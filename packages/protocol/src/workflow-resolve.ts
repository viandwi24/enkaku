import { evaluate, ExprEvalError, ExprParseError, parse, toScopeValue, type ExprScope } from '@enkaku/expr'
import type { GateOp, Predicate, ValueExpr } from './workflow'
import { WORKFLOW_LIMITS } from './workflow'

/**
 * One completed node's summary entry (plan 99 §3.6) — what `{ run: 'summary' }`
 * resolves to: a bounded, typed array, one entry per node that has run so
 * far, for a Report-style node that wants everything rather than one earlier
 * node by name. `script` is `null` for a gate (a gate has no script; it still
 * belongs in the summary, since "which gates fired and how" is part of the
 * pipeline's story).
 */
export interface RunSummaryEntry {
  nodeId: string
  script: string | null
  status: string
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  output: unknown
}

/**
 * Everything `resolveValue`/`evaluatePredicate` may read (plan 99 §4.4).
 * `outputs` maps a node id to the output of its LAST completed run — a loop
 * re-running a node overwrites the earlier entry, which is correct: a
 * binding reads "what that node most recently returned", not a history.
 */
export interface ResolveScope {
  params: Record<string, unknown>
  outputs: ReadonlyMap<string, unknown>
  summary: readonly RunSummaryEntry[]
  /**
   * The step's start time, for an `{ expr }` binding's `$now` (plan 302
   * §3.3, §4.7) — an explicit value the CALLER supplies, never read from the
   * host clock by the evaluator itself. Defaults to `Date.now()` when
   * absent, which only ever happens in a test that does not care.
   */
  now?: number
  /**
   * An `{ expr }` binding's `$random` (plan 302 §3.3). Plan 304 §4.1 is
   * where a per-run seed is meant to live; until that column exists, every
   * caller passes (or omits, defaulting to) a fixed `0` — deterministic,
   * reproducible on replay, and honestly not yet a real seed (see plan 302
   * §11's handoff for the record of this deferral).
   */
  randomSeed?: number
  /**
   * This run's position in its batch, 0-based, and how many runs the batch
   * holds — `$run.index` and `$run.count`.
   *
   * The one fact a workflow needs to divide a fleet into equal shares and
   * could not see. `$random` splits twenty devices into four branches at
   * roughly five each, which is a different promise from five each: measured
   * over a thousand batches of twenty, a single batch lands 5/5/5/5 about 1%
   * of the time, and 8/2/6/4 is ordinary. An exact share cannot come from
   * twenty independent draws — it has to be decided once, for the batch, and
   * `jobs.batchSeq` already decides it at dispatch. This is what lets an
   * expression read the decision: `$run.index % 4` is exactly five per branch,
   * every time, and `createWorkflowBatch`'s `order: 'random'` is what makes
   * WHICH device lands where random rather than fixed.
   *
   * Absent for a run with no batch — a single manual run is index 0 of 1.
   */
  runIndex?: number
  runCount?: number
}

/**
 * The result of resolving one `ValueExpr` (plan 99 §4.4). `'no_such_node'`
 * names a `{ from }` referencing a node with no recorded output at all — the
 * node never ran in this scope, which is a DIFFERENT, more specific reason
 * than `'unresolved'` (the node ran, but the requested `path` did not resolve
 * inside what it returned, or a `{ param }` named a workflow parameter that
 * was never supplied). `sawKeys` is populated only for the latter, and only
 * when the failed value was itself an object or array — the top-level keys
 * (or indices) the output actually had, truncated to
 * `WORKFLOW_LIMITS.maxSawKeys`, so the failure names what WAS there instead
 * of only what was missing (plan 99 §3.6).
 */
