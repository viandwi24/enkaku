import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../db'
import { clusters, devices, type DeviceRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

export interface ClusterMove {
  deviceId: string
  /** The cluster id the device moved out of, or null if it was unclustered (plan 22.0 §4.3). */
  from: string | null
}

/**
 * Put devices into a cluster (plan 22.0 §3.2, §4.3). One transaction: every
 * device and the cluster itself must exist, or nothing is written. Assigning
 * a device that already belongs to another cluster moves it — an `UPDATE`
 * necessarily clears the previous value, which is the whole reason a device
 * can never end up in two clusters at once.
 */
export function assignDevices(db: Db, clusterId: string, deviceIds: string[]): { moved: ClusterMove[] } {
  if (deviceIds.length === 0) return { moved: [] }
  const cluster = db.select().from(clusters).where(eq(clusters.id, clusterId)).get()
  if (!cluster) throw new EnkakuError('cluster_not_found', `no such cluster: ${clusterId}`)

  const rows = db.select().from(devices).where(inArray(devices.id, deviceIds)).all()
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const missing = deviceIds.filter((id) => !rowById.has(id))
  if (missing.length > 0) {
    throw new EnkakuError('device_not_found', `no such device(s): ${missing.join(', ')}`)
  }

  const moved: ClusterMove[] = deviceIds.map((id) => ({ deviceId: id, from: rowById.get(id)?.clusterId ?? null }))

  db.transaction((tx) => {
    for (const id of deviceIds) {
      tx.update(devices).set({ clusterId }).where(eq(devices.id, id)).run()
    }
  })

  return { moved }
}

/** Take devices out of whatever cluster they are in (plan 22.0 §4.3). Unknown ids are rejected. */
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
      tx.update(devices).set({ clusterId: null }).where(eq(devices.id, id)).run()
    }
  })
}

/** Every device currently owned by a cluster — the membership lookup itself (plan 22.0 §3.5). */
export function clusterMembers(db: Db, clusterId: string): DeviceRow[] {
  return db.select().from(devices).where(eq(devices.clusterId, clusterId)).all()
}

/**
 * Delete a cluster and unassign its members in the same transaction (plan
 * 22.0 §3.6): the devices become unclustered, nothing else about them
 * changes, and no device row is ever touched by a cluster delete beyond its
 * `cluster_id`.
 */
export function deleteClusterAndUnassign(db: Db, clusterId: string): void {
  const cluster = db.select().from(clusters).where(eq(clusters.id, clusterId)).get()
  if (!cluster) throw new EnkakuError('cluster_not_found', `no such cluster: ${clusterId}`)
  db.transaction((tx) => {
    tx.update(devices).set({ clusterId: null }).where(eq(devices.clusterId, clusterId)).run()
    tx.delete(clusters).where(eq(clusters.id, clusterId)).run()
  })
}
