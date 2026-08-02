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
 * The transition table (plan 04 §4.1). An event outside the table is an illegal
 * transition → rejected (the CAS fails) and logged as a warning. `manual` and
 * `busy` are structurally mutually exclusive: both are only reachable from `idle`.
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
