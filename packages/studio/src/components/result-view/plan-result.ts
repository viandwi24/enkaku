import { DANGEROUS_FIELD_NAMES, readHints, validateAgainstSchema } from '@enkaku/protocol'
import { deref, humanize } from '../schema-form/resolve'
import { planField, type FieldPlan, type PlanContext, type PlannedField } from '../schema-form/plan'
import type { JsonSchemaNode } from '../schema-form/types'

/**
 * Plan 97 §3.6 — the result-side sibling of `planForm`. `planField` is
 * reused UNCHANGED for every structural decision (row 1 through row 16 of
 * its own precedence table); this file adds exactly the three rules a form
 * cannot have, because a form plans BEFORE a value exists and a result
 * plans AFTER one does (§3.6's own framing). Nothing here re-derives a
 * control, a bound, or a `kind` — every `FieldPlan` on every returned field
 * still comes from `planField` itself, one call per field.
 *
 * | Rule | What it does | Why `planField` cannot have it |
 * |---|---|---|
 * | R1 | Branch selection for `anyOf`/`oneOf`: the first branch whose value
 *       actually validates is planned in the union's place; no match plans
 *       as `json`, exactly as `planField`'s own row 15 already would. | No
 *       value exists at form-plan time, and switching branches under a
 *       typing user would destroy what they entered. |
 * | R2 | Record expansion for a `z.record` (`type: 'object'` with no
 *       `properties`): the VALUE's own keys become rows, each planned from
 *       `additionalProperties`. | A form cannot draw an editor for keys
 *       that do not exist yet. |
 * | R3 | Unknown keys: present in the value but never declared on the
 *       schema render below the declared fields, raw, flagged `unknown`. | A
 *       form produces the value, so it can never have extras. |
 *
 * §3.6 scopes all three to the TOP LEVEL of the result — the same
 * granularity `summaryFields` (`@enkaku/protocol`'s `schema/result.ts`)
 * already uses for `summary: true` ("valid on at most three TOP-LEVEL
 * result fields"). H3's own evidence (the only real result schema in this
 * repository: thirteen top-level keys, twelve scalars and one
 * `Record<string, number>`) is exactly this shape, and every example the
 * plan text gives — the worked `auto-scroll` schema in §3.2, the `{ ok }`
 * discriminated union in §3.5 — resolves to a plain top-level object too.
 * A field several levels deep that is ITSELF a union or a record still
 * renders — through `planField`'s own row 13/15 `json` terminal, exactly as
 * a form would — rather than raw JSON with no explanation. Widening R1/R2
 * below the top level is future work, not a defect this step hides: doing
 * it correctly means re-deriving `planField`'s own group/table/list descent
 * value-aware, which is the "second structural decision-maker" the brief
 * warns against building. Recorded here rather than silently scoped away.
 *
 * Pure and total, like `planField` itself: no fetching, no DOM, no throw —
 * a schema this cannot make sense of degrades to the single-field `json`
 * fallback at the bottom of `planResult`, never an exception.
 */

/** One top-level result field, `planField`'s own descriptor plus the value
 *  it actually holds. `unknown: true` marks an R3 field — present in the
 *  value, absent from the schema's own `properties` — so `ResultView` can
 *  render it separately, under one quiet heading, never hidden. A `group`
 *  field's own nested values (R2's record expansion included) are NOT
 *  repeated here: `plan.children` already names every nested path
 *  (`planField`'s own static output), and `ResultView` looks each one up
 *  against `value` itself at render time — the same "one source of the
 *  structure" rule this whole file follows. */
export interface PlannedResultField extends Omit<PlannedField, 'plan'> {
  plan: FieldPlan
  value: unknown
  unknown?: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nodeType(node: JsonSchemaNode): string | undefined {
  return Array.isArray(node.type) ? ((node.type as unknown[]).find((t) => t !== 'null') as string | undefined) : (node.type as string | undefined)
}

function hasDeclaredProperties(node: JsonSchemaNode): boolean {
  return isPlainObject(node.properties) && Object.keys(node.properties as object).length > 0
}

/** A `z.record(...)` node: structurally an object, with nothing under `properties`. */
function isRecordSchema(node: JsonSchemaNode): boolean {
  return nodeType(node) === 'object' && !hasDeclaredProperties(node)
}

function unionBranches(node: JsonSchemaNode): JsonSchemaNode[] | undefined {
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) return node.anyOf as JsonSchemaNode[]
  const oneOf = (node as Record<string, unknown>).oneOf
  if (Array.isArray(oneOf) && oneOf.length > 0) return oneOf as JsonSchemaNode[]
  return undefined
}

/**
 * R1. Returns the ORIGINAL `node` unchanged whenever it is not a union, or
 * when it is one but no branch validates against `value` — in both cases
 * `planField` is left to make its own row 14/15 decision (unwrap the one
 * real branch, or `json` for "this parameter can take several different
 * shapes"/K7's `wrong-branch` fixture). Only on an actual match does this
 * substitute the winning branch, so `planField` plans THAT shape instead of
 * the wrapping union.
 */
