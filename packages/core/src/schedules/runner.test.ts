import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobRuns, jobs, schedules, scripts, type ScheduleRow } from '../db/schema'
import { createRunStore } from '../jobs/runs/store'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createLogger } from '../util/logger'
import { fireOnce, type ScheduleRunnerDeps } from './runner'

/**
 * `schedules/runner.test.ts` (plan 211 §7.1, G10) — re-keyed from the
 * deleted `schedule_runs` ledger and `jobs.status`/`batches.last_batch_id`
 * to the job/run split (plan 211 §3.2 decision 4): a schedule owns ONE
 * batch across its whole life, one member job per target device, and each
 * fire adds a RUN to every member rather than creating new jobs or a new
 * batch. `schedules.batch_id` (not `last_batch_id`) is the schedule's own
 * batch; `schedules.last_fire_outcome`/`last_fire_detail` replace the
 * deleted per-fire ledger.
 *
 * This file is a deliberately SCOPED replacement for the pre-211 suite
 * (plan 200 §8.3 — a test whose fixtures assert a structurally impossible
 * shape is rewritten to what the plan's own goal checklist names, not
 * ported wholesale): it proves G10's two named tests plus the handful of
 * adjacent behaviors (first fire creates the batch/member jobs; a later
 * fire reuses them; a device joining after the first fire gets its own new
 * job) that the same `fireOnce` call path also governs. Every OTHER
 * pre-211 describe block in the deleted version (jitter, catch-up, agent
 * targets, cancel-previous, spend caps) is a real, separate testing gap
 * this pass leaves open — noted in §11, not silently dropped.
 */

