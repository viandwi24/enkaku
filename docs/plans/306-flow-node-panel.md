# Plan 306 — Flow : The node panel — data in, parameters, data out, and a live expression preview

> Status: draft
> Ships: `packages/studio/src/components/flow/NodePanel.tsx`
> Depends on: plans 302, 303, 304, 305
> Spec references: §13; `docs/design.md`

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Opening a node shows input left, parameters centre, output right, from the last real run, with no re-run | 3 panes populated on open | owner smoke step 1 — plan 300 **P6** | owner |
| G2 | Clicking a field in the input pane inserts a reference at the cursor in the focused parameter | 1 click, no typing | owner smoke step 2 — **P7** | owner |
| G3 | An expression shows its resolved value while being typed | ≤ 150 ms keystroke→preview, no network request | owner smoke step 3, DevTools network tab empty — **P8** | owner |
| G4 | A parse error underlines the offending token and names it | the error's `offset` is used | owner smoke step 3 | owner |
| G5 | "Run this node" runs it with the last input and fills the output pane | 1 button → a `node-test` run | owner smoke step 4 — **P9** | owner |
| G6 | Pin, unpin, and edit a pin from the output pane; a pinned node is marked on the canvas | 3 controls, 1 canvas badge | owner smoke step 5 — **P10** | owner |
| G7 | The `start` node's panel edits the workflow's `params[]` | the document's inputs live in the start node | owner smoke step 6 | owner |
| G8 | Screenshots and UI trees render as themselves, not as JSON | an image in the output pane; a collapsible tree | owner smoke step 7 | owner |
| G9 | No expression is evaluated on the server for the preview | the browser imports `@enkaku/expr` | `rg -n "@enkaku/expr" packages/studio/src` finds the import; `rg -n "/api/.*(expr\|preview)" packages/studio/src` → empty | [ ] |
| G10 | `bun run typecheck` and `bun run build:studio` clean; no Studio test file added | 0 errors; 0 `*.test.tsx` | both exit 0; `rg --files packages/studio -g '*.test.tsx'` empty | [ ] |

## 1. Goals

Plan 300 P6–P10. This is the plan that decides whether the programme produced a
usable editor or a prettier viewer — plan 300 §6 names the wave-2 gate as one
row covering 305 **and** 306 for exactly this reason.

## 2. Non-goals

| Not done here | Where |
|---|---|
| Canvas structure, palette, history | plan 305 |
| Live run highlighting | plan 307 |
| A JSON editor for arbitrary node output | never — the output pane is read-only except through a pin |
| Server-side expression preview | never (G9) |

## 3. Context and design decisions

### 3.1 The three panes, and why the data is free

`workflow_steps` already stores each step's `output`, and plan 304 §4.1 adds
`input`. So the panes are a **read of an existing row**, not a new capture
mechanism: `GET /api/workflows/:name/last-run` returns, per node id, the input
and output of that node's most recent step, already size-capped at 256 KB. An
author opening a node sees real data from the last time it ran, and nothing had
to be re-executed to show it.

Plan 304 §4.4's retention exemption exists to keep this pane alive: without it
an author returning after a fortnight would find three empty panes and no way
to tell whether the editor was broken.

### 3.2 The preview must be local

Plan 300 D4 makes the live preview a condition of expressions existing at all,
and a preview that round-trips to the core is not a live preview — it is a
laggy validation. So `@enkaku/expr` is imported **into the browser bundle**
(plan 302 step 302.1 already adds it to `transpilePackages`), the scope is
built from the last-run data the panel already has, and evaluation is
synchronous, bounded by the same fuel limit the server uses. Same parser, same
evaluator, same limits, two hosts, one package — which is also what makes the
preview trustworthy: it is not an approximation of what the server will do, it
is the same code.

### 3.3 The data picker is the point, not a convenience

An author cannot type `$nodes.read-notifications.result.items.0.title` from
memory, and if they must, they will paste it wrong, run a job on a real phone,
and discover the typo two minutes later. So the input pane is a tree of the
actual last-run value, every leaf is clickable, and a click inserts the
reference for **that** leaf at the caret of the focused parameter. That single
interaction is the difference between a data-flow editor and a JSON form.

