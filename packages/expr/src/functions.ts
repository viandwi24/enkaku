// The closed function table for `@enkaku/expr`. Plan 302 §4.5.
//
// Adding a function here is a code change with a test, never configuration —
// there is no way for a workflow document to register a new one. Every
// implementation is pure: no I/O, no clock, no randomness of its own (`$now`
// and `$random` are scope values injected by the caller, per plan 302 §3.3).

import { EXPR_LIMITS, ExprEvalError, type Fuel } from './ast'

export type ExprFn = (args: unknown[], fuel: Fuel) => unknown

function typeError(msg: string): never {
  throw new ExprEvalError('E_EXPR_TYPE', msg)
}

function limitError(msg: string): never {
  throw new ExprEvalError('E_EXPR_LIMIT', msg)
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

function boundString(s: string): string {
  if (byteLength(s) > EXPR_LIMITS.maxStringBytes) limitError('string result exceeds the size limit')
  return s
}

function boundArray<T>(a: T[]): T[] {
  if (a.length > EXPR_LIMITS.maxArrayLength) limitError('array result exceeds the size limit')
  return a
}

function str(v: unknown, fn: string): string {
  if (typeof v !== 'string') typeError(`${fn}() requires a string`)
  return v
}

function num(v: unknown, fn: string): number {
  if (typeof v !== 'number') typeError(`${fn}() requires a number`)
  return v
}

function arr(v: unknown, fn: string): unknown[] {
  if (!Array.isArray(v)) typeError(`${fn}() requires an array`)
  return v
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function rec(v: unknown, fn: string): Record<string, unknown> {
  if (!isPlainRecord(v)) typeError(`${fn}() requires an object`)
  return v
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.length === 0
  if (Array.isArray(v)) return v.length === 0
  if (isPlainRecord(v)) return Object.keys(v).length === 0
  return false
}

function toJsonSafe(v: unknown, fuel: Fuel): unknown {
  fuel.spend()
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map((x) => toJsonSafe(x, fuel))
  if (isPlainRecord(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) out[k] = toJsonSafe(v[k], fuel)
    return out
  }
  return null
}

/** Parses JSON text into a null-prototype value tree — never a live prototype. */
function fromJsonValue(v: unknown, depth = 0): unknown {
  if (depth > EXPR_LIMITS.maxDepth) return undefined
  if (v === null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.slice(0, EXPR_LIMITS.maxArrayLength).map((x) => fromJsonValue(x, depth + 1))
  if (typeof v === 'object') {
    const out = Object.create(null) as Record<string, unknown>
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = fromJsonValue((v as Record<string, unknown>)[k], depth + 1)
    }
    return out
  }
  return undefined
}

function naturalCompare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  typeError('sort() requires a uniformly typed array of numbers or strings')
}

function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  return typeof v
}

/**
 * The closed gate-operator vocabulary (plan 99 §3.7), moved here from
 * `@enkaku/protocol`'s `workflow.ts` by plan 312 §3.5 so that `filterWhere`
 * (below) can reuse the SAME set a gate/switch predicate already uses —
 * "no second operator vocabulary". `workflow.ts` re-exports both names
 * unchanged, so every existing import of `GATE_OPS`/`GateOp` from that module
 * keeps working; this is the one and only place the list is written down.
 */
export const GATE_OPS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'exists',
  'notExists',
  'isEmpty',
  'notEmpty',
  'length',
] as const
export type GateOp = (typeof GATE_OPS)[number]

/** Bounded structural equality — mirrors `workflow-resolve.ts`'s `deepEqual`, duplicated here (not imported) because `@enkaku/expr` sits BELOW `@enkaku/protocol` in the dependency graph and may never import from it. */
function gateDeepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > EXPR_LIMITS.maxDepth) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => gateDeepEqual(x, b[i], depth + 1))
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && gateDeepEqual(a[k], b[k], depth + 1))
  }
  return false
}

