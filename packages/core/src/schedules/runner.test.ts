import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { NotificationContext, ScheduleFiredEvent } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobs, schedules, scheduleAgentTargets, scheduleRuns, scripts, type ScheduleAgentTargetRow, type ScheduleRow } from '../db/schema'
import { createJobStore, rowToJobInfo, type JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import type { JobService } from '../services/job-service'
import { createLogger } from '../util/logger'
import { fireOnce, pickJitterMs, runStartupCatchUp, type ScheduleAgentDispatch, type ScheduleRunnerDeps } from './runner'

/**
 * Every test here supplies a fixed `clock` (and, where relevant, a fixed
 * `random`) — never `Date.now()` — so results are reproducible (plan 21
 * §21.5). Jitter tests pair a fake clock with a fake `sleep` that advances
 * the same clock instead of actually waiting.
 */

function seedScript(db: Db, name = 'test-script', version = '1.0.0') {
  db.insert(scripts).values({ pluginId: 'p-fixture', exportId: 'main', id: `${name}-${version}`, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
}

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  // Every schedule below dispatches against `test-script@1.0.0` by default
  // (plan 62 §4.5) — `fireOnce` resolves the reference before building the
  // batch, so it must exist even for tests that only assert around overlap
  // or target resolution.
  seedScript(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'idle' | 'offline' | 'online' = 'idle') {
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
    scriptRef: overrides.scriptRef ?? 'test-script@1.0.0',
    params: overrides.params ?? {},
    groupId: overrides.groupId ?? null,
    deviceIds: overrides.deviceIds ?? ['d1'],
    concurrency: overrides.concurrency ?? 0,
    order: overrides.order ?? 'as-listed',
    onOverlap: overrides.onOverlap ?? 'skip',
    queueTimeoutSec: overrides.queueTimeoutSec ?? null,
    catchUp: overrides.catchUp ?? 'skip',
    jitterSec: overrides.jitterSec ?? 0,
    priority: overrides.priority ?? 0,
    repeatCount: overrides.repeatCount ?? 1,
    intervalMinMs: overrides.intervalMinMs ?? 0,
    intervalMaxMs: overrides.intervalMaxMs ?? 0,
    deviceIntervalMs: overrides.deviceIntervalMs ?? 0,
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

/**
 * Plan 94 §3.9, §4.9, step 94.8 — `onOverlap: 'cancel-previous'` now routes
 * through `stopBatch` (`api/batches.ts`), whose ONLY abort path is
 * `JobService.cancel()` (no second implementation, per that function's own
 * doc). A real `createJobService` needs a live `ExecutorHost`, which this
 * scheduler-focused test file has no interest in standing up — this fake
 * covers exactly what `stopBatch` calls: cancel a `queued` job the ordinary
 * way, or force a `running` one straight to `cancelled` (the outcome
 * `JobService.cancel`'s own `host.abort`/`finishExternally` fallback would
 * reach in production; this file is not the place that tests THAT logic —
 * `services/job-service.test.ts` is).
 */
function fakeJobService(db: Db, jobStore: JobStore): Pick<JobService, 'cancel'> {
  return {
    cancel(jobId) {
      const job = jobStore.get(jobId)
      if (!job) throw new Error(`no such job: ${jobId}`)
      if (job.status === 'queued') {
        const cancelled = jobStore.cancelQueued(jobId)
        if (!cancelled) throw new Error('job changed status first')
      } else if (job.status === 'running') {
        db.update(jobs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(jobs.id, jobId)).run()
      } else {
        throw new Error(`job is ${job.status}`)
      }
      const updated = jobStore.get(jobId)
      return { job: rowToJobInfo(updated!), cancelledDescendants: 0 }
    },
  }
}

function baseDeps(db: Db, overrides: Partial<ScheduleRunnerDeps> = {}): ScheduleRunnerDeps {
  const jobStore = createJobStore(db)
  return {
    db,
    jobStore,
    scheduler: fakeScheduler(),
    audit: createAuditLogger(db),
    log: createLogger('test'),
    onJobStatus: () => {},
    broadcastBatchStatus: () => {},
    broadcastFired: () => {},
    jobService: fakeJobService(db, jobStore),
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
    // Plan 94 §3.9, §4.9, step 94.8 — routed through `stopBatch` now, so the
    // detail states both buckets it reports, not just "cancelled".
    expect(runs[0]?.detail).toContain('stopped the previous run')
    expect(runs[0]?.detail).toContain('1 queued')

    const updated = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(updated?.lastBatchId).not.toBe('prev')

    // Plan 94 §3.9, step 94.8 acceptance #12 — no repetition is left planned:
    // the previous batch is marked `stopping`, not left `queued`/`running`.
    const prevBatch = db.select().from(batches).where(eq(batches.id, 'prev')).get()
    expect(prevBatch?.status).not.toBe('queued')
    expect(prevBatch?.status).not.toBe('running')
  })

  test('a group/device list resolving to nothing usable is recorded as no-targets, not a thrown error', async () => {
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

describe('fireOnce — the jitter draw is written down, not just implied (plan 94 §3.7, F28)', () => {
  test('a jittered fire records the exact drawn value on schedule_runs.jitterMs', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', jitterSec: 10, deviceIds: ['d1'] })
    const dueAt = new Date('2024-01-01T00:00:00Z')

    let clockMs = dueAt.getTime()
    const clock = () => new Date(clockMs)
    const sleep = async (ms: number) => {
      clockMs += ms
    }
    // random() = 0.5 → jitterMs = floor(0.5 * (10*1000 + 1)) = 5000ms — the SAME seeded draw
    // `pickJitterMs` produces, never re-derived: this test asserts the value that was actually
    // used ended up on the row, not merely that a plausible one could be recomputed from the range.
    await fireOnce(baseDeps(db, { clock, random: () => 0.5, sleep }), schedule, dueAt)

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.jitterMs).toBe(5000)
  })

  test('a run with no jitter configured records jitterMs: 0, distinguishable from an unexplained delay', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', jitterSec: 0, deviceIds: ['d1'] })
    const dueAt = new Date('2024-01-01T00:00:00Z')

    await fireOnce(baseDeps(db, { clock: () => dueAt }), schedule, dueAt)

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.jitterMs).toBe(0)
  })

  test('a fire skipped for overlap never reaches the draw — jitterMs: 0, not the range', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', jitterSec: 30, onOverlap: 'skip', lastBatchId: 'b1', deviceIds: ['d1'] })
    seedBatch(db, 'b1', 'running')
    const dueAt = new Date('2024-01-01T00:00:00Z')

    await fireOnce(baseDeps(db, { clock: () => dueAt }), schedule, dueAt)

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.outcome).toBe('skipped-overlap')
    expect(run?.jitterMs).toBe(0)
  })
})

