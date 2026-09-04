# Plan 307 — Flow : The run view — live on the canvas, replay from history, and the spec rewritten

> Status: implemented (software) — G1, G2, G4, G5, G9 need the owner's gate sitting (§7); step 307.6 is deferred (no data directory to prove zero stored v1 documents against, see §11)
> Ships: packages/studio/src/components/flow/RunOverlay.tsx
> Depends on: plans 304, 305, 306
> Spec references: §4.6 (**rewritten by this plan**), §12, §13

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A running workflow lights its nodes on the canvas as they execute | ≤ 1 s from step start to highlight | owner smoke step 1 — plan 300 **P11** | owner |
| G2 | The edge actually taken is highlighted; a failed node is red | 1 edge per completed step | owner smoke step 1 | owner |
| G3 | Any past run replays on the canvas through the same renderer as the live view | 1 component, 2 sources | `rg -n "RunOverlay" packages/studio/src` → used by both the editor and the job detail page | [x] |
| G4 | A replayed run draws on the layout it was authored on | the job's own snapshot supplies positions | owner smoke step 2 (plan 301 §9 Q3) | owner |
| G5 | Opening a node during or after a run shows that run's input and output | the panes read the run, not "the last run" | owner smoke step 3 | owner |
| G6 | The live source is the existing WS stream, with no new message type invented | 0 new message types | `rg -n "workflow\." packages/protocol/src/messages/` → no new literal added by this plan | [x] |
| G7 | Spec §4.6 describes the graph model, the node catalog, expressions and pins | the section no longer says "sequential steps" or "chaining scripts" | `rg -n "chaining scripts\|sequential steps only" docs/spec.md` → empty | [x] |
| G8 | `docs/design.md` gains the flow editor's patterns | 1 new section, with the node card measurements | `rg -n "Flow editor" docs/design.md` finds it | [x] |
| G9 | The whole of P1–P12 passes in one sitting | 12 rows read out | §7's gate sitting | owner |
| G10 | `bun run typecheck` and `bun run build:studio` clean | 0 errors | both exit 0 | [x] |

## 1. Goals

- A run is visible where it was authored. The single most common debugging
  question — *which branch did it take?* — is answered by looking, not by
  reading a step table.
- Live and historical use one renderer, so they can never disagree.
- The specification stops describing the workflow this repo had in August.

## 2. Non-goals

| Not done here | Where |
|---|---|
| Changing what a run records | plan 304 |
| Per-node targets, fan-out | plan 308 |
| A new WS message type | never — G6 |
| Retiring the v1 tolerance in `POST /api/workflows` | §5 step 307.6 does exactly this, and it is the plan's one removal |

## 3. Context and design decisions

### 3.1 One renderer, two sources

`RunOverlay` takes `RunState = Record<nodeId, { status, seq, takenEdge, startedAt, endedAt }>`
and draws it over the canvas. It does not know whether that state came from a
WebSocket or from a finished run's rows — which is what makes G3 provable by
grep instead of by inspection, and what stops the live view and the replay from
drifting into two subtly different truths.

### 3.2 Replay draws on the run's own document

A workflow edited after a run would otherwise replay onto a graph the run never
took. The job's snapshot (`jobs.workflow_doc`) is the document that ran, and
plan 301 §9 Q3 put positions in it precisely so a replay can be faithful. So
the job detail page renders **the snapshot**, not the current workflow, and
says so in one line when the two differ.

### 3.3 No new wire vocabulary

Run and step lifecycle already travel the `/ws` stream that the Jobs screen
consumes. This plan subscribes to the same messages and projects them into
`RunState`. If a fact needed for the overlay is genuinely absent from the
stream, the correct fix is to add the field to an existing message, in plan
304's schema, and to say so in §11 — not to invent a `workflow.node.blink`.

Remember the protocol's own rule: there is no snapshot replay on `/ws`
(CLAUDE.md). The editor fetches the run's current state over HTTP first, then
subscribes — the same order every other live screen already uses.

