// The single most important function in this package (plan 302 §4.4 rule 1).
//
// `toScopeValue` is the only way a host value enters the evaluator. It turns
// every plain object into a null-prototype object (`Object.create(null)`),
// keeps arrays and primitives, and turns anything else — a function, a
// `Date`, a `Map`, a class instance — into `undefined`. There is therefore
// nothing with a prototype chain anywhere in a built scope: no
// `__proto__`, no `constructor`, no `toString` to reach, because they were
// never copied in.
//
// Depth is bounded by `EXPR_LIMITS.maxDepth`: a cyclic object recurses at
// most `maxDepth` levels deep before the branch is cut to `undefined`, which
// is what keeps a cycle from hanging this function — there is no visited-set,
// because the depth counter alone is sufficient (a cycle revisits the same
// object, but each revisit is one more level of depth, and depth is capped).
// Arrays are bounded by `EXPR_LIMITS.maxArrayLength`: elements past the limit
// are dropped, not evaluated.

import { EXPR_LIMITS } from './ast'

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function toScopeValue(value: unknown, depth = 0): unknown {
  if (depth > EXPR_LIMITS.maxDepth) return undefined
  if (value === null) return null
  if (value === undefined) return undefined

  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (t !== 'object') return undefined // function, symbol, bigint

  if (Array.isArray(value)) {
    const n = Math.min(value.length, EXPR_LIMITS.maxArrayLength)
    const out: unknown[] = new Array(n)
    for (let i = 0; i < n; i++) out[i] = toScopeValue(value[i], depth + 1)
    return out
  }

  if (!isPlainObject(value)) return undefined // Date, Map, class instance, ...

  const out = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value)) {
    out[key] = toScopeValue(value[key], depth + 1)
  }
  return out
}
