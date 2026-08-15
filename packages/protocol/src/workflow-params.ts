import { z } from 'zod'
import type { JsonSchemaNode } from './api/json-schema'
import { SCHEMA_LIMITS } from './schema/limits'
import { ENKAKU_META_KEY, ParamHintsSchema } from './schema/vocabulary'

/**
 * A workflow parameter's own name (plan 99 §3.8, §4.2). Reuses
 * `SCHEMA_LIMITS.fieldNamePattern` (plan 95 §3.8, F24) rather than inventing
 * a second identifier grammar — a node parameter binds to a workflow
 * parameter through `{ param: <this name> }` (`workflow.ts`'s
 * `ValueExprSchema`), and both ends must agree on what a legal name even
 * looks like. `.max(64)` is not itself part of `fieldNamePattern` (which
 * bounds shape, not length) — added here for the same reason
 * `WorkflowNodeIdSchema` (`workflow.ts`) is bounded: an unbounded identifier
 * is a size vector `WORKFLOW_LIMITS.maxDocBytes` alone would only catch late.
 */
export const WorkflowParamNameSchema = z
  .string()
  .max(64)
  .regex(SCHEMA_LIMITS.fieldNamePattern, 'must be a valid identifier — letters, digits, underscore, not starting with a digit')
export type WorkflowParamName = z.infer<typeof WorkflowParamNameSchema>

/**
 * The base shapes a workflow parameter may declare (plan 99 §3.8). A subset
 * of what plan 95's JSON-Schema vocabulary already expresses structurally —
 * `stringList` is `type: 'array', items: { type: 'string' }` (plan 95 §4.2
 * row 11, "a `list` of the planned item"); `numberPair` is `prefixItems` of
 * length two, both numeric (row 6, "a `pair`") — chosen because a workflow
 * author writes DATA, not a Zod chain, so the six cases that cover the
 * owner's example and the tiktok pack's real params are named directly
 * rather than asking the author to spell out `items`/`prefixItems` by hand.
 */
export const WORKFLOW_PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'stringList', 'numberPair'] as const
export type WorkflowParamType = (typeof WORKFLOW_PARAM_TYPES)[number]

/**
 * A workflow's own parameter declaration (plan 99 §3.8, §4.2). `hints` is
 * plan 95's `ParamHints`, VERBATIM (F24–F26) — no fork, no subset, no
 * extension — so `compileWorkflowParams`'s output degrades and renders
 * exactly the way a hand-written script's `paramsSchema` already does.
 */