/** Walks a dotted `path` against `root` — segments are identifier-ish or digits-only (an array index); total, never throws. Spends one fuel unit per segment, matching `get()`'s own walk above. */
function pathWalk(root: unknown, path: string, fuel: Fuel): { found: boolean; value: unknown } {
  // An empty path means the element ITSELF.
  //
  // It used to mean nothing usable: `''.split('.')` is `['']`, and no value
  // has a field called `""` — an object failed `Object.hasOwn`, an array
  // failed the digits test, a scalar failed the `typeof` guard. So
  // `filterWhere(list, '', 'ne', x)` — the only way to filter a list of
  // plain strings or numbers, since there is no other way to name the
  // element — returned an empty list for every input. Found while writing a
  // workflow that draws one script at a time out of a pool of names and
  // removes the one it drew (owner, 2026-09-05): the pool emptied on the
  // first pass and the loop ran exactly one script.
  //
  // Nothing relied on the old answer, because the old answer was always
  // "not found".
  if (path === '') return { found: true, value: root }
  let cur: unknown = root
  for (const segment of path.split('.')) {
    fuel.spend()
    if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false, value: undefined }
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(segment)) return { found: false, value: undefined }
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index >= cur.length) return { found: false, value: undefined }
      cur = cur[index]
      continue
    }
    if (!Object.hasOwn(cur, segment)) return { found: false, value: undefined }
    cur = (cur as Record<string, unknown>)[segment]
  }
  return { found: true, value: cur }
}

/** One `GATE_OPS` comparison — the same semantics `workflow-resolve.ts`'s `evaluateLeaf` gives a gate, minus the trace (`filterWhere` needs only the verdict). `found` distinguishes "the path resolved to null/undefined" from "the path did not resolve at all", exactly as a gate's own `ResolveOutcome` does. */
function gateCompare(op: GateOp, found: boolean, left: unknown, right: unknown): boolean {
  const exists = found && left !== null && left !== undefined
  switch (op) {
    case 'exists':
      return exists
    case 'notExists':
      return !exists
    case 'isEmpty':
      return !found || isEmptyValue(left)
    case 'notEmpty':
      return found && !isEmptyValue(left)
    case 'eq':
      return found && gateDeepEqual(left, right)
    case 'ne':
      return found && !gateDeepEqual(left, right)
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      if (!found || typeof left !== 'number' || typeof right !== 'number' || Number.isNaN(left) || Number.isNaN(right)) return false
      return op === 'lt' ? left < right : op === 'lte' ? left <= right : op === 'gt' ? left > right : left >= right
    case 'contains':
      if (!found) return false
      if (typeof left === 'string') return typeof right === 'string' && left.includes(right)
      if (Array.isArray(left)) return left.some((x) => gateDeepEqual(x, right))
      return false
    case 'notContains':
      return !gateCompare('contains', found, left, right)
    case 'startsWith':
      return found && typeof left === 'string' && typeof right === 'string' && left.startsWith(right)
    case 'endsWith':
      return found && typeof left === 'string' && typeof right === 'string' && left.endsWith(right)
    case 'length': {
      if (!found) return false
      const len = typeof left === 'string' || Array.isArray(left) ? left.length : undefined
      return len !== undefined && typeof right === 'number' && Number.isFinite(right) && len === right
    }
  }
}

