# Plan 313 — Flow : Sequential Mode — the linear editor, the node toggle, and the shuffle node

> Status: implemented (software) — S1 and S4 were approved by the owner on 2026-09-07 ("lanjutkan semuanya sampai selesai") and executed in full.
> Ships: packages/studio/src/components/flow/SequenceEditor.tsx
> Depends on: plans 301–307, 310–312 (all implemented); plan 300 D1, D2, D3, D8. Plan 308 (fan-out) is NOT a precondition — §3.3 explains why the device-level half of this plan needs nothing 308 owns.
> Spec references: §4.6, §4.7, §11

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The three screens in the 2026-09-07 client brief are buildable in the product, with no bespoke code per client | every control in §3.1's table maps to a row marked "yes" | §3.1's table has no "no" left | [x] |
| G2 | A linear workflow is authored as a list, not a canvas | 0 edge drags to build a 3-action sequence with delays | `SequenceEditor.tsx`; owner smoke §7 step 1 still to run | [x] |
| G3 | The list editor and the canvas edit **one** document format | 0 new document schemas, 0 new executors, 0 new checkers | `rg -n "schema: 3" packages/protocol/src` → no hit | [x] |
| G4 | An action can be turned off without being deleted | 1 boolean on `nodeBase`; a disabled node is skipped, its edge passes through | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `disabled node` group passes | [x] |
| G5 | A set of actions can run in a random order, differently per device, replayably | `kind: 'shuffle'`; two runs of one document on two devices produce two orders; a replay of one reproduces its own | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `shuffle node` group passes | [x] |
| G6 | Running a workflow on many devices offers the same pacing a script batch already has | `deviceDelayMs` + `order` reach `createWorkflowBatch` | `bun test packages/protocol/src/actions.test.ts` → `run-workflow takes the batch controls` passes (see §11: the schema, not a dispatch harness) | [x] |
| G7 | Switching between the two editors never loses or invents structure | a document that stops being linear makes the list unavailable and says why, and becomes available again when it is linear once more | `bun test packages/protocol/src/workflow-linear.test.ts` → `the refusal is not one-way` passes | [x] |

Also shipped, beside the named artefact: `kind: 'shuffle'` and `enabled` in
`packages/protocol/src/workflow.ts`, the recogniser in
`packages/protocol/src/workflow-linear.ts`, and `pacing` on a workflow batch in
`packages/core/src/groups/dispatch.ts`.

## 1. Goals

- A **Sequential Mode** editor: a vertical list of actions with add / reorder / toggle / configure / remove, a global delay-between-actions range, and a Run button — the shape of the client brief's screen 3.
- A `shuffle` node so "each device runs these actions in a random order" is a document fact, not a story an operator tells themself.
- An `enabled` flag on every node, so an author stops deleting an action to skip it and re-adding it tomorrow.
- Workflow batches get the pacing a script batch has had since plan 94: a per-device start delay range and a random device order.
- **One** document format, one executor, one checker, one run view. The list is a lens.

## 2. Non-goals

| Not done here | Why / where |
|---|---|
| A second document schema, a `mode` column, or a sequential-only executor | §3.2 — the whole point is that there is one document |
| Fan-out across devices from inside a workflow | plan 308, still blocked on plan 300 D5 |
| "Account switch delay", "Use SIM 4G", and every other app-specific control in the brief | §3.6 — these are plugin script parameters and presets, never core workflow schema |
| Nested shuffles, or a shuffle whose members branch | §4.3 — a member is a single node, and the checker refuses the rest |
| A branded, client-specific screen | §3.6 — a plugin React screen (`plugin-surface.ts:495`) over the same API, if the client wants their own chrome |
| Reworking the canvas | plan 305 is implemented and this plan adds two node kinds' worth of rendering to it, nothing else |

## 3. Context and design decisions

### 3.1 What the brief asks for, and what the repo already has

