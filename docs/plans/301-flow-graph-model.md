# Plan 301 — Flow : Graph model v2 — explicit edges, stored positions, start and finish, one-way migration

> Status: draft
> Ships: `packages/core/src/workflows/upgrade.ts`
> Depends on: plan 300 (D1, D2); plans 210, 211, 217 (implemented)
> Spec references: §4.6 (amended by plan 307, not here)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A document declares `schema: 2`, an `entry`, and `ui: {x,y}` on every node | the literal and both fields are required by the schema | `bun test packages/protocol/src/workflow.test.ts` → `v2 shape` passes | [ ] |
| G2 | Array order carries no control meaning: reordering `nodes[]` never changes the step sequence | a fixture doc and its shuffled twin produce identical step sequences | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `order-independence` passes | [ ] |
| G3 | Every edge is a node id; no outcome enum survives | `GateOutcomeSchema` is gone | `rg -n "GateOutcome\|go: 'continue'\|go: 'stop'\|go: 'fail'" packages apps plugins --glob '!**/docs/archive/**'` → only `packages/core/src/workflows/upgrade.ts` | [ ] |
| G4 | Every run ends at a `finish` node, or at a dangling edge that behaves as one | 2 kinds added: `start`, `finish`; exactly one `start` per document | `bun test packages/protocol/src/workflow.test.ts` → `start and finish` passes | [ ] |
| G5 | Every v1 document upgrades to a v2 document with an identical step sequence | 0 divergences across the fixture corpus | `bun test packages/core/src/workflows/upgrade.test.ts` → `corpus equivalence` passes | [ ] |
| G6 | An unreachable node is a `warning`; a missing or unreachable `entry` is an `error`; a dangling edge is a `warning` | 3 codes, 2 severities | `bun test packages/protocol/src/workflow-check.test.ts` → `reachability` passes | [ ] |
| G7 | A stored v1 document is upgraded on read and persisted as v2 on the next save, never written back by a read | `workflows.doc` holds `schema: 2` after one `PUT`, and is untouched by a `GET` | `bun test packages/core/src/workflows/store.test.ts` → `upgrade on read` passes | [ ] |
| G8 | A queued or running job's snapshot still runs, unmodified in the database | `jobs.workflow_doc` is never rewritten | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `v1 snapshot still runs` passes | [ ] |
| G9 | `bun run typecheck` and `bun run build:studio` are clean | 0 errors each | both commands exit 0 | [ ] |
| G10 | The owner's farm has no document the upgrade changes behaviourally | 0 divergences | §5 step 301.8's dump-and-diff, against the owner's data directory | owner |

## 1. Goals

- The document is a **graph**: every edge is written down as a node id, and
  `nodes[]` is storage order and nothing more (plan 300 D1).
- Every node carries its own position (plan 300 D2), so plan 305's canvas can
  be the editor of record rather than a projection.
- A run's start and its ends are **nodes on the canvas**, not enum values
  hidden inside a gate's outcome.
- Exactly one migration, one-way, proven equivalent before it is allowed to
  run anywhere.
- `checkWorkflow` keeps every guarantee it has today over the new shape, and
  gains reachability.

## 2. Non-goals

| Not done here | Where |
|---|---|
| `switch`, `delay`, plugin-contributed node types, the registry | plan 303 |
| Expressions | plan 302 |
| Any Studio change beyond keeping it compiling and correct | plans 305, 306 |
| Per-node device targets, fan-out, merge | plan 308 |
| Deleting the list editor | plan 305 §10 |

## 3. Context and design decisions

### 3.1 Edges stay ON the node

The alternative — n8n's separate `connections` object (plan 300 R2) — is
refused, for three reasons in order of weight:

1. **One source of truth.** `checkWorkflow` and the executor read successors
   from the node today. A parallel `edges[]` needs referential integrity in
   both directions and a rule for what happens when the two disagree.
2. **A node's control surface is closed** (plan 300 D8): one success edge, one
   failure edge, or a gate's two. That is a pair of fields, not a general edge
   set.
