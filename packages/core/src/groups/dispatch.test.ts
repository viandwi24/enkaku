import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobRuns, jobs } from '../db/schema'
import { createRunStore } from '../jobs/runs/store'
import { createAuditLogger } from '../auth/audit'
import { createLogger } from '../util/logger'
import type { Scheduler } from '../queue/scheduler'
import { createBatchPacer } from './pacer'
import { createWorkflowBatch, type CreateWorkflowBatchInput } from './dispatch'

/**
 * `createWorkflowBatch` (plan 313 §4.4, G6).
 *
 * Plan 313 §11 recorded the absence of this file as a real gap: the pacing
 * columns and the `planFirst` call were verified only by reading them, and
 * `pacer.test.ts` deliberately covers just the pure arithmetic. What is
 * actually load-bearing is the SEAM — a workflow batch is an ordinary batch
 * row, so the pacer that has staggered script batches since plan 94 staggers
 * this one too, with no code of its own. That is what these tests hold.
 *
 * The pacer is built with a seeded `randomUint32` and a fixed `clock`, so the
 * stagger below is exact rather than approximate.
 */

const DOC = {
  schema: 2,
  name: 'seq',
  title: '',
  description: '',
  params: [],
  entry: 'start',
  maxSteps: 50,
  nodes: [
    { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, enabled: true, next: 'a' },
    { kind: 'script', id: 'a', title: '', ui: { x: 0, y: 0 }, enabled: true, script: 'demo/a@1.0.0', params: {} },
  ],
}

const NOW = new Date('2026-09-07T00:00:00Z')

function setUp(deviceIds: string[] = ['d1', 'd2', 'd3']) {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const db: Db = opened.db
  for (const id of deviceIds) {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'online' }).run()
  }
  const runs = createRunStore(db)
  const scheduler: Scheduler = { kick: () => {}, start: () => {}, stop: () => {} }
  const log = createLogger('test')
  // A fixed draw, so `deviceDelayMs` lands on a value this test can name.
  const pacer = createBatchPacer({ db, runs, scheduler, log, randomUint32: () => 0, clock: () => NOW })
  const deps = { db, runs, scheduler, audit: createAuditLogger(db), onJobStatus: () => {}, pacer }
  return { db, deps, pacer }
}

function baseInput(overrides: Partial<CreateWorkflowBatchInput> = {}): CreateWorkflowBatchInput {
  return {
    workflowName: 'seq',
    workflowDoc: DOC,
    params: {},
    target: { deviceIds: ['d1', 'd2', 'd3'] },
    concurrency: 0,
    order: 'as-listed',
    createdBy: null,
    ...overrides,
  }
}

describe('createWorkflowBatch — pacing reaches the batch row (plan 313 §4.4)', () => {
  test('a batch with no pacing writes exactly the columns it wrote before this plan', () => {
    const { db, deps } = setUp()
    const { batch } = createWorkflowBatch(deps, baseInput())
    const row = db.select().from(batches).where(eq(batches.id, batch.id)).get()
    expect(row).toMatchObject({ repeatCount: 1, intervalMinMs: 0, intervalMaxMs: 0, deviceIntervalMs: 0, deviceDelayMinMs: 0, deviceDelayMaxMs: 0 })
  })

  test('"open the phones one by one, 20-30 seconds apart" lands on the row', () => {
    const { db, deps } = setUp()
    const { batch } = createWorkflowBatch(
      deps,
      baseInput({ pacing: { count: 1, intervalMs: [0, 0], deviceIntervalMs: 5_000, deviceDelayMs: [20_000, 30_000] } }),
    )
    const row = db.select().from(batches).where(eq(batches.id, batch.id)).get()
    expect(row).toMatchObject({ deviceIntervalMs: 5_000, deviceDelayMinMs: 20_000, deviceDelayMaxMs: 30_000 })
  })
})