## 4. Technical design

### 4.1 Files

```
packages/studio/src/components/flow/
  RunOverlay.tsx      node halos, edge highlight, step badges       (the artefact)
  useRunState.ts      HTTP snapshot then WS subscription → RunState
  RunScrubber.tsx     step-by-step scrubbing for a finished run
```

Consumers: `FlowEditor.tsx` (live, when a run of this workflow is in flight)
and `app/jobs/detail/page.tsx` (replay, over the snapshot).

### 4.2 States

| State | Drawing |
|---|---|
| pending | node as normal |
| running | accent halo, pulsing |
| ok | accent ring, step number badge |
| failed | `led-bad` ring, badge, the error's first line on hover |
| pinned | pin glyph, no halo (it did not run) |
| skipped | 40 % opacity |

The taken edge is drawn at 2 px in the accent; every other edge stays at 1 px
in the muted token. Colours come from `docs/design.md`'s tokens; never a
literal hex, never a `dark:` variant.

### 4.3 The scrubber

For a finished run: a slider over `seq`, and the node panel follows it, showing
that step's recorded input and output (plan 304 §4.1). This is the cheapest
possible version of "step through the run" and it needs no new storage.

### 4.4 Spec §4.6, rewritten

The section is rewritten to describe: the v2 document (explicit edges,
positions, `start`/`finish`), the six node kinds, plugin-contributed node
types and their pinned versions, expressions and their boundary, pins as
authoring state, and — unchanged — one device per run, sequential steps, with a
forward reference to plan 308 for what would change that. The paragraph
asserting "chaining scripts" and "sequential steps only for the MVP" as the
whole model goes.

`docs/design.md` gains a **Flow editor** section: the node card measurements,
the six kind colours, the state rings, the palette's grouping rule, and the
three-pane panel's breakpoint.

## 5. Implementation steps

**307.1 — `useRunState`.** HTTP snapshot then WS subscription, projected into
`RunState`. *Result*: state exists before anything draws it.

**307.2 — `RunOverlay`.** §4.2. Mounted by `FlowEditor` when a run is live.
*Result*: **P11** live half.

**307.3 — Replay on the job detail page.** Render the snapshot with the same
overlay, plus the "this workflow has changed since this run" line. *Result*:
G3, G4.

**307.4 — The scrubber.** §4.3, wired to the node panel. *Result*: G5.

**307.5 — Spec and design.** §4.4. *Result*: G7, G8.

**307.6 — Retire the v1 tolerance.** `POST`/`PUT /api/workflows` stop
accepting `schema: 1` bodies; `upgradeWorkflowDoc` remains for stored rows and
job snapshots. Run `scripts/check-workflow-upgrade.ts` once more first: if any
stored row is still v1, this step waits. *Result*: §10.

**307.7 — The gate sitting.** Run §7. *Result*: G9, and the programme's claim
is either true or itemised.

**307.8 — Status and report.**

## 6. Acceptance criteria

- G3, G6, G7, G8, G10 mechanically; G1, G2, G4, G5, G9 at the sitting.
- `rg -n "#[0-9a-fA-F]{6}" packages/studio/src/components/flow` → empty.
- `rg -n "dark:" packages/studio/src/components/flow` → empty.

## 7. Test plan

No Studio tests (plan 200 §8.3). Backend unchanged by this plan.

**The gate sitting** (owner, one device, ~45 minutes). Read plan 300 §2's table
aloud and mark each row:

| Row | Where it is exercised |
|---|---|
| P1, P2, P3, P4, P5, P12 | plan 305 §7's six steps |
| P6, P7, P8, P9, P10 | plan 306 §7's seven steps |
| P11 | steps 1–3 below |

1. Start a workflow with a branch; watch the canvas light up and confirm the
   branch that fired is the one highlighted.
2. Open the job afterwards; the replay draws the same picture on the layout the
   run used.
3. Scrub to step 3; the node panel shows step 3's input and output.

