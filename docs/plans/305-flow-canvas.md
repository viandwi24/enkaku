# Plan 305 — Flow : The canvas becomes the editor of record

> Status: implemented (software)
> Ships: packages/studio/src/components/flow/FlowEditor.tsx
> Depends on: plans 301, 303
> Spec references: §13 (Studio); design system `docs/design.md`

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A node dragged and dropped keeps its position across save, reload, and a second browser | `ui.x/ui.y` round-trip through `PUT /api/workflows/:name` | owner smoke step 1 (§7) — plan 300 **P1** | owner |
| G2 | Three ways to add a node all work | `+` on an edge; drag from a handle to empty canvas; the palette's search | owner smoke step 2 — **P2**, **P3** | owner |
| G3 | Delete, duplicate, copy, paste, box-select and multi-drag all work | 6 gestures | owner smoke step 3 — **P4** | owner |
| G4 | Undo and redo cover every structural edit, 50 deep | `cmd+z` / `cmd+shift+z`; the 51st edit drops the oldest | owner smoke step 4 — **P5** | owner |
| G5 | Auto-arrange restores a readable layout and is one undo step | 1 button, 1 history entry | owner smoke step 5 — **P12** | owner |
| G6 | The list editor is gone — one editor, not two | files deleted, no view toggle, no `workflowEditorView` pref | §10's greps all empty | [x] |
| G7 | Findings appear on the node they belong to, live, without a save | debounced `POST /api/workflows/validate`, ≤ 1 request per 400 ms | `rg -n "400" packages/studio/src/components/flow/useValidation.ts` finds the debounce constant; owner smoke step 6 | [x] mechanical half; owner smoke step 6 open |
| G8 | Unreachable nodes and dangling edges are visibly marked, not hidden | dimmed node, dashed edge stub | owner smoke step 6 | owner |
| G9 | `bun run typecheck` and `bun run build:studio` clean | 0 errors each | both exit 0 | [x] |
| G10 | No test file was added for Studio | 0 new `*.test.tsx` | `rg --files packages/studio -g '*.test.tsx'` → empty (plan 200 §8.3) | [x] |

## 1. Goals

Plan 300 P1–P5 and P12, on the document plan 301 produced, with the node types
plan 303 registered. After this plan the canvas **is** the document: there is
no second place to edit a workflow.

## 2. Non-goals

| Not done here | Where |
|---|---|
| The node panel's data panes, the expression editor | plan 306 |
| Live run highlighting and replay | plan 307 |
| Sticky notes | §9 Q2 |
| Autosave | §3.5 — explicit save, on purpose |
| Any test file | plan 200 §8.3 forbids it |

## 3. Context and design decisions

### 3.1 What exists and is kept

[WorkflowCanvas.tsx](../../packages/studio/src/components/workflow/WorkflowCanvas.tsx)
already uses React Flow v12 with pan, zoom, minimap, hit-testing, connection
dragging and edge reconnection, and already turns a completed connection back
into an `EdgeChange` for the caller rather than holding edge state of its own.
That design is right and survives. What changes is that positions become real
(`draggable: false` at line 163 and `nodesDraggable={false}` at line 232 both
go), and that the list beside it goes away.

`@xyflow/react` is already on `^12.11.3` and current is 12.11.6 (plan 300 R1) —
no upgrade is needed and none is done in this plan.

### 3.2 What React Flow does **not** give us

Plan 300 R1's caveat: v12 ships pan/zoom, multi-select, box-select and
keyboard basics. It does **not** ship undo/redo, copy/paste, a palette, or
insert-on-edge. Those are this plan's actual work, and they are built against
the **document**, not against React Flow's node array — which is the single
most important structural decision here (§3.3).

### 3.3 History is over the document, not over the canvas

Undo must reverse "added a node", "rewired an edge", "renamed a node",
"changed a parameter" — some of which happen in a side panel React Flow never
sees. So the history stack holds **immutable `WorkflowDoc` snapshots**, and
the canvas is a projection of the current one, exactly as edges are already a
projection today.

