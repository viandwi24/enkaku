# Plan 300 — Flow : The program — the parity parameter, the eight decisions, waves, verified references

> Status: draft
> Ships: none — a program document creates no artefact of its own.
> Depends on: plan 200 (closed, §8.16), plans 210, 211, 217 (implemented on `mvp`)
> Spec references: §4.5, §4.6, §4.7, §10, §12 — §4.6 is amended by this programme and must be rewritten by plan 307, not before.

## 1. What this series is

The MVP programme (plan 200) closed on 2026-09-04 with a workflow that **runs**
and an editor that **does not sell it**. Plan 217 said so in its own non-goal
table, [217:53](217-mvp-scripts-workflows-schedules.md):

> | Redesigning the workflow editor's canvas/list UI or its `lucide-react` icons and old token classes | undesigned by the handoff (MVP 15 §2); a future post-MVP plan |

This is that plan, expanded into a programme because it is not one plan's worth
of work. The owner's brief, 2026-09-04, in the owner's words: the scripts and
workflows concept is *"masih jauh dari kata usable"*; the target is a flow
editor whose editing model is **at least n8n's**, with **modular nodes supplied
by plugins**, **data flowing from node to node**, and **expressions** that can
read and compute over that data.

Three of those four are a matter of finishing something the repo already
started. The fourth — expressions — **reverses a written decision** (plan 99
§3.7's F27, restated in [workflow.ts:100-116](../../packages/protocol/src/workflow.ts)),
and §3 D4 below gives the reason, the evidence, and the boundary that makes the
reversal safe rather than fashionable.

### 1.1 What already exists (verified 2026-09-04, by reading these files)

Nothing in this programme starts from zero. The current state, cited:

| Fact | Where | Line |
|---|---|---|
| A workflow document is `{ schema: 1, name, params[], nodes[], maxSteps, onFail? }` | `packages/protocol/src/workflow.ts` | `269` |
| Two node kinds only: `script` and `gate` | same | `205` |
| A gate outcome may `goto` a node **backwards** — loops are already legal | same | `~196` (`GateOutcomeSchema`) |
| Node parameters bind to earlier node output: `{ from, path, optional, default }` | same | `103` |
| Limits: 50 nodes, 500 step executions, 256 KB per node output | same | `15` |
| Per-step output is already persisted | `packages/core/src/db/schema.ts` (`workflow_steps`) | `547` |
| A job snapshots the document at enqueue | same (`jobs.workflow_doc`) | `415` |
| Every step of a run inherits ONE device | `packages/core/src/jobs/executors/workflow.ts` | `215`, `470` |
| A React Flow canvas exists, with edge dragging | `packages/studio/src/components/workflow/WorkflowCanvas.tsx` | whole file |
| …but nodes are not draggable and positions are never stored | same | `163` (`draggable: false`), `232` (`nodesDraggable={false}`) |
| …and the LIST is the editor of record; canvas is a view toggle | `packages/studio/src/components/workflow/WorkflowBuilder.tsx` | `79` |
| Layout is recomputed on open, by hand, no dagre | `packages/studio/src/components/workflow/compute-layout.ts` | `1-40` |
| A plugin already contributes typed scripts, React screens, and a service | `packages/sdk/src/plugin.ts` | `51`, `58`, `79`, `99` |
| A plugin's React screen is a real ES module in Studio's own tree | `packages/protocol/src/plugin-surface.ts` | `495` (`react:`), `85` (`PLUGIN_UI_API_VERSION`) |

Read that table before writing any plan in this series. The most common way
this programme can fail is by rebuilding something in the left column.

### 1.2 What this programme is not

- Not a rewrite of the executor's job model. Runs, jobs, retries, `finish()`
  and crash containment stay exactly as plan 211 left them.
- Not an n8n clone. §2.2 states, in one table, which n8n behaviours are
  adopted and which are refused **with a reason**.
- Not a licence to widen the device model. Spec §4.6's "single device,
  sequential steps only" holds for the whole of this programme; plan 308 is
  where that is argued, and it starts `draft` on purpose.

## 2. The parity parameter

"At least as good as n8n" is the owner's goal and it is not, as written, a
parameter — plan 200 §3.0's rule is that a parameter is a number, a string, a
file path, or a schema, never an adjective. So the goal is restated as twelve
interactions. Each is verifiable by a person doing it once, in one sitting,
with a stopwatch where a number is given. **The programme is done when P1–P12
pass and not before.**

| # | Interaction | Parameter |
|---|---|---|
| P1 | Drag a node; it stays where it is dropped, across reload and across a different browser | position round-trips through `PUT /api/workflows/:name` |
| P2 | Add a node in three ways: `+` on an edge (inserts between), drag from an output handle onto empty canvas (opens the palette), and the palette's own search | 3 paths, each ≤ 2 clicks from intent to a placed node |
| P3 | Search the palette by node title, plugin id, and category | a query of ≤ 3 characters ranks the intended node in the first 5 results |
| P4 | Delete, duplicate, copy, paste, box-select, multi-select-drag | 6 gestures, keyboard and mouse |
| P5 | Undo and redo **every** structural edit, at least 50 deep | `cmd+z` / `cmd+shift+z`; 50 steps of history |
| P6 | Open a node: parameters in the middle, **input data left, output data right**, both from the last real run | 3 panes; the data panes are populated without re-running |
| P7 | Click a field in the input pane; a reference to it is inserted at the cursor in the focused parameter | 1 click, no typing |
| P8 | An expression shows its resolved value, against the last run's data, while it is being typed | ≤ 150 ms from keystroke to preview, no network call |
| P9 | Run one node with the last input, without running the workflow | 1 button in the node panel; produces a run row of its own |
| P10 | Pin a node's output; downstream nodes use the pin instead of touching the device | pinned nodes are visibly marked on the canvas; production runs ignore pins |
| P11 | Watch a run on the canvas: nodes light as they execute, the taken edge is highlighted, a failed node is red, and any past run replays the same way | live and replay use the same renderer |
| P12 | Auto-arrange a hand-made mess back into a readable layout, and undo it | 1 button; `computeLayout`'s successor; undoable as one history entry |

Two of these are not in n8n and are here because a device farm needs them more
than a SaaS connector does: **P10** matters far more here (a phone is slow and
non-deterministic; iterating on step 6 of 8 without driving steps 1–5 again is
the difference between a 5-second loop and a 2-minute one), and the
screenshot/UI-tree rendering inside P6's data panes (plan 306 §4.6) has no n8n
analogue at all.

### 2.1 Explicitly out of the parity claim

Naming these keeps a later reviewer from calling the programme incomplete for
not having them: sticky notes (cheap; plan 305 §9 Q2 may add them), sub-workflows,
a node marketplace/registry UI beyond the existing Plugins page, workflow-level
versioning and diffing, and multi-user concurrent editing.

### 2.2 n8n behaviours: adopted, refused, replaced

| n8n behaviour | Here | Why |
|---|---|---|
| Canvas is the document (positions stored in the workflow JSON) | **adopted** (D2) | The single biggest reason the current editor reads as a viewer. |
| Node palette, drag-from-handle, insert-on-edge | **adopted** (P2) | The core authoring loop; everything else is decoration. |
| Input/output data panes in the node view | **adopted** (P6) | The one feature that makes a data-flow editor legible. |
| Expressions in any parameter | **adopted, re-engineered** (D4) | Same ergonomics, different engine — see D4's CVE evidence. |
| Partial execution / execute one node | **adopted** (P9) | Worth more here than in n8n; devices are slow. |
| Pinned data | **adopted, promoted** (P10) | Same reason. |
| **Items** — every node consumes and emits an array, connections carry the array | **refused** (D3) | Its cost is `pairedItem`, item linking, "always output data", run index, and "why did my node run 47 times". It exists because n8n processes rows. This drives ONE phone. |
| Parallel branches and a Merge node | **deferred** (D5, plan 308) | With one cursor, two edges into one node already merge. Merge only becomes meaningful with fan-out, and fan-out here means fan-out ACROSS DEVICES, which spec §4.6 forbids until amended. |
| Third-party nodes may define control flow | **refused** (D8) | `checkWorkflow` must be able to reason about reachability and budget; it cannot if edge semantics are open. n8n agrees in practice: IF/Switch/Merge/Loop are core nodes. |
| Expression engine that compiles to JavaScript | **refused** (D4) | Three RCEs in twelve months across the two mainstream implementations. See R3, R4. |

## 3. The eight decisions

These are the decisions that change a stored document or the shape of a plugin
and are therefore expensive to revisit. Each is **decided** here so that no plan
in this series has to guess; each names what would falsify it.

### D1 — Edges are explicit. Array order stops being control flow. **Decided: yes.**

Today an absent `next` means "the next element of `nodes[]`"
([workflow.ts:219](../../packages/protocol/src/workflow.ts)). That is a fine
list semantic and an impossible canvas semantic: deleting a node silently
rewires two others, and there is no way to express "these two nodes are
unconnected" — which every real canvas needs while a user is mid-edit.

In doc v2, `next` is required on every node that has a successor, and absent
means **terminal**. `nodes[]` remains an array (stable ids, deterministic
iteration, unchanged storage) but carries no control meaning. Migration is
mechanical: materialise the implicit fallthrough at read time, once, in the
v1→v2 upgrade (plan 301 §4.5).

*Falsified by*: a v1 document in the wild whose implicit fallthrough cannot be
materialised without changing its behaviour. Plan 301 step 301.7 checks every
document on the owner's farm before the migration is allowed to be one-way.

### D2 — Positions are stored in the document. **Decided: yes.**

Plan 102 §3.2 decided the opposite ("layout computed on open, never stored")
and was right **for a read-only projection**. It is wrong for an editor: P1
is unimplementable without it, and an auto-layout that fires on every open
destroys hand-made arrangement, which is the main thing an author does after
the third node.

`ui: { x: number, y: number }` on every node, required in v2, integers,
bounded. `computeLayout` is not deleted — it becomes the **Auto-arrange**
button (P12) and the position source for a v1 document being upgraded and for
a node created by an API caller that supplies none.

*Falsified by*: nothing plausible. The cost is 2 numbers × ≤ 50 nodes in a
128 KB budget.

### D3 — Data flow is **named outputs**, not item arrays. **Decided: named outputs.**

Every node's result is recorded under its own id for the whole run; a later
node reads `$nodes.<id>.<path>`, exactly as `{ from, path }` does today, and
exactly as GitHub Actions' `steps.<id>.outputs` does. The *visible* data flow
of P6/P7 (see what came in, click a field, get a reference) is delivered
**entirely** by the UI panes plus the run record that already exists in
`workflow_steps` — it needs no change to execution semantics at all.

This is the decision most likely to be second-guessed, so the reasoning is
recorded in full: n8n's item model buys per-row fan-out over a list, and pays
for it with the four confusions named in §2.2. A workflow here drives one
phone through a sequence of gestures. There is no row set. Adopting the item
model would import the entire cost and none of the benefit.

*Falsified by*: a real workflow the owner wants to write that needs "for each
of N results, do X" where N is data-dependent. That is a **loop over an array
in the document**, and it is plan 303 §9 Q1's open question — a `forEach` core
node with a cursor, not an item model.

### D4 — Expressions exist, and the engine is a closed AST interpreter written here. **Decided: yes, with the boundary below.**

This reverses F27. The reversal is narrow and the reason is not "n8n has one".

The refusal conflated two things. *Never `eval` author-supplied text in the
core process* is correct and stays correct. *Computation itself is dangerous*
is not: `a.length > 3` is not a hazard, `new Function(s)` is. What n8n and
JSONata both do is the second thing dressed as the first — and both were
broken in 2026, in public, by the same class of bug (R3, R4): an evaluator
that runs on live JavaScript objects, reaches `Function` through a prototype
chain, and executes system commands. n8n's own mitigation is a **deny-list**
of AST shapes (`ThisSanitizer`, `PrototypeSanitizer`, a regex for
`.constructor`), and CVE-2026-1470 walked through it with a `with` statement.

So: an expression here is **source text, parsed by a pure bounded parser into
a closed AST at publish time (to validate it) and again at run time (to
evaluate it)**, and evaluated by walking that AST. The stored form is the
source, so there is one source of truth and nothing to drift — plan 302 §3.2
argues that in full. Never `eval`, never `new Function`, never a library that
emits JavaScript. Concretely, the boundary — every line
of it enforced by `@enkaku/expr`, plan 302:

1. **Closed grammar.** Literals, paths, `+ - * / %`, comparison, `&& || !`,
   ternary, and calls to a **closed function table**. No user-defined
   functions, no assignment, no loops, no property access by computed key.
2. **No regular expressions**, ever. Plan 95 §3.8 R2's refusal was about
   ReDoS and is untouched by this decision.
3. **Prototype-free data.** The evaluation scope is built with
   `Object.create(null)` and every lookup is an own-property check. There is
   no `__proto__`, no `constructor`, no `toString` to reach, because they are
   not there.
4. **Fuel.** A step budget and a depth budget, both hard, both tested by a
   case that exhausts them.
5. **Pure.** No I/O, no device call, no clock except an explicit `$now`
   injected by the caller, no randomness except an explicit seeded `$random`
   the executor supplies per step. Two evaluations of the same AST over the
   same scope return the same value.
6. **Value transformation only.** Anything that needs to *do* something is a
   script node. Plan 99 §3.7's "the escape hatch is a script" doctrine is
   kept in full; only the line moved, from "no computation" to "pure
   computation, in a language that cannot express a side effect".

And one product rule that is part of the decision, not a nicety: **an
expression without a live preview is worse than no expression** (P8). An
author who cannot see the resolved value guesses, then burns a real device run
to find a typo. If plan 306 cannot deliver P8, plan 302 does not ship either.

*Falsified by*: the interpreter exceeding ~600 lines, or needing a second
escape hatch within three months. Either means the grammar was drawn too wide,
and the correct response is to narrow the grammar, not to reach for a library.

*Not chosen, and why* — CEL (`cel-js@0.8.2`, R5) is the right *shape*
(non-Turing-complete by design) but the JS implementation is pre-1.0, last
published 2025-07-11, and carries `chevrotain` + `ramda`; `jexl@2.3.0` was last
published in 2020; `jsonata@2.2.2` is mature and zero-dependency and was still
the subject of two critical RCEs in August 2026 (R4). The repo's own precedent
for exactly this trade is `compute-layout.ts`, which refused dagre with a
written argument. A ~400-line interpreter over a closed grammar is smaller than
any of them, exhaustively testable, and cannot grow a `Function` reference it
does not have.

### D5 — One cursor. No parallel branches, no Merge node, in this programme. **Decided: deferred to plan 308.**

Spec §4.6: *"Single device, sequential steps only for the MVP"*, with the CEO
decision recorded in `docs/mvp/README.md` Open decisions 4. Changing it is a
spec amendment, not an editor feature.

Two consequences that must not be forgotten by a plan author who reads only
this line: (a) **there is no Merge node in this programme** — two edges into
one node already merge, because there is one cursor; adding a Merge node would
add a concept without adding a capability; (b) the honest form of parallelism
here is **across devices**, not across branches — two branches on one phone
fight over one screen. Plan 308 argues that and starts `draft`.

### D6 — A plugin node is a descriptor on the plugin's existing script member, not a second catalog. **Decided: yes.**

A node and a `PluginMemberScript` already share params schema, result schema,
child-process execution, and versioning through `ScriptRefSchema`. What a node
adds is **control shape** (how many outputs, which fires) and **presentation**
(icon, category, custom editor). So plan 303 adds an optional `node?: {...}`
to the member, not a new plugin surface: one catalog, one resolution path, one
version discipline.

*Falsified by*: a wanted node that is not a script — a pure data-shaping node
with no device call and no child process. Plan 303 §9 Q2 holds that question;
the current answer is that such a node is a **core** node (D8), not a plugin
one.

### D7 — A plugin node executes exactly where a script does: in the child process. **Decided: yes.**

No new execution path. `defineService`'s in-process escape hatch
([plugin.ts:99](../../packages/sdk/src/plugin.ts)) is documented as *not a
sandbox* and stays reserved for what it was built for. A node contributed by a
third party runs behind the same crash containment as every script, and
"crash containment, never a sandbox" (CLAUDE.md) is repeated in plan 303's own
§3 so nobody mistakes node modularity for isolation.

### D8 — Control flow is core-owned, and the list is closed. **Decided: yes.**

Core owns, and a plugin may never define: `start`, `if`, `switch`, `forEach`
(if plan 303 §9 Q1 resolves for it), `delay`, `finish`, and the failure edge.
`checkWorkflow` ([workflow-check.ts:7-14](../../packages/protocol/src/workflow-check.ts))
statically proves reachability, dangling `goto`s, binding legality and the
worst-case time budget; none of that survives an open edge vocabulary. A
plugin node has exactly one success output and one failure output, and that is
the whole of its control surface.

### 3.1 Decisions the owner must ratify before wave 1 starts

D1, D2, D3, D6, D7, D8 are engineering calls and are **made**. Two are not:

- **D4** reverses a written decision and adds a package. It needs the owner's
  yes on the record before plan 302 is executed.
- **D5** touches the spec. It needs the owner's yes on *deferring*, which is
  the cheap direction; plan 308 exists so the expensive direction stays
  visible.

## 4. Waves and plans

| Plan | Wave | Title | Depends on |
|---|---|---|---|
| 301 | 0 | Graph model v2: explicit edges, stored positions, doc migration, checker | — |
| 302 | 0 | `@enkaku/expr`: the closed expression engine | — (D4 ratified) |
| 303 | 1 | The node catalog: core control nodes, the plugin `node` descriptor, the registry | 301 |
| 304 | 1 | Executor v2: graph walk, per-node IO records, run one node, pinned data | 301, 302, 303 |
| 305 | 2 | The canvas becomes the editor of record | 301, 303 |
| 306 | 2 | The node panel: parameters, data in/out, expression editor with live preview | 302, 303, 304, 305 |
| 307 | 3 | The run view: live and replay on the canvas; spec §4.6 rewritten | 304, 305, 306 |
| 308 | 4 | Per-node device targets and fan-out across devices (starts `draft`) | 307; **owner decision** |

Wave 0's two plans are independent of each other and may be executed in
parallel by two executors in two worktrees (plan 200 §8.1). Wave 1's two are
not: 304 consumes 303's registry.

### 4.1 Rules inherited from plan 200, unchanged

Plan 200 §2 (scope, reading before writing, testing, vocabulary, *do the work
yourself*, Studio code-block rules, commits) and §3 (the §0/§10/§11 format)
apply to 301–308 verbatim. In particular: **do not delegate** (§2.5), **never
run the full test suite** (CLAUDE.md), and `bun run build:studio` is part of
verification for every Studio plan, not `typecheck` alone (§2.6).

### 4.2 Vocabulary (extends plan 200 §2.4)

| Use | Never |
|---|---|
| node (of a workflow **document**) | step (for a document node — a step is a node EXECUTION in a run) |
| edge | connection, link, wire |
| node type (`plugin/script` + descriptor) | node kind (reserved for `script` \| `gate` \| the core control kinds) |
| expression, AST | formula, template, interpolation |
| pinned output | mock, stub, fixture (in UI copy) |
| named outputs | items, item list, item linking |
| Auto-arrange | auto-layout (in UI copy; `computeLayout` stays as the function name) |

Plan 200 §2.4's rows still bind: a workflow run's unit is a **step**, and
"node" for a step remains forbidden — which is exactly why the first row above
exists, since this programme makes the document's own word "node" load-bearing.

## 5. Verified external references

Checked **2026-09-04** by the author of this plan, with the tool output read,
not predicted. A plan cites these by row; a new fact is verified again and
added here with its date.

| # | Fact | Source | Caveat |
|---|---|---|---|
| R1 | `@xyflow/react` latest is **12.11.6**, published 2026-09-01, MIT, deps `zustand`, `classcat`, `@xyflow/system`. The repo pins `^12.11.3` (`packages/studio/package.json:22`), so it is already on the current major and minor line. | `https://registry.npmjs.org/@xyflow/react` | v12 ships pan/zoom, multi-select, box-select and keyboard shortcuts; it does **not** ship undo/redo, copy/paste or a node palette. P4/P5 are ours to build. |
| R2 | An n8n workflow JSON is two top-level keys — `nodes[]` (each with type, parameters, **position**) and `connections` (keyed by source node NAME, arrays of `{node, type, index}`). | `https://docs.n8n.io/workflows/components/connections/` | Their edges are keyed by node *name*, which is why renaming a node in n8n rewrites connections. D1 keys edges by **id**; ids are immutable, titles are free text. Do not copy the name-keyed shape. |
| R3 | n8n evaluates `{{ }}` by handing the contents to JavaScript's `Function` constructor, guarded by the **Tournament** library's AST hooks (`ThisSanitizer`, `PrototypeSanitizer`, `DollarSignValidator`), a regex blocking `.constructor`, and a globals-overwriting context. **CVE-2026-1470** escaped it with a `with` statement plus a local `constructor` binding, reaching `Function.prototype.constructor` and `child_process.execSync`. **CVE-2026-0863** escaped the Python Code Node through `AttributeError.obj` on Python 3.10+. JFrog's stated root cause: over-reliance on static AST validation instead of real isolation. | `https://research.jfrog.com/post/achieving-remote-code-execution-on-n8n-via-sandbox-escape/` | `@n8n/tournament@1.10.1` is `SEE LICENSE IN LICENSE.md` (n8n's Sustainable Use Licence) and depends on `recast`/`esprima-next` — it is neither reusable nor desirable here. This row is D4's primary evidence. |
| R4 | **JSONata**: CVE-2026-77414 and CVE-2026-77415 (published 2026-08-21, critical) are sandbox escapes to RCE — a shadowed environment-lookup check lets an expression walk the prototype chain to the global `Function`; internal AST structures can be hijacked past the clone helpers. Affected `<1.8.8` and `>=2.0.0 <2.2.1`; `jsonata@2.2.2` (2026-07-16, MIT, zero deps) is the current release. Also CVE-2024-27307 (prototype pollution). | `https://cvereports.com/reports/CVE-2026-77414`, `https://cvereports.com/reports/CVE-2026-77415`, `https://security.snyk.io/vuln/SNYK-JS-JSONATA-6371513` | The vendor mitigation advice is literally "avoid evaluating untrusted JSONata expressions". A browser-authored workflow parameter **is** untrusted input by this repo's own rule (CLAUDE.md: validate external input, never `as`-cast). D4's second piece of evidence. |
| R5 | CEL is explicitly non-Turing-complete and designed to be safe to evaluate; `cel-js@0.8.2` (2025-07-11, MIT) is the JS implementation, built on `chevrotain`, deps `chevrotain` + `ramda`. `jexl@2.3.0` last published 2020-09-15. | `https://cel.dev/overview/cel-overview`, `https://registry.npmjs.org/cel-js`, `https://registry.npmjs.org/jexl` | CEL is the right *design*; the JS implementation is pre-1.0 and 14 months stale. Cited by D4 as the shape to imitate, not the dependency to add. |
| R6 | n8n **partial execution**: selecting a node and choosing "Execute step" runs that node *and the preceding nodes needed to fill its input*. **Pin data**: a pinned node is not executed; its saved output is substituted and downstream nodes receive it. Production executions ignore pins. Only nodes with a single main output can be pinned. | `https://docs.n8n.io/workflows/executions/manual-partial-and-production-executions/`, `https://docs.n8n.io/data/data-pinning/` | Adopt the semantics, including "production ignores pins" — plan 304 §4.8 makes that a hard rule, since a scheduled farm job silently using pinned data would be a fabricated result. |
| R7 | n8n node descriptors: `INodeTypeDescription` is pure serialisable data shipped to the frontend to render the UI; `properties[]` carries `displayName`, `type`, `default`, `options`, `placeholder`, and `displayOptions` for conditional visibility. Versioning is either a `version: [3, 3.1]` array or a `VersionedNodeType` with a `defaultVersion`. | `https://docs.n8n.io/integrations/creating-nodes/build/reference/base-files/declarative-style-parameters`, `https://docs.n8n.io/integrations/creating-nodes/build/reference/node-versioning/` | The "descriptor is data, shipped to the client, renders the form" shape is exactly what this repo already has in Zod params schema + `SchemaForm`. Plan 303 reuses those and does **not** invent a `properties[]` vocabulary. `displayOptions` (conditional fields) has no equivalent here and is plan 303 §9 Q3. |