A row that fails is written down with what happened, and the programme is
`implemented (partial)` naming that row — never `implemented` with a row
unread.

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Should the editor follow the cursor (auto-pan to the running node)? | Yes, but only when the user has not panned during this run; a canvas that yanks itself away from where someone is reading is worse than one that does not move. |
| Q2 | Should a live run block editing? | No — edits are local until Save, and Save publishes a new document that does not affect the running job (plan 301 §4.5). A one-line notice says so. |
| Q3 | Concurrent runs of the same workflow on several devices? | The overlay shows one at a time, chosen by a picker in the toolbar. Multiple simultaneous overlays would be unreadable. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| `schema: 1` accepted on the write routes — **DEFERRED, not done** (§11): `bun run scripts/check-workflow-upgrade.ts .dev-data` reports no data directory to check at all ("nothing to check"), which is the plan's own stated reason to leave the tolerance in rather than remove a compatibility path with nothing proving it unused | `packages/core/src/api/workflows.ts` | still present: `rg -n "upgradeWorkflowDoc" packages/core/src/api/workflows.ts` → 3 hits (the tolerance is intact) |
| Spec §4.6's "chaining scripts … sequential steps only" model paragraph | `docs/spec.md` | `rg -n "chaining scripts\|sequential steps only" docs/spec.md` → empty |

## 11. Handoff report

- **Base**: this worktree started at `d96d2be` (a stale point before plan 306 landed). Merged `mvp` in before touching anything, landing on `78f7479 docs(flow-306): correct the processes line …` as required, then branched `flow-307-run-view` from there. No file was read or edited before the merge.

- **Checklist**: G1 ⏳ owner · G2 ⏳ owner · G3 ✅ (`rg -n "RunOverlay" packages/studio/src` shows it imported and used from `FlowEditor.tsx` — the live/editable canvas — and from `components/jobs/WorkflowSteps.tsx` — the replay canvas mounted by `JobDetail.tsx`'s Timeline tab; `RunOverlay` renders exactly one `<FlowCanvas>` in both cases) · G4 ⏳ owner · G5 ⏳ owner · G6 ✅ (`rg -n "workflow\." packages/protocol/src/messages/` → empty, before and after this plan; no new WS message type exists) · G7 ✅ (`rg -n "chaining scripts|sequential steps only" docs/spec.md` → empty) · G8 ✅ (`rg -n "Flow editor" docs/design.md` finds the new section) · G9 ⏳ owner (§7's sitting) · G10 ✅ (`bash scripts/typecheck.sh` all packages OK; `bun run --cwd packages/studio build` compiled, typechecked and exported `/scripts/editor` and `/jobs` cleanly — artefacts deleted after each run per instruction 10, since the wrapper refuses `bun run build:studio` while the concurrent session holds port 3001)

- **Commits**: not yet committed at the time this section was drafted — see the final commit hashes in the message this report ships with (`feat(flow-307): …` for code, `docs(flow-307): …` for the spec/design rewrite). Branch: `flow-307-run-view`.

- **Typecheck**: clean (`bash scripts/typecheck.sh` — all 20 packages `OK`).

- **Build**: `bun run --cwd packages/studio build` — compiled successfully, typechecked, exported 20/20 static pages including `/scripts/editor` and `/jobs`. Artefacts (`packages/studio/out`, `packages/studio/.next`) deleted after verification, as instructed (the port-3001 dev server from the concurrent session was never touched).

- **Tests run** (scoped to files this plan touched, per CLAUDE.md — never the full suite):
  - `bun test packages/core/src/api/workflow-jobs.test.ts` → 5 pass, 0 fail.
  - `bun test packages/core/src/queue/job-store.test.ts` → 13 pass, 0 fail.
  - `bun test packages/core/src/api/workflows.test.ts` → 32 pass, 0 fail.
  - (Run together once more as a final check: 50 pass, 0 fail, 156 `expect()` calls.)
  - No Studio test was added — plan 200 §8.3, G10's own hard row. This plan's backend surface (three schema/route additions, all additive) is what the tests above cover; nothing else needed a new test.
  - `bun run scripts/check-design-tokens.ts` → all checks `ok`.
  - `bun run scripts/check-routes.ts` → `routes ok: 6 in nav, 4 exempt` (no stale `PENDING_REMOVAL` row — this plan removed no route).