describe('fireOnce — pacing travels from the schedule into the batch, through the same seam as concurrency/order/priority (plan 94 §3.7, §4.8, step 94.9, F34)', () => {
  test('a schedule with repeatCount/interval/deviceInterval set produces a batch carrying that exact pacing', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, {
      id: 's1',
      deviceIds: ['d1'],
      repeatCount: 5,
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      deviceIntervalMs: 500,
    })
    const dueAt = new Date('2024-01-01T00:00:00Z')

    await fireOnce(baseDeps(db, { clock: () => dueAt }), schedule, dueAt)

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.outcome).toBe('dispatched')
    const batch = db.select().from(batches).where(eq(batches.id, run!.batchId!)).get()
    expect(batch?.repeatCount).toBe(5)
    expect(batch?.intervalMinMs).toBe(1000)
    expect(batch?.intervalMaxMs).toBe(2000)
    expect(batch?.deviceIntervalMs).toBe(500)
  })

  test("a schedule with default pacing (repeatCount: 1, every interval 0) produces an unpaced batch — today's behaviour exactly", async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', deviceIds: ['d1'] })
    const dueAt = new Date('2024-01-01T00:00:00Z')

    await fireOnce(baseDeps(db, { clock: () => dueAt }), schedule, dueAt)

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    const batch = db.select().from(batches).where(eq(batches.id, run!.batchId!)).get()
    expect(batch?.repeatCount).toBe(1)
    expect(batch?.intervalMinMs).toBe(0)
    expect(batch?.intervalMaxMs).toBe(0)
    expect(batch?.deviceIntervalMs).toBe(0)
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

describe('fireOnce — @latest resolution (plan 62 §3.4, §4.5)', () => {
  test('a schedule on @latest dispatches the newest version on its next firing after a publish, with no edit (acceptance #7)', async () => {
    const db = setUp() // seeds test-script@1.0.0
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'test-script@latest', deviceIds: ['d1'], onOverlap: 'queue' })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))
    let batchId = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()?.batchId
    expect(db.select().from(jobs).where(eq(jobs.batchId, batchId!)).all()[0]?.scriptId).toBe('test-script-1.0.0')

    // Publish a newer version — the schedule itself is untouched.
    seedScript(db, 'test-script', '2.0.0')
    const reloaded = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    await fireOnce(baseDeps(db), reloaded, new Date('2024-01-01T01:00:00Z'))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    batchId = runs[runs.length - 1]?.batchId
    expect(db.select().from(jobs).where(eq(jobs.batchId, batchId!)).all()[0]?.scriptId).toBe('test-script-2.0.0')
  })

  test('one firing resolves ONCE — every job in the batch shares the same scriptId even with several devices (acceptance #8)', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedDevice(db, 'd3')
    seedScript(db, 'test-script', '2.0.0')
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'test-script@latest', deviceIds: ['d1', 'd2', 'd3'] })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    const batchJobs = db.select().from(jobs).where(eq(jobs.batchId, run!.batchId!)).all()
    expect(batchJobs).toHaveLength(3)
    expect(new Set(batchJobs.map((j) => j.scriptId)).size).toBe(1)
    expect(batchJobs[0]?.scriptId).toBe('test-script-2.0.0')
  })

  test('an exact pinned reference always dispatches that version, never @latest', async () => {
    const db = setUp() // test-script@1.0.0
    seedDevice(db, 'd1')
    seedScript(db, 'test-script', '2.0.0')
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'test-script@1.0.0', deviceIds: ['d1'] })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    const batchJobs = db.select().from(jobs).where(eq(jobs.batchId, run!.batchId!)).all()
    expect(batchJobs[0]?.scriptId).toBe('test-script-1.0.0')
  })

  test('a reference that cannot resolve enqueues nothing and records a schedule.failed audit entry naming the code (acceptance #12)', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'no-such-script@latest', deviceIds: ['d1'] })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.outcome).toBe('error')
    expect(runs[0]?.batchId).toBeNull()
    expect(runs[0]?.detail).toContain('script_not_found')

    // Nothing was enqueued.
    expect(db.select().from(batches).all()).toHaveLength(0)
    expect(db.select().from(jobs).all()).toHaveLength(0)

    // And the failure is audited, naming the code.
    const audit = createAuditLogger(db)
    const entries = audit.list(10)
    const failure = entries.find((e) => e.action === 'schedule.failed')
    expect(failure).toBeDefined()
    expect(failure?.target).toBe('s1')
    expect((failure?.meta as { code?: string } | null)?.code).toBe('script_not_found')
  })

  test('plan 82 §3.3, §3.5 — with a registry wired, a schedule targeting a DEV-ONLY plugin script is refused with script_is_dev (criterion 18), never silently runs it', async () => {
    const { createScriptRegistry } = await import('../scripts/registry')
    const { createDevSlotStore } = await import('../plugins/dev-slots')
    const db = setUp()
    seedDevice(db, 'd1')
    const devSlots = createDevSlotStore()
    devSlots.put({
      pluginName: 'tiktok',
      declaredVersion: '1.0.0',
      bundlePath: '/tmp/tiktok.mjs',
      scripts: [{ exportId: 'login', paramsSchema: {}, runtime: null }],
      owner: { kind: 'workspace', label: '/scripts/tiktok' },
    })
    const registry = createScriptRegistry({ db, dataDir: '/tmp/enkaku-schedule-runner-test', devSlots })
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'tiktok/login@latest', deviceIds: ['d1'] })

    await fireOnce(baseDeps(db, { registry }), schedule, new Date('2024-01-01T00:00:00Z'))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs[0]?.outcome).toBe('error')
    expect(runs[0]?.detail).toContain('script_is_dev')
    expect(db.select().from(batches).all()).toHaveLength(0) // never ran the unreviewed dev build
  })

  test('plan 82 §3.3 — with a registry wired, a schedule targeting a PUBLISHED plugin script resolves and dispatches through the one registry path (one of the 8 call sites, criterion 14)', async () => {
    const { createScriptRegistry } = await import('../scripts/registry')
    const { createDevSlotStore } = await import('../plugins/dev-slots')
    const db = setUp()
    seedDevice(db, 'd1')
    db.insert(scripts)
      .values({ id: 'plugin-script-1', name: 'tiktok/login', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date(), pluginId: 'p1', exportId: 'login' })
      .run()
    const registry = createScriptRegistry({ db, dataDir: '/tmp/enkaku-schedule-runner-test', devSlots: createDevSlotStore() })
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'tiktok/login@1.0.0', deviceIds: ['d1'] })

    await fireOnce(baseDeps(db, { registry }), schedule, new Date('2024-01-01T00:00:00Z'))

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.outcome).toBe('dispatched')
    const batchJobs = db.select().from(jobs).where(eq(jobs.batchId, run!.batchId!)).all()
    expect(batchJobs[0]?.scriptId).toBe('plugin-script-1')
  })

  test('a schedule disabled at its exact pinned version fails with script_disabled, audited', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    db.update(scripts).set({ enabled: false }).where(eq(scripts.id, 'test-script-1.0.0')).run()
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'test-script@1.0.0', deviceIds: ['d1'] })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs[0]?.outcome).toBe('error')
    expect(runs[0]?.detail).toContain('script_disabled')
  })
})

