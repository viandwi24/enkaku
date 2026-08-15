# @enkaku/protocol

Zod schemas and pure functions shared by the core and Studio — the WS/REST envelope, settings, parameters, and the workflow document. Nothing here touches a database or a device; that is what makes it safe to import from both sides of the wire.

## `schema/` — a declared schema and a value measured against it (plan 95, M60; renamed and widened by plan 97, M62)

`packages/protocol/src/schema/` (moved from `params/` by plan 97 step 97.1 — every export kept its shape, three were renamed to drop the word "params" once the same machinery started describing a script's `result` too, and the directory move was a single mechanical commit, never a fork) is the shared description of *what an author declared* and *whether a value satisfies it*, used identically on both sides of a script: `params` (what a script reads in) and, since plan 97, `result` (what a script hands back). Everything in it is pure, total, and DOM-free — no fetching, no throw, no control name anywhere.

| Export | What it is |
|---|---|
| `ui()`, `ParamHints`, `ParamKind`, `readHints` | The typed vocabulary an author writes under `.meta()` — `kind`, `unit`, `group`, `source`, `showWhen`, and (plan 97) `summary`. Re-exported from `@enkaku/sdk` so a script project need not depend on `@enkaku/protocol` directly. Unrenamed — these names describe the vocabulary itself, which did not change meaning when its consumers widened. |
| `SCHEMA_LIMITS` (was `PARAMS_LIMITS`) | The published ceiling on any declared schema — 64 KiB, depth 5, 200 fields, 200 enum members, an identifier-shaped-name rule, a `__proto__`/`constructor`/`prototype` blocklist (`DANGEROUS_FIELD_NAMES`), a 20 000-node walk budget. One set of numbers for a `params` schema and a `result` schema alike. |
| `checkDeclaredSchema` (was `checkParamsSchema`) | Runs `SCHEMA_LIMITS` against a schema at publish time, returning **every** finding, never just the first. Wired into all three publish paths (`POST /api/scripts`, the plugin verify child, `enkaku publish`'s own local check) for both `paramsSchema` and, when declared, `resultSchema`. |
| `validateAgainstSchema` (was `validateParams`) | `(schema, value) → { ok: true } | { ok: false, issues }`, dot-notation paths, sentences written for someone who did not author the script. Evaluates no author-supplied regular expression on either side — an untrusted `pattern` is never compiled. The one function the browser's enqueue-time check, the core's own re-check, and (plan 97) `planResult`'s R1 branch selection all call, so none of the three can disagree about whether a value matches a schema. |
| `clampSchema` (was `clampParamsSchema`) | How a schema already in the database, published before a limit existed, still renders — clamped rather than refused retroactively. |
| `formatValue` (moved here from `packages/studio/src/components/schema-form/controls/format.ts`) | `(kind, unit, value) → string` — `536870912 → "512 MB"`, `0.35 → "35%"`, `90000 + ms → "1 min 30 s"`. Moved into this package specifically because the **core** now needs it too (it builds a job's `resultSummary` at settle) and cannot import from `packages/studio`; Studio re-imports it from here rather than keeping a second copy. Brings `NumberKind` with it. |
| `hostile-fixtures.ts` | Ten blocking fixtures (`self-ref-cycle`, `deep-40`, `wide-5000`, `giant-description`, `redos-pattern`, `oversized-200kb`, …) reused verbatim against both a `params` schema and a `result` schema. |
| `schema/result.ts` (new, plan 97) | `RESULT_STATUSES`/`ResultStatusSchema` (`undeclared`\|`valid`\|`invalid`\|`partial`\|`oversize` — §3.3 of plan 97 has the full reasoning for why two are not enough), `RESULT_LIMITS` (`defaultMaxResultBytes: 65_536`, matching `kv.maxValueBytes`; `maxSummaryFields: 3`; `maxSummaryChars: 120`; `maxIssues: 20`; `maxProgressBytes: 4096`), `summaryFields(schema)` (the top-level `summary: true` fields, declaration order, capped at three, a fourth silently not included rather than refused at publish), and `buildResultSummary(fields, value)` (the ≤120-character jobs-list line, reusing `formatValue` so a summary and a field's own readout never disagree). |

`ui`/`reconcileParams` were **not** renamed — `ui()` is a shipped public SDK export with real call sites everywhere, and `reconcileParams` genuinely is about reconciling a *parameter* value across a schema change (workflow edges, plan 99 §3.9's own note), not something plan 97 repurposed for results.

**A result schema is published with `io: 'output'`; a params schema with `io: 'input'` — two separate call sites in `enkaku publish`, not a shared conversion helper.** A `params` schema describes what a person is about to type, so a `.default()` field must stay optional in the generated form (`io: 'input'`). A `result` schema describes a value already produced — every default already applied by the time `run()` returns — so the same field is correctly `required` in `io: 'output'`. Measured, not assumed: `z.boolean().default(false)` is `required` in one mode and absent from `required` in the other, against this workspace's own installed Zod.

## The command console and bulk operations — wire shapes (plan 93, M58)

`packages/core/README.md`'s own "The command console and bulk operations"
section documents the executor and the runner; this package owns the
shapes both sides of the wire agree on. **93.11 (Studio's bulk-operations
UI) is not built yet** — the shapes below exist and are exercised by
`packages/core`'s routes and tests, but no Studio component under
`components/bulk/` reads them.

| Export | Where | What it is |
|---|---|---|
| `isHighConsequence(cmd)`, `HighConsequencePattern` | `command/high-consequence.ts` | The same pattern set `TerminalPane.tsx` always used, moved here so both the single-device terminal and the fan-out REST route (`api/command-runs.ts`) share one list. Advisory only — see below. |
| `CommandTargetSchema`, `CommandMemberStatusSchema`, `CommandRunStatusSchema`, `CommandMemberSchema`, `CommandOutputSchema`, `CommandCountsSchema` | `command/target.ts` | A run's target (`{ deviceIds }` \| `{ tags }` \| `{ clusterId }`), a member's status (`pending`\|`running`\|`ok`\|`failed`\|`skipped`\|`cancelled`), a run's own status (adds `awaiting-continue`, plus `skipped` as a first-class non-failure outcome — a run that is all `ok`/`skipped` is `ok`), the wire shape of one member row, one distinct-output preview, and the tallied counts a `command.progress` frame carries. |
| `SavedCommandSchema`, `SavedCommandListResponseSchema`, `SavedCommandResponseSchema`, `SavedCommandDeleteResponseSchema` | `command/saved.ts` | `GET/POST/PATCH/DELETE /api/saved-commands[/:id]`'s wire shapes. No `dangerous` field — see `packages/core/README.md`'s note on why. |
| Five `command.*` server→client messages (`command.started`/`.progress`/`.output`/`.stage`/`.finished`) plus `command.subscribe`/`command.unsubscribe` client→server | `messages/command.ts`, appended to `ServerMessage`/`ClientMessage` in `index.ts` | The live surface. Subscriber-scoped by construction (`command.subscribe` names a `runId`) — a client watching one run never receives another's traffic, and `command.progress` is coalesced to at most one frame per 250ms carrying only that tick's deltas, never one frame per member. `POST /api/command-runs` (`api/command-runs.ts`, in `packages/core`) is the only way a run is ever started; these messages carry no way to start one. |
| `PushJobParamsSchema`, `PullJobParamsSchema` | `messages/transfer.ts` | The two new `internal:push`/`internal:pull` job executors' params (step 93.9) — `{ artifactId, remotePath, mediaScan? }` and `{ remotePath }`, siblings of the existing install job's own params. |
| `commandConsole` on `AdbStatsResponseSchema` | `api/adb.ts` | `GET /api/adb/stats`'s measurement block for H1/H2/H4 — `runsInFlight`, `membersInFlight`, `coalescedFramesPerSec`, `distinctOutputRatio`, `leaseChangedPerMinute`. `.optional()` on the wire, same convention as `input`/`video` beside it; the real core always sends it, zero-filled until `daemon.ts` wires the dependency (see `packages/core/README.md`'s note). |

**The high-consequence guard is advisory, and says so wherever it appears.**
`isHighConsequence` never blocks anything by itself — it names what a
command matched (`{ hit, pattern }`) so the REST layer can require an
explicit `acknowledged: true` once the target has more than one device.
Plan 26 §3.4 settled this for the single-device terminal already: a
command allowlist/denylist is not a real security control (`sh -c`, a
backtick, or an alias defeats any parser), so this package never pretends
otherwise — the acknowledgement is an audit fact ("someone typed the exact
device count and meant it"), never an authorisation decision.

## Workflows — the document, the grammar, and the rule that matters most (plan 99, M64)

A **workflow** is a pipeline: an ordered list of **nodes**, each an ordinary published script reference, plus optional **gates** that branch on values the pipeline already has. It runs as one job, on one device, under one lease — see `packages/core/README.md`'s own Workflows section for the executor and the runtime side. This package owns the document shape, the two closed grammars a node can use, and the checks that make a document publishable.

### The document — `workflow.ts`

```ts
import { WorkflowDocSchema } from '@enkaku/protocol'

const doc = WorkflowDocSchema.parse({
  schema: 1,
  name: 'tiktok-warmup-and-search',
  version: '1.0.0',
  params: [{ name: 'keyword', type: 'string', required: true, title: 'Search keyword' }],
  maxSteps: 50,
  nodes: [
    { kind: 'script', id: 'scroll1', script: 'tiktok/auto-scroll@1.4.0', params: { videos: { const: 15 } } },
    { kind: 'script', id: 'search1', script: 'tiktok/searched-follow@1.4.0', params: { keyword: { param: 'keyword' } } },
    { kind: 'gate', id: 'enough', when: { left: { from: 'scroll1', path: 'videos' }, op: 'gte', right: { const: 10 } },
      then: { go: 'continue' }, else: { go: 'stop' } },
    { kind: 'script', id: 'report1', script: 'tiktok/report@1.0.0', params: { summary: { run: 'summary' } } },
  ],
})
```

A node's `id` must be unique in the document; array order is the pipeline's default spine, and a node's own `next` (or a gate's `then`/`else`) is the only way to name a different successor — reordering the array can therefore never silently rewire an explicit branch, because a branch names a node id, not a position. `maxSteps` (default 50, max 500) bounds node *executions*, not node count — a backward `goto` loop is legal and is what this budget is for.

Everything here is `.strict()` Zod: an unrecognised field on a node, a gate, or the document itself is a parse error, not a value silently dropped.

### The value grammar — a lookup, not a language

A node's `params` is a map from parameter name to a **value expression**. There are exactly four, and no fifth is ever added without a plan:

```ts
{ const: <json> }                        // a literal
{ param: 'keyword' }                     // a declared WORKFLOW parameter
{ from: 'scroll1', path?: 'videos' }     // an earlier node's output, whole or by path
{ run: 'summary' }                       // one entry per completed node: { nodeId, script, status, ..., output }
```

`{ from }`'s `path` is a **dotted path of identifier segments and non-negative integer indices only** — `videos`, `byLabel.long`, `matches.0.author`. No wildcards, no filters, no arithmetic, no string interpolation. It is checked against one regex (`WorkflowPathSchema`) at parse time and resolved by one total function (`resolveValue`, in `workflow-resolve.ts`) — never evaluated as code, because a path is data, not a program.

### The predicate grammar — a decision, not a program

A gate's `when` is a closed predicate, built from the same four value expressions:

```ts
{ left: ValueExpr, op: Op, right?: ValueExpr }
{ all: [Predicate, ...] } | { any: [Predicate, ...] } | { not: Predicate }
```

`Op` is closed (`GATE_OPS`): `eq | ne | lt | lte | gt | gte | contains | notContains | startsWith | endsWith | exists | notExists | isEmpty | notEmpty | length`. Depth ≤ 3, ≤ 20 leaves. `evaluatePredicate` (`workflow-resolve.ts`) is total — every operator against `undefined`/`null`/`NaN`/an empty array/a type mismatch returns a boolean, never throws — and returns a `PredicateTrace` (the resolved left/right values, the operator, the outcome, and each child's own trace for `all`/`any`/`not`) so a branch is auditable after the fact: *`scroll1.videos (12) >= 10 → continue`* is built from a trace, not reconstructed from a guess.

### The rule that matters most: neither grammar ever evaluates author-supplied code

**A value expression is a lookup. A predicate is a comparison. Neither is a program, and nothing in this package ever compiles, `eval`s, or pattern-matches a string an author wrote as if it were code.** There is no expression language here, no template syntax, no regular expression evaluated against untrusted input (the same doctrine plan 95's parameter validator already applies: `packages/protocol/src/params/validate.ts` never compiles an author's `pattern`, for the same reason — JavaScript offers no way to bound a match, so an unbounded one is a hang waiting to happen). `checkWorkflow` and `resolveValue`/`evaluatePredicate` are pure, total functions over closed, Zod-validated shapes; there is no parser, no sandbox, no timeout to configure, no security review to redo, because there is no execution surface to secure in the first place.

**If you find yourself wanting to write an expression in a gate — `videos / minutes > 2`, a string transform, a date computation — stop.** It will not parse, and it is not a bug that it does not. The answer is not a bigger grammar; it is a **script node that returns a verdict**, read by an ordinary gate:

```ts
{ kind: 'script', id: 'check-quality', script: 'tiktok/quality-check@1.0.0' },
{ kind: 'gate', id: 'enough', when: { left: { from: 'check-quality', path: 'ok' }, op: 'eq', right: { const: true } },
  then: { go: 'continue' }, else: { go: 'stop' } },
```

That script gets crash containment, versioning, its own parameters and generated form, its own timeout and retries, its own artifacts — for free, because it is an ordinary script (`@enkaku/sdk`'s `defineScript`) rather than a new thing to trust. The predicate grammar's job is to stay small; the escape hatch is the language that already exists.

### Static checking — `workflow-check.ts`

`checkWorkflow(doc, resolved, budget?)` is pure and database-free — it never queries anything; the caller resolves every node's script reference first and hands in what it found. It returns **every** finding, never just the first (`WorkflowFinding[]`, each `{ path, code, message, severity }`), so an author fixing a workflow gets one list, not one error per round trip. This is the same function Studio's Validate button and the core's publish route both call, so they can never disagree about whether a document is valid.

It checks, among other things: every node id is unique and every `goto`/`next` target exists; a binding can only read a node that runs *earlier*, computed over the transition graph (so a binding is refused even when a backward `goto` makes the reachability non-positional); a `{ param }` names a declared, type-compatible workflow parameter; a `{ from, path }` against a script that declares an output schema is checked against that schema, degrading to a warning when the producing script declares none (most scripts, today); no node's script is itself a workflow (nested workflows are refused); every node is reachable; and, when a `budget` is supplied, the worst-case timeout sum over an acyclic document against `workflow.maxTotalMs` — an undeclared node timeout makes that sum *unknown*, not zero, reported as a warning naming the responsible nodes rather than silently passing or silently refusing on a number nobody declared.

### Workflow parameters — `workflow-params.ts`

`compileWorkflowParams(params)` turns a workflow's own parameter declarations (plan 95's `ParamHints` vocabulary, reused verbatim) into the exact JSON Schema `z.toJSONSchema(<the equivalent Zod object>, { io: 'input' })` would produce — asserted by a test that builds both and deep-compares. This is the one place a workflow "compiles": to a schema, never to code, so the run dialog, the schedule editor, and the parameter form all work with no code written for workflows at all.
