import { z } from 'zod'
import { ActionSpecSchema, NavEntrySchema, PluginSurfaceSchema, SurfaceIdSchema, ViewSpecSchema } from '../plugin-surface'
import { PluginResetItemSchema, PluginServiceDeclarationSchema, PluginServiceStatusSchema } from '../plugin-service'
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
    /**
     * Plan 109 §4.1, step 109.2 — the verified service declaration, stored in
     * the same JSON column as `scripts` and `surface` and shipped on the wire
     * with them. Absent for every plugin that declares no long-lived server
     * half, which is most of them.
     *
     * Declared here late, and the reason is the same silent-strip hazard that
     * cost `captured` a week: the core has been **sending** this since 109.2,
     * but this schema predates that plan and a Zod object drops an undeclared
     * key without a word — so the plugin detail page (step 112's sibling work)
     * found the field on the wire and gone after the parse, and had to
     * re-admit it locally to show an operator the permissions they consented
     * to at install. That local re-admit can be deleted now.
     */
    service: PluginServiceDeclarationSchema.optional(),
  })
  .nullable()

/**
 * One row of `plugins` — one version. Several versions of the same `name` can be
 * listed at once (active plus every superseded one, plan 82 §4.4).
 *
 * ## What is deliberately NOT here, and what the core does about it
 *
 * `bundle` (the complete built JavaScript pack, ~1 MB per version), `source`,
 * `bundleHash` and `resetPackages` are columns of that table and are **not**
 * declared here. That was true from the day this schema was written, and for
 * most of that time it was a lie the wire told: the core sent them anyway and
 * Zod silently stripped them on arrival, so every reader downloaded a megabyte
 * and discarded it on the next line. Plan 126 closed that on the read routes
 * (step 126.1) and then on the write ones (step 126.6) — `POST /api/plugins`,
 * `POST /:id/activate`, `POST /:name/rollback` and `POST /:name/enable`, where
 * a publish sent the bundle up and got the same bytes straight back down.
 *
 * The core now has no way to send them: `plugins/runtime.ts` hands routes a
 * `PluginWireRow`, a type with no such member, and `api/plugins.ts` does not
 * import the table row at all. So this schema and the server finally agree,
 * and the agreement is enforced on the sending side rather than papered over on
 * the receiving one.
 *
 * The list route answers `PluginListItemSchema` below instead — narrower still,
 * because a farm pays for that shape once per VERSION.
 */
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

/**
 * One row of `GET /api/plugins` — **not** a `PluginRow` (plan 126 §3.2, §4.1).
 *
 * ## Why the list has a shape of its own
 *
 * `PluginRowSchema` above is what ONE version looks like when a caller asked
 * for that version. The list answers a different question — *"what does this
 * farm carry"* — and a farm carries every version of every plugin it has ever
 * published: the farm this was written for holds 20+ `tiktok` rows and a dozen
 * `networking` ones (see `PluginBulkRemoveBodySchema`'s note on why history
 * accumulates). Anything on this schema is therefore paid for **per version**,
 * and the two things `PluginRowSchema` carries that the list never renders are
 * the two largest:
 *
 *  - `manifest.scripts[].paramsSchema`/`.resultSchema` — a full JSON Schema per
 *    member per version, where the list reads only `.id`/`.title`;
 *  - `manifest.surface` — the whole declared screen, which the list does not
 *    render at all.
 *
 * So the manifest is projected down to `declaredScripts` and `hasService`, the
 * exact two things the Plugins screen reads out of it, mirroring how
 * `ScriptListItemSchema`'s `hasResult` stands in for a script's `resultSchema`
 * (`./scripts.ts` — *"a list payload has no business paying for every row's own
 * schema"*). **`manifest` itself lives on `GET /api/plugins/:name/:version`**,
 * which is where a screen that needs the surface or the service declaration
 * reads it (§3.3).
 *
 * The plugin BUNDLE was never declared here or on `PluginRowSchema`, and the
 * core no longer selects it: `plugins/runtime.ts`'s list query names its
 * columns, so `bundle`, `source`, `bundleHash` and `resetPackages` are absent
 * by construction rather than stripped by this schema after a ~1 MB-per-row
 * download the browser threw away (§0.1, §3.1).
 *
 * ## Timestamps are ISO strings here, deliberately
 *
 * `createdAt`/`verifiedAt` are `z.string()`, matching `PluginRowSchema` and the
 * file-header note above: this router does not go through `typedJson`, so a
 * `Date` column reaches the wire as `Date.prototype.toJSON`. Plan 126 §4.1
 * sketched them as unix seconds; making that change here would be a WIRE FORMAT
 * change to a route this plan is only meant to slim down, and it would break
 * every reader that currently `Date.parse`es them. Left as it is on purpose —
 * the header comment is the standing record of why.
 */
