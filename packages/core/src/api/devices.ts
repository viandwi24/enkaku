import { Hono } from 'hono'
import {
  ConnectionMediumSchema,
  DeviceConnectionPatchResponseSchema,
  DeviceHistoryCountsResponseSchema,
  DeviceReadinessResponseSchema,
  DeviceResponseSchema,
  DeviceSettingsSchema,
  DeviceTagsResponseSchema,
  DeviceViewersResponseSchema,
  DevicesBlockedResponseSchema,
  DisconnectOutcomeSchema,
  MonitorKindSchema,
  MonitorSaveResponseSchema,
  ReadinessSchema,
  ReconcileReportSchema,
  ReconnectOutcomeSchema,
  SweepReportSchema,
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
  type SweepReport,
  type Viewer,
} from '@enkaku/protocol'
import type { SessionManager } from '@enkaku/session'
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { can } from '../auth/acl'
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
import type { JobStore } from '../queue/job-store'
import { assignDevices, unassignDevices } from '../clusters/membership'
import { admitDevice } from '../registry/admission'
import { clusterRefFor, deriveConnection, loadClusterNames, rowToDeviceInfo } from '../registry/device-registry'
import { loadDeviceTags, replaceDeviceTags } from '../registry/device-tags'
import type { EndpointStore } from '../registry/endpoints'
import type { DeviceReconnector } from '../registry/reconnect'
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

/** Plan 88 §4.6, §5 step 88.4 — `POST /:id/connection/disconnect`. Every field optional: a bodyless call is valid. */
const ConnectionDisconnectBody = z.object({ force: z.boolean().optional() })

/** Plan 88 §4.6, §5 step 88.4 — `POST /:id/connection/reconnect`. Every field optional: a bodyless call is valid. */
const ConnectionReconnectBody = z.object({ allowSweep: z.boolean().optional(), force: z.boolean().optional() })

/** Plan 88 §3.1, §4.6, §5 step 88.4 — `PATCH /:id/connection`. `null` declares "medium unknown", overriding a network-inferred guess (§3.1's "a declaration wins"). */
const ConnectionPatchBody = z.object({ medium: ConnectionMediumSchema.nullable() })

/** Plan 24 §4.6 — `POST /:id/monitor/save`. The Monitor pane's "save last N lines" action. */
const MonitorSaveBody = z.object({
  kind: MonitorKindSchema,
  lines: z.array(z.string()).min(1).max(5000),
})

