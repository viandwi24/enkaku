# Plan 302 — Flow : `@enkaku/expr` — a closed expression engine that cannot reach `Function`

> Status: implemented
> Ships: packages/expr/src/index.ts
> Depends on: plan 300 D4 (**needs the owner's ratification before execution** — 300 §3.1)
> Spec references: §4.6; this plan adds a package to §3 (repository layout), rewritten by plan 307.

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | `parse` accepts the whole grammar of §4.2 and refuses everything else | every production has a passing case and a refusing case | `bun test packages/expr/src/parse.test.ts` → all pass | [x] |
| G2 | The evaluator never touches a prototype chain | scope objects are `Object.create(null)`; every lookup is an own-property check | `bun test packages/expr/src/eval.test.ts` → `prototype` group passes | [x] |
| G3 | Every published escape shape from plan 300 R3/R4 fails to parse | 6 cases, all `E_EXPR_PARSE` | `bun test packages/expr/src/security.test.ts` → `known escapes` passes | [x] |
| G4 | Fuel and depth limits are hard | an expression that would exceed either throws `E_EXPR_LIMIT` and never hangs | `bun test packages/expr/src/limits.test.ts`, wall time under 1 s | [x] (no separate `limits.test.ts` file exists — see §11 discrepancy; coverage is `parse.test.ts`'s `limits` group, `eval.test.ts`'s `fuel` group, and `security.test.ts`'s wall-time-bounded fuel-exhaustion case) |
| G5 | The engine is pure: same AST, same scope, same value, twice | 1000 randomised round-trips | `bun test packages/expr/src/eval.test.ts` → `determinism` passes | [x] |
| G6 | The package has **zero runtime dependencies** | `dependencies` is `{}` or absent | `cat packages/expr/package.json` → no `dependencies` key with entries | [x] |
| G7 | The interpreter is under 600 lines (plan 300 D4's falsification test) | `parse.ts` + `eval.ts` + `ast.ts` ≤ 600 lines | `wc -l packages/expr/src/parse.ts packages/expr/src/eval.ts packages/expr/src/ast.ts` → total ≤ 600 | [x] (518) |
| G8 | A workflow parameter may be an expression, and the old four `ValueExpr` forms still work unchanged | 5 forms parse; the 4 old ones have no behaviour change | `bun test packages/protocol/src/workflow.test.ts` → `ValueExpr five forms` passes | [x] |
| G9 | `checkWorkflow` reports an unparsable or out-of-scope expression at publish, not at run | 2 codes | `bun test packages/protocol/src/workflow-check.test.ts` → `expression findings` passes | [x] |
| G10 | `bun run typecheck` clean | 0 errors | `bun run typecheck` exits 0 | [x] |

## 1. Goals

- An author can write `$nodes.read.result.count > 3 && $params.mode == "fast"`
  in any workflow parameter or gate operand.
- The engine cannot express a side effect, cannot reach a JavaScript
  prototype, cannot loop unboundedly, and cannot be handed to `eval` or
  `new Function` because no code path in it constructs a function from text.
- The four existing `ValueExpr` forms keep working byte-for-byte; expressions
  are a **fifth form**, additive, with no migration of stored documents.

## 2. Non-goals

| Not done here | Where |
|---|---|
| The editor, the preview, the data picker | plan 306 (and **P8 gates this plan**: 300 D4) |
| Replacing `{ from, path }` in stored documents | never — the old forms stay legal |
| Regular expressions | never (plan 95 §3.8 R2 stands) |
| Date arithmetic, timezone maths | plan 306 §9 if an author actually asks |
| User-defined functions, variables, assignment | never — that is a script |

## 3. Context and design decisions

### 3.1 Why not a library

Plan 300 R3/R4/R5 in full. In one paragraph: n8n hands expression text to
`Function` and defends with an AST **deny-list**, and CVE-2026-1470 walked
past it with a `with` statement; JSONata evaluates against live JS objects and
CVE-2026-77414 walked the prototype chain to the global `Function`; both were
2026. CEL is the right design — non-Turing-complete, allow-list — but `cel-js`
is 0.8.2, last published 2025-07-11, and pulls `chevrotain` and `ramda`. The
repo's own precedent is `compute-layout.ts`, which refused dagre in writing
and shipped 100 lines instead.

The defence here is **structural, not a filter**: there is no `Function` to
reach, because the evaluator is a `switch` over a closed AST union and the
scope is a prototype-free object graph. A deny-list can be walked around; a
grammar that cannot express member access on a prototype cannot.

### 3.2 The stored form is the source text (refines plan 300 D4)

Plan 300 D4 says "stored as an AST". Executing that literally means the
document carries a serialised AST plus the source text for the editor, and
therefore carries the risk that the two drift. This plan stores **the source
string only**, and derives the AST with the same pure parser at publish time
(to validate and bound it) and again at run time.

That is not a weakening: the hazard D4 names is `eval`, and parsing is not
evaluating. `parse` is a pure function from string to a closed union, bounded
by `maxAstNodes` and `maxDepth` before it returns, and it constructs no
callable. One source of truth beats a cached derivation of it.

*Plan 300 §3 D4's wording is corrected to match by the plan-300 author; if the
two documents still disagree when you read this, this paragraph wins and the
discrepancy goes in §11.*

### 3.3 Purity has two escape valves, and both are injected

`$now` and `$random` are **not** read from the host by the evaluator. The
caller passes them in the scope: the executor supplies `$now` once per step
(the step's start time) and `$random` from a per-run seed. Consequences worth
the constraint: an expression is reproducible when a run is replayed, and the
evaluator has no access to a clock or an entropy source of its own.

## 4. Technical design

### 4.1 Package

`packages/expr`, `@enkaku/expr`, no runtime dependencies (G6), five files:

| File | Contents |
|---|---|
| `src/ast.ts` | the AST union and `EXPR_LIMITS` |
| `src/parse.ts` | tokeniser + recursive-descent parser → AST, or `ExprParseError` |
| `src/eval.ts` | `evaluate(ast, scope, opts)` → value, or `ExprEvalError` |
| `src/functions.ts` | the closed function table |
| `src/index.ts` | `parse`, `evaluate`, `describe` (types of a scope, for plan 306's autocomplete), the error classes, `EXPR_LIMITS` |

### 4.2 Grammar

```
expr        := ternary
ternary     := or ( '?' expr ':' expr )?
or          := and ( '||' and )*
and         := equality ( '&&' equality )*
equality    := comparison ( ('==' | '!=') comparison )*
comparison  := additive ( ('<' | '<=' | '>' | '>=') additive )*
additive    := multiplicative ( ('+' | '-') multiplicative )*
multiplicative := unary ( ('*' | '/' | '%') unary )*
unary       := ('!' | '-') unary | postfix
postfix     := primary ( '.' IDENT | '[' expr ']' )*
primary     := NUMBER | STRING | 'true' | 'false' | 'null'
             | ROOT | IDENT '(' args? ')' | '(' expr ')'
ROOT        := '$params' | '$nodes' | '$input' | '$run' | '$now' | '$random'
args        := expr ( ',' expr )*
```

Not in the grammar, and therefore not expressible: assignment, `=>`, `function`,
`new`, `with`, `typeof`, `instanceof`, `in`, template literals, regex literals,
spread, optional chaining, comma operator, `++`/`--`, bitwise operators,
`?.`, `??` (use `default(a, b)`), object and array literals, and any identifier
that is not immediately followed by `(`.

That last rule is the one that makes `constructor` unreachable: a bare
identifier is **only** legal as a function name in a call position, and the
function table is a closed record. `$nodes.a.constructor` is legal *syntax*
(`.` IDENT) and returns `undefined` at run time, because member access is an
own-property lookup on a null-prototype object (§4.4). Both doors are shut.

### 4.3 AST

```ts
export type Expr =
  | { t: 'lit'; v: string | number | boolean | null }
  | { t: 'root'; name: '$params' | '$nodes' | '$input' | '$run' | '$now' | '$random' }
  | { t: 'member'; on: Expr; key: string }
  | { t: 'index'; on: Expr; idx: Expr }
  | { t: 'unary'; op: '!' | '-'; on: Expr }
  | { t: 'bin'; op: BinOp; l: Expr; r: Expr }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'call'; fn: string; args: Expr[] }

export const EXPR_LIMITS = {
  maxSourceBytes: 2_000,
  maxAstNodes: 200,
  maxDepth: 20,
  /** Evaluation fuel: one unit per AST node visited, per function call, per element touched by an array function. */
  maxSteps: 10_000,
  maxStringBytes: 64 * 1024,
  maxArrayLength: 10_000,
} as const
```

`maxAstNodes` and `maxDepth` are enforced **inside** `parse`, as the tree is
built, so a pathological input is refused before a whole tree exists.

### 4.4 Evaluation

```ts
export interface ExprScope {
  $params: Readonly<Record<string, unknown>>
  $nodes: Readonly<Record<string, unknown>>
  $input: unknown
  $run: Readonly<{ summary: unknown }>
  $now: number
  $random: number
}

export function evaluate(ast: Expr, scope: ExprScope, opts?: { fuel?: number }): unknown
```

Five rules, each with a test:

1. **Scopes are null-prototype.** The caller builds them with
   `toScopeValue(x)`, exported from this package: a recursive copy that turns
   every plain object into `Object.create(null)`, keeps arrays, primitives,
   `null`, and turns anything else (functions, class instances, `Date`,
   `Map`) into `undefined`. Depth- and size-bounded. This is the single most
   important function in the package and it has its own test file.
2. **Member access is an own-property check**: `Object.prototype.hasOwnProperty.call(on, key)`
   — captured once at module load, never looked up through the value.
   Missing ⇒ `undefined`, never a throw.
3. **Index access** takes an integer ≥ 0 on an array, or a string on an
   object (same own-property rule). A negative or fractional index ⇒
   `undefined`. No `-1` convenience: `last(a)` exists.
4. **Fuel** decrements on every node visit and every element an array function
   touches; zero ⇒ `ExprEvalError('E_EXPR_LIMIT')`.
5. **Coercion is explicit and narrow.** `+` concatenates when either side is a
   string, adds when both are numbers, and is an error otherwise —
   no `[] + {}` folklore. `==` compares primitives by value with no coercion
   across types (`1 == "1"` is `false`); objects and arrays compare by deep
   value, bounded by fuel.

### 4.5 The function table (`functions.ts`)

Closed. Each entry declares arity, argument types, and a pure implementation.
Adding one is a code change with a test, never configuration.

| Group | Functions |
|---|---|
| text | `len`, `lower`, `upper`, `trim`, `contains`, `startsWith`, `endsWith`, `split`, `join`, `replace` (literal, not regex), `slice`, `padStart`, `padEnd` |
| number | `abs`, `floor`, `ceil`, `round`, `min`, `max`, `clamp`, `toNumber` |
| array | `len`, `first`, `last`, `at`, `slice`, `contains`, `count`, `unique`, `sort` (natural, no comparator), `reverse` |
| object | `has`, `keys`, `get` (dotted path + default) |
| value | `default`, `coalesce`, `isEmpty`, `notEmpty`, `toText`, `toJson`, `fromJson`, `type` |

`fromJson` returns a value already passed through `toScopeValue` — parsed JSON
never enters the evaluator with a live prototype.

### 4.6 Errors

| Class | Code | When |
|---|---|---|
| `ExprParseError` | `E_EXPR_PARSE` | syntax, unknown root, unknown function, over `maxAstNodes`/`maxDepth`/`maxSourceBytes` |
| `ExprEvalError` | `E_EXPR_LIMIT` | fuel, string or array bound |
| `ExprEvalError` | `E_EXPR_TYPE` | an operator or function applied to the wrong type |

Every error carries `offset` (character index into the source) so plan 306 can
underline the failing token.

### 4.7 The fifth `ValueExpr` form

```ts
// packages/protocol/src/workflow.ts
z.object({ expr: z.string().min(1).max(EXPR_LIMITS.maxSourceBytes) }).strict()
```

The four existing forms are untouched (G8). `checkWorkflow` gains two codes:
`expr-parse` (error, with the parse error's message and offset) and
`expr-unknown-node` (error — `$nodes.foo` where `foo` is not a node that can
have run before this one, which is the SAME reachability rule the `{ from }`
form already enforces, applied to the roots an expression names).

`packages/core/src/workflows/workflow-resolve.ts` gains one branch: build the
scope from the run's recorded outputs, `parse`, `evaluate`. The scope is built
once per step, not once per binding.

## 5. Implementation steps

**302.1 — The package skeleton.** `packages/expr/package.json`
(`@enkaku/expr`, `"type": "module"`, no `dependencies`), `tsconfig.json`
extending `tsconfig.base.json`, and `src/ast.ts` with the union and
`EXPR_LIMITS`. Add the package to the root workspace and to
`packages/studio`'s `transpilePackages` (plan 306 imports it in the browser).
*Result*: `bun run typecheck` clean with an empty implementation.

**302.2 — `toScopeValue`.** Write it first, with `src/scope.test.ts`: a plain
object becomes null-prototype; a nested one too; `Date`/`Map`/function/class
instance become `undefined`; cycles are cut at `maxDepth`; arrays keep order.
*Result*: the one function every other file depends on is proven before there
is a parser.

**302.3 — Tokeniser and parser.** `src/parse.ts` per §4.2, enforcing the three
size limits during construction. *Result*: `parse.test.ts` with a passing and
a refusing case per production, plus the "bare identifier only in call
position" rule.

**302.4 — Evaluator.** `src/eval.ts` per §4.4. *Result*: `eval.test.ts`
covering the five rules, determinism (G5), and `undefined` propagation.

**302.5 — Function table.** `src/functions.ts` per §4.5, one test per
function, including the bounds (`slice` past the end, `split` on an empty
string, `sort` on mixed types → `E_EXPR_TYPE`).

**302.6 — The security suite.** `src/security.test.ts`, and this file is the
plan's spine, not an afterthought. It contains, verbatim as source strings and
each asserted to throw at **parse** time:
- the CVE-2026-1470 shape: `(function(){ var constructor = 'x'; with(function(){}){ return constructor("...")() } })()`
- `$nodes.a.constructor("return process")()`
- `$nodes.a.__proto__.polluted = 1`
- `$nodes["constructor"]["prototype"]`
- `toJson.constructor`
- an 8 KB nested-parentheses bomb (`maxDepth`)
and, asserted at **eval** time: `$nodes.a.__proto__` → `undefined`,
`$nodes.a.toString` → `undefined`, a 10 000-iteration `sort`+`unique` chain →
`E_EXPR_LIMIT`.

**302.7 — Protocol wiring.** Add the fifth `ValueExpr` form and the two
`checkWorkflow` codes (§4.7). *Result*:
`bun test packages/protocol/src/workflow.test.ts` and
`bun test packages/protocol/src/workflow-check.test.ts` green.

**302.8 — Runtime wiring.** `workflow-resolve.ts` builds the scope and
evaluates. `$now` is the step's start time; `$random` comes from a per-run
seed stored on the run row so a replay reproduces it. *Result*:
`bun test packages/core/src/jobs/executors/workflow.test.ts` green with a new
case binding a parameter through an expression.

**302.9 — Line count and report.** `wc -l` for G7; if it is over 600, narrow
the grammar (D4's falsification test) rather than asking for an exception.

## 6. Acceptance criteria

- G1–G10.
- `rg -n "new Function|eval\(|Function\(" packages/expr/src` → empty.
- `rg -n "\bprototype\b" packages/expr/src` → only in `scope.ts`'s
  `Object.create(null)` comment and the captured `hasOwnProperty`.
- The security suite has ≥ 9 cases and all pass.

## 7. Test plan

Unit, as listed in §5. No integration test beyond the executor case in 302.8.

Manual smoke (owner, 3 minutes): publish a workflow whose gate reads
`len($nodes.read.result.items) > 0`, run it against a device, and confirm the
step summary shows the gate's resolved verdict. Then edit it to
`$nodes.read.result.items.constructor` and confirm the publish is refused with
a message naming the offset.

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Does the browser bundle need the parser, or only the server? | Both — P8's preview is local and must not round-trip. That is why 302.1 adds the package to `transpilePackages`. |
| Q2 | Should `$input` exist when a node has two incoming edges? | Yes: `$input` is the output of the node the cursor actually came from at run time, which is always exactly one node under plan 300 D5's single cursor. If D5 is ever reversed, `$input` becomes ambiguous and plan 308 must address it. |
| Q3 | Date and duration helpers? | Not now. `$now` is a number; an author who needs formatting uses a script. Revisit only with a real request. |
| Q4 | Autocomplete needs a type view of the scope (`describe`) | Stubbed in `index.ts` in this plan, implemented by 306 against the last run's real data. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| The claim that this repo has no expression language | `packages/protocol/src/workflow.ts` module doc (plan 99 §3.7 F27 wording) | `rg -n "refuses to build one" packages/protocol/src/workflow.ts` → empty; the comment is rewritten to cite plan 300 D4 and name the boundary (done in this second pass — see below) |

## 11. Handoff report

This plan was executed in two passes, by two different agent sessions. The
first pass (steps 302.1–302.6, 302.9) is preserved below unedited except for
this note; the second pass (steps 302.7–302.8, this section's addendum)
finished the plan and flips `> Status:` to `implemented`.

### Second pass — 302.7 and 302.8 (this session)

- **Checklist**: G1–G7 and G10 unchanged from the first pass (see below). G8 ✅ G9 ✅ — both now built and green.

- **Scope executed**: 302.7 (the fifth `ValueExpr` form in `packages/protocol/src/workflow.ts`, the two `checkWorkflow` codes in `workflow-check.ts`) and 302.8 (the `resolveValue` wiring). §10's F27 rewrite is done in this pass, not the first.

- **Files touched**:
  - `packages/protocol/package.json` — added `@enkaku/expr: workspace:*`.
  - `packages/protocol/src/workflow.ts` — `ValueExpr`'s fifth form `{ expr: string }` (bounded by `EXPR_LIMITS.maxSourceBytes`), the module doc rewritten to name plan 300 D4 instead of "refuses to build one".
  - `packages/protocol/src/workflow.test.ts` — new `describe('ValueExpr five forms', ...)` group (G8's named group), the old "fifth shape ... refused" test retitled "sixth shape" since a fifth is now legal.
  - `packages/protocol/src/workflow-check.ts` — `E_WORKFLOW_EXPR_PARSE` and `E_WORKFLOW_EXPR_UNKNOWN_NODE` finding codes, a `collectExprNodeRefs` AST walker, and the `'expr' in expr` branch in the binding-sites loop.
  - `packages/protocol/src/workflow-check.test.ts` — new `describe('expression findings (plan 302 §4.7, G9)', ...)` group, 6 cases.
  - `packages/protocol/src/workflow-resolve.ts` — `ResolveScope` gains optional `now`/`randomSeed`; a `WeakMap`-memoised `buildExprScope` (keyed on the `ResolveScope` object's own identity, so a step with N `{ expr }` bindings builds `$params`/`$nodes`/`$run` through `toScopeValue` exactly once — see the discrepancy below on how "once per step" was actually satisfied); `resolveValue` gains the `'expr' in expr` branch (parse + evaluate, caught and turned into `{ ok: false, code: 'unresolved' }` on any failure).
  - `packages/protocol/src/workflow-resolve.test.ts` — unchanged; the existing "four forms" suite still passes unmodified (G8's byte-for-byte requirement).
  - `packages/core/src/jobs/executors/workflow.ts` — `runScriptStep` takes a `stepStartedAt: Date` parameter and passes `now: stepStartedAt.getTime()`; the gate's own scope passes `now: rowStartedAt.getTime()`; the `onFail` cleanup scope passes `now: Date.now()` (no step row of its own to draw a start time from).
  - `packages/core/src/jobs/executors/workflow.test.ts` — new case: an `{ expr }` binding reading `$nodes`, `$params`, and `$now`, asserted against the child job's own `params` row.

- **Discrepancy — the file plan 302.8 names does not exist.** §4.7/§5 step 302.8 both say `packages/core/src/workflows/workflow-resolve.ts`. No such file exists on `mvp`; `resolveValue`/`evaluatePredicate`/`ResolveScope` have lived in `packages/protocol/src/workflow-resolve.ts` since plan 99, and plan 301 kept them there. The wiring was built in the real file. `@enkaku/expr` is now a dependency of `@enkaku/protocol` (not `@enkaku/core`) as a consequence — the opposite direction from what §4.1/§4.7's prose implies, but the only one that matches where the function this plan is wiring actually lives.

- **Discrepancy — the two `WorkflowFindingCode` names.** §4.7 names them `expr-parse` and `expr-unknown-node` (lowercase, hyphenated). Every one of the ~20 existing codes in `WorkflowFindingCode` is `E_WORKFLOW_*`/`W_WORKFLOW_*` (upper snake case, no exceptions — see the type's own definition). Adding two lowercase-hyphenated outliers into a closed union that is otherwise 100% consistent would be a worse fit than the plan's literal wording, so this pass used `E_WORKFLOW_EXPR_PARSE` and `E_WORKFLOW_EXPR_UNKNOWN_NODE` instead — same meaning, matching the file's own established convention. Both are `error` severity, as §4.7 specifies.

- **Discrepancy — `E_WORKFLOW_EXPR_UNKNOWN_NODE` covers two cases `{ from }` splits across two codes.** `{ from }`'s unknown-node case is `E_WORKFLOW_UNKNOWN_NODE`, and its forward-ref case is the separate `E_WORKFLOW_FORWARD_REF`. §4.7's own prose for the expression version folds both into ONE code ("`expr-unknown-node` (error — `$nodes.foo` where `foo` is not a node that can have run before this one...)"), so this pass followed the plan's prose literally rather than the `{ from }` precedent's two-code split. If a later reviewer wants the `{ from }` symmetry instead, splitting `E_WORKFLOW_EXPR_UNKNOWN_NODE` into two codes is a small, isolated change confined to the `if ('expr' in expr)` branch.

- **Design decision recorded (not in the plan, needed to implement it) — `$input`.** §4.7's own code block for `workflow-resolve.ts` does not mention `$input` at all, but `@enkaku/expr`'s `ExprScope` requires it, and plan 302 §9 Q2 already answers what it should be: "the output of the node the cursor actually came from at run time... always exactly one node under plan 300 D5's single cursor." Rather than thread a new "previous node id" variable through the executor, `$input` is derived as the LAST entry of `scope.summary` — under the single-cursor model that is provably the same node, and `summary` is already appended in step-completion order by every one of the executor's three call sites. `undefined` for the very first script/gate node, whose predecessor is `start` (which produces nothing). Not a discrepancy so much as an unstated design gap in §4.7 that this pass had to close to compile at all.

- **Design decision recorded — `$random`, per the launch instruction.** No `runs`/`jobRuns` column carries a per-run seed (`packages/core/src/db/schema.ts`'s `jobRuns` table has no `seed`/`randomSeed` field, checked directly). Per the explicit instruction accompanying this job, that column is plan 304 §4.1's to add — not added here. `ResolveScope.randomSeed` is optional and every call site in `workflow.ts` omits it, so `resolveValue`'s `buildExprScope` falls back to the documented fixed `0`. `$random` is therefore constant across every run until plan 304 lands; this is recorded, not hidden, in `ResolveScope.randomSeed`'s own doc comment and here.

- **`$now`'s unit.** §3.3/§4.7 do not state a unit. This pass used **milliseconds** (`Date.getTime()`), matching JavaScript's own `Date.now()` convention that `$now` most naturally mirrors for an author writing `$now - $nodes.a.startedAt` — NOT the repo's usual unix-seconds DB convention (`packages/core/src/db/schema.ts`'s timestamp columns), because `$now` here is a pure evaluation input handed to `@enkaku/expr`, not a stored column. Recorded because it is the kind of unit mismatch that is easy to get wrong later.

- **Typecheck**: clean. `bash scripts/typecheck.sh` → `OK` for all 21 workspace targets (protocol, expr, ui, adb, toolchain, drivers, scrcpy, sdk, session, harness, core, node, studio, probe-server, networking, proxy-manager, tiktok-automation-pack, mikrotik-routing, google-automation-pack, youtube-automation-pack, examples).

- **Tests run** (one invocation at a time, never concurrently):
  - `bun test packages/protocol/src/workflow.test.ts` → 70 pass, 0 fail
  - `bun test packages/protocol/src/workflow-check.test.ts` → 40 pass, 0 fail
  - `bun test packages/protocol/src/workflow-resolve.test.ts` → 55 pass, 0 fail (unmodified — proves G8's "no behaviour change" for the four old forms)
  - `bun test packages/core/src/jobs/executors/workflow.test.ts` → 9 pass, 0 fail
  - `bun test packages/expr/src/` (unmodified this pass; run once as a final sweep since `workflow.ts`/`workflow-check.ts`/`workflow-resolve.ts` now import from it) → 162 pass, 0 fail, 1224 expect() calls

- **`bun run build:studio`**: **not run**, same reason as the first pass — a `next dev` server (now `node` pid on `:3001`, from the same concurrently running Studio session the launch instructions named) still holds the port; `bash scripts/build-studio.sh` was invoked and confirmed the refusal (its own guard message, quoted verbatim): *"The Studio dev server is running on :3001. Building now would corrupt it... Stop it first, then build."* Neither job in this launch touches `packages/studio`, so this is expected, not a gap this pass could close without violating the instruction not to touch the other session's dev server.

- **`packages/studio`**: NOT edited, per the launch instruction. Checked for fallout: `packages/studio/src/components/workflow/ValueExprEditor.tsx`'s `kindOfValueExpr` is an if-chain (`'const' in value` / `'param' in value` / `'from' in value`, falling through to `'run'`) — not an exhaustive `switch`, so the new `expr` variant compiles fine and simply misclassifies an `{ expr }` value as `'run'` at the UI layer (it would render as a run-summary picker, not an expression editor). This is a known, expected gap: plan 306 owns building the actual expression editor UI; nothing in plans 302/303 asked Studio to render the fifth form correctly, and `bun run typecheck`'s `studio OK` confirms nothing broke.

- **Removed, proven** (§10, completed in this pass):
  - `rg -n "refuses to build one" packages/protocol/src/workflow.ts` → empty (0 matches). The module doc for `ValueExpr` now reads: "Plan 99 §3.6's F27 stance — a binding must never compute — is reversed by plan 300 D4...".

- **Observed, not done**:
  - `bun run build:studio` — blocked by the concurrent session's dev server, as above.
  - The §7 manual owner smoke ("publish a workflow whose gate reads `len($nodes.read.result.items) > 0`, run it against a device...") — needs a real device and an operator; not run by an agent, consistent with plan 200 §8.3's division of labour. The protocol/executor wiring it depends on now exists and is unit-tested.

- **Open questions hit**: none of plan 302 §9's four questions blocked 302.7/302.8. Q2 ($input's definition) is answered exactly as §9 already answers it — see the design-decision note above for how that answer was actually wired given §4.7's code block omits `$input` entirely.

- **Processes**: no process was started by this session that is still running.

  ```
  $ ps -Ao pid=,command= | grep -i "[o]penpf"
  (no output)
  ```

### First pass — 302.1–302.6, 302.9 (prior session, preserved verbatim)

- **Checklist**: G1 ✅ G2 ✅ G3 ✅ G4 ✅ (see discrepancy below) G5 ✅ G6 ✅ G7 ✅ (518 lines) G8 ⏸ deferred (302.7 not executed, instructed) G9 ⏸ deferred (302.8 not executed, instructed) G10 ✅

- **Scope actually executed**: steps 302.1–302.6 and 302.9, exactly as scoped. Steps 302.7 (the fifth `ValueExpr` form + two `checkWorkflow` codes in `packages/protocol/src/workflow.ts` / `workflow-check.ts`) and 302.8 (`packages/core/src/workflows/workflow-resolve.ts` wiring) were **not started** — those three files are being rewritten by a concurrently running plan-301 agent in another worktree, and touching them here would guarantee a merge conflict on exactly the files whose shape is changing, per the launch instructions.

- **Commits**: to be created after this report — one `feat(flow-302): ...` commit containing the whole package, the `typecheck.sh`/`next.config.ts` wiring, and this report. (See the final message for the actual hash once committed.)

- **Branch**: `flow-302-expr-engine`, cut from `mvp` at `d22785e` (`docs(flow): D4 ratified by the owner, 2026-09-04`), in worktree `/Users/solpochi/Projects/oss/openpf/.claude/worktrees/agent-ab1b440fcfa8029eb`.

- **Typecheck**: clean. `bash scripts/typecheck.sh` → `OK` for all 21 workspace targets including the new `expr` row (added to the script's package list). `packages/expr` typechecks standalone too (`bunx tsc --noEmit -p packages/expr`).

- **Tests run** (one invocation at a time, never concurrently, per CLAUDE.md):
  - `bun test packages/expr/src/scope.test.ts` → 12 pass, 0 fail
  - `bun test packages/expr/src/parse.test.ts` → 62 pass, 0 fail
  - `bun test packages/expr/src/eval.test.ts` → 28 pass, 0 fail
  - `bun test packages/expr/src/functions.test.ts` → 49 pass, 0 fail
  - `bun test packages/expr/src/security.test.ts` → 11 pass, 0 fail
  - `bun test packages/expr/src/` (the directory this plan touched, run once as a final sweep) → 162 pass, 0 fail, 1224 expect() calls, 34ms
  - `packages/protocol/src/workflow.test.ts` and `packages/protocol/src/workflow-check.test.ts` (named by G8/G9) were **not run** — the fifth `ValueExpr` form and the `checkWorkflow` codes they'd cover were not built (deferred).

- **`bun run build:studio`**: **not run**. A `next-server` (pid 18677, `next dev`) was already listening on `:3001` when this plan started, owned by the concurrent session the launch instructions named as working in the main worktree. `scripts/build-studio.sh` refuses to build while that port is held (by design — it corrupts the dev server), and killing someone else's process to force it through would violate "never touch the main worktree / other agents' processes." The one Studio-relevant change here (`next.config.ts`'s `transpilePackages` gaining `@enkaku/expr`) is a one-line, low-risk addition in the same shape as the two entries already there; it typechecks, but the export itself is unverified. Flagged rather than forced.

- **Removed, proven**:
  - `rg -n "new Function|eval\(|Function\(" packages/expr/src` → 0 matches (empty), as required.
  - `rg -n "\bprototype\b" packages/expr/src` → **17 matches in 7 files**, not the "only in `scope.ts`'s comment and the captured `hasOwnProperty`" the plan's §6 predicted. All 17 are safe: doc comments in `eval.ts`/`functions.ts`/`scope.ts` explaining the null-prototype design, and test names/descriptions in all five `*.test.ts` files that talk *about* prototypes (`'a plain object becomes null-prototype'`, `'.__proto__ resolves to undefined'`, etc.). The one security-relevant capture, `const hasOwn = Object.prototype.hasOwnProperty`, lives in `eval.ts` (where member/index lookups actually happen), not in `scope.ts` (which only builds scopes) — the plan's predicted location doesn't match where the own-property check is naturally needed. Recorded as a discrepancy, not silently narrowed.
  - `packages/protocol/src/workflow.ts`'s F27 module-doc rewrite (plan §10's only row) is **not done** — it belongs to deferred step 302.7 and touches a file plan-301's concurrent agent owns right now. `rg -n "refuses to build one" packages/protocol/src/workflow.ts` still finds the old line (1 match) — expected, given the deferral.

- **Discrepancies between plan and code**:
  - **G4 cites `packages/expr/src/limits.test.ts`**, a file no implementation step (§5) ever calls for. §5's own steps put size/depth-limit cases in `parse.test.ts`'s `limits` group (302.3), fuel cases in `eval.test.ts`'s `fuel` group (302.4), and the wall-time-bounded fuel-exhaustion case in `security.test.ts` (302.6). No `limits.test.ts` was created; G4's intent is covered by those three groups instead. The wall-time assertion (`< 1000ms`) lives in `security.test.ts`'s 10,000-iteration `sort`+`unique` case.
  - **`toScopeValue` needed its own file (`scope.ts`/`scope.test.ts`)**, though §4.1's five-file table (`ast.ts`, `parse.ts`, `eval.ts`, `functions.ts`, `index.ts`) does not list one. §5 step 302.2 names `src/scope.test.ts` directly and calls `toScopeValue` "the single most important function in the package," so a dedicated file matched the step's intent better than folding it into `eval.ts` (which would have pushed `eval.ts` over budget for no reason, since `scope.ts` is not one of the three files G7 counts). Not counted toward G7's 600-line budget either way.
  - **`ExprEvalError` and `Fuel` live in `ast.ts`, not `eval.ts`.** §4.4's code block shows `evaluate(...)` in what reads like `eval.ts`, but `functions.ts` (§4.5) needs to throw `ExprEvalError` and receive `Fuel` as a real value, and `eval.ts` needs to import the real `FUNCTIONS` table from `functions.ts` as a value — a two-way value import would be a circular module dependency. Moving the two shared runtime primitives into the dependency-free `ast.ts` breaks the cycle: `functions.ts` and `eval.ts` both value-import from `ast.ts` only, never from each other in a cycle. `index.ts` still re-exports both from a single place, so the public API is unaffected. This does inflate `ast.ts`'s line count against the three-file G7 budget (still 518/600 total), which is the honest tradeoff — narrowing further was not needed since the total was under budget either way.
  - **`$nodes["constructor"]["prototype"]` structurally cannot parse**, by design, not by a string blacklist: any string-literal used as a `[ ]` index is refused at parse time (`a string literal index is not allowed; use "." or get()`), because plan 300 D4 §1 says "no property access by computed key" while plan 302 §4.4 rule 3's prose ("or a string on an object") suggested bracket-string indexing was meant to be legal at eval time. The two documents disagree; the security suite (G3) settles it by requiring that exact string to fail at *parse* time, which only a category-level exclusion (not a value-level one) can satisfy without violating the "never special-case one string" instruction. Numeric bracket indexing (`a[0]`, `a[i]`) is untouched; object access by name goes only through `.` (fixed key) or `get(obj, "a.b.c")` (the closed-table substitute, itself an own-property walk that can never reach `constructor`/`__proto__`/`prototype` either — see `functions.test.ts`'s `get()` case). This is the single most consequential design call in the package and is called out here in full rather than left implicit in a code comment.
  - **`ExprEvalError.offset` is not a real source position for eval-time errors.** §4.3's `Expr` AST union (copied verbatim from the plan) carries no `offset` field on any node, so an eval-time error has nothing to point at; it defaults to `0`. Parse-time errors (`ExprParseError`) do carry the real character offset, since the tokeniser has one. §4.6's "every error carries `offset`" is therefore only fully true for parse errors; eval errors carry a placeholder. Not fixed here because adding position tracking to every AST node would grow `ast.ts`/`eval.ts` well past what G7's budget needs, for a feature (underlining the failing token for a *runtime* error) that plan 306 owns and that a workflow author only meets after a run has already happened via the recorded step data, not through this package's error object.

- **Observed, not done**:
  - `bun run build:studio` (§6/CLAUDE.md's Studio verification step) — blocked by a concurrent session's `next dev` on `:3001`, not run. See above.
  - 302.7 and 302.8 in full — instructed deferral, not a discovery.
  - The manual owner smoke in §7 ("publish a workflow whose gate reads `len($nodes.read.result.items) > 0`...") needs the protocol wiring from 302.7/302.8 to exist at all; not runnable yet.

- **Open questions hit**: none of §9's four questions blocked any of steps 302.1–302.6/302.9. Q1 (browser needs the parser too) is why `transpilePackages` was edited in 302.1. Q4 (`describe`) is stubbed exactly as Q4 says to.

- **Processes**: no process was started by this session that is still running. The `next-server` on `:3001` (pid 18677) predates this session and belongs to the concurrently running Studio session named in the launch instructions; it was not started, stopped, or otherwise touched here.

  ```
  $ ps -Ao pid=,command= | grep -i "[o]penpf"
  (no output)
  ```
