import type { AdbClient, TrackerEvent } from '@enkaku/adb'
import { DeviceInfoSchema, defaultDeviceSettings, type DeviceInfo, type DeviceReadiness, type DeviceSettings, type LeaseHolder, type Readiness } from '@enkaku/protocol'
import { and, eq, gte, ne, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { clusters, devices, deviceEvents, discoveredDevices, type DeviceRow } from '../db/schema'
import type { DeviceStateMachine } from '../device/state-machine'
import { staticReadinessFallback } from '../device/readiness'
import type { Logger } from '../util/logger'
import { probeDeviceIdentity } from '@enkaku/session'
import type { WsHub } from '../server/ws'
import { loadDeviceTags } from './device-tags'
import { classify, recordSighting } from './admission'
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
  /**
   * Device became usable → kick the scheduler (Plan 04). Takes the device's
   * id (plan 52 §4.1, §5.3) so a caller can also restore any persisted
   * network route for exactly this device, probe-first.
   */
  onDeviceReady?: (deviceId: string) => void
  /** Main-stream device events: device.online / device.offline / device.unauthorized (Plan 18 §4.2). */
  record?: EventRecorder['record']
  /**
   * Farm defaults, applied to a device the first time it is enrolled.
   * Without this the Settings page would be decorative: the defaults were
   * never read, and new devices silently took the DB column defaults instead.
   */
  deviceDefaults?: () => DeviceSettings
  /** `readiness.defaultDesired` (plan 43 §4.4) — see the comment on `defaultsForNewDevice` below for why this is a separate accessor from `deviceDefaults`. */
  defaultDesiredReadiness?: () => Readiness
}

export interface DeviceRegistry {
  start(): Promise<void>
  stop(): Promise<void>
  listDevices(): DeviceInfo[]
  deviceCount(): number
  /**
   * A device was just admitted from the Discovered tray (plan 56). If that
   * phone is connected right now, bring it online immediately instead of
   * waiting for the next tracker event — which, for a phone that never gets
   * unplugged, may never come.
   */
  admitted(stableId: string): void
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
  /** Populated only by `listDevicesWithTags` (plan 37 §4.5) — see `DeviceInfoSchema.lastCrashAt`. */
  lastCrashAt: number | null = null,
  /**
   * Readiness (plan 43 §4.1) — the live `ReadinessManager.get()` result from
   * every production call site. Falls back to `staticReadinessFallback`
   * (offline-aware, but session-blind) ONLY when no manager was threaded
   * through, which today is orchestrator mode (no local readiness manager
   * exists there at all) and tests that construct a row directly.
   */
  readiness: DeviceReadiness | null = null,
  /**
   * Who currently holds this device's manual lease (plan 71 §3.2, §4.4) — the
   * single field that replaced Plan 69's three polling workarounds. `null`
   * when nobody does, which is also what every call site that has no lease
   * manager to hand (orchestrator mode, most tests) gets by default.
   */
  heldBy: LeaseHolder | null = null,
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
    lastCrashAt,
    readiness: readiness ?? staticReadinessFallback(row),
    heldBy,
  })
}

/**
 * Devices that crashed at least once in the last hour (plan 37 §4.5's device
 * card badge) — ONE aggregate query regardless of fleet size, not a
 * per-device lookup, keyed off the same `idx_device_events_tail
 * (deviceId, stream, at)` index the Logs tab already relies on.
 */
export function loadRecentCrashes(db: Db, sinceEpochSec: number): Map<string, number> {
  const rows = db
    .select({ deviceId: deviceEvents.deviceId, lastAt: sql<number>`max(${deviceEvents.at})` })
    .from(deviceEvents)
    .where(and(eq(deviceEvents.kind, 'app.crashed'), gte(deviceEvents.at, new Date(sinceEpochSec * 1000))))
    .groupBy(deviceEvents.deviceId)
    .all()
  // `max(at)` is a raw SQL aggregate over the underlying INTEGER column — it
  // returns the stored unix-seconds value directly, NOT a Drizzle-mapped
  // Date (that mapping only applies to plain column selects), so this is
  // just a number, already in the repo-wide unix-seconds convention.
  return new Map(rows.map((r) => [r.deviceId, Math.floor(Number(r.lastAt))]))
}

/**
 * Every device plus its tags and its cluster, in exactly three queries
 * regardless of how many devices there are (plan 19 §4.3 and plan 22.0
 * §4.4, acceptance #7 and #10 — never N+1).
 */
