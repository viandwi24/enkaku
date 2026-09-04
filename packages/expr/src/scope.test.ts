import { describe, expect, test } from 'bun:test'
import { EXPR_LIMITS } from './ast'
import { toScopeValue } from './scope'

describe('toScopeValue', () => {
  test('primitives pass through unchanged', () => {
    expect(toScopeValue('x')).toBe('x')
    expect(toScopeValue(3)).toBe(3)
    expect(toScopeValue(true)).toBe(true)
    expect(toScopeValue(null)).toBe(null)
    expect(toScopeValue(undefined)).toBe(undefined)
  })

  test('a plain object becomes null-prototype', () => {
    const out = toScopeValue({ a: 1, b: 'two' }) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(null)
    expect(out.a).toBe(1)
    expect(out.b).toBe('two')
  })

  test('a nested object is also null-prototype, recursively', () => {
    const out = toScopeValue({ a: { b: { c: 1 } } }) as Record<string, unknown>
    const a = out.a as Record<string, unknown>
    const b = a.b as Record<string, unknown>
    expect(Object.getPrototypeOf(a)).toBe(null)
    expect(Object.getPrototypeOf(b)).toBe(null)
    expect(b.c).toBe(1)
  })

  test('arrays keep order and stay real arrays', () => {
    const out = toScopeValue([3, 1, { x: 1 }]) as unknown[]
    expect(Array.isArray(out)).toBe(true)
    expect(out[0]).toBe(3)
    expect(out[1]).toBe(1)
    expect(Object.getPrototypeOf(out[2] as object)).toBe(null)
  })

  test('Date becomes undefined', () => {
    expect(toScopeValue(new Date())).toBe(undefined)
  })

  test('Map becomes undefined', () => {
    expect(toScopeValue(new Map())).toBe(undefined)
  })

  test('a function becomes undefined', () => {
    expect(toScopeValue(() => 1)).toBe(undefined)
  })

  test('a class instance becomes undefined', () => {
    class Foo { x = 1 }
    expect(toScopeValue(new Foo())).toBe(undefined)
  })

  test('a value nested inside an object that is itself a class instance is still undefined', () => {
    class Foo { x = 1 }
    const out = toScopeValue({ inner: new Foo() }) as Record<string, unknown>
    expect(out.inner).toBe(undefined)
  })

  test('a cyclic object is cut at maxDepth, not hung', () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    const out = toScopeValue(obj) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(null)
    // Walk down `self.self.self...`; eventually hits the depth cap and returns undefined.
    let cur: unknown = out
    let steps = 0
    while (cur !== undefined && steps <= EXPR_LIMITS.maxDepth + 2) {
      cur = (cur as Record<string, unknown>).self
      steps++
    }
    expect(cur).toBe(undefined)
    expect(steps).toBeLessThanOrEqual(EXPR_LIMITS.maxDepth + 2)
  })

  test('an array past maxArrayLength is truncated', () => {
    const big = new Array(EXPR_LIMITS.maxArrayLength + 50).fill(1)
    const out = toScopeValue(big) as unknown[]
    expect(out.length).toBe(EXPR_LIMITS.maxArrayLength)
  })

  test('a bigint and a symbol become undefined', () => {
    expect(toScopeValue(10n)).toBe(undefined)
    expect(toScopeValue(Symbol('s'))).toBe(undefined)
  })
})
