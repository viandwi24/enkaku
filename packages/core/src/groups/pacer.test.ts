import { describe, expect, test } from 'bun:test'
import type { BatchStatusEvent } from '@enkaku/protocol'
import { asc, eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobs, type JobRow } from '../db/schema'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createLogger } from '../util/logger'
import { createBatch } from './dispatch'
import { createBatchPacer, drawIntervalMs, replanAfterRestart, type BatchPacer } from './pacer'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string) {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'online' }).run()
}

function fakeScheduler(): { scheduler: Scheduler; kicks: number[] } {
  const kicks: number[] = []
  return { scheduler: { kick: () => void kicks.push(kicks.length), start: () => {}, stop: () => {} }, kicks }
}

/** A fixed sequence of uint32s, cycling — deterministic, never `Math.random()` (the whole point of the seam). */
function seededRandom(seq: number[]): () => number {
  let i = 0
  return () => seq[i++ % seq.length] as number
}

function fakeClock(startMs: number): { clock: () => Date; advance: (ms: number) => void } {
  let now = startMs
  return { clock: () => new Date(now), advance: (ms: number) => (now += ms) }
}

describe('drawIntervalMs — the honest draw (F29)', () => {
  test('max <= min returns min with no draw at all (the intervalMs: [0, 0] default)', () => {
    let called = false
    const result = drawIntervalMs(0, 0, () => {
      called = true
      return 999
    })
    expect(result).toBe(0)
    expect(called).toBe(false)
  })

  test('every draw lands in [min, max], inclusive, across a wide seeded sequence', () => {
    const seq = [0, 1, 2, 3, 0xffffffff, 0x80000000, 1234567, 7, 100, 999999]
    const random = seededRandom(seq)
    for (let i = 0; i < seq.length; i++) {
      const v = drawIntervalMs(2000, 4000, random)
      expect(v).toBeGreaterThanOrEqual(2000)
      expect(v).toBeLessThanOrEqual(4000)
    }
  })

  test('a fixed seed reproduces the exact same draw — proving the source is swappable, not proving crypto is weak', () => {
    const random = seededRandom([5])
    expect(drawIntervalMs(1000, 1000, random)).toBe(1000) // span 1 — always min regardless of draw
    const random2 = seededRandom([0])
    expect(drawIntervalMs(0, 9, random2)).toBe(0)
  })
})

describe('BatchPacer.planFirst — the stagger (plan 94 §3.8)', () => {
  function dispatchPaced(db: Db, deviceIds: string[], opts: { count: number; intervalMs: [number, number]; deviceIntervalMs: number }, pacer?: BatchPacer) {
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()
    return createBatch(
      { db, scheduler, audit, onJobStatus: () => {}, pacer },
      { scriptId: 'internal:sleep', params: {}, target: { deviceIds }, concurrency: 0, order: 'as-listed', pacing: opts },
    )
  }

  test('device n starts ~n * deviceIntervalMs after device 0 — deterministic, not drawn', () => {
    const db = setUp()
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    const { clock } = fakeClock(1_000_000_000 * 1000)
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test'), clock, randomUint32: () => 0 })

    const { batch } = dispatchPaced(db, ['d1', 'd2', 'd3'], { count: 1, intervalMs: [0, 0], deviceIntervalMs: 1000 }, pacer)

    const rows = db.select().from(jobs).where(eq(jobs.batchId, batch.id)).orderBy(asc(jobs.batchSeq)).all()
    expect(rows.length).toBe(3)
    const nowSec = Math.floor(clock().getTime() / 1000)
    expect(rows[0]?.notBefore).toBeNull() // device 0 — no stagger
    expect(rows[0]?.pacedDelayMs).toBeNull()
    expect(rows[1]?.notBefore).toBe(nowSec + 1) // device 1 — 1000ms stagger
    expect(rows[1]?.pacedDelayMs).toBe(1000)
    expect(rows[2]?.notBefore).toBe(nowSec + 2) // device 2 — 2000ms stagger
    expect(rows[2]?.pacedDelayMs).toBe(2000)
    expect(rows.every((r) => r.batchRepeat === 0)).toBe(true)
  })

  test('deviceIntervalMs: 0 (no stagger) leaves notBefore null for every device — byte-identical to an unpaced batch', () => {
    const db = setUp()
    for (const d of ['d1', 'd2']) seedDevice(db, d)
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    const { batch } = dispatchPaced(db, ['d1', 'd2'], { count: 3, intervalMs: [0, 0], deviceIntervalMs: 0 }, pacer)
    const rows = db.select().from(jobs).where(eq(jobs.batchId, batch.id)).all()
    expect(rows.every((r) => r.notBefore === null)).toBe(true)
    expect(rows.every((r) => r.batchRepeat === 0)).toBe(true)
  })

  test('an unpaced batch (count: 1, every interval 0) with a wired pacer is a no-op — today\'s behaviour exactly', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })
    const { batch, jobs: created } = dispatchPaced(db, ['d1'], { count: 1, intervalMs: [0, 0], deviceIntervalMs: 0 }, pacer)
    expect(created[0]?.notBefore).toBeNull()
    expect(created[0]?.batchRepeat).toBeNull()
    const row = db.select().from(batches).where(eq(batches.id, batch.id)).get()
    expect(row?.repeatCount).toBe(1)
  })

  test('no pacer wired at all — createBatch behaves exactly as before this plan, even with a pacing block', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const { batch, jobs: created } = dispatchPaced(db, ['d1'], { count: 5, intervalMs: [1000, 2000], deviceIntervalMs: 500 })
    expect(created[0]?.notBefore).toBeNull()
    const row = db.select().from(batches).where(eq(batches.id, batch.id)).get()
    expect(row?.repeatCount).toBe(5) // the batch row still records the config...
    // ...but nothing ever plans off it without a pacer.
  })
})