```ts
interface History {
  past: WorkflowDoc[]   // ≤ 50
  present: WorkflowDoc
  future: WorkflowDoc[]
}
```

Two rules that keep it honest:

- **Every mutation goes through one reducer.** `applyDocEdit(doc, edit)` in
  `packages/studio/src/components/flow/doc-edit.ts`, a pure function with a
  closed `DocEdit` union. Nothing else may produce a new document. This is
  what makes G4 provable by reading one file instead of auditing twenty.
- **Coalescing is by intent, not by time.** Dragging a node produces one
  history entry on drop, not sixty during the drag; typing in a title field
  produces one entry per focus session. `applyDocEdit` takes a
  `coalesceKey?: string` and the store merges consecutive edits sharing it.

Snapshots of a ≤ 128 KB document, 50 deep, is ≤ 6.4 MB worst case and in
practice far less. That is cheaper than the bug surface of an inverse-operation
scheme, and it is the same trade `WorkflowCanvas` already made by deriving
edges instead of storing them.

### 3.4 Copy, paste, and ids

Copying serialises the selected nodes plus the edges **between** them into
`application/json` on the clipboard, with a `enkaku/flow-nodes@1` envelope.
Pasting remaps every id (`read` → `read-2`), rewires the internal edges to the
new ids, drops edges pointing outside the selection, and offsets positions by
+24/+24. Pasting into a **different** workflow works and is wanted — it is how
an author reuses a pattern. Pasting a node whose plugin is not installed
produces a node that renders with its raw ref and a "not installed" badge,
because refusing the paste would lose the author's work for a reason they can
fix later.

### 3.5 Explicit save, not autosave

n8n autosaves; this does not, and the reason is the device farm. A workflow is
published, snapshotted at enqueue, and may be running on twenty phones. An
editor that writes on every keystroke turns a half-finished thought into a
publish. So: an explicit **Save**, a dirty indicator, a browser-level warning
on navigate-away, and validation that runs continuously (G7) so Save is never
the first time an author learns something is wrong.

### 3.6 The palette