- **Removed, proven**:
  - Spec §4.6's old "chaining scripts … sequential steps only" paragraph — `rg -n "chaining scripts|sequential steps only" docs/spec.md` → empty (also fixed a second occurrence of "chaining scripts" in §1's Nouns glossary, which the same grep would otherwise still have caught).
  - `schema: 1` write-route tolerance — **NOT removed, deferred**. Step 307.6's own precondition: `bun run scripts/check-workflow-upgrade.ts .dev-data` → `no database at .dev-data/enkaku.db — nothing to check.` (exit 1). No data directory exists in this worktree at all, so there is nothing to prove zero stored v1 documents against. Per the task's explicit instruction 5, the tolerance stays in (`packages/core/src/api/workflows.ts` — `upgradeWorkflowDoc` still accepts a `schema: 1` body on `POST`/`PUT`), and the §10 row above is marked deferred rather than done.

- **What shipped, concretely**:
  - `packages/studio/src/components/flow/useRunState.ts` (new) — `GET /api/workflow-jobs/:id/runs/:runId/steps` first, then a `ws.on('job.status', …)` subscription filtered on `payload.jobId === jobId || payload.parentWorkflowJobId === jobId` (the same field `use-job-detail.ts` already reads for "step N of workflow job"), plus a 1.5s poll fallback while the run is not finalized (see the gap noted below). Projects into `RunState = Record<nodeId, RunNodeState>`.
  - `packages/studio/src/components/flow/RunOverlay.tsx` (new, the plan's `Ships:` artefact) — renders exactly one `<FlowCanvas>`, fed by `useRunState`. `FlowEditor.tsx` mounts it in place of the `FlowCanvas` it used to render directly (editable, over the workflow's own last real run, fetched via the existing `fetchWorkflowLastRun`); `components/jobs/WorkflowSteps.tsx` mounts it read-only, over the specific job/run being viewed, with the job's own `workflowDoc` snapshot for positions.
  - `packages/studio/src/components/flow/RunScrubber.tsx` (new) — a plain range input over `seq`, wired into `WorkflowSteps.tsx` to drive a compact input/output pane (`DataView`, reused unchanged) for the selected step.
  - `FlowCanvas.tsx`, `FlowNode.tsx`, `FlowEdge.tsx` — extended, not rebuilt: an optional `runState`/`readOnly` prop on `FlowCanvasProps`, an optional `run?: RunNodeState` on `FlowNodeData` (rings/halo/step-badge per §4.2's state table), an optional `taken?: boolean` on `FlowEdgeData` (2px accent stroke for the taken edge). Every existing caller (there was only one, `FlowEditor.tsx`, now routed through `RunOverlay`) is unaffected when these props are absent.
  - **Three existing-message extensions** (§3.3's own instructed fix for a genuinely-absent fact, applied to the HTTP surface the same way it is meant for the WS one — no new route, no new message type):
    - `WorkflowStepInfoSchema` (`packages/protocol/src/api/workflow-jobs.ts`) gained `input`, `takenEdge`, `pinned` — the DB columns (`workflow_steps.input`/`.taken_edge`/`.pinned`) already existed from plan 304 but were never surfaced over `GET /api/workflow-jobs/:id/runs/:runId/steps`; the run view's scrubber and edge-highlight both need them.
    - `WorkflowLastRunResponseSchema` (`packages/protocol/src/api/workflow-last-run.ts`) gained `jobId` — needed so `FlowEditor.tsx` can identify which workflow job's `job.status` broadcasts to subscribe to for its own last real run, without a second lookup.
    - `JobDetailSchema` (`packages/protocol/src/messages/job.ts`) gained `workflowDoc` (the parsed, already-v2-upgraded `jobs.workflow_doc`) — needed for G4 (replay draws on the run's own layout, not the workflow's current one).
  - `docs/spec.md` §4.6 rewritten in full (document v2, explicit edges, stored positions, six node kinds, plugin node descriptors, named-outputs data flow, the expression boundary, pins as authoring state, the still-true one-device/sequential-steps line with a forward reference to plan 308) — §1's Nouns glossary line for "workflow" updated too.
  - `docs/design.md` gained a new `## Flow editor` section (node card measurements, the three-not-six colour grouping the actual code implements, the state-ring layering including the run overlay's own set, the palette's grouping rule, the panel's real breakpoint, the replay canvas).

- **Discrepancies between plan and code**:
  1. **§4.1's file list names `app/jobs/detail/page.tsx` as a consumer — this file does not exist.** Plan 218 §3.3 deleted the second job-detail route: the Jobs screen (`app/jobs/page.tsx` → `components/jobs/JobsScreen.tsx` → `components/jobs/JobDetail.tsx`) renders the detail IN PLACE, never as a second route (confirmed by reading `JobDetail.tsx`'s own doc comment). The workflow job's Timeline tab is `components/jobs/WorkflowSteps.tsx`, already wired from `JobDetail.tsx` — that is where `RunOverlay` is actually mounted for replay. Followed the file, not the plan's path, per the task's own instruction to do so; recorded here as the discrepancy the file's contents already state.
  2. **§4.2's state table calls the failed ring `led-bad`.** No such token exists — `packages/ui/src/theme.css` defines `--color-led-ok` / `--color-led-warn` / `--color-led-danger`, and the surrounding `FlowNode.tsx` code (plan 305/306) already uses `led-danger` for exactly this purpose. Used `ring-2 ring-led-danger`, matching the file that already existed, not the plan's invented name.
  3. **§4.1 implies `RunOverlay` is the whole visible artefact standing alone; in practice it had to be threaded through `FlowCanvas`/`FlowNode`/`FlowEdge`.** Rebuilding node/edge rendering inside `RunOverlay` itself would have duplicated `FlowCanvas`'s entire node/edge derivation (`deriveGraph`, the `ui`/fallback-layout position logic, every callback prop) — a second renderer in substance even if `RunOverlay` were the only file literally shipped. Instead `RunOverlay` renders exactly one `FlowCanvas`, and `FlowCanvas`/`FlowNode`/`FlowEdge` gained small, additive, optional props (`runState`, `readOnly`, `data.run`, `data.taken`) that do nothing when absent — this is what makes "one renderer, two sources" (§3.1) literally true rather than aspirational, and is believed to be within "does not rebuild any of them" (instruction 2's own wording — extending is not rebuilding).
  4. **`NodePanel.tsx`'s own doc comment says the three-pane layout activates "at ≥ 1280 px"; the code is `lg:grid-cols-3`, Tailwind's default `lg` breakpoint (1024 px), and no project-level override was found.** `docs/design.md`'s new section documents the code's actual behaviour (1024 px), not the comment's stated one — the file wins for facts, the comment is stale from plan 306 and not this plan's to fix.
  5. **`NodePanel.tsx` was NOT modified to read a specific (non-latest) run's input/output**, contrary to what a literal reading of §3.1 ("the panes read the run, not 'the last run'") might suggest applies everywhere. On inspection this distinction only matters for the REPLAY surface (job detail page, which can show an older, non-latest run): `FlowEditor.tsx`'s own node panel always shows the workflow's LAST real run, and `RunOverlay`'s live overlay in that same editor is *also* fed from that same last real run (`fetchWorkflowLastRun`), so the two already agree by construction — extending `NodePanel` was unnecessary there. For the replay surface, a full `NodePanel` (with its run-a-node/pin controls, parameter editing, script picker) makes no sense over a read-only historical run on a possibly-stale document snapshot, so a separate, much smaller read-only input/output pane (`RunScrubber` + `DataView`, inside `WorkflowSteps.tsx`) was built instead of extending the heavy authoring component. Recorded as a deliberate scope decision, not an oversight.

- **Observed, not done**:
  - **No live WS signal exists for `gate`/`switch`/`delay` steps.** Only a `script` step enqueues a real child job (with its own `job.status` broadcasts); the other kinds settle inside the workflow job's own process with nothing broadcast per-step. `useRunState`'s 1.5s poll fallback (while the run is not finalized) is the honest, additive answer §3.3 asks for when a fact is genuinely absent from the stream — it re-reads the same HTTP snapshot every existing consumer already trusts, never a second source of truth. This means G1's "≤ 1s from step start to highlight" is only reliably met for `script` steps; a fast `gate`/`switch` step may settle between polls and simply never show a visible `running` frame at all (it will still show its final `ok`/`failed` state on the next poll or WS-triggered refetch). Named for the owner's gate sitting, not hidden.
  - **No "edits are local, the run is independent" one-line notice was added to `FlowEditor.tsx`** (plan §9 Q2's own stated answer). `RunOverlay` does not expose whether the run it is drawing is still live to its caller (deliberately encapsulated, so `FlowEditor` never has to reason about live-vs-replay), and threading that one boolean back out felt like more surface than the notice was worth against the time this plan had. A real gap, not a refusal — cheap to add later by having `useRunState` return `status` and `RunOverlay` accept an `onStatusChange` callback.
  - **Q3's toolbar picker for concurrent runs of the same workflow on several devices** was not built — `fetchWorkflowLastRun` returns exactly one (the latest) run, so the editor's live overlay only ever shows one run at a time by construction, which happens to satisfy Q3's stated answer ("the overlay shows one at a time") without a picker UI, but there is no way to choose a DIFFERENT concurrent run from the editor. Acceptable given Q3 is an open question, not a goal row.
  - `#0` step badges never collide with the existing `unreachable` badge (`-top-2 right-1`) in practice, since an unreachable node cannot also be a run step — not verified with a live run, only by reading the two conditions as mutually exclusive.

- **Open questions hit**: none blocked a step. §9's three questions (auto-pan Q1, live-run-blocks-editing Q2, concurrent-runs picker Q3) were read and their "current answer" columns followed; Q1 (auto-pan to the running node) was not implemented — `RunOverlay` does not move the canvas viewport at all, live or replay — recorded here since Q1's own current answer ("yes, but only when the user has not panned") describes a real feature this plan did not build, not a decision this plan made.

- **What the owner's gate sitting still needs, across the whole programme** (the list instruction 12 asks for, so §7 can be read from one place):
  - **P1–P5, P12** — plan 305 §7's six steps (drag/reload persistence, the three ways to add a node, palette search, delete/duplicate/copy/paste/box-select/multi-drag, undo/redo 50 deep, Auto-arrange).
  - **P6–P10** — plan 306 §7's seven steps (node panel three-pane layout, click-to-insert a data reference, live expression preview ≤150ms, run-one-node, pin/unpin with production ignoring pins).
  - **P11** — this plan's own §7 steps 1–3 (watch a branch fire live and confirm the highlighted edge is the one taken; open the job afterwards and confirm the replay draws the same picture on the run's own layout; scrub to step 3 and confirm the panel shows that step's input/output).
  - **G1, G2, G4, G5, G9** — this plan's own owner rows, all exercised by the same P11 sitting above; no separate session needed.
  - Every P-row and G-row above needs a **physical device** — none of it can be verified from this worktree, which has no `.dev-data`, no attached hardware, and per instruction 9 must not touch the concurrent session's dev server on port 3001.

- **Processes**: `ps aux | grep -i "next\|bun run dev\|enkaku" | grep -v grep` → no output. No dev server, no build watcher, no background process was started or left running by this session.
