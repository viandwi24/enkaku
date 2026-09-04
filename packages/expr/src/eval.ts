// The evaluator for `@enkaku/expr`. Plan 302 §4.4.
//
// `evaluate` walks a closed `Expr` tree with a `switch`. There is no branch
// that constructs a function from text, reads a prototype, or performs I/O.
// The five rules from §4.4, each with its own test group in `eval.test.ts`:
//
// 1. Scopes are null-prototype — built by the caller with `toScopeValue`
//    (`scope.ts`); this file only ever reads the six fixed root keys.
// 2. Member access is an own-property check, `hasOwnProperty` captured once
//    at module load so a hostile value cannot shadow it.
// 3. Index access takes an integer on an array or a string on an object,
//    same own-property rule; anything else is `undefined`.
// 4. Fuel (`Fuel`, `ast.ts`) is spent on every node visit, every function
//    call, and every element an array function touches.
// 5. Coercion is explicit and narrow: `+` only for two numbers or when
//    either side is a string (and the other a string or number); `==`
//    compares primitives with no cross-type coercion and objects/arrays by
//    bounded deep value.

import { EXPR_LIMITS, ExprEvalError, Fuel, type BinOp, type Expr, type RootName } from './ast'
import { FUNCTIONS } from './functions'

export { ExprEvalError, Fuel }

export interface ExprScope {
  $params: Readonly<Record<string, unknown>>
  $nodes: Readonly<Record<string, unknown>>
  $input: unknown
  $run: Readonly<{ summary: unknown }>
  $now: number
  $random: number
}

const hasOwn = Object.prototype.hasOwnProperty

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

function typeError(msg: string): never {
  throw new ExprEvalError('E_EXPR_TYPE', msg)
}

function truthy(v: unknown): boolean {
  return Boolean(v)
}

function num(v: unknown, op: string): number {
  if (typeof v !== 'number') typeError(`"${op}" requires a number`)
  return v
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function getMember(on: unknown, key: string): unknown {
  if (on === null || on === undefined || typeof on !== 'object') return undefined
  if (!hasOwn.call(on, key)) return undefined
  return (on as Record<string, unknown>)[key]
}

function getIndex(on: unknown, idx: unknown): unknown {
  if (Array.isArray(on)) {
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= on.length) return undefined
    return on[idx]
  }
  if (isPlainRecord(on) && typeof idx === 'string') return getMember(on, idx)
  return undefined
}

function add(l: unknown, r: unknown): unknown {
  if (typeof l === 'number' && typeof r === 'number') return l + r
  const lOk = typeof l === 'string' || typeof l === 'number'
  const rOk = typeof r === 'string' || typeof r === 'number'
  if ((typeof l === 'string' || typeof r === 'string') && lOk && rOk) {
    const s = String(l) + String(r)
    if (byteLength(s) > EXPR_LIMITS.maxStringBytes) {
      throw new ExprEvalError('E_EXPR_LIMIT', 'string result exceeds the size limit')
    }
    return s
  }
  typeError('"+" requires two numbers, or a string with a string or number')
}

function deepEqual(a: unknown, b: unknown, fuel: Fuel): boolean {
  fuel.spend()
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], fuel)) return false
    return true
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const ak = Object.keys(a)
    if (ak.length !== Object.keys(b).length) return false
    for (const k of ak) {
      if (!hasOwn.call(b, k)) return false
      if (!deepEqual(a[k], b[k], fuel)) return false
    }
    return true
  }
  return false
}

function evalBin(op: BinOp, l: unknown, r: unknown, fuel: Fuel): unknown {
  switch (op) {
    case '+': return add(l, r)
    case '-': return num(l, '-') - num(r, '-')
    case '*': return num(l, '*') * num(r, '*')
    case '/': return num(l, '/') / num(r, '/')
    case '%': return num(l, '%') % num(r, '%')
    case '<': return num(l, '<') < num(r, '<')
    case '<=': return num(l, '<=') <= num(r, '<=')
    case '>': return num(l, '>') > num(r, '>')
    case '>=': return num(l, '>=') >= num(r, '>=')
    case '==': return deepEqual(l, r, fuel)
    case '!=': return !deepEqual(l, r, fuel)
    /* c8 ignore next -- '&&'/'||' short-circuit in evalNode and never reach here */
    default: return typeError(`unsupported operator '${op}'`)
  }
}

function evalNode(node: Expr, scope: ExprScope, fuel: Fuel): unknown {
  fuel.spend()
  switch (node.t) {
    case 'lit':
      return node.v
    case 'root':
      return scope[node.name as RootName]
    case 'member':
      return getMember(evalNode(node.on, scope, fuel), node.key)
    case 'index':
      return getIndex(evalNode(node.on, scope, fuel), evalNode(node.idx, scope, fuel))
    case 'unary': {
      const v = evalNode(node.on, scope, fuel)
      return node.op === '!' ? !truthy(v) : -num(v, '-')
    }
    case 'bin': {
      if (node.op === '&&') {
        const l = evalNode(node.l, scope, fuel)
        return truthy(l) ? evalNode(node.r, scope, fuel) : l
      }
      if (node.op === '||') {
        const l = evalNode(node.l, scope, fuel)
        return truthy(l) ? l : evalNode(node.r, scope, fuel)
      }
      return evalBin(node.op, evalNode(node.l, scope, fuel), evalNode(node.r, scope, fuel), fuel)
    }
    case 'cond':
      return truthy(evalNode(node.c, scope, fuel)) ? evalNode(node.a, scope, fuel) : evalNode(node.b, scope, fuel)
    case 'call': {
      const fn = FUNCTIONS[node.fn]
      if (!fn) typeError(`unknown function '${node.fn}'`)
      const args = node.args.map((a) => evalNode(a, scope, fuel))
      fuel.spend()
      return fn(args, fuel)
    }
  }
}

/** Evaluate a closed AST against a scope. Pure: same AST + scope → same value. */
export function evaluate(ast: Expr, scope: ExprScope, opts?: { fuel?: number }): unknown {
  const fuel = new Fuel(opts?.fuel ?? EXPR_LIMITS.maxSteps)
  return evalNode(ast, scope, fuel)
}