export const PluginListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  /**
   * `.default(null)` on the three nullable identity columns, matching
   * `PluginRowSchema`'s own leniency: these are `text` columns that are null for
   * most rows, and a caller that omits the key entirely means the same thing as
   * one that sends `null`. The fields this plan ADDED are required instead —
   * see `scriptCount`/`declaredScripts`/`hasService` below.
   */
  title: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  status: PluginStatusSchema,
  verifiedAt: z.string().nullable(),
  /** Verbatim from the verification child (plan 82 §4.6) — rendered as-is, never summarised. */
  verifyError: z.string().nullable(),
  verifyErrorCode: z.string().nullable(),
  /** A live count of registered `scripts` rows, not the manifest's declared count (0 for a `failed` plugin, since nothing registered). */
  scriptCount: z.number().int(),
  /**
   * What the list renders out of `manifest.scripts`: the id and the human title
   * of each member this version declared, and never its params or result schema
   * (§3.2). `title` is absent for a member that declared none — the same
   * optionality `VerifiedScriptSchema.title` has, kept rather than filled with
   * an empty string so "no title" and "titled with nothing" stay distinct.
   *
   * Empty for a `failed` version whose bundle never got far enough to report a
   * manifest at all, which is a real state the screen already words.
   */
  declaredScripts: z.array(z.object({ id: z.string(), title: z.string().optional() })),
  /** The one bit `manifest.service` contributes to this screen: the "service" chip. Everything else about the declaration — the permissions, listeners, events, webhooks an operator consented to — is on the detail route. */
  hasService: z.boolean(),
  createdBy: z.string().nullable().default(null),
  createdAt: z.string(),
})
export type PluginListItem = z.infer<typeof PluginListItemSchema>

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

