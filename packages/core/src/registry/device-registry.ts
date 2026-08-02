import type { AdbClient, TrackerEvent } from '@enkaku/adb'
import { DeviceInfoSchema, defaultDeviceSettings, type DeviceInfo, type DeviceSettings } from '@enkaku/protocol'
import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../db'
import { clusters, devices, type DeviceRow } from '../db/schema'
import type { DeviceStateMachine } from '../device/state-machine'
import type { Logger } from '../util/logger'
import { probeDeviceIdentity } from '@enkaku/session'
import type { WsHub } from '../server/ws'
import { loadDeviceTags } from './device-tags'
import type { EventRecorder } from '../events/recorder'

export interface DeviceRegistryDeps {
  client: AdbClient
  db: Db
  hub: WsHub
  log: Logger
  /** The device state machine (Plan 04) — every status transition goes through it. */
  states: DeviceStateMachine
  /** Device gone or offline → close any session still open (Plan 03). */
  onDeviceGone?: (deviceId: string) => void
  /** Device became usable → kick the scheduler (Plan 04). */
  onDeviceReady?: () => void
  /** Main-stream device events: device.online / device.offline / device.unauthorized (Plan 18 §4.2). */
  record?: EventRecorder['record']
  /**
   * Farm defaults, applied to a device the first time it is enrolled.
   * Without this the Settings page would be decorative: the defaults were
   * never read, and new devices silently took the DB column defaults instead.
   */
  deviceDefaults?: () => DeviceSettings
}

export interface DeviceRegistry {
  start(): Promise<void>
  stop(): Promise<void>
  listDevices(): DeviceInfo[]
  deviceCount(): number
}

/**
 * Every device's owning cluster resolved by name, in one query total (plan
 * 22.0 §4.4, acceptance #10 — never one query per device). A device with no
 * cluster looks it up as `undefined` and `rowToDeviceInfo` renders that as
 * `null`, same as an empty map would.
 */
export function loadClusterNames(db: Db): Map<string, string> {
  return new Map(db.select({ id: clusters.id, name: clusters.name }).from(clusters).all().map((c) => [c.id, c.name]))
}

/** The single-device counterpart to `loadClusterNames` — one extra query, only when the device has a cluster. */
export function clusterRefFor(db: Db, clusterId: string | null): { id: string; name: string } | null {
  if (!clusterId) return null
  const row = db.select({ name: clusters.name }).from(clusters).where(eq(clusters.id, clusterId)).get()
  return row ? { id: clusterId, name: row.name } : null
}

export function rowToDeviceInfo(
  row: DeviceRow,
  tags: string[] = [],
  cluster: { id: string; name: string } | null = null,
): DeviceInfo {
  return DeviceInfoSchema.parse({
    id: row.id,
    stableId: row.stableId,
    serial: row.serial,
    label: row.label,
    androidVersion: row.androidVersion,
    apiLevel: row.apiLevel,
    screenW: row.screenW,
    screenH: row.screenH,
    density: row.density,
    status: row.status ?? 'offline',
    lastSeen: row.lastSeen ? Math.floor(row.lastSeen.getTime() / 1000) : null,
    battery: row.battery ?? null,
    quarantineReason: row.quarantineReason ?? null,
    tags,
    cluster,
  })
}

/**
 * Every device plus its tags and its cluster, in exactly three queries
 * regardless of how many devices there are (plan 19 §4.3 and plan 22.0
 * §4.4, acceptance #7 and #10 — never N+1).
 */
export function listDevicesWithTags(db: Db): DeviceInfo[] {
  const rows = db.select().from(devices).all()
  const tagMap = loadDeviceTags(db)
  const clusterNames = loadClusterNames(db)
  return rows.map((r) =>
    rowToDeviceInfo(r, tagMap.get(r.id) ?? [], r.clusterId ? { id: r.clusterId, name: clusterNames.get(r.clusterId) ?? r.clusterId } : null),
  )
}

/**
 * Orkestrasi tracker → probe → upsert-by-stableId → broadcast (plan 01 §4.5).
 * - state 'device'       → probe → upsert → broadcast added|status idle
 * - state 'unauthorized' → log.warn saja (wizard = Plan 03)
 * - remove               → status offline + broadcast device.status
 */
