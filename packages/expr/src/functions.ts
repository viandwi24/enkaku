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
}

export const FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(FUNCTIONS))