describe('createWorkflowBatch — planFirst actually runs (plan 313 §4.4, G6)', () => {
  test('the members are staggered: without this call the columns would be stored and inert', () => {
    const { db, deps } = setUp()
    const { batch } = createWorkflowBatch(deps, baseInput({ pacing: { count: 1, intervalMs: [0, 0], deviceIntervalMs: 30_000, deviceDelayMs: [0, 0] } }))

    const members = db.select().from(jobs).where(eq(jobs.batchId, batch.id)).orderBy(jobs.batchSeq).all()
    expect(members).toHaveLength(3)
    const delays = members.map((m) => {
      const run = db.select().from(jobRuns).where(eq(jobRuns.id, m.latestRunId as string)).get()
      return run?.pacedDelayMs ?? 0
    })
    // A 30 s ladder: device 0 starts now, device 1 at +30 s, device 2 at +60 s.
    // This is the whole assertion plan 313 §11 said was missing — it fails if
    // `deps.pacer?.planFirst(batchId)` is removed from `createWorkflowBatch`.
    expect(delays).toEqual([0, 30_000, 60_000])
  })

  test('a per-device delay range is drawn per member, not shared', () => {
    const { db, deps } = setUp()
    const { batch } = createWorkflowBatch(deps, baseInput({ pacing: { count: 1, intervalMs: [0, 0], deviceIntervalMs: 0, deviceDelayMs: [20_000, 30_000] } }))
    const members = db.select().from(jobs).where(eq(jobs.batchId, batch.id)).all()
    for (const m of members) {
      const run = db.select().from(jobRuns).where(eq(jobRuns.id, m.latestRunId as string)).get()
      // The seeded draw is the range's lower bound; what matters here is that
      // every member got one at all, rather than only the first.
      expect(run?.pacedDelayMs).toBe(20_000)
      expect(run?.notBefore).toBe(Math.floor(NOW.getTime() / 1000) + 20)
    }
  })

  test('an unpaced batch is left alone — no notBefore, exactly as before', () => {
    const { db, deps } = setUp()
    const { batch } = createWorkflowBatch(deps, baseInput())
    const members = db.select().from(jobs).where(eq(jobs.batchId, batch.id)).all()
    for (const m of members) {
      const run = db.select().from(jobRuns).where(eq(jobRuns.id, m.latestRunId as string)).get()
      expect(run?.pacedDelayMs ?? 0).toBe(0)
    }
  })
})

describe('createWorkflowBatch — order (plan 313 §4.4)', () => {
  test("'as-listed' keeps the caller's order, and batchSeq records it", () => {
    const { db, deps } = setUp()
    const { batch } = createWorkflowBatch(deps, baseInput({ target: { deviceIds: ['d1', 'd2', 'd3'] } }))
    const members = db.select().from(jobs).where(eq(jobs.batchId, batch.id)).orderBy(jobs.batchSeq).all()
    expect(members.map((m) => m.deviceId)).toEqual(['d1', 'd2', 'd3'])
  })

  test("'random' is recorded on the row and shuffles the members it dispatches", () => {
    // A shuffle of three can land back in order, so this asserts the two
    // things that are actually guaranteed — the row says what was asked for,
    // and every device still gets exactly one member — plus that SOME
    // ordering across repeated draws differs from the input.
    const orders = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const { db, deps } = setUp()
      const { batch } = createWorkflowBatch(deps, baseInput({ order: 'random' }))
      const row = db.select().from(batches).where(eq(batches.id, batch.id)).get()
      expect(row?.order).toBe('random')
      const members = db.select().from(jobs).where(eq(jobs.batchId, batch.id)).orderBy(jobs.batchSeq).all()
      expect([...members.map((m) => m.deviceId)].sort()).toEqual(['d1', 'd2', 'd3'])
      orders.add(members.map((m) => m.deviceId).join(','))
    }
    // Over 40 draws of 3! = 6 orderings, seeing only one is a shuffle that
    // does not shuffle — the exact bug `createWorkflowBatch`'s own comment
    // records having had once.
    expect(orders.size).toBeGreaterThan(1)
  })
})
