# Plan 309 — Flow : Simulate — running a workflow without a device

> Status: implemented (software)
> Ships: packages/core/src/workflows/simulate.ts
> Depends on: plans 301–307 (all implemented); plan 300 D3, D4, R6
> Spec references: §4.6, §4.8, §12, §16 — §4.6 gains a simulate paragraph, written by this plan.

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A whole workflow can be run with no device contact at all | 0 adb calls, 0 child processes, 0 session opens during a simulation | `bun test packages/core/src/workflows/simulate.test.ts` → `touches nothing` passes (the test's driver stub throws if called) | [x] |
| G2 | Every node's value comes from a pin, a sample derived from its `resultSchema`, or an author-written mock — in that order | 3 sources, precedence fixed | same file → `value precedence` passes | [x] |
| G3 | Gates, switches and expressions evaluate **for real** against the simulated values | the same `workflow-resolve.ts` and `@enkaku/expr` the executor uses; no second evaluator | `rg -n "evaluate\(" packages/core/src/workflows/simulate.ts` → imports from `@enkaku/expr`, defines nothing | [x] |
| G4 | A simulated run can never be mistaken for a real one | `trigger = 'simulate'`; excluded from the Jobs list by default; never satisfies a schedule; never becomes a script's "last run" | same file → `never counts as real` passes | [x] |
| G5 | A node that cannot be simulated stops the simulation and says which node and why | 1 finding, naming the node id | same file → `stops with a reason` passes | [x] |
| G6 | The canvas replays a simulation through the SAME overlay a real run uses | 1 renderer (plan 307 §3.1) | `rg -n "RunOverlay" packages/studio/src` → unchanged consumer list | [x] |
| G7 | A simulated run is visibly a simulation, everywhere it appears | a badge on the canvas, on the job row, and in the node panel | owner smoke §7 step 4 | owner |
| G8 | `bun run typecheck` and `bun run build:studio` clean | 0 errors | both exit 0 | [x] |

## 1. Goals

The owner's ask, 2026-09-05, choosing the largest of three options: *"mode
simulate penuh seperti n8n"* — run the whole workflow dry, no node touches a
device, every node uses a pin or a sample, and the result fills the canvas
like a real run.

- An author can shape a 9-node workflow, watch which branch fires, fix the
  gate, and watch again — in seconds, on a laptop, with no phone plugged in.
- Expressions get real data to resolve against before any device exists. That
  closes the last gap in plan 300 D4's bargain: the preview shows a value even
  on a workflow that has never run.

## 2. Non-goals

| Not done here | Where |
|---|---|
| Simulating what a script *does* to a device | never — a simulation produces a script's OUTPUT, it does not model its behaviour |
| Recording or replaying real device traffic | plan 94's recordings, unchanged |
| Fan-out across devices | plan 308, still blocked on D5 |
| A second evaluator, or any expression change | plan 302's engine is used as-is (G3) |

## 3. Context and design decisions

### 3.1 What a simulation actually is

A workflow run has exactly two kinds of node: ones that **compute** (`gate`,
`switch`, `start`, `finish`, and every expression binding) and ones that
**act** (`script`, `delay`). The computing half is already pure, in-process,
and device-free — it runs identically whether a phone is attached or not.

So a simulation is not a model of the system. It is the real control-flow
engine, with the acting half replaced by a value. That is why G3 forbids a
second evaluator: the moment simulation has its own gate logic, it can
disagree with production about which branch fires, and a tool that lies about
that is worse than no tool.

### 3.2 Where a node's value comes from, in order

1. **A pin** (plan 304). If the author pinned a value, that is the answer —
   the same value a manual run would substitute. One concept, not two.
2. **A sample derived from `resultSchema`** (plan 303 §4.3 ships it to the
   client and the registry). `string → "text"`, `number → 0`,
   `boolean → false`, `array → one element of the item shape`,
   `object → each property, recursed`, bounded by depth and node count.
3. **An author-written mock**, stored exactly like a pin, because it *is* a
   pin — written by hand instead of captured from a run (plan 306 §9 Q3
   already specified the JSON editor).

If none of the three yields a value, the simulation **stops at that node**
with a finding naming it (G5): *"`read-notifications` declares no result
shape — pin a value to simulate past it."* It does not invent `{}` and carry
on, because a `{}` that flows into a gate produces a branch decision the
author will trust and the farm will not reproduce.

That refusal has a second effect worth stating: it makes declaring
`resultSchema` on a plugin member pay for itself. A pack whose members declare
their result shape is fully simulable; one that does not is simulable only
node by node, as its author pins values. That is the right incentive and it
costs this plan nothing.

### 3.3 `delay` resolves instantly, and says so

A simulated `delay` returns immediately and records the duration it *would*
have waited. The alternative — honouring the wait — turns a 4-minute workflow
into a 4-minute simulation, which defeats the point. The recorded step shows
`skipped 30s`, so a reader is never misled about the real cost.

### 3.4 A simulation must be unmistakable, and that is a storage decision

The tempting shape is to store a simulation as an ordinary run so plan 307's
overlay just works. It does just work — and that is exactly the hazard: a row
in the Jobs list that looks like evidence a workflow ran on a device.

So: **stored, with `trigger = 'simulate'`**, and four hard rules, each with a
test (G4):

- The Jobs list excludes `simulate` runs unless the filter asks for them.
- A `simulate` run never becomes a workflow's or a script's "last run" for
  plan 306's data panes — an author looking at real data must never be shown
  sample data instead.
- A schedule is never satisfied by one.
- Retention prunes them on a much shorter horizon than real runs (spec §16),
  because they are scratch work, not history.

Storing rather than returning synchronously is what buys G6: one overlay, one
scrubber, one node panel, no second read path.

### 3.5 Why not "just run it with a fake driver"

Considered and refused. A fake driver would make `script` nodes execute their
real code against a stub, which means a child process per node, the plugin
pipeline, `reset`, retries and `finish()` — all the machinery whose only
purpose is to talk to a device, running to produce a value the author already
told us. It would be slower than the real thing on a phone, and it would
execute third-party code as a side effect of drawing a preview.

## 4. Technical design

### 4.1 `packages/core/src/workflows/simulate.ts` (the artefact)

```ts
export interface SimulateRequest {
  /** The document as the EDITOR currently has it — a simulation runs on unsaved work (§4.4). */
  doc: WorkflowDoc
  /** Values for the workflow's own `params[]`, from the same form the Run dialog uses. */
  params: Record<string, unknown>
  /** Author-written mocks, merged over stored pins, keyed by node id. */
  mocks?: Record<string, unknown>
}

export interface SimulatedStep {
  seq: number
  nodeId: string
  input: unknown
  output: unknown
  /** Where the value came from — rendered on the step, so nothing is anonymous. */
  source: 'pin' | 'mock' | 'sample' | 'computed'
  takenEdge: string | null
  /** Set on a `delay` (§3.3). */
  skippedMs?: number
}

export function simulateWorkflow(req: SimulateRequest, deps: { pins: PinStore; registry: ScriptRegistry }): SimulateResult
```

Pure apart from the two reads it is handed. No clock (`$now` is a fixed
timestamp passed in), no randomness (`$random` from a fixed seed), so **two
simulations of the same document give the same answer** — the property that
makes it worth trusting.

### 4.2 Sample generation — `sampleFromSchema.ts`

A pure function over `JsonSchemaNode`, bounded by `SIMULATE_LIMITS`
(`maxDepth: 6`, `maxNodes: 500`, `maxArrayLength: 1`). Honours `default`,
`examples[0]`, `enum[0]` and `const` when present, in that order, before
falling back to the per-type placeholder — an author who documented their
schema gets their own examples back, not `"text"`.

### 4.3 Route

`POST /api/workflows/simulate`, permission `script.view` (it runs nothing and
touches no device — this is deliberately NOT `job.run`), body
`{ doc, params, mocks? }`, response `202 { runId }`. The run is written with
`trigger = 'simulate'` and `deviceId = null`.

**`deviceId` is nullable for the first time**, and that is the schema change
this plan carries: a simulated run belongs to no device. The column is
already nullable for other reasons; the executor's non-null assumption is
what changes.

### 4.4 Simulating unsaved work

The editor sends its current document, not a stored name. An author simulates
the graph in front of them — including the node they have not saved yet, which
is the whole point. The document is validated by `checkWorkflow` first; a
document with errors is refused with the same findings the editor already
shows.

### 4.5 Studio

| File | Change |
|---|---|
| `components/flow/FlowEditor.tsx` | A **Simulate** button beside Save. No device picker. |
| `components/flow/SimulateDialog.tsx` (new) | The workflow's `params[]` form, plus a list of nodes whose value will come from a sample, so the author sees what is being invented before they trust the result |
| `components/flow/RunOverlay.tsx` | A `simulated` variant: the same states, drawn with a dashed halo and a "SIMULATED" chip on the canvas |
| `components/flow/NodePanel.tsx` | The output pane labels its source (`pin` / `mock` / `sample` / `computed`) and offers **Use as mock** on a sampled value |
| `components/jobs/*` | `simulate` runs hidden unless filtered for; the row carries the chip |

## 5. Implementation steps

**309.1 — `sampleFromSchema.ts`** with its own test file: every JSON Schema
type, the four honoured hints, the three limits. Write it first; everything
else depends on it.

**309.2 — `simulate.ts`**: the walk, reusing `workflow-resolve.ts` and the
executor's successor logic. **Do not copy the successor logic** — extract it
from `jobs/executors/workflow.ts` into a shared pure function and call it from
both, so G3's "no second engine" is structural rather than promised.

**309.3 — Storage and the four rules of §3.4**, each with its test.

**309.4 — The route** (§4.3) and `deviceId` nullability through the run path.

**309.5 — Retention**: simulate runs on a short horizon; one line, one test.

**309.6 — Studio**: the button, the dialog, the overlay variant, the panel
labels, the Jobs filter. No test files (plan 200 §8.3).

**309.7 — Spec §4.6** gains a simulate paragraph; `docs/design.md`'s Flow
editor section gains the simulated states.

**309.8 — Status and report.**

## 6. Acceptance criteria

- G1–G6, G8 mechanically; G7 at the owner's sitting.
- `rg -n "deviceId" packages/core/src/workflows/simulate.ts` → empty.
- The successor function has exactly one definition in the workspace.

## 7. Test plan

| File | Covers |
|---|---|
| `packages/core/src/workflows/sample-from-schema.test.ts` | every type, the hints, the limits |
| `packages/core/src/workflows/simulate.test.ts` | value precedence; touches nothing; stops with a reason; determinism; delay skipping; never counts as real |
| `packages/core/src/api/workflows.test.ts` | the route, including refusal of a document with errors |
| `packages/core/src/retention/` | the short horizon |

Owner smoke, **no device attached — that is the point**: build a 5-node
workflow with a gate, press Simulate, watch the canvas light up and the branch
fire; change the gate's operand and simulate again; open a node and confirm
its output says where the value came from; confirm the run does not appear in
the Jobs list until the filter asks for it.

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Should a simulation be able to run a SINGLE node, like plan 304's run-node? | Not in this plan. Run-node exists and uses a real device; simulate is whole-graph. Revisit if asked. |
| Q2 | Should a sampled value be persisted as a mock automatically? | No. **Use as mock** is a button (§4.5) — an author decides what becomes fixture. |
| Q3 | Does a simulated run count toward a device's activity policy? | It cannot: it has no device. |
| Q4 | Should the editor simulate automatically on every edit? | No. It is a button. An automatic dry run on every keystroke would make the canvas flicker and would hide the moment an author chose to check. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| The executor's private successor logic | `packages/core/src/jobs/executors/workflow.ts` | `rg -n "function successorOf\|function nextNodeId" packages/core/src` → exactly one definition, in the shared module |

## 11. Handoff report

**Status: implemented (software)** — every non-`owner` §0 row passes its own stated command (output below); G7 is genuinely owner-only (a badge is a visual fact, not something a terminal can confirm) and stays unticked for the owner's sitting.

### What was built, by area

- **`packages/core/src/workflows/step-compute.ts`** (new) — the shared pure module G3 and §10 require: `defaultEdgeFor`/`successorOf` (extracted verbatim from `jobs/executors/workflow.ts`, which had them as private, unexported functions) plus `computeGateStep`/`computeSwitchStep`/`computeSetStep`/`computeDelayMs`, each a straight lift of the executor's own inline logic for that node kind. `jobs/executors/workflow.ts` was rewritten to call these instead of computing branch decisions inline — its own tests (`workflow.test.ts`, 28 tests) pass unchanged, proving the refactor is behaviour-preserving. `rg -n "function successorOf|function nextNodeId" packages/core/src` returns exactly one hit, in this file.
- **`packages/core/src/workflows/sample-from-schema.ts`** + test — `sampleFromSchema`, bounded by `SIMULATE_LIMITS` (`maxDepth: 6`, `maxNodes: 500`, `maxArrayLength: 1`), honouring `const` → `default` → `examples[0]` → `enum[0]` before the per-type placeholder, exactly as §4.2 specifies.
- **`packages/core/src/workflows/simulate.ts`** + test — `simulateWorkflow(req, { pins, registry })`, the pure walk. Only `script` nodes are substituted (mock → pin → sample, see the correction below); `gate`/`switch`/`delay`/`set` are always computed for real through `step-compute.ts`, since they never touch a device to begin with. `start`/`finish` pass through/end exactly as the executor treats them. Determinism is proven by a test that runs the same weighted-switch document twice with the same `seed`/`now` and asserts deep equality.
- **`packages/core/src/workflows/simulate-store.ts`** (new) — `storeSimulateRun`, which persists a `SimulateResult` as an ordinary `jobs`/`job_runs`/`workflow_steps` triple with `trigger: 'simulate'`, reusing the existing tables rather than a parallel schema (this is what buys G6 for free — `useRunState`'s existing `GET /api/workflow-jobs/:jobId/runs/:runId/steps` read path needs no change at all to serve a simulated run).
- **`packages/core/src/api/workflows.ts`** — `POST /simulate` (permission `script.view`, not `job.run`): validates the posted document through the exact same `validateForWrite` pipeline `POST`/`PUT /api/workflows` use, calls `simulateWorkflow`, stores the result, and answers `202 { jobId, runId }` (see the correction below re: `jobId`). `NON_REAL_RUN_TRIGGERS = ['node-test', 'simulate']` replaces the three `ne(jobRuns.trigger, 'node-test')` call sites (`last-run`, the two pin-input lookups) with `notInArray(...)`, so a simulate run is excluded from "last real input/output" the same way a node-test run already was.
- **`packages/core/src/queue/job-store.ts` / `services/job-service.ts` / `api/jobs.ts`** — `list()` gained `includeSimulate?: boolean`, defaulting to excluded via a correlated subquery on `job_runs.trigger` (the same shape the existing `status` filter already uses), threaded through the service layer to `GET /api/jobs?includeSimulate=1`. Proven by a new `job-store.test.ts` group.
- **`packages/core/src/jobs/runs/sweeper.ts`** — a simulate run's own, much shorter retention horizon (`SIMULATE_RUN_RETENTION_DAYS`, default 2 days, `config/constants.ts`, `ENKAKU_SIMULATE_RUN_RETENTION_DAYS` override), swept independently of `policy.runDays` and never exempted by `latestWorkflowRunIds` (which now also excludes `node-test`/`simulate`, closing a latent gap where a node-test run could have been mistaken for a workflow's "latest" and kept alive forever). Proven by two new tests in `sweeper.test.ts`.
- **`packages/protocol`** — `RunTriggerSchema` gained `'simulate'`; `workflow-pins.ts` gained `WorkflowSimulateRequestSchema`/`WorkflowSimulateResponseSchema`.
- **`packages/core/src/scripts/registry.ts`** — `ScriptEntry` gained `resultSchema: unknown` (populated from `scripts.resultSchema` for a plugin row, `null` for a dev slot, which carries no result shape yet) — the second value source G2 needs, threaded with no other change to the registry's shape.
- **`packages/core/src/auth/audit.ts`** — `AuditAction` gained `'workflow.simulate'`.
- **Studio**: a **Simulate** button beside Save in `FlowEditor.tsx` (outline variant, no device picker) opening `SimulateDialog.tsx` (new) — the workflow's own `params[]` form plus a list of `script` nodes with no pin/mock, each read against `ScriptListItem.hasResult` so an author sees which will sample cleanly and which will stop the run. On success the SAME `lastRunRef` state that already feeds the ONE existing `<RunOverlay>` is set to the new `{jobId, runId}`, with a new `simulated` flag; `RunOverlay.tsx` draws a dashed accent halo and a "SIMULATED" chip instead of the live/replay status line when set — no second renderer, no second consumer of `RunOverlay`. `NodePanel.tsx` gained an optional `onMock` prop and a **Use as mock** button under a `script` node's shown output (see the simplification note below); `FlowEditor` keeps the resulting mocks in a session-only `Record<string, unknown>` state, merged into every `simulateWorkflow` call.
- **`docs/spec.md`** §4.6 gained the simulate paragraph this plan's header commits to. **`docs/design.md`**'s Flow editor section gained the simulated states (the halo, the chip, the dialog, "Use as mock").

### Deviations from the plan's own sketch, each recorded because a later reader will hit the same question

1. **`deviceId` stays a non-null empty string, not `string | null`.** §4.3 sketches `deviceId` becoming nullable. Before writing any migration I searched: `jobs.deviceId`/`job_runs.deviceId` are read, unguarded, by roughly 250 call sites across the claim/queue/device-activity machinery (`claimNext`, `runningByDevice`, batch dispatch, the Jobs list device filter…), every one of them written on the assumption the column is always a real string. Widening it would have forced re-auditing all 250 for a `null` none of them can ever actually receive — a `simulate` run is inserted ALREADY TERMINAL (`storeSimulateRun` never writes `status: 'queued'`), so it never reaches `claimNext` regardless of what `deviceId` holds. The empty string is `NOT NULL`-safe, distinguishable from every real device id (a real `stableId` is never empty), and needed no migration; `trigger === 'simulate'` — not `deviceId` — is what actually marks a run as fabricated, and every G4 rule keys on trigger, never on deviceId. `rg -n "deviceId" packages/core/src/workflows/simulate.ts` is still empty, satisfying the acceptance criterion literally; the deviceId handling lives in `simulate-store.ts`, a separate module, by design. Recorded here because §4.3 reads differently and a later reader should not go looking for a migration that was deliberately not written.
2. **The response is `{ jobId, runId }`, not `{ runId }`.** `RunOverlay`'s data source (`useRunState`) is keyed on BOTH ids — the plan's own `{ runId }` sketch would have left Studio unable to feed the overlay at all. Widened to match `run-node`'s own response shape (`{ job, runId }`), which already carries both.
3. **Value precedence is mock → pin → sample, not pin → sample → mock as §3.2's numbered list reads.** §3.2 lists "1. pin, 2. sample, 3. mock" but §4.1's own `SimulateRequest.mocks` doc comment says mocks are "merged over stored pins" — the two sentences describe different orderings. I followed the more specific, code-level statement: a request-supplied mock (the author's current, unsaved hypothesis) overrides a stored pin, which still beats an invented sample. This also matches the obvious authoring flow: "Use as mock" lets an author preview a hypothetical without first pinning it, which would be pointless if a stored pin always won regardless.
4. **G12's "unholdable value" reasoning does not apply here** (that is plan 312's own §11 note, referenced for context only — not repeated).
5. **"Use as mock" reads the REAL last run's output, not a sampled value specifically.** §4.5 says the button appears "on a sampled value" — but `NodePanel`'s existing data panes read the workflow's real last run (`fetchWorkflowLastRun`), which by construction (G4, rule 2) never shows simulated data. Building a second read path so the node panel could show "this run's simulated output, with its source label" and gate the button on `source === 'sample'` specifically was more surface than this pass could safely add without risking the concurrent plan-310/311 work landing in shared files (`api/workflows.ts`, `db/schema.ts` — both were being edited live by other agents during this session; see below). The button is offered whenever a `script` node has a real recorded output, letting an author capture any prior real value as a mock for the next simulation — a smaller but still genuinely useful version of the same feature. A follow-up would wire the simulate result itself back into the node panel for the fully-specified version.
6. **The Jobs list UI (the chip, the default filter toggle) was not touched.** `packages/studio/src/components/JobsList.tsx` was explicitly off-limits (plan 310's file). The BACKEND half of G4's first rule is real and tested (`job-store.test.ts`): `GET /api/jobs` excludes `trigger: 'simulate'` by default and admits it via `?includeSimulate=1`. The Studio-side filter/chip is a small, safe follow-up once plan 310 lands.
7. **`docs/spec.md` §4.6's "Six node kinds" / §4.8's `trigger` enum list are already stale** (plan 312 added `set` and `simulate`/`node-test` respectively without updating this prose) — left alone as out of this plan's scope; only the simulate paragraph itself was added, per the plan header's own narrow mandate.

### Concurrent work encountered

Two other agents were live in this same tree working on plans 310 and 311 for large parts of this session, both editing `packages/core/src/db/schema.ts` and, unexpectedly, `packages/core/src/api/workflows.ts` (plan 311's workflow param presets landed IN the same file plan 309 needed the `/simulate` route in). This produced several transient `bun run typecheck` failures (missing exports mid-rename) that were never caused by this plan's own edits — confirmed each time by `git diff` on the failing file before touching anything, and by waiting rather than "fixing" someone else's in-flight rename. No file outside this plan's own scope was edited to resolve them; every failure cleared on its own once the other session's edit completed. `packages/core/src/api/workflows.ts` was edited by both this plan and plan 311's agent concurrently in the same file; every re-read before an edit showed the other agent's additions landing cleanly alongside mine with no collision (the `WorkflowSimulateRequestSchema`/`WorkflowSimulateResponseSchema` imports, the `/simulate` route, and `NON_REAL_RUN_TRIGGERS` all survived every intermediate read).

### What could not be verified from this terminal

- **G7** (owner smoke): the dashed halo and "SIMULATED" chip are wired (`RunOverlay.tsx`) and typecheck/build clean, but were never seen rendered in a browser.
- **The Simulate dialog's params form and "will use a sample" list**, and the "Use as mock" button: typecheck- and build-clean, exercised by no test (Studio has none, plan 200 §8.3) — not clicked through a browser.
- **The full owner smoke script (§7)**: building a 5-node workflow with a gate, pressing Simulate, watching the canvas light up, changing the gate and re-simulating, confirming the Jobs list hides the run until filtered — all mechanically plausible from the unit/route tests above, none of it driven through an actual running core + Studio.

### Test output (each run individually, per the testing rules)

```
bun test packages/core/src/workflows/sample-from-schema.test.ts   →  8 pass, 0 fail
bun test packages/core/src/workflows/simulate.test.ts             →  8 pass, 0 fail
bun test packages/core/src/api/workflows.test.ts                  → 41 pass, 0 fail
bun test packages/core/src/jobs/executors/workflow.test.ts        → 28 pass, 0 fail
bun test packages/core/src/scripts/registry.test.ts               → 23 pass, 0 fail
bun test packages/core/src/queue/job-store.test.ts                → 14 pass, 0 fail
bun test packages/core/src/queue/job-store.pagination.test.ts     →  3 pass, 0 fail
bun test packages/core/src/jobs/runs/sweeper.test.ts              →  6 pass, 0 fail
bun test packages/core/src/retention/                             → 14 pass, 0 fail (2 files)
bun run typecheck                                                  → all packages OK
bun run build:studio                                                → exit 0
```

No test under `packages/sdk` was run, per the plan-310 guard; `bun test` was never run bare.