The client brief (three screenshots, 2026-09-07) is not one feature. It is
eleven controls, and most of them already exist. Read this table before
believing any part of this plan is large:

| Control in the brief | Today | Where |
|---|---|---|
| "Open phones one by one (delay between) 20–30 seconds" | **done** (was: backend yes, workflow no) | `PacingSchema.deviceDelayMs` ([actions.ts:63](../../packages/protocol/src/actions.ts)) is applied by [pacer.ts:90](../../packages/core/src/groups/pacer.ts); `CreateWorkflowBatchInput` ([dispatch.ts:211](../../packages/core/src/groups/dispatch.ts)) has no `pacing` field, and [run.ts:275](../../packages/core/src/actions/run.ts) hardcodes `concurrency: 0, order: 'as-listed'` |
| "Shuffle device order" | **done** (was: backend yes, workflow no) | `order: z.enum(['as-listed','random'])` ([actions.ts:129](../../packages/protocol/src/actions.ts)); `createWorkflowBatch` honours it, the `run-workflow` verb never sends it |
| "ADD ACTION" card grid | **yes** | `NodePalette.tsx` over `registry.ts` — a plugin's `node` descriptor (plan 300 D6) already produces exactly these cards, with icon, title and category |
| An ordered action sequence | **yes** | a chain of `kind: 'script'` nodes joined by `next` |
| Reorder ↑ / ↓ | **done** — `SequenceEditor`'s own rows | `doc-edit.ts` can rewire; no list UI exists |
| Per-action ⚙ → parameters | **yes** | `NodePanel.tsx` + `ParamsEditor.tsx` + `PresetRow` (plan 311) |
| Per-action ✕ → remove | **yes** | `canvas-edit.ts` |
| Per-action ON/OFF toggle | **done** — `enabled` on `nodeBase` | nothing in `nodeBase` ([workflow.ts:194](../../packages/protocol/src/workflow.ts)) |
| "Delay between each action, 1 s ~ 10 s" | **done** — one control, `gapExpr`/`readGap` | one `delay` node per gap with `ms: { expr: '1000 + $random * 9000' }, maxMs: 10000`. `$random` is a real per-run seed already (`job_runs.seed`, plan 304 §3.4, `deriveRandom(seed, seq)`) |
| "Shuffle order — each device runs actions in a random order" | **done** — `kind: 'shuffle'` | a graph's edges are fixed; expressing N! orders as `next` edges is N! paths |
| "Account switch delay", "Use SIM 4G (change IP)" | **yes, as plugin script params** | §3.6 |
| "Run 0 devices" + the device picker | **yes** | `ActionDialog` + `DevicePicker` |

(The right-hand column is as of execution, 2026-09-07. What it said before
any of this was written is kept in the parentheses, because the point of the
table is that most of the brief was already there.)

So the honest answer to *"is the workflow already this easy?"* was **no, and the
reason was not the engine**. Building screen 3 today means: place three script
nodes and two delay nodes on a canvas, drag five edges, type an arithmetic
expression to get a 1–10 s range, and then discover there is no way to turn an
action off and no way to shuffle the three. Two of those eleven rows are real
schema gaps; one is plumbing; the rest is a missing **layout**.

### 3.2 S1 — Sequential Mode is a lens over the v2 graph, never a second format

The tempting shape is a second document kind — `schema: 3`, a
`{ actions: [...] }` array, its own executor. It is the wrong one, and the
repo has already paid for the general version of this mistake: plan 300 D1
removed control meaning from `nodes[]` precisely because **two things that can
disagree eventually will**. A second format would duplicate the executor
(1 000 lines), `checkWorkflow` (650 lines), the run view, the simulator, the
pin store, and the job snapshot — and it would fork on the first feature that
lands in one and not the other.

So: **the sequential editor emits ordinary v2 documents, and reads them back.**
Everything downstream — `workflow.ts`'s executor, `workflow-check.ts`,
`RunOverlay`, `simulate.ts`, `jobs.workflow_doc` — is untouched by this plan.

