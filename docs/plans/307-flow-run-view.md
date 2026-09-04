# Plan 307 — Flow : The run view — live on the canvas, replay from history, and the spec rewritten

> Status: draft
> Ships: `packages/studio/src/components/flow/RunOverlay.tsx`
> Depends on: plans 304, 305, 306
> Spec references: §4.6 (**rewritten by this plan**), §12, §13

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A running workflow lights its nodes on the canvas as they execute | ≤ 1 s from step start to highlight | owner smoke step 1 — plan 300 **P11** | owner |
| G2 | The edge actually taken is highlighted; a failed node is red | 1 edge per completed step | owner smoke step 1 | owner |
| G3 | Any past run replays on the canvas through the same renderer as the live view | 1 component, 2 sources | `rg -n "RunOverlay" packages/studio/src` → used by both the editor and the job detail page | [ ] |
| G4 | A replayed run draws on the layout it was authored on | the job's own snapshot supplies positions | owner smoke step 2 (plan 301 §9 Q3) | owner |
| G5 | Opening a node during or after a run shows that run's input and output | the panes read the run, not "the last run" | owner smoke step 3 | owner |
| G6 | The live source is the existing WS stream, with no new message type invented | 0 new message types | `rg -n "workflow\." packages/protocol/src/messages/` → no new literal added by this plan | [ ] |
| G7 | Spec §4.6 describes the graph model, the node catalog, expressions and pins | the section no longer says "sequential steps" or "chaining scripts" | `rg -n "chaining scripts\|sequential steps only" docs/spec.md` → empty | [ ] |
| G8 | `docs/design.md` gains the flow editor's patterns | 1 new section, with the node card measurements | `rg -n "Flow editor" docs/design.md` finds it | [ ] |
| G9 | The whole of P1–P12 passes in one sitting | 12 rows read out | §7's gate sitting | owner |
| G10 | `bun run typecheck` and `bun run build:studio` clean | 0 errors | both exit 0 | [ ] |

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
| `schema: 1` accepted on the write routes | `packages/core/src/api/workflows.ts` | `rg -n "schema: 1|WorkflowDocV1" packages/core/src/api/workflows.ts` → empty |
| Spec §4.6's "chaining scripts … sequential steps only" model paragraph | `docs/spec.md` | `rg -n "chaining scripts" docs/spec.md` → empty |

## 11. Handoff report

_To be written by the executing agent._