/**
 * The `maxConcurrent` half of the same gap the version-gate test in
 * `jobs/scheduled-batch-version-gate.test.ts` pins for `checkRuntimeMajor`:
 * both gates are only reachable once `fireOnce`'s own `batchDeps` forwards
 * `scriptNameOf` (via `deps.registry`) into `createBatch`. Fixing only the
 * version gate and leaving this half unproven is exactly how
 * `docs/plans/96-m61-hotfixes.md` §96.14's "closed" claim looked complete
 * while a schedule-fired batch still denormalised `scriptName: null` /
 * `maxConcurrent: 0` (unlimited) on every member row — the same failure
 * shape `groups/dispatch-batch-max-concurrent.integration.test.ts` proves
 * for the direct `createBatch` call sites, reproduced here through the
 * REAL `fireOnce` and a REAL `ScriptRegistry`, matching production wiring
 * (`daemon.ts` supplies `registry: scriptRegistry` to `createScheduleRunner`).
 */
describe('fireOnce — a scheduled batch member carries the SAME runtime.maxConcurrent cap and scriptName a standalone enqueue() applies', () => {
  test('a maxConcurrent:1 script fired by a schedule across three idle devices pins maxConcurrent:1 and a non-null scriptName on every member row, and the claim gate honours it', async () => {
    const db = setUp()
    // `online`, not the file's usual `idle` default: this test's own final
    // assertion goes through `claimNext`, whose admission SQL requires
    // `status = 'online'` literally (plan 205 §4.7) — a pre-existing gap this
    // plan's own test run surfaced (plan 200 §2.1).
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d, 'online')
    db.insert(scripts)
      .values({
        pluginId: 'p-fixture',
        exportId: 'main',
        id: 'capped-1.0.0',
        name: 'capped',
        version: '1.0.0',
        bundle: 'export {}',
        enabled: true,
        createdAt: new Date(),
        runtime: { maxConcurrent: 1 },
      })
      .run()
    const { createScriptRegistry } = await import('../scripts/registry')
    const { createDevSlotStore } = await import('../plugins/dev-slots')
    const registry = createScriptRegistry({ db, dataDir: '/tmp/enkaku-schedule-runner-maxconcurrent-test', devSlots: createDevSlotStore() })
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'capped@1.0.0', deviceIds: ['d1', 'd2', 'd3'] })

    const jobStore = createJobStore(db)
    await fireOnce(baseDeps(db, { registry, jobStore }), schedule, new Date('2024-01-01T00:00:00Z'))

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.outcome).toBe('dispatched')
    const batchJobs = db.select().from(jobs).where(eq(jobs.batchId, run!.batchId!)).all()
    expect(batchJobs.length).toBe(3)
    for (const row of batchJobs) {
      expect(row.maxConcurrent).toBe(1)
      expect(row.scriptName).toBe('capped')
      expect(row.scriptVersion).toBe('1.0.0')
    }

    // The claim gate (`queue/job-store.ts`'s `claimNext`) correlates running
    // siblings via `r.script_name = j.script_name` — it can only see this
    // batch's cap at all because `scriptName` is non-null. Sequential calls
    // prove the cap actually holds, not just that the columns are populated.
    expect(jobStore.claimNext(60)).not.toBeNull()
    expect(jobStore.claimNext(60)).toBeNull()
  })
})

