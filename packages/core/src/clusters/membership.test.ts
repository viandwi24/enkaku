import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { clusters, devices } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { assignDevices, clusterMembers, deleteClusterAndUnassign, unassignDevices } from './membership'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, clusterId: string | null = null): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'idle', clusterId })
    .run()
}

function seedCluster(db: Db, id: string, name: string): void {
  db.insert(clusters).values({ id, name, description: null, createdAt: new Date() }).run()
}

describe('assignDevices (plan 22.0 §4.3)', () => {
  test('assigns unclustered devices and reports from: null', () => {
    const db = setUp()
    seedCluster(db, 'c1', 'Jakarta')
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')

    const { moved } = assignDevices(db, 'c1', ['d1', 'd2'])
    expect(moved.sort((a, b) => a.deviceId.localeCompare(b.deviceId))).toEqual([
      { deviceId: 'd1', from: null },
      { deviceId: 'd2', from: null },
    ])
    expect(clusterMembers(db, 'c1').map((d) => d.id).sort()).toEqual(['d1', 'd2'])
  })

  test('moving a device already in another cluster reports what it moved from, and the old cluster no longer lists it', () => {
    const db = setUp()
    seedCluster(db, 'jakarta', 'Jakarta')
    seedCluster(db, 'bandung', 'Bandung')
    seedDevice(db, 'd1', 'jakarta')

    const { moved } = assignDevices(db, 'bandung', ['d1'])
    expect(moved).toEqual([{ deviceId: 'd1', from: 'jakarta' }])
    expect(clusterMembers(db, 'jakarta')).toEqual([])
    expect(clusterMembers(db, 'bandung').map((d) => d.id)).toEqual(['d1'])
  })

  test('a device can never end up in two clusters — the column IS the guarantee (plan 22.0 §3.2)', () => {
    const db = setUp()
    seedCluster(db, 'jakarta', 'Jakarta')
    seedCluster(db, 'bandung', 'Bandung')
    seedDevice(db, 'd1')

    assignDevices(db, 'jakarta', ['d1'])
    assignDevices(db, 'bandung', ['d1'])

    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.clusterId).toBe('bandung')
    expect(clusterMembers(db, 'jakarta')).toEqual([])
  })

  test('an unknown device id is rejected and nothing is assigned (transactional)', () => {
    const db = setUp()
    seedCluster(db, 'c1', 'Jakarta')
    seedDevice(db, 'd1')

    expect(() => assignDevices(db, 'c1', ['d1', 'ghost'])).toThrow(EnkakuError)
    // Nothing committed — not even the valid half of the batch.
    expect(clusterMembers(db, 'c1')).toEqual([])
  })

  test('an unknown cluster id is rejected', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    expect(() => assignDevices(db, 'ghost-cluster', ['d1'])).toThrow(EnkakuError)
  })
})

describe('unassignDevices', () => {
  test('clears the cluster field, leaving the device otherwise untouched', () => {
    const db = setUp()
    seedCluster(db, 'c1', 'Jakarta')
    seedDevice(db, 'd1', 'c1')

    unassignDevices(db, ['d1'])
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.clusterId).toBeNull()
    expect(row?.label).toBe('device d1')
  })

  test('an unknown device id is rejected', () => {
    const db = setUp()
    expect(() => unassignDevices(db, ['ghost'])).toThrow(EnkakuError)
  })
})

describe('deleteClusterAndUnassign (plan 22.0 §3.6)', () => {
  test('deletes the cluster and unassigns its members, but deletes no device', () => {
    const db = setUp()
    seedCluster(db, 'c1', 'Jakarta')
    seedDevice(db, 'd1', 'c1')
    seedDevice(db, 'd2', 'c1')

    deleteClusterAndUnassign(db, 'c1')

    expect(db.select().from(clusters).where(eq(clusters.id, 'c1')).get()).toBeUndefined()
    const d1 = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    const d2 = db.select().from(devices).where(eq(devices.id, 'd2')).get()
    expect(d1?.clusterId).toBeNull()
    expect(d2?.clusterId).toBeNull()
  })

  test('an unknown cluster id is rejected', () => {
    const db = setUp()
    expect(() => deleteClusterAndUnassign(db, 'ghost')).toThrow(EnkakuError)
  })
})
