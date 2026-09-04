import { z } from 'zod'
import { JsonSchemaNodeSchema } from './json-schema'
import { ActivityKindSchema } from '../activity'

/**
 * What a capability does to a device (MVP 04 §1.4, plan 205 §4.4). Absent:
 * the capability never touches a device. `kind: 'read'`: the device must be
 * online, nothing is started and the policy is not consulted. Any other
 * kind is evaluated against the device's live activities before the handler
 * runs; `control` also refreshes the caller's control marker.
 */
export const CapabilityActivitySchema = z.object({
  kind: z.enum([...ActivityKindSchema.options, 'read']),
  exclusiveWith: z.array(ActivityKindSchema).optional(),
})

/**
 * `GET /api/v1/cap` (plan 63 §3.6) — the registry filtered to what the
 * caller may invoke. Before plan 72, `packages/core/src/api/cap.ts`'s
 * `GET /` handler returned this as a BARE ARRAY (`c.json(items)`, no
 * wrapper) while `agents/detail/page.tsx` asked for `{capabilities: [...]}`
 * — a shape that did not exist, so `b.capabilities` was `undefined` on every
 * load and the Tools tab crashed. Plan 72 §4.2 fixes the route to return the
 * envelope below; this schema is what BOTH sides now share.
 */
export const CapabilityDescriptorSchema = z.object({
  id: z.string(),
  description: z.string(),
  input: JsonSchemaNodeSchema,
  output: JsonSchemaNodeSchema,
  permission: z.string(),
  activity: CapabilityActivitySchema.nullable(),
  deadline: z.number(),
  effect: z.enum(['read', 'write', 'destructive']),
})
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>

/** `GET /api/v1/cap`. */
export const ListCapabilitiesResponseSchema = z.object({ capabilities: z.array(CapabilityDescriptorSchema) })

/**
 * `POST /api/v1/cap/:id` (`packages/core/src/api/cap.ts`) succeeds with
 * `{ok: true, output}` — the failure branch (`{ok: false, error}`, a
 * non-2xx status) never reaches a caller of `api()`, which throws on any
 * non-`res.ok` response before a schema is ever consulted.
 */
export function invokeCapabilityResponseSchema<T extends z.ZodTypeAny>(output: T) {
  return z.object({ ok: z.literal(true), output })
}
