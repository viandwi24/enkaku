# Plan 102 — M67 : The workflow canvas

> Status: partial — 102.1 through 102.6 are implemented and unit-tested.
> 102.4 now ships the real side panel §4.1 specifies (the SAME `NodeCard`
> the list editor uses, mounted beside the canvas — no second form
> component, no scroll-to-list interim). 102.5 (editing through the canvas)
> is implemented: dragging a connection, reconnecting an edge, or deleting
> one writes straight to `next`/`onFailure`/`then`/`else` through
> `canvas-edit.ts`, the exact inverse of `derive-graph.ts` — there is still
> no `edges` array anywhere. 102.7 is owner-run and unfilled (§7 table
> below, empty Outcome column as required); H-3's *mechanized* round-trip
> property is additionally proven by an automated test
> (`canvas-edit.test.ts`), which is evidence for the owner's own manual
> H-3 check, not a substitute for it — the Outcome column stays empty.
> Depends on: Plan 99 (M64) — the workflow document, executor, resolver and list editor all ship there; this plan adds a second view onto the same document and changes neither the format nor the executor. Plan 101 (M66) for visual tokens only, and not for correctness: this plan may land before or after it, but §3.6 explains why landing after is cheaper.
> Spec references: §11.7 (the workflow editor), §19 (Studio screen spec — including the schema-driven rendering principle this plan takes a deliberate, scoped exception to)
> Ships: packages/studio/src/components/workflow/WorkflowCanvas.tsx

---

## 0. Evidence

### 0.1 Confirmed findings

| # | Finding | Evidence |
|---|---------|----------|
| **G1** | **Plan 99 §3.9 recommended against a canvas for v1 and priced it**: the list editor is ~10 steps / ~1 300–1 800 lines reusing `SchemaForm`, `ParamSetPicker`, `DevicePicker`, `PaginatedTable`; a canvas was *"~8 more steps, ~2 500–4 000 more lines, reuses almost nothing, needs a layout algorithm."* | `docs/plans/99-m64-workflows.md:1819-1842` |
| **G2** | That same section states the shipped data format *"a graph canvas could render later with **no migration**."* This plan's §3.2 tests that claim rather than repeating it. | `docs/plans/99-m64-workflows.md:1165-1167` |
| **G3** | **The workflow document stores no layout coordinates.** A repo-wide search of `packages/protocol/src/workflow.ts` for `x:`/`y:`/`position`/`layout`/`coord` returns nothing but one unrelated prose comment. | `packages/protocol/src/workflow.ts` |
| **G4** | **Edges are implicit, not a list.** A `script` node carries `next?: WorkflowNodeId`; a `gate` carries `onFailure: GateOutcome` and the outcome union is `{go:'continue'\|'stop'\|'fail'}` or `{go:'goto', node}`. There is no `edges` array to read or write. | `packages/protocol/src/workflow.ts:199`, `:210-241` |
| **G5** | `goto` **may jump backward** — the document's own comment says so. So the graph is not a DAG and any layout algorithm must tolerate cycles. | `packages/protocol/src/workflow.ts` (`GateOutcomeSchema` doc comment) |
| **G6** | The shipped list editor is **168 lines** — the page; the node rows, branch rail, script/version picker, bindings sub-form, parameter editor with Promote, and Validate live in `packages/studio/src/components/workflow/`. | `packages/studio/src/app/workflows/editor/page.tsx` |
| **G7** | **No graph library is installed.** `bun.lock` contains no `xyflow` or `react-flow`. Studio runs React `^19.0.0`. | `bun.lock`; `packages/studio/package.json` |
| **G8** | Studio is a **static export** (`output: 'export'`), and workspace packages must be listed in `transpilePackages`. | `CLAUDE.md`; `packages/studio/next.config.*` |
| **G9** | Spec §19's rendering principle is that **every config panel is rendered from a schema** through the schema-driven form renderer — *"no hardcoded UI per component."* Plan 99 §3.9 called a canvas *"the exact opposite"* of this. | `docs/spec.md` §19; `docs/plans/99-m64-workflows.md:1832` |
| **G10** | The reference design's canvas is absolutely-positioned nodes with bezier edges and a zoom transform — i.e. it assumes stored or computed positions. | `refs/ui/Enkaku Dashboard.dc.html` (`canvasStyle`, `workflowNodesView`, `edgePaths`) |

