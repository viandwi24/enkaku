import type { JsonSchemaNode } from '../api/json-schema'
import { SCHEMA_LIMITS } from './limits'
import { validateAgainstSchema } from './validate'

/**
 * The four findings worth REPORTING (plan 95 §4.4). `kept` and `filled` are
 * deliberately absent from this union: they mean the stored value already
 * satisfies the schema, or the schema itself supplies the missing value, so
 * nothing was lost and there is nothing to tell anyone — see `reconcileParams`'s
 * own doc comment for the full six-row table these four sit inside.
 */
export type FindingKind = 'removed' | 'reset' | 'invalid' | 'missing'

export interface ReconcileFinding {
  /** Dot-notation, matching `ParamIssue.path` (`videos`, `retry.backoffBaseMs`). */
  path: string
  kind: FindingKind
  /** A sentence for a person who did not author the script, matching `validate.ts`'s own tone. */
  detail: string
}

export interface ReconcileResult {
  /** The reconciled parameter object: kept values kept, absent-with-a-default
   *  fields filled, invalid-with-a-default fields reset, removed keys
   *  dropped. `missing`/`invalid` fields are left exactly as encountered
   *  (absent, or present-but-wrong) so an ATTENDED caller can show and fix
   *  them — see `blocking` below for what an UNATTENDED caller must do
   *  instead. */
  value: unknown
  findings: ReconcileFinding[]
  /** `true` when `findings` contains an `invalid` or a `missing` — the two
   *  outcomes with no default to fall back to. An unattended caller (a
   *  schedule firing, a batch rerun) must refuse rather than run on a
   *  half-understood configuration. */
  blocking: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** A shallow copy of an object-shaped value with dangerous keys (R5's
 *  prototype-pollution cousin) stripped — used on the paths that pass a
 *  stored value through unreconciled (a depth-cap bailout, a schema with no
 *  named fields to reconcile against) rather than field by field. */
function safeCopy(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (!DANGEROUS_KEYS.has(key)) out[key] = v
  }
  return out
}

function resolveRefOnce(root: Record<string, unknown>, ref: string): unknown {
  if (ref === '#') return root
  const segments = ref.replace(/^#\/?/, '').split('/').filter(Boolean)
  let cur: unknown = root
  for (const segment of segments) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[segment]
  }
  return cur
}

/**
 * Resolves a `$ref` chain and unwraps a nullable `anyOf`/`oneOf` — the same
 * two structural moves `validate.ts`'s own `check` makes (plan 95 §3.3 row
 * 1, row 14) — so `properties`/`required`/`default` below are read off the
 * REAL node, never a wrapper. Cycle-guarded per branch (`refVisited` is not
 * threaded across siblings, matching `limits.ts`'s own reasoning: a `$ref`
 * legitimately reused in two unrelated places is not a cycle). Returns
 * `null` on a cycle, an unresolvable `$ref`, or several real `anyOf`
 * branches — reconciliation then treats the field as OPAQUE (kept as
 * whatever was stored, no finding) rather than guessing, the same
 * "degrade rather than falsely reject" rule `validate.ts` and `plan.ts`
 * both already follow.
 */
function resolveStructural(nodeIn: unknown, root: Record<string, unknown>, refVisited: Set<string>): Record<string, unknown> | null {
  if (!isPlainObject(nodeIn)) return null
  let node = nodeIn
  while (typeof node.$ref === 'string') {
    const ref = node.$ref
    if (refVisited.has(ref)) return null
    refVisited.add(ref)
    const target = resolveRefOnce(root, ref)
    if (!isPlainObject(target)) return null
    node = target
  }
  const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined
  if (branches) {
    const real = branches.filter((b) => !(isPlainObject(b) && b.type === 'null'))
    if (real.length === 1) return resolveStructural(real[0], root, refVisited)
    return null
  }
  return node
}

/** A "field" the schema names, or a "group" whose OWN children are the
 *  fields (K7's nesting rule) — a bare `z.record()` (F19: `type: 'object'`
 *  with no `properties`) is a leaf, not a group, since it has no NAMED
 *  children to reconcile individually. */
function groupProperties(resolved: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!resolved || !isPlainObject(resolved.properties)) return null
  const props = resolved.properties as Record<string, unknown>
  return Object.keys(props).length > 0 ? props : null
}

function readDefault(childRaw: Record<string, unknown>, resolved: Record<string, unknown> | null): { has: true; value: unknown } | { has: false } {
  if ('default' in childRaw) return { has: true, value: childRaw.default }
  if (resolved && 'default' in resolved) return { has: true, value: resolved.default }
  return { has: false }
}

function requiredSet(node: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(node.required) ? (node.required as unknown[]).filter((k): k is string => typeof k === 'string') : [])
}

