export { EXPR_LIMITS, ExprEvalError, Fuel, ROOT_NAMES } from './ast'
export type { BinOp, Expr, RootName } from './ast'
export { ExprParseError, parse } from './parse'
export { toScopeValue } from './scope'
export { evaluate } from './eval'
export type { ExprScope } from './eval'
export { deriveRandom } from './random'

/**
 * A shallow type view of a scope, for plan 306's autocomplete (§9 Q4). Not
 * implemented here — plan 306 builds it against a real run's recorded
 * output, which this package has no access to.
 */
export type ScopeShape = Record<string, 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'unknown'>

export function describe(_scope: unknown): ScopeShape {
  return {}
}