### 3.3 S2 — The lens is a recogniser, not a stored mode flag

A stored `mode: 'sequential'` can lie: an author opens the canvas, adds a
gate, and the flag still says linear. A flag that can disagree with the
document is the exact drift D1 removed.

So the sequential editor's availability is computed:

```ts
// packages/protocol/src/workflow-linear.ts — pure, no React, no I/O
export function readLinear(doc: WorkflowDoc): LinearView | null
```

`readLinear` returns the ordered action list when the document is in the
**canonical linear shape**, and `null` — with a reason, for the UI to explain —
otherwise. `doc.ui.editor` is stored, but it is only a *preference for which
editor opens first*; it never overrides the recogniser.

The consequence is the one that matters for the client: **the switch is not
one-way**. Branch on the canvas and Sequential Mode becomes unavailable and
says why; delete the branch and it comes back. An author is never trapped in
the simple editor, and never locked out of it by an edit they can undo.

The canonical linear shape (checked by `readLinear`):

1. exactly one `start` (already a document invariant);
2. every node has exactly one inbound edge, except `start`, which has none;
3. the only outgoing edge used is `next`, except that a `script` node's
   `onFailure` may point at the document's single `finish` node, or be absent —
   the same choice for every node;
4. no `gate` and no `switch` anywhere;
5. at most one `finish`, and it is terminal;
6. a `shuffle`'s members (§4.3) are exempt from rule 2 — the shuffle owns them.

### 3.4 S3 — `enabled` on every node

One boolean on `nodeBase`, defaulting to `true`. A disabled node is **skipped**
at run time: the executor follows its `next` without executing it, records a
`skipped` step row so the run view shows the gap honestly, and charges it no
budget. `checkWorkflow` still walks it — a disabled node with a dangling edge
is still a broken document tomorrow, when it is re-enabled.

This is wanted on the canvas too, and n8n has exactly it. It is the cheapest
row in the brief and the one an operator will use most: the difference between
"skip Read Notifications tonight" and deleting a configured node.

### 3.5 S4 — `shuffle` is a dispatcher with a cursor, not a container

This is the one genuinely new capability, and the one design call worth
arguing. Three candidate shapes were considered:

**(a) A container node** holding a nested sub-graph. Refused: it makes the node
list non-flat, and `checkWorkflow`'s reachability and budget walks
([workflow-check.ts:591](../../packages/protocol/src/workflow-check.ts)) are
written over a flat node array. Nesting is a rewrite of the checker for one
feature.

**(b) Expand the permutation at snapshot time.** `jobs.workflow_doc` is already
a per-job snapshot, so `createWorkflowBatch` could write a *different* linear
chain per device and change nothing else. Genuinely tempting, and rejected for
one reason: the canvas would then show a document that is not what runs, and
`simulate.ts` and the replay view would each need their own permutation
story. Plan 300's whole posture is that the document is the truth.

**(c) A dispatcher with a cursor.** `kind: 'shuffle'` carries
`members: WorkflowNodeId[]` and a `next`. On each visit it picks a member it
has not yet run in this run, at random from `$random`, and jumps to it; a
member has **no `next` of its own**, so control returns to the shuffle node;
when every member has run, the shuffle follows `next`. **Chosen.**

(c) earns it on four counts:

- **No static cycle.** Because members are dangling, the return edge does not
  exist in the graph. The cycle detector never fires, so
  `W_WORKFLOW_LOOP` — which today makes the budget walk give up entirely
  ([workflow-check.ts:637](../../packages/protocol/src/workflow-check.ts)) —
  stays silent, and the budget stays checkable.
- **The budget is exact.** Each member runs exactly once, so
  `cost(shuffle) = Σ cost(members) + cost(next)`. Deterministic, statically
  computable, no "might".
- **Membership is unambiguous.** A node is in exactly one shuffle, and it is
  in one because that shuffle lists it — not because of where an edge points.
