import { z } from 'zod'
import type { JsonSchemaNode } from '../api/json-schema'
import { SCHEMA_LIMITS } from './limits'
import { readHints } from './vocabulary'

/** One field-level failure. `path` is dot-notation (`videos`, `retry.backoffBaseMs`),
 *  matching the convention `SchemaForm` already uses for `serverErrors` (plan 95 §4.3). */
export interface ParamIssue {
  path: string
  message: string
}

/**
 * Plan 97 §4.3, §4.6 — the wire/DB counterpart of `ParamIssue`, needed the
 * moment an issue list crosses a Zod boundary (the child⇄parent `result`
 * message's `outcome.issues`, and `jobs.result_issues`). Kept here, beside
 * the plain interface it mirrors, rather than declared ad hoc at each call
 * site.
 */
export const ParamIssueSchema = z.object({ path: z.string(), message: z.string() })

export type ValidateParamsResult = { ok: true } | { ok: false; issues: ParamIssue[] }

/** The sentinel `z.number().int()` with no explicit bounds emits (F5) — a
 *  bound this exact must be treated as "no bound", never as a real limit. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function declaredTypes(node: Record<string, unknown>): string[] | undefined {
  const t = node.type
  if (typeof t === 'string') return [t]
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string')
  return undefined
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    case 'null':
      return value === null
    default:
      // An unrecognised declared type (a JSON Schema keyword this validator
      // does not model) never blocks a value on its own — see §4.3's "what
      // it does not check": totality here means "does not falsely reject",
      // not "understands every JSON Schema keyword".
      return true
  }
}

function isNumericSchema(node: unknown): boolean {
  if (!isPlainObject(node)) return false
  const types = declaredTypes(node)
  return !!types && (types.includes('number') || types.includes('integer'))
}

/** Resolves a `$ref` chain against `root.$defs`, guarded by a visited set
 *  (R1, F21) — a self-referential schema returns `null` rather than looping. */
function derefNode(node: Record<string, unknown>, root: JsonSchemaNode, refVisited: Set<string>): Record<string, unknown> | null {
  let current: Record<string, unknown> = node
  while (typeof current.$ref === 'string') {
    const ref = current.$ref
    if (refVisited.has(ref)) return null
    refVisited.add(ref)
    const match = /^#\/\$defs\/(.+)$/.exec(ref)
    const defs = isPlainObject(root) ? (root as Record<string, unknown>).$defs : undefined
    const target = match && isPlainObject(defs) ? (defs as Record<string, unknown>)[match[1] as string] : undefined
    if (!isPlainObject(target)) return null
    current = target
  }
  return current
}

// Fixed, Enkaku-owned checks (§3.8): none of these evaluate an author-supplied
// regular expression. `pattern` itself is never read here — see §3.8, R2.
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function isValidUri(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function isValidDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value) && !Number.isNaN(Date.parse(value))
}

/** An Android application id: reverse-domain, at least two identifier
 *  segments joined by dots (`com.example.app`) — the constraint `pattern`
 *  used to express, now a first-class Enkaku-owned check (§3.8). */
function isValidPackageName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value)
}

function checkNumber(node: Record<string, unknown>, value: number, path: string, issues: ParamIssue[]): void {
  if (typeof node.minimum === 'number' && node.minimum !== -UNBOUNDED && value < node.minimum) {
    issues.push({ path, message: `must be at least ${node.minimum}` })
  }
  if (typeof node.maximum === 'number' && node.maximum !== UNBOUNDED && value > node.maximum) {
    issues.push({ path, message: `must be at most ${node.maximum}` })
  }
  if (typeof node.exclusiveMinimum === 'number' && value <= node.exclusiveMinimum) {
    issues.push({ path, message: `must be greater than ${node.exclusiveMinimum}` })
  }
  if (typeof node.exclusiveMaximum === 'number' && value >= node.exclusiveMaximum) {
    issues.push({ path, message: `must be less than ${node.exclusiveMaximum}` })
  }
  if (typeof node.multipleOf === 'number' && node.multipleOf > 0) {
    const ratio = value / node.multipleOf
    if (Math.abs(Math.round(ratio) - ratio) > 1e-9) {
      issues.push({ path, message: `must be a multiple of ${node.multipleOf}` })
    }
  }
  // `kind: 'chance'`'s domain (§3.2, §4.3) — checked regardless of what the
  // schema's own minimum/maximum say, so a schema published before that rule
  // was enforced at publish time still gets the real constraint at run time.
  if (readHints(node).kind === 'chance' && (value < 0 || value > 1)) {
    issues.push({ path, message: 'must be between 0 and 1' })
  }
}

