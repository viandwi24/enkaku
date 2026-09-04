// The tokeniser and recursive-descent parser for `@enkaku/expr`. Plan 302 §4.2.
//
// `parse` is a pure function from source text to a closed `Expr` AST, or it
// throws `ExprParseError`. It never constructs anything callable and never
// touches a host object — string in, tree out. Two structural rules do the
// security work a deny-list cannot: (1) a bare identifier is only legal
// immediately before `(`, as a function call — everywhere else it is a
// parse error, which is what makes `constructor` unreachable as a value: it
// can only ever be a *member key* after `.`, a compile-time-fixed string,
// never an evaluated expression; (2) `[ expr ]` may not itself be a string
// literal — computed access by string key is not in the grammar at all
// (plan 300 D4 §1), and `get(obj, "a.b.c")` is the closed-table substitute.

import { EXPR_LIMITS, ROOT_NAMES, type BinOp, type Expr, type RootName } from './ast'
import { FUNCTION_NAMES } from './functions'

export class ExprParseError extends Error {
  readonly code = 'E_EXPR_PARSE' as const
  readonly offset: number
  constructor(message: string, offset: number) {
    super(message)
    this.name = 'ExprParseError'
    this.offset = offset
  }
}

type TokenType = 'num' | 'str' | 'ident' | 'root' | 'punct' | 'eof'
interface Token { type: TokenType; value: string; offset: number }

const PUNCT_2 = ['&&', '||', '==', '!=', '<=', '>='] as const
const PUNCT_1 = '+-*/%!<>?:.()[],'
const isDigit = (c: string) => c >= '0' && c <= '9'
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c)

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const n = source.length
  let i = 0
  while (i < n) {
    const c = source[i]!
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    const start = i

    if (isDigit(c)) {
      let j = i + 1
      while (j < n && isDigit(source[j]!)) j++
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
        j++
        while (j < n && isDigit(source[j]!)) j++
      }
      tokens.push({ type: 'num', value: source.slice(i, j), offset: start })
      i = j
      continue
    }

    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      let out = ''
      let closed = false
      while (j < n) {
        const cj = source[j]!
        if (cj === quote) { closed = true; j++; break }
        if (cj === '\\') {
          const esc = source[j + 1]
          if (esc === 'n') out += '\n'
          else if (esc === 't') out += '\t'
          else if (esc === 'r') out += '\r'
          else if (esc === '\\' || esc === '"' || esc === "'") out += esc
          else throw new ExprParseError(`unknown escape '\\${esc ?? ''}'`, j)
          j += 2
          continue
        }
        out += cj
        j++
      }
      if (!closed) throw new ExprParseError('unterminated string literal', start)
      tokens.push({ type: 'str', value: out, offset: start })
      i = j
      continue
    }

    if (c === '$') {
      let j = i + 1
      while (j < n && isIdentPart(source[j]!)) j++
      const name = source.slice(i, j)
      if (!(ROOT_NAMES as readonly string[]).includes(name)) {
        throw new ExprParseError(`unknown root '${name}'`, start)
      }
      tokens.push({ type: 'root', value: name, offset: start })
      i = j
      continue
    }

    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdentPart(source[j]!)) j++
      tokens.push({ type: 'ident', value: source.slice(i, j), offset: start })
      i = j
      continue
    }

    const two = source.slice(i, i + 2)
    if ((PUNCT_2 as readonly string[]).includes(two)) {
      tokens.push({ type: 'punct', value: two, offset: start })
      i += 2
      continue
    }
    if (PUNCT_1.includes(c)) {
      tokens.push({ type: 'punct', value: c, offset: start })
      i++
      continue
    }
    throw new ExprParseError(`unexpected character '${c}'`, start)
  }
  tokens.push({ type: 'eof', value: '', offset: n })
  return tokens
}

const KEYWORD_LITERALS: Record<string, string | number | boolean | null> = { true: true, false: false, null: null }

