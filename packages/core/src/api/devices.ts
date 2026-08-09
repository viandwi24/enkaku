import { Hono } from 'hono'
import {
  DeviceHistoryCountsResponseSchema,
  DeviceReadinessResponseSchema,
  DeviceResponseSchema,
  DeviceSettingsSchema,
  DeviceTagsResponseSchema,
  DeviceViewersResponseSchema,
  DevicesBlockedResponseSchema,
  MonitorKindSchema,
  MonitorSaveResponseSchema,
  ReadinessSchema,
  ReconcileReportSchema,
  defaultDeviceSettings,
  normaliseTag,
  validateEngineSelection,
  type DeviceSettings,
  type LeaseHolder,
  type Readiness,
  type ReconcileReport,
  type RegistryResponse,
  type ServerMessage,
  type ShellMode,
  type Viewer,
} from '@enkaku/protocol'
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { deletedDevices, devices, discoveredDevices } from '../db/schema'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { BatteryMonitor } from '../device/battery'
import type { DeviceLifecycle } from '../device/lifecycle'
import { staticReadinessFallback, type ReadinessManager } from '../device/readiness'
import type { EventRecorder } from '../events/recorder'
import type { LeaseManager } from '../lease/lease-manager'
import { assignDevices, unassignDevices } from '../clusters/membership'
import { admitDevice } from '../registry/admission'
import { clusterRefFor, loadClusterNames, rowToDeviceInfo } from '../registry/device-registry'
import { loadDeviceTags, replaceDeviceTags } from '../registry/device-tags'
import { saveForDevice } from '../runner/artifact-store'
import { EnkakuError } from '../util/errors'
import { createAdbEndpointRoutes } from './adb-endpoint'
import { createDeviceEventsRoutes } from './device-events'
import { createTransferRoutes, type TransferRoutesDeps } from './transfer'
import { decodeStringCursor, encodeCursor, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

const DriversBody = z.object({
  transport: z.string(),
  display: z.string(),
  input: z.string(),
  inspection: z.string(),
})

const PatchBody = z.object({
  label: z.string().min(1).optional(),
  ownerId: z.string().nullable().optional(),
  settings: z.unknown().optional(),
})

const TagsBody = z.object({ tags: z.array(z.string()) })

/** Plan 22.0 §4.4 — `PUT /:id/cluster`. `null` unassigns. */
const DeviceClusterBody = z.object({ clusterId: z.string().min(1).nullable() })

/** Plan 47 §4.4 — `POST /:id/block`. Every field optional: a bodyless call is valid. */
const BlockBody = z.object({ reason: z.string().min(1).optional() })

/** Plan 24 §4.6 — `POST /:id/monitor/save`. The Monitor pane's "save last N lines" action. */
const MonitorSaveBody = z.object({
  kind: MonitorKindSchema,
  lines: z.array(z.string()).min(1).max(5000),
})

const ERROR_STATUS: Record<string, number> = {
  device_not_found: 404,
  cluster_not_found: 404,
  E_BAD_REQUEST: 400,
  UNKNOWN_ENGINE: 400,
  ENGINE_UNAVAILABLE: 409,
  LOCK_CONFLICT: 409,
  REQUIREMENT_MISSING: 409,
  not_quarantined: 409,
  // Device readiness (plan 43 §3.4, §4.5) — the same codes `readiness.set` throws.
  device_offline: 409,
  device_quarantined: 409,
  job_running: 409,
  device_in_use: 409,
  E_NOT_SUPPORTED: 501,
  // Device lifecycle (plan 47 §3.5, §4.4) — the same codes `lifecycle.forget`/`block` throw.
  device_busy: 409,
  device_online: 409,
  not_blocked: 404,
}

/** `PUT /:id/readiness` (plan 43 §4.5). */
const ReadinessSetBody = z.object({
  desired: ReadinessSchema,
  /** The WS session id, when the caller is a browser tab that also holds a lease (plan 43 §3.4's "you hold the lease" check) — same pattern as plan 27/39's `clientId`. */
  clientId: z.string().min(1).optional(),
})

/** `POST /discovered/:stableId/admit` (plan 56 §4.3) — every field optional; a bodyless call admits with the probed label. */
const AdmitDeviceBodySchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  clusterId: z.string().optional(),
})

