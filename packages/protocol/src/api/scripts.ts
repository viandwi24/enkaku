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