export const FUNCTIONS: Record<string, ExprFn> = {
  // text
  len: ([v], fuel) => {
    fuel.spend()
    if (typeof v === 'string') return v.length
    return arr(v, 'len').length
  },
  lower: ([v]) => str(v, 'lower').toLowerCase(),
  upper: ([v]) => str(v, 'upper').toUpperCase(),
  trim: ([v]) => str(v, 'trim').trim(),
  contains: ([v, needle], fuel) => {
    fuel.spend()
    if (typeof v === 'string') return v.includes(str(needle, 'contains'))
    return arr(v, 'contains').some((x) => x === needle)
  },
  startsWith: ([v, needle]) => str(v, 'startsWith').startsWith(str(needle, 'startsWith')),
  endsWith: ([v, needle]) => str(v, 'endsWith').endsWith(str(needle, 'endsWith')),
  split: ([v, sep], fuel) => boundArray(str(v, 'split').split(str(sep, 'split'))).map((s) => (fuel.spend(), s)),
  join: ([v, sep], fuel) => boundString(arr(v, 'join').map((x) => (fuel.spend(), String(x))).join(str(sep, 'join'))),
  replace: ([v, find, to]) => boundString(str(v, 'replace').split(str(find, 'replace')).join(str(to, 'replace'))),
  slice: ([v, start, end]) => {
    if (typeof v === 'string') return v.slice(num(start, 'slice'), end === undefined ? undefined : num(end, 'slice'))
    return boundArray(arr(v, 'slice').slice(num(start, 'slice'), end === undefined ? undefined : num(end, 'slice')))
  },
  padStart: ([v, len, pad]) => boundString(str(v, 'padStart').padStart(num(len, 'padStart'), pad === undefined ? ' ' : str(pad, 'padStart'))),
  padEnd: ([v, len, pad]) => boundString(str(v, 'padEnd').padEnd(num(len, 'padEnd'), pad === undefined ? ' ' : str(pad, 'padEnd'))),

  // number
  abs: ([v]) => Math.abs(num(v, 'abs')),
  floor: ([v]) => Math.floor(num(v, 'floor')),
  ceil: ([v]) => Math.ceil(num(v, 'ceil')),
  round: ([v]) => Math.round(num(v, 'round')),
  min: (args) => Math.min(...args.map((v) => num(v, 'min'))),
  max: (args) => Math.max(...args.map((v) => num(v, 'max'))),
  clamp: ([v, lo, hi]) => Math.min(Math.max(num(v, 'clamp'), num(lo, 'clamp')), num(hi, 'clamp')),
  toNumber: ([v]) => {
    if (typeof v === 'number') return v
    const n = Number(str(v, 'toNumber'))
    if (Number.isNaN(n)) typeError('toNumber() could not parse a number')
    return n
  },

  // array
  first: ([v]) => arr(v, 'first')[0],
  last: ([v]) => { const a = arr(v, 'last'); return a[a.length - 1] },
  at: ([v, i]) => arr(v, 'at')[num(i, 'at')],
  unique: ([v], fuel) => boundArray(Array.from(new Set(arr(v, 'unique').map((x) => (fuel.spend(), x))))),
  sort: ([v], fuel) => boundArray([...arr(v, 'sort')].sort((a, b) => (fuel.spend(), naturalCompare(a, b)))),
  reverse: ([v]) => [...arr(v, 'reverse')].reverse(),
  count: ([v], fuel) => { fuel.spend(); return arr(v, 'count').length },

  // object
  has: ([o, k]) => Object.hasOwn(rec(o, 'has'), str(k, 'has')),
  keys: ([o]) => boundArray(Object.keys(rec(o, 'keys'))),
  get: ([o, path, def], fuel) => {
    let cur: unknown = o
    for (const key of str(path, 'get').split('.')) {
      fuel.spend()
      if (cur === null || cur === undefined || typeof cur !== 'object') return def
      if (!Object.hasOwn(cur, key)) return def
      cur = (cur as Record<string, unknown>)[key]
    }
    return cur === undefined ? def : cur
  },

  // value
  default: ([v, d]) => (v === undefined || v === null ? d : v),
  coalesce: (args) => {
    for (const v of args) if (v !== undefined && v !== null) return v
    return null
  },
  isEmpty: ([v]) => isEmptyValue(v),
  notEmpty: ([v]) => !isEmptyValue(v),
  toText: ([v]) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v)),
  toJson: ([v], fuel) => boundString(JSON.stringify(toJsonSafe(v, fuel))),
  fromJson: ([v]) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(str(v, 'fromJson'))
    } catch {
      typeError('fromJson() could not parse JSON')
    }
    return fromJsonValue(parsed)
  },
  type: ([v]) => typeName(v),

  // array paths (plan 312 §3.5) — per-element work without a lambda.
  /** `pluck(array, "dotted.path")` — the value at that path in each element (`map(i => i.path)` without the binding). A missing path yields `undefined` for that element, exactly as `get()` with no default would. */
  pluck: ([v, path], fuel) => {
    const array = boundArray(arr(v, 'pluck'))
    const p = str(path, 'pluck')
    return array.map((el) => {
      fuel.spend()
      return pathWalk(el, p, fuel).value
    })
  },
  /** `filterWhere(array, "dotted.path", op, value)` — the elements whose path satisfies `op` against `value`, using the SAME closed `GATE_OPS` a gate/switch predicate already evaluates. */
  filterWhere: ([v, path, op, value], fuel) => {
    const array = boundArray(arr(v, 'filterWhere'))
    const p = str(path, 'filterWhere')
    const opName = str(op, 'filterWhere')
    if (!(GATE_OPS as readonly string[]).includes(opName)) {
      typeError(`filterWhere() op must be one of: ${GATE_OPS.join(', ')} — got "${opName}"`)
    }
    return boundArray(
      array.filter((el) => {
        fuel.spend()
        const { found, value: leftValue } = pathWalk(el, p, fuel)
        return gateCompare(opName as GateOp, found, leftValue, value)
      }),
    )
  },
}

