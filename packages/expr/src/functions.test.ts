import { describe, expect, test } from 'bun:test'
import { ExprEvalError } from './ast'
import { evaluate, type ExprScope } from './eval'
import { parse } from './parse'
import { toScopeValue } from './scope'

function scope(params: Record<string, unknown> = {}): ExprScope {
  return {
    $params: toScopeValue(params) as Record<string, unknown>,
    $nodes: toScopeValue({}) as Record<string, unknown>,
    $input: undefined,
    $run: { summary: undefined },
    $now: 0,
    $random: 0,
  }
}

function run(source: string, params: Record<string, unknown> = {}): unknown {
  return evaluate(parse(source), scope(params))
}

describe('text functions', () => {
  test('len', () => expect(run('len("abc")')).toBe(3))
  test('lower', () => expect(run('lower("ABC")')).toBe('abc'))
  test('upper', () => expect(run('upper("abc")')).toBe('ABC'))
  test('trim', () => expect(run('trim("  a  ")')).toBe('a'))
  test('contains, on a string', () => expect(run('contains("hello", "ell")')).toBe(true))
  test('startsWith', () => expect(run('startsWith("hello", "he")')).toBe(true))
  test('endsWith', () => expect(run('endsWith("hello", "lo")')).toBe(true))
  test('split', () => expect(run('split("a,b,c", ",")')).toEqual(['a', 'b', 'c']))
  test('join', () => expect(run('join(split("a,b", ","), "-")')).toBe('a-b'))
  test('replace, literal not regex', () => expect(run('replace("a.b.c", ".", "-")')).toBe('a-b-c'))
  test('slice, on a string', () => expect(run('slice("hello", 1, 3)')).toBe('el'))
  test('slice past the end returns what exists, not a throw', () => expect(run('slice("hi", 0, 99)')).toBe('hi'))
  test('padStart', () => expect(run('padStart("5", 3, "0")')).toBe('005'))
  test('padEnd', () => expect(run('padEnd("5", 3, "0")')).toBe('500'))
  test('split on an empty string yields one empty element, not a throw', () =>
    expect(run('split("", ",")')).toEqual(['']))
})

describe('number functions', () => {
  test('abs', () => expect(run('abs(-3)')).toBe(3))
  test('floor', () => expect(run('floor(1.7)')).toBe(1))
  test('ceil', () => expect(run('ceil(1.2)')).toBe(2))
  test('round', () => expect(run('round(1.5)')).toBe(2))
  test('min', () => expect(run('min(3, 1, 2)')).toBe(1))
  test('max', () => expect(run('max(3, 1, 2)')).toBe(3))
  test('clamp', () => {
    expect(run('clamp(5, 0, 3)')).toBe(3)
    expect(run('clamp(-1, 0, 3)')).toBe(0)
    expect(run('clamp(2, 0, 3)')).toBe(2)
  })
  test('toNumber', () => expect(run('toNumber("42")')).toBe(42))
  test('toNumber on an unparsable string is a type error', () => {
    expect(() => run('toNumber("nope")')).toThrow(ExprEvalError)
  })
})

describe('array functions', () => {
  test('first', () => expect(run('first($params.a)', { a: [1, 2, 3] })).toBe(1))
  test('last', () => expect(run('last($params.a)', { a: [1, 2, 3] })).toBe(3))
  test('at', () => expect(run('at($params.a, 1)', { a: [1, 2, 3] })).toBe(2))
  test('slice, on an array', () => expect(run('slice($params.a, 1)', { a: [1, 2, 3] })).toEqual([2, 3]))
  test('contains, on an array', () => expect(run('contains($params.a, 2)', { a: [1, 2, 3] })).toBe(true))
  test('count', () => expect(run('count($params.a)', { a: [1, 2, 3] })).toBe(3))
  test('unique', () => expect(run('unique($params.a)', { a: [1, 1, 2] })).toEqual([1, 2]))
  test('sort, natural order', () => expect(run('sort($params.a)', { a: [3, 1, 2] })).toEqual([1, 2, 3]))
  test('sort on mixed types is a type error', () => {
    expect(() => run('sort($params.a)', { a: [1, 'x'] })).toThrow(ExprEvalError)
  })
  test('reverse', () => expect(run('reverse($params.a)', { a: [1, 2, 3] })).toEqual([3, 2, 1]))
})

describe('object functions', () => {
  test('has', () => expect(run('has($params.o, "a")', { o: { a: 1 } })).toBe(true))
  test('has, missing key', () => expect(run('has($params.o, "z")', { o: { a: 1 } })).toBe(false))
  test('keys', () => expect(run('keys($params.o)', { o: { a: 1, b: 2 } })).toEqual(['a', 'b']))
  test('get, dotted path', () => expect(run('get($params.o, "a.b", null)', { o: { a: { b: 3 } } })).toBe(3))
  test('get, missing path returns the default', () =>
    expect(run('get($params.o, "a.z", "d")', { o: { a: { b: 3 } } })).toBe('d'))
})