export function createDeviceRegistry(deps: DeviceRegistryDeps): DeviceRegistry {
  const { client, db, hub, log } = deps
  /** serial → stableId, so a remove event resolves without a query. */
  /**
   * Farm defaults → the columns the session builder reads, plus the settings
   * JSON. Both are written from ONE source so they cannot disagree.
   */
  const defaultsForNewDevice = () => {
    const s = deps.deviceDefaults?.() ?? defaultDeviceSettings()
    return {
      transport: s.engines.transport,
      display: s.engines.display,
      input: s.engines.input,
      inspection: s.engines.inspection,
      settings: s,
    }
  }

  const serialToStableId = new Map<string, string>()
  /** Dedupe probes per serial (a flapping wireless device causes an event storm). */
  const probesInFlight = new Set<string>()
  let unsubscribe: (() => void) | null = null

  async function onOnline(serial: string): Promise<void> {
    if (probesInFlight.has(serial)) return
    probesInFlight.add(serial)
    try {
      let probe
      try {
        probe = await probeDeviceIdentity(client, serial)
      } catch (err) {
        // Retry once after a delay — a device is sometimes not shell-ready the instant it appears.
        log.debug(`probe of ${serial} failed, retrying once in 1s`, { err: String(err) })
        await Bun.sleep(1000)
        probe = await probeDeviceIdentity(client, serial)
      }
      if (probe.stableId.startsWith('serial:')) {
        log.warn(`using the tertiary stableId fallback for ${serial} (ro.serialno and android_id are both invalid)`)
      }
      const now = new Date()
      const existing = db.select().from(devices).where(eq(devices.stableId, probe.stableId)).get()
      db.insert(devices)
        .values({
          id: crypto.randomUUID(),
          stableId: probe.stableId,
          serial,
          label: probe.model ?? probe.stableId,
          androidVersion: probe.androidVersion,
          apiLevel: probe.apiLevel,
          screenW: probe.screenW,
          screenH: probe.screenH,
          density: probe.density,
          status: 'idle',
          lastSeen: now,
          // First enrollment copies the farm defaults; the conflict branch below
          // deliberately leaves them alone so a device keeps its own settings.
          ...(existing ? {} : defaultsForNewDevice()),
        })
        .onConflictDoUpdate({
          target: devices.stableId,
          // id, label, and status are NOT touched here — status only moves via
          // the state machine (DEVICE_CONNECTED), which keeps `quarantined` sticky.
          set: {
            serial,
            androidVersion: probe.androidVersion,
            apiLevel: probe.apiLevel,
            screenW: probe.screenW,
            screenH: probe.screenH,
            density: probe.density,
            lastSeen: now,
          },
        })
        .run()
      serialToStableId.set(serial, probe.stableId)
      const row = db.select().from(devices).where(eq(devices.stableId, probe.stableId)).get()
      if (!row) return
      if (existing) {
        // The official transition (offline→idle; quarantined stays quarantined).
        deps.states.apply(row.id, 'DEVICE_CONNECTED')
        log.info(`device online: ${row.label} (${probe.stableId}) via ${serial}`)
      } else {
        hub.broadcast({ type: 'device.added', payload: rowToDeviceInfo(row) })
        log.info(`new device registered: ${row.label} (${probe.stableId}) via ${serial}`)
      }
      deps.record?.({ deviceId: row.id, stream: 'main', kind: 'device.online', meta: { serial, transport: row.transport ?? 'adb-usb' } })
      deps.onDeviceReady?.()
    } catch (err) {
      log.warn(`probe of ${serial} failed outright — waiting for the next event`, { err: String(err) })
    } finally {
      probesInFlight.delete(serial)
    }
  }

  function onRemove(serial: string): void {
    const stableId = serialToStableId.get(serial)
    serialToStableId.delete(serial)
    const row = stableId
      ? db.select().from(devices).where(eq(devices.stableId, stableId)).get()
      : db.select().from(devices).where(eq(devices.serial, serial)).get()
    if (!row || row.status === 'offline') return
    // The same device may still be online over another transport (USB plus WiFi).
    for (const [s, sid] of serialToStableId) {
      if (sid === row.stableId && s !== serial) {
        log.debug(`device ${row.stableId} is still online via ${s} — not marking it offline`)
        return
      }
    }
    db.update(devices).set({ lastSeen: new Date() }).where(eq(devices.id, row.id)).run()
    // Any running job on this device is failed and its session closed by the caller.
    deps.onDeviceGone?.(row.id)
    deps.states.apply(row.id, 'DEVICE_DISCONNECTED')
    deps.record?.({ deviceId: row.id, stream: 'main', kind: 'device.offline', meta: { reason: 'disconnected' } })
    log.info(`device offline: ${row.label} (${row.stableId})`)
  }

  function onTrackerEvent(ev: TrackerEvent): void {
    if (ev.kind === 'remove') {
      onRemove(ev.serial)
      return
    }
    if (ev.state === 'device') {
      void onOnline(ev.serial)
    } else if (ev.state === 'unauthorized') {
      log.warn(`device ${ev.serial} is unauthorized — accept the USB debugging dialog on the phone's screen`)
      hub.broadcast({ type: 'device.unauthorized', payload: { serial: ev.serial } })
      // Only recorded if we already know this device (a previous session's
      // stableId) — an unenrolled device has no row and no Logs tab to show it on.
      const stableId = serialToStableId.get(ev.serial)
      const knownRow = stableId ? db.select().from(devices).where(eq(devices.stableId, stableId)).get() : null
      if (knownRow) deps.record?.({ deviceId: knownRow.id, stream: 'main', kind: 'device.unauthorized', meta: {} })
    } else {
      log.debug(`device ${ev.serial} state=${ev.state} — ignored in M0`)
    }
  }

  return {
    async start() {
      // Crash recovery: idle|manual|busy → offline (quarantined stays sticky);
      // the tracker's first snapshot brings back whatever is really there.
      db
        .update(devices)
        .set({ status: 'offline' })
        .where(and(ne(devices.status, 'offline'), ne(devices.status, 'quarantined')))
        .run()
      const tracker = client.trackDevices()
      unsubscribe = tracker.on(onTrackerEvent)
      await tracker.start()
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = null
      await client.trackDevices().stop()
    },
    listDevices() {
      return listDevicesWithTags(db)
    },
    deviceCount() {
      return db.select().from(devices).all().length
    },
  }
}