/**
 * Plan 95 §4.4, §5 step 95.7 — reconciliation at firing. Written so it would
 * FAIL if `paramsCompatible` (tested separately in `api/schedules.test.ts`)
 * only ever reflected the LAST firing's outcome rather than a fresh
 * recomputation: here the schedule is published against `s@1.0.0`, then the
 * schema changes underneath it, and the very NEXT firing (never fired before
 * against the new schema) must already refuse — there is no "warm up" firing.
 */
describe('fireOnce — reconciliation against the resolved schema (plan 95 §4.4, §5 step 95.7)', () => {
  test('publish s@1.0.0 with { videos }, create an s@latest schedule, publish s@1.1.0 adding a required region with no default: the next firing enqueues nothing and records params_incompatible naming region', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    db.update(scripts)
      .set({ paramsSchema: { type: 'object', properties: { videos: { type: 'number' } } } })
      .where(eq(scripts.id, 'test-script-1.0.0'))
      .run()
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'test-script@latest', deviceIds: ['d1'], params: { videos: 30 } })

    // 1.1.0 adds a REQUIRED `region` with no default — the exact scenario the plan names.
    db.insert(scripts)
      .values({
        pluginId: 'p-fixture',
        exportId: 'main',
        id: 'test-script-1.1.0',
        name: 'test-script',
        version: '1.1.0',
        bundle: 'export {}',
        enabled: true,
        createdAt: new Date(),
        paramsSchema: { type: 'object', properties: { videos: { type: 'number' }, region: { type: 'string' } }, required: ['videos', 'region'] },
      })
      .run()

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.outcome).toBe('error')
    expect(runs[0]?.batchId).toBeNull()
    expect(runs[0]?.detail).toContain('params_incompatible')
    expect(runs[0]?.detail).toContain('region')

    // Nothing was enqueued.
    expect(db.select().from(batches).all()).toHaveLength(0)
    expect(db.select().from(jobs).all()).toHaveLength(0)

    const audit = createAuditLogger(db)
    const failure = audit.list(10).find((e) => e.action === 'schedule.failed')
    expect(failure).toBeDefined()
    expect(failure?.target).toBe('s1')
    expect((failure?.meta as { code?: string } | null)?.code).toBe('params_incompatible')
    expect((failure?.meta as { message?: string } | null)?.message).toContain('region')
  })

  test('a non-blocking finding (a tightened bound with a default) still dispatches, using the RECONCILED value, not the stale stored one', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    db.update(scripts)
      .set({ paramsSchema: { type: 'object', properties: { chance: { type: 'number', minimum: 0, maximum: 1, default: 0.5 } } } })
      .where(eq(scripts.id, 'test-script-1.0.0'))
      .run()
    // Stored under an older, wider bound — no longer valid, but the schema supplies a default.
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'test-script@1.0.0', deviceIds: ['d1'], params: { chance: 5 } })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.outcome).toBe('dispatched')
    const batchJobs = db.select().from(jobs).where(eq(jobs.batchId, run!.batchId!)).all()
    expect(batchJobs[0]?.params).toEqual({ chance: 0.5 })
  })

  test('a schedule with no params schema at all (a script that takes none) is never incompatible', async () => {
    const db = setUp() // test-script@1.0.0 has no paramsSchema set
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', scriptRef: 'test-script@1.0.0', deviceIds: ['d1'] })

    await fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.outcome).toBe('dispatched')
  })
})

