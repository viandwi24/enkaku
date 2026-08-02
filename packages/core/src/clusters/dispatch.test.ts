import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { clusters, devices, jobs, type ClusterRow } from '../db/schema'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import { createBatch } from './dispatch'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'idle' | 'offline' = 'idle') {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status })
    .run()
}

function fakeScheduler(): { scheduler: Scheduler; kicks: number } {
  const state = { kicks: 0 }
  return { scheduler: { kick: () => void state.kicks++, start: () => {}, stop: () => {} }, kicks: state.kicks }
}

describe('createBatch — resolution and dispatch (plan 20 §4.4, §7)', () => {
  test('dispatching to an ad-hoc device list creates one job per device with ascending batchSeq', () => {
    const db = setUp()
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()

    const { batch, jobs: created } = createBatch(
      { db, scheduler, audit, onJobStatus: () => {} },
      { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1', 'd2', 'd3'] }, concurrency: 0, order: 'as-listed' },
    )

    expect(created.length).toBe(3)
    expect(created.map((j) => j.batchSeq)).toEqual([0, 1, 2])
    expect(created.map((j) => j.deviceId)).toEqual(['d1', 'd2', 'd3'])
    expect(created.every((j) => j.batchId === batch.id)).toBe(true)

    const rows = db.select().from(jobs).where(eq(jobs.batchId, batch.id)).all()
    expect(rows.length).toBe(3)
  })

  test('order: random shuffles at dispatch and every job still gets a distinct, contiguous batchSeq', () => {
    const db = setUp()
    for (const d of ['d1', 'd2', 'd3', 'd4', 'd5']) seedDevice(db, d)
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()

    const { jobs: created } = createBatch(
      { db, scheduler, audit, onJobStatus: () => {} },
      {
        scriptId: 'internal:sleep',
        params: {},
        target: { deviceIds: ['d1', 'd2', 'd3', 'd4', 'd5'] },
        concurrency: 0,
        order: 'random',
      },
    )
    expect(created.map((j) => j.batchSeq).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 1, 2, 3, 4])
    // Every device still appears exactly once.
    expect(new Set(created.map((j) => j.deviceId)).size).toBe(5)
  })

  test('a cluster resolving to zero usable devices is a coded error, not an empty batch', () => {
    const db = setUp()
    seedDevice(db, 'd1', 'offline')
    const cluster: ClusterRow = { id: 'c1', name: 'Empty', description: null, createdAt: new Date() }
    db.insert(clusters).values(cluster).run()
    db.update(devices).set({ clusterId: 'c1' }).where(eq(devices.id, 'd1')).run()
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()

    expect(() =>
      createBatch(
        { db, scheduler, audit, onJobStatus: () => {} },
        { scriptId: 'internal:sleep', params: {}, target: { clusterId: 'c1' }, concurrency: 0, order: 'as-listed' },
      ),
    ).toThrow(EnkakuError)
    const batchRows = db.select().from(jobs).all()
    expect(batchRows.length).toBe(0)
  })

  test('dispatching to a cluster with mixed online/offline members runs only the online ones (plan 22.0, acceptance #5)', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2', 'offline')
    seedDevice(db, 'd3')
    const cluster: ClusterRow = { id: 'c1', name: 'Mixed', description: null, createdAt: new Date() }
    db.insert(clusters).values(cluster).run()
    for (const id of ['d1', 'd2', 'd3']) db.update(devices).set({ clusterId: 'c1' }).where(eq(devices.id, id)).run()
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()

    const { batch, jobs: created } = createBatch(
      { db, scheduler, audit, onJobStatus: () => {} },
      { scriptId: 'internal:sleep', params: {}, target: { clusterId: 'c1' }, concurrency: 0, order: 'as-listed' },
    )

    // The offline member is skipped, not dropped silently — it is simply not
    // among the jobs created; the batch itself still runs on the rest.
    expect(created.map((j) => j.deviceId).sort()).toEqual(['d1', 'd3'])
    expect(batch.clusterId).toBe('c1')
  })

  test('an unknown cluster id fails with cluster_not_found', () => {
    const db = setUp()
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()
    expect(() =>
      createBatch(
        { db, scheduler, audit, onJobStatus: () => {} },
        { scriptId: 'internal:sleep', params: {}, target: { clusterId: 'nope' }, concurrency: 0, order: 'as-listed' },
      ),
    ).toThrow(EnkakuError)
  })
})