/**
 * Functions that read the SCOPE rather than only their arguments — the two
 * values a pure evaluator cannot invent for itself.
 *
 * They exist because `$random` and `$now` are unguessable. Everyone who
 * writes automation knows `Math.random()`; nobody arrives knowing that this
 * language hands you a pre-drawn number under a dollar sign, and there is
 * nowhere they could have learnt it (the owner's own question, 2026-09-05:
 * "lah kalau $random ini darimana user belajarnya?"). `rand()` and `now()`
 * are the names people already have.
 *
 * What they are NOT is `Math.random()`, and the difference is deliberate:
 * both return the SAME value every time they are called within one step.
 * That is what lets the Timeline replay a finished run and light the branch
 * that actually fired, instead of drawing a new number and showing a path
 * the device never took. It is also what makes a draw and the decision based
 * on it agree — a workflow that picks an item and then removes the one it
 * picked would otherwise remove a different one, silently.
 *
 * A fresh number per step, not per run: step 3 and step 6 differ.
 */
export interface ScopeFnScope {
  $random: number
  $now: number
  /** Draws taken so far in THIS step — see `rand()`. Mutable on purpose; one counter per step, shared by every expression the step evaluates. */
  draws: { n: number }
}

export type ScopeFn = (args: unknown[], scope: ScopeFnScope, fuel: Fuel) => unknown

/**
 * A fresh draw, derived rather than generated.
 *
 * `rand()` behaves the way `Math.random()` behaves — call it twice, get two
 * different numbers — while staying reproducible, because the Nth draw of a
 * step is a pure function of that step's own `$random` and N. The evaluator
 * walks an expression in a fixed order, so the Nth call is always the same
 * call, and a replay of a finished run re-derives exactly the numbers it ran
 * with. That is the "cache it behind the scenes" the owner asked for
 * (2026-09-05): the shape a user expects on the surface, determinism
 * underneath, no host entropy anywhere.
 */
function nextDraw(scope: ScopeFnScope): number {
  const i = scope.draws.n++
  // Fold the step's own draw into a 32-bit state with the call index. The
  // multiplier is the same odd constant `deriveRandom` uses, for the same
  // reason: nearby indices must not produce visibly related output.
  const state = (Math.imul(Math.floor(scope.$random * 4294967296) | 0, 0x9e3779b1) ^ (i | 0)) | 0
  let t = (state + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const SCOPE_FUNCTIONS: Record<string, ScopeFn> = {
  /**
   * `rand()` → a new number in `[0, 1)`, exactly like `Math.random()`.
   * `rand(n)` → a new whole number in `0…n-1`, the shape `floor(rand() * n)`
   * is always written as.
   *
   * Two calls give two numbers. The same two calls, replayed, give the same
   * two numbers — see `nextDraw`. When you need one draw that several
   * SEPARATE expressions of the same step must agree on (drawing an item in
   * one field and removing that item in another), read `$random` instead:
   * that is the step's single value and it does not advance.
   */
  rand: (args, scope) => {
    const r = nextDraw(scope)
    if (args.length === 0) return r
    const n = num(args[0], 'rand')
    if (!(n > 0)) typeError(`rand(n) needs a positive count — got ${n}`)
    return Math.floor(r * n)
  },
  /** `now()` → this step's start time in unix milliseconds. Supplied by the caller, never read from the host clock, so a replay reports when the step actually ran. */
  now: (_args, scope) => scope.$now,
}

export const FUNCTION_NAMES: ReadonlySet<string> = new Set([...Object.keys(FUNCTIONS), ...Object.keys(SCOPE_FUNCTIONS)])