/** `GET /api/plugins` — `items` are `PluginListItem`s, not full rows; see that schema for why. */
export const PluginsListResponseSchema = z.object({
  items: z.array(PluginListItemSchema),
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

/**
 * `POST /api/plugins` (stage, optionally verify in the same call).
 *
 * **The response does not echo the upload** (plan 126 step 126.6). The request
 * body of this route is the bundle — up to a `.enkaku` package's worth of it —
 * and until that step `plugin` was the raw table row, so a publish paid for the
 * same ~1 MB twice, once in each direction, to show a dialog a version string.
 * See `PluginRowSchema`'s note for how the core makes that unrepeatable.
 */
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
 *
 * All three carry the same projected row every other `{ plugin }` on this
 * router carries (step 126.6) — a click on Activate, Roll back or Enable used
 * to pull that version's whole bundle down with the acknowledgement.
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
 * ## Reset data — `POST /api/plugins/:name/reset`
 *
 * The farm owner's ask: *"di plugins ada opsi buat reset data dong … terus
 * trigger reset function handler juga di pluginsnya. contoh ketika plugin proxy
 * manager di reset, selain hapus semua data, plugin proxy manager juga harus set
 * network proxy ke off dulu ke device yang pernah diassign … jadi biar ga
 * error."*
 *
 * **The handler runs BEFORE the data is deleted, and that ordering is the whole
 * feature.** The plugin's stored data is what tells it which phones it touched;
 * deleting first and notifying after would hand the handler an empty namespace
 * and leave live routes on real devices that nothing in the farm can any longer
 * explain.
 *
 * ### Three outcomes, and the middle one is not a success
 *
 * | `status` | what happened | was the data deleted? |
 * |---|---|---|
 * | `reset` | cleanup finished, or there was none to do | yes |
 * | `reset-with-debts` | cleanup could not finish, but every unfinished piece is now recorded somewhere that outlives this plugin's data (`PLUGIN_RESET_OUTCOMES`' `pending`) | yes |
 * | `blocked` | at least one piece of cleanup **failed** — the undo did not happen and nothing is holding the obligation | **no. Nothing was deleted.** |
 *
 * `blocked` deletes nothing at all, not even the parts that cleaned up fine.
 * A partial delete would destroy the record of exactly the devices still
 * carrying whatever the plugin left on them, which is the orphan this action
 * exists to prevent. The handler is required to be idempotent and re-runnable
 * (`defineService({ onReset })` says so), so the operator's move is to fix the
 * cause and press Reset again.
 *
 * Always answered `200`, including `blocked`: a partly-completed pass is a
 * completed request whose report IS the answer, and a 4xx would tell a caller
 * nothing happened when eleven phones were just un-routed. Request-level
 * refusals (no such plugin, the service is not running) still throw.
 */
export const PLUGIN_RESET_STATUSES = ['reset', 'reset-with-debts', 'blocked'] as const
export type PluginResetStatus = (typeof PLUGIN_RESET_STATUSES)[number]

/** Why a declared reset handler did not run, or how it ended badly. A code plus the sentence a person reads. */
export const PluginResetFaultSchema = z.object({ code: z.string(), message: z.string() })

export const PluginResetResponseSchema = z.object({
  plugin: z.string(),
  status: z.enum(PLUGIN_RESET_STATUSES),
  handler: z.object({
    /** Whether the ACTIVE version's manifest declares one at all. */
    declared: z.boolean(),
    /** Whether plugin code was actually entered. `false` with `declared: true` always carries a `skipped` or an `error`. */
    ran: z.boolean(),
    /** Present when the handler was not entered — the service is not running, say. Never a silent `ran: false`. */
    skipped: PluginResetFaultSchema.nullable(),
    /** Present when the handler was entered and threw, overran its deadline, or answered a report shape the farm could not parse. */
    error: PluginResetFaultSchema.nullable(),
    items: z.array(PluginResetItemSchema),
    note: z.string().nullable(),
    counts: z.object({ cleared: z.number(), unchanged: z.number(), pending: z.number(), failed: z.number() }),
  }),
  data: z.object({
    deleted: z.boolean(),
    /** Why nothing was deleted, when nothing was. `null` on a delete that happened. */
    keptBecause: z.string().nullable(),
    /** Rows actually removed, split by scope so "8 device entries across 3 phones" is sayable. */
    entries: z.number(),
    global: z.number(),
    device: z.number(),
    /** How many devices held at least one row under this namespace. */
    devices: z.number(),
  }),
  /** One sentence stating what happened, written server-side so the CLI and the browser cannot word the same outcome differently. */
  message: z.string(),
})
export type PluginResetResponse = z.infer<typeof PluginResetResponseSchema>

/**
 * ## Bulk version removal — `POST /api/plugins/:name/versions/remove`
 *
 * The farm owner's ask, verbatim: *"remove di plugins itu bisa remove specific
 * versi, atau remove all version, atau remove all except latest version"*.
 * The first of the three is `DELETE /:name/:version`, which already exists and
 * is not duplicated here. These two are the other two.
 *
 * **Why version history needs pruning at all.** It accumulates per publish and
 * nothing ever collects it: the farm this was written for carries 20+ `tiktok`
 * rows and a dozen `networking` ones. "All except the latest" is the one an
 * operator actually reaches for — routine housekeeping that must not touch what
 * is live — which is why the keep set below is wider than the name suggests.
 */
export const PluginVersionRemovalScopeSchema = z.enum(['all', 'except-latest'])
export type PluginVersionRemovalScope = z.infer<typeof PluginVersionRemovalScopeSchema>

export const PluginBulkRemoveBodySchema = z.object({
  scope: PluginVersionRemovalScopeSchema,
  /**
   * The same flag `DELETE /:name/:version?deleteKv=1` carries, and it means the
   * same thing: the KV namespace is the plugin NAME, shared by every version, so
   * this is a property of the whole request rather than of any one row. Honoured
   * exactly once — on the last version this request actually removes — because
   * running `deleteNamespace` eleven times would report eleven counts for one
   * deletion and the operator would read the total as eleven times too large.
   */
  deleteKv: z.boolean().optional(),
})
export type PluginBulkRemoveBody = z.infer<typeof PluginBulkRemoveBodySchema>

/**
 * Why a version was NOT removed although the request covered its plugin.
 *
 * These are `skip` codes, never errors: nothing was attempted on the row, and
 * that is the correct outcome rather than a failure to report. Each one is a
 * separate code so the screen can say which rule saved which row — "the active
 * one" and "the newest one" are usually the same row and sometimes are not, and
 * collapsing them would hide exactly the divergence an operator needs to see.
 */
export const PLUGIN_VERSION_KEEP_LATEST = 'plugin_kept_latest'
export const PLUGIN_VERSION_KEEP_ACTIVE = 'plugin_kept_active'
export const PLUGIN_VERSION_KEEP_DISABLED = 'plugin_kept_disabled'
export const PLUGIN_VERSION_KEEP_VERIFYING = 'plugin_kept_verifying'
/** A status this build does not recognise — see `PLUGIN_VERSION_REMOVABLE_STATUSES`. */
export const PLUGIN_VERSION_KEEP_UNRECOGNISED = 'plugin_kept_unrecognised_status'

/**
 * The ONLY statuses `except-latest` will prune, stated as an allowlist rather
 * than as a list of statuses to protect.
 *
 * The difference is the whole safety property. `plugins.status` is a plain
 * `text` column, so a value this build has never heard of is representable; with
 * a denylist ("keep `active`, `disabled`, `verifying`") such a row would fall
 * through into the delete list, which is the one direction this must never fail
 * in. With an allowlist it is kept and NAMED
 * (`PLUGIN_VERSION_KEEP_UNRECOGNISED`), so a farm whose schema has moved on
 * prunes less than asked and says so, instead of deleting what it cannot read.
 */
export const PLUGIN_VERSION_REMOVABLE_STATUSES: readonly string[] = ['staged', 'superseded', 'failed']

/**
 * One version's outcome, following `DeviceNetworkApplyResultSchema`'s grain
 * (plan 114 §3.9) rather than inventing a third bulk report format:
 *
 * - **removed** — `skip` and `error` both null. The row is gone.
 * - **kept** — `skip` present. The row was deliberately not attempted; the code
 *   is one of the four `PLUGIN_VERSION_KEEP_*` above and `message` says which
 *   rule in the operator's own words.
 * - **failed** — `error` present. Removal was attempted and refused; chiefly
 *   `script_in_use`, which means a queued or running job still names one of this
 *   version's scripts. That is the core protecting a live job, not a bug, and it
 *   is reported per version rather than failing the whole request.
 *
 * `status` is the row's status as it stood when the request was planned, which
 * is what makes a keep reason checkable after the fact.
 */
export const PluginVersionRemovalResultSchema = z.object({
  id: z.string(),
  version: z.string(),
  /**
   * The row's status verbatim, as it stood when the request was planned — which
   * is what makes a keep reason checkable after the fact.
   *
   * `z.string()` and not `PluginStatusSchema`, deliberately: `plugins.status` is
   * a `text` column, and a value this build does not recognise is exactly the
   * case `PLUGIN_VERSION_KEEP_UNRECOGNISED` exists to report. A schema that
   * refused to carry it would make the one row worth naming the one row the
   * report could not describe.
   */
  status: z.string(),
  /** Entries deleted from the plugin's KV namespace by THIS row's removal — non-zero on at most one result per request (see `deleteKv` above). */
  kvDeleted: z.number().int(),
  skip: z.object({ code: z.string(), message: z.string() }).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type PluginVersionRemovalResult = z.infer<typeof PluginVersionRemovalResultSchema>

/**
 * `POST /api/plugins/:name/versions/remove`.
 *
 * **Partial success is a 200.** Removing nine of eleven with two named refusals
 * is what this route is FOR — the refusals are the report, not an error — so
 * there is no `ok` member to misread and the caller classifies each row itself.
 * `total` is every version the plugin had when the request was planned, so
 * `results.length === total` always: a kept row is a result, not an omission.
 *
 * `webhooksDeleted` mirrors what the single-version route already does (plan 109
 * step 109.7): a plugin's webhook secrets are dropped only when NOTHING named
 * `name` is left, because a secret must survive a rollback. Non-zero here means
 * the whole plugin is gone.
 */
export const PluginBulkRemoveResponseSchema = z.object({
  plugin: z.string(),
  scope: PluginVersionRemovalScopeSchema,
  total: z.number().int(),
  results: z.array(PluginVersionRemovalResultSchema),
  webhooksDeleted: z.number().int(),
})
export type PluginBulkRemoveResponse = z.infer<typeof PluginBulkRemoveResponseSchema>

export type PluginVersionRemovalOutcome = 'removed' | 'kept' | 'failed'

/**
 * The one rule that turns a result row into an outcome class, declared beside
 * the schema and used by both sides — the same discipline
 * `classifyDeviceNetworkApply` follows, and for the same reason: two copies of a
 * classification drift, and the moment they do a count on screen stops matching
 * the list underneath it.
 */
export function classifyPluginVersionRemoval(result: PluginVersionRemovalResult): PluginVersionRemovalOutcome {
  if (result.skip !== null) return 'kept'
  if (result.error !== null) return 'failed'
  return 'removed'
}

/**
 * Semver order over two plugin versions, `-1 | 0 | 1`.
 *
 * `StageBody` in the core admits `\d+\.\d+\.\d+(?:[-+].+)?`, so the numeric core
 * always parses; a suffix may be a prerelease (`-rc.1`), build metadata
 * (`+dev.3`), or absent. Semver's own rule is followed for the first — a
 * prerelease sorts BELOW the release it precedes, so `1.2.0-rc.1 < 1.2.0` — and
 * build metadata is ignored for ordering, which is why `1.2.0+dev.3` and
 * `1.2.0` compare equal and fall through to the caller's tie-break.
 *
 * A version that does not parse at all sorts below every one that does, rather
 * than throwing: this runs on the way to deciding what to DELETE, and a row the
 * comparator cannot read must never be mistaken for the newest one.
 */
export function comparePluginVersions(a: string, b: string): number {
  const parse = (v: string): { core: [number, number, number]; pre: string | null } | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:([-+]).+)?$/.exec(v)
    if (!m) return null
    const pre = m[4] === '-' ? v.slice(v.indexOf('-') + 1).split('+')[0]! : null
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa && !pb) return a === b ? 0 : a < b ? -1 : 1
  if (!pa) return -1
  if (!pb) return 1
  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! !== pb.core[i]!) return pa.core[i]! < pb.core[i]! ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  // A release outranks any prerelease of the same core (semver §11.3).
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre < pb.pre ? -1 : 1
}