### 0.2 Hypotheses (probe before building)

| # | Hypothesis | Probe that settles it |
|---|-----------|----------------------|
| **H1** | `@xyflow/react` v12 supports React 19 and builds cleanly under `output: 'export'`. | Install it in a scratch branch, render three nodes, run `bun run --cwd packages/studio build`. If the static export fails or React 19 is unsupported at the pinned version, §3.4's library choice is void and the fallback there applies. |
| **H2** | Auto-layout produces a readable graph for real workflows without stored positions (§3.2), including one containing a backward `goto` (G5). | Lay out the longest workflow in `examples/` plus a hand-built one with a backward `goto`; judge readability. |
| **H3** | A canvas and the list editor can stay in sync as two views of one document without either becoming the "real" one. | Round-trip test: edit in canvas → open list → edit → reopen canvas; assert the document is byte-identical to the same edits applied in the other order where order is semantically irrelevant. |

---

## 1. Goals

1. A **second view** onto the workflow document — a canvas — with the list editor kept, not replaced.
2. Use a graph library for panning, zooming, edge routing, hit-testing and selection, rather than hand-rolling them (§3.4).
3. **No schema change and no migration** if that is genuinely achievable (§3.2), because plan 99 promised it and the promise should be tested rather than quietly dropped.
4. Make the parts of a workflow that a list cannot show — a backward `goto`, a branch that rejoins, an unreachable node — **visible at a glance**, since that is the only thing a canvas buys.

## 2. Non-goals

- **Not replacing the list editor.** It is keyboard-navigable, diffable, and renders from the schema; §3.5 keeps it as the primary editor and the canvas as the view that answers "what shape is this?".
- **Not a general diagramming surface.** No free-floating notes, no manual edge drawing between arbitrary points. Every edge on the canvas is a projection of `next`/`onFailure` (G4), never an independent object.
- **Not changing the executor, the resolver, or the document format** beyond what §3.2 concludes is unavoidable.

## 3. Context and design decisions

### 3.1 What the canvas is actually for

A list can show ten nodes in order. It cannot show that node 7's gate jumps
back to node 3 (G5), that two branches rejoin, or that a node is unreachable.
Those are shape questions, and shape is what a canvas answers.

That framing decides the scope: the canvas earns its cost on **comprehension**,
not on editing convenience. Where the two conflict, comprehension wins — which
is also why §3.5 keeps the list as the editor of record.

### 3.2 Layout is computed, not stored — and that is what keeps plan 99's promise true

G3: the document has no coordinates. G2: plan 99 promised a canvas would need
no migration. Both cannot be true if the canvas stores positions.

So layout is **computed on open** by a layout algorithm, from `next`/`onFailure`
alone (G4). Nothing is written back to the document. That keeps the format
untouched, keeps two editors from disagreeing about a field only one of them
maintains, and means a workflow authored in the list editor opens in the canvas
already arranged.

The cost, stated plainly: an operator **cannot hand-arrange** nodes and have it
persist. That is a real loss and the plan accepts it, because the alternative
is a `layout` field that the list editor never writes, that goes stale the
moment a node is added elsewhere, and that turns "no migration" into a
migration.

**If H2 shows auto-layout is not readable enough**, the fallback is a
`layout` map stored **outside** the workflow document — keyed by workflow id in
a Studio-local store or a separate table — so the document itself stays clean
and a missing layout always degrades to auto. Decide it on H2's evidence, and
record the decision here.

The algorithm must tolerate cycles (G5). A layered/Sugiyama-style layout
(dagre, elkjs) handles a back-edge by ranking it as a feedback edge; a naive
topological sort does not terminate. This is the specific thing to verify, not
assume.

### 3.3 Edges are a projection, never state