describe('BatchPacer.onMemberSettled — the repeating clock (plan 94 §3.7, §3.8, §4.8)', () => {
  function seedBatch(db: Db, repeatCount: number, intervalMs: [number, number], deviceIntervalMs = 0): string {
    const id = crypto.randomUUID()
    db.insert(batches)
      .values({
        id,
        groupId: null,
        scriptId: 'internal:sleep',
        params: null,
        concurrency: 0,
        order: 'as-listed',
        status: 'running',
        repeatCount,
        intervalMinMs: intervalMs[0],
        intervalMaxMs: intervalMs[1],
        deviceIntervalMs,
        createdBy: null,
        createdAt: new Date(),
        finishedAt: null,
      })
      .run()
    return id
  }

  function seedJob(db: Db, batchId: string, deviceId: string, opts: { batchRepeat: number; status: string }): JobRow {
    const row: JobRow = {
      id: crypto.randomUUID(),
      scriptId: 'internal:sleep',
      deviceId,
      params: null,
      priority: 0,
      status: opts.status,
      heartbeatExpiresAt: null,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: opts.status === 'queued' || opts.status === 'running' ? null : new Date(),
      batchId,
      batchSeq: 0,
      expiresAt: null,
      notBefore: null,
      batchRepeat: opts.batchRepeat,
      pacedDelayMs: 0,
      failureClass: null,
      errorPhase: null,
      infraAttempts: 0,
      scriptName: null,
      scriptVersion: null,
      triggeredByJobId: null,
      rootJobId: null,
      depth: 0,
      triggerKey: null,
      peakRssBytes: null,
      maxConcurrent: null,
      runtimeOverride: null,
      resultStatus: null,
      resultBytes: null,
      resultSummary: null,
      resultIssues: null,
    }
    db.insert(jobs).values(row).run()
    return row
  }

  test('a settled device with fewer than repeatCount repetitions gets exactly one new job, with a delay drawn in [min, max] and materialised as pacedDelayMs', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const batchId = seedBatch(db, 3, [2000, 4000])
    seedJob(db, batchId, 'd1', { batchRepeat: 0, status: 'success' })
    const { scheduler, kicks } = fakeScheduler()
    const { clock } = fakeClock(2_000_000_000 * 1000)
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test'), clock, randomUint32: seededRandom([500]) })

    pacer.onMemberSettled(batchId, 'd1')

    const rows = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()
    expect(rows.length).toBe(2)
    const next = rows.find((r) => r.batchRepeat === 1)
    expect(next).toBeDefined()
    expect(next?.status).toBe('queued')
    expect(next?.pacedDelayMs).toBeGreaterThanOrEqual(2000)
    expect(next?.pacedDelayMs).toBeLessThanOrEqual(4000)
    const nowSec = Math.floor(clock().getTime() / 1000)
    expect(next?.notBefore).toBe(nowSec + Math.round((next?.pacedDelayMs ?? 0) / 1000))
    expect(kicks.length).toBeGreaterThan(0) // scheduler was kicked so the new row is reachable without waiting for the fallback tick
  })

  test('a device that already completed repeatCount repetitions gets no further job', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const batchId = seedBatch(db, 2, [1000, 1000])
    seedJob(db, batchId, 'd1', { batchRepeat: 0, status: 'success' })
    seedJob(db, batchId, 'd1', { batchRepeat: 1, status: 'success' })
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    pacer.onMemberSettled(batchId, 'd1')

    const rows = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()
    expect(rows.length).toBe(2) // unchanged
  })

  test('an unpaced batch (repeatCount: 1) never plans a second repetition', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const batchId = seedBatch(db, 1, [0, 0])
    seedJob(db, batchId, 'd1', { batchRepeat: 0, status: 'success' })
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    pacer.onMemberSettled(batchId, 'd1')

    expect(db.select().from(jobs).where(eq(jobs.batchId, batchId)).all().length).toBe(1)
  })

  test('a "stopping" batch never gets a further repetition planned — checked first, no window for one to sneak in', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const batchId = seedBatch(db, 5, [1000, 1000])
    db.update(batches).set({ status: 'stopping' }).where(eq(batches.id, batchId)).run()
    seedJob(db, batchId, 'd1', { batchRepeat: 0, status: 'success' })
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    pacer.onMemberSettled(batchId, 'd1')

    expect(db.select().from(jobs).where(eq(jobs.batchId, batchId)).all().length).toBe(1)
  })

  test('a terminal batch (success/failed/cancelled) never gets a further repetition planned', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const batchId = seedBatch(db, 5, [1000, 1000])
    db.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, batchId)).run()
    seedJob(db, batchId, 'd1', { batchRepeat: 0, status: 'cancelled' })
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    pacer.onMemberSettled(batchId, 'd1')

    expect(db.select().from(jobs).where(eq(jobs.batchId, batchId)).all().length).toBe(1)
  })

  test('multiple devices are paced independently — each keeps its own repetition count', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const batchId = seedBatch(db, 3, [500, 500])
    seedJob(db, batchId, 'd1', { batchRepeat: 0, status: 'success' })
    seedJob(db, batchId, 'd2', { batchRepeat: 0, status: 'success' })
    seedJob(db, batchId, 'd2', { batchRepeat: 1, status: 'success' })
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    pacer.onMemberSettled(batchId, 'd1')
    pacer.onMemberSettled(batchId, 'd2')

    const d1Rows = db.select().from(jobs).where(eq(jobs.deviceId, 'd1')).all()
    const d2Rows = db.select().from(jobs).where(eq(jobs.deviceId, 'd2')).all()
    expect(d1Rows.length).toBe(2) // 0 -> planned 1
    expect(d2Rows.length).toBe(3) // 0, 1 -> planned 2
    expect(Math.max(...d2Rows.map((r) => r.batchRepeat ?? -1))).toBe(2)
  })
})

