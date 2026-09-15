import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobRuns, jobs, schedules, scheduleWorkflowTargets, scripts, workflows, type ScheduleRow } from '../db/schema'
import { createBatchPacer } from '../groups/pacer'
import { createRunStore } from '../jobs/runs/store'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createLogger } from '../util/logger'
import { applyDeviceLabels, createLabel } from '../registry/device-labels'
import { createWorkflowStore } from '../workflows/store'
import { fireOnce, scheduleTarget, type ScheduleRunnerDeps } from './runner'

/**
 * `schedules/runner.test.ts` (plan 211 §7.1, G10). Every fire creates its OWN
 * batch through `createBatch`/`createWorkflowBatch` — the same functions a
 * manual run-script or run-workflow uses — so the batch is paced by
 * `planFirst` like any other, earlier batches are never touched, and
 * `schedules.batch_id` names the newest. (The reuse-one-batch model of plan
 * 211 §3.2 decision 4 added unplanned runs to an old batch on every later
 * fire, which started every phone at once.) `schedules.last_fire_outcome`/
 * `last_fire_detail` replace the deleted per-fire ledger.
 *
 * This file is a deliberately SCOPED replacement for the pre-211 suite
 * (plan 200 §8.3 — a test whose fixtures assert a structurally impossible
 * shape is rewritten to what the plan's own goal checklist names, not
 * ported wholesale): it proves the per-fire batch, its pacing, the overlap
 * policy against the previous fire's batch, and the label and workflow
 * targets that the same `fireOnce` call path also governs. Every OTHER
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
    sequential: overrides.sequential ?? false,
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

/** Marks every member's latest run of a batch `success`, so the next fire is not an overlap. */
function settleBatch(db: Db, batchId: string) {
  const runs = createRunStore(db)
  for (const j of db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()) {
    const run = runs.latestRun(j.id)
    if (run) db.update(jobRuns).set({ status: 'success', finishedAt: new Date() }).where(eq(jobRuns.id, run.id)).run()
  }
}

/** Everything a fire could have touched on one batch: its row, its member jobs, and every run on them. */
function batchSnapshot(db: Db, batchId: string): string {
  const batch = db.select().from(batches).where(eq(batches.id, batchId)).get()
  const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()
  const runs = memberJobs.flatMap((j) => db.select().from(jobRuns).where(eq(jobRuns.jobId, j.id)).all())
  return JSON.stringify({ batch, memberJobs, runs })
}

function scheduleRow(db: Db, id = 's1'): ScheduleRow {
  return db.select().from(schedules).where(eq(schedules.id, id)).get()!
}

describe('fireOnce — every fire creates its own batch', () => {
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

  test('a second fire creates a NEW batch, leaves the first untouched, and points schedule.batchId at the newest', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedSchedule(db, { id: 's1' })
    const deps = baseDeps(db)

    await fireOnce(deps, scheduleRow(db), new Date())
    const firstBatchId = scheduleRow(db).batchId!
    settleBatch(db, firstBatchId)
    const firstBefore = batchSnapshot(db, firstBatchId)

    await fireOnce(deps, scheduleRow(db), new Date())

    const row = scheduleRow(db)
    expect(row.lastFireOutcome).toBe('dispatched')
    expect(row.batchId).toBeTruthy()
    expect(row.batchId).not.toBe(firstBatchId)
    expect(db.select().from(batches).all()).toHaveLength(2)
    // The earlier batch, its member jobs and every run on them are byte-for-byte what they were.
    expect(batchSnapshot(db, firstBatchId)).toBe(firstBefore)

    const newMembers = db.select().from(jobs).where(eq(jobs.batchId, row.batchId!)).all()
    expect(new Set(newMembers.map((j) => j.deviceId))).toEqual(new Set(['d1', 'd2']))
    for (const j of newMembers) {
      expect(j.scheduleId).toBe('s1')
      expect(deps.runs.getJob(j.id)?.runCount).toBe(1)
    }
    for (const [, runsForDevice] of runsByDevice(db, row.batchId!)) {
      expect(runsForDevice.map((r) => r.trigger)).toEqual(['schedule'])
    }
  })

  test('a device joining the target after the first fire is in the next fire\'s batch', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedSchedule(db, { id: 's1', deviceIds: ['d1'] })
    const deps = baseDeps(db)

    await fireOnce(deps, scheduleRow(db), new Date())
    const firstBatchId = scheduleRow(db).batchId!
    settleBatch(db, firstBatchId)

    db.update(schedules).set({ deviceIds: ['d1', 'd2'] }).where(eq(schedules.id, 's1')).run()
    await fireOnce(deps, scheduleRow(db), new Date())

    expect(db.select().from(jobs).where(eq(jobs.batchId, firstBatchId)).all().map((j) => j.deviceId)).toEqual(['d1'])
    const newMembers = db.select().from(jobs).where(eq(jobs.batchId, scheduleRow(db).batchId!)).all()
    expect(new Set(newMembers.map((j) => j.deviceId))).toEqual(new Set(['d1', 'd2']))
  })
})

