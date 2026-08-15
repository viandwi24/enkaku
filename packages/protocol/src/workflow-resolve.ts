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
 * Resolves one `ValueExpr` against `scope` (plan 99 §4.4). TOTAL — every
 * branch below returns a `ResolveOutcome`; none of them throws, on any input,
 * including a `from` node that never ran, a `path` that runs into `null`, or
 * a workflow parameter that was declared but never supplied.
 */
export function resolveValue(expr: ValueExpr, scope: ResolveScope): ResolveOutcome {
  if ('const' in expr) return { ok: true, value: expr.const }

  if ('run' in expr) return { ok: true, value: scope.summary }

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
