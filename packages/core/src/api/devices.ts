import { Hono } from 'hono'
import {
  DeviceSettingsSchema,
  MonitorKindSchema,
  defaultDeviceSettings,
  normaliseTag,
  validateEngineSelection,
  type RegistryResponse,
  type ShellMode,
  type Viewer,
} from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import type { Db } from '../db'
import { devices } from '../db/schema'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { BatteryMonitor } from '../device/battery'
import type { EventRecorder } from '../events/recorder'
import type { LeaseManager } from '../lease/lease-manager'
import { assignDevices, unassignDevices } from '../clusters/membership'
import { clusterRefFor, loadClusterNames, rowToDeviceInfo } from '../registry/device-registry'
import { loadDeviceTags, replaceDeviceTags } from '../registry/device-tags'
import { saveForDevice } from '../runner/artifact-store'
import { EnkakuError } from '../util/errors'
import { createAdbEndpointRoutes } from './adb-endpoint'
import { createDeviceEventsRoutes } from './device-events'
import { decodeStringCursor, encodeCursor, parsePageQuery } from './pagination'

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
}

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
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  // GET /:id/events — the device event log (plan 18 §4.5), mounted here so it
  // lives under /api/devices/:id/events without a separate entry in http.ts.
  app.route('/', createDeviceEventsRoutes({ db }))

  // POST/DELETE/GET /:id/adb-endpoint (plan 27 §4.3) — same mounting pattern
  // as the event log above, so it lives under /api/devices/:id/adb-endpoint
  // without a separate top-level entry in http.ts.
  if (deps.adbEndpoint) app.route('/', createAdbEndpointRoutes(deps.adbEndpoint))

  const mustGet = (id: string) => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
    return row
  }

  const infoWithTags = (id: string) => {
    const row = mustGet(id)
    return rowToDeviceInfo(row, loadDeviceTags(db, [row.id]).get(row.id) ?? [], clusterRefFor(db, row.clusterId))
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
      // Legacy key, kept alongside `items` for one release (plan 30 §3.3).
      devices: items,
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
    return c.json({
      device: {
        ...rowToDeviceInfo(row, loadDeviceTags(db, [row.id]).get(row.id) ?? [], clusterRefFor(db, row.clusterId)),
        transport: row.transport,
        display: row.display,
        input: row.input,
        inspection: row.inspection,
        battery: row.battery,
        settings: parsedSettings.success ? parsedSettings.data : row.settings,
        quarantineReason: row.quarantineReason,
        ownerId: row.ownerId,
      },
    })
  })

  // Small and bounded by nature (a farm's concurrent viewers of one device),
  // so this deliberately skips the Plan 30 pagination envelope (plan 31 §31.3).
  app.get('/:id/viewers', (c) => {
    const row = mustGet(c.req.param('id'))
    return c.json({ viewers: deps.viewersOf?.(row.id) ?? [] })
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
      const result = validateEngineSelection(await deps.registry(), engines)
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
    return c.json({ device: infoWithTags(row.id) })
  })

  /** Per-device engine choice — validated server-side (capabilities and locks, spec §8). */
  app.patch('/:id/drivers', async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = DriversBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { transport, display, input, inspection } is required')
    const result = validateEngineSelection(await deps.registry(), body.data)
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
    return c.json({ device: infoWithTags(row.id) })
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
    return c.json({ artifact: info })
  })

  /**
   * Replace a device's whole tag set (plan 19 §4.3) — simpler to reason about
   * than add/remove endpoints, and it makes the Studio editor a plain form.
   */
  app.put('/:id/tags', async (c) => {
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
    return c.json({ tags })
  })

  /**
   * Assign or unassign this device's cluster (plan 22.0 §4.4). `clusterId:
   * null` unassigns; a non-null value moves the device — an `UPDATE`
   * necessarily clears whatever cluster it was in before, so `movedFrom`
   * reports what changed (acceptance #2) without a second lookup.
   */
  app.put('/:id/cluster', async (c) => {
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

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
