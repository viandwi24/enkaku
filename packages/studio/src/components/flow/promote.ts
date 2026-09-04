import { readHints, WORKFLOW_PARAM_TYPES, type WorkflowParam, type WorkflowParamType } from '@enkaku/protocol'
import { humanize } from '@/components/schema-form/resolve'
import type { JsonSchemaNode } from '@/components/schema-form/types'

/**
 * Promote (plan 99 §3.8): "creates a workflow parameter that copies the node
 * parameter's own `title`, `description`, `hints` and default verbatim out
 * of the node script's `paramsSchema`." This file is the pure half of that —
 * no React, so it is testable with no DOM, matching this repo's own
 * precedent for keeping "what a control MEANS" separate from "how it is
 * drawn" (`schema-form/plan.ts`'s module doc).
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function baseType(node: JsonSchemaNode): string | undefined {
  return Array.isArray(node.type) ? (node.type as unknown[]).find((t) => t !== 'null') as string | undefined : (node.type as string | undefined)
}

function isNumericType(t: string | undefined): boolean {
  return t === 'number' || t === 'integer'
}

/** The single non-`null` branch of a nullable `anyOf`/`oneOf` wrapper, or `undefined` when there is more than one real branch (plan 95's own "exactly one real branch" rule, `plan.ts` row 14). */
function unwrapNullable(node: JsonSchemaNode): JsonSchemaNode | undefined {
  const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray((node as Record<string, unknown>).oneOf) ? ((node as Record<string, unknown>).oneOf as JsonSchemaNode[]) : undefined
  if (!branches) return undefined
  const real = branches.filter((b) => baseType(b) !== 'null')
  return real.length === 1 ? real[0] : undefined
}

/**
 * A subset of plan 95's JSON-Schema vocabulary maps onto `WORKFLOW_PARAM_TYPES`
 * (`workflow-params.ts`'s own doc comment: "`stringList` is `type: 'array',
 * items: {type: 'string'}`; `numberPair` is `prefixItems` of length two, both
 * numeric"). `null` means "this parameter's shape has no workflow-parameter
 * equivalent" — Promote is simply not offered for it (an object, a free
 * string enum backed by a $ref this walker does not chase, and so on).
 */
export function inferWorkflowParamType(node: JsonSchemaNode): WorkflowParamType | null {
  if (!isRecord(node)) return null
  const type = baseType(node)
  if (type === 'boolean') return 'boolean'
  if (type === 'integer') return 'integer'
  if (type === 'number') return 'number'
  if (Array.isArray(node.prefixItems) && node.prefixItems.length === 2 && node.prefixItems.every((p) => isNumericType(baseType(p)))) {
    return 'numberPair'
  }
  if (type === 'string') return 'string'
  if (type === 'array') {
    const items = Array.isArray(node.items) ? undefined : node.items
    return items && baseType(items) === 'string' ? 'stringList' : null
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum.every((m) => typeof m === 'string') ? 'string' : node.enum.every((m) => typeof m === 'number') ? 'number' : null
  }
  const branch = unwrapNullable(node)
  return branch ? inferWorkflowParamType(branch) : null
}

/** `numberBounds`'s own `±MAX_SAFE_INTEGER` sentinel rule (`schema-form/plan.ts`), applied here so a promoted `min`/`max` never carries a value that only ever meant "no bound". */
function boundedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && value !== MAX_SAFE && value !== -MAX_SAFE ? value : undefined
}

/**
 * Builds the new `WorkflowParam` Promote creates (plan 99 §3.8) — `title`,
 * `description`, `hints`, and `default` copied VERBATIM off the node
 * script's own declared property; `required`/`type` derived structurally.
 * Returns `null` when `inferWorkflowParamType` cannot place this shape —
 * the caller is expected to hide the Promote affordance in that case rather
 * than offer an action that cannot succeed.
 */
export function promoteNodeParam(propertySchema: JsonSchemaNode, key: string, existingNames: ReadonlySet<string>, required: boolean): WorkflowParam | null {
  const type = inferWorkflowParamType(propertySchema)
  if (!type) return null
  const branch = unwrapNullable(propertySchema) ?? propertySchema
  const hints = readHints(propertySchema)
  const name = uniqueParamName(key, existingNames)
  const enumValues = Array.isArray(branch.enum) && branch.enum.length > 0 ? (branch.enum.filter((m) => typeof m === 'string' || typeof m === 'number') as (string | number)[]) : undefined

  const param: WorkflowParam = {
    name,
    type,
    required,
    title: typeof propertySchema.title === 'string' ? propertySchema.title : humanize(key),
    description: typeof propertySchema.description === 'string' ? propertySchema.description : '',
    ...(Object.keys(hints).length > 0 ? { hints } : {}),
    ...(propertySchema.default !== undefined ? { default: propertySchema.default } : {}),
    ...(enumValues && (type === 'string' || type === 'number' || type === 'integer') ? { enum: enumValues } : {}),
    ...(boundedNumber(branch.minimum) !== undefined ? { min: boundedNumber(branch.minimum) } : {}),
    ...(boundedNumber(branch.maximum) !== undefined ? { max: boundedNumber(branch.maximum) } : {}),
  }
  return param
}

/** `keyword`, `keyword-2`, `keyword-3`, ... — `WorkflowParamNameSchema`'s grammar allows only `[A-Za-z_][A-Za-z0-9_]*`, so the disambiguator is `_2`, not `-2`. */
function uniqueParamName(seed: string, existing: ReadonlySet<string>): string {
  const base = /^[A-Za-z_]/.test(seed) ? seed.replace(/[^A-Za-z0-9_]/g, '_') : `p_${seed.replace(/[^A-Za-z0-9_]/g, '_')}`
  if (!existing.has(base)) return base
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}_${i}`
    if (!existing.has(candidate)) return candidate
  }
  return `${base}_${Date.now()}`
}

export { WORKFLOW_PARAM_TYPES }