function seedScript(db: Db, name = 'test-script', version = '1.0.0') {
  db.insert(scripts).values({ pluginId: 'p-fixture', exportId: 'main', id: `${name}-${version}`, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
}

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  seedScript(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' | 'quarantined' = 'online') {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status }).run()
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
    deviceIds: overrides.deviceIds ?? ['d1', 'd2'],
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
    batchId: overrides.batchId ?? null,
    lastFireOutcome: overrides.lastFireOutcome ?? null,
    lastFireDetail: overrides.lastFireDetail ?? null,
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
  const jobStore = createJobStore(db)
  const runs = createRunStore(db)
  return {
    db,
    jobStore,
    runs,
    scheduler: fakeScheduler(),
    audit: createAuditLogger(db),
    log: createLogger('test'),
    onJobStatus: () => {},
    broadcastBatchStatus: () => {},
    broadcastFired: () => {},
    clock: () => new Date(),
    random: () => 0,
    sleep: async () => {},
    ...overrides,
  }
}

/** Every member job's LATEST run, keyed by device id — the read this whole file asserts against. */
function runsByDevice(db: Db, batchId: string): Map<string, { trigger: string; status: string }[]> {
  const runs = createRunStore(db)
  const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()
  const out = new Map<string, { trigger: string; status: string }[]>()
  for (const job of memberJobs) {
    const rows = runs.runs(job.id).map((r) => ({ trigger: r.trigger, status: r.status }))
    out.set(job.deviceId, rows)
  }
  return out
}

describe('fireOnce — a schedule owns one job per device, one batch across its life (plan 211 §3.2 decision 4, G10)', () => {
  test('the first fire creates the batch and one member job per target device', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const schedule = seedSchedule(db, { id: 's1' })
    const deps = baseDeps(db)

    await fireOnce(deps, schedule, new Date())

    const row = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(row?.batchId).toBeTruthy()
    expect(row?.lastFireOutcome).toBe('dispatched')
    const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, row!.batchId!)).all()
    expect(memberJobs).toHaveLength(2)
    expect(new Set(memberJobs.map((j) => j.deviceId))).toEqual(new Set(['d1', 'd2']))
    for (const j of memberJobs) expect(deps.runs.getJob(j.id)?.runCount).toBe(1)
  })

  test('each fire adds one run with trigger schedule to every member job', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const schedule = seedSchedule(db, { id: 's1' })
    const deps = baseDeps(db)

    await fireOnce(deps, schedule, new Date())
    const afterFirst = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    const batchId = afterFirst.batchId!

    // Settle every member's run so the second fire is not blocked by overlap.
    for (const j of db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()) {
      const run = deps.runs.latestRun(j.id)
      if (run) db.update(jobRuns).set({ status: 'success', finishedAt: new Date() }).where(eq(jobRuns.id, run.id)).run()
    }

    await fireOnce(deps, { ...schedule, batchId, lastFiredAt: afterFirst.lastFiredAt }, new Date())
    // Settle between the two later fires so the third is not skipped for overlap.
    for (const j of db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()) {
      const run = deps.runs.latestRun(j.id)
      if (run) db.update(jobRuns).set({ status: 'success', finishedAt: new Date() }).where(eq(jobRuns.id, run.id)).run()
    }
    await fireOnce(deps, { ...schedule, batchId, lastFiredAt: afterFirst.lastFiredAt }, new Date())

    // 2 jobs, still — 2 devices, 3 fires (G10's own parameter: "2 devices,
    // 3 fires: 2 jobs, 6 runs, every run trigger = 'schedule'").
    const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()
    expect(memberJobs).toHaveLength(2)
    const byDevice = runsByDevice(db, batchId)
    for (const [, runsForDevice] of byDevice) {
      expect(runsForDevice).toHaveLength(3)
      for (const r of runsForDevice) expect(r.trigger).toBe('schedule')
    }
  })

  test('a device joining the target after the first fire gets its own new job, not a run on someone else\'s', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const schedule = seedSchedule(db, { id: 's1', deviceIds: ['d1'] })
    const deps = baseDeps(db)

    await fireOnce(deps, schedule, new Date())
    const afterFirst = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    const batchId = afterFirst.batchId!
    for (const j of db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()) {
      const run = deps.runs.latestRun(j.id)
      if (run) db.update(jobRuns).set({ status: 'success', finishedAt: new Date() }).where(eq(jobRuns.id, run.id)).run()
    }
    expect(db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()).toHaveLength(1)

    await fireOnce(deps, { ...schedule, batchId, deviceIds: ['d1', 'd2'], lastFiredAt: afterFirst.lastFiredAt }, new Date())

    const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()
    expect(memberJobs).toHaveLength(2)
    const d1Job = memberJobs.find((j) => j.deviceId === 'd1')!
    const d2Job = memberJobs.find((j) => j.deviceId === 'd2')!
    expect(deps.runs.getJob(d1Job.id)?.runCount).toBe(2) // fired twice
    expect(deps.runs.getJob(d2Job.id)?.runCount).toBe(1) // joined on the second fire
  })
})

describe('fireOnce — onOverlap (plan 211 §3.2 decision 4, G10)', () => {
  test('onOverlap skip adds no run while a previous run is live', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', deviceIds: ['d1'], onOverlap: 'skip' })
    const deps = baseDeps(db)

    await fireOnce(deps, schedule, new Date())
    const afterFirst = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    const batchId = afterFirst.batchId!
    const job = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()[0]!
    // The run is left `running` (or `queued`) — never settled — so the batch is still active.
    expect(deps.runs.getJob(job.id)?.runCount).toBe(1)

    await fireOnce(deps, { ...schedule, batchId, lastFiredAt: afterFirst.lastFiredAt }, new Date())

    expect(deps.runs.getJob(job.id)?.runCount).toBe(1) // unchanged — no run added
    const row = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(row?.lastFireOutcome).toBe('skipped-overlap')
  })

  test('onOverlap queue adds a run even while the previous one is still live', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', deviceIds: ['d1'], onOverlap: 'queue' })
    const deps = baseDeps(db)

    await fireOnce(deps, schedule, new Date())
    const afterFirst = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    const batchId = afterFirst.batchId!
    const job = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()[0]!

    await fireOnce(deps, { ...schedule, batchId, lastFiredAt: afterFirst.lastFiredAt }, new Date())

    expect(deps.runs.getJob(job.id)?.runCount).toBe(2)
    const row = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(row?.lastFireOutcome).toBe('dispatched')
  })
})