describe('value functions', () => {
  test('default', () => expect(run('default(null, "d")')).toBe('d'))
  test('default passes through a real value', () => expect(run('default(1, "d")')).toBe(1))
  test('coalesce', () => expect(run('coalesce(null, null, 3)')).toBe(3))
  test('isEmpty', () => {
    expect(run('isEmpty("")')).toBe(true)
    expect(run('isEmpty($params.a)', { a: [] })).toBe(true)
    expect(run('isEmpty("x")')).toBe(false)
  })
  test('notEmpty', () => expect(run('notEmpty("x")')).toBe(true))
  test('toText', () => {
    expect(run('toText(3)')).toBe('3')
    expect(run('toText(null)')).toBe('')
  })
  test('toJson / fromJson round-trip', () => {
    expect(run('fromJson(toJson($params.a))', { a: [1, 2, { x: 3 }] })).toEqual([1, 2, { x: 3 }])
  })
  test('fromJson on garbage is a type error', () => {
    expect(() => run('fromJson("{not json")')).toThrow(ExprEvalError)
  })
  test('fromJson never produces a live-prototype value', () => {
    const out = run('fromJson("{\\"a\\": 1}")') as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(null)
  })
  test('type', () => {
    expect(run('type(1)')).toBe('number')
    expect(run('type("x")')).toBe('string')
    expect(run('type(true)')).toBe('boolean')
    expect(run('type(null)')).toBe('null')
    expect(run('type($params.a)', { a: [1] })).toBe('array')
    expect(run('type($params.a)', { a: { x: 1 } })).toBe('object')
  })
})

describe('array paths — pluck/filterWhere (plan 312 §3.5, G6)', () => {
  test('pluck: the value at a dotted path in each element', () => {
    expect(run('pluck($params.a, "id")', { a: [{ id: 1 }, { id: 2 }, { id: 3 }] })).toEqual([1, 2, 3])
  })
  test('pluck: a dotted (nested) path', () => {
    expect(run('pluck($params.a, "user.name")', { a: [{ user: { name: 'x' } }, { user: { name: 'y' } }] })).toEqual(['x', 'y'])
  })
  test('pluck: a missing path yields undefined for that element, not a throw', () => {
    expect(run('pluck($params.a, "id")', { a: [{ id: 1 }, {}] })).toEqual([1, undefined])
  })
  test('pluck requires an array', () => {
    expect(() => run('pluck($params.a, "id")', { a: 'nope' })).toThrow(ExprEvalError)
  })
  test('pluck is bounded by maxArrayLength', () => {
    const big = Array.from({ length: 10_001 }, (_, i) => ({ id: i }))
    expect(() => run('pluck($params.a, "id")', { a: big })).toThrow(ExprEvalError)
  })

  test('filterWhere: gte over a dotted path', () => {
    expect(run('filterWhere($params.a, "videos", "gte", 10)', { a: [{ videos: 5 }, { videos: 12 }, { videos: 20 }] })).toEqual([{ videos: 12 }, { videos: 20 }])
  })
  test('filterWhere: eq', () => {
    expect(run('filterWhere($params.a, "tag", "eq", "x")', { a: [{ tag: 'x' }, { tag: 'y' }] })).toEqual([{ tag: 'x' }])
  })
  test('filterWhere: exists / notExists over a missing path', () => {
    expect(run('filterWhere($params.a, "id", "exists", null)', { a: [{ id: 1 }, {}] })).toEqual([{ id: 1 }])
    expect(run('filterWhere($params.a, "id", "notExists", null)', { a: [{ id: 1 }, {}] })).toEqual([{}])
  })
  test('filterWhere: contains, on a string path', () => {
    expect(run('filterWhere($params.a, "name", "contains", "an")', { a: [{ name: 'anna' }, { name: 'bob' }] })).toEqual([{ name: 'anna' }])
  })
  test('filterWhere: an unknown op is a type error, naming the closed set', () => {
    expect(() => run('filterWhere($params.a, "id", "regex", "x")', { a: [{ id: 1 }] })).toThrow(ExprEvalError)
  })
  test('filterWhere requires an array', () => {
    expect(() => run('filterWhere($params.a, "id", "eq", 1)', { a: 'nope' })).toThrow(ExprEvalError)
  })
  test('filterWhere never mutates its input array', () => {
    const a = [{ id: 1 }, { id: 2 }]
    run('filterWhere($params.a, "id", "eq", 1)', { a })
    expect(a).toEqual([{ id: 1 }, { id: 2 }])
  })
})