## 6. Risks, named now

| Risk | Why it is real here | Mitigation, owned by |
|---|---|---|
| **A plugin node never reaches the farm.** Bundled packs are seeded once, keyed `name@version`, recorded in `<dataDir>/seeded-packs.json`; an unchanged version is skipped on every later boot (CLAUDE.md). | A node catalog changes far more often than a script did. Plan 124 already shipped this exact bug twice. | Plan 303 §5 makes the three-site version bump a step with a grep, and §7 a smoke that checks the node appears in a fresh farm's palette. |
| **The canvas ships and the data panes do not.** | P1–P5 are visible and fun; P6–P8 are the ones that make it usable. A wave that stops after 305 leaves a prettier viewer. | Wave 2 closes only when 305 **and** 306 pass; the wave gate is a single row, not two. |
| **Doc v2 migration is one-way.** | v1 documents exist on the owner's farm. | Plan 301 §5 step 301.7: dump every stored document, upgrade in memory, run both executors over a fixture set, diff the step sequence; migrate only when they agree. |
| **Expression scope creep.** | Every expression language grows. | D4's falsification test (600 lines / second escape hatch) is a §0 row in plan 302, not a sentiment. |
| **Two editors during waves 1–2.** | The list editor still works and the canvas is being rebuilt beside it. | The list editor is **deleted** by plan 305 §10, in the same plan that makes the canvas authoritative — never a wave apart (00-overview §4.3: no weaker parallel path kept "for one release"). |
| **`build:studio` breaks late.** | Static export catches what `typecheck` does not (plan 200 §2.6). | Every Studio plan's §0 carries a `bun run build:studio` row. |