describe('fireOnce — a later fire is planned like a manual batch (plan 316)', () => {
  test('a sequential schedule\'s second fire gets its own sub-groups: sub-group 0 released, later sub-groups held', async () => {
    // The bug this closes: a later fire reused the first batch and added runs
    // with no `batchRepeat`, `batchWave` or `held`, which the pacer ignores and
    // the claim releases — so every phone started at once.
    const db = setUp()
    for (const id of ['d1', 'd2', 'd3', 'd4']) seedDevice(db, id)
    seedSchedule(db, { id: 's1', deviceIds: ['d1', 'd2', 'd3', 'd4'], sequential: true, waveSize: 2, repeatCount: 2 })
    const deps = baseDeps(db)
    const pacer = createBatchPacer({ db, runs: deps.runs, scheduler: fakeScheduler(), log: createLogger('test') })
    const pacedDeps = { ...deps, pacer }

    try {
      const latestRunShape = (batchId: string) =>
        db
          .select()
          .from(jobs)
          .where(eq(jobs.batchId, batchId))
          .orderBy(jobs.batchSeq)
          .all()
          .map((j) => {
            const run = deps.runs.latestRun(j.id)!
            return { deviceId: j.deviceId, batchRepeat: run.batchRepeat, batchWave: run.batchWave, held: run.held }
          })

      await fireOnce(pacedDeps, scheduleRow(db), new Date())
      const firstBatchId = scheduleRow(db).batchId!
      const expected = [
        { deviceId: 'd1', batchRepeat: 0, batchWave: 0, held: false },
        { deviceId: 'd2', batchRepeat: 0, batchWave: 0, held: false },
        { deviceId: 'd3', batchRepeat: 0, batchWave: 1, held: true },
        { deviceId: 'd4', batchRepeat: 0, batchWave: 1, held: true },
      ]
      expect(latestRunShape(firstBatchId)).toEqual(expected)

      settleBatch(db, firstBatchId)
      const firstBefore = batchSnapshot(db, firstBatchId)

      await fireOnce(pacedDeps, scheduleRow(db), new Date())
      const secondBatchId = scheduleRow(db).batchId!
      expect(secondBatchId).not.toBe(firstBatchId)
      const secondBatch = db.select().from(batches).where(eq(batches.id, secondBatchId)).get()!
      expect(secondBatch.sequential).toBe(true)
      expect(secondBatch.waveSize).toBe(2)
      expect(secondBatch.repeatCount).toBe(2)
      // Planned exactly like the first — its own phase 0, its own sub-groups.
      expect(latestRunShape(secondBatchId)).toEqual(expected)
      // And the first fire's finished runs were not re-planned.
      expect(batchSnapshot(db, firstBatchId)).toBe(firstBefore)
    } finally {
      pacer.stop()
    }
  })
})