export type ResolveOutcome = { ok: true; value: unknown } | { ok: false; code: 'unresolved' | 'no_such_node'; detail: string; sawKeys?: string[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The top-level keys (or, for an array, string indices) `value` exposes — `undefined` for a primitive, which has none. Truncated to `WORKFLOW_LIMITS.maxSawKeys` (plan 99 §3.6). */
function topLevelKeys(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((_, i) => String(i)).slice(0, WORKFLOW_LIMITS.maxSawKeys)
  if (isPlainObject(value)) return Object.keys(value).slice(0, WORKFLOW_LIMITS.maxSawKeys)
  return undefined
}

/**
 * Walks `path` (already publish-time validated by `WorkflowPathSchema` — a
 * dotted run of identifier segments and non-negative integer indices, never
 * evaluated as code) against `root`. TOTAL: `null`/`undefined`/`NaN`
 * mid-walk, an out-of-range or non-numeric array index, and a property that
 * simply is not there all resolve to "not found" rather than throwing —
 * there is no `[]`/`.` access in this function that is not guarded first.
 */
function resolvePath(root: unknown, path: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (path === undefined || path === '') return { ok: true, value: root }
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return { ok: false }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { ok: false }
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index >= current.length) return { ok: false }
      current = current[index]
      continue
    }
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return { ok: false }
    current = current[segment]
  }
  return { ok: true, value: current }
}

/** `{ from, optional: true }`'s fallback (plan 99 §3.6) — `undefined` when there is no `default`, which is exactly what "optional, no default" should yield. */
function optionalFallback(expr: Extract<ValueExpr, { from: string }>): ResolveOutcome | undefined {
  return expr.optional ? { ok: true, value: expr.default } : undefined
}

/**
 * Memoises the `ExprScope` built for one `ResolveScope` OBJECT (plan 302
 * §4.7): "build the scope once per step, not once per binding". Every call
 * site in this repo builds exactly one `ResolveScope` per step and reuses
 * it for every binding that step resolves
 * (`packages/core/src/jobs/executors/workflow.ts`'s three `scope`
 * constructions), so keying the cache on the `ResolveScope` object's own
 * identity — a `WeakMap`, so a scope that goes out of scope is not held —
 * is exactly "once per step" without threading a separate cache handle
 * through every call site.
 */
const exprScopeCache = new WeakMap<ResolveScope, ExprScope>()

/**
 * Builds the `ExprScope` an `{ expr }` binding evaluates against (plan 302
 * §3.3, §4.7): `$params`/`$nodes`/`$run` are the SAME `outputs`/`params`/
 * `summary` every other `ValueExpr` form already reads, copied through
 * `toScopeValue` so nothing with a live prototype ever reaches the
 * evaluator. `$input` is the last node the cursor actually passed through —
 * under plan 300 D5's single cursor that is always exactly one node, so the
 * last `summary` entry (plan 302 §9 Q2) — `undefined` for the very first
 * node, whose predecessor is `start` and produced nothing. `$now`/`$random`
 * are the two purity escape valves (plan 302 §3.3): the caller supplies
 * them via `scope.now`/`scope.randomSeed`, never read from the host clock
 * or an entropy source here; `$random` is a fixed `0` until plan 304 §4.1
 * gives a run its own seed column (see `ResolveScope.randomSeed`'s own doc
 * comment).
 */
function buildExprScope(scope: ResolveScope): ExprScope {
  const cached = exprScopeCache.get(scope)
  if (cached) return cached
  const lastOutput = scope.summary.length > 0 ? scope.summary[scope.summary.length - 1]?.output : undefined
  const built: ExprScope = {
    $params: toScopeValue(scope.params) as Readonly<Record<string, unknown>>,
    $nodes: toScopeValue(Object.fromEntries(scope.outputs)) as Readonly<Record<string, unknown>>,
    $input: toScopeValue(lastOutput),
    $run: { summary: toScopeValue(scope.summary), index: scope.runIndex ?? 0, count: scope.runCount ?? 1 },
    $now: scope.now ?? Date.now(),
    $random: scope.randomSeed ?? 0,
  }
  exprScopeCache.set(scope, built)
  return built
}

/**
 * Resolves one `ValueExpr` against `scope` (plan 99 §4.4, plan 302 §4.7).
 * TOTAL — every branch below returns a `ResolveOutcome`; none of them
 * throws, on any input, including a `from` node that never ran, a `path`
 * that runs into `null`, a workflow parameter that was declared but never
 * supplied, or an `{ expr }` that fails to parse or to evaluate (the
 * `@enkaku/expr` error is caught here and turned into an `'unresolved'`
 * outcome, exactly as an unresolvable `{ from }` binding already is —
 * `checkWorkflow`'s `E_WORKFLOW_EXPR_PARSE`/`E_WORKFLOW_EXPR_UNKNOWN_NODE`
 * are the publish-time backstop; this run-time catch is what keeps a
 * document that somehow reached the executor unchecked from throwing
 * instead of failing the step with a named reason).
 */
