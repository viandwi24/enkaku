# Plan 312 — Workflow data: the `set` node, the assignment editor, array functions, and the weighted switch

> Status: draft
> Ships: `packages/studio/src/components/flow/AssignmentEditor.tsx`
> Depends on: plans 301–307 (implemented); plan 300 D3, D4, D8; plan 309 (simulate — the cheapest way to test this)
> Spec references: §4.6

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A `set` node builds new data from earlier nodes without touching a device | 7th node kind; in-process; no child job | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `set node` group passes | [ ] |
| G2 | A field name uses dot notation to build nested output | `a.b` + `20` ⇒ `{ a: { b: 20 } }` | `bun test packages/protocol/src/workflow-set.test.ts` → `dot notation` passes | [ ] |
| G3 | Each assignment's value toggles between a literal and an expression, and so does its **name** | 2 toggles per row | owner smoke §7 step 2 | owner |
| G4 | `keepOnlySet` decides whether the input is carried through | 2 behaviours, tested | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `keepOnlySet` passes | [ ] |
| G5 | Dragging a value from the INPUT pane creates an assignment with the name AND value filled | 1 drag ⇒ 1 complete row | owner smoke §7 step 1 | owner |
| G6 | `pluck` and `filterWhere` cover per-element array work with no lambda and no new grammar | 2 functions, closed table | `bun test packages/expr/src/functions.test.ts` → `array paths` passes | [ ] |
| G7 | A `switch` can branch by weight instead of predicate | `mode: 'weighted'`; weights sum-normalised; draw from `$random` | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `weighted switch` passes | [ ] |
| G8 | A weighted draw is reproducible for a given run | same seed, same branch | same file → `weighted is deterministic` passes | [ ] |
| G11 | The JSON tab and the Fields tab round-trip losslessly, both directions | a document edited in either tab reads identically in the other | `bun test packages/studio/src/../json-view.test.ts` is forbidden (§8); proven instead by `bun test packages/protocol/src/workflow-set.test.ts` → `json round trip` over the pure codec | [ ] |
| G12 | A JSON document that cannot become assignments is refused with its reason, not stored | 3 cases: top-level array, duplicate key, unholdable value | same file → `json refusals` passes | [ ] |
| G9 | The expression engine gains no new grammar, no regex, no lambda | `parse.ts` unchanged except the function table's names | `git diff --stat packages/expr/src/parse.ts` → 0 changed lines | [ ] |
| G10 | `bun run typecheck` and `bun run build:studio` clean; no Studio test file added | 0 errors, 0 `*.test.tsx` | both exit 0 | [ ] |

## 1. Goals

The owner, 2026-09-05, describing what they want to be able to draw:

> node 1 → node 2 (ambil data dari node 1, terus bikin data baru untuk
> output) → node 3 (ambil data hasil dari output node 2)

Today node 2 can only be a script. There is no way to reshape data inside the
document — which means a workflow that needs `videoCount` has to run a script
to compute it, on a phone, to produce a number the author could have written.

This plan adds the node that closes that, the editor that makes it pleasant,
and the two expression functions the gap analysis found missing.

## 2. Non-goals

| Not done here | Where |
|---|---|
| — | (the JSON view is IN scope, §4.5) |
| Lambdas (`map(a, $item.id)`) | §9 Q2 — the escalation if `pluck` proves insufficient, not before |
| Regular expressions | never (plan 95 §3.8 R2, plan 300 D4) |
| Binary data flowing between nodes | §9 Q3 — artefacts already have a home |
| Item arrays / fan-out | plan 300 D3, plan 308 |

## 3. Context and design decisions

### 3.1 What the research says, and where we already agree

Checked 2026-09-05 against the current n8n documentation (§5):

- **n8n's Edit Fields (Set) node** has two modes, **Manual Mapping** and
  **JSON Output**. In manual mapping you *"configure the fields by dragging
  and dropping values from INPUT"*, and the documented default when you drag
  is that *"n8n sets the value's name as the field name"* and *"the field
  value contains an expression which accesses the value"*. Each field has a
  **Fixed | Expressions** toggle, *"for both the name and value of the
  field"*. Options include **Keep Only Set Fields** and **Support Dot
  Notation**, where name `number.one` with value `20` produces nested JSON.