/**
 * The minimum a caller must know about a version for the plan below —
 * structurally satisfied by a `PluginRow` from `GET /api/plugins` and by a
 * `plugins` row read straight out of the core's database.
 *
 * `status` is `string`, matching the `text` column it comes from rather than
 * narrowing it: see `PLUGIN_VERSION_REMOVABLE_STATUSES` on why a value this
 * build cannot classify has to survive the trip rather than be parsed away.
 */
export interface PluginVersionCandidate {
  id: string
  version: string
  status: string
}

export interface PluginVersionRemovalPlan<T extends PluginVersionCandidate> {
  remove: T[]
  keep: { candidate: T; code: string; message: string }[]
}

/**
 * Which versions a bulk removal takes and which it leaves — **the single
 * definition of both scopes, shared by the core and by Studio's confirm
 * dialog.**
 *
 * Shared rather than restated, for the same reason `classifyDeviceNetworkApply`
 * is: a destructive dialog that promises "these nine go, these two stay" and a
 * server that then applies a slightly different rule is worse than no dialog at
 * all. Studio calls this to WRITE the confirm; the core calls it to DO the work.
 *
 * ## `except-latest` keeps four things, not one
 *
 * **The latest version and the active version are not the same row.** They
 * usually coincide; a rollback is precisely the case where they do not, leaving
 * an older version `active` while a newer one sits `superseded`. A housekeeping
 * action that silently deleted the row the farm is currently running would be
 * the worst possible outcome of routine pruning, so `except-latest` keeps:
 *
 * 1. the highest version by semver (`PLUGIN_VERSION_KEEP_LATEST`) — what the
 *    label on the button says;
 * 2. the `active` row, whichever version that is (`..._KEEP_ACTIVE`) — what the
 *    farm is running right now;
 * 3. the `disabled` row (`..._KEEP_DISABLED`) — the version `POST /:name/enable`
 *    puts back, and the ONLY row that verb can reach. Deleting it is deleting
 *    the switched-off farm's way back on;
 * 4. any `verifying` row (`..._KEEP_VERIFYING`) — a publish is mid-flight
 *    against it right now;
 * 5. any row whose status this build does not recognise at all
 *    (`..._KEEP_UNRECOGNISED`) — see `PLUGIN_VERSION_REMOVABLE_STATUSES`.
 *
 * Each keep carries its own code, so a row kept for two reasons still reports
 * the most specific one (active/disabled/verifying beat latest — the operator
 * pruning history wants to be told "this one is live", not "this one is newest").
 *
 * ## `all` keeps nothing
 *
 * "Remove all versions" is the uninstall, and it means all — including the
 * active row, exactly as `DELETE /:name/:version` already allows for a single
 * one. What still protects the farm there is not a keep rule but the per-version
 * refusal: a version a queued or running job still names is refused
 * (`script_in_use`) and reported, never bulldozed.
 */