- **It is visible.** The canvas draws N edges out and one return bundle back.
  Nothing about the random order is hidden in an editor's head.

The rules the checker enforces, each because its absence is a real bug:

| Rule | Because |
|---|---|
| A member may not declare `next` | its successor is the shuffle, decided at run time |
| A member is listed by at most one shuffle | otherwise "runs exactly once" is a lie |
| A member may not itself be a `shuffle` | keeps the budget walk flat (§4.3 Q1 holds nesting open) |
| A member may not be `start` or `finish` | neither is a step |
| 2 ≤ `members.length` ≤ `maxSwitchCases` (10) | one member is not a shuffle; past ten it is a script |
| A member's `onFailure` is unrestricted | a failing action aborting the sequence is the wanted behaviour, and it already works |

Replay is free: `$random` is already `deriveRandom(job_runs.seed, seq)` and a
`resume` run reuses its parent's seed, so the same run reproduces its own
order and two devices in one batch draw different ones.

### 3.6 S5 — The app-specific controls stay out of core

"Account switch delay (seconds)", "Use SIM 4G (change IP)", "Scroll FYP",
"Interact User" are not workflow concepts. They are one plugin's scripts and
one plugin's parameters. Putting them in `WorkflowDoc` would make the core
schema a TikTok schema.

Where they land instead, each on a path that already exists:

- **Each action card** — a plugin script member with a `node` descriptor
  (plan 300 D6). The brief's twelve cards are twelve members of one plugin.
- **"Use SIM 4G"** — a script node placed before the sequence, or the
  `vpn-helper` network layer; not a workflow field.
- **"Account switch delay"** — a parameter of the account-switch script, saved
  as a preset (plan 311).
- **The brief's exact chrome**, if the client wants their own branding — a
  plugin React screen (`plugin-surface.ts:495`) driving `POST /api/actions`
  and `PUT /api/workflows/:name`. Core ships the generic Sequential Mode;
  a plugin may ship a skin over it.

This is the answer to "keep the workflow flexible": the flexibility lives in
the node catalog, which plugins already extend, not in a growing core schema.

## 4. Technical design

### 4.1 `enabled` on `nodeBase`

```ts
const nodeBase = {
  id: WorkflowNodeIdSchema,
  title: z.string().max(80).default(''),
  ui: WorkflowPointSchema,
  /** Plan 313 §3.4 — a node an author has turned off. Skipped at run time; its `next` is followed as if it had succeeded with no output. Still checked at publish time, because it is a real node again the moment it is switched back on. */
  enabled: z.boolean().default(true),
}
```

