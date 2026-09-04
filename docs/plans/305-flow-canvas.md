# Plan 305 — Flow : The canvas becomes the editor of record

> Status: draft
> Ships: `packages/studio/src/components/flow/FlowEditor.tsx`
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
| G6 | The list editor is gone — one editor, not two | files deleted, no view toggle, no `workflowEditorView` pref | §10's greps all empty | [ ] |
| G7 | Findings appear on the node they belong to, live, without a save | debounced `POST /api/workflows/validate`, ≤ 1 request per 400 ms | `rg -n "400" packages/studio/src/components/flow/useValidation.ts` finds the debounce constant; owner smoke step 6 | [ ] |
| G8 | Unreachable nodes and dangling edges are visibly marked, not hidden | dimmed node, dashed edge stub | owner smoke step 6 | owner |
| G9 | `bun run typecheck` and `bun run build:studio` clean | 0 errors each | both exit 0 | [ ] |
| G10 | No test file was added for Studio | 0 new `*.test.tsx` | `rg --files packages/studio -g '*.test.tsx'` → empty (plan 200 §8.3) | [ ] |

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

## 11. Handoff report

_To be written by the executing agent._
