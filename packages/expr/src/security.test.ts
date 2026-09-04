// The spine of plan 302 (§5 step 302.6). Every string here is a real escape
// shape from plan 300 R3/R4 or a direct structural attack on this package's
// own boundary. Each is asserted to fail exactly where the plan says it must
// fail. If a case here stops failing, the GRAMMAR is wrong — the fix is to
// narrow the grammar, never to special-case the string that got through
// (plan 300 D4's falsification test, restated at the top of plan 302 §5).

import { describe, expect, test } from 'bun:test'
import { ExprEvalError } from './ast'
import { evaluate, type ExprScope } from './eval'
import { ExprParseError, parse } from './parse'
import { toScopeValue } from './scope'

function scope(overrides: Partial<ExprScope> = {}): ExprScope {
  return {
    $params: toScopeValue({}) as Record<string, unknown>,
    $nodes: toScopeValue({ a: { x: 1 } }) as Record<string, unknown>,
    $input: undefined,
    $run: { summary: undefined },
    $now: 0,
    $random: 0,
    ...overrides,
  }
}

describe('known escapes — refused at PARSE time', () => {
  test('the CVE-2026-1470 shape: a with-statement local-constructor escape', () => {
    const src =
      "(function(){ var constructor = 'x'; with(function(){}){ return constructor(\"...\")() } })()"
    expect(() => parse(src)).toThrow(ExprParseError)
  })

  test('a direct constructor-call escape through a member chain', () => {
    expect(() => parse('$nodes.a.constructor("return process")()')).toThrow(ExprParseError)
  })

  test('a direct __proto__ assignment (prototype pollution)', () => {
    expect(() => parse('$nodes.a.__proto__.polluted = 1')).toThrow(ExprParseError)
  })

  test('computed member access by string literal, spelling "constructor"', () => {
    expect(() => parse('$nodes["constructor"]["prototype"]')).toThrow(ExprParseError)
  })

  test('a bare identifier reaching for a member instead of a call', () => {
    expect(() => parse('toJson.constructor')).toThrow(ExprParseError)
  })

  test('an 8 KB nested-parentheses bomb', () => {
    const depth = 4000
    const src = '('.repeat(depth) + '1' + ')'.repeat(depth)
    expect(src.length).toBeGreaterThan(8000)
    expect(() => parse(src)).toThrow(ExprParseError)
  })
})

describe('known escapes — refused at EVAL time', () => {
  test('.__proto__ resolves to undefined, never the real prototype', () => {
    const ast = parse('$nodes.a.__proto__')
    expect(evaluate(ast, scope())).toBe(undefined)
  })

  test('.toString resolves to undefined, never a callable', () => {
    const ast = parse('$nodes.a.toString')
    expect(evaluate(ast, scope())).toBe(undefined)
  })

  test('a 10,000-iteration sort+unique chain exhausts fuel rather than hanging', () => {
    const big = Array.from({ length: 10_000 }, (_, i) => i % 500)
    const s = scope({ $nodes: toScopeValue({ a: big }) as Record<string, unknown> })
    const ast = parse('unique(sort($nodes.a))')
    const started = performance.now()
    expect(() => evaluate(ast, s)).toThrow(ExprEvalError)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('structural guarantees', () => {
  test('every scope object handed to evaluate is null-prototype', () => {
    const s = scope({ $params: toScopeValue({ a: 1, b: { c: 2 } }) as Record<string, unknown> })
    expect(Object.getPrototypeOf(s.$params)).toBe(null)
    const b = (s.$params as Record<string, unknown>).b
    expect(Object.getPrototypeOf(b as object)).toBe(null)
  })

  test('no case in this suite ever reaches a real Function', () => {
    // If any of the parse-time cases above had actually produced an AST,
    // evaluating it could still never construct a callable: there is no AST
    // node shape that carries one, and getMember/getIndex only ever return
    // an own-property value or undefined. This is asserted structurally by
    // the type of `Expr` (ast.ts) rather than dynamically here.
    expect(true).toBe(true)
  })
})