- The widget is called **`assignmentCollection`**, described as *"the drag
  and drop component when you want users to pre-fill name and value
  parameters with a single drag interaction"*.
- **AWS Step Functions** shapes data with a declarative per-state pipeline
  (`InputPath → Parameters → ResultSelector → ResultPath → OutputPath`) and
  in 2026 added **variables** — assign in one state, read in any later one —
  explicitly to *"simplify state payload management"*. It has never allowed
  arbitrary code inside a state machine; for that you write a Lambda.

Two conclusions worth writing down. First, **Step Functions moved toward the
model this repo already has**: named outputs (`$nodes.<id>`) are the thing
they added variables to get. Plan 300 D3 is not a compromise, it is where a
mature system landed. Second, **n8n's Set node is mostly declarative too** —
the drag-and-drop path writes an expression for you, and the `Fixed` toggle
exists precisely so authors do not have to write one. The part that needs
JavaScript is the Code node, and this repo's answer to the Code node is a
script member: real TypeScript, versioned with its plugin, crash-contained in
a child process.

### 3.2 So the gap is one node and one widget

`ValueExpr`'s literal-vs-`{ expr }` distinction **is** n8n's Fixed vs
Expression toggle, and plan 306 shipped it as `ExprField`. `DataTree` already
click-inserts a reference. What is missing is the node those fields belong to,
and the drag interaction that fills a name and a value in one gesture.

### 3.3 `set` is a core node, and that settles plan 303 §9 Q2

Plan 303 §9 Q2 asked whether a pure data-shaping node — no device, no child
process — should exist, and deferred it until someone asked twice. The owner
has now asked once directly and once by describing the n8n flow they want.

It is **core**, not a plugin, on plan 300 D8's own logic: a plugin node runs
in a child process because it may touch a device, and `set` never does. Making
it a plugin would spawn a process to compute `len(x)`. It defines no new edge
(one `next`, like `delay`), so D8's control-flow prohibition is untouched.

### 3.4 Dot notation, and what it may not do

`a.b.c` builds nested objects. It may **not** index arrays (`a.0.b` is a
field literally named `0`), because writing into an array by index needs a
rule for what happens to the gaps, and no author has needed it. The checker
refuses a segment that is only digits, with that sentence.

### 3.5 Array work without lambdas

The one thing the function table cannot express is per-element work:
n8n writes `$json.items.map(i => i.id)`. A lambda would mean binding a
variable inside an expression, which is the first step of every language that
ends up with `eval`.

Two closed functions cover the cases that actually occur:

- `pluck(array, "dotted.path")` → the values at that path in each element.
  This is `map(i => i.path)` without the binding.
- `filterWhere(array, "dotted.path", op, value)` → the elements whose path
  satisfies `op` (the same `GATE_OPS` a gate already uses — no second operator
  vocabulary).

Both bounded by the existing `EXPR_LIMITS.maxArrayLength` and fuel. Neither
touches `parse.ts` (G9): they are entries in the function table, which is what
that table is for.

### 3.6 The weighted switch

Two workflows out of three the owner has described start with "pick a
behaviour at random". Written today that is a `switch` whose cases read
`$random < 0.33`, `$random < 0.66` — cumulative thresholds the author must
compute, order correctly, and keep consistent when a case is added. Every part
of that is a mistake waiting to be made.

So `switch` gains `mode: 'weighted'`: each case carries `weight: number`, the
executor normalises the weights and draws with `$random`. "30 / 50 / 20"
becomes what the author writes. The predicate mode is unchanged and remains
the default; this is a second mode on one node, not a second node.

Because `$random` is `deriveRandom(seed, seq)` from the run's stored seed
(plan 304 §3.4), the draw is **reproducible for a run and different between
runs** — which is exactly right for a farm: twenty devices each get their own
branch, and a replay of any one of them takes the branch it actually took
(G8).

