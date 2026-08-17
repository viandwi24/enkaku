import { z } from 'zod'
import { ActionSpecSchema, NavEntrySchema, PluginSurfaceSchema, SurfaceIdSchema, ViewSpecSchema } from '../plugin-surface'
import { RuntimeEnvelopeSchema } from '../runtime-envelope'
import { KvEntrySchema } from './kv'

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

/**
 * One member a verified bundle declared — `manifest.scripts` and a
 * `VerifyReport`'s own `scripts` share this shape.
 *
 * Plan 108 §0.2 P7/P8, §5 step 108.3 — the four fields below closed the gap
 * where this WIRE schema was behind the manifest it describes: the core's own
 * `VerifiedScript` already carried `resultSchema` and `runtime`, and the
 * verify child now also reports each member's `title`/`description`, which is
 * what lets a screen name a script the way its author did instead of by its
 * id. All four are optional, because a member declares none of them by
 * default and every row written before this step has none.
 */
export const VerifiedScriptSchema = z.object({
  id: z.string(),
  paramsSchema: z.unknown(),
  /** Plan 97 — `null` for a member declaring no `result`; absent in a manifest written before that plan. */
  resultSchema: z.unknown().optional(),
  /** Plan 98 — the member's runtime envelope; `null` when it declared none. */
  runtime: RuntimeEnvelopeSchema.nullable().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
})

export const PluginManifestSchema = z
  .object({
    scripts: z.array(VerifiedScriptSchema),
    /**
     * Plan 108 §5 step 108.3 — the verified surface, stored in the same JSON
     * column as `scripts` and shipped on the wire with the rest of the row.
     * Absent for every plugin that declares no screen, which is every plugin
     * published before this plan.
     */
    surface: PluginSurfaceSchema.optional(),
  })
  .nullable()

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
  /**
   * Plan 108 §5 step 108.6 — the surface the dev build declared, so an
   * unpublished plugin contributes its sidebar entry exactly as a published
   * one does (a dev slot is not a `plugins` row, so there is no `manifest`
   * column for it to ride in — it lives on the slot itself). `null` for a
   * dev build that declares no screen; absent for a slot created before this
   * step existed.
   */
  surface: PluginSurfaceSchema.nullable().optional(),
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
  /** Plan 108 §3.9 — the re-validated surface, present only when the bundle declared one. */
  surface: PluginSurfaceSchema.optional(),
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

/**
 * `POST /api/plugins/:id/activate`, `POST /api/plugins/:name/rollback`, and
 * `POST /api/plugins/:name/enable` — the three routes that end with one row
 * now `active` and report which one. (`disable` has no such row and answers
 * `PluginOkResponseSchema` instead.)
 */
export const PluginActivateResponseSchema = z.object({ plugin: PluginRowSchema })

/** `POST /api/plugins/restart`. */
export const PluginRestartResponseSchema = z.object({ ok: z.number(), failed: z.number() })

/** `POST /api/plugins/dev` — a `VerifyReport` plus the resulting slot when it built successfully. */
export const PluginDevPutResponseSchema = VerifyReportSchema.extend({ slot: DevSlotSchema.optional() })

/** `DELETE /api/plugins/:name/:version`. */
export const PluginRemoveResponseSchema = z.object({ removed: z.boolean(), kvDeleted: z.number() })

/** `POST /api/plugins/:name/disable` and `DELETE /api/plugins/dev/:name` — both answer a bare acknowledgement. */
export const PluginOkResponseSchema = z.object({ ok: z.boolean() })

/**
 * The four `/api/plugins/:name/data/*` responses (plan 108 §4.5, step 108.4).
 *
 * Every entry on the wire is the SAME `KvEntrySchema` `/api/kv` already
 * defines — deliberately reused rather than redefined, because both routes
 * pass through the same `redactEntry` boundary and a second copy of the
 * shape is a second place for that promise to drift. A secret's `value` is
 * always `null` here too.
 */
export const PluginDataListResponseSchema = z.object({
  items: z.array(KvEntrySchema),
  nextCursor: z.string().nullable(),
})
export type PluginDataListResponse = z.infer<typeof PluginDataListResponseSchema>

/** `PUT /api/plugins/:name/data/entry` — the written entry, redacted. */
export const PluginDataEntryResponseSchema = KvEntrySchema
export type PluginDataEntryResponse = z.infer<typeof PluginDataEntryResponseSchema>

/**
 * `GET /api/plugins/:name/data/count` — the two numbers the Remove dialog states BEFORE it
 * offers to delete a plugin's stored data (P4). The namespace is the plugin NAME, shared by
 * every version of it, so these counts describe the plugin as a whole and not the one version
 * being removed.
 */
export const PluginDataCountResponseSchema = z.object({ global: z.number(), device: z.number() })
export type PluginDataCountResponse = z.infer<typeof PluginDataCountResponseSchema>