G4: there is no `edges` array. The canvas derives edges from `next` and
`onFailure` on render, and an edge interaction writes back to **those fields**,
never to an edge list. Introducing an edge object that mirrors them would
create two sources of truth for the same fact — and the one the executor reads
would be the one the UI does not.

### 3.4 Use a library, and be explicit about which and why

The owner asked for one and named React Flow. **`@xyflow/react`** (React Flow
v12) is the proposal: it supplies pan, zoom, minimap, selection, edge routing,
hit-testing, and controlled node/edge state — most of what G1's 2 500–4 000
lines were.

What it does **not** supply is auto-layout (§3.2), which is a separate
dependency (`dagre` or `elkjs`). Note that plainly rather than discovering it
mid-build.

H1 gates this: React 19 support and a clean static-export build (G8). If H1
fails at the pinned version, do not hand-roll the canvas — report it, because
that returns the decision to G1's original price and the owner should re-decide
rather than have a plan quietly become four times its estimate.

Both libraries are **Studio-only** additions. They touch no core stack decision
in plan 00 §3.

### 3.5 The list editor stays the editor of record

G9: spec §19's principle is schema-driven rendering, and plan 99 §3.9 called a
canvas its exact opposite. That tension is real and this plan does not pretend
otherwise — it takes a **scoped exception**: the canvas is one bespoke surface,
justified by §3.1, and everything it edits is still edited through the same
schema-driven sub-forms the list editor uses (a node's params, bindings,
`onFailure`) rendered in a side panel.

So: select a node on the canvas → its editor is the **existing** component from
the list editor, not a second implementation. If the canvas grows its own
parallel forms, this exception has been abused and the review should say so.

`docs/spec.md` §19 gets a sentence recording the exception and its reasoning,
in the same step — an undocumented exception to a stated principle is how a
principle stops meaning anything.

### 3.6 Cheaper after plan 101, but not blocked by it

Plan 101 changes token values and the shell. A canvas built before it inherits
the new palette automatically (101 §3.1 — component files do not change), so
there is no rework either way. The reason to sequence after is narrower: both
plans touch `packages/studio/src/components/workflow/` if the canvas lands
first, and 101.5's drag-select work shares selection idioms worth settling once.

---

## 4. Technical design

### 4.1 Data flow

```
WorkflowDocument (unchanged, packages/protocol/src/workflow.ts)
        │  nodes[]: {id, kind, next?, onFailure?}
        ▼
  deriveGraph()        ← pure, tested, no React
        │  {nodes: [{id, kind, label}], edges: [{from, to, kind}]}
        ▼
  computeLayout()      ← dagre/elk, tolerates cycles (G5)
        │  + {x, y} per node, NOT persisted (§3.2)
        ▼
  <WorkflowCanvas>     ← @xyflow/react, controlled
        │  selection → existing node editor components (§3.5)
        ▼
  document mutation → next/onFailure only (§3.3)
```

`deriveGraph` and `computeLayout` are **pure functions in their own files**,
unit-tested without a renderer — the same shape `tile-identity.ts` already uses
so a component test never has to assert on graph maths.

### 4.2 Edge kinds

Derived, not stored (§3.3): a `script` node's `next` is the ordinary edge; a
gate's `onFailure` with `go:'goto'` is a branch edge; `go:'stop'`/`'fail'` are
terminals rendered as end markers rather than edges to a node. A backward
`goto` (G5) is drawn distinctly, because it is the single most valuable thing
the canvas shows that the list cannot.

### 4.3 Unreachable nodes

A node no `next`/`goto` reaches is a real authoring bug the list editor cannot
surface. The canvas marks it. This is `deriveGraph`'s output, not a visual
flourish — so `Validate` can use the same function rather than reimplementing
reachability.

---

## 5. Implementation steps

### 102.1 — `deriveGraph` and `computeLayout`, with no UI at all — DONE.

Pure functions plus tests: edges from `next`/`onFailure` (G4), backward-`goto`
tolerance (G5), unreachable-node detection (§4.3), a layout that terminates on
a cyclic graph. Verifiable result: the longest workflow in `examples/` and a
hand-built cyclic one both produce a finite, non-overlapping layout.