For a `{ from, path }` binding (the pre-expression form, still legal) the same
click writes the binding instead of an expression — the picker knows which
form the field is in and does not convert it silently.

### 3.4 Rendering device data as device data

A device farm's node outputs are screenshots, UI trees, and coordinates. n8n
has no analogue and no reason to. The output pane therefore renders by declared
type from the member's `resultSchema` (plan 303 §4.3 ships it to the client):
a base64 or artefact-referenced image renders as an image; a UI tree renders as
a collapsible tree with each node's class, text and bounds; everything else is
the existing JSON viewer. A 2 MB screenshot rendered as a base64 string in a
JSON pane is not "showing the data", it is hiding it in plain sight.

## 4. Technical design

### 4.1 Layout

A right-hand drawer, full height, three columns at ≥ 1280 px and a tabbed
single column below that:

```
┌ INPUT ────────┬ PARAMETERS ───────────┬ OUTPUT ────────┐
│ tree of the   │ SchemaForm over the   │ tree/image/    │
│ last input    │ node's params schema  │ tree-view of   │
│ click a leaf  │ + per-field expression│ the last output│
│ → insert ref  │   toggle and preview  │ + Pin controls │
├───────────────┴───────────────────────┴────────────────┤
│ Run this node   ·   pinned <when>   ·   findings        │
└────────────────────────────────────────────────────────┘
```

### 4.2 Files

```
packages/studio/src/components/flow/
  NodePanel.tsx        the drawer and its three columns          (the artefact)
  DataTree.tsx         clickable value tree, used by both panes
  DataView.tsx         type-directed rendering (§3.4)
  ExprField.tsx        one parameter: literal ⇄ expression toggle, editor, preview
  ExprEditor.tsx       textarea + token underline + offset-accurate error
  usePreview.ts        debounced local parse+evaluate against the last-run scope
  PinControls.tsx      pin / unpin / edit, plus the age label
  StartPanel.tsx       the workflow's own `params[]` editor (G7)
```

`ParamsEditor.tsx`, `PredicateEditor.tsx`, `ValueExprEditor.tsx` and
`ScriptPicker.tsx` are reused from plan 305's surviving set; `SchemaForm`
(`packages/studio/src/components/schema-form/`) renders the params form
unchanged — this plan adds **no** second form renderer.

### 4.3 `ExprField`

Every parameter is one of five `ValueExpr` forms plus a literal. The field
shows the current form, a `fx` toggle that converts a literal into an
expression (`{ expr: '…' }`) and back when the expression is a bare literal,
and — while the form is `expr` — the editor and the preview. Converting an
expression back to a literal when it is *not* a bare literal is refused with a
one-line explanation instead of silently discarding the author's work.

### 4.4 `usePreview`

```ts
// debounce 120 ms, so G3's 150 ms budget is the debounce plus a parse of ≤ 2 KB
const { value, error } = usePreview(source, scope)
```

`scope` is built once per open node from the last-run data with
`toScopeValue` — the same function the server uses (plan 302 §4.4 rule 1), so
a value that is `undefined` in the preview is `undefined` on the server for the
same reason.

### 4.5 Route

`GET /api/workflows/:name/last-run` → `{ runId, at, nodes: Record<nodeId, { input, output, pinned, takenEdge, status }> }`,
permission `script.view`, 404 when the workflow has never run (the panes then
say so, and the picker is empty but the fields still work).

### 4.6 A newer node version exists

When a document pins `plugin/member@1.2.0` and the activated plugin is at
`1.3.0`, the panel shows a single line — "1.3.0 is activated; this node uses
1.2.0" — with an Update button that rewrites the ref as one `update-node` edit
(plan 305 §4.2), so it lands in history and can be undone. It never updates by
itself: plan 303 §4.4 pinned the version on purpose.

## 5. Implementation steps

