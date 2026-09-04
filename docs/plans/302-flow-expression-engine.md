# Plan 302 — Flow : `@enkaku/expr` — a closed expression engine that cannot reach `Function`

> Status: draft
> Ships: `packages/expr/src/index.ts`
> Depends on: plan 300 D4 (**needs the owner's ratification before execution** — 300 §3.1)
> Spec references: §4.6; this plan adds a package to §3 (repository layout), rewritten by plan 307.

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | `parse` accepts the whole grammar of §4.2 and refuses everything else | every production has a passing case and a refusing case | `bun test packages/expr/src/parse.test.ts` → all pass | [ ] |
| G2 | The evaluator never touches a prototype chain | scope objects are `Object.create(null)`; every lookup is an own-property check | `bun test packages/expr/src/eval.test.ts` → `prototype` group passes | [ ] |
| G3 | Every published escape shape from plan 300 R3/R4 fails to parse | 6 cases, all `E_EXPR_PARSE` | `bun test packages/expr/src/security.test.ts` → `known escapes` passes | [ ] |
| G4 | Fuel and depth limits are hard | an expression that would exceed either throws `E_EXPR_LIMIT` and never hangs | `bun test packages/expr/src/limits.test.ts`, wall time under 1 s | [ ] |
| G5 | The engine is pure: same AST, same scope, same value, twice | 1000 randomised round-trips | `bun test packages/expr/src/eval.test.ts` → `determinism` passes | [ ] |
| G6 | The package has **zero runtime dependencies** | `dependencies` is `{}` or absent | `cat packages/expr/package.json` → no `dependencies` key with entries | [ ] |
| G7 | The interpreter is under 600 lines (plan 300 D4's falsification test) | `parse.ts` + `eval.ts` + `ast.ts` ≤ 600 lines | `wc -l packages/expr/src/parse.ts packages/expr/src/eval.ts packages/expr/src/ast.ts` → total ≤ 600 | [ ] |
| G8 | A workflow parameter may be an expression, and the old four `ValueExpr` forms still work unchanged | 5 forms parse; the 4 old ones have no behaviour change | `bun test packages/protocol/src/workflow.test.ts` → `ValueExpr five forms` passes | [ ] |
| G9 | `checkWorkflow` reports an unparsable or out-of-scope expression at publish, not at run | 2 codes | `bun test packages/protocol/src/workflow-check.test.ts` → `expression findings` passes | [ ] |
| G10 | `bun run typecheck` clean | 0 errors | `bun run typecheck` exits 0 | [ ] |

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
| The claim that this repo has no expression language | `packages/protocol/src/workflow.ts` module doc (plan 99 §3.7 F27 wording) | `rg -n "refuses to build one" packages/protocol/src/workflow.ts` → empty; the comment is rewritten to cite plan 300 D4 and name the boundary |

## 11. Handoff report

_To be written by the executing agent._