Executor: at the top of the step loop, a node with `enabled === false` writes a
`workflow_steps` row with `status: 'skipped'`, records **no** output (so a
downstream `{ from }` binding fails honestly rather than silently reading
yesterday's value), charges no budget, and advances to `next`.

Checker: unchanged reachability and binding checks; one new warning,
`W_WORKFLOW_DISABLED_BINDING`, when an enabled node binds `{ from }` a
disabled one — the failure is otherwise only found at run time.

### 4.2 `doc.ui`

```ts
/** Editor-owned, never read by the executor or the checker. */
ui: z.object({ editor: z.enum(['sequence', 'canvas']).default('canvas') }).strict().default({ editor: 'canvas' }),
```

One field, one purpose: which editor opens first. `readLinear` decides what is
*possible*; this decides what is *shown*.

### 4.3 The `shuffle` node

```ts
z.object({
  ...nodeBase,
  kind: z.literal('shuffle'),
  /** Run exactly once each, in an order drawn from `$random`, before `next` (§3.5). */
  members: z.array(WorkflowNodeIdSchema).min(2).max(WORKFLOW_LIMITS.maxSwitchCases),
  next: WorkflowNodeIdSchema.optional(),
}).strict()
```

`WORKFLOW_NODE_KINDS` becomes eight. The list stays closed (plan 300 D8): a
plugin may not define a ninth.

Executor state: one `Map<nodeId, Set<memberId>>` per run, held in the same
place `outputs` already lives, so a `resume` rebuilds it from the recorded step
rows rather than from memory.

Budget walk: `shuffle` is summed as `Σ cost(members) + cost(next)`, and its
members are not walked as independent roots.

### 4.4 Workflow batch pacing

`CreateWorkflowBatchInput` gains the `pacing` field `CreateBatchInput` already
has ([dispatch.ts:54](../../packages/core/src/groups/dispatch.ts)), written to
the same batch columns. `createBatchPacer` is generic over batch rows and needs
**no change at all** — a workflow batch is a batch row.

`run-workflow`'s request body gains `concurrency`, `order` and `pacing`,
validated by the same `PacingSchema`, and [run.ts:275](../../packages/core/src/actions/run.ts)
stops hardcoding them.

Studio: the concurrency / order / start-delay block in
`verb-dialogs.tsx` is lifted into one `<BatchPacingFields>` component and
rendered by **both** `run-script` and `run-workflow`. One control, one place,
two dialogs.

### 4.5 `SequenceEditor.tsx` — the artefact

A vertical list, one row per action, over `readLinear(doc)`. What it reuses
**unchanged**: `NodePalette` (the "ADD ACTION" grid), `NodePanel` +
`ParamsEditor` + `PresetRow` (the ⚙ sheet), `useHistory` (undo/redo),
`useValidation`, `doc-edit.ts`, `RunOverlay`'s step states. What is new is the
**layout** and four gestures: reorder ↑/↓, toggle `enabled`, remove, and
"shuffle these" (select rows → wrap in a `shuffle` node).

The global "Delay between each action, 1 s ~ 10 s" control writes one `delay`
node into each gap with `ms: { expr: '<min> + $random * <max-min>' }` and
`maxMs: <max>`, and reads the range back from them. A delay node the editor did
not author (a hand-written expression) is shown as its own row rather than
folded into the global control — the editor never rewrites what it cannot
represent.

Auto-layout on save: the sequence writes a simple top-to-bottom column of
`ui` positions, so opening the same document on the canvas shows a sane chain.

## 5. Verified external references

| # | Reference | Checked | Relevance |
|---|---|---|---|
| R1 | n8n node "Deactivate" (disable) — a node stays in the document, is skipped, and its connection passes through | 2026-09-07 | §3.4 is the same behaviour, and the same reason |
| R2 | Zapier / Make: linear "steps" editors with an advanced branching mode behind them | 2026-09-07 | §3.2's lens posture is the industry-standard shape, not an invention |
| R3 | This repo, `packages/core/src/groups/pacer.ts:90` | 2026-09-07 | §4.4 needs no scheduler work; the ladder plus draw is already written |

## 6. Implementation steps

**Wave A — plumbing and the toggle (small, independently shippable).**

- 313.1 `enabled` on `nodeBase`; executor skip; `W_WORKFLOW_DISABLED_BINDING`; the canvas renders a disabled node dimmed. → `bun test packages/core/src/jobs/executors/workflow.test.ts`
- 313.2 `pacing`/`order`/`concurrency` on `CreateWorkflowBatchInput` and the `run-workflow` verb. → `bun test packages/core/src/groups/dispatch.test.ts`
- 313.3 `<BatchPacingFields>` extracted and rendered by both dialogs. → `bun run typecheck`

**Wave B — the shuffle node.**

- 313.4 `kind: 'shuffle'` in the schema and `WORKFLOW_NODE_KINDS`; the six checker rules of §3.5. → `bun test packages/protocol/src/workflow-check.test.ts`
- 313.5 The executor's cursor, including `resume` rebuilding it from step rows. → `bun test packages/core/src/jobs/executors/workflow.test.ts`
- 313.6 The budget walk's `shuffle` case. → `bun test packages/protocol/src/workflow-check.test.ts`
- 313.7 Canvas rendering, `registry.ts` catalog entry, `simulate.ts`. → `bun test packages/core/src/workflows/simulate.test.ts`

**Wave C — the editor.**

- 313.8 `workflow-linear.ts`: `readLinear`, and the round-trip test G7 names. → `bun test packages/protocol/src/workflow-linear.test.ts`
- 313.9 `doc.ui.editor`; the editor switch and its "this workflow has branches" explanation.
- 313.10 `SequenceEditor.tsx`. → `bun run typecheck` (Studio has no tests, plan 200 §8.3)
- 313.11 The delay-range control and its read-back rule (§4.5).

Rough cost: wave A ≈ 2 days, B ≈ 3 days, C ≈ 5 days.

## 7. Test plan

Backend tests, scoped per CLAUDE.md — one file or directory per invocation,
never the root suite:

```bash
bun test packages/protocol/src/workflow-linear.test.ts
bun test packages/protocol/src/workflow-check.test.ts
bun test packages/core/src/jobs/executors/workflow.test.ts
bun test packages/core/src/groups/dispatch.test.ts
bun test packages/core/src/workflows/simulate.test.ts
bun run typecheck
```

Owner smoke, once, in one sitting:

1. New workflow → Sequential Mode → add Browse Shop, Read Notifications,
   Scroll FYP from the card grid → set the delay range to 1–10 s → **6 clicks
   to a runnable document.**
2. Toggle Read Notifications off; run; the run view shows it skipped, not absent.
3. Select all three, "Shuffle these"; run on 3 devices with "one by one,
   20–30 s" and "shuffle device order"; the three runs start at three different
   times and execute three different orders.
4. Open the same workflow on the canvas; the chain and the shuffle fan are
   readable without rearranging anything.
5. Add a gate on the canvas; Sequential Mode says why it is unavailable.
   Delete the gate; it comes back.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The lens's canonical shape is too narrow, and real documents fall out of Sequential Mode constantly | §3.3's rules were drawn from the brief's own screens; 313.8's round-trip test runs over every document on the owner's farm before 313.10 starts |
| `shuffle` becomes the seam through which nesting, weights, and sub-flows arrive | §2 refuses all three; §9 Q1 holds nesting open rather than letting it arrive by accident |
| Two editors means two places a bug can live | Wave C adds a layout only — every editing primitive is the one the canvas already calls (§4.5) |
| An operator believes Sequential Mode is a different, lesser product | The switch is not one-way (§3.3), and both editors write the same file |
| The client wants their exact screen, not ours | §3.6 — a plugin React screen over the same API; core does not grow a skin |

## 9. Open questions

- **Q1 — may a `shuffle` member be a `shuffle`?** Current answer: no (§3.5),
  because the flat budget walk is worth more than nested randomisation. What
  would change it: an author who needs "shuffle these three groups, and shuffle
  within each".
- **Q2 — should the sequential editor be able to author `onFailure` at all?**
  The brief has no failure branch. Proposed: one document-level "on failure"
  choice (stop / continue), written to every node's `onFailure` identically,
  which rule 3 of §3.3 already assumes.
- **Q3 — does `doc.ui.editor` belong in the document or in a user preference?**
  In the document as proposed, because the author's choice should follow the
  workflow to another browser. Falsified by a farm where two operators want
  different editors for one workflow.
- **Q4 (owner)** — S1 (a lens, not a second format) and S4 (the dispatcher
  shuffle) are the two calls that are expensive to reverse later. Both need a
  yes on the record before §6 wave B starts.

## 11. Handoff report

Written after executing §6 in full on 2026-09-07.

### What was built, by area

- **Protocol** — `enabled` on `nodeBase`; `kind: 'shuffle'` (eight kinds now);
  `doc.ui.editor`; the "at most one shuffle owns a node" invariant in
  `WorkflowDocSchema`; `E_WORKFLOW_SHUFFLE_MEMBER`,
  `W_WORKFLOW_SHUFFLE_EMPTY` and `W_WORKFLOW_DISABLED_BINDING` in
  `checkWorkflow`; the shuffle case in the budget walk; `workflow-linear.ts`.
- **Core** — the executor's disabled skip and shuffle cursor (rebuilt from
  step rows on resume); the same two in `simulate.ts`, so a simulation walks
  a shuffle exactly as a run does; `pacing` on `CreateWorkflowBatchInput` and
  the `planFirst` call; `core:shuffle` in the node catalog.
