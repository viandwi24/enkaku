import { inArray } from 'drizzle-orm'
import type { DeviceLabelRef } from '@enkaku/protocol'
import type { Db } from '../../db'
import { devices } from '../../db/schema'
import { assignDevices, unassignDevices, type GroupMove } from '../../groups/membership'
import { applyDeviceLabels, type LabelDiff } from '../../registry/device-labels'

/**
 * `set-group` (plan 207 §4.2) — one call for every accepted device
 * (`assignDevices`/`unassignDevices` are already one-transaction, multi-id
 * operations); returns a map so the router can build each device's
 * `detail: { movedFrom }`.
 */
export function setGroup(db: Db, deviceIds: string[], groupId: string | null): Map<string, GroupMove> {
  if (groupId !== null) {
    const moved = assignDevices(db, groupId, deviceIds).moved
    return new Map(moved.map((m) => [m.deviceId, m]))
  }
  const rows = db.select({ id: devices.id, groupId: devices.groupId }).from(devices).where(inArray(devices.id, deviceIds)).all()
  const fromById = new Map(rows.map((r) => [r.id, r.groupId]))
  unassignDevices(db, deviceIds)
  return new Map(deviceIds.map((deviceId) => [deviceId, { deviceId, from: fromById.get(deviceId) ?? null }]))
}

/**
 * `set-labels` (plan 225 §4.5) — one device at a time, because unlike
 * `setGroup` above each device's result depends on what it already carries:
 * `add` is a union with its current set, not an assignment.
 */
export function setLabels(
  db: Db,
  deviceId: string,
  op: 'add' | 'remove' | 'replace',
  labelIds: string[],
): { labels: DeviceLabelRef[]; diff: LabelDiff } {
  return applyDeviceLabels(db, deviceId, op, labelIds)
}
