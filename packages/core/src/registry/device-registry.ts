import type { AdbClient, TrackerEvent } from '@enkaku/adb'
import { DeviceInfoSchema, type DeviceInfo } from '@enkaku/protocol'
import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { DeviceStateMachine } from '../device/state-machine'
import type { Logger } from '../util/logger'
import { probeDeviceIdentity } from '@enkaku/session'
import type { WsHub } from '../server/ws'

export interface DeviceRegistryDeps {
  client: AdbClient
  db: Db
  hub: WsHub
  log: Logger
  /** State machine device (Plan 04) — transisi status hanya lewat sini. */
  states: DeviceStateMachine
  /** Device hilang/offline → tutup sesi yang masih terbuka (Plan 03). */
  onDeviceGone?: (deviceId: string) => void
  /** Device siap dipakai → kick scheduler (Plan 04). */
  onDeviceReady?: () => void
}

export interface DeviceRegistry {
  start(): Promise<void>
  stop(): Promise<void>
  listDevices(): DeviceInfo[]
  deviceCount(): number
}

export function rowToDeviceInfo(row: DeviceRow): DeviceInfo {
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
  })
}

/**
 * Orkestrasi tracker → probe → upsert-by-stableId → broadcast (plan 01 §4.5).
 * - state 'device'       → probe → upsert → broadcast added|status idle
 * - state 'unauthorized' → log.warn saja (wizard = Plan 03)
 * - remove               → status offline + broadcast device.status
 */
export function createDeviceRegistry(deps: DeviceRegistryDeps): DeviceRegistry {
  const { client, db, hub, log } = deps
  /** serial → stableId, untuk resolve event remove tanpa query. */
  const serialToStableId = new Map<string, string>()
  /** Dedupe probe per serial (device wireless flap → badai event). */
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
        // Retry sekali dengan delay — device kadang belum siap shell saat baru muncul.
        log.debug(`probe ${serial} gagal, retry 1x dalam 1s`, { err: String(err) })
        await Bun.sleep(1000)
        probe = await probeDeviceIdentity(client, serial)
      }
      if (probe.stableId.startsWith('serial:')) {
        log.warn(`stableId fallback tertiary dipakai untuk ${serial} (ro.serialno & android_id invalid)`)
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
        })
        .onConflictDoUpdate({
          target: devices.stableId,
          // id, label, dan status TIDAK diubah di sini — status hanya lewat
          // state machine (DEVICE_CONNECTED), supaya `quarantined` sticky.
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
        // Transisi resmi (offline→idle; quarantined tetap quarantined).
        deps.states.apply(row.id, 'DEVICE_CONNECTED')
        log.info(`device online: ${row.label} (${probe.stableId}) via ${serial}`)
      } else {
        hub.broadcast({ type: 'device.added', payload: rowToDeviceInfo(row) })
        log.info(`device baru terdaftar: ${row.label} (${probe.stableId}) via ${serial}`)
      }
      deps.onDeviceReady?.()
    } catch (err) {
      log.warn(`probe ${serial} gagal total — menunggu event berikutnya`, { err: String(err) })
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
    // Device yang sama mungkin masih online lewat transport lain (USB + WiFi).
    for (const [s, sid] of serialToStableId) {
      if (sid === row.stableId && s !== serial) {
        log.debug(`device ${row.stableId} masih online via ${s} — skip offline`)
        return
      }
    }
    db.update(devices).set({ lastSeen: new Date() }).where(eq(devices.id, row.id)).run()
    // Job running di device ini di-fail & sesi ditutup oleh caller.
    deps.onDeviceGone?.(row.id)
    deps.states.apply(row.id, 'DEVICE_DISCONNECTED')
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
      log.warn(`device ${ev.serial} unauthorized — terima dialog USB debugging di layar HP`)
      hub.broadcast({ type: 'device.unauthorized', payload: { serial: ev.serial } })
    } else {
      log.debug(`device ${ev.serial} state=${ev.state} — diabaikan di M0`)
    }
  }

  return {
    async start() {
      // Recovery dari crash: idle|manual|busy → offline (quarantined sticky);
      // snapshot awal tracker meng-online-kan yang benar-benar ada.
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
      return db.select().from(devices).all().map(rowToDeviceInfo)
    },
    deviceCount() {
      return db.select().from(devices).all().length
    },
  }
}
