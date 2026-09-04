import { describe, expect, test } from 'bun:test'
import { EXPR_LIMITS } from './ast'
import { ExprParseError, parse } from './parse'

function refuses(source: string) {
  expect(() => parse(source)).toThrow(ExprParseError)
}

describe('parse — literals', () => {
  test('number', () => expect(parse('42')).toEqual({ t: 'lit', v: 42 }))
  test('decimal number', () => expect(parse('3.5')).toEqual({ t: 'lit', v: 3.5 }))
  test('string, double-quoted', () => expect(parse('"hi"')).toEqual({ t: 'lit', v: 'hi' }))
  test('string, single-quoted, with an escape', () =>
    expect(parse("'a\\nb'")).toEqual({ t: 'lit', v: 'a\nb' }))
  test('true / false / null', () => {
    expect(parse('true')).toEqual({ t: 'lit', v: true })
    expect(parse('false')).toEqual({ t: 'lit', v: false })
    expect(parse('null')).toEqual({ t: 'lit', v: null })
  })
  test('refuses an unterminated string', () => refuses('"unterminated'))
  test('refuses an unknown escape', () => refuses('"a\\qb"'))
})

describe('parse — roots', () => {
  test('every declared root parses', () => {
    const names = ['$params', '$nodes', '$input', '$run', '$now', '$random'] as const
    for (const name of names) {
      expect(parse(name)).toEqual({ t: 'root', name })
    }
  })
  test('refuses an unknown root', () => refuses('$bogus'))
})

describe('parse — member and index', () => {
  test('member access', () =>
    expect(parse('$nodes.read')).toEqual({
      t: 'member',
      on: { t: 'root', name: '$nodes' },
      key: 'read',
    }))
  test('chained member access', () =>
    expect(parse('$nodes.read.result')).toEqual({
      t: 'member',
      on: { t: 'member', on: { t: 'root', name: '$nodes' }, key: 'read' },
      key: 'result',
    }))
  test('numeric index', () =>
    expect(parse('$nodes.a[0]')).toEqual({
      t: 'index',
      on: { t: 'member', on: { t: 'root', name: '$nodes' }, key: 'a' },
      idx: { t: 'lit', v: 0 },
    }))
  test('index by an expression', () =>
    expect(parse('$nodes.a[1 + 1]')).toEqual({
      t: 'index',
      on: { t: 'member', on: { t: 'root', name: '$nodes' }, key: 'a' },
      idx: { t: 'bin', op: '+', l: { t: 'lit', v: 1 }, r: { t: 'lit', v: 1 } },
    }))
  test('refuses member access with no key', () => refuses('$nodes.'))
  test('refuses a string literal as an index', () => refuses('$nodes["a"]'))
})

describe('parse — unary', () => {
  test('logical not', () => expect(parse('!true')).toEqual({ t: 'unary', op: '!', on: { t: 'lit', v: true } }))
  test('negation', () => expect(parse('-1')).toEqual({ t: 'unary', op: '-', on: { t: 'lit', v: 1 } }))
  test('refuses a bare double-negative operator with nothing after it', () => refuses('!'))
})

describe('parse — binary operators', () => {
  const cases: Array<[string, string]> = [
    ['1 + 2', '+'],
    ['1 - 2', '-'],
    ['1 * 2', '*'],
    ['1 / 2', '/'],
    ['1 % 2', '%'],
    ['1 == 2', '=='],
    ['1 != 2', '!='],
    ['1 < 2', '<'],
    ['1 <= 2', '<='],
    ['1 > 2', '>'],
    ['1 >= 2', '>='],
    ['true && false', '&&'],
    ['true || false', '||'],
  ]
  for (const [src, op] of cases) {
    test(`parses '${op}'`, () => {
      const ast = parse(src)
      expect(ast.t).toBe('bin')
      expect((ast as { op: string }).op).toBe(op)
    })
  }
  test('refuses a dangling operator', () => refuses('1 +'))

  test('precedence: * before +', () =>
    expect(parse('1 + 2 * 3')).toEqual({
      t: 'bin',
      op: '+',
      l: { t: 'lit', v: 1 },
      r: { t: 'bin', op: '*', l: { t: 'lit', v: 2 }, r: { t: 'lit', v: 3 } },
    }))
})

