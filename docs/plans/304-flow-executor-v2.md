# Plan 304 — Flow : Executor v2 — graph walk, per-step input, run one node, pinned outputs

> Status: implemented
> Ships: packages/core/src/workflows/pins.ts
> Depends on: plans 301, 302, 303
> Spec references: §4.6, §4.8, §12, §16

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Every step records the input it received, the output it produced, and the edge it took | 3 new columns, all populated | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `step record` passes | [x] |
| G2 | The recorded input is exactly what an expression saw as `$input` | byte-equal to the scope value | same file → `input equals scope` passes | [x] |
| G3 | A single node can be run on its own, against the last run's input, without running the workflow | `POST /api/workflows/:name/run-node` → a run with `trigger = 'node-test'` | `bun test packages/core/src/api/workflows.test.ts` → `run one node` passes | [x] |
| G4 | A pinned node is not executed; its pin is substituted and downstream nodes receive it | 1 step skipped, marked `pinned` | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `pin substitution` passes | [x] |
| G5 | A production run ignores every pin | `trigger` ∈ {`schedule`, `batch`} ⇒ pins not read at all | same file → `production ignores pins` passes | [x] |
| G6 | Pins live outside the document and outside the job snapshot | `workflow_pins` table; `rg` finds no pin field in the doc schema | `rg -n "pin" packages/protocol/src/workflow.ts` → empty | [x] |
| G7 | `$random` and `$now` are reproducible on a replay | a run carries a seed; replaying yields the same expression values | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `deterministic replay` passes | [x] |
| G8 | The most recent run of each workflow survives retention | 1 run per workflow is exempt from the age rule | `bun test packages/core/src/retention/` (the directory only) → `keeps last workflow run` passes | [x] |
| G9 | A migration adds the columns and the table without rewriting existing rows | 1 generated migration; existing runs read back unchanged | `bun run --cwd packages/core db:generate`, then `bun test packages/core/src/db/` (the directory only) | [x] |
| G10 | `bun run typecheck` clean | 0 errors | exits 0 | [x] |

## 1. Goals

- The run record carries enough to draw plan 307's canvas replay and to fill
  plan 306's data panes **without re-running anything**.
- An author can iterate on step 6 of 8 without driving steps 1–5 on a real
  phone (plan 300 P9, P10) — the single largest time cost in authoring device
  automation.
- Pins can never lie: a scheduled farm job that silently used a pinned output
  would be a fabricated result, and §3.3 makes that structurally impossible.

## 2. Non-goals

| Not done here | Where |
|---|---|
| Any UI | plans 305, 306, 307 |
| Fan-out, per-node targets | plan 308 |
| Changing job, retry, or `finish()` semantics | never — plan 211 owns them |
| Storing artefacts (screenshots) differently | plan 307 §4.6 renders what the run already stores |

## 3. Context and design decisions

### 3.1 The run record is the data panel's storage, and most of it already exists

`workflow_steps` already holds `runId`, `seq`, `stepId`, and `output` capped by
`WORKFLOW_LIMITS.maxNodeOutputBytes`
([schema.ts:547](../../packages/core/src/db/schema.ts)). Three columns turn it
into everything plan 306 P6 and plan 307 P11 need: `input`, `takenEdge`, and
`pinned`. No new table for run data, no new size budget — the same 256 KB cap
applies to `input`, and the same truncation marker is reused.

### 3.2 Running one node needs an input, and there are exactly three places to get one

In order of preference, and the API takes whichever the caller names:

1. **The last run's recorded input for that node** (`workflow_steps.input`) —
   the default, and the reason G1 exists.
2. **A pin** on the node's predecessor.
3. **Literal JSON** supplied by the caller, validated against the node's
   params schema.

If none is available the request is refused with `E_NODE_NO_INPUT` naming the
three options, rather than running the node against `undefined` and producing
a confusing failure.

### 3.3 Pins are authoring state, not document state

A pin is stored in `workflow_pins (workflow_name, node_id, data, updated_at,
created_by)` — **not** in `workflows.doc`, and therefore never in
`jobs.workflow_doc`. Three consequences, all wanted:

- Publishing a workflow does not publish someone's mock data.
- A queued job cannot acquire a pin after it was enqueued.
- Production ignores pins by *not looking*, not by a flag that could be
  inverted: `readPins()` is called only on the `manual`, `rerun` and
  `node-test` paths. n8n reaches the same rule (plan 300 R6) and this plan
  copies it deliberately.