/**
 * Reconciles one OBJECT level (plan 95 §4.4). `invalidPaths` is the full set
 * of paths `validateAgainstSchema` already found wrong for the WHOLE stored value
 * against the WHOLE schema — computed once, by the caller, so this walk
 * never re-implements a type/bound/enum/ordered-pair check itself; it only
 * asks "did that one shared validation pass mark this field's own path (or
 * anything inside it) as an issue?" A field is reconciled as one unit — an
 * ordered pair or a tuple with one bad element is ONE finding on the pair's
 * own path, not per-element, matching how `validateAgainstSchema` already attaches
 * arity/ordering issues to the parent path.
 *
 * `depth` bounds the recursion (R1) independently of `validateAgainstSchema`'s own
 * bound: a self-referential GROUP (nested `properties` reached through a
 * `$ref` cycle that only closes once `stored` itself runs out of nesting)
 * could otherwise recurse as deep as an attacker-crafted `stored` blob is
 * nested. Past the cap, a field is left exactly as stored, with no finding —
 * the same "degrade, don't hang" choice `check()` makes in `validate.ts`.
 */
function reconcileObject(
  properties: Record<string, unknown>,
  required: ReadonlySet<string>,
  root: Record<string, unknown>,
  stored: Record<string, unknown>,
  path: string,
  depth: number,
  invalidPaths: readonly string[],
  findings: ReconcileFinding[],
): Record<string, unknown> {
  if (depth > SCHEMA_LIMITS.maxDepth) {
    // Safety net, not the enforcement point (checkDeclaredSchema owns that at
    // publish) — pass the stored subtree through untouched rather than hang.
    return safeCopy(stored)
  }
  // A plain `{}`, not `Object.create(null)` — a null-prototype object trips
  // up plenty of ordinary code downstream (JSON serialisers, ORM column
  // encoders, anything that checks `value.constructor`) that has no reason
  // to expect one. Prototype pollution is prevented the other way: every
  // assignment below is skipped outright for a dangerous key, so `out`
  // never receives an attacker-controlled `__proto__`/`constructor`/
  // `prototype` in the first place.
  const out: Record<string, unknown> = {}

  for (const [key, childRaw] of Object.entries(properties)) {
    if (DANGEROUS_KEYS.has(key) || !isPlainObject(childRaw)) continue
    const fieldPath = joinPath(path, key)
    const resolved = resolveStructural(childRaw, root, new Set())
    const nestedProps = groupProperties(resolved)
    const hasStored = Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== undefined

    if (nestedProps && hasStored && isPlainObject(stored[key])) {
      out[key] = reconcileObject(
        nestedProps,
        requiredSet(resolved as Record<string, unknown>),
        root,
        stored[key] as Record<string, unknown>,
        fieldPath,
        depth + 1,
        invalidPaths,
        findings,
      )
      continue
    }

    const fieldHasIssue = invalidPaths.some((p) => p === fieldPath || p.startsWith(`${fieldPath}.`) || p.startsWith(`${fieldPath}[`))
    const def = readDefault(childRaw, resolved)

    if (hasStored && !fieldHasIssue) {
      out[key] = stored[key] // kept — no finding
      continue
    }
    if (!hasStored) {
      if (def.has) {
        out[key] = def.value // filled from the default — no finding (K2's own behaviour)
      } else if (required.has(key)) {
        findings.push({ path: fieldPath, kind: 'missing', detail: 'is required by the current schema, is not set, and has no default to fall back to' })
      }
      // Optional, absent, no default: stays absent — an ordinary unset field, not a finding.
      continue
    }
    // Present, but no longer valid.
    if (def.has) {
      out[key] = def.value
      findings.push({ path: fieldPath, kind: 'reset', detail: 'no longer satisfies the current schema — reset to its default' })
    } else {
      out[key] = stored[key] // left in place so an attended caller can show and fix it
      findings.push({ path: fieldPath, kind: 'invalid', detail: 'no longer satisfies the current schema, and there is no default to fall back to' })
    }
  }

  for (const key of Object.keys(stored)) {
    if (DANGEROUS_KEYS.has(key) || key in properties) continue
    findings.push({ path: joinPath(path, key), kind: 'removed', detail: 'the current schema no longer declares this parameter' })
  }

  return out
}

