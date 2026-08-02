import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { ScheduleFiredEvent } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobs, schedules, scheduleRuns, type ScheduleRow } from '../db/schema'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createLogger } from '../util/logger'
import { fireOnce, pickJitterMs, runStartupCatchUp, type ScheduleRunnerDeps } from './runner'

/**
 * Every test here supplies a fixed `clock` (and, where relevant, a fixed
 * `random`) — never `Date.now()` — so results are reproducible (plan 21
 * §21.5). Jitter tests pair a fake clock with a fake `sleep` that advances
 * the same clock instead of actually waiting.
 */

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

function seedBatch(db: Db, id: string, status: 'queued' | 'running' | 'success') {
  db.insert(batches)
    .values({ id, scriptId: 'internal:sleep', concurrency: 0, order: 'as-listed', status, createdAt: new Date() })
    .run()
}

function seedJob(db: Db, id: string, deviceId: string, batchId: string, status: 'queued' | 'running' | 'success' = 'queued') {
  db.insert(jobs)
    .values({ id, scriptId: 'internal:sleep', deviceId, params: {}, priority: 0, status, createdAt: new Date(), batchId, batchSeq: 0 })
    .run()
}

function seedSchedule(db: Db, overrides: Partial<ScheduleRow> & { id: string }): ScheduleRow {
  const row: ScheduleRow = {
    id: overrides.id,
    name: overrides.name ?? 'test schedule',
    enabled: overrides.enabled ?? true,
    cron: overrides.cron ?? '0 * * * *',
    timezone: overrides.timezone ?? 'UTC',
    scriptId: overrides.scriptId ?? 'internal:sleep',
    params: overrides.params ?? {},
    clusterId: overrides.clusterId ?? null,
    deviceIds: overrides.deviceIds ?? ['d1'],
    concurrency: overrides.concurrency ?? 0,
    order: overrides.order ?? 'as-listed',
    onOverlap: overrides.onOverlap ?? 'skip',
    queueTimeoutSec: overrides.queueTimeoutSec ?? null,
    catchUp: overrides.catchUp ?? 'skip',
    jitterSec: overrides.jitterSec ?? 0,
    priority: overrides.priority ?? 0,
    lastFiredAt: overrides.lastFiredAt ?? null,
    lastBatchId: overrides.lastBatchId ?? null,
    createdBy: overrides.createdBy ?? null,
    createdAt: overrides.createdAt ?? new Date(),
  }
  db.insert(schedules).values(row).run()
  return row
}

function fakeScheduler(): Scheduler {
  return { kick: () => {}, start: () => {}, stop: () => {} }
}

function baseDeps(db: Db, overrides: Partial<ScheduleRunnerDeps> = {}): ScheduleRunnerDeps {
  return {
    db,
    jobStore: createJobStore(db),
    scheduler: fakeScheduler(),
    audit: createAuditLogger(db),
    log: createLogger('test'),
    onJobStatus: () => {},
    broadcastBatchStatus: () => {},
    broadcastFired: () => {},
    ...overrides,
  }
}

describe('pickJitterMs — plan 21 §3.6', () => {
  test('jitterSec: 0 never delays', () => {
    expect(pickJitterMs(0)).toBe(0)
  })

  test('stays within [0, jitterSec * 1000] for any draw', () => {
    for (const r of [0, 0.1, 0.5, 0.9, 0.999999]) {
      const ms = pickJitterMs(30, () => r)
      expect(ms).toBeGreaterThanOrEqual(0)
      expect(ms).toBeLessThanOrEqual(30_000)
    }
  })
})

describe('fireOnce — onOverlap modes (plan 21 §3.2)', () => {
  test('skip: a due schedule whose previous batch is still running dispatches nothing, and records why', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedBatch(db, 'prev', 'running')
    seedJob(db, 'j-prev', 'd2', 'prev', 'running')
    const schedule = seedSchedule(db, { id: 's1', onOverlap: 'skip', lastBatchId: 'prev', deviceIds: ['d1'] })

    const dueAt = new Date('2024-01-01T00:00:00Z')
    await fireOnce(baseDeps(db), schedule, dueAt)

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs.length).toBe(1)
    expect(runs[0]?.outcome).toBe('skipped-overlap')
    expect(runs[0]?.batchId).toBeNull()

    const batchRows = db.select().from(batches).all()
    expect(batchRows.length).toBe(1) // only "prev" — nothing new was created

    const updated = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(updated?.lastFiredAt?.getTime()).toBe(dueAt.getTime())
    expect(updated?.lastBatchId).toBe('prev') // unchanged
  })

  test('queue: dispatches a new batch even while the previous one is still running', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedBatch(db, 'prev', 'running')
    seedJob(db, 'j-prev', 'd2', 'prev', 'running')
    const schedule = seedSchedule(db, { id: 's1', onOverlap: 'queue', lastBatchId: 'prev', deviceIds: ['d1'] })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs.length).toBe(1)
    expect(runs[0]?.outcome).toBe('dispatched')
    expect(runs[0]?.batchId).not.toBeNull()

    const batchRows = db.select().from(batches).all()
    expect(batchRows.length).toBe(2) // "prev" is untouched, plus the new one

    // The previous batch's running job is left alone.
    const prevJob = db.select().from(jobs).where(eq(jobs.id, 'j-prev')).get()
    expect(prevJob?.status).toBe('running')
  })

  test('cancel-previous: cancels the queued remainder of the previous batch, then starts a new one', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedBatch(db, 'prev', 'queued')
    seedJob(db, 'j-prev', 'd2', 'prev', 'queued')
    const schedule = seedSchedule(db, { id: 's1', onOverlap: 'cancel-previous', lastBatchId: 'prev', deviceIds: ['d1'] })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))

    const prevJob = db.select().from(jobs).where(eq(jobs.id, 'j-prev')).get()
    expect(prevJob?.status).toBe('cancelled')

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs[0]?.outcome).toBe('dispatched')
    expect(runs[0]?.detail).toContain('cancelled')

    const updated = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(updated?.lastBatchId).not.toBe('prev')
  })

  test('a cluster/device list resolving to nothing usable is recorded as no-targets, not a thrown error', async () => {
    const db = setUp()
    const schedule = seedSchedule(db, { id: 's1', deviceIds: ['does-not-exist'] })

    await expect(fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))).resolves.toBeUndefined()

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs[0]?.outcome).toBe('no-targets')
    expect(runs[0]?.batchId).toBeNull()
  })
})