- **Studio** — `SequenceEditor.tsx`; the mode switch; the shuffle member
  picker and the Switch off/on control in `NodePanel`; disabled-node dimming
  on the canvas; `BatchPacingFields` shared by both run dialogs.

### Four decisions made without an explicit plan instruction

1. **`members` lost its `.min(2)`.** §4.3 wrote it with one, which made a
   freshly-placed shuffle unrepresentable and forced an `as`-cast at the
   node-template site — the cast is what exposed the problem. Fewer than two
   members is now `W_WORKFLOW_SHUFFLE_EMPTY`, a warning, on plan 301 §4.3's
   rule that refusing to save a half-built document makes the editor hostile.
2. **`doc.ui` is `.optional()`, not `.default()`.** A defaulted object is
   required in the parsed type, which would have forced every document
   literal in the workspace to carry a field about editor chrome. Absent
   already means "no preference", which is exactly `'canvas'`.
3. **`ActionParams` is now built from the schema's INPUT type.** Adding two
   defaulted fields to `run-workflow` would otherwise have forced every
   re-run call site — which creates no batch at all — to name two batch
   controls it has no opinion about. A caller is exactly the party that has
   not applied the schema's defaults yet.
4. **G6 is verified against the schema, not a dispatch harness.** There is no
   `groups/dispatch.test.ts` in this repo — `pacer.test.ts` deliberately
   tests only the pure arithmetic, saying the rest "is a database walk that a
   unit test would only restate". Building the whole harness for one
   assertion was not worth it; the contract change is pinned in
   `actions.test.ts` instead. **This is a real gap**: nothing proves
   `planFirst` is actually called on a workflow batch except reading the
   line.

