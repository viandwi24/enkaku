import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobs } from '../db/schema'
import { createJobStore } from './job-store'

/**
 * The claim query (plan 20 §4.2, §7) is the only place device booking is
 * made race-free (spec §10.3). These tests are written against the gate the
 * rewrite must add: a batch's `concurrency` must never be exceeded, batch
 * order must be respected, and neither may ever push a standalone job — or a
 * higher-priority one — behind a batch. Written before the rewrite so they
 * fail against the old statement (no batch awareness at all) and pass
 * against the new one.
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'idle' | 'busy' | 'offline' = 'idle') {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status })
    .run()
}

function seedBatch(db: Db, id: string, concurrency: number, order: 'as-listed' | 'random' = 'as-listed') {
  db.insert(batches)
    .values({ id, scriptId: 'internal:sleep', concurrency, order, status: 'queued', createdAt: new Date() })
    .run()
}

let seq = 0
/** created_at is integer unix seconds: two jobs seeded in the same test tick
 * would otherwise tie, which is exactly the scenario worth exercising, but
 * `createdAt` lets a test force an explicit order when it needs one. */
function seedJob(
  db: Db,
  input: {
    deviceId: string
    priority?: number
    batchId?: string | null
    batchSeq?: number | null
    createdAt?: Date
  },
) {
  const id = `job-${++seq}`
  db.insert(jobs)
    .values({
      id,
      scriptId: 'internal:sleep',
      deviceId: input.deviceId,
      params: { durationMs: 1000 },
      priority: input.priority ?? 0,
      status: 'queued',
      createdAt: input.createdAt ?? new Date(),
      batchId: input.batchId ?? null,
      batchSeq: input.batchSeq ?? null,
    })
    .run()
  return id
}

describe('claimNext — standalone jobs', () => {
  test('a standalone job (no batch) is claimed exactly once', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })

    const first = store.claimNext(60)
    expect(first?.job.id).toBe(jobId)
    expect(first?.job.status).toBe('running')

    const second = store.claimNext(60)
    expect(second).toBeNull()
  })
})

describe('claimNext — batch concurrency gate (plan 20 §4.2)', () => {
  test('concurrency=1 never yields two running jobs in the same batch', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })

    const claim1 = store.claimNext(60)
    expect(claim1).not.toBeNull()

    // Both devices are idle at this point except the one just claimed — the
    // second device is still idle, so a device-status-only gate would wrongly
    // let this second claim through.
    const claim2 = store.claimNext(60)
    expect(claim2).toBeNull()

    const running = db.select().from(jobs).where(eq(jobs.batchId, 'b1')).all().filter((j) => j.status === 'running')
    expect(running.length).toBe(1)
  })

  test('concurrency=1: finishing the running job frees the next slot', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const job0 = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })

    const claim1 = store.claimNext(60)
    expect(claim1?.job.id).toBe(job0)
    expect(store.claimNext(60)).toBeNull()

    store.finish(job0, 'success', {})
    // The device frees up independently of the batch gate (plan 20 §3.3 —
    // per-device idleness is a separate, pre-existing constraint).
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd1')).run()

    const claim2 = store.claimNext(60)
    expect(claim2).not.toBeNull()
    expect(claim2?.deviceId).toBe('d2')
  })

  test('concurrency=2 never yields three running jobs in the same batch', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 2)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })
    seedJob(db, { deviceId: 'd3', batchId: 'b1', batchSeq: 2 })

    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).toBeNull()

    const running = db.select().from(jobs).where(eq(jobs.batchId, 'b1')).all().filter((j) => j.status === 'running')
    expect(running.length).toBe(2)
  })

  test('concurrency=0 (unlimited) starts every device at once', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 0)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })
    seedJob(db, { deviceId: 'd3', batchId: 'b1', batchSeq: 2 })

    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).toBeNull()
  })

  test('a batch of 5 with concurrency=1: exactly one claim succeeds until it finishes (§7)', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    const deviceIds = ['d1', 'd2', 'd3', 'd4', 'd5']
    for (const d of deviceIds) seedDevice(db, d)
    const jobIds = deviceIds.map((d, i) => seedJob(db, { deviceId: d, batchId: 'b1', batchSeq: i }))

    const firstClaim = store.claimNext(60)
    expect(firstClaim?.job.id).toBe(jobIds[0])
    // Repeated calls, all devices still idle except the claimed one — none succeed.
    for (let i = 0; i < 4; i++) expect(store.claimNext(60)).toBeNull()
  })
})