const ERROR_STATUS: Record<string, number> = {
  device_not_found: 404,
  cluster_not_found: 404,
  E_BAD_REQUEST: 400,
  // `device.owner.set` (plan 09 §4.4, `auth/acl.ts`) — the ownerId transition's own gate on PATCH /:id.
  'auth.forbidden': 403,
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
  // The bounded sweep (plan 88 §3.5, §4.5, §5 step 88.3) — `sweeper.sweep`'s own coded refusals.
  E_SCAN_BUSY: 409,
  E_SCAN_UNAVAILABLE: 409,
  // Per-device disconnect/reconnect (plan 88 §3.7, §3.8, §4.6, §5 step 88.4).
  // `E_TRANSPORT_NOT_DETACHABLE`: adb has no host service to release a single
  // USB transport (§4.6) — the Connection menu's Disconnect item is present
  // but disabled for exactly this reason, never a silent no-op.
  E_TRANSPORT_NOT_DETACHABLE: 409,
  // `PATCH /:id/connection` on a USB device — there is no network address to
  // declare a medium for.
  E_NOT_ON_NETWORK: 409,
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
  /**
   * `POST /scan` (plan 88 §3.5, §4.5, §4.6, §5 step 88.3) — the bounded
   * subnet sweep's own manual trigger (F29), distinct from `rescan` above:
   * `rescan` re-reads adb's OWN list; `scan` dials addresses adb has never
   * heard of. `undefined` (orchestrator mode, or a farm with no sweeper
   * wired yet) refuses with `E_NOT_SUPPORTED` — same optionality pattern as
   * `rescan`. A `scan.mode: 'off'`/no-networks refusal is `sweeper.sweep`'s
   * OWN job (`E_SCAN_UNAVAILABLE`) and is handled below, not here.
   */
  sweeper?: { sweep(opts?: { expect?: string[] }): Promise<SweepReport> }
  /**
   * Who currently holds each device's manual lease, and the means to force
   * it free (plan 88 §3.7, §4.6, §5 step 88.4: "a successful disconnect ...
   * releases the manual lease first"). Required, like `heldByOf` — the lease
   * manager exists in every mode this router is mounted in.
   */
  leases: LeaseManager
  /**
   * The running-job guard for `POST /:id/connection/disconnect` (plan 88
   * §4.6, §5 step 88.4: "a device with a running job refuses unless force,
   * and the error lists the jobs"). Required, like `leases` above — the job
   * store exists in every mode, including the orchestrator.
   */
  jobStore: Pick<JobStore, 'list'>
  /**
   * Per-device disconnect/reconnect (plan 88 §3.7, §3.8, §4.4, §4.6, §5 step
   * 88.4). `reconnector` is the SAME `DeviceReconnector` steps 88.2/88.8
   * built and wired into `daemon.ts` — NOT a second reconnect path: its own
   * `reconnect`/`disconnect` already run the ladder and the ordinary USB
   * refusal; this router adds the coded HTTP refusal, the running-job guard,
   * and the session/lease teardown ordering on top. Both accessors are
   * forward-refs (`daemon.ts` assigns `reconnector`/`sessions` later in boot
   * than this router is built, the same reason `rescan`/`onAdmitted` above
   * are functions rather than values) and both are `undefined` in
   * orchestrator mode or before the adb subsystem comes up — the routes
   * below refuse with `E_NOT_SUPPORTED` rather than not existing, same
   * optionality pattern as `rescan`/`sweeper`.
   */
  connection?: {
    reconnector: () => DeviceReconnector | null
    /** Force-closes this device's session before the transport actually drops (plan 88 §4.6's ordering) — `SessionManager.closeDevice`. */
    sessions: () => Pick<SessionManager, 'closeDevice'> | null
  }
  /** The address book (plan 88 §3.2, §4.3) — `PATCH /:id/connection`'s write path. Same optionality as `connection` above. */
  endpoints?: Pick<EndpointStore, 'declare'>
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

  /**
   * `POST /scan` (plan 88 §3.5, §4.5, §4.6, §5 step 88.3) — the bounded
   * subnet sweep's manual trigger (F29, H4): the Studio "Rescan / scan all
   * networks" button, and nothing else — there is no automatic cadence to
   * call this on a timer (§9 Q1, decided 2026-08-12). A static route, same
   * shadowing reason as `/rescan` above. `sweeper.sweep()` itself enforces
   * `scan.mode`/"no scannable network" (`E_SCAN_UNAVAILABLE`) and the
   * singleton mutex (`E_SCAN_BUSY`) — both map through `ERROR_STATUS` above,
   * so this route does no policy checking of its own.
   *
   * Audited as its own `device.scan` action (plan 88 §5 step 88.4) — step
   * 88.3 had to audit this under `device.rescan` with `meta.via: 'scan'` as a
   * stopgap, since `packages/core/src/auth/audit.ts`'s `AuditAction` union
   * was held by a concurrent step at the time; that step's own comment said
   * a dedicated action should be added once the file was free again, and
   * step 88.4 is what does it.
   */
  app.post('/scan', requirePermission('device.settings'), async (c) => {
    if (!deps.sweeper) throw new EnkakuError('E_NOT_SUPPORTED', 'network scanning is not available (orchestrator mode, or the adb subsystem is not ready)')
    const report: SweepReport = await deps.sweeper.sweep()
    deps.audit.record({
      userId: c.get('user')?.id ?? null,
      action: 'device.scan',
      meta: { scanned: report.scanned, answered: report.answered, adopted: report.adopted.length, discovered: report.discovered.length },
    })
    return typedJson(c, SweepReportSchema, report)
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

  /**
   * `device.settings` (plan 34 §4.4, §4.5) — the blanket gate every sibling
   * mutation on this router already declares (`PUT /:id/tags`, `PUT
   * /:id/cluster`, `PATCH /:id/drivers`, …), but this route never had: any
   * authenticated caller could reach `label`/`settings` with no permission
   * check at all (plan 87, mvp-3 Finding 3). It is a no-op today FOR WHO GETS
   * IN — `device.settings` sits in `OPERATOR` (`acl.ts`), so both roles this
   * codebase has already passed before this existed — but it is not a no-op
   * for what the router SAYS: the next role `acl.ts` adds would silently
   * inherit this hole instead of being asked to earn `device.settings` like
   * every other mutation here. Do not delete this as "redundant" just
   * because both roles currently pass it. `device.owner.set` immediately
   * below is a SEPARATE, stricter check on the `ownerId` transition alone —
   * this gate sits in front of it, not instead of it.
   */
  app.patch('/:id', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = PatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'invalid body')
    const user = c.get('user')
    // `device.owner.set` (`auth/acl.ts`, admin-only) — gates ONLY the
    // ownerId transition, and only when it actually changes: `label` and
    // `settings` below stay ordinary operator work, unrestricted by this
    // check, and a PATCH that merely repeats the current owner is a no-op,
    // not a reassignment. Without this, any authenticated operator could
    // set a device's `ownerId` to themselves or anyone else, silently — the
    // exact thing `canUseDevice` otherwise gates lease acquisition, job
    // enqueue, and the adb endpoint on.
    const ownerChanged = body.data.ownerId !== undefined && body.data.ownerId !== row.ownerId
    if (ownerChanged && (!user || !can(user.role, 'device.owner.set'))) {
      throw new EnkakuError('auth.forbidden', 'only an admin may reassign a device’s owner')
    }
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
    if (ownerChanged) {
      // Both the old and new owner, so the trail answers "who had it before"
      // as well as "who has it now" — the whole point of auditing a
      // reassignment rather than just a flag flip.
      deps.audit.record({
        userId: user?.id ?? null,
        action: 'device.owner',
        target: row.id,
        meta: { from: row.ownerId, to: body.data.ownerId },
      })
    }
    return typedJson(c, DeviceResponseSchema, { device: infoWithTags(row.id) })
  })

  /**
   * Per-device engine choice — validated server-side (capabilities and locks,
   * spec §8). `device.settings` (plan 34 §4.4, §4.5) — the same permission
   * `PUT /:id/tags`/`PUT /:id/cluster` above already gate on: this route had
   * NO `requirePermission` at all until this fix (a security-sweep finding,
   * not part of the original plan 09/34 work), so any authenticated operator
   * could silently change a device's transport/display/input/inspector
   * engines. Audited as `device.drivers` — the action name was already
   * defined in `auth/audit.ts` and never used anywhere until now.
   */
  app.patch('/:id/drivers', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = DriversBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { transport, display, input, inspection } is required')
    // Same 'none' default as the `.settings` branch above (plan 44 §5.4 is
    // not built yet) — this endpoint does not accept a network engine choice.
    const result = validateEngineSelection(await deps.registry(), { ...body.data, network: 'none' })
    if (!result.ok) throw new EnkakuError(result.code, result.message)
    const from = { transport: row.transport, display: row.display, input: row.input, inspection: row.inspection }
    db.update(devices).set(body.data).where(eq(devices.id, row.id)).run()
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'device.drivers', target: row.id, meta: { from, to: body.data } })
    return c.json({ device: { id: row.id, ...body.data } })
  })

  /**
   * `POST /:id/connection/disconnect` (plan 88 §3.7, §3.8, §4.6, §5 step
   * 88.4) — drops a `tcp` device's adb transport. The phone stays enrolled:
   * its record, tags, cluster, settings, job history and artifacts are
   * untouched. This is NOT Remove/Forget/Block (§3.8's whole point), so the
   * confirm copy and this route's own behaviour say so, not just the button.
   *
   * Guards, in order — the substance of this step:
   * 1. A `usb` device refuses with `E_TRANSPORT_NOT_DETACHABLE`: adb has no
   *    host service to release one USB transport (F11), so the menu item is
   *    present but disabled with this exact reason, never a button that
   *    quietly does nothing.
   * 2. A running job refuses (coded `job_running`, naming every job) unless
   *    `force` — bypassing `EnkakuError`/`ERROR_STATUS` here (like
   *    `E_ADB_BUSY_FARM` in `tools/routes.ts`) because the refusal carries a
   *    structured `jobs` list alongside the coded message, not just prose.
   * 3. Only once both guards pass: the session closes and the manual lease
   *    is force-released BEFORE the transport actually drops, so an operator
   *    who asked for this sees it as their own action, not the device dying
   *    out from under them.
   */
  app.post('/:id/connection/disconnect', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = ConnectionDisconnectBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { force? } is required')

    const conn = deriveConnection(row.serial, [])
    if (conn.kind === 'usb') {
      throw new EnkakuError(
        'E_TRANSPORT_NOT_DETACHABLE',
        `${row.label} is connected over USB — adb has no way to release a single USB transport. Unplug the cable to disconnect it.`,
      )
    }

    const reconnector = deps.connection?.reconnector()
    if (!reconnector) {
      throw new EnkakuError('E_NOT_SUPPORTED', 'device connection control is not available (orchestrator mode, or the adb subsystem is not ready)')
    }

    if (!body.data.force) {
      const running = deps.jobStore.list({ deviceId: row.id, status: 'running', limit: 50 }).rows
      if (running.length > 0) {
        const names = running.map((j) => j.scriptName ?? 'a script').join(', ')
        return c.json(
          {
            error: {
              code: 'job_running',
              message: `${running.length} running job${running.length === 1 ? '' : 's'} on ${row.label} (${names}) would fail if disconnected now — pass force to disconnect anyway`,
            },
            jobs: running.map((j) => ({ id: j.id, scriptName: j.scriptName ?? 'a script' })),
          },
          409,
        )
      }
    }

    // Close first, release second, drop the transport LAST (plan 88 §4.6's
    // ordering) — a device with no session and no lease disconnecting reads
    // as "Enkaku did this on purpose", not as an unexplained drop.
    await deps.connection?.sessions?.()?.closeDevice(row.id)
    deps.leases.releaseDevice?.(row.id, 'disconnected')

    const outcome = await reconnector.disconnect(row.stableId)
    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'device.disconnected',
      actor: c.get('user')?.id ?? null,
      meta: { result: outcome.result, force: Boolean(body.data.force) },
    })
    deps.audit.record({
      userId: c.get('user')?.id ?? null,
      action: 'device.disconnect',
      target: row.id,
      meta: { result: outcome.result, force: Boolean(body.data.force) },
    })
    return typedJson(c, DisconnectOutcomeSchema, outcome)
  })

  /**
   * `POST /:id/connection/reconnect` (plan 88 §3.3, §3.8, §4.4, §4.6, §5 step
   * 88.4, fixes F13, tests H2) — dials this ONE device's last known address.
   * Reuses `DeviceReconnector.reconnect()` verbatim (steps 88.2/88.8's own
   * ladder: already-connected → remembered addresses → sweep when
   * `allowSweep` and a sweeper is wired) — this route adds nothing to the
   * ladder itself, only the HTTP/audit/event wrapping every other mutation on
   * this router already has.
   */
  app.post('/:id/connection/reconnect', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = ConnectionReconnectBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { allowSweep?, force? } is required')

    const reconnector = deps.connection?.reconnector()
    if (!reconnector) {
      throw new EnkakuError('E_NOT_SUPPORTED', 'device connection control is not available (orchestrator mode, or the adb subsystem is not ready)')
    }

    const outcome = await reconnector.reconnect(row.stableId, { allowSweep: body.data.allowSweep, force: body.data.force })
    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'device.reconnected',
      actor: c.get('user')?.id ?? null,
      meta: { result: outcome.result },
    })
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'device.reconnect', target: row.id, meta: { result: outcome.result } })
    return typedJson(c, ReconnectOutcomeSchema, outcome)
  })

  /**
   * `PATCH /:id/connection` (plan 88 §3.1, §4.6, §5 step 88.4) — declares (or
   * clears, `medium: null`) this device's medium for its CURRENT network
   * address, for a device whose cutover to Wi-Fi/OTG happened outside
   * Enkaku (§3.4's wizard, step 88.5, is the guided path; this is the manual
   * correction). Refuses on a `usb` device: there is no network address to
   * declare a medium for. A declaration always wins over a network match
   * (§3.1) — `EndpointStore.declare` records `source: 'declared'` even for
   * `medium: null`, an explicit "unknown" that a later network match must
   * not silently overwrite.
   */
  app.patch('/:id/connection', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = ConnectionPatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { medium: "wired" | "wireless" | null } is required')

    const conn = deriveConnection(row.serial, [])
    if (conn.kind !== 'tcp' || !conn.address || conn.port === null) {
      throw new EnkakuError('E_NOT_ON_NETWORK', `${row.label} is connected over USB — there is no network address to declare a medium for.`)
    }
    if (!deps.endpoints) {
      throw new EnkakuError('E_NOT_SUPPORTED', 'device connection control is not available (orchestrator mode, or the adb subsystem is not ready)')
    }

    deps.endpoints.declare(row.stableId, row.serial, body.data.medium)
    deps.audit.record({
      userId: c.get('user')?.id ?? null,
      action: 'device.medium',
      target: row.id,
      meta: { address: row.serial, medium: body.data.medium },
    })

    // Reflects the just-declared value directly, for the caller's immediate
    // confirmation. `deriveConnection` itself does not yet read the endpoint
    // store's declared medium back on every render (`GET /api/devices` and
    // `GET /:id` derive `connection` from `serial` + farm networks only,
    // §4.1) — a known, pre-existing gap this step does not close; see this
    // step's own report.
    return typedJson(c, DeviceConnectionPatchResponseSchema, { connection: { ...conn, medium: body.data.medium, mediumSource: 'declared' } })
  })

  /**
   * `device.quarantine` (plan 09 §4.4, admin-only in `auth/acl.ts`) — the SET
   * side of quarantine happens automatically (`BatteryMonitor`'s own
   * thermal policy), but this manual UNSET side had no permission check at
   * all until this fix: any authenticated operator could clear a
   * thermal/safety quarantine on a device they may not even own. Audited as
   * `device.unquarantine`, matching the action name already defined (and
   * already unused) in `auth/audit.ts`.
   */
  app.post('/:id/unquarantine', requirePermission('device.quarantine'), (c) => {
    const row = mustGet(c.req.param('id'))
    const monitor = deps.battery()
    if (!monitor || !monitor.unquarantine(row.id)) {
      throw new EnkakuError('not_quarantined', `device ${row.label} is not quarantined`)
    }
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'device.unquarantine', target: row.id, meta: { reason: row.quarantineReason } })
    return typedJson(c, DeviceResponseSchema, { device: infoWithTags(row.id) })
  })

  /**
   * "Save last N lines" (plan 24 §4.6, §3.6): the Monitor pane is deliberately
   * ephemeral — nothing is persisted while it streams — so this is the one
   * explicit escape hatch, writing a `.log` artifact tied to the device
   * rather than a job. `device.settings` (plan 87, mvp-3 Finding 3) — this
   * route had NO permission check at all until this fix, the same
   * "everyone has it anyway" gap `PATCH /:id`'s blanket gate closes above;
   * gated on the same permission its siblings on this router already use.
   */
  app.post('/:id/monitor/save', requirePermission('device.settings'), async (c) => {
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