export function resolveValue(expr: ValueExpr, scope: ResolveScope): ResolveOutcome {
  if ('const' in expr) return { ok: true, value: expr.const }

  if ('run' in expr) return { ok: true, value: scope.summary }

  if ('expr' in expr) {
    try {
      const ast = parse(expr.expr)
      const value = evaluate(ast, buildExprScope(scope))
      return { ok: true, value }
    } catch (err) {
      const offset = err instanceof ExprParseError || err instanceof ExprEvalError ? ` (offset ${err.offset})` : ''
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, code: 'unresolved', detail: `expression "${expr.expr}" failed: ${detail}${offset}` }
    }
  }

  if ('param' in expr) {
    if (Object.prototype.hasOwnProperty.call(scope.params, expr.param)) {
      return { ok: true, value: scope.params[expr.param] }
    }
    return { ok: false, code: 'unresolved', detail: `workflow parameter "${expr.param}" was not supplied` }
  }

  // The `from` variant — an earlier node's output, whole or one path into it.
  if (!scope.outputs.has(expr.from)) {
    return (
      optionalFallback(expr) ?? {
        ok: false,
        code: 'no_such_node',
        detail: `node "${expr.from}" has not run — there is no recorded output for it in this workflow`,
      }
    )
  }
  const output = scope.outputs.get(expr.from)
  const resolved = resolvePath(output, expr.path)
  if (resolved.ok) return { ok: true, value: resolved.value }
  return (
    optionalFallback(expr) ?? {
      ok: false,
      code: 'unresolved',
      detail: `path "${expr.path ?? ''}" did not resolve on node "${expr.from}"'s output`,
      sawKeys: topLevelKeys(output),
    }
  )
}

/** `undefined`/`null` count as "does not exist"; everything else (including `0`, `false`, `NaN`, `''`) counts as existing. */
function existsAsValue(outcome: ResolveOutcome): boolean {
  return outcome.ok && outcome.value !== undefined && outcome.value !== null
}

/** A string of length 0, an array of length 0, an object with no own keys, or a missing/null/undefined value all count as empty. A number or boolean is never empty. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

/** Structural equality, total and depth-bounded (never hangs on a pathological value — real node outputs are JSON, which cannot cycle, but nothing here assumes that). `NaN` never equals anything, including itself, matching JS's own semantics. */
function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b // false for NaN vs NaN too — `===` already gives us that
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i], depth + 1))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    return aKeys.length === bKeys.length && aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k], depth + 1))
  }
  return false
}

/** `contains`: substring on a string, membership on an array. Any other shape (or a string/array mismatch on either side) is `false`, never a throw. */
function containsValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'string') return typeof right === 'string' && left.includes(right)
  if (Array.isArray(left)) return left.some((item) => deepEqual(item, right))
  return false
}

/** `length`: LEFT's length (string or array) compared for EQUALITY against RIGHT (a number) — the one length-based operator in the closed set (§3.7); `path` has no `.length` accessor of its own (arrays only admit numeric index segments, plan 99 §3.6), which is why this exists as its own operator. */
function lengthEquals(left: unknown, right: unknown): boolean {
  const length = typeof left === 'string' || Array.isArray(left) ? left.length : undefined
  return length !== undefined && typeof right === 'number' && Number.isFinite(right) && length === right
}

/** `lt`/`lte`/`gt`/`gte`: strictly numeric on both sides. A string, `NaN`, or any other shape makes the comparison `false` rather than throwing or coercing. */
function numericCompare(op: 'lt' | 'lte' | 'gt' | 'gte', left: unknown, right: unknown): boolean {
  if (typeof left !== 'number' || typeof right !== 'number' || Number.isNaN(left) || Number.isNaN(right)) return false
  switch (op) {
    case 'lt':
      return left < right
    case 'lte':
      return left <= right
    case 'gt':
      return left > right
    case 'gte':
      return left >= right
  }
}