3. **n8n's shape is worse than it looks** — its connections are keyed by node
   *name*, which is why renaming a node there rewrites the graph. Here an edge
   names an immutable `id`, and `title` is free text that renames for free.

`deriveGraph` ([derive-graph.ts:38](../../packages/studio/src/components/workflow/derive-graph.ts) —
`EdgeKind = 'next' | 'onFailure' | 'then' | 'else'`) already projects exactly
this into React Flow and keeps working.

### 3.2 Termination is a node, not an enum

v1 ends a run with `{ go: 'stop' }` or `{ go: 'fail' }` inside a gate outcome.
On a canvas that is an edge that goes nowhere and means something — the worst
combination available. v2 replaces the outcome union entirely: **every edge is
a node id**, and a run ends by reaching a `finish` node, which carries the
status and the message that the outcome used to carry.

This also fixes something v1 got wrong quietly: `{ go: 'fail' }` and a script
node's failure path were two different mechanisms for "this run failed". Now
they are one, and the canvas draws them the same way.

**A dangling edge** — a `next` that is absent because the author has not wired
it yet — is not an error. At publish it is a `warning`; at run, reaching the
end of a `next` ends the run `succeeded`, and reaching the end of an
`onFailure` ends it `failed`. That is the behaviour an unfinished graph
already implies, written down rather than discovered.

### 3.3 What changes semantically, and what an author notices

| v1 | v2 | An author notices |
|---|---|---|
| `next` absent ⇒ the next array element | `next` absent ⇒ dangling (ends the run) | Deleting a node no longer rewires its neighbours |
| gate `{ go: 'continue' }` ⇒ next array element | gone; `then`/`else` name a node | Both gate branches are visible on the canvas |
| `{ go: 'stop' \| 'fail' }` | an edge to a `finish` node | Every path visibly ends somewhere |
| entry is `nodes[0]` | `doc.entry`, pointing at the one `start` node | Reordering the list does not move the start |
| no positions | `ui: { x, y }`, required | The canvas remembers |

The first row is both the point and the risk: a v1 document parsed as v2
without upgrading would silently truncate at the first node with no `next`.
That is why `schema` is a required literal that only accepts `2` — an
un-upgraded document fails loudly at read, by name, and never runs.

### 3.4 `start` is a node, and it is where the inputs live

The owner's brief asked for *"titik start-nya, bisa nerima / build inputs"*.
The document already has typed inputs (`params[]`, `WorkflowParamSchema`); what
it lacks is somewhere for them to **be** on the canvas. So: exactly one `start`
node per document, undeletable, `entry` points at it, and plan 306 renders the
document's `params[]` in its node panel. It runs nothing and costs no step.

## 4. Technical design

### 4.1 `packages/protocol/src/workflow.ts`

```ts
/** Canvas position. Integers, bounded, so a document cannot carry a 1e308 that breaks the viewport maths. */
export const WorkflowPointSchema = z
  .object({
    x: z.number().int().min(-100_000).max(100_000),
    y: z.number().int().min(-100_000).max(100_000),
  })
  .strict()

/** Fields every node has, whatever its kind. */
const nodeBase = {
  id: WorkflowNodeIdSchema,
  title: z.string().max(80).default(''),
  ui: WorkflowPointSchema,
}

export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('start'), next: WorkflowNodeIdSchema.optional() }).strict(),

  z
    .object({
      ...nodeBase,
      kind: z.literal('script'),
      script: ScriptRefSchema,
      params: z.record(WorkflowParamNameSchema, ValueExprSchema).default({}),
      reset: z.enum(['farm', 'none']).optional(),
      retries: z.number().int().min(0).max(10).optional(),
      /** Absent = dangling; reaching it ends the run succeeded (§3.2). */
      next: WorkflowNodeIdSchema.optional(),
      /** Absent = dangling; reaching it ends the run failed (§3.2). */
      onFailure: WorkflowNodeIdSchema.optional(),
    })
    .strict(),

  z
    .object({
      ...nodeBase,
      kind: z.literal('gate'),
      when: PredicateSchema,
      then: WorkflowNodeIdSchema.optional(),
      else: WorkflowNodeIdSchema.optional(),
    })
    .strict(),

  z
    .object({
      ...nodeBase,
      kind: z.literal('finish'),
      status: z.enum(['succeed', 'fail']).default('succeed'),
      /** Shown on the job row when this node ends the run — the message `gate.message` used to carry. */
      message: z.string().max(200).default(''),
    })
    .strict(),
])

const WorkflowDocShapeSchema = z
  .object({
    schema: z.literal(2),
    name: WorkflowNameSchema,
    title: z.string().max(80).default(''),
    description: z.string().max(300).default(''),
    params: z.array(WorkflowParamSchema).max(WORKFLOW_LIMITS.maxParams).default([]),
    /** The one `start` node. Never `nodes[0]` (§3.4). */
    entry: WorkflowNodeIdSchema,
    nodes: z.array(WorkflowNodeSchema).min(1).max(WORKFLOW_LIMITS.maxNodes),
    maxSteps: z.number().int().min(1).max(500).default(50),
    onFail: z.object({ script: ScriptRefSchema, params: z.record(WorkflowParamNameSchema, ValueExprSchema).default({}) }).strict().optional(),
  })
  .strict()
```