function pickBranch(node: JsonSchemaNode, value: unknown, root: JsonSchemaNode): JsonSchemaNode {
  const resolved = deref(node, root)
  const branches = unionBranches(resolved)
  if (!branches) return node
  const match = branches.find((branch) => validateAgainstSchema(deref(branch, root), value).ok)
  return match ?? node
}

/** One record entry (R2, and the root-level `planResult` fallback for a
 *  bare `z.record(...)` result) — `key`/`value` from the VALUE, `plan` from
 *  `additionalProperties` via `planField`, exactly as a `z.record` param
 *  already documents itself to a form ("this parameter is a free-form
 *  map") except here the keys are real because a value exists to read
 *  them from. */
function planRecordEntry(key: string, itemSchema: JsonSchemaNode | undefined, value: unknown, ctx: PlanContext): PlannedResultField {
  return {
    path: key,
    label: humanize(key),
    advanced: false,
    required: false,
    value,
    plan: planField(itemSchema ?? {}, ctx),
  }
}

function planRecordFields(node: JsonSchemaNode, value: unknown, ctx: PlanContext): PlannedResultField[] {
  if (!isPlainObject(value)) return []
  const itemSchema = isPlainObject(node.additionalProperties) ? (node.additionalProperties as JsonSchemaNode) : undefined
  const nextCtx: PlanContext = { ...ctx, depth: ctx.depth + 1 }
  return Object.keys(value)
    .filter((key) => !DANGEROUS_FIELD_NAMES.has(key))
    .map((key) => planRecordEntry(key, itemSchema, value[key], nextCtx))
}

function toStaticField(field: PlannedResultField): PlannedField {
  return {
    path: field.path,
    label: field.label,
    help: field.help,
    group: field.group,
    advanced: field.advanced,
    required: field.required,
    showWhen: field.showWhen,
    plan: field.plan,
  }
}

/** One DECLARED top-level field: R1 first (does this field's own node need
 *  a branch picked for it), then R2 if the (possibly branch-picked) node
 *  turns out to be a record, then `planField` for everything else. */
function planDeclaredField(key: string, childNode: JsonSchemaNode, parentValue: unknown, required: boolean, root: JsonSchemaNode, ctx: PlanContext): PlannedResultField {
  const rawValue = isPlainObject(parentValue) ? parentValue[key] : undefined
  const picked = pickBranch(childNode, rawValue, root)
  const resolved = deref(picked, root)
  const hints = readHints(resolved)
  const label = typeof resolved.title === 'string' ? resolved.title : humanize(key)
  const help = typeof resolved.description === 'string' ? resolved.description : undefined
  const base = { path: key, label, help, group: hints.group, advanced: hints.advanced ?? false, required, showWhen: hints.showWhen, value: rawValue }

  if (isRecordSchema(resolved)) {
    const children = planRecordFields(resolved, rawValue, ctx).map(toStaticField)
    return { ...base, plan: { control: 'group', heading: label, children } }
  }
  return { ...base, plan: planField(picked, ctx) }
}

/**
 * `planResult(schema, value): PlannedResultField[]` — the whole result,
 * top-level fields in declaration order, R3's unknown keys appended after
 * them in the value's own key order. Total: a schema this cannot recognise
 * as an object (a bare scalar result, or a union with no matching branch
 * and no object shape) still returns ONE field (`path: ''`) rather than
 * silently dropping the value — the same "never fail by omission" rule
 * `planField`'s own row 16 keeps.
 */
export function planResult(schema: JsonSchemaNode, value: unknown): PlannedResultField[] {
  const root = schema
  const ctx: PlanContext = { root, depth: 1, seen: new Set() }
  const picked = pickBranch(schema, value, root)
  const resolved = deref(picked, root)

  if (isRecordSchema(resolved)) {
    return planRecordFields(resolved, value, ctx)
  }

  if (hasDeclaredProperties(resolved)) {
    const properties = resolved.properties as Record<string, JsonSchemaNode>
    const required = new Set(Array.isArray(resolved.required) ? (resolved.required as string[]) : [])
    const fields = Object.entries(properties).map(([key, child]) => planDeclaredField(key, child, value, required.has(key), root, ctx))

    // R3 — never hidden, always after the declared fields, in the value's own order.
    if (isPlainObject(value)) {
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(properties, key) || DANGEROUS_FIELD_NAMES.has(key)) continue
        fields.push({
          path: key,
          label: humanize(key),
          advanced: false,
          required: false,
          value: value[key],
          unknown: true,
          plan: { control: 'json', reason: 'not declared by the result schema' },
        })
      }
    }
    return fields
  }

  // Not an object shape at the top (a bare scalar/array result, or an
  // unresolved union — R1 found no matching branch): the whole value is
  // one field, planned by `planField` exactly as a form would plan it.
  return [{ path: '', label: 'Result', advanced: false, required: false, value, plan: planField(picked, ctx) }]
}
