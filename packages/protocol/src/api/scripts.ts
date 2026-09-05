import { z } from 'zod'
import { JsonSchemaNodeSchema } from './json-schema'
import { pageSchema } from './pagination'
import { RuntimeEnvelopeSchema } from '../runtime-envelope'
import { IconNameSchema } from '../plugin-surface'

/** The owning plugin, as a script is displayed: `plugin@1.2.0 / login` (MVP 03 §2.2 rule 1). */
export const ScriptPluginRefSchema = z.object({
  name: z.string(),
  version: z.string(),
  /**
   * Plan 310 §3.3, §4.2 — the PLUGIN's own icon, carried here rather than on
   * a second endpoint: the script palette's plugin page is a projection of
   * this same list (§4.2, "no second endpoint"), and a plugin row needs its
   * icon to draw. `null` = the caller applies the default (`puzzle`).
   */
  icon: IconNameSchema.nullable(),
})
export type ScriptPluginRef = z.infer<typeof ScriptPluginRefSchema>

/** The most recent job of this script NAME, whichever plugin version it ran (`jobs.script_name`), or null. */
export const ScriptLastRunSchema = z.object({
  jobId: z.string(),
  status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled']),
  createdAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
})
export type ScriptLastRun = z.infer<typeof ScriptLastRunSchema>

/** One row of `GET /api/scripts`: a member of an ACTIVE plugin. `id` is the member row of the active version. */
export const ScriptListItemSchema = z.object({
  id: z.string(),
  /** `<plugin>/<script>`. */
  name: z.string(),
  exportId: z.string(),
  plugin: ScriptPluginRefSchema,
  paramsSchema: JsonSchemaNodeSchema.nullable(),
  hasResult: z.boolean(),
  lastRun: ScriptLastRunSchema.nullable(),
  /** The member's own title, from the manifest (plan 303 §5 step 303.5 already persists it). `null` = the manifest declared none. */
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** `ICON_NAMES` (`plugin-surface.ts`). `null` = the caller applies the default (`play`). */
  icon: IconNameSchema.nullable(),
})
export type ScriptListItem = z.infer<typeof ScriptListItemSchema>
/** Every member in one page; `nextCursor` is always null (the set is small, see plan 210 §3.2 item 2). */
export const ScriptsListResponseSchema = pageSchema(ScriptListItemSchema)

/** `GET /api/scripts/:id`: any owned row, active or superseded (job history reads pinned rows here). */
export const ScriptRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  exportId: z.string(),
  plugin: ScriptPluginRefSchema,
  paramsSchema: JsonSchemaNodeSchema.nullable(),
  resultSchema: JsonSchemaNodeSchema.nullable().optional(),
  createdBy: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  createdAt: z.number().nullable(),
  runtime: RuntimeEnvelopeSchema.nullable().optional(),
  /** Only with `?bundle=1`. */
  bundle: z.string().optional(),
})
export const ScriptResponseSchema = z.object({ script: ScriptRowSchema })

/** `DELETE /api/scripts/:id` (unowned rows only). */
export const ScriptDeleteResponseSchema = z.object({ ok: z.literal(true) })

/**
 * A named parameter set (plan 95 §4.7, §5 step 95.8) — a convenience for a
 * human filling a form, keyed on the script NAME rather than one published
 * version, so it survives every publish. `params` is `z.unknown()`: like
 * `ScriptRow.paramsSchema`'s sibling columns (`jobs.params`,
 * `schedules.params`), it is validated against the SCHEMA it is about to
 * meet at the moment it is applied (`reconcileParams`), not against any
 * fixed shape here.
 */
export const ParamSetInfoSchema = z.object({
  id: z.string(),
  scriptName: z.string(),
  name: z.string(),
  params: z.unknown(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ParamSetInfo = z.infer<typeof ParamSetInfoSchema>

/** `GET /api/scripts/:name/param-sets`. */
export const ParamSetListResponseSchema = z.object({ items: z.array(ParamSetInfoSchema) })

/** `POST`/`PATCH /api/scripts/:name/param-sets(/:id)` — both echo the full row back. */
export const ParamSetResponseSchema = z.object({ paramSet: ParamSetInfoSchema })

/** `DELETE /api/scripts/:name/param-sets/:id` — `{ok: true}`, not an empty 204 body. */
export const ParamSetDeleteResponseSchema = z.object({ ok: z.literal(true) })
