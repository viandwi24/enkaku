// The closed AST union for `@enkaku/expr`. See plan 302 §4.3.
//
// This union is exhaustive: there is no `unknown`/`any` escape node, no
// "computed member access by arbitrary key" form, and no node that carries
// a callable. A value that walks this tree can only ever produce a literal,
// a lookup, an arithmetic/comparison/logical result, or a call into the
// closed function table (`functions.ts`).

export type BinOp =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | '&&' | '||'

export type RootName = '$params' | '$nodes' | '$input' | '$run' | '$now' | '$random'

export const ROOT_NAMES: readonly RootName[] = ['$params', '$nodes', '$input', '$run', '$now', '$random']

export type Expr =
  | { t: 'lit'; v: string | number | boolean | null }
  | { t: 'root'; name: RootName }
  | { t: 'member'; on: Expr; key: string }
  | { t: 'index'; on: Expr; idx: Expr }
  | { t: 'unary'; op: '!' | '-'; on: Expr }
  | { t: 'bin'; op: BinOp; l: Expr; r: Expr }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'call'; fn: string; args: Expr[] }

export const EXPR_LIMITS = {
  maxSourceBytes: 2_000,
  maxAstNodes: 200,
  maxDepth: 20,
  /** Evaluation fuel: one unit per AST node visited, per function call, per element touched by an array function. */
  maxSteps: 10_000,
  maxStringBytes: 64 * 1024,
  maxArrayLength: 10_000,
} as const

/**
 * Raised by `evaluate` (`eval.ts`) and the closed function table
 * (`functions.ts`). Lives here, not in `eval.ts`, so that `functions.ts` can
 * throw it without a circular import: `eval.ts` value-imports the function
 * table, so the function table cannot also value-import from `eval.ts`.
 */
export class ExprEvalError extends Error {
  readonly code: 'E_EXPR_LIMIT' | 'E_EXPR_TYPE'
  readonly offset: number

  constructor(code: 'E_EXPR_LIMIT' | 'E_EXPR_TYPE', message: string, offset = 0) {
    super(message)
    this.name = 'ExprEvalError'
    this.code = code
    this.offset = offset
  }
}

/**
 * Evaluation fuel: a hard, shared budget spent by every node visit, every
 * function call, and every array element a function touches. Exhausting it
 * throws `ExprEvalError('E_EXPR_LIMIT', ...)`. Lives here for the same
 * import-cycle reason as `ExprEvalError`.
 */
export class Fuel {
  remaining: number

  constructor(n: number) {
    this.remaining = n
  }

  spend(n = 1): void {
    this.remaining -= n
    if (this.remaining < 0) {
      throw new ExprEvalError('E_EXPR_LIMIT', 'expression exceeded its evaluation fuel')
    }
  }
}