describe('replanAfterRestart — restart safety (plan 94 §4.8)', () => {
  test('a device whose last repetition settled before the crash gets its next repetition planned on boot', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const id = crypto.randomUUID()
    db.insert(batches)
      .values({
        id,
        groupId: null,
        scriptId: 'internal:sleep',
        params: null,
        concurrency: 0,
        order: 'as-listed',
        status: 'running',
        repeatCount: 3,
        intervalMinMs: 100,
        intervalMaxMs: 100,
        deviceIntervalMs: 0,
        createdBy: null,
        createdAt: new Date(),
        finishedAt: null,
      })
      .run()
    db.insert(jobs)
      .values({
        id: crypto.randomUUID(),
        scriptId: 'internal:sleep',
        deviceId: 'd1',
        params: null,
        priority: 0,
        status: 'success',
        heartbeatExpiresAt: null,
        result: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: new Date(),
        batchId: id,
        batchSeq: 0,
        expiresAt: null,
        notBefore: null,
        batchRepeat: 0,
        pacedDelayMs: 0,
        failureClass: null,
        errorPhase: null,
        infraAttempts: 0,
        scriptName: null,
        scriptVersion: null,
        triggeredByJobId: null,
        rootJobId: null,
        depth: 0,
        triggerKey: null,
        peakRssBytes: null,
        maxConcurrent: null,
        runtimeOverride: null,
        resultStatus: null,
        resultBytes: null,
        resultSummary: null,
        resultIssues: null,
      })
      .run()
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    replanAfterRestart({ db, pacer })

    const rows = db.select().from(jobs).where(eq(jobs.batchId, id)).all()
    expect(rows.length).toBe(2)
    expect(rows.some((r) => r.batchRepeat === 1 && r.status === 'queued')).toBe(true)
  })

  test('a device still queued/running when the core stopped is left alone — its own eventual settle re-plans it', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const id = crypto.randomUUID()
    db.insert(batches)
      .values({
        id,
        groupId: null,
        scriptId: 'internal:sleep',
        params: null,
        concurrency: 0,
        order: 'as-listed',
        status: 'running',
        repeatCount: 3,
        intervalMinMs: 100,
        intervalMaxMs: 100,
        deviceIntervalMs: 0,
        createdBy: null,
        createdAt: new Date(),
        finishedAt: null,
      })
      .run()
    db.insert(jobs)
      .values({
        id: crypto.randomUUID(),
        scriptId: 'internal:sleep',
        deviceId: 'd1',
        params: null,
        priority: 0,
        status: 'running',
        heartbeatExpiresAt: null,
        result: null,
        error: null,
        createdAt: new Date(),
        startedAt: new Date(),
        finishedAt: null,
        batchId: id,
        batchSeq: 0,
        expiresAt: null,
        notBefore: null,
        batchRepeat: 0,
        pacedDelayMs: 0,
        failureClass: null,
        errorPhase: null,
        infraAttempts: 0,
        scriptName: null,
        scriptVersion: null,
        triggeredByJobId: null,
        rootJobId: null,
        depth: 0,
        triggerKey: null,
        peakRssBytes: null,
        maxConcurrent: null,
        runtimeOverride: null,
        resultStatus: null,
        resultBytes: null,
        resultSummary: null,
        resultIssues: null,
      })
      .run()
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    replanAfterRestart({ db, pacer })

    expect(db.select().from(jobs).where(eq(jobs.batchId, id)).all().length).toBe(1) // untouched
  })
})