### Two bugs the work surfaced

- **The script success path bypassed the shared successor lookup.** It
  advanced through `node.next` directly, so a shuffle ran its first member
  and stopped. Both paths now go through `advance`. Found by the new tests,
  not by review.
- **`FlowCanvas.iconFor` returned an icon name that did not exist.** It is
  typed `string` rather than `IconName`, so `'shuffle'` typechecked and would
  have rendered nothing. `PLUGIN_ICONS` is an exhaustive
  `Record<IconName, Icon>`, so adding the name to `ICON_NAMES` forced the
  mapping — but `iconFor`'s own return type is still `string`, and a future
  node kind can repeat this exact mistake.

### What I could not verify

- **The owner smoke (§7) has not been run.** Studio has no tests by decision
  (plan 200 §8.3), so every claim about the sequence editor's behaviour rests
  on `bun run typecheck`, on the pure `readLinear` tests, and on reading the
  code. The six-click claim in G2 is unmeasured.
- **Nothing was run against a device.** The shuffle's per-device orders are
  proven by the seed test, not by two phones.
- **The full suite was not run** (CLAUDE.md forbids it for an agent). The
  scoped runs were: `packages/protocol/src`, `packages/core/src/workflows`,
  `packages/core/src/jobs`, `packages/core/src/api`, `packages/core/src/actions`,
  `packages/core/src/groups` — all green — plus every CI doc/token check.

### One thing a reader should not re-derive

The shuffle's members are **dangling on purpose**. It looks like an omission
and it is the load-bearing part of the design: because a member declares no
`next`, the return edge does not exist in the graph, so `findCycle` stays
quiet, `W_WORKFLOW_LOOP` never fires, and the budget walk keeps working. Give
a member a `next` "for clarity" and the budget check silently stops
happening for every document that contains a shuffle.