## 4. Technical design

### 4.1 The node

```ts
// packages/protocol/src/workflow.ts — added to the discriminated union
z.object({
  ...nodeBase,
  kind: z.literal('set'),
  assignments: z
    .array(
      z.object({
        /** Dot notation builds nested output (§3.4). Literal or expression, like the value. */
        name: ValueExprSchema,
        value: ValueExprSchema,
      }).strict(),
    )
    .max(WORKFLOW_LIMITS.maxAssignments),
  /** Drop the input and emit only what this node sets (n8n's "Keep Only Set Fields"). */
  keepOnlySet: z.boolean().default(false),
  next: WorkflowNodeIdSchema.optional(),
}).strict(),
```

`WORKFLOW_LIMITS.maxAssignments = 40` — the same ceiling `maxParams` uses, for
the same reason: past that it is a data file, not a mapping.

`checkWorkflow` gains: a `set` node costs **zero** time in the budget walk
(it is in-process and bounded by fuel), and a name expression that resolves to
a non-string at publish time — when it is a literal — is an error naming the row.

### 4.2 The weighted switch

```ts
// the `switch` variant gains:
  mode: z.enum(['predicate', 'weighted']).default('predicate'),
  cases: z.array(
    z.object({
      when: PredicateSchema.optional(),   // required in 'predicate' mode
      weight: z.number().positive().optional(), // required in 'weighted' mode
      to: WorkflowNodeIdSchema.optional(),
      label: z.string().max(40).default(''),
    }).strict(),
  ).min(1).max(WORKFLOW_LIMITS.maxSwitchCases),
```

The schema's `superRefine` enforces one shape per mode rather than allowing
both fields at once — a case with a predicate AND a weight is an author who
believes one of them does something, and one of them does not.

### 4.3 The executor

```
case 'set':
  const base = node.keepOnlySet ? {} : { ...$input }
  for (const a of node.assignments):
      name  = resolve(a.name)   // must be a non-empty string
      value = resolve(a.value)
      setPath(base, name.split('.'), value)   // refuses a digits-only segment
  output = base
```

`setPath` is pure, bounded by `EXPR_LIMITS.maxDepth`, and lives beside the
executor with its own test file. It never mutates `$input`.

Weighted switch:

```
const total = sum(case.weight)
let draw = $random * total
for (const c of cases): draw -= c.weight; if (draw <= 0) return c.to
return node.default
```

### 4.4 The editor — `AssignmentEditor.tsx` (the artefact)

Mounted in `NodePanel`'s PARAMETERS column when the node is `kind: 'set'`.
One row per assignment:

```
[⠿]  [ name          ] [fx]   =   [ value                    ] [fx]   [🗑]
```

- Both `name` and `value` are `ExprField`s (plan 306 §4.3) — the `fx` toggle
  already exists and already refuses to convert a non-literal expression back
  to a literal.
- **Drag from `DataTree`**: the INPUT pane's leaves become drag sources
  (HTML5 drag with a JSON payload of `{ path, leafName }`). Dropping on the
  list appends a row with `name` = the leaf's own key as a **literal** and
  `value` = a reference expression to that leaf — n8n's documented default,
  and the reason one gesture is enough (G5).
- Dropping onto an existing row's value replaces just that value.
- Reordering by the drag handle; order matters, because a later assignment
  may overwrite an earlier one's path.
- The row shows a live preview of the resolved value, from `usePreview`
  (plan 306 §4.4) — the same local, network-free evaluator.

### 4.5 The JSON view — a projection, never a second source of truth

The `set` node's PARAMETERS column has two tabs, **Fields** and **JSON**, and
they edit **the same `assignments[]`**. There is one stored shape, one
executor path, one checker. The JSON editor renders the assignments as a JSON
document and parses edits back into assignments — the same discipline
`WorkflowCanvas` already applies to edges, which are drawn from the document
and never held as independent state.

```
{                                              report.count = { expr: 'len($nodes.n1.videos)' }
  "report": { "count": "=len($nodes.n1.videos)" },   ⇄     label        = 'nightly'
  "label": "nightly"
}
```

