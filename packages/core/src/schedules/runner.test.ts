import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobRuns, jobs, schedules, scheduleWorkflowTargets, scripts, workflows, type ScheduleRow } from '../db/schema'
import { createRunStore } from '../jobs/runs/store'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createLogger } from '../util/logger'
import { applyDeviceLabels, createLabel } from '../registry/device-labels'
import { createWorkflowStore } from '../workflows/store'
import { fireOnce, scheduleTarget, type ScheduleRunnerDeps } from './runner'

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
    labelIds: overrides.labelIds ?? null,
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
    waveSize: overrides.waveSize ?? 1,
    deviceDelayMinMs: overrides.deviceDelayMinMs ?? 0,
    deviceDelayMaxMs: overrides.deviceDelayMaxMs ?? 0,
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


describe('fireOnce — a label target (plan 225)', () => {
  test('dispatches to every device carrying ALL the labels, and to no other', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedDevice(db, 'd3')
    const smoke = createLabel(db, { name: 'Smoke Pool' })
    const a15 = createLabel(db, { name: 'Android 15' })
    applyDeviceLabels(db, 'd1', 'add', [smoke.id, a15.id])
    applyDeviceLabels(db, 'd2', 'add', [smoke.id])
    applyDeviceLabels(db, 'd3', 'add', [a15.id])

    const schedule = seedSchedule(db, { id: 's1', deviceIds: null, labelIds: [smoke.id, a15.id] })
    const deps = baseDeps(db)
    await fireOnce(deps, schedule, new Date())

    const row = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(row?.lastFireOutcome).toBe('dispatched')
    const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, row!.batchId!)).all()
    expect(memberJobs.map((j) => j.deviceId)).toEqual(['d1'])
  })

  test('a device labelled AFTER the schedule was written is in the next fire — the reason to schedule against a label at all', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const smoke = createLabel(db, { name: 'Smoke Pool' })
    applyDeviceLabels(db, 'd1', 'add', [smoke.id])

    const schedule = seedSchedule(db, { id: 's1', deviceIds: null, labelIds: [smoke.id] })
    const deps = baseDeps(db)
    await fireOnce(deps, schedule, new Date())

    const afterFirst = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    expect(db.select().from(jobs).where(eq(jobs.batchId, afterFirst.batchId!)).all()).toHaveLength(1)

    // Settle the first fire's runs — `onOverlap` defaults to `skip`, so a
    // second fire over a live batch would skip before it ever resolved the
    // target, and this test would pass for the wrong reason.
    for (const j of db.select().from(jobs).where(eq(jobs.batchId, afterFirst.batchId!)).all()) {
      const run = deps.runs.latestRun(j.id)
      if (run) db.update(jobRuns).set({ status: 'success', finishedAt: new Date() }).where(eq(jobRuns.id, run.id)).run()
    }

    // The operator labels a second phone between the two firings.
    applyDeviceLabels(db, 'd2', 'add', [smoke.id])
    await fireOnce(deps, afterFirst, new Date())

    const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, afterFirst.batchId!)).all()
    expect(new Set(memberJobs.map((j) => j.deviceId))).toEqual(new Set(['d1', 'd2']))
  })

  test('a label nothing carries any more reports no-targets rather than dispatching an empty batch', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const orphan = createLabel(db, { name: 'Nobody' })

    const schedule = seedSchedule(db, { id: 's1', deviceIds: null, labelIds: [orphan.id] })
    await fireOnce(baseDeps(db), schedule, new Date())

    expect(db.select().from(schedules).where(eq(schedules.id, 's1')).get()?.lastFireOutcome).toBe('no-targets')
  })
})

describe('scheduleTarget (plan 225)', () => {
  test('reads a group, a label set, or an explicit list — in that order of specificity', () => {
    const db = setUp()
    const label = createLabel(db, { name: 'Smoke Pool' })
    expect(scheduleTarget(seedSchedule(db, { id: 'g', groupId: 'grp-1' }))).toEqual({ groupId: 'grp-1' })
    expect(scheduleTarget(seedSchedule(db, { id: 'l', deviceIds: null, labelIds: [label.id] }))).toEqual({ labelIds: [label.id] })
    expect(scheduleTarget(seedSchedule(db, { id: 'd', deviceIds: ['d1'] }))).toEqual({ deviceIds: ['d1'] })
  })

  test('an empty stored label list is not a label target — it falls through to the device list', () => {
    const db = setUp()
    expect(scheduleTarget(seedSchedule(db, { id: 's', labelIds: [], deviceIds: ['d1'] }))).toEqual({ deviceIds: ['d1'] })
  })
})