## 7. Branch and gates

- Programme branch: `flow`, cut from `mvp`. Plan documents themselves land on
  `mvp` directly (they are documentation, they break nothing).
- Wave gate: every plan in the wave `implemented` or `implemented (software)`
  with only `owner` rows open, `bun run typecheck` clean, `bun run build:studio`
  clean, `bash scripts/check-plan-status.sh` passing, and the union of the
  wave's §10 greps run once from the repo root with no hit.
- **P1–P12 are checked at the wave-3 gate, by the owner, in one sitting, with
  the twelve rows read out.** A programme that claims parity without that
  sitting has claimed it, not shown it.

## 8. What is tested, and what is not

Plan 200 §8.3 stands: **Studio and `@enkaku/ui` have zero tests.** This
programme does not change that, and no plan in it may add a `*.test.tsx`, a
renderer, or a preload.

Backend tests are required, and scoped, for exactly these:

| Area | Plan | File |
|---|---|---|
| Doc v2 schema, edge legality, v1→v2 upgrade | 301 | `packages/protocol/src/workflow.test.ts`, `packages/core/src/workflows/upgrade.test.ts` |
| `checkWorkflow` over an explicit-edge graph | 301 | `packages/protocol/src/workflow-check.test.ts` |
| The expression parser, the evaluator, the fuel limits, and the escape attempts | 302 | `packages/expr/src/*.test.ts` — including a case per R3/R4 escape shape |
| Node registry resolution and version pinning | 303 | `packages/core/src/workflows/registry.test.ts` |
| Executor v2 step sequence, single-node run, pin substitution, production ignoring pins | 304 | `packages/core/src/jobs/executors/workflow.test.ts` |

The canvas, the node panel and the run view are verified by `typecheck`,
`build:studio`, and the P1–P12 sitting. That is the deal plan 200 §8.3 made and
this programme keeps it.

## 9. Open questions

| # | Question | Held by | Current answer if unresolved |
|---|---|---|---|
| Q1 | Does D4 get the owner's yes? | owner | Plan 302 does not start; 306 ships the data picker (P7) without the expression editor (P8), and parity is claimed at 11/12. |
| Q2 | Does a `forEach` node over an array belong in the core catalog? | plan 303 §9 Q1 | No — a script returns the array and a gate plus `goto` walks it, as today. Revisit only with a real workflow that needs it. |
| Q3 | Conditional parameter visibility (n8n's `displayOptions`, R7) | plan 303 §9 Q3 | Not built. `SchemaForm` renders every declared field. |
| Q4 | Does the palette need categories beyond `plugin id`? | plan 305 | No. Group by plugin, with core nodes first. |
| Q5 | Retention of per-node run data (P6 needs the last run to still exist) | plan 304, against spec §16 | The last run per workflow is retained regardless of the age rule; older runs fall under §16 unchanged. |
