import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { groups, devices } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { assignDevices, groupMembers, deleteGroupAndUnassign, unassignDevices } from './membership'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, groupId: string | null = null): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'idle', groupId })
    .run()
}

function seedGroup(db: Db, id: string, name: string): void {
  db.insert(groups).values({ id, name, description: null, createdAt: new Date() }).run()
}

describe('assignDevices (plan 22.0 §4.3)', () => {
  test('assigns ungrouped devices and reports from: null', () => {
    const db = setUp()
    seedGroup(db, 'c1', 'Jakarta')
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')

    const { moved } = assignDevices(db, 'c1', ['d1', 'd2'])
    expect(moved.sort((a, b) => a.deviceId.localeCompare(b.deviceId))).toEqual([
      { deviceId: 'd1', from: null },
      { deviceId: 'd2', from: null },
    ])
    expect(groupMembers(db, 'c1').map((d) => d.id).sort()).toEqual(['d1', 'd2'])
  })

  test('moving a device already in another group reports what it moved from, and the old group no longer lists it', () => {
    const db = setUp()
    seedGroup(db, 'jakarta', 'Jakarta')
    seedGroup(db, 'bandung', 'Bandung')
    seedDevice(db, 'd1', 'jakarta')

    const { moved } = assignDevices(db, 'bandung', ['d1'])
    expect(moved).toEqual([{ deviceId: 'd1', from: 'jakarta' }])
    expect(groupMembers(db, 'jakarta')).toEqual([])
    expect(groupMembers(db, 'bandung').map((d) => d.id)).toEqual(['d1'])
  })

  test('a device can never end up in two groups — the column IS the guarantee (plan 22.0 §3.2)', () => {
    const db = setUp()
    seedGroup(db, 'jakarta', 'Jakarta')
    seedGroup(db, 'bandung', 'Bandung')
    seedDevice(db, 'd1')

    assignDevices(db, 'jakarta', ['d1'])
    assignDevices(db, 'bandung', ['d1'])

    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.groupId).toBe('bandung')
    expect(groupMembers(db, 'jakarta')).toEqual([])
  })

  test('an unknown device id is rejected and nothing is assigned (transactional)', () => {
    const db = setUp()
    seedGroup(db, 'c1', 'Jakarta')
    seedDevice(db, 'd1')

    expect(() => assignDevices(db, 'c1', ['d1', 'ghost'])).toThrow(EnkakuError)
    // Nothing committed — not even the valid half of the batch.
    expect(groupMembers(db, 'c1')).toEqual([])
  })

  test('an unknown group id is rejected', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    expect(() => assignDevices(db, 'ghost-group', ['d1'])).toThrow(EnkakuError)
  })
})

describe('unassignDevices', () => {
  test('clears the group field, leaving the device otherwise untouched', () => {
    const db = setUp()
    seedGroup(db, 'c1', 'Jakarta')
    seedDevice(db, 'd1', 'c1')

    unassignDevices(db, ['d1'])
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.groupId).toBeNull()
    expect(row?.label).toBe('device d1')
  })

  test('an unknown device id is rejected', () => {
    const db = setUp()
    expect(() => unassignDevices(db, ['ghost'])).toThrow(EnkakuError)
  })
})

describe('deleteGroupAndUnassign (plan 22.0 §3.6)', () => {
  test('deletes the group and unassigns its members, but deletes no device', () => {
    const db = setUp()
    seedGroup(db, 'c1', 'Jakarta')
    seedDevice(db, 'd1', 'c1')
    seedDevice(db, 'd2', 'c1')

    deleteGroupAndUnassign(db, 'c1')

    expect(db.select().from(groups).where(eq(groups.id, 'c1')).get()).toBeUndefined()
    const d1 = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    const d2 = db.select().from(devices).where(eq(devices.id, 'd2')).get()
    expect(d1?.groupId).toBeNull()
    expect(d2?.groupId).toBeNull()
  })

  test('an unknown group id is rejected', () => {
    const db = setUp()
    expect(() => deleteGroupAndUnassign(db, 'ghost')).toThrow(EnkakuError)
  })
})