/**
 * Plan 68 §3.1, §4.2 — the AGENT branch of `fireOnce`. Presence of a
 * `scheduleAgentTargets` row is the discriminator (`db/schema.ts`'s own doc
 * comment): every test above never inserts one, which is exactly what keeps
 * them — and their behaviour — untouched (acceptance #2). These tests share
 * the SAME `fireOnce`, the same overlap/jitter mechanics, proving §3.1's
 * "both branches share the overlap check, the concurrency ceiling, the
 * spend cap, and the jitter."
 */
function seedAgentTarget(db: Db, overrides: Partial<ScheduleAgentTargetRow> & { scheduleId: string }): ScheduleAgentTargetRow {
  const row: ScheduleAgentTargetRow = {
    scheduleId: overrides.scheduleId,
    agentId: overrides.agentId ?? 'agent-1',
    prompt: overrides.prompt ?? 'check the checkout flow',
    threadMode: overrides.threadMode ?? 'new',
    threadId: overrides.threadId ?? null,
    onApprovalRequired: overrides.onApprovalRequired ?? 'deny',
    lastAgentRunId: overrides.lastAgentRunId ?? null,
    createdAt: overrides.createdAt ?? new Date(),
  }
  db.insert(scheduleAgentTargets).values(row).run()
  return row
}

interface FakeAgentDispatchOpts {
  agentExists?: boolean
  runStatuses?: Record<string, 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'>
  countActiveScheduledRuns?: number
  spentOutputTokensSince?: number
  dispatchResult?: { runId: string; threadId: string }
  dispatchThrows?: Error
}