export function listDevicesWithTags(
  db: Db,
  /** Readiness (plan 43 §4.1) — omitted call sites fall back to `staticReadinessFallback` per-row, same as `rowToDeviceInfo` itself. */
  readinessOf?: (deviceId: string, row: DeviceRow) => DeviceReadiness,
  /** Lease holder (plan 71 §4.4) — omitted call sites fall back to `null` (unheld), same as `rowToDeviceInfo` itself. */
  heldByOf?: (deviceId: string) => LeaseHolder | null,
): DeviceInfo[] {
  const rows = db.select().from(devices).all()
  const tagMap = loadDeviceTags(db)
  const clusterNames = loadClusterNames(db)
  // The device card crash badge (plan 37 §4.5) — one query for the whole
  // fleet, not one per device.
  const recentCrashes = loadRecentCrashes(db, Math.floor(Date.now() / 1000) - 3600)
  return rows.map((r) =>
    rowToDeviceInfo(
      r,
      tagMap.get(r.id) ?? [],
      r.clusterId ? { id: r.clusterId, name: clusterNames.get(r.clusterId) ?? r.clusterId } : null,
      recentCrashes.get(r.id) ?? null,
      readinessOf?.(r.id, r) ?? null,
      heldByOf?.(r.id) ?? null,
    ),
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
      // Readiness (plan 43 §4.4) — `readiness.defaultDesired` on
      // `FarmSettings` is a separate top-level block from `DeviceSettings`
      // (unlike engines/prep/timing above, which ARE nested inside it), so
      // it needs its own accessor. `null` (the omitted-accessor default)
      // reads as `asleep` everywhere `desiredReadiness` is consulted — the
      // schema's own default, so a host that does not wire this keeps
      // enrolling devices exactly as before this plan.
      desiredReadiness: deps.defaultDesiredReadiness?.() ?? null,
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
      // Block check (plan 47 §3.3, §4.2): keyed on `stableId`, never the
      // serial — a blocked device is skipped BEFORE it is ever inserted, so
      // blocking is free at steady state and survives a different USB port
      // or a switch to adb-tcp, both of which change only the serial. Logged
      // once at `debug` (not `info`) since a blocked device reappearing is
      // expected, ongoing behaviour, not a noteworthy event.
      //
      // Admission (plan 56 §4.2) folds that block check into one decision, so
      // the three outcomes live in a single place rather than as separate
      // guards that could drift apart.
      const admission = classify(db, probe.stableId)
      if (admission === 'blocked') {
        log.debug(`skipping blocked device ${probe.stableId} (serial ${serial}) — not probing further`)
        return
      }
      if (admission === 'discovered') {
        // Seen, identified, and deliberately NOT enrolled: no `devices` row
        // means nothing to schedule, nothing to lease, and nothing for the
        // wall to draw. It waits in the tray until someone admits it.
        const firstSighting = !db
          .select({ stableId: discoveredDevices.stableId })
          .from(discoveredDevices)
          .where(eq(discoveredDevices.stableId, probe.stableId))
          .get()
        recordSighting(db, {
          stableId: probe.stableId,
          serial,
          label: probe.model ?? null,
          androidVersion: probe.androidVersion ?? null,
        })
        serialToStableId.set(serial, probe.stableId)
        hub.broadcast({
          type: 'device.discovered',
          payload: {
            stableId: probe.stableId,
            serial,
            label: probe.model ?? null,
            androidVersion: probe.androidVersion ?? null,
          },
        })
        // `info` on the first sighting only. A phone that is plugged in daily
        // and never admitted should not narrate itself into the log forever.
        if (firstSighting) {
          log.info(`device discovered, awaiting admission: ${probe.model ?? probe.stableId} (${probe.stableId}) via ${serial}`)
        } else {
          log.debug(`device ${probe.stableId} seen again, still awaiting admission`)
        }
        return
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
      deps.onDeviceReady?.(row.id)
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
    admitted(stableId) {
      // A phone admitted from the tray (plan 56) is usually plugged in RIGHT
      // NOW — but the tracker only speaks on change, so without this the new
      // device would sit there reading `disconnected` until someone unplugged
      // and replugged it. A card that says disconnected about a phone on the
      // desk is worse than no card.
      //
      // `serialToStableId` is the live view of what adb currently reports, so
      // it answers "is this phone actually here?" without a probe. Re-running
      // `onOnline` then takes the ordinary enrolment path, which now upserts
      // and transitions rather than discovering, because the row exists.
      for (const [serial, sid] of serialToStableId) {
        if (sid === stableId) {
          void onOnline(serial)
          return
        }
      }
    },
  }
}