/**
 * The schema-evolution rule (plan 95 §4.4), in one pure function, used by
 * presets, schedules, batch rerun, and the run dialog: a script's parameter
 * schema is a contract, and contracts change. `reconcileParams` is what a
 * stored parameter object meets the moment it faces a schema newer than the
 * one it was written against.
 *
 * **The rule, stated once and applied everywhere:**
 *
 * > A stored parameter object is never silently reshaped and never silently
 * > rejected. At the moment it meets a schema it is reconciled, and the
 * > reconciliation is reported.
 * >
 * > | stored | schema | outcome |
 * > |---|---|---|
 * > | present, valid | declares it | kept |
 * > | absent | declares it, has a `default` | filled from the default |
 * > | absent | declares it, **no** default | **`missing`** |
 * > | present, now invalid | has a `default` | reset to the default, **`reset`** |
 * > | present, now invalid | **no** default | **`invalid`** |
 * > | present | does not declare it | dropped, **`removed`** |
 * >
 * > **An unattended caller stops on `blocking`.** A schedule firing, a
 * > batch, a rerun-failed: the run does not happen, and the failure names
 * > the fields — exactly as plan 62 §4.5 already refuses to enqueue a
 * > partial batch when a reference cannot resolve, for the same reason
 * > (*"half a batch is worse than none, because half a batch looks like it
 * > worked"*).
 * >
 * > **An attended caller does not stop.** The run dialog opens with those
 * > fields highlighted and focused, because a human is right there and can
 * > answer.
 *
 * `missing` fires only for a field the schema marks `required` — an
 * OPTIONAL field the schema declares, that the stored set never set and
 * that carries no default, simply stays absent. The table above does not
 * spell "required" out in that row, but every worked example in the plan
 * (the `region` scenario, H3, acceptance criterion 15) is about a required
 * field with no default; reading the row as "any undeclared-default field"
 * would make `missing` fire on every ordinary optional parameter a schedule
 * never happened to set, turning a real signal into permanent noise.
 *
 * Delegates every type/bound/enum/ordered-pair check to `validateAgainstSchema`
 * (`./validate.ts`) — this function does not re-implement constraint
 * checking, only the six-row classification above (kept / filled / missing
 * / reset / invalid / removed) on top of it.
 */
export function reconcileParams(schema: JsonSchemaNode | null | undefined, stored: unknown): ReconcileResult {
  if (schema === null || schema === undefined || !isPlainObject(schema)) {
    return { value: stored, findings: [], blocking: false }
  }

  const storedObj = isPlainObject(stored) ? stored : {}
  const validation = validateAgainstSchema(schema, storedObj)
  const invalidPaths = validation.ok ? [] : validation.issues.map((i) => i.path)

  const findings: ReconcileFinding[] = []
  const topProperties = isPlainObject(schema.properties) ? (schema.properties as Record<string, unknown>) : null
  const value =
    topProperties && Object.keys(topProperties).length > 0
      ? reconcileObject(topProperties, requiredSet(schema), schema, storedObj, '', 0, invalidPaths, findings)
      : safeCopy(storedObj) // a top-level schema with no named fields (a bare record, or an atomic type) — nothing named to reconcile against

  const blocking = findings.some((f) => f.kind === 'invalid' || f.kind === 'missing')
  return { value, findings, blocking }
}

/**
 * The ONE line a preset picker shows after applying a named parameter set
 * (plan 95 §4.4, §4.7, §5 step 95.8) — the same "say what changed and what
 * it means, never a finding-code dump" rule `clamp.ts`'s `summarizeClamp`
 * already follows for the sibling "a stored schema met a limit" report.
 * `missing`/`invalid` are collapsed into ONE clause (`needs a value`)
 * because the distinction is not the operator's problem to parse: either
 * way, the field is left flagged red by the form's own validation the
 * moment this result's `value` is applied, which is where the operator
 * actually acts on it — this line only needs to say THAT they exist.
 *
 * Never empty and silent: a caller with zero findings gets an explicit
 * "nothing needed to change" rather than showing no report at all (plan 95
 * §5 step 95.8's own instruction — "if nothing changed, say that too rather
 * than showing an empty panel").
 */
export function summarizeApply(setName: string, findings: readonly ReconcileFinding[]): string {
  if (findings.length === 0) return `Applied '${setName}' — every setting still matches this version.`
  const reset = findings.filter((f) => f.kind === 'reset').length
  const removed = findings.filter((f) => f.kind === 'removed').length
  const needsValue = findings.filter((f) => f.kind === 'invalid' || f.kind === 'missing').length
  const parts: string[] = []
  if (reset > 0) parts.push(`${reset} setting${reset === 1 ? '' : 's'} reset to ${reset === 1 ? 'its' : 'their'} new default`)
  if (removed > 0) parts.push(`${removed} no longer exist${removed === 1 ? 's' : ''}`)
  if (needsValue > 0) parts.push(`${needsValue} need${needsValue === 1 ? 's' : ''} a value before you can run`)
  return `Applied '${setName}' — ${parts.join(', ')}.`
}