describe('fireOnce — jitter shifts firedAt, never dueAt (plan 21 §3.6, acceptance #6)', () => {
  test('firedAt lands exactly jitterMs after dueAt; dueAt is untouched', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', jitterSec: 10, deviceIds: ['d1'] })
    const dueAt = new Date('2024-01-01T00:00:00Z')

    let clockMs = dueAt.getTime()
    const clock = () => new Date(clockMs)
    const sleep = async (ms: number) => {
      clockMs += ms
    }
    // random() = 0.5 → jitterMs = floor(0.5 * (10*1000 + 1)) = 5000ms.
    await fireOnce(baseDeps(db, { clock, random: () => 0.5, sleep }), schedule, dueAt)

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.dueAt.getTime()).toBe(dueAt.getTime())
    expect(run?.firedAt?.getTime()).toBe(dueAt.getTime() + 5000)
  })
})

describe('runStartupCatchUp — collapses missed fires into exactly one run (plan 21 §3.4, acceptance #5)', () => {
  test("catchUp: 'once' — 3 missed hourly fires become exactly one dispatched run with missedCount: 3", async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const lastFiredAt = new Date('2024-06-01T00:00:00.000Z')
    const now = new Date('2024-06-01T03:00:00.000Z') // 3 hourly fires missed in between
    seedSchedule(db, { id: 's1', cron: '0 * * * *', timezone: 'UTC', catchUp: 'once', lastFiredAt, deviceIds: ['d1'] })

    await runStartupCatchUp(baseDeps(db, { clock: () => now }))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs.length).toBe(1)
    expect(runs[0]?.outcome).toBe('dispatched')
    expect(runs[0]?.missedCount).toBe(3)

    const batchRows = db.select().from(batches).all()
    expect(batchRows.length).toBe(1)

    const updated = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(updated?.lastFiredAt?.getTime()).toBe(now.getTime())
  })

  test("catchUp: 'skip' — the same 3 misses are recorded but nothing runs", async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const lastFiredAt = new Date('2024-06-01T00:00:00.000Z')
    const now = new Date('2024-06-01T03:00:00.000Z')
    seedSchedule(db, { id: 's1', cron: '0 * * * *', timezone: 'UTC', catchUp: 'skip', lastFiredAt, deviceIds: ['d1'] })

    const fired: ScheduleFiredEvent[] = []
    await runStartupCatchUp(baseDeps(db, { clock: () => now, broadcastFired: (m) => fired.push(m) }))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs.length).toBe(1)
    expect(runs[0]?.outcome).toBe('skipped-missed')
    expect(runs[0]?.missedCount).toBe(3)
    expect(runs[0]?.batchId).toBeNull()

    expect(db.select().from(batches).all().length).toBe(0)
    expect(fired.length).toBe(1)
    expect(fired[0]?.payload.outcome).toBe('skipped-missed')

    const updated = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(updated?.lastFiredAt?.getTime()).toBe(now.getTime()) // the checkpoint still ratchets forward
  })

  test('a schedule that never fired before has nothing to catch up', async () => {
    const db = setUp()
    seedSchedule(db, { id: 's1', lastFiredAt: null })
    await runStartupCatchUp(baseDeps(db, { clock: () => new Date('2024-06-01T03:00:00.000Z') }))
    expect(db.select().from(scheduleRuns).all().length).toBe(0)
  })

  test('a schedule with zero missed occurrences writes no row', async () => {
    const db = setUp()
    const t = new Date('2024-06-01T00:00:00.000Z')
    seedSchedule(db, { id: 's1', cron: '0 * * * *', timezone: 'UTC', lastFiredAt: t })
    // "now" is a few seconds after lastFiredAt — well before the next hourly fire.
    await runStartupCatchUp(baseDeps(db, { clock: () => new Date(t.getTime() + 5_000) }))
    expect(db.select().from(scheduleRuns).all().length).toBe(0)
  })
})

describe('every fire decision leaves exactly one schedule_runs row (plan 21 §4.2)', () => {
  test('two separate fires produce two separate rows', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', deviceIds: ['d1'] })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))
    const reloaded = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    await fireOnce(baseDeps(db), reloaded, new Date('2024-01-01T01:00:00Z'))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs.length).toBe(2)
  })
})
