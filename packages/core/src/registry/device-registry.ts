import type { AdbClient, TrackerEvent } from '@enkaku/adb'
import { DeviceInfoSchema, type DeviceInfo } from '@enkaku/protocol'
import { eq, ne } from 'drizzle-orm'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { Logger } from '../util/logger'
import { probeDeviceIdentity } from './probe'
import type { WsHub } from '../server/ws'

export interface DeviceRegistryDeps {
  client: AdbClient
  db: Db
  hub: WsHub
  log: Logger
  /** Device hilang/offline → tutup sesi yang masih terbuka (Plan 03). */
  onDeviceGone?: (deviceId: string) => void
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
          // id & label TIDAK diubah (label milik user setelah rename).
          set: {
            serial,
            androidVersion: probe.androidVersion,
            apiLevel: probe.apiLevel,
            screenW: probe.screenW,
            screenH: probe.screenH,
            density: probe.density,
            status: 'idle',
            lastSeen: now,
          },
        })
        .run()
      serialToStableId.set(serial, probe.stableId)
      const row = db.select().from(devices).where(eq(devices.stableId, probe.stableId)).get()
      if (!row) return
      if (existing) {
        hub.broadcast({
          type: 'device.status',
          payload: { id: row.id, stableId: row.stableId, status: 'idle' },
        })
        log.info(`device online: ${row.label} (${probe.stableId}) via ${serial}`)
      } else {
        hub.broadcast({ type: 'device.added', payload: rowToDeviceInfo(row) })
        log.info(`device baru terdaftar: ${row.label} (${probe.stableId}) via ${serial}`)
      }
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
    db.update(devices).set({ status: 'offline', lastSeen: new Date() }).where(eq(devices.id, row.id)).run()
    hub.broadcast({
      type: 'device.status',
      payload: { id: row.id, stableId: row.stableId, status: 'offline' },
    })
    deps.onDeviceGone?.(row.id)
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
      // Recovery dari crash: semua row non-offline → offline; snapshot awal
      // tracker akan meng-online-kan yang benar-benar ada.
      db.update(devices).set({ status: 'offline' }).where(ne(devices.status, 'offline')).run()
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