// ---------------------------------------------------------------------------
// The workflow work target (plan 314 §7.1)
// ---------------------------------------------------------------------------

/** A one-node document that records which platform this device+slot lands on. */
function warmupDoc(name = 'warmup') {
  return {
    schema: 2 as const,
    name,
    title: 'Warmup',
    description: '',
    entry: 'start',
    maxSteps: 10,
    params: [],
    nodes: [
      { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, next: 'pick' },
      {
        kind: 'set',
        id: 'pick',
        title: '',
        ui: { x: 0, y: 0 },
        assignments: [{ name: { const: 'platform' }, value: { expr: '($device.number + 0) % 3' } }],
        keepOnlySet: false,
        next: 'finish',
      },
      { kind: 'finish', id: 'finish', title: '', ui: { x: 0, y: 0 }, status: 'succeed', message: '' },
    ],
  }
}

function seedWorkflow(db: Db, name = 'warmup') {
  db.insert(workflows).values({ id: `wf-${name}`, name, doc: warmupDoc(name), createdBy: null, createdAt: new Date(), updatedAt: new Date() }).run()
}

function seedWorkflowSchedule(db: Db, scheduleId: string, workflowName = 'warmup') {
  db.insert(scheduleWorkflowTargets).values({ scheduleId, workflowName, params: null, createdAt: new Date() }).run()
}

describe('fireOnce — a schedule may target a WORKFLOW (plan 314 §7.1)', () => {
  test('the first fire creates one workflow job per device, each carrying the document', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedWorkflow(db)
    // `scriptRef` is unused for this kind — the dispatcher branches on the
    // companion row before it ever reads that column.
    const schedule = seedSchedule(db, { id: 's1', scriptRef: '' })
    seedWorkflowSchedule(db, 's1')
    const deps = baseDeps(db, { workflows: createWorkflowStore(db) })

    await fireOnce(deps, schedule, new Date())

    const row = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(row?.lastFireOutcome).toBe('dispatched')
    const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, row!.batchId!)).all()
    expect(memberJobs).toHaveLength(2)
    for (const j of memberJobs) {
      expect(j.kind).toBe('workflow')
      expect(j.workflowName).toBe('warmup')
      // The snapshot is what makes editing a workflow safe mid-flight.
      expect((j.workflowDoc as { name?: string } | null)?.name).toBe('warmup')
      // Stamped, so `GET /api/schedules/:id/jobs` finds it from the FIRST
      // fire — the screen built to prove a warm-up ran would otherwise be
      // empty for exactly the schedules it was built for.
      expect(j.scheduleId).toBe('s1')
    }
  })

  test('the first fire’s runs carry trigger `schedule`, not `batch`', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedWorkflow(db)
    const schedule = seedSchedule(db, { id: 's1', scriptRef: '' })
    seedWorkflowSchedule(db, 's1')
    const deps = baseDeps(db, { workflows: createWorkflowStore(db) })

    await fireOnce(deps, schedule, new Date())

    const batchId = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!.batchId!
    expect([...runsByDevice(db, batchId).values()].flat().map((r) => r.trigger)).toEqual(['schedule'])
  })

  test('a later fire reuses the batch, adds a run per member, and gives a NEW device its own job', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedWorkflow(db)
    const schedule = seedSchedule(db, { id: 's1', scriptRef: '' })
    seedWorkflowSchedule(db, 's1')
    const deps = baseDeps(db, { workflows: createWorkflowStore(db) })

    await fireOnce(deps, schedule, new Date())
    const batchId = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!.batchId!
    for (const j of db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()) {
      const run = deps.runs.latestRun(j.id)
      if (run) db.update(jobRuns).set({ status: 'success' }).where(eq(jobRuns.id, run.id)).run()
    }

    // A phone joins the group between the two firings — the target is
    // re-resolved at EVERY fire, so it must be in the next one.
    seedDevice(db, 'd2')
    const after = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    await fireOnce(deps, after, new Date())

    expect(db.select().from(schedules).where(eq(schedules.id, 's1')).get()!.batchId).toBe(batchId)
    const byDevice = runsByDevice(db, batchId)
    expect(byDevice.get('d1')).toHaveLength(2)
    expect(byDevice.get('d2')).toHaveLength(1)
    expect(db.select().from(batches).where(eq(batches.id, batchId)).all()).toHaveLength(1)
  })

  test('a later fire re-snapshots the CURRENT document onto a settled member', async () => {
    // Editing a warm-up must change what tomorrow runs. Pinning the document
    // at the first fire would mean an operator edits it, sees it saved, and
    // the farm keeps running last month's version with nothing to show.
    const db = setUp()
    seedDevice(db, 'd1')
    seedWorkflow(db)
    const schedule = seedSchedule(db, { id: 's1', scriptRef: '' })
    seedWorkflowSchedule(db, 's1')
    const store = createWorkflowStore(db)
    const deps = baseDeps(db, { workflows: store })

    await fireOnce(deps, schedule, new Date())
    const batchId = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!.batchId!
    for (const j of db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()) {
      const run = deps.runs.latestRun(j.id)
      if (run) db.update(jobRuns).set({ status: 'success' }).where(eq(jobRuns.id, run.id)).run()
    }

    const edited = { ...warmupDoc(), title: 'Warmup, edited' }
    db.update(workflows).set({ doc: edited, updatedAt: new Date() }).where(eq(workflows.name, 'warmup')).run()

    const after = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    await fireOnce(deps, after, new Date())

    const member = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()[0]!
    expect((member.workflowDoc as { title?: string }).title).toBe('Warmup, edited')
  })

  test('a workflow schedule on a core with no workflow store fails NAMED, never silently', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedWorkflow(db)
    const schedule = seedSchedule(db, { id: 's1', scriptRef: '' })
    seedWorkflowSchedule(db, 's1')
    const deps = baseDeps(db) // no `workflows`

    await fireOnce(deps, schedule, new Date())

    const row = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    expect(row.lastFireOutcome).toBe('error')
    expect(row.lastFireDetail).toContain('E_WORKFLOW_STORE_UNAVAILABLE')
  })

  test('the per-device delay a schedule stores reaches the batch (plan 314 §10.5)', async () => {
    // The regression this closes: the runner built its pacing from four
    // columns and `deviceDelayMs` was not one of them, so "each device starts
    // at its own time" was unsettable on a schedule however the operator set
    // it.
    const db = setUp()
    seedDevice(db, 'd1')
    seedWorkflow(db)
    const schedule = seedSchedule(db, { id: 's1', scriptRef: '', deviceDelayMinMs: 60_000, deviceDelayMaxMs: 7_200_000 })
    seedWorkflowSchedule(db, 's1')
    const deps = baseDeps(db, { workflows: createWorkflowStore(db) })

    await fireOnce(deps, schedule, new Date())

    const batchId = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!.batchId!
    const batch = db.select().from(batches).where(eq(batches.id, batchId)).get()!
    expect(batch.deviceDelayMinMs).toBe(60_000)
    expect(batch.deviceDelayMaxMs).toBe(7_200_000)
  })
})