export const WorkflowParamSchema = z
  .object({
    name: WorkflowParamNameSchema,
    type: z.enum(WORKFLOW_PARAM_TYPES),
    required: z.boolean().default(false),
    default: z.unknown().optional(),
    title: z.string().min(1).max(SCHEMA_LIMITS.maxTitleChars),
    description: z.string().max(SCHEMA_LIMITS.maxDescriptionChars).default(''),
    hints: ParamHintsSchema.optional(),
    enum: z.array(z.union([z.string(), z.number()])).max(SCHEMA_LIMITS.maxEnumMembers).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict()
export type WorkflowParam = z.infer<typeof WorkflowParamSchema>

/** True when every member of `values` is a `string` — narrows `enum` for the `string` param type. */
function isStringEnum(values: readonly (string | number)[]): values is string[] {
  return values.every((v) => typeof v === 'string')
}

/** True when every member of `values` is a `number` — narrows `enum` for the `number`/`integer` param types. */
function isNumberEnum(values: readonly (string | number)[]): values is number[] {
  return values.every((v) => typeof v === 'number')
}

/**
 * The Zod type ONE parameter compiles to, before `required`/`default`/
 * `title`/`description`/`hints` are layered on (`fieldFor`, below). An
 * `enum` on a `string` type becomes `z.enum(...)`; on `number`/`integer` it
 * becomes a union of literals — Zod has no first-class numeric enum, and a
 * union of `z.literal()`s is what `z.toJSONSchema` already renders as a
 * plain JSON Schema `enum`, so there is nothing bespoke to maintain here.
 */
function baseZodType(param: WorkflowParam): z.ZodTypeAny {
  switch (param.type) {
    case 'string': {
      if (param.enum && param.enum.length > 0 && isStringEnum(param.enum)) {
        return param.enum.length === 1 ? z.literal(param.enum[0] as string) : z.enum(param.enum as [string, ...string[]])
      }
      let s = z.string()
      if (typeof param.min === 'number') s = s.min(param.min)
      if (typeof param.max === 'number') s = s.max(param.max)
      return s
    }
    case 'number':
    case 'integer': {
      if (param.enum && param.enum.length > 0 && isNumberEnum(param.enum)) {
        const literals: z.ZodTypeAny[] = param.enum.map((v) => z.literal(v))
        return literals.length === 1 ? literals[0]! : z.union(literals as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
      }
      let n = param.type === 'integer' ? z.number().int() : z.number()
      if (typeof param.min === 'number') n = n.min(param.min)
      if (typeof param.max === 'number') n = n.max(param.max)
      return n
    }
    case 'boolean':
      return z.boolean()
    case 'stringList': {
      let a = z.array(z.string())
      if (typeof param.min === 'number') a = a.min(param.min)
      if (typeof param.max === 'number') a = a.max(param.max)
      return a
    }
    case 'numberPair':
      // A `prefixItems` pair (plan 95 §4.2 row 6), NOT a `stringList`-style
      // bounded array — `min`/`max` do not apply to a fixed-arity tuple.
      return z.tuple([z.number(), z.number()])
  }
}

/**
 * Wraps `baseZodType`'s result with everything that is NOT the value's own
 * shape: `required`/`default` (F16 — a `.default()`-wrapped field is what
 * keeps it OUT of `io: 'input'`'s `required` list; a `default` value present
 * wins over a bare `required: true` with no default, since a default makes a
 * field optional to the caller regardless of what the author also ticked),
 * then `.describe()` for `description`, then `.meta()` for `title` plus the
 * `x-enkaku` hints — the exact chain order `TimingSettingsSchema`
 * (`settings.ts`) already uses for a hand-written script's own params, so
 * `z.toJSONSchema` renders both alike (this is the whole equivalence claim
 * this module exists to prove — see `workflow-params.test.ts`).
 */
function fieldFor(param: WorkflowParam): z.ZodTypeAny {
  let schema = baseZodType(param)
  if (param.default !== undefined) {
    schema = schema.default(param.default)
  } else if (!param.required) {
    schema = schema.optional()
  }
  if (param.description) schema = schema.describe(param.description)
  const meta: Record<string, unknown> = { title: param.title }
  if (param.hints && Object.keys(param.hints).length > 0) meta[ENKAKU_META_KEY] = param.hints
  return schema.meta(meta)
}

/**
 * Compiles a workflow's parameter DECLARATIONS to the same JSON Schema a
 * hand-written Zod object would produce for the equivalent fields (plan 99
 * §3.8, §4.2). This is the ONE place a workflow "compiles" — and it compiles
 * to a SCHEMA, not to code: the output goes straight into `scripts.paramsSchema`
 * (the same column a CLI-published script's schema lives in), so the run
 * dialog, `ParamSetPicker`, `validateAgainstSchema`, `reconcileParams`,
 * `checkDeclaredSchema`, the batch form, and the agent's enqueue validation all
 * work with no code written for workflows at all.
 *
 * `io: 'input'` is not a preference (plan 95 §3.2, §4.9) — the default
 * `io: 'output'` puts every `.default()` field into `required`, which is the
 * exact defect that made a defaulted enum publish as mandatory and killed a
 * job on validation before it did anything (F16). `sdk/cli/publish.ts:187`
 * calls the SAME `{ io: 'input' }` for the same reason; this function matches
 * it by construction, never by convention alone.
 *
 * `null` for an empty declaration list, matching `scripts.paramsSchema`'s own
 * "no params at all" convention (`validateAgainstSchema`, `schema/validate.ts:312`)
 * — a workflow with no declared parameters is not a violation, it is the
 * common case for a fixed pipeline.
 */
export function compileWorkflowParams(params: readonly WorkflowParam[]): JsonSchemaNode | null {
  if (params.length === 0) return null
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const param of params) shape[param.name] = fieldFor(param)
  const zodObject = z.object(shape)
  return z.toJSONSchema(zodObject, { io: 'input' }) as JsonSchemaNode
}
