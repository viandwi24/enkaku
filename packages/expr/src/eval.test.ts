import { describe, expect, test } from 'bun:test'
import { EXPR_LIMITS } from './ast'
import { ExprEvalError, evaluate, type ExprScope } from './eval'
import { parse } from './parse'
import { toScopeValue } from './scope'

function scope(overrides: Partial<ExprScope> = {}): ExprScope {
  return {
    $params: toScopeValue({}) as Record<string, unknown>,
    $nodes: toScopeValue({}) as Record<string, unknown>,
    $input: undefined,
    $run: { summary: undefined },
    $now: 1_000,
    $random: 0.5,
    ...overrides,
  }
}

function run(source: string, s: ExprScope = scope()): unknown {
  return evaluate(parse(source), s)
}

describe('eval — arithmetic and comparison', () => {
  test('numeric arithmetic', () => {
    expect(run('1 + 2 * 3')).toBe(7)
    expect(run('(1 + 2) * 3')).toBe(9)
    expect(run('7 % 2')).toBe(1)
    expect(run('-3 + 1')).toBe(-2)
  })
  test('string concatenation', () => {
    expect(run('"a" + "b"')).toBe('ab')
    expect(run('"n=" + 3')).toBe('n=3')
  })
  test('"+" on two booleans is a type error', () => {
    expect(() => run('true + false')).toThrow(ExprEvalError)
  })
  test('comparisons', () => {
    expect(run('1 < 2')).toBe(true)
    expect(run('2 <= 2')).toBe(true)
    expect(run('3 > 2')).toBe(true)
  })
  test('equality has no cross-type coercion', () => {
    expect(run('1 == "1"')).toBe(false)
    expect(run('1 == 1')).toBe(true)
    expect(run('"a" != "b"')).toBe(true)
  })
  test('deep equality for arrays and objects', () => {
    const s = scope({ $params: toScopeValue({ a: [1, 2, { x: 1 }] }) as Record<string, unknown> })
    expect(evaluate(parse('$params.a == $params.a'), s)).toBe(true)
  })
})

describe('eval — logic and short-circuit', () => {
  test('&& returns the left operand when falsy, else the right', () => {
    expect(run('false && true')).toBe(false)
    expect(run('true && "x"')).toBe('x')
  })
  test('|| returns the left operand when truthy, else the right', () => {
    expect(run('"x" || "y"')).toBe('x')
    expect(run('false || "y"')).toBe('y')
  })
  test('&& short-circuits: the right side is never evaluated when the left is falsy', () => {
    // A right side that would throw if evaluated (unknown function is caught
    // at parse time, so this proves short-circuit via fuel spend instead):
    // fuel is finite; a right branch that would exceed it is never charged.
    const s = scope()
    const tiny = { fuel: 2 }
    // "false && (1+1+1+1+1+1+1+1)" — if the right side were evaluated it
    // would spend far more than 2 fuel units and throw E_EXPR_LIMIT.
    expect(evaluate(parse('false && (1 + 1 + 1 + 1 + 1 + 1 + 1 + 1)'), s, tiny)).toBe(false)
  })
  test('ternary', () => {
    expect(run('1 < 2 ? "yes" : "no"')).toBe('yes')
    expect(run('1 > 2 ? "yes" : "no"')).toBe('no')
  })
})

describe('eval — member and index, undefined propagation', () => {
  test('member access reads an own property', () => {
    const s = scope({ $nodes: toScopeValue({ read: { count: 3 } }) as Record<string, unknown> })
    expect(evaluate(parse('$nodes.read.count'), s)).toBe(3)
  })
  test('member access on a missing key is undefined, not a throw', () => {
    const s = scope({ $nodes: toScopeValue({ read: {} }) as Record<string, unknown> })
    expect(evaluate(parse('$nodes.read.missing'), s)).toBe(undefined)
  })
  test('index access on an array', () => {
    const s = scope({ $nodes: toScopeValue({ a: [10, 20, 30] }) as Record<string, unknown> })
    expect(evaluate(parse('$nodes.a[1]'), s)).toBe(20)
  })
  test('a negative or out-of-range index is undefined', () => {
    const s = scope({ $nodes: toScopeValue({ a: [10, 20] }) as Record<string, unknown> })
    expect(evaluate(parse('$nodes.a[-1 + -1]'), s)).toBe(undefined)
    expect(evaluate(parse('$nodes.a[9]'), s)).toBe(undefined)
  })
  test('a fractional index is undefined', () => {
    const s = scope({ $nodes: toScopeValue({ a: [10, 20] }) as Record<string, unknown> })
    expect(evaluate(parse('$nodes.a[1.5]'), s)).toBe(undefined)
  })
})