function checkString(node: Record<string, unknown>, value: string, path: string, issues: ParamIssue[]): void {
  if (typeof node.minLength === 'number' && value.length < node.minLength) {
    issues.push({ path, message: `must be at least ${node.minLength} characters` })
  }
  if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
    issues.push({ path, message: `must be at most ${node.maxLength} characters` })
  }
  // `pattern` is deliberately NEVER evaluated here — §3.8, R2: no
  // author-supplied regular expression is ever compiled or run, in the
  // browser or in the core.
  if (node.format === 'email' && !isValidEmail(value)) {
    issues.push({ path, message: 'must be a valid email address' })
  }
  if (node.format === 'uri' && !isValidUri(value)) {
    issues.push({ path, message: 'must be a valid URI' })
  }
  if (node.format === 'date-time' && !isValidDateTime(value)) {
    issues.push({ path, message: 'must be a valid date and time' })
  }
  if (readHints(node).kind === 'packageName' && !isValidPackageName(value)) {
    issues.push({ path, message: 'must be a valid Android package name (e.g. com.example.app)' })
  }
}

function checkTuple(
  node: Record<string, unknown>,
  value: unknown,
  root: JsonSchemaNode,
  path: string,
  depth: number,
  refVisited: Set<string>,
  issues: ParamIssue[],
): void {
  const prefixItems = node.prefixItems as unknown[]
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be a list' })
    return
  }
  if (value.length !== prefixItems.length) {
    issues.push({ path, message: `must have exactly ${prefixItems.length} values` })
    return
  }
  prefixItems.forEach((item, i) => {
    if (isPlainObject(item)) check(item, value[i], root, `${path}[${i}]`, depth + 1, refVisited, issues)
  })

  // The ordered-pair rule (§3.2, §4.3): a 2-number tuple is an interval,
  // low end first, unless `ordered: false` opts out.
  if (prefixItems.length === 2 && isNumericSchema(prefixItems[0]) && isNumericSchema(prefixItems[1]) && readHints(node).ordered !== false) {
    const [lo, hi] = value as [unknown, unknown]
    if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) {
      issues.push({ path, message: 'the lower bound cannot be greater than the upper bound' })
    }
  }
}

function checkArray(node: Record<string, unknown>, value: unknown, root: JsonSchemaNode, path: string, depth: number, refVisited: Set<string>, issues: ParamIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be a list' })
    return
  }
  if (typeof node.minItems === 'number' && value.length < node.minItems) {
    issues.push({ path, message: `must have at least ${node.minItems} items` })
  }
  if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
    issues.push({ path, message: `must have at most ${node.maxItems} items` })
  }
  if (isPlainObject(node.items)) {
    const itemSchema = node.items
    value.forEach((item, i) => check(itemSchema, item, root, `${path}[${i}]`, depth + 1, refVisited, issues))
  }
}

function checkObject(node: Record<string, unknown>, value: unknown, root: JsonSchemaNode, path: string, depth: number, refVisited: Set<string>, issues: ParamIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path, message: 'must be an object' })
    return
  }
  const required = Array.isArray(node.required) ? (node.required as unknown[]).filter((k): k is string => typeof k === 'string') : []
  for (const key of required) {
    if (value[key] === undefined) issues.push({ path: joinPath(path, key), message: 'required' })
  }
  const properties = isPlainObject(node.properties) ? node.properties : undefined
  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] === undefined) continue // absence of an optional field is not itself an error
      if (isPlainObject(child)) check(child, value[key], root, joinPath(path, key), depth + 1, refVisited, issues)
    }
  }
}