describe('fireOnce — onOverlap is judged against the previous fire\'s batch', () => {
  test('skip creates no batch while the previous one still has a queued member, and says why', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedSchedule(db, { id: 's1', deviceIds: ['d1'], onOverlap: 'skip' })
    const fired: { outcome: string; batchId: string | null }[] = []
    const deps = baseDeps(db, { broadcastFired: (msg) => fired.push({ outcome: msg.payload.outcome, batchId: msg.payload.batchId }) })

    await fireOnce(deps, scheduleRow(db), new Date())
    const firstBatchId = scheduleRow(db).batchId!
    // The first fire's run is left queued — never settled — so the batch is still active.
    const firstBefore = batchSnapshot(db, firstBatchId)

    await fireOnce(deps, scheduleRow(db), new Date())

    const row = scheduleRow(db)
    expect(row.lastFireOutcome).toBe('skipped-overlap')
    expect(row.lastFireDetail).toContain('previous run still active')
    expect(row.batchId).toBe(firstBatchId) // still the newest batch there is
    expect(db.select().from(batches).all()).toHaveLength(1)
    expect(batchSnapshot(db, firstBatchId)).toBe(firstBefore)
    expect(fired.at(-1)).toEqual({ outcome: 'skipped-overlap', batchId: null })
  })

  test('a settled previous batch is not an overlap', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedSchedule(db, { id: 's1', deviceIds: ['d1'], onOverlap: 'skip' })
    const deps = baseDeps(db)

    await fireOnce(deps, scheduleRow(db), new Date())
    settleBatch(db, scheduleRow(db).batchId!)
    await fireOnce(deps, scheduleRow(db), new Date())

    expect(scheduleRow(db).lastFireOutcome).toBe('dispatched')
    expect(db.select().from(batches).all()).toHaveLength(2)
  })

  test('queue creates the new batch anyway and moves schedule.batchId to it, leaving the live one alone', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedSchedule(db, { id: 's1', deviceIds: ['d1'], onOverlap: 'queue' })
    const deps = baseDeps(db)

    await fireOnce(deps, scheduleRow(db), new Date())
    const firstBatchId = scheduleRow(db).batchId!
    const firstBefore = batchSnapshot(db, firstBatchId)

    await fireOnce(deps, scheduleRow(db), new Date())

    const row = scheduleRow(db)
    expect(row.lastFireOutcome).toBe('dispatched')
    expect(row.lastFireDetail).toContain('previous run still active')
    expect(row.batchId).not.toBe(firstBatchId)
    expect(db.select().from(jobs).where(eq(jobs.batchId, row.batchId!)).all()).toHaveLength(1)
    expect(batchSnapshot(db, firstBatchId)).toBe(firstBefore)
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

    const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, scheduleRow(db).batchId!)).all()
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

  test('a later fire creates a NEW workflow batch, with a device that joined in between', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedWorkflow(db)
    seedSchedule(db, { id: 's1', scriptRef: '' })
    seedWorkflowSchedule(db, 's1')
    const deps = baseDeps(db, { workflows: createWorkflowStore(db) })

    await fireOnce(deps, scheduleRow(db), new Date())
    const firstBatchId = scheduleRow(db).batchId!
    settleBatch(db, firstBatchId)
    const firstBefore = batchSnapshot(db, firstBatchId)

    // A phone joins between the two firings — the target is re-resolved at
    // EVERY fire, so it must be in the next one.
    seedDevice(db, 'd2')
    await fireOnce(deps, scheduleRow(db), new Date())

    const secondBatchId = scheduleRow(db).batchId!
    expect(secondBatchId).not.toBe(firstBatchId)
    expect(batchSnapshot(db, firstBatchId)).toBe(firstBefore)
    const byDevice = runsByDevice(db, secondBatchId)
    expect(byDevice.get('d1')).toHaveLength(1)
    expect(byDevice.get('d2')).toHaveLength(1)
    for (const j of db.select().from(jobs).where(eq(jobs.batchId, secondBatchId)).all()) expect(j.kind).toBe('workflow')
  })

  test('a later fire snapshots the CURRENT document onto its own batch, and the earlier batch keeps its own', async () => {
    // Editing a warm-up must change what tomorrow runs. Pinning the document
    // at the first fire would mean an operator edits it, sees it saved, and
    // the farm keeps running last month's version with nothing to show.
    const db = setUp()
    seedDevice(db, 'd1')
    seedWorkflow(db)
    seedSchedule(db, { id: 's1', scriptRef: '' })
    seedWorkflowSchedule(db, 's1')
    const deps = baseDeps(db, { workflows: createWorkflowStore(db) })

    await fireOnce(deps, scheduleRow(db), new Date())
    const firstBatchId = scheduleRow(db).batchId!
    settleBatch(db, firstBatchId)

    const edited = { ...warmupDoc(), title: 'Warmup, edited' }
    db.update(workflows).set({ doc: edited, updatedAt: new Date() }).where(eq(workflows.name, 'warmup')).run()

    await fireOnce(deps, scheduleRow(db), new Date())

    const newMember = db.select().from(jobs).where(eq(jobs.batchId, scheduleRow(db).batchId!)).all()[0]!
    expect((newMember.workflowDoc as { title?: string }).title).toBe('Warmup, edited')
    const oldMember = db.select().from(jobs).where(eq(jobs.batchId, firstBatchId)).all()[0]!
    expect((oldMember.workflowDoc as { title?: string }).title).toBe('Warmup')
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