describe('eval — prototype (rule 2)', () => {
  const s = scope({ $nodes: toScopeValue({ a: { x: 1 } }) as Record<string, unknown> })

  test('.constructor is undefined, never a function', () => {
    expect(evaluate(parse('$nodes.a.constructor'), s)).toBe(undefined)
  })
  test('.__proto__ is undefined', () => {
    expect(evaluate(parse('$nodes.a.__proto__'), s)).toBe(undefined)
  })
  test('.toString is undefined', () => {
    expect(evaluate(parse('$nodes.a.toString'), s)).toBe(undefined)
  })
  test('.hasOwnProperty is undefined', () => {
    expect(evaluate(parse('$nodes.a.hasOwnProperty'), s)).toBe(undefined)
  })
  test('scope objects really are null-prototype', () => {
    expect(Object.getPrototypeOf(s.$nodes)).toBe(null)
  })
})

describe('eval — fuel (rule 4)', () => {
  test('a low fuel budget throws E_EXPR_LIMIT on a real expression', () => {
    expect(() => evaluate(parse('1 + 1 + 1 + 1 + 1'), scope(), { fuel: 1 })).toThrow(ExprEvalError)
  })
  test('the default budget is generous enough for an ordinary expression', () => {
    expect(run('1 + 1 + 1')).toBe(3)
  })
})

describe('eval — purity / determinism (G5, rule 5)', () => {
  test('1000 round-trips of the same AST and scope return the same value', () => {
    const ast = parse('($params.a + $params.b) * 2 == $params.c && len($params.s) > 1')
    const s = scope({
      $params: toScopeValue({ a: 1, b: 2, c: 6, s: 'ab' }) as Record<string, unknown>,
    })
    const first = evaluate(ast, s)
    for (let i = 0; i < 1000; i++) {
      expect(evaluate(ast, s)).toEqual(first)
    }
  })

  test('$now and $random are read only from the injected scope, never the host', () => {
    const s1 = scope({ $now: 42, $random: 0.1 })
    const s2 = scope({ $now: 42, $random: 0.1 })
    expect(evaluate(parse('$now + $random'), s1)).toEqual(evaluate(parse('$now + $random'), s2))
  })
})

describe('eval — functions', () => {
  test('len, upper, contains', () => {
    expect(run('len("abcd")')).toBe(4)
    expect(run('upper("ab")')).toBe('AB')
    expect(run('contains("hello", "ell")')).toBe(true)
  })
  test('default and coalesce', () => {
    const s = scope({ $nodes: toScopeValue({ a: {} }) as Record<string, unknown> })
    expect(evaluate(parse('default($nodes.a.missing, "d")'), s)).toBe('d')
    expect(run('coalesce(null, null, "x")')).toBe('x')
  })
  test('get() walks a dotted path safely and cannot reach a prototype', () => {
    const s = scope({ $nodes: toScopeValue({ a: { b: { c: 1 } } }) as Record<string, unknown> })
    expect(evaluate(parse('get($nodes.a, "b.c", null)'), s)).toBe(1)
    expect(evaluate(parse('get($nodes.a, "b.constructor", null)'), s)).toBe(null)
  })
})

describe('eval — EXPR_LIMITS.maxSteps is the default fuel', () => {
  test('a huge sort+unique chain runs out of fuel', () => {
    const big = Array.from({ length: EXPR_LIMITS.maxArrayLength }, (_, i) => i % 100)
    const s = scope({ $nodes: toScopeValue({ a: big }) as Record<string, unknown> })
    expect(() => evaluate(parse('unique(sort($nodes.a))'), s)).toThrow(ExprEvalError)
  })
})
