import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { groups, deviceLabels, devices, labels, type GroupRow } from '../db/schema'
import { resolveGroup, resolveTarget } from './resolve'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'idle' | 'busy' | 'offline' | 'quarantined' = 'idle') {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status })
    .run()
}

/** Create the label if it is new, then put it on the device. Returns its id, which is what a target names. */
function tag(db: Db, deviceId: string, name: string): string {
  const existing = db.select().from(labels).where(eq(labels.name, name)).get()
  const id = existing?.id ?? crypto.randomUUID()
  if (!existing) db.insert(labels).values({ id, name, color: 'slate', description: null, createdAt: new Date() }).run()
  db.insert(deviceLabels).values({ deviceId, labelId: id, at: new Date() }).run()
  return id
}

/** The id of a label by name — a target names ids, the tests read better in names. */
function labelId(db: Db, name: string): string {
  return db.select().from(labels).where(eq(labels.name, name)).get()!.id
}

describe('resolveTarget — labels AND semantics (plan 225 §3.4, plan 20 §4.3)', () => {
  test('a device must carry every listed label', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedDevice(db, 'd3')
    tag(db, 'd1', 'pool:smoke')
    tag(db, 'd1', 'android:15')
    tag(db, 'd2', 'pool:smoke')
    tag(db, 'd3', 'android:15')

    const result = resolveTarget(db, { labelIds: [labelId(db, 'pool:smoke'), labelId(db, 'android:15')], deviceIds: [] })
    expect(result.usable.map((r) => r.deviceId)).toEqual(['d1'])
  })

  test('explicit ids are always included regardless of labels', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    tag(db, 'd1', 'pool:smoke')

    const result = resolveTarget(db, { labelIds: [labelId(db, 'pool:smoke')], deviceIds: ['d2'] })
    const ids = result.usable.map((r) => r.deviceId).sort()
    expect(ids).toEqual(['d1', 'd2'])
    expect(result.usable.find((r) => r.deviceId === 'd2')?.via).toBe('explicit')
    expect(result.usable.find((r) => r.deviceId === 'd1')?.via).toBe('label')
  })

  test('a device is never listed twice when it matches both a tag and the explicit list', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    tag(db, 'd1', 'pool:smoke')

    const result = resolveTarget(db, { labelIds: [labelId(db, 'pool:smoke')], deviceIds: ['d1'] })
    expect(result.usable.length).toBe(1)
  })

  test('offline and quarantined devices are reported in skipped, with a reason, not silently dropped', () => {
    const db = setUp()
    seedDevice(db, 'd1', 'offline')
    seedDevice(db, 'd2', 'quarantined')
    seedDevice(db, 'd3', 'idle')
    tag(db, 'd1', 'pool:smoke')
    tag(db, 'd2', 'pool:smoke')
    tag(db, 'd3', 'pool:smoke')

    const result = resolveTarget(db, { labelIds: [labelId(db, 'pool:smoke')], deviceIds: [] })
    expect(result.usable.map((r) => r.deviceId)).toEqual(['d3'])
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { deviceId: 'd1', reason: 'offline' },
        { deviceId: 'd2', reason: 'quarantined' },
      ]),
    )
  })

  test('an explicit id for a device that no longer exists is reported skipped', () => {
    const db = setUp()
    const result = resolveTarget(db, { labelIds: [], deviceIds: ['ghost'] })
    expect(result.usable).toEqual([])
    expect(result.skipped).toEqual([{ deviceId: 'ghost', reason: 'no longer exists' }])
  })

  test('no tags and no explicit ids resolves to nothing, cleanly', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const result = resolveTarget(db, { labelIds: [], deviceIds: [] })
    expect(result.usable).toEqual([])
    expect(result.skipped).toEqual([])
  })
})

describe('resolveGroup — a membership lookup (plan 22.0 §3.5, §4.3)', () => {
  function seedGroup(db: Db, id: string, name: string): GroupRow {
    const row: GroupRow = { id, name, description: null, createdAt: new Date() }
    db.insert(groups).values(row).run()
    return row
  }

  test('resolves exactly the devices whose group_id points at it — tags play no part', () => {
    const db = setUp()
    const group = seedGroup(db, 'c1', 'Smoke')
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    db.update(devices).set({ groupId: 'c1' }).where(eq(devices.id, 'd1')).run()
    // d2 carries the same tag a Plan 20 group would have matched on, but is
    // not assigned to this group — it must not appear.
    tag(db, 'd2', 'pool:smoke')

    const result = resolveGroup(db, group)
    expect(result.usable.map((r) => r.deviceId)).toEqual(['d1'])
    expect(result.usable[0]?.via).toBe('group')
  })

  test('an offline or quarantined member is reported skipped, with a reason, never dropped', () => {
    const db = setUp()
    const group = seedGroup(db, 'c1', 'Smoke')
    seedDevice(db, 'd1', 'offline')
    seedDevice(db, 'd2', 'quarantined')
    seedDevice(db, 'd3', 'idle')
    for (const id of ['d1', 'd2', 'd3']) db.update(devices).set({ groupId: 'c1' }).where(eq(devices.id, id)).run()

    const result = resolveGroup(db, group)
    expect(result.usable.map((r) => r.deviceId)).toEqual(['d3'])
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { deviceId: 'd1', reason: 'offline' },
        { deviceId: 'd2', reason: 'quarantined' },
      ]),
    )
  })

  test('a group with no members resolves to nothing, cleanly', () => {
    const db = setUp()
    const group = seedGroup(db, 'c1', 'Empty')
    seedDevice(db, 'd1')
    const result = resolveGroup(db, group)
    expect(result.usable).toEqual([])
    expect(result.skipped).toEqual([])
  })
})