`WorkflowDocSchema`'s `superRefine` keeps the duplicate-id check and adds two
that need no external lookup: `entry` names a node in `nodes[]`, and that node
has `kind: 'start'`; there is **exactly one** `start` node.

`GateOutcomeSchema`, `GateOutcome` and the gate's `message` field are deleted
(§10). `WORKFLOW_LIMITS` does not move: positions add ≤ 50 × ~24 bytes to a
128 KB budget.

### 4.2 `packages/protocol/src/workflow-check.ts`

- `buildGraph` starts at `doc.entry`; successors are read from the four
  optional id fields instead of the outcome union.
- Three codes added to `WorkflowFindingCode`: `entry-unknown` (error),
  `node-unreachable` (warning), `edge-dangling` (warning).
- The longest-path budget walk starts at `entry` and excludes unreachable
  nodes — a node that cannot run cannot cost time.
- A `finish` node is a sink and costs zero. A `start` node costs zero.
- Everything else — dangling `goto` (now: an edge naming an unknown id), a
  binding reading a node that cannot have run yet, an undeclared `{ param }` —
  is unchanged in behaviour; only successor enumeration changes.

### 4.3 Reachability is a warning, not an error

An author mid-edit has orphans: a node dragged aside, a branch not yet wired.
Refusing to save that makes the canvas hostile, and the canvas is the point.
So an unreachable node and a dangling edge are `warning` and publish succeeds;
plan 305 renders them dimmed. Only a missing, unknown, or non-`start` `entry`
is an `error`, because that document cannot run at all.

### 4.4 `packages/core/src/workflows/upgrade.ts` (new — the plan's artefact)

```ts
/**
 * The ONE place a v1 document becomes a v2 document (plan 301 §4.4). Pure: no
 * database, no clock, no import from Studio. Called by `WorkflowStore` on read
 * and by the workflow executor when it meets a v1 `jobs.workflow_doc`.
 */
export function upgradeWorkflowDoc(raw: unknown): WorkflowDoc
```

Rules, applied in order:

1. Parse against `WorkflowDocV1Schema` — a **copy** of the v1 shape frozen in
   this file, never imported from `@enkaku/protocol`. Protocol ships one
   current shape; the historical one lives with its migration.
2. Prepend a `start` node (`id: 'start'`, or `start-2`… if taken) whose `next`
   is the old `nodes[0].id`. `entry` = that node.
3. For each node at index `i`: `next` absent and `i + 1 < nodes.length` ⇒
   `next = nodes[i+1].id`; absent at the last index ⇒ leave dangling.
4. Gate outcomes → edges. `{ go: 'goto', node }` ⇒ that id.
   `{ go: 'continue' }` at index `i` ⇒ `nodes[i+1].id`, or a `finish`
   (`succeed`) when `i` is the last index. `{ go: 'stop' }` ⇒ an edge to a
   shared `finish` node with `status: 'succeed'`; `{ go: 'fail' }` ⇒ one with
   `status: 'fail'`, carrying the gate's old `message`. At most two `finish`
   nodes are created per document, and only when referenced.