Three rules make the round trip unambiguous:

1. **A string value beginning with `=` is an expression**; everything after
   the `=` is parsed by `@enkaku/expr`. A literal string that really does
   begin with `=` is escaped `==`. This is n8n's own internal convention and
   the same idea as Step Functions' `"key.$"` suffix (§5 R5) — a marker, not
   a grammar. `parse.ts` is untouched (G9 still holds).
2. **Interpolation inside an expression string**: `"run-{{ $now }}"` compiles
   at publish time to `'"run-" + toText($now)'` and is stored as an ordinary
   expression. No new `ValueExpr` form, no executor change, no second
   evaluator. The splitter is ~40 lines with its own test file, and it is a
   splitter: the text between markers is literal, the text inside is handed to
   the existing parser.
3. **What cannot round-trip is refused in the editor, never stored raw.** A
   top-level array, a duplicate key, a value type no assignment can hold — the
   JSON tab shows the reason and does not commit. The moment the JSON tab can
   save something the Fields tab cannot read, there are two sources of truth,
   and that — not the cost of a template — is the real hazard this design
   exists to avoid.

Switching tabs is therefore always lossless in both directions, which is what
makes two authoring modes safe to offer at all.

### 4.6 The palette

`set` joins the core group with icon `list` and the description "Build new
data from earlier nodes — no device involved." The weighted switch is not a
separate palette entry: it is a mode toggle inside the switch node's panel.

## 5. Verified external references

Checked **2026-09-05**, tool output read.

| # | Fact | Source |
|---|---|---|
| R1 | n8n's Edit Fields (Set) node: modes **Manual Mapping** and **JSON Output**; fields configured *"by dragging and dropping values from INPUT"*; on drag *"n8n sets the value's name as the field name"* and the value becomes an expression; a **Fixed \| Expressions** toggle exists *"for both the name and value of the field"*; options **Keep Only Set Fields**, **Include in Output**, **Support Dot Notation** (`number.one` + `20` ⇒ nested JSON). | `https://github.com/n8n-io/n8n-docs/blob/main/docs/integrations/builtin/core-nodes/n8n-nodes-base.set.md` |
| R2 | n8n's widget for this is `type: 'assignmentCollection'` — *"the drag and drop component when you want users to pre-fill name and value parameters with a single drag interaction"*. The full widget vocabulary is String, Number, Collection, DateTime, Boolean, Color, Options, Multi-options, Filter, Assignment collection, Fixed collection, Resource locator, Resource mapper, JSON, HTML, Notice, Hints. | `https://docs.n8n.io/connect/create-nodes/build-your-node/reference/node-ui-elements` |
| R3 | n8n passes an **array of items** between nodes, each `{ json: {...}, binary: {...} }`; references are `$json`, `$('<node>').item.json`, `$input.first()/last()/all()`, and `$("<node>").all(branchIndex?, runIndex?)`. | `https://github.com/n8n-io/n8n-docs/blob/main/docs/build/work-with-data/understand-n8ns-data-structure.md`, `.../reference-data/reference-previous-nodes.md` |
| R4 | Mapping in the UI is *"by dragging and dropping data from the INPUT pane into node parameters"*, which *"generates the expression for you"*; n8n states mapping *"doesn't include changing (transforming) data, just referencing it"*. | `https://github.com/n8n-io/n8n-docs/blob/main/docs/build/work-with-data/reference-data/use-the-ui-mapper.md` |
| R5 | AWS Step Functions shapes data declaratively per state (`InputPath` → `Parameters` → `ResultSelector` → `ResultPath` → `OutputPath`) and added **variables** — assign in one state, reference in later ones — to *"simplify state payload management"*. Arbitrary code is a Lambda, never inline. | `https://docs.aws.amazon.com/step-functions/latest/dg/input-output-inputpath-params.html`, `https://aws.amazon.com/blogs/compute/simplifying-developer-experience-with-variables-and-jsonata-in-aws-step-functions/` |

