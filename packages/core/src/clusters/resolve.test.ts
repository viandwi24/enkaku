import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { clusters, deviceTags, devices, type ClusterRow } from '../db/schema'
import { resolveCluster, resolveTarget } from './resolve'

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

function tag(db: Db, deviceId: string, t: string) {
  db.insert(deviceTags).values({ deviceId, tag: t, at: new Date() }).run()
}

describe('resolveTarget — tags AND semantics (plan 19 §4.3, plan 20 §4.3)', () => {
  test('a device must carry every listed tag', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedDevice(db, 'd3')
    tag(db, 'd1', 'pool:smoke')
    tag(db, 'd1', 'android:15')
    tag(db, 'd2', 'pool:smoke')
    tag(db, 'd3', 'android:15')

    const result = resolveTarget(db, { tags: ['pool:smoke', 'android:15'], deviceIds: [] })
    expect(result.usable.map((r) => r.deviceId)).toEqual(['d1'])
  })

  test('explicit ids are always included regardless of tags', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    tag(db, 'd1', 'pool:smoke')

    const result = resolveTarget(db, { tags: ['pool:smoke'], deviceIds: ['d2'] })
    const ids = result.usable.map((r) => r.deviceId).sort()
    expect(ids).toEqual(['d1', 'd2'])
    expect(result.usable.find((r) => r.deviceId === 'd2')?.via).toBe('explicit')
    expect(result.usable.find((r) => r.deviceId === 'd1')?.via).toBe('tag')
  })

  test('a device is never listed twice when it matches both a tag and the explicit list', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    tag(db, 'd1', 'pool:smoke')

    const result = resolveTarget(db, { tags: ['pool:smoke'], deviceIds: ['d1'] })
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

    const result = resolveTarget(db, { tags: ['pool:smoke'], deviceIds: [] })
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
    const result = resolveTarget(db, { tags: [], deviceIds: ['ghost'] })
    expect(result.usable).toEqual([])
    expect(result.skipped).toEqual([{ deviceId: 'ghost', reason: 'no longer exists' }])
  })

  test('no tags and no explicit ids resolves to nothing, cleanly', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const result = resolveTarget(db, { tags: [], deviceIds: [] })
    expect(result.usable).toEqual([])
    expect(result.skipped).toEqual([])
  })
})

describe('resolveCluster — a membership lookup (plan 22.0 §3.5, §4.3)', () => {
  function seedCluster(db: Db, id: string, name: string): ClusterRow {
    const row: ClusterRow = { id, name, description: null, createdAt: new Date() }
    db.insert(clusters).values(row).run()
    return row
  }

  test('resolves exactly the devices whose cluster_id points at it — tags play no part', () => {
    const db = setUp()
    const cluster = seedCluster(db, 'c1', 'Smoke')
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    db.update(devices).set({ clusterId: 'c1' }).where(eq(devices.id, 'd1')).run()
    // d2 carries the same tag a Plan 20 cluster would have matched on, but is
    // not assigned to this cluster — it must not appear.
    tag(db, 'd2', 'pool:smoke')

    const result = resolveCluster(db, cluster)
    expect(result.usable.map((r) => r.deviceId)).toEqual(['d1'])
    expect(result.usable[0]?.via).toBe('cluster')
  })

  test('an offline or quarantined member is reported skipped, with a reason, never dropped', () => {
    const db = setUp()
    const cluster = seedCluster(db, 'c1', 'Smoke')
    seedDevice(db, 'd1', 'offline')
    seedDevice(db, 'd2', 'quarantined')
    seedDevice(db, 'd3', 'idle')
    for (const id of ['d1', 'd2', 'd3']) db.update(devices).set({ clusterId: 'c1' }).where(eq(devices.id, id)).run()

    const result = resolveCluster(db, cluster)
    expect(result.usable.map((r) => r.deviceId)).toEqual(['d3'])
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { deviceId: 'd1', reason: 'offline' },
        { deviceId: 'd2', reason: 'quarantined' },
      ]),
    )
  })

  test('a cluster with no members resolves to nothing, cleanly', () => {
    const db = setUp()
    const cluster = seedCluster(db, 'c1', 'Empty')
    seedDevice(db, 'd1')
    const result = resolveCluster(db, cluster)
    expect(result.usable).toEqual([])
    expect(result.skipped).toEqual([])
  })
})