describe('claimNext — batch order (plan 20 §3.2, §4.2)', () => {
  test('as-listed claims ascending batchSeq regardless of insert order', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 0)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    // Inserted out of seq order on purpose.
    const j2 = seedJob(db, { deviceId: 'd3', batchId: 'b1', batchSeq: 2 })
    const j0 = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    const j1 = seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })

    // concurrency=1 forces one-at-a-time so claim order is directly observable.
    db.update(batches).set({ concurrency: 1 }).where(eq(batches.id, 'b1')).run()

    const claim1 = store.claimNext(60)
    expect(claim1?.job.id).toBe(j0)
    store.finish(j0, 'success', {})
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd1')).run()

    const claim2 = store.claimNext(60)
    expect(claim2?.job.id).toBe(j1)
    store.finish(j1, 'success', {})
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd2')).run()

    const claim3 = store.claimNext(60)
    expect(claim3?.job.id).toBe(j2)
  })

  test('a standalone job (NULL batch_seq) is not pushed to the back at equal priority', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 0)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const now = new Date()
    // Same priority, same created_at second — the tie a NULLS-LAST ordering would lose.
    const batched = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0, priority: 0, createdAt: now })
    const standalone = seedJob(db, { deviceId: 'd2', priority: 0, createdAt: now })

    const claimed: string[] = []
    for (let i = 0; i < 2; i++) {
      const c = store.claimNext(60)
      if (c) claimed.push(c.job.id)
    }
    expect(claimed).toContain(standalone)
    expect(claimed).toContain(batched)
    // The standalone job must not be last among equal-priority, equal-age jobs.
    expect(claimed.indexOf(standalone)).toBeLessThanOrEqual(claimed.indexOf(batched))
  })
})

describe('claimNext — priority still dominates (plan 20 §3.3, acceptance #7)', () => {
  test('a standalone job at priority 10 wins over a batched job at priority 0', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 0)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const batched = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0, priority: 0 })
    const standalone = seedJob(db, { deviceId: 'd2', priority: 10 })

    const claim = store.claimNext(60)
    expect(claim?.job.id).toBe(standalone)
    expect(claim?.job.id).not.toBe(batched)
  })

  test('a standalone job is not blocked behind a running (concurrency-saturated) batch', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0, priority: 0 })
    const standaloneHigh = seedJob(db, { deviceId: 'd2', priority: 5 })

    // The batch's only slot fills first (it happens to be higher in this
    // ordering only because of priority — verify the standalone still gets served).
    const claim1 = store.claimNext(60)
    expect(claim1?.job.id).toBe(standaloneHigh)

    const claim2 = store.claimNext(60)
    expect(claim2).not.toBeNull() // the batch job, unaffected by the standalone
  })
})

describe('claimNext — restart continuation (plan 20 §7)', () => {
  test('with jobs half-finished, a fresh claimNext continues at the right batchSeq', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    const j0 = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    const j1 = seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })
    const j2 = seedJob(db, { deviceId: 'd3', batchId: 'b1', batchSeq: 2 })

    const c0 = store.claimNext(60)
    expect(c0?.job.id).toBe(j0)
    store.finish(j0, 'success', {})
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd1')).run()

    // Simulate a fresh JobStore instance (as a core restart would create).
    const restarted = createJobStore(db)
    const c1 = restarted.claimNext(60)
    expect(c1?.job.id).toBe(j1)
    expect(c1?.job.id).not.toBe(j2)
  })
})