**Shipped.** `packages/studio/src/components/workflow/derive-graph.ts` and
`compute-layout.ts`, no React, no library. `deriveGraph` walks the node array
building edges from `script.next` (defaulting to array-order fallthrough),
`gate.then`/`gate.else` (`GateOutcomeSchema`'s `continue`/`goto`/`stop`/`fail`
union), and marks each edge `backward` when its target's index is `<=` its
source's. `computeLayout` is a rank-based layered layout via **bounded
relaxation over forward edges only** (backward `goto` edges are excluded from
rank computation, so a cycle cannot loop the algorithm — proof is inline as a
code comment) — deliberately not `dagre`/`elkjs`: at ≤50 nodes and a
mostly-linear shape, a real graph library adds a dependency and its own
cycle-detection subtlety for a problem this size does not need; flagged here
as the evidence an H2 failure (102.7) would use to justify one.
**Deviation from the test-plan text above**: no workflow fixtures exist under
`examples/` at all (grep confirms zero `*.workflow.*` files there), so "the
longest workflow in `examples/`" is not a real input — a hand-authored
in-test fixture stood in instead in `derive-graph.test.ts`/
`compute-layout.test.ts`. This is a stale claim in this plan's own §7, not
a new gap; flagging it rather than quietly rewriting the test-plan prose.
Tests: `derive-graph.test.ts` (12 pass), `compute-layout.test.ts` (8 pass).

### 102.2 — H1: prove the library builds — DONE.

Install `@xyflow/react` (+ the layout dependency), render three static nodes,
run `bun run --cwd packages/studio build`. Verifiable result: the static export
succeeds. **If it does not, stop and report** (§3.4) rather than substituting a
hand-rolled canvas.

**Shipped.** `@xyflow/react@^12.11.3` installed via `bun add` (no separate
layout dependency needed — `computeLayout` above is hand-rolled, so React
Flow supplies pan/zoom/minimap/hit-testing only). `bun run --cwd packages/studio
build` succeeds under React 19 and `output: 'export'`. Bundle-size delta,
recorded per §8's risk: `/workflows/editor` page bundle 16 kB → 57.8 kB,
First Load JS 246 kB → 306 kB (measured 2026-08-15, full build log in the
verification section of this pass).

### 102.3 — The canvas, read-only — DONE.

Render a real workflow: nodes, derived edges, backward-`goto` styling,
unreachable markers, pan/zoom/minimap. No editing. Verifiable result: every
workflow in `examples/` renders, and its edge set matches `deriveGraph`'s
output exactly.

**Shipped.** `packages/studio/src/components/workflow/WorkflowCanvas.tsx` —
`nodesDraggable={false}`/`nodesConnectable={false}` (editing was 102.5's
scope, not started at the time this step shipped — see 102.5 below for what
it became; `nodesDraggable` stays `false` unconditionally even after 102.5,
since only edges became editable, never node position/§3.2), custom
`workflowNode` type showing kind icon, title, and
an `unreachable` badge, backward edges drawn dashed/animated in
`--color-led-warn`. `WorkflowCanvas.test.tsx` (4 pass) asserts node labels
render, the unreachable badge appears, and click wiring fires
`onSelectNode` — but **not** an exact DOM edge count: happy-dom has no real
layout engine, so `@xyflow/react`'s per-edge SVG paths never mount (they
depend on measured node dimensions via `ResizeObserver`, which happy-dom
does not provide even when stubbed). Edge-set correctness against
`deriveGraph` is `derive-graph.test.ts`'s job instead — a pure-function test
needs no renderer, consistent with §4.1's "no component test ever has to
assert on graph maths." Same `examples/` caveat as 102.1 applies.

### 102.4 — Selection and the side panel — DONE.

Selecting a node opens the **existing** node editor components from the list
editor (§3.5). Verifiable result: no new form component is added in this step —
asserted by review of the diff's file list, and stated as such here so the
reviewer knows to check.