5. A script node's `onFailure` outcome is mapped by the same rules.
6. Positions: rank-and-row, reimplemented here as a pure function over the v1
   shape — **not** imported from Studio (a core module never imports from
   `packages/studio`, and that is not a workspace dependency). ~40 lines,
   ranks from forward edges, `x = rank * 240`, `y = row * 130`, matching
   `compute-layout.ts`'s constants so a document opens looking the way it
   looked the day before.
7. `schema = 2`; re-parse through `WorkflowDocSchema`; return.

### 4.5 Where the upgrade is called

| Caller | File | Behaviour |
|---|---|---|
| Read a stored workflow | `packages/core/src/workflows/store.ts` (`parseWorkflowDoc`) | Upgrade in memory. Do **not** write back — the next `PUT` persists v2 naturally (G7). |
| Read a job snapshot | `packages/core/src/jobs/executors/workflow.ts` | Upgrade in memory. **Never** rewrite `jobs.workflow_doc`: the snapshot is evidence of what was enqueued (G8). |
| `POST` / `PUT /api/workflows` | `packages/core/src/api/workflows.ts` | Accept v1 or v2 in the body, upgrade, check, store v2. The tolerance exists for API clients; plan 307 §10 removes it once no v1 remains. |

### 4.6 Error codes

| Code | When | HTTP |
|---|---|---|
| `E_WORKFLOW_SCHEMA_UNKNOWN` | `schema` is neither 1 nor 2 | 400 |
| `E_WORKFLOW_UPGRADE_FAILED` | a v1 document does not satisfy the v1 schema | 400, naming the Zod path |

## 5. Implementation steps

**301.1 — Protocol: the v2 shape.** Edit `packages/protocol/src/workflow.ts`
per §4.1: `WorkflowPointSchema`; `nodeBase`; the four node variants; delete
`GateOutcomeSchema`/`GateOutcome`; add `entry`; `schema: z.literal(2)`; extend
the `superRefine`. Rewrite the module doc comment's control-flow paragraph to
state the new edge semantics in two sentences. *Result*:
`bun test packages/protocol/src/workflow.test.ts` — v1 assertions rewritten in
the same step.

**301.2 — Protocol: the checker.** Edit `workflow-check.ts` per §4.2 and §4.3.
*Result*: `bun test packages/protocol/src/workflow-check.test.ts` green, with
new cases for all three codes.

**301.3 — The upgrade module.** Create `packages/core/src/workflows/upgrade.ts`
per §4.4, with `WorkflowDocV1Schema` frozen inside it and **not** exported from
the package index. *Result*: `packages/core/src/workflows/upgrade.test.ts`
covering rules 2–6 one at a time.

**301.4 — Store and executor.** Wire §4.5's three callers. The executor
upgrades once at the top of the run, before any step; nothing downstream knows
v1 existed. Replace the executor's outcome `switch` with successor lookups.
*Result*: `bun test packages/core/src/workflows/store.test.ts` and
`bun test packages/core/src/jobs/executors/workflow.test.ts` green, including
G2 and G8.

**301.5 — The API.** `packages/core/src/api/workflows.ts`: accept both
versions on `POST`/`PUT`, upgrade before `checkWorkflow`, store v2; add both
error codes. *Result*: `bun test packages/core/src/api/workflows.test.ts`
green.

**301.6 — Keep Studio correct, not just compiling.** `model.ts` gives every
new node a `ui` (rank-and-row for a new node, `{x: 0, y: 0}` for the first) and
creates the `start` node for a new draft; `GateOutcomeEditor.tsx` becomes a
node picker instead of an enum picker; `derive-graph.ts` reads the id fields.
No new control, no visual redesign — that is plan 305. *Result*:
`bun run typecheck` **and** `bun run build:studio` clean (plan 200 §2.6).

**301.7 — `finish` in the list editor.** `NodeCard.tsx` renders `start` and
`finish` as non-editable cards so a v2 document is not silently unrenderable
between this plan and plan 305. Minimal: title, status, message. *Result*: an
upgraded document opens in the existing editor and round-trips through save.

