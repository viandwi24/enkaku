import { z } from 'zod'

/**
 * A named parameter preset (plan 95 §4.7, §5 step 95.8; generalised to
 * workflows by plan 311 §3.3, §4.1) — a convenience for a human filling a
 * form, keyed on `(kind, ownerName)` rather than one published script
 * version or a workflow's row id, so it survives every publish (plan 311
 * G6). `params` is `z.unknown()`: like `ScriptRow.paramsSchema`'s sibling
 * columns (`jobs.params`, `schedules.params`), it is validated against the
 * SCHEMA it is about to meet at the moment it is applied
 * (`reconcileParams`), not against any fixed shape here.
 */
export const PresetKindSchema = z.enum(['script', 'workflow'])
export type PresetKind = z.infer<typeof PresetKindSchema>

export const ParamPresetInfoSchema = z.object({
  id: z.string(),
  kind: PresetKindSchema,
  /** A script's `plugin/script` name, or a workflow's `name`. Never a version (plan 311 §3.1). */
  ownerName: z.string(),
  name: z.string(),
  params: z.unknown(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ParamPresetInfo = z.infer<typeof ParamPresetInfoSchema>

/** `GET /api/scripts/:name/param-sets`, `GET /api/workflows/:name/presets`. */
export const ParamPresetListResponseSchema = z.object({ items: z.array(ParamPresetInfoSchema) })

/** `POST`/`PATCH` on either preset route family — both echo the full row back. */
export const ParamPresetResponseSchema = z.object({ preset: ParamPresetInfoSchema })

/** `DELETE` on either preset route family — `{ok: true}`, not an empty 204 body. */
export const ParamPresetDeleteResponseSchema = z.object({ ok: z.literal(true) })