/** What a leaf comparison looked at and decided (plan 99 §3.7, §4.4) — the row `job_nodes.verdict` stores and the job detail page's one-sentence rendering (`scroll1.videos (12) >= 10 → continue`) is built from. */
export interface PredicateTrace {
  op: GateOp | 'all' | 'any' | 'not'
  left?: unknown
  right?: unknown
  /** Set when `left` could not be resolved — WHY, in words (plan 99 §3.7: "a predicate over a node that never ran is `false` with a named reason, not an exception"). */
  leftUnresolved?: string
  /** Same, for `right`, on a binary op. */
  rightUnresolved?: string
  value: boolean
  /** Present only for `all`/`any`/`not` — the child traces that produced `value`. */
  children?: PredicateTrace[]
}

/** Evaluates one leaf `{ left, op, right? }` — never a compound predicate. */
function evaluateLeaf(pred: Extract<Predicate, { left: ValueExpr }>, scope: ResolveScope): PredicateTrace {
  const leftOutcome = resolveValue(pred.left, scope)
  const rightOutcome = pred.right !== undefined ? resolveValue(pred.right, scope) : undefined
  const leftValue = leftOutcome.ok ? leftOutcome.value : undefined
  const rightValue = rightOutcome?.ok ? rightOutcome.value : undefined
  const bothOk = leftOutcome.ok && (rightOutcome === undefined || rightOutcome.ok)

  let value: boolean
  switch (pred.op) {
    case 'exists':
      value = existsAsValue(leftOutcome)
      break
    case 'notExists':
      value = !existsAsValue(leftOutcome)
      break
    case 'isEmpty':
      // The "only sane reading" of an unresolved LEFT (plan 99 §4.4): nothing there reads as empty.
      value = !leftOutcome.ok || isEmptyValue(leftValue)
      break
    case 'notEmpty':
      value = leftOutcome.ok && !isEmptyValue(leftValue)
      break
    case 'eq':
      value = bothOk && deepEqual(leftValue, rightValue)
      break
    case 'ne':
      value = bothOk && !deepEqual(leftValue, rightValue)
      break
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      value = bothOk && numericCompare(pred.op, leftValue, rightValue)
      break
    case 'contains':
      value = bothOk && containsValue(leftValue, rightValue)
      break
    case 'notContains':
      value = bothOk && !containsValue(leftValue, rightValue)
      break
    case 'startsWith':
      value = bothOk && typeof leftValue === 'string' && typeof rightValue === 'string' && leftValue.startsWith(rightValue)
      break
    case 'endsWith':
      value = bothOk && typeof leftValue === 'string' && typeof rightValue === 'string' && leftValue.endsWith(rightValue)
      break
    case 'length':
      value = bothOk && lengthEquals(leftValue, rightValue)
      break
  }

  return {
    op: pred.op,
    left: leftOutcome.ok ? leftOutcome.value : undefined,
    right: rightOutcome?.ok ? rightOutcome.value : undefined,
    leftUnresolved: leftOutcome.ok ? undefined : leftOutcome.detail,
    rightUnresolved: rightOutcome && !rightOutcome.ok ? rightOutcome.detail : undefined,
    value,
  }
}

/**
 * Evaluates a predicate against `scope` and returns both the verdict and a
 * trace of what it compared (plan 99 §3.7, §4.4). TOTAL: an operand that
 * cannot be resolved — including `{ from }` naming a node that never ran —
 * never throws; it makes the leaf `false` (`exists`/binary comparisons) or
 * `true` (`notExists`/`isEmpty`, the "only sane reading" of nothing being
 * there), and the trace names WHY via `leftUnresolved`/`rightUnresolved`.
 */
export function evaluatePredicate(pred: Predicate, scope: ResolveScope): { value: boolean; trace: PredicateTrace } {
  if ('all' in pred) {
    const results = pred.all.map((p) => evaluatePredicate(p, scope))
    const value = results.every((r) => r.value)
    return { value, trace: { op: 'all', value, children: results.map((r) => r.trace) } }
  }
  if ('any' in pred) {
    const results = pred.any.map((p) => evaluatePredicate(p, scope))
    const value = results.some((r) => r.value)
    return { value, trace: { op: 'any', value, children: results.map((r) => r.trace) } }
  }
  if ('not' in pred) {
    const result = evaluatePredicate(pred.not, scope)
    const value = !result.value
    return { value, trace: { op: 'not', value, children: [result.trace] } }
  }
  const trace = evaluateLeaf(pred, scope)
  return { value: trace.value, trace }
}