**301.8 — Prove the migration before trusting it.** Write
`scripts/check-workflow-upgrade.ts`: read every `workflows` row and every
non-null `jobs.workflow_doc` from a given data directory, upgrade each, then
walk **both** the v1 and the v2 successor relation over a synthetic execution
that takes every branch, and diff the two step sequences. One line per
document, a final count. *Result*: run against `.dev-data/`; the owner runs it
against the farm (G10). A non-zero divergence count blocks the plan.

**301.9 — Status and report.** Update `> Status:`, fill §11, run
`bash scripts/check-plan-status.sh`.

## 6. Acceptance criteria

- G1–G9 pass; G10 is the owner's row.
- `rg -n "nodes\[0\]" packages/core/src/jobs/executors/workflow.ts packages/protocol/src/workflow-check.ts` → no hit meaning "the entry node".
- No file outside `upgrade.ts` mentions `schema: 1` or `GateOutcome`.
- `bun run build:studio` clean.

## 7. Test plan

| File | Covers |
|---|---|
| `packages/protocol/src/workflow.test.ts` | v2 required fields; `entry` must name the one `start`; exactly one `start`; `ui` bounds; `finish` defaults |
| `packages/protocol/src/workflow-check.test.ts` | `entry-unknown`, `node-unreachable`, `edge-dangling`; budget excludes unreachable nodes; every pre-existing case still passes |
| `packages/core/src/workflows/upgrade.test.ts` | one test per §4.4 rule; `continue` at the last index; `stop`/`fail` share one `finish` each; a v2 document is returned unchanged |
| `packages/core/src/workflows/store.test.ts` | upgrade on read; no write-back |
| `packages/core/src/jobs/executors/workflow.test.ts` | order-independence (G2); v1 snapshot still runs (G8); dangling `next` ends succeeded; dangling `onFailure` ends failed |

Manual smoke (owner, 5 minutes): open an existing workflow, save, reopen. The
row is v2 in the database
(`sqlite3 <dataDir>/enkaku.db "select json_extract(doc,'\$.schema') from workflows"`
→ all `2`), the editor renders the same graph plus a `start` card, and a run
produces the same steps as the day before.

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Should a `GET` write back an upgraded document? | No. A read must not have a write side effect; the next real save persists it. |
| Q2 | Should an unreachable node block a **run**? | No. It cannot run by definition; blocking adds a failure mode with no benefit. |
| Q3 | Do positions belong in the job snapshot? | Yes, by inclusion — the snapshot is the document. ~1 KB, and it is what lets a past run replay on the layout it was authored on (plan 307 P11). |
| Q4 | Should `finish` carry an arbitrary result value for the job row? | Not in this plan. `message` is a string; a structured result is plan 304 §9. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| `GateOutcomeSchema`, `GateOutcome` | `packages/protocol/src/workflow.ts` | `rg -n "GateOutcome" packages apps plugins --glob '!**/docs/archive/**'` → empty |
| `{ go: 'continue' \| 'stop' \| 'fail' \| 'goto' }` | same | `rg -n "go: '" packages apps plugins --glob '!**/docs/archive/**'` → only `packages/core/src/workflows/upgrade.ts` |
| The gate's own `message` field | same | `rg -n "message: z.string\(\).max\(200\)" packages/protocol/src/workflow.ts` → one hit, on `finish` |
| Implicit array fallthrough | `packages/core/src/jobs/executors/workflow.ts`, `workflow-check.ts` | `rg -n "index \+ 1|i \+ 1" packages/core/src/jobs/executors/workflow.ts packages/protocol/src/workflow-check.ts` → no hit meaning "the next node" |
| `schema: z.literal(1)` | `packages/protocol/src/workflow.ts` | `rg -n "z.literal\(1\)" packages/protocol/src/workflow.ts` → empty |
| `GateOutcomeEditor`'s enum options | `packages/studio/src/components/workflow/GateOutcomeEditor.tsx` | `rg -n "continue|stop|fail" packages/studio/src/components/workflow/GateOutcomeEditor.tsx` → empty |

## 11. Handoff report

_To be written by the executing agent._
