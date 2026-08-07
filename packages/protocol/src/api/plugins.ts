import { z } from 'zod'

/**
 * `/api/plugins` (plan 82 §4.6). NOTE this route does not go through
 * `typedJson`/unix-second timestamp conversion the way most of the core's
 * other routes do (`packages/core/src/api/plugins.ts` sends the raw
 * `PluginRow` straight through `c.json()`) — `createdAt`/`verifiedAt` are
 * therefore ISO 8601 strings on the wire (`Date.prototype.toJSON`, which is
 * what `JSON.stringify` calls on a `Date`), NOT the unix-seconds numbers
 * `ScriptRowSchema` uses elsewhere in this file's neighbours. Documented
 * here rather than "fixed" silently — changing the wire format is outside
 * this pass's remit.
 */

export const PluginStatusSchema = z.enum(['staged', 'verifying', 'active', 'superseded', 'failed', 'disabled'])

/** One member a verified bundle declared — `manifest.scripts` and a `VerifyReport`'s own `scripts` share this shape. */
export const VerifiedScriptSchema = z.object({
  id: z.string(),
  paramsSchema: z.unknown(),
})

export const PluginManifestSchema = z.object({ scripts: z.array(VerifiedScriptSchema) }).nullable()

/** One row of `plugins` — one version. Several versions of the same `name` can be listed at once (active plus every superseded one, plan 82 §4.4). */
export const PluginRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: PluginStatusSchema,
  verifiedAt: z.string().nullable(),
  /** Verbatim from the verification child (plan 82 §4.6) — rendered as-is, never summarised. */
  verifyError: z.string().nullable(),
  verifyErrorCode: z.string().nullable(),
  manifest: PluginManifestSchema,
  createdBy: z.string().nullable().optional(),
  createdAt: z.string(),
  /** Added by `PluginRuntime.list()` only — a live count of registered `scripts` rows, not the manifest's declared count (0 for a `failed` plugin, since nothing registered). */
  scriptCount: z.number().optional(),
})
export type PluginRow = z.infer<typeof PluginRowSchema>
export type PluginStatus = z.infer<typeof PluginStatusSchema>

export const DevSlotOwnerSchema = z.object({
  kind: z.enum(['workspace', 'cli']),
  label: z.string(),
})

/** A bare `DevSlot` (`packages/core/src/plugins/dev-slots.ts`) — what `POST /api/plugins/dev` returns as `slot`. */
export const DevSlotSchema = z.object({
  pluginName: z.string(),
  declaredVersion: z.string(),
  buildVersion: z.string(),
  buildN: z.number(),
  bundlePath: z.string(),
  scripts: z.array(z.object({ exportId: z.string(), paramsSchema: z.unknown() })),
  owner: DevSlotOwnerSchema,
  createdAt: z.number(),
  lastBuildAt: z.number(),
  lastBuildOk: z.boolean(),
  lastError: z.string().nullable(),
  expiresAt: z.number(),
})

/** `DevSlot` plus `kvNamespace` — what `runtime.devSlots()` (`GET /api/plugins`'s `dev`, `GET /api/plugins/dev`) returns. */
export const DevSlotViewSchema = DevSlotSchema.extend({ kvNamespace: z.string() })
export type DevSlotView = z.infer<typeof DevSlotViewSchema>

/** `GET /api/plugins`. */
export const PluginsListResponseSchema = z.object({
  items: z.array(PluginRowSchema),
  dev: z.array(DevSlotViewSchema),
})

/** `GET /api/plugins/dev`. */
export const PluginDevSlotsResponseSchema = z.object({ items: z.array(DevSlotViewSchema) })

/** `GET /api/plugins/:name/:version`. */
export const PluginResponseSchema = z.object({ plugin: PluginRowSchema })

export const VerifyReportSchema = z.object({
  ok: z.boolean(),
  pluginId: z.string().optional(),
  version: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  scripts: z.array(VerifiedScriptSchema),
  resetPackages: z.array(z.string()),
  error: z.string().optional(),
  errorCode: z.string().optional(),
})
export type VerifyReport = z.infer<typeof VerifyReportSchema>

/** `POST /api/plugins` (stage, optionally verify in the same call). */
export const PluginStageResponseSchema = z.object({
  plugin: PluginRowSchema.nullable(),
  verify: VerifyReportSchema.optional(),
})

/** `POST /api/plugins/:id/verify`, `POST /api/plugins/:name/reload`. */
export const PluginVerifyResponseSchema = z.object({ verify: VerifyReportSchema })

/** `POST /api/plugins/:id/activate`, `POST /api/plugins/:name/rollback`. */
export const PluginActivateResponseSchema = z.object({ plugin: PluginRowSchema })

/** `POST /api/plugins/restart`. */
export const PluginRestartResponseSchema = z.object({ ok: z.number(), failed: z.number() })

/** `POST /api/plugins/dev` — a `VerifyReport` plus the resulting slot when it built successfully. */
export const PluginDevPutResponseSchema = VerifyReportSchema.extend({ slot: DevSlotSchema.optional() })

/** `DELETE /api/plugins/:name/:version`. */
export const PluginRemoveResponseSchema = z.object({ removed: z.boolean(), kvDeleted: z.number() })