`branchIndex`/`runIndex` in R3 is the item model's cost showing through its
own API, and is cited by plan 300 D3 as the reason this repo does not adopt it.

## 6. Implementation steps

**312.1 — `pluck` and `filterWhere`** in `packages/expr/src/functions.ts`,
with tests including the bounds. Nothing else in `@enkaku/expr` changes (G9).

**312.2 — The `set` node in the protocol**, plus `setPath` and its test.
*Result*: G1's schema half, G2.

**312.3 — The checker**: zero budget cost, the digits-only-segment refusal,
the literal-name type check.

**312.4 — The executor**: `set` per §4.3. *Result*: G1, G4.

**312.5 — The weighted switch**: schema mode, `superRefine`, executor draw.
*Result*: G7, G8.

**312.6 — `AssignmentEditor.tsx`** per §4.4, mounted in `NodePanel`.
*Result*: G3.

**312.7 — Drag sources in `DataTree`** and the drop targets. *Result*: G5.

**312.8 — The JSON view.** The codec (`assignments ⇄ JSON`) as a **pure
module in `@enkaku/protocol`** with its own test file, so the round trip is
proven without a Studio test (plan 200 §8.3); then the tab in `NodePanel`.
The interpolation splitter lands here too, compiling to concatenation at
publish. *Result*: G11, G12.

**312.9 — Palette entry** and `docs/design.md`'s Flow editor section gains the
assignment row's measurements.

**312.10 — Status and report.**

## 7. Test plan

| File | Covers |
|---|---|
| `packages/expr/src/functions.test.ts` | `pluck`, `filterWhere`, their bounds and type errors |
| `packages/protocol/src/workflow-set.test.ts` | dot notation, digits-only refusal, assignment ceiling, switch mode exclusivity |
| `packages/core/src/jobs/executors/workflow.test.ts` | `set` output; `keepOnlySet` both ways; order-dependent overwrite; weighted switch distribution and determinism |

Owner smoke, **no device needed** (this is what plan 309's simulate is for):
1. Add a `set` node after a script node. Drag a leaf from the INPUT pane into
   the assignment list — one row appears with the name **and** value filled.
2. Toggle that row's value to Fixed, type a literal, toggle back.
3. Name a field `report.count`, give it `len($nodes.n1.videos)`, simulate, and
   confirm the output is `{ report: { count: 3 } }`.
4. Turn on `keepOnlySet` and simulate again — the input is gone.
5. Switch a `switch` node to weighted, 30/50/20, simulate ten times, and
   confirm the branches vary.

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | ~~A JSON-template mode?~~ | **Decided: yes.** See §4.5. The first draft of this plan refused it and the refusal was wrong on its own technical claim — a marker convention needs no second grammar, and interpolation is a splitter, not a language. Overturned by the CEO, 2026-09-05, on the ground the plan had not weighed: a client who says "my API needs exactly this shape" pastes JSON, and telling them to type fourteen fields one at a time is a lost client, not a design decision. |
| Q2 | Lambdas (`map(arr, $item.id)`)? | Not yet. `pluck`/`filterWhere` cover the observed cases without introducing binding. If an author needs a second lambda-shaped function within three months, that is the evidence, and the answer is a bounded `$item` binding — never a general one. |
| Q3 | Binary data (screenshots) flowing through `set`? | No. Artefacts have their own store and a 256 KB node-output cap; passing images through the data path would blow both. |
| Q4 | Should `set` be able to DELETE a field from the input? | Yes, and it is the same feature: an assignment whose value is the literal `null` with a `remove` flag, or `keepOnlySet` plus re-listing what to keep. Decide in 312.2 and record which; do not ship both. |
| Q5 | Does the weighted switch need per-device weights? | No. Weights are part of the recipe; which device runs it is the target's business (plan 308). |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| `node.icon` on a plugin member | `packages/protocol/src/workflow-node-type.ts` | plan 310 §3.3 moved it to the member; `rg -n "node.*icon" packages/sdk/src/plugin.ts` → the member-level field only |

## 11. Handoff report

_To be written by the executing agent._
