import type { DeviceStatus } from '@enkaku/protocol'
import { and, eq } from 'drizzle-orm'
import { changedRows, type Db } from '../db'
import { devices } from '../db/schema'
import type { Logger } from '../util/logger'

export type DeviceEvent = 'DEVICE_CONNECTED' | 'DEVICE_DISCONNECTED' | 'QUARANTINE' | 'UNQUARANTINE'

/**
 * The transition table (MVP 04 §0.1, §4, plan 205 §4.6). An event outside the
 * table is an illegal transition → rejected (the CAS fails) and logged as a
 * warning. "busy" and "controlled" are no longer stored: they are derived
 * from the activity registry and never appear here.
 */
const TRANSITIONS: Record<DeviceEvent, Partial<Record<DeviceStatus, DeviceStatus>>> = {
  DEVICE_CONNECTED: { offline: 'online', quarantined: 'quarantined' },
  DEVICE_DISCONNECTED: { online: 'offline', quarantined: 'quarantined' },
  QUARANTINE: { online: 'quarantined' },
  UNQUARANTINE: { quarantined: 'online' },
}

export function nextStatus(event: DeviceEvent, from: DeviceStatus): DeviceStatus | null {
  return TRANSITIONS[event][from] ?? null
}

export interface DeviceStateMachine {
  /** Apply a transition by CAS (compare-and-set against the previous status). */
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
        log.warn(`transition ${event} for an unknown device: ${deviceId}`)
        return null
      }
      const from = (row.status ?? 'offline') as DeviceStatus
      const to = nextStatus(event, from)
      if (to === null) {
        log.warn(`illegal transition rejected: ${event} from status '${from}' (device ${deviceId})`)
        return null
      }
      if (to === from) return { changed: false, from, to }

      // CAS: only update while the status still matches what was read.
      const changed = changedRows(
        db
          .update(devices)
          .set({ status: to })
          .where(and(eq(devices.id, deviceId), eq(devices.status, from)))
          .run(),
      )
      if (changed === 0) {
        log.debug(`CAS failed for ${event} (${from}→${to}) on device ${deviceId} — the status changed first`)
        return null
      }
      deps.onChange?.(deviceId, to)
      return { changed: true, from, to }
    },
  }
}