/**
 * Plan 94 §5 step 94.11 — the orphan half of "Restart safety". The pacer
 * holds no process memory (§4.8's own opening line): it resumes purely from
 * `jobs.notBefore`/`.batchRepeat`/`.pacedDelayMs`. The re-plan loop above
 * already covers "a device settled and the NEXT repetition was never
 * planned" — these tests cover the other half: a batch whose LAST device's
 * LAST repetition already settled before the crash, so there is nothing
 * left to plan, but `batches.status` is still cached at `queued`/`running`
 * because the crash landed between the job settling and
 * `groups/status.ts`'s `recomputeBatchStatus` running — a batch with zero
 * live jobs that no other sweep in this codebase ever looks at again,
 * because its own status claims it is already done... except it is not
 * done, it is stuck.
 */
describe('replanAfterRestart — closing an orphaned paced batch (plan 94 §5 step 94.11)', () => {
  function seedBatch(db: Db, status: 'queued' | 'running' | 'stopping', repeatCount: number): string {
    const id = crypto.randomUUID()
    db.insert(batches)
      .values({
        id,
        groupId: null,
        scriptId: 'internal:sleep',
        params: null,
        concurrency: 0,
        order: 'as-listed',
        status,
        repeatCount,
        intervalMinMs: 100,
        intervalMaxMs: 100,
        deviceIntervalMs: 0,
        createdBy: null,
        createdAt: new Date(),
        finishedAt: null,
      })
      .run()
    return id
  }

  function seedJob(db: Db, batchId: string, deviceId: string, opts: { batchRepeat: number; status: string }): JobRow {
    const row: JobRow = {
      id: crypto.randomUUID(),
      scriptId: 'internal:sleep',
      deviceId,
      params: null,
      priority: 0,
      status: opts.status,
      heartbeatExpiresAt: null,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: opts.status === 'queued' || opts.status === 'running' ? null : new Date(),
      batchId,
      batchSeq: 0,
      expiresAt: null,
      notBefore: null,
      batchRepeat: opts.batchRepeat,
      pacedDelayMs: 0,
      failureClass: null,
      errorPhase: null,
      infraAttempts: 0,
      scriptName: null,
      scriptVersion: null,
      triggeredByJobId: null,
      rootJobId: null,
      depth: 0,
      triggerKey: null,
      peakRssBytes: null,
      maxConcurrent: null,
      runtimeOverride: null,
      resultStatus: null,
      resultBytes: null,
      resultSummary: null,
      resultIssues: null,
    }
    db.insert(jobs).values(row).run()
    return row
  }

  test('a paced batch whose only device already reached repeatCount, cached "running" from a crash, is closed to "success" on boot when jobStore/broadcast are wired', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const id = seedBatch(db, 'running', 2)
    seedJob(db, id, 'd1', { batchRepeat: 0, status: 'success' })
    seedJob(db, id, 'd1', { batchRepeat: 1, status: 'success' }) // completed === repeatCount already
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })
    const broadcasts: BatchStatusEvent[] = []

    replanAfterRestart({ db, pacer, jobStore: createJobStore(db), broadcast: (msg) => broadcasts.push(msg) })

    const row = db.select().from(batches).where(eq(batches.id, id)).get()
    expect(row?.status).toBe('success')
    expect(row?.finishedAt).not.toBeNull()
    // No phantom repetition planned — completed already equals repeatCount.
    expect(db.select().from(jobs).where(eq(jobs.batchId, id)).all().length).toBe(2)
    expect(broadcasts.some((b) => b.payload.batchId === id && b.payload.status === 'success')).toBe(true)
  })

  test('a paced batch whose only device already reached repeatCount with one failure closes to "failed", not "success"', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const id = seedBatch(db, 'running', 2)
    seedJob(db, id, 'd1', { batchRepeat: 0, status: 'success' })
    seedJob(db, id, 'd1', { batchRepeat: 1, status: 'failed' })
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    replanAfterRestart({ db, pacer, jobStore: createJobStore(db), broadcast: () => {} })

    const row = db.select().from(batches).where(eq(batches.id, id)).get()
    expect(row?.status).toBe('failed')
  })

  test('without jobStore/broadcast wired (a test harness with no interest in it), the re-plan still runs but the orphan reconciliation is skipped — same as every other optional accessor in this codebase', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const id = seedBatch(db, 'running', 2)
    seedJob(db, id, 'd1', { batchRepeat: 0, status: 'success' })
    seedJob(db, id, 'd1', { batchRepeat: 1, status: 'success' })
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    replanAfterRestart({ db, pacer })

    const row = db.select().from(batches).where(eq(batches.id, id)).get()
    expect(row?.status).toBe('running') // unchanged — nothing closed it
  })

  test('a batch left "stopping" by an operator is never touched by this sweep — not resurrected, not reconciled', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const id = seedBatch(db, 'stopping', 2)
    seedJob(db, id, 'd1', { batchRepeat: 0, status: 'success' })
    seedJob(db, id, 'd1', { batchRepeat: 1, status: 'success' })
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })
    const broadcasts: BatchStatusEvent[] = []

    replanAfterRestart({ db, pacer, jobStore: createJobStore(db), broadcast: (msg) => broadcasts.push(msg) })

    const row = db.select().from(batches).where(eq(batches.id, id)).get()
    expect(row?.status).toBe('stopping') // untouched — `nonTerminal` never selects it
    expect(broadcasts).toHaveLength(0)
    expect(db.select().from(jobs).where(eq(jobs.batchId, id)).all().length).toBe(2) // no phantom repetition
  })

  test('a paced batch with zero job rows at all (defensive — should not happen in practice) is logged and closed to "failed" rather than left orphaned forever', () => {
    const db = setUp()
    const id = seedBatch(db, 'queued', 3) // no job rows inserted at all
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })
    const broadcasts: BatchStatusEvent[] = []

    replanAfterRestart({ db, pacer, jobStore: createJobStore(db), broadcast: (msg) => broadcasts.push(msg) })

    const row = db.select().from(batches).where(eq(batches.id, id)).get()
    expect(row?.status).toBe('failed')
    expect(row?.finishedAt).not.toBeNull()
    expect(broadcasts.some((b) => b.payload.batchId === id && b.payload.status === 'failed')).toBe(true)
  })

  test('a batch still mid-flight (fewer repetitions settled than repeatCount) is re-planned, not closed', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const id = seedBatch(db, 'running', 3)
    seedJob(db, id, 'd1', { batchRepeat: 0, status: 'success' }) // only 1 of 3 done — the crash interrupted the pacer, not the run
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })

    replanAfterRestart({ db, pacer, jobStore: createJobStore(db), broadcast: () => {} })

    const row = db.select().from(batches).where(eq(batches.id, id)).get()
    expect(row?.status).toBe('queued') // one settled, one freshly queued — not yet running, not done
    const rows = db.select().from(jobs).where(eq(jobs.batchId, id)).all()
    expect(rows.length).toBe(2) // repetition 1 planned
    expect(rows.some((r) => r.batchRepeat === 1 && r.status === 'queued')).toBe(true)
  })
})

describe('rearm — one dynamic timer at the earliest future notBefore', () => {
  test('stop() clears the timer — nothing keeps the process alive (00-overview §7)', () => {
    const db = setUp()
    const { scheduler } = fakeScheduler()
    const pacer = createBatchPacer({ db, scheduler, log: createLogger('test') })
    pacer.rearm()
    // No assertion beyond "this does not throw and stop() is safe to call
    // repeatedly" — the real proof that nothing leaks is `bun test`'s own
    // process exit, which a lingering unref'd timer would not block anyway,
    // but an un-cleared one under a fake timer WOULD. `stop()` is idempotent:
    pacer.stop()
    pacer.stop()
  })
})
