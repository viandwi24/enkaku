import { z } from 'zod'
import { JsonSchemaNodeSchema } from './json-schema'
import { pageSchema } from './pagination'

/** `GET /api/scripts/:id` (`packages/core/src/scripts/routes.ts`). */
export const ScriptRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  paramsSchema: JsonSchemaNodeSchema.nullable(),
  enabled: z.boolean(),
  createdBy: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  createdAt: z.number().nullable(),
})
export const ScriptResponseSchema = z.object({ script: ScriptRowSchema })

/**
 * `GET /api/scripts` (the ungrouped, paginated list) — every field
 * `ScriptRowSchema` has except `source`, which that route's own projection
 * never selects (`packages/core/src/scripts/routes.ts`'s `GET /` handler).
 * Plan 95 §5 step 95.5 (fixes F8): Studio's `fetchAllPages` used to read
 * this list through a bare `as` cast; this is what lets it validate
 * instead.
 */
export const ScriptListItemSchema = ScriptRowSchema.omit({ source: true })

/** `GET /api/scripts/:name/versions`. */
export const VersionOptionSchema = z.object({
  id: z.string(),
  version: z.string(),
  enabled: z.boolean(),
  createdAt: z.number().nullable(),
})
export const ScriptVersionsResponseSchema = z.object({ items: z.array(VersionOptionSchema) })

/** `GET /api/scripts?group=name` — one row per script name (plan 62 §3.5). */
export const ScriptGroupRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  latestVersion: z.string(),
  versionCount: z.number(),
  lastPublishedAt: z.number().nullable(),
  enabled: z.boolean(),
})
export const ScriptGroupsPageResponseSchema = pageSchema(ScriptGroupRowSchema)

/**
 * `PATCH /api/scripts/:id` (`packages/core/src/scripts/routes.ts`) — a
 * genuine mismatch plan 72's migration found: two Studio call sites had
 * independently declared this route returns a full `ScriptRowSchema`
 * (natural to assume — "toggle enabled" reads like "fetch the row back"),
 * but the route only ever echoes back `{id, enabled}`.
 */
export const ScriptToggleResponseSchema = z.object({ script: z.object({ id: z.string(), enabled: z.boolean() }) })

/** `DELETE /api/scripts/:id` — `{ok: true}`, not an empty 204 body. */
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