export function createDeviceRoutes(deps: {
  db: Db
  registry: () => Promise<RegistryResponse>
  battery: () => BatteryMonitor | null
  audit: AuditLogger
  /** Where `saveForDevice` writes the Monitor tab's "save last N lines" artifact (plan 24 §4.6). */
  dataDir: string
  /** Main-stream device event: settings.changed (plan 18 §4.2). */
  record?: EventRecorder['record']
  /**
   * The snapshot half of presence (plan 31 §3.4, §4.2): `/ws` has no replay,
   * so a client GETs the current viewer list before subscribing to
   * `device.viewers`. Backed by the same WS router that broadcasts it — no
   * second bookkeeping structure.
   */
  viewersOf?: (deviceId: string) => Viewer[]
  /**
   * The lease-scoped adb endpoint (plan 27 §4.2, §4.3) — undefined when the
   * adb subsystem is not up (orchestrator mode), same optionality as
   * `record` above; the mounted routes handle a missing manager by refusing
   * with `E_ADB_UNAVAILABLE` rather than the route simply not existing.
   */
  adbEndpoint?: {
    manager: AdbEndpointManager
    leases: LeaseManager
    shellSettings: () => { mode: ShellMode; endpointEnabled: boolean }
  }
  /**
   * File transfer and APK install (plan 39 §4.3, §4.4) — undefined when the
   * adb subsystem is not up (orchestrator mode), the same optionality as
   * `adbEndpoint` above.
   */
  transfer?: TransferRoutesDeps
  /**
   * Device readiness (plan 43 §4.5) — undefined only in orchestrator mode
   * (no local devices at all) or a test that does not wire it; the mounted
   * routes refuse with `E_NOT_SUPPORTED` rather than not existing.
   */
  readiness?: Pick<ReadinessManager, 'get' | 'set'>
  /**
   * Who currently holds a device's manual lease (plan 71 §3.2, §4.4) — the
   * lease manager's `getHolder`, threaded through so every `DeviceInfo` this
   * router builds carries it (criterion 1). Required, unlike `readiness`:
   * the lease manager exists in every mode this router is mounted in.
   */
  heldByOf: (deviceId: string) => LeaseHolder | null
  /**
   * Device lifecycle — Forget and Block (plan 47 §4.3, §4.4). Required
   * (unlike `adbEndpoint`/`transfer`/`readiness` above): it depends only on
   * `db` and the lease manager, both of which exist in every mode,
   * including the orchestrator (constructed before that mode's early return
   * in daemon.ts).
   */
  /**
   * Farm defaults, applied when a device is ADMITTED (plan 56 §4.3). They used
   * to be applied by the registry on first enrolment; admission moved that
   * moment, because the registry no longer creates rows.
   */
  /** Bring a just-admitted device online if it is currently connected (plan 56) — see `DeviceRegistry.admitted`. */
  onAdmitted?: (stableId: string) => void
  /**
   * `POST /rescan` (plan 85 §3.3, §4.4, §4.6) — the manual escape hatch for
   * the discovery reconciler: "the first thing a human does when a phone is
   * missing is look for that button." `undefined`/`null` (orchestrator
   * mode, or the adb subsystem never came up) refuses with `E_NOT_SUPPORTED`
   * rather than the route not existing at all — same optionality pattern as
   * `readiness` below.
   */
  rescan?: () => Promise<ReconcileReport> | null
  deviceDefaults?: () => DeviceSettings
  /** `readiness.defaultDesired` (plan 43 §4.4) — a separate accessor for the same reason it is one in the registry. */
  defaultDesiredReadiness?: () => Readiness
  lifecycle: DeviceLifecycle
  /** `device.removed` on Forget/Block (plan 47 §4.4) — the same broadcast the Studio fleet list already listens for, previously never sent by anything. */
  broadcast: (msg: ServerMessage) => void
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  // GET /:id/events — the device event log (plan 18 §4.5), mounted here so it
  // lives under /api/devices/:id/events without a separate entry in http.ts.
  app.route('/', createDeviceEventsRoutes({ db }))

  // GET /refs?ids=a,b,c (plan 47 §4.5) — dangling-reference resolution: a job,
  // batch, or schedule keeps a plain `deviceId` after the device it points at
  // is forgotten (§3.4), so any UI rendering one needs a label to show —
  // `deleted device (<stableId>)` rather than a blank. Mounted as a static
  // route BEFORE `/:id` below so it is never shadowed by the param route.
  app.get('/refs', (c) => {
    const ids = (c.req.query('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const refs: Record<string, { id: string; label: string | null; stableId: string; deleted: boolean }> = {}
    if (ids.length > 0) {
      const liveRows = db.select({ id: devices.id, label: devices.label, stableId: devices.stableId }).from(devices).where(inArray(devices.id, ids)).all()
      for (const r of liveRows) refs[r.id] = { id: r.id, label: r.label, stableId: r.stableId, deleted: false }
      const missing = ids.filter((id) => !(id in refs))
      if (missing.length > 0) {
        const deletedRows = db.select().from(deletedDevices).where(inArray(deletedDevices.id, missing)).all()
        for (const r of deletedRows) refs[r.id] = { id: r.id, label: r.label, stableId: r.stableId, deleted: true }
      }
    }
    return c.json({ refs })
  })

  // GET /blocked, DELETE /blocked/:stableId (plan 47 §4.4) — the Blocked
  // devices list in farm Settings. Static routes, mounted before `/:id`
  // below for the same shadowing reason as `/refs` above.
  app.get('/blocked', requirePermission('device.settings'), async (c) => {
    return typedJson(c, DevicesBlockedResponseSchema, { blocked: await deps.lifecycle.listBlocked() })
  })

  app.delete('/blocked/:stableId', requirePermission('device.settings'), async (c) => {
    const stableId = c.req.param('stableId')
    await deps.lifecycle.unblock(stableId, { userId: c.get('user')?.id ?? null })
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'device.unblock', target: stableId })
    return c.json({ ok: true })
  })

  /**
   * The Discovered tray (plan 56 §4.3). Static routes, mounted before `/:id`
   * for the same shadowing reason as `/blocked` above.
   *
   * These are keyed on `stableId`, not on a device id, because a discovered
   * phone has no device row — that is the entire point of the plan.
   */
  app.get('/discovered', requirePermission('device.settings'), (c) => {
    const rows = deps.db.select().from(discoveredDevices).all()
    return c.json({
      discovered: rows
        .map((r) => ({
          stableId: r.stableId,
          serial: r.serial,
          label: r.label,
          androidVersion: r.androidVersion,
          firstSeen: r.firstSeen ? Math.floor(r.firstSeen.getTime() / 1000) : null,
          lastSeen: r.lastSeen ? Math.floor(r.lastSeen.getTime() / 1000) : null,
        }))
        // Longest-waiting first: the tray is a queue of decisions, and the
        // phone that has been waiting since Tuesday is the one to deal with.
        .sort((a, b) => (a.firstSeen ?? 0) - (b.firstSeen ?? 0)),
    })
  })

  app.post('/discovered/:stableId/admit', requirePermission('device.settings'), async (c) => {
    const stableId = c.req.param('stableId')
    const body = AdmitDeviceBodySchema.parse(await c.req.json().catch(() => ({})))
    const row = admitDevice(deps.db, stableId, {
      ...(body.label ? { label: body.label } : {}),
      ...(body.clusterId ? { clusterId: body.clusterId } : {}),
      ...(deps.deviceDefaults ? { deviceDefaults: deps.deviceDefaults } : {}),
      ...(deps.defaultDesiredReadiness ? { defaultDesiredReadiness: deps.defaultDesiredReadiness } : {}),
    })
    if (!row) {
      // Either blocked, or dismissed/admitted by someone else between the
      // operator loading the tray and pressing the button. Both are "there is
      // nothing here to admit", which is a 404 and not a server error.
      return c.json({ error: { code: 'E_NOT_DISCOVERED', message: `no device awaiting admission with stableId ${stableId}` } }, 404)
    }
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'device.admit', target: stableId })
    deps.record?.({ deviceId: row.id, stream: 'main', kind: 'device.admitted', meta: { stableId, label: row.label } })
    deps.broadcast({ type: 'device.added', payload: rowToDeviceInfo(row) })
    // Ask the registry to bring it online if the phone is plugged in right
    // now; otherwise the card would read `disconnected` about a device on the
    // desk until it was physically unplugged and replugged.
    deps.onAdmitted?.(stableId)
    return typedJson(c, DeviceResponseSchema, { device: rowToDeviceInfo(row) })
  })

  app.delete('/discovered/:stableId', requirePermission('device.settings'), (c) => {
    const stableId = c.req.param('stableId')
    // Dismiss is NOT a block (plan 56 §3.5): the entry goes away and the phone
    // reappears the next time it connects. A dismissal that quietly persisted
    // would be a block wearing a lighter word, and an operator who means
    // "never again" already has a control that says exactly that.
    deps.db.delete(discoveredDevices).where(eq(discoveredDevices.stableId, stableId)).run()
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'device.dismiss', target: stableId })
    return c.json({ ok: true })
  })

  /**
   * `POST /rescan` (plan 85 §3.3, §4.4, §4.6) — a static route, mounted
   * before `/:id` for the same shadowing reason as `/refs`/`/blocked`/
   * `/discovered` above. Runs the discovery reconciler's pass right now,
   * instead of waiting up to `discovery.scanIntervalSec` for the next
   * automatic one — the Studio **Rescan** button calls this directly.
   *
   * The plan's own table names `device.admin` as the permission; that
   * permission does not exist in this codebase's ACL
   * (`packages/core/src/auth/acl.ts`, out of scope for this change) — every
   * other admin-style device mutation in this exact router (block, forget,
   * tags, cluster, discovered/admit) already gates on `device.settings`, so
   * this uses the same one rather than inventing a permission nothing else
   * recognises.
   */
  app.post('/rescan', requirePermission('device.settings'), async (c) => {
    const result = deps.rescan?.() ?? null
    if (!result) throw new EnkakuError('E_NOT_SUPPORTED', 'device discovery is not available (orchestrator mode, or the adb subsystem is not ready)')
    const report = await result
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'device.rescan' })
    return typedJson(c, ReconcileReportSchema, report)
  })

  // `canUseDevice`'s device half (plan 34 §3.5, §4.4) — a minimal lookup, not
  // `mustGet` (defined below): a missing device is not this check's problem,
  // it is `checkInputAllowed`'s (`adb-endpoint.ts`'s `authorize` already
  // treats "no such device" as "no ownership check", letting that error
  // surface with its own coded error further down).
  const getDeviceOwner = (id: string): { ownerId: string | null } | null => {
    const row = db.select({ ownerId: devices.ownerId }).from(devices).where(eq(devices.id, id)).get()
    return row ?? null
  }

  // POST/DELETE/GET /:id/adb-endpoint (plan 27 §4.3) — same mounting pattern
  // as the event log above, so it lives under /api/devices/:id/adb-endpoint
  // without a separate top-level entry in http.ts.
  if (deps.adbEndpoint) app.route('/', createAdbEndpointRoutes({ ...deps.adbEndpoint, getDevice: getDeviceOwner }))

  // POST /:id/install|push|pull (plan 39 §4.4) — same mounting pattern again.
  if (deps.transfer) app.route('/', createTransferRoutes(deps.transfer))

  const mustGet = (id: string) => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
    return row
  }

  /** The manager's live `get()` when wired, else the pure DB-only fallback (plan 43 §4.1). */
  const readinessOf = (row: { id: string; status: string | null; desiredReadiness: string | null }) =>
    deps.readiness?.get(row.id) ?? staticReadinessFallback(row)

  const infoWithTags = (id: string) => {
    const row = mustGet(id)
    return rowToDeviceInfo(row, loadDeviceTags(db, [row.id]).get(row.id) ?? [], clusterRefFor(db, row.clusterId), null, readinessOf(row), deps.heldByOf(row.id))
  }

  // `?tag=a&tag=b` narrows to devices carrying ALL of them (plan 19 §4.3) — one
  // tags query total, so a 50-device farm does not issue 50 (acceptance #7).
  // `?clusterId=<id>` narrows to that cluster's members; `?clusterId=none`
  // narrows to unclustered devices (plan 22.0 §4.4, acceptance #4).
  app.get('/', (c) => {
    const wanted = (c.req.queries('tag') ?? []).map(normaliseTag).filter(Boolean)
    const clusterIdParam = c.req.query('clusterId') ?? null
    const rows = db.select().from(devices).all()
    const tagMap = loadDeviceTags(db)
    const clusterNames = loadClusterNames(db)
    let filtered =
      wanted.length === 0 ? rows : rows.filter((r) => wanted.every((t) => (tagMap.get(r.id) ?? []).includes(t)))
    if (clusterIdParam === 'none') filtered = filtered.filter((r) => r.clusterId === null)
    else if (clusterIdParam) filtered = filtered.filter((r) => r.clusterId === clusterIdParam)
    const infos = filtered.map((r) =>
      rowToDeviceInfo(
        r,
        tagMap.get(r.id) ?? [],
        r.clusterId ? { id: r.clusterId, name: clusterNames.get(r.clusterId) ?? r.clusterId } : null,
        null,
        readinessOf(r),
        deps.heldByOf(r.id),
      ),
    )

    // `/api/devices` is the odd one (plan 30 §4.2): sorted by `label` ASC —
    // a browse list, not a feed — and tags already forced a full in-memory
    // pass above (they live in a separate table), so the sort and the
    // cursor window are applied here too rather than in SQL.
    const sorted = [...infos].sort((a, b) =>
      a.label === b.label ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.label < b.label ? -1 : 1,
    )
    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const cursor = decodeStringCursor(cursorParam)
    const startIdx = cursor
      ? sorted.findIndex((d) => d.label > cursor.sortValue || (d.label === cursor.sortValue && d.id > cursor.id))
      : 0
    const windowed = startIdx === -1 ? [] : sorted.slice(startIdx, startIdx + limit + 1)
    const hasMore = windowed.length > limit
    const items = hasMore ? windowed.slice(0, limit) : windowed
    const last = items[items.length - 1]
    const nextCursor = hasMore && last ? encodeCursor(last.label, last.id) : null

    return c.json({
      items,
      nextCursor,
      total: sorted.length,
    })
  })

  app.get('/:id', (c) => {
    const row = mustGet(c.req.param('id'))
    // Normalised through the schema before it reaches Studio (Plan 17 §4.2): a
    // row written before this plan still has `prep.stayAwake` as a boolean, and
    // the settings form fills in gaps client-side but does not know the old
    // shape. Sending the canonical value means a blind save keeps the row's
    // original intent instead of silently applying the new field's default.
    const parsedSettings = DeviceSettingsSchema.safeParse(row.settings ?? {})
    const device = {
      ...rowToDeviceInfo(row, loadDeviceTags(db, [row.id]).get(row.id) ?? [], clusterRefFor(db, row.clusterId), null, readinessOf(row), deps.heldByOf(row.id)),
      transport: row.transport,
      display: row.display,
      input: row.input,
      inspection: row.inspection,
      battery: row.battery,
      settings: parsedSettings.success ? parsedSettings.data : row.settings,
      quarantineReason: row.quarantineReason,
      ownerId: row.ownerId,
      // Node-owned (cloud) devices have no local Inspector to attach to
      // (plan 56 §2 non-goals) — Studio uses this to disable the Inspect
      // tab with a stated reason rather than let it dead-end at a refusal.
      nodeId: row.nodeId,
    }
    // NOT wired to `typedJson`/`DeviceDetailResponseSchema` (plan 72.5): `battery: row.battery`
    // above re-overwrites the already-correctly-typed `battery` the `rowToDeviceInfo` spread just
    // computed with the raw `unknown`-typed DB json column, which does not structurally satisfy
    // `DeviceDetailSchema`'s `battery: BatteryStateSchema.nullable()`. Fixing the route (dropping
    // the redundant override, or typing the column) is out of scope for a response-envelope wiring
    // pass — flagged in the plan 72.5 report instead.
    return c.json({ device })
  })

  // Small and bounded by nature (a farm's concurrent viewers of one device),
  // so this deliberately skips the Plan 30 pagination envelope (plan 31 §31.3).
  app.get('/:id/viewers', (c) => {
    const row = mustGet(c.req.param('id'))
    return typedJson(c, DeviceViewersResponseSchema, { viewers: deps.viewersOf?.(row.id) ?? [] })
  })

  /** `GET /:id/readiness` (plan 43 §4.5) — the same shape `device.readiness` broadcasts. */
  app.get('/:id/readiness', (c) => {
    const row = mustGet(c.req.param('id'))
    return typedJson(c, DeviceReadinessResponseSchema, { readiness: readinessOf(row) })
  })

  /**
   * `PUT /:id/readiness` (plan 43 §4.5) — server-authoritative (spec §10.1):
   * every refusal in §3.4 is enforced inside `readiness.set` itself, not
   * here, so this route refuses exactly the same way the WS
   * `device.readiness.set` message does (acceptance #7). `device.view` is
   * the permission both Wake and Sleep require per the plan's table; the
   * finer distinction (job running, another viewer/lease holder) is
   * `readiness.set`'s own job.
   */
  app.put('/:id/readiness', requirePermission('device.view'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = ReadinessSetBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { desired } is required')
    if (!deps.readiness) throw new EnkakuError('E_NOT_SUPPORTED', 'device readiness is not available (orchestrator mode)')
    const readiness = await deps.readiness.set(row.id, body.data.desired, {
      userId: c.get('user')?.id ?? null,
      clientId: body.data.clientId ?? null,
    })
    return typedJson(c, DeviceReadinessResponseSchema, { readiness })
  })

  app.patch('/:id', async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = PatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'invalid body')
    const patch: Record<string, unknown> = {}
    if (body.data.label !== undefined) patch.label = body.data.label
    if (body.data.ownerId !== undefined) patch.ownerId = body.data.ownerId
    let changedKeys: string[] = []
    let logInputTextJustEnabled = false
    if (body.data.settings !== undefined) {
      const parsed = DeviceSettingsSchema.safeParse(body.data.settings)
      if (!parsed.success) {
        throw new EnkakuError(
          'E_BAD_REQUEST',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        )
      }
      // Engines live in their own columns because the session builder and the
      // scheduler query them. They are still validated and written from the
      // settings object, so the column and the JSON can never disagree.
      const engines = parsed.data.engines
      // `network` is not yet a `DeviceSettingsSchema.engines` field (plan 44
      // §5.4, the settings/migration side of the network engine, is not
      // built in this slice) — defaulted to 'none' here purely to satisfy
      // `EngineSelection`'s shape; nothing persists a chosen network engine
      // through this route yet.
      const result = validateEngineSelection(await deps.registry(), { ...engines, network: 'none' })
      if (!result.ok) throw new EnkakuError(result.code, result.message)
      // Diffed against the CURRENT settings (normalised through the same
      // schema, so a legacy row's defaults do not read as a spurious change) —
      // both for the device event's meta and to catch a `logInputText` flip
      // (plan 18 §3.4, §18.4), which is audited separately below.
      const before = DeviceSettingsSchema.safeParse(row.settings ?? {})
      const beforeData = before.success ? before.data : defaultDeviceSettings()
      changedKeys = (Object.keys(parsed.data) as Array<keyof typeof parsed.data>).filter(
        (k) => JSON.stringify(beforeData[k]) !== JSON.stringify(parsed.data[k]),
      )
      logInputTextJustEnabled = !beforeData.logInputText && parsed.data.logInputText
      patch.settings = parsed.data
      patch.transport = engines.transport
      patch.display = engines.display
      patch.input = engines.input
      patch.inspection = engines.inspection
    }
    if (Object.keys(patch).length > 0) db.update(devices).set(patch).where(eq(devices.id, row.id)).run()
    if (changedKeys.length > 0) {
      deps.record?.({ deviceId: row.id, stream: 'main', kind: 'settings.changed', actor: c.get('user')?.id ?? null, meta: { keys: changedKeys } })
    }
    if (logInputTextJustEnabled) {
      // Off by default and security-relevant to flip: naming the user here is
      // the whole point of the setting (plan 18 §3.4).
      deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'device.settings', target: row.id, meta: { logInputText: true } })
    }
    return typedJson(c, DeviceResponseSchema, { device: infoWithTags(row.id) })
  })

  /** Per-device engine choice — validated server-side (capabilities and locks, spec §8). */
  app.patch('/:id/drivers', async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = DriversBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { transport, display, input, inspection } is required')
    // Same 'none' default as the `.settings` branch above (plan 44 §5.4 is
    // not built yet) — this endpoint does not accept a network engine choice.
    const result = validateEngineSelection(await deps.registry(), { ...body.data, network: 'none' })
    if (!result.ok) throw new EnkakuError(result.code, result.message)
    db.update(devices).set(body.data).where(eq(devices.id, row.id)).run()
    return c.json({ device: { id: row.id, ...body.data } })
  })

  app.post('/:id/unquarantine', (c) => {
    const row = mustGet(c.req.param('id'))
    const monitor = deps.battery()
    if (!monitor || !monitor.unquarantine(row.id)) {
      throw new EnkakuError('not_quarantined', `device ${row.label} is not quarantined`)
    }
    return typedJson(c, DeviceResponseSchema, { device: infoWithTags(row.id) })
  })

  /**
   * "Save last N lines" (plan 24 §4.6, §3.6): the Monitor pane is deliberately
   * ephemeral — nothing is persisted while it streams — so this is the one
   * explicit escape hatch, writing a `.log` artifact tied to the device
   * rather than a job.
   */
  app.post('/:id/monitor/save', async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = MonitorSaveBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { kind, lines } (1..5000 lines) is required')
    const text = body.data.lines.join('\n')
    const info = await saveForDevice({ db, dataDir: deps.dataDir }, row.id, body.data.kind, new TextEncoder().encode(text))
    return typedJson(c, MonitorSaveResponseSchema, { artifact: info })
  })

  /**
   * Replace a device's whole tag set (plan 19 §4.3) — simpler to reason about
   * than add/remove endpoints, and it makes the Studio editor a plain form.
   */
  // `device.settings` (plan 34 §4.4, §4.5) — the exact permission already
  // named as the audit action for both of these mutations below.
  app.put('/:id/tags', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = TagsBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { tags: string[] } is required')
    const { tags, diff } = replaceDeviceTags(db, row.id, body.data.tags)
    deps.audit.record({
      userId: c.get('user')?.id ?? null,
      action: 'device.settings',
      target: row.id,
      meta: { tags: diff },
    })
    return typedJson(c, DeviceTagsResponseSchema, { tags })
  })

  /**
   * Assign or unassign this device's cluster (plan 22.0 §4.4). `clusterId:
   * null` unassigns; a non-null value moves the device — an `UPDATE`
   * necessarily clears whatever cluster it was in before, so `movedFrom`
   * reports what changed (acceptance #2) without a second lookup.
   */
  app.put('/:id/cluster', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = DeviceClusterBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { clusterId: string | null } is required')
    const from = row.clusterId
    if (body.data.clusterId === null) {
      unassignDevices(db, [row.id])
    } else {
      assignDevices(db, body.data.clusterId, [row.id])
    }
    deps.audit.record({
      userId: c.get('user')?.id ?? null,
      action: body.data.clusterId === null ? 'cluster.unassign' : 'cluster.assign',
      target: row.id,
      meta: { clusterId: body.data.clusterId, from },
    })
    return c.json({ device: infoWithTags(row.id), movedFrom: from })
  })

  /**
   * `GET /:id/history-counts` (plan 47 §3.4, §4.4) — shown before "delete
   * history" is offered on a Forget: never destructive by itself.
   */
  app.get('/:id/history-counts', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const counts = await deps.lifecycle.historyCounts(row.id)
    return typedJson(c, DeviceHistoryCountsResponseSchema, { counts })
  })

  /**
   * `DELETE /:id?deleteHistory=true|false` (plan 47 §4.4) — Forget. Every
   * refusal in §3.5 (busy, an active manual lease, still connected) is
   * enforced inside `lifecycle.forget` itself, server-authoritative exactly
   * like every other mutation here (spec §10.1, acceptance #12): calling
   * this directly is refused exactly as the Studio dialog is.
   */
  app.delete('/:id', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const deleteHistory = c.req.query('deleteHistory') === 'true'
    const result = await deps.lifecycle.forget(row.id, { deleteHistory, actor: { userId: c.get('user')?.id ?? null } })
    deps.audit.record({
      userId: c.get('user')?.id ?? null,
      action: 'device.forget',
      target: row.id,
      meta: { stableId: result.stableId, deleteHistory: result.historyDeleted, ...(result.counts ? { counts: result.counts } : {}) },
    })
    // The fleet list has listened for this since plan 42 — nothing ever sent
    // it before this plan, which is the whole reason forgetting did not exist.
    deps.broadcast({ type: 'device.removed', payload: { id: result.deviceId, stableId: result.stableId } })
    return c.json({ forgotten: result })
  })

  /**
   * `POST /:id/block` (plan 47 §3.3, §4.4) — forgets AND blocks the
   * `stableId` in one transaction (`lifecycle.block`), so the fleet can
   * never show the confusing half-state of a device that is blocked but
   * still listed.
   */
  app.post('/:id/block', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = BlockBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { reason? } is required')
    const blocked = await deps.lifecycle.block(row.id, {
      ...(body.data.reason ? { reason: body.data.reason } : {}),
      actor: { userId: c.get('user')?.id ?? null },
    })
    deps.audit.record({
      userId: c.get('user')?.id ?? null,
      action: 'device.block',
      target: row.id,
      meta: { stableId: blocked.stableId, reason: blocked.reason },
    })
    deps.broadcast({ type: 'device.removed', payload: { id: row.id, stableId: blocked.stableId } })
    return c.json({ blocked })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