The canvas marks a pinned node (plan 305 §4.6) so nobody debugs a workflow for
an hour without noticing that step 3 has not run since Tuesday.

**Only a node with one main output may be pinned** — plan 300 R6's rule, which
this plan cited but did not originally enforce, found in review after the first
implementation landed and fixed in the same session. A pinned node is never
executed, so a pinned `gate` or `switch` would never evaluate its predicate and
the run would leave by whichever successor happened to be declared first: a pin
that lies about control flow, which is the one thing §3.3 exists to prevent.
`start` and `finish` produce no output at all. So `PUT /:name/pins/:nodeId`
refuses anything but a `script` or a `delay`, with `E_PIN_NOT_PINNABLE`, and
refuses an unknown node id with `E_NODE_UNKNOWN`.

### 3.4 Determinism, and the seed

Plan 302 §3.3 injects `$now` and `$random` rather than letting the evaluator
reach a clock. The run row gains `seed` (an integer, generated at run
creation); `$random` for step *n* is derived from `(seed, n)` with a small
pure PRNG in `@enkaku/expr`. A replayed or resumed run reuses the stored seed,
so an expression that branched one way yesterday branches the same way today
(G7). `$now` is the step's own recorded `startedAt`, which is already stored.

## 4. Technical design

### 4.1 Schema

```ts
// packages/core/src/db/schema.ts — workflowSteps gains:
  /** The value the step received as `$input` (plan 304 §3.1), size-capped by `WORKFLOW_LIMITS.maxNodeOutputBytes`, truncation marked the same way `output` marks it. */
  input: text('input', { mode: 'json' }),
  /** Which edge the step left by: 'next' | 'onFailure' | 'then' | 'else' | 'case:<i>' | 'default' | null when the run ended here. */
  takenEdge: text('taken_edge'),
  /** True when the step was satisfied from a pin instead of executed (plan 304 §3.3). */
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),

// jobRuns gains:
  /** Plan 304 §3.4 — the per-run seed `$random` derives from. */
  seed: integer('seed').notNull().default(0),

// new table:
export const workflowPins = sqliteTable(
  'workflow_pins',
  {
    workflowName: text('workflow_name').notNull(),
    nodeId: text('node_id').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    createdBy: text('created_by'),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workflowName, t.nodeId] })],
)
```

`RunTrigger` gains `'node-test'`:
`'manual' | 'rerun' | 'schedule' | 'batch' | 'resume' | 'workflow-step' | 'node-test'`.

### 4.2 The walk

```
cursor = doc.entry
steps = 0
while cursor and steps < doc.maxSteps:
    node = doc.nodes[cursor]
    input = scopeValueOf(previous step's output)      # $input
    if pinsAllowed and pins[node.id]: output, pinned = pins[node.id], true
    else: output = execute(node, input)                # unchanged per kind
    record(seq=steps, stepId=node.id, input, output, pinned, takenEdge)
    cursor = successorOf(node, output)                 # plan 301 §3.2 rules
    steps += 1
```

`execute` is untouched for `script` (still a child job through the same
`JobRunner`), and is in-process and device-free for `gate`, `switch`, `delay`,
`start`, `finish` — exactly as `gate` already is.

`maxSteps` exhaustion keeps its existing error. A `start` and a `finish` node
each record a step so the canvas can highlight them; they cost no device time
and are exempt from the budget walk (plan 301 §4.2).