**306.1 — The last-run route.** §4.5, in `packages/core/src/api/workflows.ts`,
with its test in `packages/core/src/api/workflows.test.ts`. *Result*: the only
backend work in this plan, and the only test.

**306.2 — `DataTree` and `DataView`.** The value tree with click-to-insert, and
type-directed rendering per §3.4. *Result*: G8's rendering paths exist before
anything depends on them.

**306.3 — The panel shell.** `NodePanel.tsx` with the three columns, fed by
306.1, replacing plan 305's interim side panel. *Result*: **P6**.

**306.4 — Click to insert.** Wire `DataTree`'s leaf click to the focused
field's caret, both for the expression form and the `{ from, path }` form
(§3.3). *Result*: **P7**.

**306.5 — Expression editor and preview.** `ExprField`, `ExprEditor`,
`usePreview`. Import `@enkaku/expr` in the browser. Underline by `offset`.
*Result*: **P8**, G4, G9.

**306.6 — Run this node.** A button posting to
`POST /api/workflows/:name/run-node` (plan 304 §4.3), with the device chosen by
the same DevicePicker the Run dialog uses (plan 216) — **not** a new picker.
Poll the run and fill the output pane when it finishes. *Result*: **P9**.

**306.7 — Pins.** `PinControls.tsx` over plan 304's four routes, plus the
canvas badge (plan 305 §4.4 already reserves the state). *Result*: **P10**.

**306.8 — The start node's panel.** `StartPanel.tsx` editing `doc.params[]`
with the existing `ParamsEditor`. *Result*: G7.

**306.9 — Version notice.** §4.6. *Result*: an author is told, never
surprised.

**306.10 — Status and report.**

## 6. Acceptance criteria

- G9, G10 mechanically; G1–G8 at the owner sitting.
- `rg -n "JSON.stringify" packages/studio/src/components/flow/DataView.tsx` →
  only in the fallback branch.
- `rg -n "new DevicePicker|function DevicePicker" packages/studio/src/components/flow` → empty (306.6 reuses plan 216's).

## 7. Test plan

Backend: `bun test packages/core/src/api/workflows.test.ts` for 306.1 only.
No Studio tests (plan 200 §8.3).

Owner sitting (one device, ~15 minutes):
1. Open a node that ran yesterday — both data panes are populated, nothing
   re-ran. (**P6**)
2. Click a nested leaf in the input pane with a text parameter focused — the
   reference appears at the caret and the preview resolves it. (**P7**)
3. Type `len($input.items) > 0`, watch the value appear as you type; then break
   it (`len($input.items` ) and confirm the underline lands on the right
   character. (**P8**, G4)
4. Press Run this node — a `node-test` run appears in Jobs and the output pane
   fills. (**P9**)
5. Pin that output; the canvas badges the node; re-run the workflow and confirm
   the node did not touch the device; unpin. (**P10**)
6. Open the start node and add a workflow parameter; it appears in the Run
   dialog. (G7)
7. Open a node whose result is a screenshot — it renders as an image; open one
   returning a UI tree — it renders as a tree. (G8)

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Autocomplete inside the expression editor? | Yes, but narrow: `$` roots and, one level at a time, the keys actually present in the last-run scope. No language server, no fuzzy ranking. `describe` (plan 302 §4.1) is where it reads types from. |
| Q2 | Should the input pane show the *predecessor's* output or this node's recorded input? | This node's recorded input. They are the same value in a single-cursor run, and the recorded one stays correct if plan 308 ever changes that. |
| Q3 | Editing a pin by hand? | Yes, a JSON textarea validated against the node's `resultSchema` when it has one. Refusing invalid JSON, accepting anything else. |
| Q4 | What if the last run predates the current document (the node no longer exists)? | The pane says "this node has not run in the most recent run" and the picker is empty. Never silently show another node's data. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| Plan 305's interim single-column node editor panel | `packages/studio/src/components/flow/FlowEditor.tsx` | `rg -n "interim panel" packages/studio/src/components/flow` → empty |

## 11. Handoff report

_To be written by the executing agent._