function fakeAgentDispatch(opts: FakeAgentDispatchOpts = {}) {
  const calls: { dispatch: Array<Parameters<ScheduleAgentDispatch['dispatch']>[0]>; cancelRun: string[] } = { dispatch: [], cancelRun: [] }
  const dispatch: ScheduleAgentDispatch = {
    agentExists: () => opts.agentExists ?? true,
    runStatus: (runId) => opts.runStatuses?.[runId] ?? null,
    cancelRun: (runId) => calls.cancelRun.push(runId),
    countActiveScheduledRuns: () => opts.countActiveScheduledRuns ?? 0,
    spentOutputTokensSince: () => opts.spentOutputTokensSince ?? 0,
    dispatch: (input) => {
      calls.dispatch.push(input)
      if (opts.dispatchThrows) throw opts.dispatchThrows
      return opts.dispatchResult ?? { runId: 'run-1', threadId: 'thread-1' }
    },
  }
  return { dispatch, calls }
}

describe('fireOnce — the agent branch (plan 68 §3.1, §4.2)', () => {
  test('dispatches an agent run, records lastAgentRunId, and threadId on a fresh "continue" thread', async () => {
    const db = setUp()
    const schedule = seedSchedule(db, { id: 's1' })
    seedDevice(db, 'd1')
    seedAgentTarget(db, { scheduleId: 's1', agentId: 'agent-1', prompt: 'nightly check', threadMode: 'continue' })
    const { dispatch, calls } = fakeAgentDispatch({ dispatchResult: { runId: 'run-42', threadId: 'thread-42' } })

    await fireOnce(baseDeps(db, { agentDispatch: dispatch }), schedule, new Date('2024-01-01T00:00:00Z'))

    expect(calls.dispatch).toHaveLength(1)
    expect(calls.dispatch[0]).toMatchObject({ scheduleId: 's1', agentId: 'agent-1', prompt: 'nightly check', threadMode: 'continue', onApprovalRequired: 'deny' })

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.outcome).toBe('dispatched')
    expect(runs[0]?.batchId).toBeNull() // an agent firing produces a RUN, never a batch

    const target = db.select().from(scheduleAgentTargets).where(eq(scheduleAgentTargets.scheduleId, 's1')).get()
    expect(target?.lastAgentRunId).toBe('run-42')
    expect(target?.threadId).toBe('thread-42') // persisted on the FIRST continue firing
  })

  test('a "continue" thread already established is reused, never overwritten', async () => {
    const db = setUp()
    const schedule = seedSchedule(db, { id: 's1' })
    seedDevice(db, 'd1')
    seedAgentTarget(db, { scheduleId: 's1', threadMode: 'continue', threadId: 'existing-thread' })
    const { dispatch, calls } = fakeAgentDispatch({ dispatchResult: { runId: 'run-2', threadId: 'existing-thread' } })

    await fireOnce(baseDeps(db, { agentDispatch: dispatch }), schedule, new Date('2024-01-01T00:00:00Z'))

    expect(calls.dispatch[0]?.existingThreadId).toBe('existing-thread')
    const target = db.select().from(scheduleAgentTargets).where(eq(scheduleAgentTargets.scheduleId, 's1')).get()
    expect(target?.threadId).toBe('existing-thread')
  })

  test('a schedule with a group/device target narrows the run to those resolved devices (criterion 3)', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const schedule = seedSchedule(db, { id: 's1', deviceIds: ['d1', 'd2'] })
    seedAgentTarget(db, { scheduleId: 's1' })
    const { dispatch, calls } = fakeAgentDispatch()

    await fireOnce(baseDeps(db, { agentDispatch: dispatch }), schedule, new Date('2024-01-01T00:00:00Z'))

    expect(calls.dispatch[0]?.deviceIds?.sort()).toEqual(['d1', 'd2'])
  })

  test('a device target resolving to nothing usable is no-targets, not thrown (mirrors the script branch)', async () => {
    const db = setUp()
    const schedule = seedSchedule(db, { id: 's1', deviceIds: ['does-not-exist'] })
    seedAgentTarget(db, { scheduleId: 's1' })
    const { dispatch, calls } = fakeAgentDispatch()

    await fireOnce(baseDeps(db, { agentDispatch: dispatch }), schedule, new Date('2024-01-01T00:00:00Z'))

    expect(calls.dispatch).toHaveLength(0) // never reached — devices did not resolve first
    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs[0]?.outcome).toBe('no-targets')
  })

  test('no dispatcher wired (defensive): the fire is dropped, not thrown, and nothing is recorded', async () => {
    const db = setUp()
    const schedule = seedSchedule(db, { id: 's1' })
    seedDevice(db, 'd1')
    seedAgentTarget(db, { scheduleId: 's1' })
    await expect(fireOnce(baseDeps(db), schedule, new Date('2024-01-01T00:00:00Z'))).resolves.toBeUndefined()
    expect(db.select().from(scheduleRuns).all()).toHaveLength(0)
  })

  test('an agent that no longer exists (or is disabled) fails the firing with agent_not_found', async () => {
    const db = setUp()
    const schedule = seedSchedule(db, { id: 's1' })
    seedDevice(db, 'd1')
    seedAgentTarget(db, { scheduleId: 's1' })
    const { dispatch } = fakeAgentDispatch({ agentExists: false })

    await fireOnce(baseDeps(db, { agentDispatch: dispatch }), schedule, new Date('2024-01-01T00:00:00Z'))

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
    expect(runs[0]?.outcome).toBe('error')
    expect(runs[0]?.detail).toContain('agent_not_found')
  })

  describe('onOverlap applies identically to an agent target (criterion 5)', () => {
    test('skip: a still-active previous run is skipped and recorded, not silently', async () => {
      const db = setUp()
      const schedule = seedSchedule(db, { id: 's1', onOverlap: 'skip' })
      seedDevice(db, 'd1')
      seedAgentTarget(db, { scheduleId: 's1', lastAgentRunId: 'prev-run' })
      const { dispatch, calls } = fakeAgentDispatch({ runStatuses: { 'prev-run': 'running' } })

      await fireOnce(baseDeps(db, { agentDispatch: dispatch }), schedule, new Date('2024-01-01T00:00:00Z'))

      expect(calls.dispatch).toHaveLength(0)
      const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
      expect(runs[0]?.outcome).toBe('skipped-overlap')
      expect(runs[0]?.detail).toContain('prev-run')
    })

    test('queue: dispatches a new run even while the previous one is still going', async () => {
      const db = setUp()
      const schedule = seedSchedule(db, { id: 's1', onOverlap: 'queue' })
      seedDevice(db, 'd1')
      seedAgentTarget(db, { scheduleId: 's1', lastAgentRunId: 'prev-run' })
      const { dispatch, calls } = fakeAgentDispatch({ runStatuses: { 'prev-run': 'running' } })

      await fireOnce(baseDeps(db, { agentDispatch: dispatch }), schedule, new Date('2024-01-01T00:00:00Z'))

      expect(calls.dispatch).toHaveLength(1)
      const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
      expect(runs[0]?.outcome).toBe('dispatched')
    })

    test('cancel-previous: cancels the still-running run, then dispatches a new one', async () => {
      const db = setUp()
      const schedule = seedSchedule(db, { id: 's1', onOverlap: 'cancel-previous' })
      seedDevice(db, 'd1')
      seedAgentTarget(db, { scheduleId: 's1', lastAgentRunId: 'prev-run' })
      const { dispatch, calls } = fakeAgentDispatch({ runStatuses: { 'prev-run': 'paused' } })

      await fireOnce(baseDeps(db, { agentDispatch: dispatch }), schedule, new Date('2024-01-01T00:00:00Z'))

      expect(calls.cancelRun).toEqual(['prev-run'])
      expect(calls.dispatch).toHaveLength(1)
    })

    test('a terminal previous run (succeeded) is never treated as active', async () => {
      const db = setUp()
      const schedule = seedSchedule(db, { id: 's1', onOverlap: 'skip' })
      seedDevice(db, 'd1')
      seedAgentTarget(db, { scheduleId: 's1', lastAgentRunId: 'prev-run' })
      const { dispatch, calls } = fakeAgentDispatch({ runStatuses: { 'prev-run': 'succeeded' } })

      await fireOnce(baseDeps(db, { agentDispatch: dispatch }), schedule, new Date('2024-01-01T00:00:00Z'))

      expect(calls.dispatch).toHaveLength(1)
    })
  })

  describe('the scheduled-concurrency ceiling (plan 68 §3.3, criterion 6)', () => {
    test('reached: follows onOverlap (skip) exactly like an active previous run', async () => {
      const db = setUp()
      const schedule = seedSchedule(db, { id: 's1', onOverlap: 'skip' })
      seedDevice(db, 'd1')
      seedAgentTarget(db, { scheduleId: 's1' })
      const { dispatch, calls } = fakeAgentDispatch({ countActiveScheduledRuns: 3 })

      await fireOnce(
        baseDeps(db, { agentDispatch: dispatch, scheduledAgentCeilings: () => ({ spendCapOutputTokensPer24h: null, maxConcurrentScheduledRuns: 3 }) }),
        schedule,
        new Date('2024-01-01T00:00:00Z'),
      )

      expect(calls.dispatch).toHaveLength(0)
      const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
      expect(runs[0]?.outcome).toBe('skipped-overlap')
      expect(runs[0]?.detail).toContain('ceiling')
    })

    test('under the ceiling: dispatches normally', async () => {
      const db = setUp()
      const schedule = seedSchedule(db, { id: 's1' })
      seedDevice(db, 'd1')
      seedAgentTarget(db, { scheduleId: 's1' })
      const { dispatch, calls } = fakeAgentDispatch({ countActiveScheduledRuns: 2 })

      await fireOnce(
        baseDeps(db, { agentDispatch: dispatch, scheduledAgentCeilings: () => ({ spendCapOutputTokensPer24h: null, maxConcurrentScheduledRuns: 3 }) }),
        schedule,
        new Date('2024-01-01T00:00:00Z'),
      )

      expect(calls.dispatch).toHaveLength(1)
    })
  })

  describe('the farm-wide spend cap refuses only the scheduled firing (plan 68 §3.3, criterion 7)', () => {
    test('reached: refused with the spend-cap outcome, a system notification, and an audited E_SPEND_CAP', async () => {
      const db = setUp()
      const schedule = seedSchedule(db, { id: 's1', createdBy: 'u1' })
      seedDevice(db, 'd1')
      seedAgentTarget(db, { scheduleId: 's1' })
      const { dispatch, calls } = fakeAgentDispatch({ spentOutputTokensSince: 1500 })
      const notified: Array<{ level: string; title: string; context?: NotificationContext }> = []

      await fireOnce(
        baseDeps(db, {
          agentDispatch: dispatch,
          scheduledAgentCeilings: () => ({ spendCapOutputTokensPer24h: 1000, maxConcurrentScheduledRuns: 3 }),
          notifySystem: (input) => notified.push(input),
        }),
        schedule,
        new Date('2024-01-01T00:00:00Z'),
      )

      expect(calls.dispatch).toHaveLength(0) // the run is genuinely never started
      const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).all()
      expect(runs[0]?.outcome).toBe('spend-cap')
      expect(notified).toHaveLength(1)
      expect(notified[0]?.context).toMatchObject({ scheduleId: 's1' })

      const audit = createAuditLogger(db)
      const failure = audit.list(10).find((e) => e.action === 'schedule.failed')
      expect((failure?.meta as { code?: string } | null)?.code).toBe('E_SPEND_CAP')
    })

    test('unset (null) cap never refuses, however much has been spent', async () => {
      const db = setUp()
      const schedule = seedSchedule(db, { id: 's1' })
      seedDevice(db, 'd1')
      seedAgentTarget(db, { scheduleId: 's1' })
      const { dispatch, calls } = fakeAgentDispatch({ spentOutputTokensSince: 999_999_999 })

      await fireOnce(
        baseDeps(db, { agentDispatch: dispatch, scheduledAgentCeilings: () => ({ spendCapOutputTokensPer24h: null, maxConcurrentScheduledRuns: 3 }) }),
        schedule,
        new Date('2024-01-01T00:00:00Z'),
      )

      expect(calls.dispatch).toHaveLength(1)
    })

    test('under the cap: dispatches normally', async () => {
      const db = setUp()
      const schedule = seedSchedule(db, { id: 's1' })
      seedDevice(db, 'd1')
      seedAgentTarget(db, { scheduleId: 's1' })
      const { dispatch, calls } = fakeAgentDispatch({ spentOutputTokensSince: 100 })

      await fireOnce(
        baseDeps(db, { agentDispatch: dispatch, scheduledAgentCeilings: () => ({ spendCapOutputTokensPer24h: 1000, maxConcurrentScheduledRuns: 3 }) }),
        schedule,
        new Date('2024-01-01T00:00:00Z'),
      )

      expect(calls.dispatch).toHaveLength(1)
    })
  })

  test('jitter shifts firedAt for an agent firing exactly as it does for a script firing (§3.1: shared, not duplicated)', async () => {
    const db = setUp()
    const schedule = seedSchedule(db, { id: 's1', jitterSec: 10 })
    seedDevice(db, 'd1')
    seedAgentTarget(db, { scheduleId: 's1' })
    const dueAt = new Date('2024-01-01T00:00:00Z')
    let clockMs = dueAt.getTime()
    const clock = () => new Date(clockMs)
    const sleep = async (ms: number) => {
      clockMs += ms
    }
    const { dispatch } = fakeAgentDispatch()

    await fireOnce(baseDeps(db, { agentDispatch: dispatch, clock, random: () => 0.5, sleep }), schedule, dueAt)

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, 's1')).get()
    expect(run?.dueAt.getTime()).toBe(dueAt.getTime())
    expect(run?.firedAt?.getTime()).toBe(dueAt.getTime() + 5000)
  })
})