describe('fireOnce — a SCRIPT schedule also carries its per-device delay (plan 314 §10.5)', () => {
  test('the same pacing block reaches a script batch', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const schedule = seedSchedule(db, { id: 's1', deviceDelayMinMs: 5_000, deviceDelayMaxMs: 25_000 })
    const deps = baseDeps(db)

    await fireOnce(deps, schedule, new Date())

    const batchId = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!.batchId!
    const batch = db.select().from(batches).where(eq(batches.id, batchId)).get()!
    expect(batch.deviceDelayMinMs).toBe(5_000)
    expect(batch.deviceDelayMaxMs).toBe(25_000)
  })
})

// ---------------------------------------------------------------------------
// The route-level path (plan 314 §7.1) — `run-now` must reach the same branch
// the cron firing does.
// ---------------------------------------------------------------------------

describe('a workflow schedule dispatches identically however it is fired', () => {
  test('run-now and a cron firing both reach the workflow branch', async () => {
    // The bug this pins: the daemon hands the workflow store to the RUNNER,
    // while `api/schedules.ts` builds its own `runnerDeps` for `run-now`. Miss
    // it there and the scheduled firing works while the button an operator
    // presses to TEST the rotation fails — the one asymmetry that would make
    // someone conclude the whole feature is broken.
    const db = setUp()
    seedDevice(db, 'd1')
    seedWorkflow(db)
    const schedule = seedSchedule(db, { id: 's1', scriptRef: '' })
    seedWorkflowSchedule(db, 's1')
    const deps = baseDeps(db, { workflows: createWorkflowStore(db) })

    // `run-now` is `fireOnce` with jitter suppressed — the route adds nothing
    // else, so firing the same way here covers the same ground.
    await fireOnce(deps, { ...schedule, jitterSec: 0 }, new Date())

    const row = db.select().from(schedules).where(eq(schedules.id, 's1')).get()!
    expect(row.lastFireOutcome).toBe('dispatched')
    expect(row.batchId).toBeTruthy()
    const members = db.select().from(jobs).where(eq(jobs.batchId, row.batchId!)).all()
    expect(members).toHaveLength(1)
    expect(members[0]?.kind).toBe('workflow')
  })
})
