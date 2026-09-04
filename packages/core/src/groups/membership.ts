import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../db'
import { groups, devices, type DeviceRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

export interface GroupMove {
  deviceId: string
  /** The group id the device moved out of, or null if it had no group (plan 22.0 §4.3). */
  from: string | null
}

/**
 * Put devices into a group (plan 22.0 §3.2, §4.3). One transaction: every
 * device and the group itself must exist, or nothing is written. Assigning a
 * device that already belongs to another group moves it — an `UPDATE`
 * necessarily clears the previous value, which is the whole reason a device
 * can never end up in two groups at once.
 */
export function assignDevices(db: Db, groupId: string, deviceIds: string[]): { moved: GroupMove[] } {
  if (deviceIds.length === 0) return { moved: [] }
  const group = db.select().from(groups).where(eq(groups.id, groupId)).get()
  if (!group) throw new EnkakuError('group_not_found', `no such group: ${groupId}`)

  const rows = db.select().from(devices).where(inArray(devices.id, deviceIds)).all()
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const missing = deviceIds.filter((id) => !rowById.has(id))
  if (missing.length > 0) {
    throw new EnkakuError('device_not_found', `no such device(s): ${missing.join(', ')}`)
  }

  const moved: GroupMove[] = deviceIds.map((id) => ({ deviceId: id, from: rowById.get(id)?.groupId ?? null }))

  db.transaction((tx) => {
    for (const id of deviceIds) {
      tx.update(devices).set({ groupId }).where(eq(devices.id, id)).run()
    }
  })

  return { moved }
}

/** Take devices out of whatever group they are in (plan 22.0 §4.3). Unknown ids are rejected. */
export function unassignDevices(db: Db, deviceIds: string[]): void {
  if (deviceIds.length === 0) return
  const rows = db.select({ id: devices.id }).from(devices).where(inArray(devices.id, deviceIds)).all()
  const found = new Set(rows.map((r) => r.id))
  const missing = deviceIds.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new EnkakuError('device_not_found', `no such device(s): ${missing.join(', ')}`)
  }
  db.transaction((tx) => {
    for (const id of deviceIds) {
      tx.update(devices).set({ groupId: null }).where(eq(devices.id, id)).run()
    }
  })
}

/** Every device currently owned by a group — the membership lookup itself (plan 22.0 §3.5). */
export function groupMembers(db: Db, groupId: string): DeviceRow[] {
  return db.select().from(devices).where(eq(devices.groupId, groupId)).all()
}

/**
 * Delete a group and unassign its members in the same transaction (plan
 * 22.0 §3.6): the devices lose their group, nothing else about them changes,
 * and no device row is ever touched by a group delete beyond its `group_id`.
 */
export function deleteGroupAndUnassign(db: Db, groupId: string): void {
  const group = db.select().from(groups).where(eq(groups.id, groupId)).get()
  if (!group) throw new EnkakuError('group_not_found', `no such group: ${groupId}`)
  db.transaction((tx) => {
    tx.update(devices).set({ groupId: null }).where(eq(devices.groupId, groupId)).run()
    tx.delete(groups).where(eq(groups.id, groupId)).run()
  })
}