describe('cancelQueuedDescendants (plan 81 §4.4, criterion 11)', () => {
  function trigger(db: Db, parentId: string, id: string, status: string) {
    db.insert(jobs)
      .values({ id, scriptId: 'internal:sleep', deviceId: 'd1', status, priority: 0, createdAt: new Date(), triggeredByJobId: parentId, depth: 1 })
      .run()
  }

  test('cancels every still-queued descendant, transitively, and leaves unrelated jobs alone', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const root = seedJob(db, { deviceId: 'd1' })
    // root -> c1 (queued) -> gc1 (queued)
    //      -> c2 (queued)
    trigger(db, root, 'c1', 'queued')
    trigger(db, 'c1', 'gc1', 'queued')
    trigger(db, root, 'c2', 'queued')
    // An unrelated standalone job — never triggered by anything.
    const unrelated = seedJob(db, { deviceId: 'd1' })

    const cancelled = store.cancelQueuedDescendants(root)
    expect(cancelled).toBe(3)
    expect(store.get('c1')?.status).toBe('cancelled')
    expect(store.get('gc1')?.status).toBe('cancelled')
    expect(store.get('c2')?.status).toBe('cancelled')
    expect(store.get(unrelated)?.status).toBe('queued') // untouched
    expect(store.get(root)?.status).toBe('queued') // the root itself is never touched by this call
  })

  test('a non-queued descendant (already running/finished) is left alone, not cancelled', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const root = seedJob(db, { deviceId: 'd1' })
    trigger(db, root, 'c1', 'running')
    trigger(db, root, 'c2', 'success')
    trigger(db, root, 'c3', 'queued')

    const cancelled = store.cancelQueuedDescendants(root)
    expect(cancelled).toBe(1)
    expect(store.get('c1')?.status).toBe('running')
    expect(store.get('c2')?.status).toBe('success')
    expect(store.get('c3')?.status).toBe('cancelled')
  })

  test('a sibling subtree (same root, different parent) is left alone — this walks triggeredByJobId, not rootJobId', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const root = seedJob(db, { deviceId: 'd1' })
    trigger(db, root, 'c1', 'queued')
    trigger(db, root, 'c2', 'queued') // c1's SIBLING — not a descendant of c1

    const cancelled = store.cancelQueuedDescendants('c1')
    expect(cancelled).toBe(0)
    expect(store.get('c2')?.status).toBe('queued')
  })
})

describe('list — rootJobId filter (plan 81 §4.5)', () => {
  function trigger(db: Db, rootId: string, parentId: string, id: string, depth: number) {
    db.insert(jobs)
      .values({
        id,
        scriptId: 'internal:sleep',
        deviceId: 'd1',
        status: 'queued',
        priority: 0,
        createdAt: new Date(),
        triggeredByJobId: parentId,
        rootJobId: rootId,
        depth,
      })
      .run()
  }

  test('returns every other member of the chain, excluding the root itself', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const root = seedJob(db, { deviceId: 'd1' })
    trigger(db, root, root, 'c1', 1)
    trigger(db, root, 'c1', 'gc1', 2)
    const unrelatedRoot = seedJob(db, { deviceId: 'd1' })
    trigger(db, unrelatedRoot, unrelatedRoot, 'other-c1', 1)

    const { rows, total } = store.list({ rootJobId: root, limit: 50 })
    expect(rows.map((r) => r.id).sort()).toEqual(['c1', 'gc1'])
    expect(total).toBe(2)
    // Neither the root's own row nor a different chain's members leak in.
    expect(rows.some((r) => r.id === root)).toBe(false)
    expect(rows.some((r) => r.id === 'other-c1')).toBe(false)
  })

  test('a job with no chain returns an empty page, not an error', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const standalone = seedJob(db, { deviceId: 'd1' })

    const { rows, total } = store.list({ rootJobId: standalone, limit: 50 })
    expect(rows).toEqual([])
    expect(total).toBe(0)
  })
})