describe('parse — ternary', () => {
  test('a ? b : c', () =>
    expect(parse('true ? 1 : 2')).toEqual({
      t: 'cond',
      c: { t: 'lit', v: true },
      a: { t: 'lit', v: 1 },
      b: { t: 'lit', v: 2 },
    }))
  test('refuses a ternary missing its else branch', () => refuses('true ? 1'))
})

describe('parse — calls', () => {
  test('a call with no arguments', () =>
    expect(parse('coalesce()')).toEqual({ t: 'call', fn: 'coalesce', args: [] }))
  test('a call with arguments', () =>
    expect(parse('max(1, 2, 3)')).toEqual({
      t: 'call',
      fn: 'max',
      args: [{ t: 'lit', v: 1 }, { t: 'lit', v: 2 }, { t: 'lit', v: 3 }],
    }))
  test('refuses a dangling comma in an argument list', () => refuses('max(1, )'))
  test('refuses a call to a function not in the closed table', () => refuses('exec(1)'))
})

describe('parse — grouping', () => {
  test('parentheses override precedence', () =>
    expect(parse('(1 + 2) * 3')).toEqual({
      t: 'bin',
      op: '*',
      l: { t: 'bin', op: '+', l: { t: 'lit', v: 1 }, r: { t: 'lit', v: 2 } },
      r: { t: 'lit', v: 3 },
    }))
  test('refuses an unclosed parenthesis', () => refuses('(1 + 2'))
})

describe('parse — the bare-identifier rule', () => {
  test('an identifier immediately followed by "(" is a call', () =>
    expect(parse('len($input)')).toEqual({
      t: 'call',
      fn: 'len',
      args: [{ t: 'root', name: '$input' }],
    }))
  test('refuses a bare identifier used as a value', () => refuses('constructor'))
  test('refuses a bare identifier that is not a keyword or a call', () => refuses('foo + 1'))
})

describe('parse — forms deliberately absent from the grammar', () => {
  test('refuses assignment', () => refuses('$params.x = 1'))
  test('refuses arrow functions', () => refuses('x => x'))
  test('refuses the function keyword used as a statement', () => refuses('function(){}'))
  test('refuses new', () => refuses('new Foo()'))
  test('refuses with', () => refuses('with (x) { x }'))
  test('refuses typeof', () => refuses('typeof x'))
  test('refuses template literals', () => refuses('`hi`'))
  test('refuses a regex literal', () => refuses('/abc/'))
  test('refuses optional chaining', () => refuses('$nodes?.a'))
  test('refuses nullish coalescing (use default())', () => refuses('$nodes.a ?? 1'))
  test('refuses object literals', () => refuses('{ a: 1 }'))
  test('refuses array literals', () => refuses('[1, 2, 3]'))
  test('refuses the comma operator', () => refuses('1, 2'))
  test('refuses increment', () => refuses('x++'))
  test('refuses bitwise and', () => refuses('1 & 2'))
})

describe('parse — limits', () => {
  test('refuses source over maxSourceBytes', () => {
    const huge = '1 + '.repeat(EXPR_LIMITS.maxSourceBytes)
    refuses(huge)
  })
  test('refuses a tree with too many nodes', () => {
    const many = Array.from({ length: EXPR_LIMITS.maxAstNodes + 50 }, () => '1').join(' + ')
    refuses(many)
  })
  test('refuses nesting deeper than maxDepth', () => {
    const deep = '('.repeat(EXPR_LIMITS.maxDepth + 10) + '1' + ')'.repeat(EXPR_LIMITS.maxDepth + 10)
    refuses(deep)
  })
})