/**
 * `GET /api/plugins/:name/data/scan?key=…` — one row per device, whether or
 * not it holds the key (`entry: null` when it does not).
 *
 * The device fields are the FIXED allowlist of plan §3.6 — `deviceId`,
 * `stableId`, `label`, `status`, `clusterId`, `number` — and nothing else.
 * Anything richer is a handler, and handlers are plan 109.
 *
 * `number` is the device's short, human-facing number (`device_numbers`,
 * keyed on `stableId`), LEFT JOINed by the same single statement the entry
 * is: a device with no reservation reports `null`, exactly as a device with
 * no entry reports `entry: null`. It is stable identity, never a row index.
 */
export const PluginDataScanRowSchema = z.object({
  deviceId: z.string(),
  stableId: z.string(),
  label: z.string(),
  status: z.string().nullable(),
  clusterId: z.string().nullable(),
  number: z.number().int().nullable(),
  entry: KvEntrySchema.nullable(),
})
export type PluginDataScanRow = z.infer<typeof PluginDataScanRowSchema>

export const PluginDataScanResponseSchema = z.object({
  items: z.array(PluginDataScanRowSchema),
  nextCursor: z.string().nullable(),
})
export type PluginDataScanResponse = z.infer<typeof PluginDataScanResponseSchema>

/**
 * Where a live surface came from (plan 108 §3.5, §5 step 108.6). `'plugin'`
 * is the ACTIVE published version; `'dev'` is an unpublished dev slot, which
 * Studio flags with a `DEV` chip (criterion 7) and which SHADOWS a published
 * plugin of the same name — the same precedence plan 82 §3.5 already set for
 * a dev script.
 */
export const PluginSurfaceOriginSchema = z.enum(['plugin', 'dev'])
export type PluginSurfaceOrigin = z.infer<typeof PluginSurfaceOriginSchema>

/** One live plugin's contribution to the sidebar. */
export const PluginUiEntrySchema = z.object({
  plugin: z.string(),
  /** The active version, or a dev slot's `buildVersion` (`1.2.0+dev.3`). */
  version: z.string(),
  origin: PluginSurfaceOriginSchema,
  nav: z.array(NavEntrySchema),
})
export type PluginUiEntry = z.infer<typeof PluginUiEntrySchema>

/**
 * `GET /api/plugins/ui` (plan 108 §4.5) — active plugins and dev slots only,
 * never a staged/failed/superseded/disabled one (criterion 6). A plugin whose
 * surface declares no nav entry is absent rather than present-and-empty:
 * there is nothing for the sidebar to draw.
 */
export const PluginUiResponseSchema = z.object({ items: z.array(PluginUiEntrySchema) })
export type PluginUiResponse = z.infer<typeof PluginUiResponseSchema>

/**
 * `GET /api/plugins/:name/view/:viewId` (plan 108 §4.5) — the view plus ONLY
 * the actions it references, never the whole action map: a screen has no use
 * for another screen's actions, and shipping them would put a `confirm`
 * string and a script reference in front of an operator for a button that
 * page cannot draw.
 */
export const PluginViewResponseSchema = z.object({
  plugin: z.string(),
  version: z.string(),
  origin: PluginSurfaceOriginSchema,
  viewId: z.string(),
  view: ViewSpecSchema,
  actions: z.record(SurfaceIdSchema, ActionSpecSchema),
})
export type PluginViewResponse = z.infer<typeof PluginViewResponseSchema>

/**
 * `POST /api/plugins/:name/action/:actionId`'s body (plan 108 §4.5) — what
 * the browser sends, and the ONLY three things it may send: the row the
 * action was invoked from, the values a `form` action's dialog collected, and
 * the devices a `picker`/`selection` target chose.
 *
 * There is no `params`, no `script`, and no `scope` member, and that is the
 * point: everything else about what the action does comes from the VERIFIED
 * surface, server-side. A browser can choose which declared action to run and
 * over which row — never what it does.
 */
export const PluginActionBodySchema = z.object({
  row: z.unknown().optional(),
  form: z.unknown().optional(),
  deviceIds: z.array(z.string().min(1)).max(1000).optional(),
})
export type PluginActionBody = z.infer<typeof PluginActionBodySchema>

/** What an executed action actually did — one variant per `ActionSpec.kind` (a `form` reports whatever its `then` reports). */
export const PluginActionResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('job'), jobId: z.string(), deviceId: z.string(), scriptId: z.string() }),
  z.object({ kind: z.literal('batch'), batchId: z.string(), scriptId: z.string(), jobCount: z.number() }),
  z.object({ kind: z.literal('kv.set'), scope: z.enum(['global', 'device']), stableId: z.string().nullable(), key: z.string() }),
  z.object({ kind: z.literal('kv.delete'), scope: z.enum(['global', 'device']), stableId: z.string().nullable(), key: z.string(), deleted: z.boolean() }),
])
export type PluginActionResult = z.infer<typeof PluginActionResultSchema>

export const PluginActionResponseSchema = z.object({
  plugin: z.string(),
  actionId: z.string(),
  result: PluginActionResultSchema,
})
export type PluginActionResponse = z.infer<typeof PluginActionResponseSchema>