Fed by `GET /api/node-types` (plan 303 §4.3). Grouped: core control nodes
first, then one group per plugin, each sorted by title. Search matches title,
description, plugin id and `keywords`, ranks prefix matches first, and is
capped at 5 visible results before scrolling (plan 300 P3's parameter). It
opens in three places — the toolbar button, a drag from a handle onto empty
canvas (dropped at the cursor), and `+` on an edge (inserted between, with
both edges rewired) — and all three call the same component with a different
`onPick`.

## 4. Technical design

### 4.1 File layout

```
packages/studio/src/components/flow/
  FlowEditor.tsx        the page-level shell: canvas + palette + panel + toolbar   (the artefact)
  FlowCanvas.tsx        React Flow, controlled by the document                     (from WorkflowCanvas.tsx)
  FlowNode.tsx          one node's card: icon, title, summary fields, badges
  FlowEdge.tsx          edge with a `+` affordance at its midpoint
  NodePalette.tsx       searchable, grouped, keyboard-navigable
  doc-edit.ts           `DocEdit` union + `applyDocEdit` (pure)
  useHistory.ts         past/present/future over documents
  useClipboard.ts       copy/cut/paste with id remapping
  useValidation.ts      debounced validate, findings keyed by node id
  layout.ts             `computeLayout` moved here, unchanged, now behind Auto-arrange
```

`derive-graph.ts`, `edges.ts`, `canvas-edit.ts`, `promote.ts`,
`scriptBindings.ts`, `ParamsEditor.tsx`, `PredicateEditor.tsx`,
`ValueExprEditor.tsx`, `ScriptPicker.tsx` **stay** and are re-imported from the
new directory; plan 306 rebuilds the panel that uses them.

### 4.2 `DocEdit`

```ts
export type DocEdit =
  | { t: 'add-node'; node: WorkflowNode; connectFrom?: { id: string; edge: EdgeKind } }
  | { t: 'insert-on-edge'; edge: { from: string; kind: EdgeKind }; node: WorkflowNode }
  | { t: 'remove-nodes'; ids: string[] }        // also clears every edge pointing at them
  | { t: 'move-nodes'; positions: Record<string, WorkflowPoint> }
  | { t: 'set-edge'; from: string; kind: EdgeKind; to: string | undefined }
  | { t: 'update-node'; id: string; patch: Partial<WorkflowNode> }
  | { t: 'paste'; nodes: WorkflowNode[]; edges: { from: string; kind: EdgeKind; to: string }[] }
  | { t: 'auto-arrange' }
```

`remove-nodes` refuses to remove the `start` node (plan 301 §3.4) and says so
in a toast rather than silently ignoring the keystroke.

### 4.3 Keyboard

| Key | Action |
|---|---|
| `Delete` / `Backspace` | remove selection |
| `cmd/ctrl+z`, `cmd/ctrl+shift+z` | undo, redo |
| `cmd/ctrl+c`, `cmd/ctrl+x`, `cmd/ctrl+v` | copy, cut, paste |
| `cmd/ctrl+d` | duplicate in place |
| `cmd/ctrl+a` | select all |
| `Escape` | clear selection, close the palette |
| `Tab` from a selected node | open the palette wired to that node's free output |

Bindings live in one `useEffect` in `FlowEditor.tsx` and are disabled while an
input or the palette has focus — the omission that makes every canvas editor
delete a node while the user is typing a title.

### 4.4 Rendering rules (design system)

Per `docs/design.md`: tokens only, `bg-panel` / `text-faint` forms, never
`dark:`, never the v3 bracket form. A node card is 220 × 64 at rank spacing
240 × 130 (`layout.ts`'s existing constants, so an upgraded document opens
unchanged). States: selected (accent ring), unreachable (50 % opacity),
has-error finding (`led-bad` ring), has-warning (`led-warn` ring), pinned
(a pin glyph, plan 304 §3.3), not-installed (dashed border, raw ref shown).

### 4.5 Validation loop

`useValidation.ts` debounces 400 ms, posts the current document to
`POST /api/workflows/validate` (which exists —
[api/workflows.ts:160](../../packages/core/src/api/workflows.ts)), and keys the
returned `WorkflowFinding[]` by the node index in its `path`
(`nodes[2].params.keyword` → node 2), reusing `WorkflowBuilder`'s existing
`nodeIndexOf` regex rather than inventing a second parser. Findings render on
the node and, for the selected node, in the panel.

## 5. Implementation steps

**305.1 — Move and rename.** Create `components/flow/`, move `WorkflowCanvas.tsx`
→ `FlowCanvas.tsx` and `compute-layout.ts` → `layout.ts` with `git mv`, update
imports. No behaviour change. *Result*: `bun run build:studio` clean.

**305.2 — `doc-edit.ts`.** The pure reducer of §4.2, complete, before any UI
uses it. *Result*: typecheck clean; every later step calls only this.

**305.3 — Positions are real.** Remove `draggable: false` and
`nodesDraggable={false}`; wire React Flow's `onNodeDragStop` to a
`move-nodes` edit (one entry per drag, §3.3). *Result*: **P1** demonstrable.

**305.4 — History.** `useHistory.ts`, with coalescing keys. Wire undo/redo
keys. *Result*: **P5**.

**305.5 — Palette.** `NodePalette.tsx` fed by `GET /api/node-types`, opened
from the three entry points of §3.6. *Result*: **P2**, **P3**.

**305.6 — Clipboard and selection.** `useClipboard.ts` per §3.4; box-select and
multi-drag come from React Flow and need only to be enabled. *Result*: **P4**.

**305.7 — Auto-arrange.** A toolbar button emitting one `auto-arrange` edit.
*Result*: **P12**.

**305.8 — Validation and node states.** `useValidation.ts` and §4.4's states.
*Result*: G7, G8.

**305.9 — Delete the list editor.** Remove `WorkflowBuilder.tsx`'s list layout,
`NodeCard.tsx`, `BranchRail.tsx`, the view toggle and the
`workflowEditorView` local pref; `scripts/editor/page.tsx` renders
`FlowEditor`. The **same plan** that makes the canvas authoritative deletes the
alternative — 00-overview §4.3 forbids keeping a weaker parallel path "for one
release". *Result*: G6, §10's greps.

**305.10 — Status and report.**

## 6. Acceptance criteria

- G6, G7, G9, G10 mechanically; G1–G5 and G8 at the owner sitting.
- `rg -n "nodesDraggable=\{false\}|draggable: false" packages/studio/src` → empty.
- `rg -n "applyDocEdit" packages/studio/src/components/flow` → every mutation
  site, and no `setDraft(` that builds a document by hand.

## 7. Test plan

No unit tests (plan 200 §8.3). Verification is `typecheck`, `build:studio`, and
the owner sitting:

1. Drag three nodes into a shape; Save; reload; open in a second browser — the
   shape is identical. (**P1**)
2. Add a node from the toolbar, by dragging from a handle to empty canvas, and
   by clicking `+` on an edge; the third one is wired between its neighbours.
   Search for a node by a 3-character prefix of its plugin id. (**P2**, **P3**)
3. Box-select two nodes, drag them together, duplicate them, cut and paste
   them into a second workflow. (**P4**)
4. Make ten edits of different kinds; undo all ten; redo all ten. (**P5**)
5. Scatter the graph; Auto-arrange; undo once — the scatter returns. (**P12**)
6. Delete an edge so a node is unreachable and leave one `next` dangling: the
   node dims, the stub dashes, and the finding names both. (G7, G8)

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Should the canvas snap to a grid? | Yes, 8 px, matching the design system's spacing unit. Free positioning looks careless on a screenshot. |
| Q2 | Sticky notes? | Not in this plan. They need a document field (`notes[]`) and therefore a schema change; if wanted, they belong in a plan 301-style model change, not smuggled in here. |
| Q3 | Should a node be renamable to a duplicate title? | Yes — titles are free text; ids are the identity (plan 301 §3.1). |
| Q4 | Minimap on by default? | Yes, bottom-right, collapsible; it is already there and costs nothing. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| The list editor | `packages/studio/src/components/workflow/WorkflowBuilder.tsx` (list half), `NodeCard.tsx`, `BranchRail.tsx` | `test ! -e packages/studio/src/components/workflow/NodeCard.tsx && test ! -e packages/studio/src/components/workflow/BranchRail.tsx` |
| The canvas/list view toggle | `WorkflowBuilder.tsx:79` (`const [view, setView] = useState<'list' \| 'canvas'>`) | `rg -n "'list' \| 'canvas'" packages/studio/src` → empty |
| The `workflowEditorView` local preference | `packages/studio/src/lib/prefs.ts` | `rg -n "workflowEditorView" packages/studio/src` → empty |
| The old `components/workflow/` directory | — | `test ! -d packages/studio/src/components/workflow` (its survivors moved to `components/flow/`) |

## 11a. Browser verification, 2026-09-05

Run by the orchestrating session with the in-app browser against `bun run
dev:studio` on :3001 and a core on :7700, on the owner's `.dev-data`. This is
NOT the owner's gate sitting — it is a machine driving a page, and three rows
below still need a person. It is recorded because it found three defects that
`typecheck`, `build:studio` and the static export all passed.

**Defects found and fixed** (commit `8d7e4c0`):

| # | Defect | Effect |
|---|---|---|
| 1 | `onSelectionChange` built a new `Set` unconditionally; React Flow fires it on every re-sync, including the one our own `nodes` prop caused | "Maximum update depth exceeded" on mount — **the editor did not render at all** |
| 2 | The 1040px node panel was gated on SELECTION (`open={!!selectedNode}`) | The panel covered the canvas the instant a drag began; multi-select was unusable. Now a click selects and a double click opens |
| 3 | `useHistory` nested `setFuture` inside a `setPresent` updater inside a `setPast` updater | Every undo pushed two identical snapshots onto the redo stack, so redo restored a duplicate and appeared to do nothing while its button stayed lit. The three stacks are now one state object — the shape §3.3 specified |

**Rows verified in the browser**:

| Row | Verified | How |
|---|---|---|
| G1 / P1 | ✅ (one browser) | Dragged `start`, saved, re-opened `?name=parity-check`: `ui = {x:-48,y:40}` in the stored document AND `translate(-48px, 40px)` on the restored canvas. The "second browser" half of G1 is still `owner` |
| G2 / P2 | ⚠️ partial | Toolbar → palette → type → Enter adds the node. **Drag-from-handle-to-empty-canvas and `+`-on-edge were not exercised** and stay `owner` |
| P3 | ✅ | `gat` (3 chars) ranks Gate as the only result; the item carries `data-selected`, and Enter picks it |
| G3 / P4 | ⚠️ partial | `cmd+a` selected 2, `cmd+d` → `delay-2`, `cmd+c`/`cmd+v` → `delay-3` (id remap correct), `Backspace` removed all three and **`start` survived**, one undo restored them. **Box-select and multi-drag were not exercised** and stay `owner` |
| G4 / P5 | ⚠️ partial | Drag → `translate(-48px,40px)`; undo → `translate(0px,0px)`; redo → back, redo stack then empty (one entry, no duplicate). **The 50-deep half was not exercised** |
| G5 / P12 | ✅ | Auto-arrange moved `start` (-48,40) → (0,0); one undo restored the scatter exactly |
| G8 | ⚠️ partial | An unreachable `gate` renders with an amber ring and an `UNREACHABLE` badge, and the panel names both findings (`edge-dangling`, `node-unreachable`). The dashed dangling-edge stub was not observed |

**Observed, not fixed** (each needs a decision, none is in this plan's §0):

- **React Flow's `MiniMap` and `Controls` render white on the dark theme.** They ship their own CSS and this plan's tokens never reach them. Visible in every screenshot; it is the most obvious visual defect in the editor.
- **Opening a saved workflow immediately shows "Unsaved"** with no edit made — probably schema defaults applied on load making the parsed document differ from the fetched one.
- Two false alarms worth recording so they are not re-reported: the node palette's Enter key works as merged (the first failure was the driving tool sending `Return`, a different key), and Auto-arrange works as merged (the first click missed the button). Both were re-tested against the unmodified code before anything was changed.

## 11. Handoff report

- **Worktree branch**: `worktree-agent-abd9e6e13e6cad0d7`, cut (long before this
  session) at `d96d2be` — 313 commits behind `mvp`'s tip, missing plans
  301–303 entirely (v1 workflow doc, no `switch`/`delay`, no node registry).
  This was discovered only after the first pass of implementation was
  written against a stale `model.ts`; see "Discrepancies" below for the full
  story and the merge that fixed it.

- **Checklist**: G1 owner, G2 owner, G3 owner, G4 owner, G5 owner, G6 ✅
  (mechanical, greps below), G7 ✅ mechanical half (the 400 ms debounce
  constant and the `findingsByNodeIndex` wiring exist and typecheck; the
  live-on-canvas half is owner smoke step 6), G8 owner, G9 ✅, G10 ✅.
  **Six of the twelve parity rows this plan owns (P1, P2, P4, P5, P12, and
  half of P6/G8's "visibly marked") can only be checked by a human at a
  keyboard clicking, dragging and pressing keys in a real browser against a
  running core — nothing in this session drove a browser, so every `owner`
  row above is an honest gap, not a formality.**

- **Commits** (branch `worktree-agent-abd9e6e13e6cad0d7`, in order):
  - `91ff4e2` — `wip(flow-305)`: the initial `git mv` and a first `doc-edit.ts`,
    written against the stale pre-301 base (later corrected).
  - `c3dda44` — `merge(flow-305)`: merged `mvp`'s tip (313 commits, through
    `feat(flow-303)`) into this branch and resolved the resulting
    modify/delete conflicts on `NodeCard.tsx`/`WorkflowBuilder.tsx`/
    `model.ts`/`derive-graph.ts`/`edges.ts`/`canvas-edit.ts`/
    `GateOutcomeEditor.tsx` by deleting them, per plan intent.
  - `63a48b2` — `feat(flow-305)`: `FlowEditor.tsx`, `FlowCanvas.tsx`,
    `FlowNode.tsx`, `FlowEdge.tsx`, `NodePalette.tsx`, `doc-edit.ts`,
    `useHistory.ts`, `useClipboard.ts`, `useValidation.ts`, `layout.ts`,
    the updated `derive-graph.ts`/`edges.ts`/`canvas-edit.ts`, the
    rewritten `/scripts/editor` page, `fetchNodeTypes` in `lib/api.ts`,
    `prefs.ts`'s `workflowEditorView` removed. Typecheck clean end to end.
  - `9e8bbb7` — `chore(flow-305)`: dropped a dead re-export left over from
    an earlier draft of `useClipboard.ts`.
  - This report and the `> Status:`/`Ships:` line corrections are the final
    commit, made together with this file.

- **Why the merge happened, in full** (the discrepancy that matters most):
  the assigned worktree had been branched from `mvp` at `d96d2be`, well
  before plans 301–303 landed. Every file this session read through the
  `Read`/`Bash cat` tools against the **non-worktree** path
  (`/Users/solpochi/Projects/oss/openpf/...`, without the
  `.claude/worktrees/...` prefix) was silently served from the **main
  checkout**, which was already at plan 303's tip — so the plan's own
  citations (`workflow.ts`'s six kinds, `registry.ts`, `GET /api/node-types`)
  all checked out correctly, but the actual worktree this session could
  edit and commit in was 313 commits behind and had none of it. The first
  implementation pass (the `91ff4e2` commit) was written and moved files
  against that stale reality. Caught only when `git status`/`git log`
  finally ran against the worktree's own git store (via `/usr/bin/git`,
  which bypasses whatever wrapper was redirecting plain `git` commands) and
  showed `schema: z.literal(1)` and no `registry.ts` in the files this
  session had just edited. Fixed by committing the stale work as a `wip`
  checkpoint, merging `mvp`'s tip in, and resolving the resulting
  modify/delete conflicts by taking the deletions (all seven conflicted
  files are ones this plan deletes anyway). Recorded at length because it
  is exactly the class of failure plan 200 §8.5's round-gate process exists
  to catch, and no round gate ran here — a single-plan worktree assigned
  behind the tip is a gap that process does not cover.

- **Discrepancies between plan and code**:
  - **§4.1's file layout says `derive-graph.ts`, `edges.ts`, `canvas-edit.ts`
    "stay" unchanged, "re-imported from the new directory."** In fact all
    three imported `WorkflowDocDraft`/`WorkflowNodeDraft` from the deleted
    `model.ts`, and none of them understood `switch`/`delay` (added by plan
    303, after these files were last touched, and never backported to
    Studio — 303 §2's own non-goals say the canvas is plan 305's job). All
    three were rewritten to operate directly on `@enkaku/protocol`'s
    `WorkflowDoc`/`WorkflowNode` and to cover all six node kinds
    (`switch`'s `case:<i>`/`default` edges, `delay`'s `next`). Kept their
    original names, their original doc-comment voice, and — for `edges.ts`
    — every exported function's shape, so plan 306 can still reuse them
    exactly as promised.
  - **`GateOutcomeEditor.tsx` was not named in §4.1's "stays" list, and was
    not named in §5/§10 as removed either.** It was `NodeCard.tsx`'s
    only consumer; with `NodeCard.tsx` gone (§5 step 305.9) it had no
    caller left, and its whole job (a `Select` translating "not wired
    yet"/"jump to X") is now inline in `FlowEdge.tsx`'s label and
    `edges.ts`'s `describeOutcome`. Deleted, on the same reasoning §10
    applies to `NodeCard.tsx`/`BranchRail.tsx`.
  - **`model.ts` was not named in §4.1's "stays" list either, but was also
    not named in §10.** It is superseded by design: §3.3 makes the canvas a
    projection of the real `WorkflowDoc`, not a looser "draft" type, so
    `doc-edit.ts`'s `DocEdit` union operates on `@enkaku/protocol`'s own
    types directly. `model.ts`'s few genuinely reusable pieces
    (`freshNodeId`, `placeholderPredicate`, the slugify helper) moved into
    `doc-edit.ts`, where the plan's own §4.2 already expected a reducer to
    live. Deleted the rest (`WorkflowDocDraft`, `docToDraft`,
    `toWorkflowDoc`, `emptyDraft`) as dead once nothing built a draft any
    more.
  - **§4.2's `DocEdit` union has no way to change the document's own
    `name`/`title`/`description`/`maxSteps`/`params`.** Every other field is
    reachable through `update-node` (a node) or the six other cases, but
    none of them touch the document root. A `set-meta` variant was added —
    documented in `doc-edit.ts`'s own comment as *not* part of the plan's
    literal §4.2 block — because a workflow needs a name to be saved at all
    and G4's "no `setDraft(` that builds a document by hand" criterion is
    still met (it is the one extra case in the same, one, `applyDocEdit`
    switch).
  - **Icon names.** `FlowEditor.tsx`'s toolbar wanted a redo glyph and an
    "arrange" glyph; `@enkaku/ui`'s icon allowlist (which this session was
    told not to touch) has neither `ArrowClockwiseIcon` nor `MagicWandIcon`.
    Substituted `ArrowsClockwiseIcon` (redo) and `SquaresFourIcon`
    (Auto-arrange) — both already exported, both legible stand-ins, neither
    a new dependency.
  - **Pinned-node rendering (§4.4's "pinned (a pin glyph, plan 304 §3.3)")
    is wired but structurally inert.** `FlowNode.tsx`'s data shape has no
    `pinned` field because `WorkflowNode` (this worktree's merged-in
    protocol, through plan 303) has no pin data at all — plan 304 owns that
    field and, per the launch instructions, this session could not touch
    `packages/protocol`. Nothing renders a pin badge; nothing claims to.

- **Observed, not done**:
  - The doc-level metadata form (`WorkflowMetaForm`) is a compact
    Name/Title/Step-budget row plus a collapsible Description/Params
    section — functional, but not designed against the handoff the way
    plan 306's node panel will be. It exists only because §4.2's `DocEdit`
    union needed a caller and the workflow needs a name.
  - `NodeInspector` (the node panel's minimal content for this plan — plan
    306 owns the real 3-pane data-flow panel) shows title, findings, and
    kind-specific fields, reusing `ScriptPicker`/`ValueExprEditor`/
    `PredicateEditor` exactly as §4.1 said those files would be for. It has
    no input/output data panes (P6/P7/P8 are explicitly plan 306, §2's own
    non-goal table).
  - `switch`'s per-case `to`/`default` targets are editable only through the
    canvas (drag a connection from a `case:<i>`/`default` handle) — the
    panel edits a case's predicate and label but not its target directly,
    since that is properly an edge, not a node field.
  - The three-`Combobox`/`Command`-based palette caps results only by the
    `CommandList`'s own `max-h-60` scroll container, not a hard slice to 5
    — P3's "first 5 results" is satisfied by ranking (prefix matches sort
    first) rather than by refusing to render a 6th; scrolling past 5 still
    works, matching the design handoff's general "never hide, let it
    scroll" instinct more than a literal 5-item cutoff. Flagged rather than
    silently claimed as the letter of P3.

- **Open questions hit**: none of §9's four questions blocked a step. Q1
  (8 px grid snap) is implemented (`FlowCanvas.tsx`'s `snapToGrid`/
  `snapGrid={[8, 8]}`). Q2 (sticky notes) — not built, as answered. Q3
  (duplicate titles) — never refused; nothing in `doc-edit.ts` checks title
  uniqueness. Q4 (minimap) — on by default, bottom-right (React Flow's own
  default position), via `<MiniMap pannable zoomable ... />` in
  `FlowCanvas.tsx`; a dedicated collapse control was not added (React Flow's
  `MiniMap` has no such affordance out of the box, and building one was
  judged out of this plan's scope).

- **Typecheck**: clean. `bash scripts/typecheck.sh` → `OK` for all 21
  workspace targets (protocol, expr, ui, adb, toolchain, drivers, scrcpy,
  sdk, session, harness, core, node, studio, probe-server, networking,
  proxy-manager, tiktok-automation-pack, mikrotik-routing,
  google-automation-pack, youtube-automation-pack, examples).

- **`bun run build:studio`**: refused — port 3001 was held by the
  concurrently running Studio dev session named in the launch instructions
  (confirmed with `lsof -nP -iTCP:3001 -sTCP:LISTEN`, PID belonging to that
  session, never touched). Ran the underlying build directly instead, per
  the launch instructions' own fallback: `bun run --cwd packages/studio
  build`. It compiled successfully (22.8 s), typechecked, generated 20
  static pages including `/scripts/editor`, and exported cleanly — no
  errors, no warnings beyond Next's own informational "multiple lockfiles"
  notice (pre-existing, unrelated to this plan). `packages/studio/out` and
  `packages/studio/.next` were deleted immediately afterward; `git status`
  confirms neither is tracked or left behind.

- **Tests run**: none — plan 200 §8.3 and this plan's own G10 forbid a new
  Studio test file, and no existing test survived under
  `packages/studio/src/components/workflow/` to break (they were part of
  §10's own deletion list, pre-existing on `mvp` from before this plan and
  removed by the merge conflict resolution above, same as `NodeCard.tsx`
  etc.). No backend package was touched, so no backend test was run.

- **Removed, proven** (§10's four rows, run from the repo root):
  ```
  $ test ! -e packages/studio/src/components/workflow/NodeCard.tsx && test ! -e packages/studio/src/components/workflow/BranchRail.tsx && echo PASS
  PASS

  $ rg -n "'list' \| 'canvas'" packages/studio/src
  (no output — empty)

  $ rg -n "workflowEditorView" packages/studio/src
  (no output — empty)

  $ test ! -d packages/studio/src/components/workflow && echo PASS
  PASS
  ```

- **§6 acceptance criteria, checked**:
  ```
  $ rg -n "nodesDraggable=\{false\}|draggable: false" packages/studio/src
  (no output — empty)

  $ rg -n "applyDocEdit" packages/studio/src/components/flow
  packages/studio/src/components/flow/doc-edit.ts:5:... document goes through. `applyDocEdit(doc, edit)` is pure...
  packages/studio/src/components/flow/doc-edit.ts:129:export function applyDocEdit(doc: WorkflowDoc, edit: DocEdit): WorkflowDoc {
  packages/studio/src/components/flow/useHistory.ts:5:import { applyDocEdit, type DocEdit } from './doc-edit'
  packages/studio/src/components/flow/useHistory.ts:44:        const next = applyDocEdit(current, edit)
  packages/studio/src/components/flow/canvas-edit.ts:7:... EDIT is now `applyDocEdit(doc, { t: 'set-edge', ... })` ...
  ```
  `useHistory.ts`'s `dispatch` is the only call site that invokes
  `applyDocEdit` outside `doc-edit.ts` itself; every mutation in
  `FlowEditor.tsx`/`FlowCanvas.tsx`/`useClipboard.ts` goes through
  `history.dispatch(...)`, never a hand-built document.

- **`bash scripts/check-plan-status.sh`**: found the plan's own `Ships:`
  line backtick-wrapped (`` `packages/studio/.../FlowEditor.tsx` ``), which
  the script cannot resolve as a path — the exact defect plan 220's own
  fix note (200 §8.5) describes. Un-backticked it; the script now reports
  "every plan that declares an artefact agrees with the code" and exits 0.

- **Processes**: nothing left running that this session started.
  ```
  $ ps -Ao pid=,command= | grep -i "[o]penpf"
  (no output)
  ```
  (The concurrently running session's `scrcpy`/`next dev -p 3001` processes
  observed earlier in this session had already exited on their own by the
  time this final check ran; neither was started, stopped, or otherwise
  touched here.)
