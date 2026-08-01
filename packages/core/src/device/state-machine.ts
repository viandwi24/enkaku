import type { DeviceStatus } from '@enkaku/protocol'
import { and, eq } from 'drizzle-orm'
import { changedRows, type Db } from '../db'
import { devices } from '../db/schema'
import type { Logger } from '../util/logger'

export type DeviceEvent =
  | 'DEVICE_CONNECTED'
  | 'DEVICE_DISCONNECTED'
  | 'MANUAL_ACQUIRED'
  | 'MANUAL_RELEASED'
  | 'JOB_CLAIMED'
  | 'JOB_FINISHED'
  | 'QUARANTINE'
  | 'UNQUARANTINE'

/**
 * Tabel transisi (plan 04 §4.1). Event di luar tabel = transisi ilegal →
 * ditolak (CAS gagal) + log warn. `manual` dan `busy` mutually exclusive
 * secara struktural: keduanya hanya bisa dicapai dari `idle`.
 */
const TRANSITIONS: Record<DeviceEvent, Partial<Record<DeviceStatus, DeviceStatus>>> = {
  DEVICE_CONNECTED: { offline: 'idle', quarantined: 'quarantined' },
  DEVICE_DISCONNECTED: { idle: 'offline', manual: 'offline', busy: 'offline', quarantined: 'quarantined' },
  MANUAL_ACQUIRED: { idle: 'manual' },
  MANUAL_RELEASED: { manual: 'idle' },
  JOB_CLAIMED: { idle: 'busy' },
  JOB_FINISHED: { busy: 'idle' },
  QUARANTINE: { idle: 'quarantined', manual: 'quarantined', busy: 'quarantined' },
  UNQUARANTINE: { quarantined: 'idle' },
}

export function nextStatus(event: DeviceEvent, from: DeviceStatus): DeviceStatus | null {
  return TRANSITIONS[event][from] ?? null
}

export interface DeviceStateMachine {
  /** Terapkan transisi via CAS (compare-and-set status lama). */
  apply(deviceId: string, event: DeviceEvent): { changed: boolean; from: DeviceStatus; to: DeviceStatus } | null
  current(deviceId: string): DeviceStatus | null
}

export function createDeviceStateMachine(deps: {
  db: Db
  log: Logger
  onChange?: (deviceId: string, status: DeviceStatus) => void
}): DeviceStateMachine {
  const { db, log } = deps

  return {
    current(deviceId) {
      const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
      return (row?.status as DeviceStatus | undefined) ?? null
    },

    apply(deviceId, event) {
      const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
      if (!row) {
        log.warn(`transisi ${event} untuk device tidak dikenal: ${deviceId}`)
        return null
      }
      const from = (row.status ?? 'offline') as DeviceStatus
      const to = nextStatus(event, from)
      if (to === null) {
        log.warn(`transisi ilegal ditolak: ${event} dari status '${from}' (device ${deviceId})`)
        return null
      }
      if (to === from) return { changed: false, from, to }

      // CAS: hanya update kalau status masih sama seperti yang dibaca.
      const changed = changedRows(
        db
          .update(devices)
          .set({ status: to })
          .where(and(eq(devices.id, deviceId), eq(devices.status, from)))
          .run(),
      )
      if (changed === 0) {
        log.debug(`CAS gagal untuk ${event} (${from}→${to}) device ${deviceId} — status keburu berubah`)
        return null
      }
      deps.onChange?.(deviceId, to)
      return { changed: true, from, to }
    },
  }
}