### 4.3 Routes

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/api/workflows/:name/run-node` | `{ nodeId, deviceId, input?: { from: 'last-run' \| 'pin' \| 'literal', value?: unknown } }` | `202 { runId }` |
| `GET` | `/api/workflows/:name/pins` | — | `{ pins: [{ nodeId, updatedAt, bytes }] }` (never the data — it can be 256 KB) |
| `GET` | `/api/workflows/:name/pins/:nodeId` | — | `{ data }` |
| `PUT` | `/api/workflows/:name/pins/:nodeId` | `{ data }` or `{ from: 'last-run' }` | `204` |
| `DELETE` | `/api/workflows/:name/pins/:nodeId` | — | `204` |

Permissions: `script.view` to read, `script.publish` to write a pin,
`job.run` to run a node. Error codes: `E_NODE_NO_INPUT`,
`E_NODE_UNKNOWN`, `E_PIN_TOO_LARGE` (over `maxNodeOutputBytes`).

### 4.4 Retention (spec §16)

The most recent run of each workflow is exempt from the age rule (G8), because
plan 306's data panes are empty without it and an author returning to a
workflow after a fortnight would otherwise find a dead editor. Everything else
is unchanged. This is a one-line predicate in the retention sweep and a row in
the settings documentation, not a new setting.

## 5. Implementation steps

**304.1 — Schema and migration.** Edit `packages/core/src/db/schema.ts` per
§4.1; `bun run --cwd packages/core db:generate`; read the generated SQL and
confirm it is three `ALTER TABLE ADD COLUMN`s and one `CREATE TABLE`, with no
table rewrite. *Result*: G9.

**304.2 — Recording.** The executor writes `input`, `takenEdge` and `pinned`
on every step, using the existing truncation helper for `input`. *Result*:
G1, G2.

**304.3 — The seed.** Generate at run creation; store; derive `$random` in
`@enkaku/expr` from `(seed, seq)`; feed `$now` from the step's `startedAt`.
*Result*: G7.

**304.4 — Pins: store and routes.** New `packages/core/src/workflows/pins.ts`
(the artefact) and the four routes of §4.3. *Result*: G6, and
`bun test packages/core/src/workflows/pins.test.ts` green.

**304.5 — Pins: substitution.** `readPins()` is called on `manual`, `rerun`
and `node-test` only; a pinned node records a step with `pinned = true` and no
device contact. *Result*: G4, G5.

**304.6 — Run one node.** `POST /api/workflows/:name/run-node` per §3.2 and
§4.3: build a one-node document in memory (`start` → the node → `finish`),
enqueue it as an ordinary workflow job with `trigger = 'node-test'`, and let
the existing runner do the rest. **Do not** add a second execution path.
*Result*: G3.

**304.7 — Retention.** The exemption of §4.4, plus its test. *Result*: G8.

**304.8 — Status and report.**

## 6. Acceptance criteria

- G1–G10.
- `rg -n "readPins" packages/core/src` → called from exactly one file, guarded
  by a trigger check.
- `rg -n "'node-test'" packages/core/src packages/protocol/src` → the enum, the
  route, the guard, and their tests; nothing else.
- A `node-test` run appears in the Jobs list like any other run (no hidden
  execution).

## 7. Test plan

| File | Covers |
|---|---|
| `packages/core/src/jobs/executors/workflow.test.ts` | step record; `$input` equality; pin substitution; production ignoring pins; deterministic replay; `maxSteps` unchanged |
| `packages/core/src/workflows/pins.test.ts` | CRUD; size refusal; pins are per workflow+node |
| `packages/core/src/api/workflows.test.ts` | run-one-node with each of the three input sources; `E_NODE_NO_INPUT` |
| `packages/core/src/db/` (directory) | the migration applies to a populated database |
| `packages/core/src/retention/` (directory) | last run per workflow kept |

Manual smoke (owner, 10 minutes, one device): run a 4-node workflow; open the
run and confirm each step shows an input and an output; pin node 2's output;
run node 3 alone and confirm it used the pin and never woke the device; run the
workflow from a schedule and confirm the pin was ignored and node 2 executed.

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Should a pin expire? | Not automatically. It shows its `updatedAt` in the UI (plan 306) and an author clears it. An expiry that fires mid-debug is worse than a stale pin that is labelled. |
| Q2 | Should `finish` carry a structured result onto the job row? | Deferred. `message` is enough for the MVP of this programme; a structured result needs a place in the job row's own schema. |
| Q3 | Does a `node-test` run count against the device's activity policy? | Yes, unchanged — it is an ordinary job. Anything else would be an invisible device consumer. |
| Q4 | Should pins be exportable with a workflow? | No. §3.3's whole point is that they are not part of the document. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| Nothing | — | Additive; the columns replace nothing |

## 11. Handoff report

- **Checklist**: G1 ✅ G2 ✅ G3 ✅ G4 ✅ G5 ✅ G6 ✅ G7 ✅ G8 ✅ G9 ✅ G10 ✅ — all ten goals are software-verifiable and green; none needed an `owner` row.

- **Branch**: `flow-304-workflow-executor-v2`, cut from `mvp` (worktree `/Users/solpochi/Projects/oss/openpf/.claude/worktrees/agent-a66bb04354ac7e06e`).

- **Commits**: `35e5509` — `feat(flow-304): executor v2 — per-step input/edge recording, pinned outputs, run-node, deterministic $random` (one commit; branch `flow-304-workflow-executor-v2`, cut from `mvp` at `94f71e0`). This report itself is committed in a second, immediately following commit (`docs(flow-304): …`).

- **Typecheck**: clean (`bash scripts/typecheck.sh` — every package `OK`, including `core`, `protocol`, `expr`, `studio`).

- **Tests run** (one invocation at a time, never the full suite):
  - `bun test packages/expr/src/` → 166 pass, 0 fail (6 files) — the new `deriveRandom` PRNG plus every pre-existing expr test, unaffected by the added export.
  - `bun test packages/core/src/jobs/executors/workflow.test.ts` → 19 pass, 0 fail (14 pre-existing + 5 new: step record (G1), input-equals-scope (G2), pin substitution (G4), production ignores pins (G5), deterministic $random (G7)).
  - `bun test packages/core/src/workflows/pins.test.ts` → 8 pass, 0 fail (new file, `pins.ts`'s own CRUD/size/scoping suite).
  - `bun test packages/core/src/api/workflows.test.ts` → 27 pass, 0 fail (20 pre-existing + 7 new: run-node's three input sources, E_NODE_NO_INPUT, E_NODE_UNKNOWN, and pins-over-HTTP CRUD + cascade-delete).
  - `bun test packages/core/src/db/` (directory) → 57 pass, 0 fail — migration 0073 applies cleanly across every existing migration fixture in this directory (G9).
  - `bun test packages/core/src/retention/` (directory) → 14 pass, 0 fail (13 pre-existing + 1 new: `keeps last workflow run`, G8).
  - `bun test packages/core/src/jobs/runs/` (directory, touched by the `seed` addition) → 17 pass, 0 fail.
  - `bun test packages/core/src/api/workflows-wiring.test.ts` (daemon-wiring guard, touched by the new `daemon.ts` deps) → 2 pass, 0 fail.
  - Not run: any other directory. `bun test` (bare) was never invoked.

- **Removed, proven**: §10 declares nothing removed (additive plan). No proof command applies.

- **§6 acceptance greps, with real output**:
  - `rg -n "readPins" packages/core/src` →
    ```
    packages/core/src/workflows/pins.ts:34:  readPins(workflowName: string): ReadonlyMap<string, unknown>
    packages/core/src/workflows/pins.ts:72:    readPins(workflowName) {
    packages/core/src/workflows/pins.test.ts:55:    const all = pins.readPins('wf-a')
    packages/core/src/db/schema.ts:591: * `readPins()` (`workflows/pins.ts`) is the ONLY reader, called only on the
    packages/core/src/jobs/executors/workflow.ts:214:      // trigger. A `schedule`/`batch` run never reaches `deps.pins.readPins`
    packages/core/src/jobs/executors/workflow.ts:217:      const activePins: ReadonlyMap<string, unknown> = pinsAllowed && job.workflowName ? deps.pins.readPins(job.workflowName) : new Map()
    ```
    One CALL site (`workflow.ts:217`), guarded by `pinsAllowed = PIN_AWARE_TRIGGERS.has(ctx.run.trigger)` where `PIN_AWARE_TRIGGERS = {'manual', 'rerun', 'node-test'}` — `schedule`/`batch` never reach it.
  - `rg -n "'node-test'" packages/core/src packages/protocol/src` → the `RunTrigger` enum (`schema.ts`, `messages/job.ts`), the route's three uses in `api/workflows.ts` (the two `lastRecordedInput`-family exclusions and the `addRun` call), the executor's guard (`PIN_AWARE_TRIGGERS`, the seeding branch), and the one test assertion in `workflows.test.ts`. Nothing else.
  - `rg -n -i "pin" packages/protocol/src/workflow.ts` → empty (G6).
  - `test -e packages/core/src/workflows/pins.ts` → exists (the `Ships:` artefact).

- **Migration**: `packages/core/drizzle/0073_tranquil_red_skull.sql`, index **73** (the next free index in `_journal.json` at the time of generation — 0072 was the last). Read in full before accepting: **one `CREATE TABLE workflow_pins`** and **four `ALTER TABLE … ADD COLUMN`** statements — `job_runs.seed`, `workflow_steps.input`, `workflow_steps.taken_edge`, `workflow_steps.pinned`. No table rewrite, no data loss, no `DROP`, no index change on an existing table.

- **Discrepancies between plan and code**:
  - **`workflow-resolve.ts`'s real location** (flagged in advance by the task brief): the file lives at `packages/protocol/src/workflow-resolve.ts`, not `packages/core/src/workflows/workflow-resolve.ts` as plan 304 and plan 302 both say. Used the real path throughout.
  - **§5's migration count**: the plan's step 304.1 says "three `ALTER TABLE ADD COLUMN`s and one `CREATE TABLE`". The generated migration has **four** `ALTER TABLE ADD COLUMN`s (the plan's own §4.1 schema block lists exactly four new columns across two tables — `workflow_steps.input`/`.taken_edge`/`.pinned` plus `job_runs.seed` — so the plan's step text undercounted its own schema by one; the schema block was followed, not the step's prose count). Still purely additive; no table rewrite.
  - **`input`'s truncation marker**: §3.1 says "the same truncation marker is reused" for `input`, but §4.1's schema block declares only 3 new `workflow_steps` columns (`input`, `taken_edge`, `pinned`) — no `input_truncated` column exists to reuse `output`'s marker into. Implemented `input` as capped-to-`null`-over-the-limit with a `deps.log.warn` at truncation time instead of inventing a fifth column the plan's own schema block did not declare.
  - **§3.2 point 3, "literal input validated against the node's params schema"**: `$input` (what `workflow_steps.input` records, and what `run-node`'s three sources all resolve to per §3.2's own point 1) is the *previous node's raw output*, not the target node's own resolved parameter object — the two have no schema relationship (a script's `paramsSchema` describes named parameters, `$input` is an arbitrary JSON value). Implemented `run-node`'s literal source as accepting any JSON value (still size-capped implicitly by request-body limits), not validated against the target's params schema, which would have been a category error. Recorded here rather than silently reinterpreting the plan.
  - **`run-node`'s predecessor-only input model**: a node's `params` bindings may read `{ from: X }` for *any* earlier node, not only its immediate predecessor. §3.2's three input sources ("the last run's recorded input for THAT node", "a pin on the node's PREDECESSOR", "literal JSON") only ever name the node itself or its one predecessor, so this plan's `run-node` seeds exactly one synthetic predecessor entry (found by scanning the real published document's edges) before running the stripped-down one-node graph. A node whose params read a *non-adjacent* ancestor will fail to resolve that specific binding when run alone (an ordinary `E_WORKFLOW_BINDING_UNRESOLVED`-shaped step failure inside the synthetic run, not a route-level error) — this is a scope limitation inherent to the plan's own three-source model, not a bug; the common single-hop case (the one plan 300 R6/P9 is about) works correctly and is tested.
  - **Pin substitution's edge choice for control nodes**: the plan's §4.2 pseudocode treats pin substitution uniformly across all node kinds but does not say which edge a pinned `gate`/`switch` takes (neither evaluates a predicate when pinned). Implemented `defaultEdgeFor`: the node's *first declared* successor (`then` over `else`; the first case with a `to`, else `default`) — documented in code, not silently arbitrary.
  - **`{ from: 'last-run' }` pin semantics**: §4.3's route table gives the pin-set body as `{ data }` or `{ from: 'last-run' }` without specifying which value the latter captures. Implemented it as the pinned node's own last-recorded *output* (the value the canvas already shows for that node), not its `$input` — the natural reading of "pin this node's data."

- **Observed, not done**:
  - `packages/core/src/api/workflow-jobs.ts`'s `createWorkflowJobRoutes` (steps/resume) is not mounted anywhere in `daemon.ts`/`server/http.ts` — a pre-existing gap unrelated to this plan, left alone (not in scope, not caused by this work).
  - `run-node`'s synthetic document does not carry the real workflow's declared `params[]`, so a target node whose bindings use `{ param: X }` will not resolve `X` unless the caller's literal/pin path happens to satisfy it incidentally. Not required by any G-row; noted for plan 306's UI to account for (it will need to supply workflow params too, or the route will need extending).
  - No `workflow_steps` row is written for the synthetic seeded predecessor in a `node-test` run (kept in-memory only) — a deliberate simplification (§3.2 discrepancy above) since that node did not actually run in this run.

- **Open questions hit**: none of §9's four questions blocked a step. Q1 (pin expiry), Q2 (`finish`'s structured result), Q3 (node-test and the activity policy — confirmed unchanged, ordinary job), and Q4 (pin export) were all left exactly as their "current answer" rows say; no step required deciding them.

- **Processes**: `ps -Ao pid=,command= | grep -i "[o]penpf"` → (no output; nothing left running from this session).