**Shipped, replacing the prior interim.** `WorkflowBuilder.tsx` now renders a
real side panel beside the canvas (`view === 'canvas'`, `selectedNodeId`
state): clicking a node calls `setSelectedNodeId` (passed straight through
as `WorkflowCanvas`'s `onSelectNode`), and the panel mounts `<NodeCard>` —
the literal import already used by the list view below it, same component
instance, not a copy — passing it the selected node's own index, its
`precedingOptions`/`allOptions`, and the same `onChange`/`onRemove`/
`onMove`/`onPromote` callbacks the list wires, all going through the same
`patchNode`/`updateNode` (`model.ts`) the list already used. The one
difference from the list's own card: no drag-reorder handlers are passed,
because there is never more than one card in the panel to drop onto — Move
up/down (already present on every `NodeCard`) is the non-drag way to do the
same thing, unaffected. A stale selection (the node was removed) is cleared
by a `useEffect` watching `draft.nodes`, and switching to List clears it
too. **Verifiable result, checkably**: `grep -rn "NodeCard" packages/studio/
src/components/workflow/WorkflowBuilder.tsx` shows exactly one import and
two call sites (list, panel) of the SAME component — no second
implementation exists anywhere in the diff.

### 102.5 — Editing through the canvas — DONE.

Reconnecting an edge writes `next`/`onFailure` (§3.3). Verifiable result: H3's
round-trip — canvas edit and list edit produce the same document.

**Shipped.** `packages/studio/src/components/workflow/canvas-edit.ts` is the
exact inverse of `derive-graph.ts` — pure, no React, no `@xyflow/react`
*value* import (only its `Connection` shape, structurally, as a parameter
type) — exporting `retargetEdge`/`clearEdge`/`applyEdgeChange` (dispatches
by `targetId === null`) and `connectionToEdgeChange` (translates a library
`Connection` into `{nodeId, kind, targetId}` by reading `sourceHandle`,
which is always one of the four `EdgeKind` strings, never a separate
lookup table). `WorkflowCanvas.tsx` gives every node a `target` handle plus
one or two named SOURCE handles — `next`/`onFailure` for a script node,
`then`/`else` for a gate — wires `onConnect`/`onReconnect`/`onEdgesDelete`
to that translator, and passes `data.editable` down to each `<Handle>`'s
own `isConnectable` prop (a handle-level prop, confirmed NOT inherited
automatically from the node's own `connectable` flag — an early draft of
this step set only the node-level flag and shipped a canvas whose handles
all still classed `connectable` in the DOM even with no `onEdgeChange`
handed in; caught by the `WorkflowCanvas.test.tsx` assertion added for
exactly this, before it ever reached a commit, not by hand-inspection). `WorkflowBuilder.tsx` wires `onEdgeChange` to
`setDraft((d) => applyEdgeChange(d, change))` — the one and only place a
canvas edge edit becomes a document write, through `updateNode`, same as
every other edit in this file. Node **position** stays uneditable
(`draggable: false` unconditionally) — §3.2's "layout is computed, never
stored" is untouched by this step; only edges became editable, never
coordinates. A backward retarget (an earlier node) is written through the
identical code path as a forward one — `retargetEdge` does not special-case
direction, matching `WorkflowNodeIdSchema` itself.

**Tests.** `canvas-edit.test.ts` (15 pass, no renderer) covers
`retargetEdge`/`clearEdge` for all four `EdgeKind`s including a backward
target, the defensive no-ops (wrong kind for the node, unknown source/target
id), `connectionToEdgeChange`'s translation and its null cases, and three
H3 round-trip tests proving a canvas edit and a list edit commute — on
different nodes, on the SAME node's different fields, and through a
delete — because both paths reduce to the same `updateNode` object-spread.
`WorkflowCanvas.test.tsx` gained three tests proving the WIRING (handle ids
per node kind; a read-only canvas marks no handle `connectable`; an
editable one marks all of them) rather than simulating an actual drag —
happy-dom has no real pointer/geometry engine to simulate one with, the
same reasoning already documented for why this file never asserts on edge
PATH geometry (102.3's own note, above).

### 102.6 — The view toggle, and `docs/spec.md` §19 — DONE.

List ↔ canvas on the editor page, remembering the operator's choice. §19 gains
the sentence recording the scoped exception (§3.5). Verifiable result:
`bun run spec:check` stays at GAP 0; the toggle persists.

**Shipped.** `prefs.ts` gained `workflowEditorView: z.enum(['list',
'canvas']).default('list')` in `LocalPrefsSchema` (localStorage — a property
of the screen, not a per-tab landing rule, same reasoning as
`sidebarCollapsed`). `WorkflowBuilder.tsx` renders a List/Canvas
button-group toggle in the nodes-section header; list stays the default and
the editor of record, per §2/§3.5. `docs/spec.md` §19's Workflows row now
records the scoped exception ("a second **view** of the one schema-driven
form, not a second **implementation** of it"). `bun run spec:check` reports
GAP 0 (tables 0, screens 0, routes 0) after the change.

### 102.7 — H2, and the layout decision it settles — OWNER-RUN, unfilled.

Owner-run (§7). Its outcome decides whether §3.2's computed layout stands or
the out-of-document `layout` map is needed — recorded in §3.2, not left as
folklore.

---

## 6. Acceptance criteria

- [x] `packages/protocol/src/workflow.ts` is **unchanged** — no coordinates, no `edges` array (§3.2, §3.3, G2's promise kept). *(Verified by direct read, not assumed — confirmed zero edits to this file across the whole pass.)*
- [x] `deriveGraph`/`computeLayout` are pure, tested without a renderer, and terminate on a graph containing a backward `goto` (G5). *(`derive-graph.test.ts`, `compute-layout.test.ts` — 20 tests, no renderer.)*
- [x] Every canvas edge corresponds to a `next`/`onFailure` value; no edge exists that the executor would not follow (§3.3). *(`deriveGraph` is the sole edge source for `WorkflowCanvas.tsx`; no edge is synthesized in the component.)*
- [x] The node editor on the canvas is the **same component** the list editor uses — no second implementation (§3.5). *(Met as designed now — `WorkflowBuilder.tsx` imports `NodeCard` once and calls it from two places, the list and the canvas side panel; see 102.4's note above and `grep -c "^import { NodeCard }" packages/studio/src/components/workflow/WorkflowBuilder.tsx` = 1.)*
- [x] The list editor still works and is still the default view (§2, §3.5). *(`workflowEditorView` defaults to `'list'`; full studio suite green.)*
- [x] An unreachable node is marked, and `Validate` uses the same reachability function (§4.3). *(`WorkflowCanvas`'s badge and the existing Validate path both read `deriveGraph(draft).unreachable` — same function, cannot disagree.)*
- [x] Reconnecting, creating, or deleting an edge on the canvas writes `next`/`onFailure`/`then`/`else` and nothing else — no `edges` array was introduced (§3.3, §5 step 102.5). *(`canvas-edit.ts` is the sole write path; `packages/protocol/src/workflow.ts` remains unedited — confirmed by direct read, same as the first row above.)*
- [x] `docs/spec.md` §19 records the scoped exception to schema-driven rendering (§3.5); `spec:check` at GAP 0.
- [ ] `bun run --cwd packages/studio build` succeeds — static export intact (G8). *(NOT re-run in this pass — the Studio dev server was live on :3001 for the whole session (two phones attached, owner working), and `scripts/build-studio.sh` refuses to build while it is running because `next build` corrupts a live `next dev` process. `bunx tsc --noEmit` is clean and the full Studio test suite is green (1235/0) as the closest available substitute, but neither is the same check as a real static-export build. Left unchecked deliberately rather than claimed on a proxy — run `bun run build:studio` once the dev server is stopped, and update this row and the bundle-size note in §8/102.2 with the real number.)*
- [x] `bun run typecheck`, `bun test`, `bun run --cwd packages/studio test` all green. *(One pre-existing, unrelated failure: `packages/core/src/api/jobs.ts(229,49)` TS2739 — present before this pass, owner-arbitrated, untouched here.)*

## 7. Test plan

### Unit (bun test, no renderer)

- `derive-graph.test.ts`: edges from `next`; gate `goto` forward and backward; `stop`/`fail` as terminals not edges; unreachable detection; a node whose `next` names a missing id.
- `compute-layout.test.ts`: terminates on a cycle (G5); no overlapping nodes; deterministic for the same input — a layout that reshuffles on every open is unusable regardless of how it scores on H2.
- `canvas-edit.test.ts` (step 102.5) — the write-back half, symmetric with `derive-graph.test.ts`'s read half: `retargetEdge`/`clearEdge` for all four `EdgeKind`s (including a backward target, and the defensive no-ops for a kind the node does not own or an unknown node id); `connectionToEdgeChange`'s translation of a library `Connection`, including its `null` cases; three H3 round-trip tests (canvas-then-list vs. list-then-canvas, on different nodes, on the same node's different fields, and through a delete) proving the property mechanically rather than only by owner inspection.

### Component

- `WorkflowCanvas.test.tsx`: renders a fixture workflow; edge count matches `deriveGraph`; selecting a node fires `onSelectNode` with the node's id and renders nothing of its own (`WorkflowBuilder.test.tsx` is what proves the SAME `NodeCard` mounts, since that mounting happens one level up, in the panel `WorkflowBuilder.tsx` owns). Step 102.5 additions: every node exposes the correct named handles for its kind (`next`/`onFailure` for a script, `then`/`else` for a gate, `target` on both); a read-only canvas (no `onEdgeChange`) marks no handle `connectable`, an editable one marks all of them — the wiring proven directly rather than by simulating a drag happy-dom has no geometry engine to make real.

### Owner-run

| # | What | How | Outcome |
|---|---|---|---|
| H-1 | The library builds under static export with React 19 (§3.4, gates everything). | Step 102.2's build. | *(owner to fill in)* |
| H-2 | Auto-layout is readable enough to skip stored positions (§3.2). | Open the longest `examples/` workflow and one with a backward `goto`; judge whether the shape is legible without hand-arranging. | *(owner to fill in)* |
| H-3 | Canvas and list stay in sync (§3.5). | Edit in canvas, open list, edit, reopen canvas; compare documents. | *(owner to fill in)* |

## 8. Risks and mitigations

- **The library does not support React 19 / static export.** The single largest risk, and the reason 102.2 is a step of its own before any canvas work. Mitigated by stopping and reporting rather than hand-rolling (§3.4) — the hand-rolled path is G1's original price, which the owner approved this plan *without*.
- **Auto-layout is unreadable for real workflows**, making the canvas prettier than the list but no more useful. Mitigated by H2 being a gate with a named fallback (§3.2), not a hope.
- **The canvas grows its own forms and quietly becomes a second editor**, at which point §3.5's scoped exception to spec §19 is no longer scoped. Mitigated by 102.4's acceptance being "no new form component in this step", stated where a reviewer will read it.
- **Two views drift.** Mitigated by both rendering from one document with no view-private state (§3.2, §3.3) — the canvas owns no field the list does not.
- **Bundle size**, on a static export served from the core to a browser that may be on a farm LAN. Mitigated by measuring it in 102.2 and recording the number here, so a later "why is Studio bigger" has an answer. **Not re-measured after 102.4/102.5** in this pass — the Studio dev server was live for the whole session and `scripts/build-studio.sh` refuses to build while it runs (§6's build checkbox notes the same gap). 102.4/102.5 added one new source file (`canvas-edit.ts`, no new dependency) and a handful of `<Handle>` elements from the ALREADY-installed `@xyflow/react`, so the delta should be small, but "should be small" is a guess, not the measured number 102.2 set the precedent of recording here — re-measure with `bun run build:studio` once the dev server is free and update this line and 102.2's own figure.

## 9. Open questions

1. **If H2 fails, where does the `layout` map live** — a Studio-local store (per browser, so two operators see different arrangements) or a server-side table (shared, but a new table and a migration)? §3.2 names the fallback but not its home, because H2 may make the question moot.
2. **Should the canvas be the default view** for a workflow above some node count, where a list stops being readable? Deliberately unanswered: nobody has watched an operator use either yet.