class Parser {
  private pos = 0
  private nodeCount = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos]! }
  private advance(): Token { return this.tokens[this.pos++]! }
  private check(type: TokenType, value?: string): boolean {
    const t = this.peek()
    return t.type === type && (value === undefined || t.value === value)
  }
  private match(type: TokenType, value?: string): Token | undefined {
    return this.check(type, value) ? this.advance() : undefined
  }
  private expect(type: TokenType, value?: string): Token {
    const t = this.match(type, value)
    if (!t) {
      const cur = this.peek()
      throw new ExprParseError(`expected '${value ?? type}', got '${cur.value || '<end>'}'`, cur.offset)
    }
    return t
  }
  private node<T extends Expr>(e: T, offset: number): T {
    this.nodeCount++
    if (this.nodeCount > EXPR_LIMITS.maxAstNodes) throw new ExprParseError('expression has too many nodes', offset)
    return e
  }
  private checkDepth(depth: number, offset: number): void {
    if (depth > EXPR_LIMITS.maxDepth) throw new ExprParseError('expression is nested too deeply', offset)
  }

  parseProgram(): Expr {
    const e = this.parseExpr(0)
    if (!this.check('eof')) {
      const t = this.peek()
      throw new ExprParseError(`unexpected token '${t.value}'`, t.offset)
    }
    return e
  }

  private parseExpr(depth: number): Expr {
    this.checkDepth(depth, this.peek().offset)
    return this.parseTernary(depth)
  }

  private parseTernary(depth: number): Expr {
    const offset = this.peek().offset
    const c = this.parseOr(depth)
    if (this.match('punct', '?')) {
      const a = this.parseExpr(depth + 1)
      this.expect('punct', ':')
      const b = this.parseExpr(depth + 1)
      return this.node({ t: 'cond', c, a, b }, offset)
    }
    return c
  }

  private parseBinaryChain(depth: number, ops: readonly string[], next: (depth: number) => Expr): Expr {
    const offset = this.peek().offset
    let l = next(depth)
    for (;;) {
      const t = this.peek()
      if (t.type !== 'punct' || !ops.includes(t.value)) break
      this.advance()
      l = this.node({ t: 'bin', op: t.value as BinOp, l, r: next(depth) }, offset)
    }
    return l
  }

  private parseOr = (depth: number) => this.parseBinaryChain(depth, ['||'], this.parseAnd)
  private parseAnd = (depth: number) => this.parseBinaryChain(depth, ['&&'], this.parseEquality)
  private parseEquality = (depth: number) => this.parseBinaryChain(depth, ['==', '!='], this.parseComparison)
  private parseComparison = (depth: number) =>
    this.parseBinaryChain(depth, ['<', '<=', '>', '>='], this.parseAdditive)
  private parseAdditive = (depth: number) => this.parseBinaryChain(depth, ['+', '-'], this.parseMultiplicative)
  private parseMultiplicative = (depth: number) => this.parseBinaryChain(depth, ['*', '/', '%'], this.parseUnary)

  private parseUnary = (depth: number): Expr => {
    const t = this.peek()
    if (t.type === 'punct' && (t.value === '!' || t.value === '-')) {
      this.advance()
      this.checkDepth(depth + 1, t.offset)
      return this.node({ t: 'unary', op: t.value as '!' | '-', on: this.parseUnary(depth + 1) }, t.offset)
    }
    return this.parsePostfix(depth)
  }

  private parsePostfix(depth: number): Expr {
    let e = this.parsePrimary(depth)
    for (;;) {
      if (this.match('punct', '.')) {
        const id = this.expect('ident')
        e = this.node({ t: 'member', on: e, key: id.value }, id.offset)
        continue
      }
      const open = this.match('punct', '[')
      if (open) {
        const idx = this.parseExpr(depth + 1)
        if (idx.t === 'lit' && typeof idx.v === 'string') {
          throw new ExprParseError('a string literal index is not allowed; use "." or get()', open.offset)
        }
        this.expect('punct', ']')
        e = this.node({ t: 'index', on: e, idx }, open.offset)
        continue
      }
      break
    }
    return e
  }

  private parsePrimary(depth: number): Expr {
    const t = this.peek()
    if (t.type === 'num') { this.advance(); return this.node({ t: 'lit', v: Number(t.value) }, t.offset) }
    if (t.type === 'str') { this.advance(); return this.node({ t: 'lit', v: t.value }, t.offset) }
    if (t.type === 'root') { this.advance(); return this.node({ t: 'root', name: t.value as RootName }, t.offset) }

    if (t.type === 'ident') {
      if (Object.hasOwn(KEYWORD_LITERALS, t.value)) {
        this.advance()
        return this.node({ t: 'lit', v: KEYWORD_LITERALS[t.value]! }, t.offset)
      }
      const nextTok = this.tokens[this.pos + 1]
      if (nextTok && nextTok.type === 'punct' && nextTok.value === '(') {
        if (!FUNCTION_NAMES.has(t.value)) throw new ExprParseError(`unknown function '${t.value}'`, t.offset)
        this.advance() // the identifier
        this.advance() // '('
        const args: Expr[] = []
        if (!this.check('punct', ')')) {
          args.push(this.parseExpr(depth + 1))
          while (this.match('punct', ',')) args.push(this.parseExpr(depth + 1))
        }
        this.expect('punct', ')')
        return this.node({ t: 'call', fn: t.value, args }, t.offset)
      }
      throw new ExprParseError(`bare identifier '${t.value}' is only legal as a function call`, t.offset)
    }

    if (t.type === 'punct' && t.value === '(') {
      this.advance()
      const e = this.parseExpr(depth + 1)
      this.expect('punct', ')')
      return e
    }

    throw new ExprParseError(`unexpected token '${t.value || '<end>'}'`, t.offset)
  }
}

/** Parse expression source into a closed AST, or throw `ExprParseError`. */
export function parse(source: string): Expr {
  if (new TextEncoder().encode(source).length > EXPR_LIMITS.maxSourceBytes) {
    throw new ExprParseError(`expression source exceeds ${EXPR_LIMITS.maxSourceBytes} bytes`, 0)
  }
  return new Parser(tokenize(source)).parseProgram()
}