export function planPluginVersionRemoval<T extends PluginVersionCandidate>(
  candidates: readonly T[],
  scope: PluginVersionRemovalScope,
): PluginVersionRemovalPlan<T> {
  /**
   * Oldest first, in both scopes. Both returned lists are in this order: it is
   * the order the core deletes in and the order the dialog lists in, and a
   * confirm that enumerated the versions in a different order from the one the
   * server works through would be describing a different plan.
   *
   * Oldest first also fails in the right direction — if a removal is refused
   * part-way (a queued job holding a version), what survives is the newest end
   * of the history rather than a random middle.
   *
   * The id breaks a tie, so two rows carrying the same version string (a
   * `+build` pair, or two the comparator cannot read) order the same way every
   * time — and so the dialog and the server pick the same "latest".
   */
  const ordered = [...candidates].sort((a, b) => comparePluginVersions(a.version, b.version) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  if (scope === 'all') return { remove: ordered, keep: [] }

  const latest = ordered[ordered.length - 1]

  const remove: T[] = []
  const keep: PluginVersionRemovalPlan<T>['keep'] = []
  for (const c of ordered) {
    if (c.status === 'active') {
      keep.push({ candidate: c, code: PLUGIN_VERSION_KEEP_ACTIVE, message: `${c.version} is the version this farm is running` })
    } else if (c.status === 'disabled') {
      keep.push({
        candidate: c,
        code: PLUGIN_VERSION_KEEP_DISABLED,
        message: `${c.version} is disabled, and Enable puts back this exact version — removing it removes the way back`,
      })
    } else if (c.status === 'verifying') {
      keep.push({ candidate: c, code: PLUGIN_VERSION_KEEP_VERIFYING, message: `${c.version} is being verified right now` })
    } else if (!PLUGIN_VERSION_REMOVABLE_STATUSES.includes(c.status)) {
      keep.push({
        candidate: c,
        code: PLUGIN_VERSION_KEEP_UNRECOGNISED,
        message: `${c.version} is "${c.status}", which this farm cannot classify — it is kept rather than guessed at`,
      })
    } else if (latest && c.id === latest.id) {
      keep.push({ candidate: c, code: PLUGIN_VERSION_KEEP_LATEST, message: `${c.version} is the latest version` })
    } else {
      remove.push(c)
    }
  }
  return { remove, keep }
}

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
 * Plan 109 §4.6, step 109.6 — one row from a `ctx.onQuery` handler, and the
 * wire shape of `GET /api/plugins/:name/query/:queryId`.
 *
 * **The same row a `kv.scan` produces**, deliberately: `value` is the row's own
 * data, `device`/`entry` are the two context objects `ViewRenderer` reads
 * `$device.*`/`$entry.*` from. One shape means a handler-backed table goes
 * through the SAME `readRowField`/`planColumn` path a `kv.scan` table does —
 * no second renderer, no second field vocabulary, and `POST /:name/action/:id`
 * lifts `$device` out of a handler row exactly as it does out of a scanned one.
 *
 * The device fields are the plan 108 §3.6 allowlist and nothing else. A handler
 * FILLS them rather than the core joining them, which changes nothing about
 * what a caller may then do with them: `action-executor.ts` already re-parses
 * `$device` out of the POSTed row (`RowDeviceSchema`) precisely because the row
 * crossed a wire, and re-resolves the device itself before dispatching.
 */
export const PluginQueryDeviceSchema = z.object({
  id: z.string(),
  stableId: z.string(),
  label: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  clusterId: z.string().nullable().default(null),
  number: z.number().int().nullable().default(null),
})

export const PluginQueryEntrySchema = z.object({
  key: z.string(),
  version: z.number().int(),
  /** Unix seconds, the same unit every other timestamp on this surface uses. */
  updatedAt: z.number().int(),
})

export const PluginQueryRowSchema = z.object({
  /**
   * The React key and the selection key. Optional: the route fills in the row's
   * index when a handler does not supply one, which is right for a read-only
   * table and wrong the moment rows can be selected across a refetch — so a
   * handler feeding a `selectable` table should supply a stable id of its own.
   */
  id: z.string().min(1).max(200).optional(),
  value: z.unknown(),
  device: PluginQueryDeviceSchema.nullish(),
  entry: PluginQueryEntrySchema.nullish(),
})
export type PluginQueryRow = z.infer<typeof PluginQueryRowSchema>

/**
 * What a `ctx.onQuery` handler returns. Validated by the core before it is
 * serialised — a plugin's output crosses the same wire a browser reads, so it
 * is external input like any other, and a handler that answers a string gets a
 * coded failure naming its own plugin rather than a Studio parse error naming
 * nothing.
 *
 * `PLUGIN_QUERY_MAX_ROWS` is a page, not a total: a handler that has more says
 * so with `nextCursor`, and Studio walks the pages the same capped way
 * `fetchPluginRows` already does for `kv.scan`.
 */
export const PLUGIN_QUERY_MAX_ROWS = 1000
export const PluginQueryResultSchema = z.object({
  rows: z.array(PluginQueryRowSchema).max(PLUGIN_QUERY_MAX_ROWS),
  nextCursor: z.string().max(500).nullish(),
})
export type PluginQueryResult = z.infer<typeof PluginQueryResultSchema>

/** `GET /api/plugins/:name/query/:queryId`. `items`/`nextCursor` to match the two `data/*` list shapes above, so Studio pages all three identically. */
export const PluginQueryResponseSchema = z.object({
  plugin: z.string(),
  queryId: z.string(),
  items: z.array(PluginQueryRowSchema),
  nextCursor: z.string().nullable(),
})
export type PluginQueryResponse = z.infer<typeof PluginQueryResponseSchema>

/** `POST /api/plugins/:name/runtime/restart` — the status the service landed in, never a bare `{ ok: true }`: `starting` is not `running` and the caller must be able to tell. */
export const PluginServiceRestartResponseSchema = z.object({
  plugin: z.string(),
  status: PluginServiceStatusSchema,
})
export type PluginServiceRestartResponse = z.infer<typeof PluginServiceRestartResponseSchema>

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
