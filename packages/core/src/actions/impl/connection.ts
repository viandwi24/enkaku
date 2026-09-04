import type { ConnectionMedium, CutoverState, DisconnectOutcome, ReconnectOutcome } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db'
import { devices } from '../../db/schema'
import type { ActivityRegistry } from '../../activity/registry'
import { deriveConnection, type FarmNetwork } from '../../registry/device-registry'
import type { CutoverManager } from '../../registry/cutover'
import type { DeviceReconnector } from '../../registry/reconnect'
import type { SessionManager } from '@enkaku/session'
import { EnkakuError } from '../../util/errors'

/** A live `job`/`workflow-job` activity — the same "running job" guard `disconnect`/`cutover` used before plan 207, now read off the activity registry (plan 205) rather than a direct `jobStore` query. */
function hasRunningJob(activities: Pick<ActivityRegistry, 'list'>, deviceId: string): boolean {
  return activities.list(deviceId).some((a) => a.kind === 'job' || a.kind === 'workflow-job')
}

/** `reconnect` (plan 207 §4.2) — the same `DeviceReconnector.reconnect` ladder `POST /:id/connection/reconnect` used. */
export async function reconnectDevice(
  reconnector: DeviceReconnector,
  stableId: string,
  opts: { allowSweep?: boolean; force?: boolean },
): Promise<ReconnectOutcome> {
  return reconnector.reconnect(stableId, opts)
}

export type DisconnectStatus = { status: 'done'; outcome: DisconnectOutcome } | { status: 'warned'; message: string } | { status: 'failed'; message: string }

/**
 * `disconnect` (plan 207 §4.2) — `devices.ts:1407-1470`'s body as a function:
 * USB refusal, a live-job guard (warn, `force` proceeds), then close the
 * session, end control/command activities, and drop the transport.
 */
export async function disconnectDevice(
  deps: {
    db: Db
    activities: Pick<ActivityRegistry, 'list' | 'endWhere'>
    reconnector: DeviceReconnector
    sessions: Pick<SessionManager, 'closeDevice'> | null
  },
  deviceId: string,
  opts: { force?: boolean },
): Promise<DisconnectStatus> {
  const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
  if (!row) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
  const conn = deriveConnection(row.serial, [])
  if (conn.kind === 'usb') {
    return {
      status: 'failed',
      message: `${row.label} is connected over USB — adb has no way to release a single USB transport. Unplug the cable to disconnect it.`,
    }
  }
  if (!opts.force && hasRunningJob(deps.activities, row.id)) {
    return { status: 'warned', message: `a running job on ${row.label} would fail if disconnected now` }
  }
  await deps.sessions?.closeDevice(row.id)
  deps.activities.endWhere((deviceId2, activity) => deviceId2 === row.id && (activity.kind === 'control' || activity.kind === 'command'))
  const outcome = await deps.reconnector.disconnect(row.stableId)
  return { status: 'done', outcome }
}

export type CutoverStartStatus = { status: 'done'; state: CutoverState } | { status: 'forbidden'; message: string } | { status: 'failed'; message: string }

/** `cutover` `op: 'start'` (plan 207 §4.2) — `devices.ts:1555-1600`'s body as a function. */
export async function cutoverStart(
  deps: { db: Db; activities: Pick<ActivityRegistry, 'list'>; cutover: CutoverManager; networks: () => FarmNetwork[] },
  deviceId: string,
  opts: { port?: number; medium: ConnectionMedium; address?: string },
): Promise<CutoverStartStatus> {
  const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
  if (!row) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
  const conn = deriveConnection(row.serial, deps.networks())
  if (conn.kind !== 'usb') {
    return { status: 'failed', message: `${row.label} is already on the network — use disconnect/reconnect, or declare its medium directly.` }
  }
  if (row.status === 'offline') {
    return { status: 'failed', message: `${row.label} is offline — connect it over USB before starting the cutover wizard.` }
  }
  if (hasRunningJob(deps.activities, row.id)) {
    return { status: 'forbidden', message: `a running job on ${row.label} — finish or cancel it before moving this device to the network` }
  }
  const state = await deps.cutover.start({ id: row.id, stableId: row.stableId, serial: row.serial, label: row.label }, opts)
  return { status: 'done', state }
}

export function cutoverCancel(cutover: CutoverManager, stableId: string): { cancelled: true } {
  cutover.cancel(stableId)
  return { cancelled: true }
}