function check(nodeIn: unknown, value: unknown, root: JsonSchemaNode, path: string, depth: number, refVisited: Set<string>, issues: ParamIssue[]): void {
  if (depth > SCHEMA_LIMITS.maxDepth) return // a safety net, not the enforcement point — checkDeclaredSchema owns that at publish

  if (!isPlainObject(nodeIn)) return
  let node = nodeIn
  if (typeof node.$ref === 'string') {
    const resolved = derefNode(node, root, refVisited)
    if (!resolved) return // a cycle, or an unresolvable $ref — nothing more can safely be checked
    node = resolved
  }

  // Nullable unwrapping (`anyOf`/`oneOf` with exactly one non-null branch),
  // the same structural read the resolver uses (plan 95 §3.3 row 14).
  const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined
  if (branches) {
    const isNullBranch = (b: unknown): boolean => isPlainObject(b) && b.type === 'null'
    if (value === null && branches.some(isNullBranch)) return
    const real = branches.filter((b) => !isNullBranch(b))
    if (real.length === 1 && isPlainObject(real[0])) {
      check(real[0], value, root, path, depth + 1, refVisited, issues)
    }
    // Several real branches (row 15): not this validator's job to pick one —
    // the resolver renders it as an escape hatch and the child re-checks it
    // with the real Zod schema.
    return
  }

  if (value === undefined) return // required-ness is the parent object's job, not this node's
  const types = declaredTypes(node)
  if (value === null) {
    if (types && !types.includes('null')) issues.push({ path, message: 'must not be empty' })
    return
  }
  if (types && !types.some((t) => matchesType(value, t))) {
    issues.push({ path, message: `must be a ${types.join(' or ')}` })
    return
  }

  if (Array.isArray(node.enum)) {
    if (!node.enum.includes(value)) issues.push({ path, message: `choose one of: ${node.enum.join(', ')}` })
    return
  }
  if ('const' in node) {
    if (value !== node.const) issues.push({ path, message: `must be ${JSON.stringify(node.const)}` })
    return
  }

  if (types?.includes('number') || types?.includes('integer')) {
    if (typeof value === 'number') checkNumber(node, value, path, issues)
    return
  }
  if (types?.includes('string')) {
    if (typeof value === 'string') checkString(node, value, path, issues)
    return
  }
  if (types?.includes('boolean')) return

  if (Array.isArray(node.prefixItems)) {
    checkTuple(node, value, root, path, depth, refVisited, issues)
    return
  }
  if (types?.includes('array')) {
    checkArray(node, value, root, path, depth, refVisited, issues)
    return
  }
  if (types?.includes('object') || isPlainObject(node.properties)) {
    checkObject(node, value, root, path, depth, refVisited, issues)
    return
  }
  // Anything else (a bare `z.record` with no `properties`, an unrecognised
  // keyword combination) is outside what this validator represents — the
  // same "degrade rather than falsely reject" rule row 16 of the resolver's
  // table applies to (plan 95 §3.3).
}

/**
 * The one validator, used by both Studio (on every keystroke) and the core
 * (at `POST /api/jobs`, `/api/batches`, `/api/schedules`) — plan 95 §3.7,
 * §4.3. `null`/`undefined` schema means the script declares no params at
 * all, which is never itself a violation.
 *
 * What it deliberately does NOT check: `pattern` (§3.8 — no author-supplied
 * regular expression is ever evaluated) and anything a `.refine()` or
 * `.superRefine()` expressed (§3.6 — silently dropped by `z.toJSONSchema`,
 * so there is nothing here to read; `enkaku publish` warns about these
 * instead, see `@enkaku/sdk`'s `publish.ts`).
 */
export function validateAgainstSchema(schema: JsonSchemaNode | null | undefined, value: unknown): ValidateParamsResult {
  if (schema === null || schema === undefined || !isPlainObject(schema)) return { ok: true }
  const issues: ParamIssue[] = []
  const input = value === undefined || value === null ? {} : value
  check(schema, input, schema, '', 0, new Set<string>(), issues)
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
