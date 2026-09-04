import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { batches, groups, devices, jobs, type GroupRow, type JobRow } from '../db/schema'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import { createBatch, pickRebindDevice } from './dispatch'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online') {
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

  test('a group resolving to zero usable devices is a coded error, not an empty batch', () => {
    const db = setUp()
    seedDevice(db, 'd1', 'offline')
    const group: GroupRow = { id: 'c1', name: 'Empty', description: null, createdAt: new Date() }
    db.insert(groups).values(group).run()
    db.update(devices).set({ groupId: 'c1' }).where(eq(devices.id, 'd1')).run()
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()

    expect(() =>
      createBatch(
        { db, scheduler, audit, onJobStatus: () => {} },
        { scriptId: 'internal:sleep', params: {}, target: { groupId: 'c1' }, concurrency: 0, order: 'as-listed' },
      ),
    ).toThrow(EnkakuError)
    const batchRows = db.select().from(jobs).all()
    expect(batchRows.length).toBe(0)
  })

  test('dispatching to a group with mixed online/offline members runs only the online ones (plan 22.0, acceptance #5)', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2', 'offline')
    seedDevice(db, 'd3')
    const group: GroupRow = { id: 'c1', name: 'Mixed', description: null, createdAt: new Date() }
    db.insert(groups).values(group).run()
    for (const id of ['d1', 'd2', 'd3']) db.update(devices).set({ groupId: 'c1' }).where(eq(devices.id, id)).run()
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()

    const { batch, jobs: created } = createBatch(
      { db, scheduler, audit, onJobStatus: () => {} },
      { scriptId: 'internal:sleep', params: {}, target: { groupId: 'c1' }, concurrency: 0, order: 'as-listed' },
    )

    // The offline member is skipped, not dropped silently — it is simply not
    // among the jobs created; the batch itself still runs on the rest.
    expect(created.map((j) => j.deviceId).sort()).toEqual(['d1', 'd3'])
    expect(batch.groupId).toBe('c1')
  })

  /**
   * Plan 93 §3.12, §4.2, §4.6, step 93.8, closing F11 — `resolved.skipped`
   * was already computed here (it decides `E_NO_TARGETS` above, and used to
   * be thrown away into the audit `meta` field) and is now persisted onto
   * the batch row itself, so an operator can see "17 of 20 — 3 were
   * offline" without opening the audit log.
   */
  test('resolved.skipped is persisted onto the batch row, with reasons', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2', 'offline')
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()

    const { batch } = createBatch(
      { db, scheduler, audit, onJobStatus: () => {} },
      { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1', 'd2'] }, concurrency: 0, order: 'as-listed' },
    )

    expect(batch.skipped).toEqual([{ deviceId: 'd2', reason: 'offline' }])
  })

  test('a batch with no skips persists skipped: null', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()

    const { batch } = createBatch(
      { db, scheduler, audit, onJobStatus: () => {} },
      { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1'] }, concurrency: 0, order: 'as-listed' },
    )

    expect(batch.skipped).toBeNull()
  })

  test('an unknown group id fails with group_not_found', () => {
    const db = setUp()
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()
    expect(() =>
      createBatch(
        { db, scheduler, audit, onJobStatus: () => {} },
        { scriptId: 'internal:sleep', params: {}, target: { groupId: 'nope' }, concurrency: 0, order: 'as-listed' },
      ),
    ).toThrow(EnkakuError)
  })
})

describe('createBatch — assertDeviceAllowed / canUseDevice (plan 34 §3.5, §4.4)', () => {
  test('a refusal on any resolved device stops the WHOLE batch — no job rows persist', () => {
    const db = setUp()
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()
    const checked: string[] = []

    expect(() =>
      createBatch(
        {
          db,
          scheduler,
          audit,
          onJobStatus: () => {},
          assertDeviceAllowed: (deviceId) => {
            checked.push(deviceId)
            if (deviceId === 'd2') throw new EnkakuError('auth.forbidden', 'this device belongs to another user')
          },
        },
        { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1', 'd2', 'd3'] }, concurrency: 0, order: 'as-listed' },
      ),
    ).toThrow(EnkakuError)

    expect(checked).toContain('d2')
    // No half-created batch — the check runs before any job row is built.
    expect(db.select().from(jobs).all().length).toBe(0)
  })

  test('with no assertDeviceAllowed configured, dispatch is unaffected — the pre-plan-34 default', () => {
    const db = setUp()
    for (const d of ['d1', 'd2']) seedDevice(db, d)
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()

    const { jobs: created } = createBatch(
      { db, scheduler, audit, onJobStatus: () => {} },
      { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1', 'd2'] }, concurrency: 0, order: 'as-listed' },
    )
    expect(created.length).toBe(2)
  })
})

describe('pickRebindDevice — moving a batch member after an infra failure (plan 36 §3.6)', () => {
  test('picks an online sibling device with no running job, never the one that just failed', () => {
    const db = setUp()
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()
    const { jobs: created } = createBatch(
      { db, scheduler, audit, onJobStatus: () => {} },
      { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1', 'd2', 'd3'] }, concurrency: 0, order: 'as-listed' },
    )
    // d2 and d3 stay queued (online, no running job); d1 is the device the job just failed on.
    const failing = created.find((j) => j.deviceId === 'd1')
    if (!failing) throw new Error('fixture: expected a job on d1')

    const picked = pickRebindDevice(db, failing)
    expect(picked).toBe('d2') // lowest batchSeq among the eligible siblings
  })

  test('returns null when every sibling device already has a running job (the caller then retries in place)', () => {
    const db = setUp()
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    const audit = createAuditLogger(db)
    const { scheduler } = fakeScheduler()
    const { jobs: created } = createBatch(
      { db, scheduler, audit, onJobStatus: () => {} },
      { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1', 'd2', 'd3'] }, concurrency: 0, order: 'as-listed' },
    )
    db.update(jobs).set({ status: 'running' }).where(eq(jobs.deviceId, 'd2')).run()
    db.update(jobs).set({ status: 'running' }).where(eq(jobs.deviceId, 'd3')).run()
    const failing = created.find((j) => j.deviceId === 'd1')
    if (!failing) throw new Error('fixture: expected a job on d1')

    expect(pickRebindDevice(db, failing)).toBeNull()
  })

  test('a standalone job (no batch) never rebinds', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const standalone: JobRow = {
      id: 'job-standalone',
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
      batchId: null,
      batchSeq: null,
      expiresAt: null,
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
      // Plan 98 §3.8, §4.4, step 98.7 — null here: a bare fixture row, no
      // per-job override exercised by this test.
      runtimeOverride: null,
      // Plan 94 §3.8, §4.8, step 94.6 — null here: a bare fixture row, no
      // pacer exercised by this test.
      notBefore: null,
      batchRepeat: null,
      pacedDelayMs: null,
      // Plan 97 §3.3, §4.4 — null here: a bare fixture row, this test does
      // not exercise a settled result.
      resultStatus: null,
      resultBytes: null,
      resultSummary: null,
      resultIssues: null,
    }
    expect(pickRebindDevice(db, standalone)).toBeNull()
  })
})

/**
 * Plan 95 §5 step 95.6's verifiable result, batch half: F11 recorded that a
 * batch validated its params blob once and fanned the SAME object into every
 * child job row — so a bad blob became N failing jobs, each of which leased a
 * device first. `deps.validateScript` (wired, in production, to
 * `validateScriptForRun` → the real script executor's `validateParams`,
 * `jobs/executors/script.ts`) is called as `createBatch`'s very first
 * statement, before target resolution and before either the batch or any job
 * row is written — this test proves that ordering directly, with a REAL
 * device row whose status a lease would have changed, rather than only
 * asserting the 400 a route would return.
 */
describe('createBatch — an invalid params object is refused before any device is leased (plan 95 §5 step 95.6)', () => {
  test('a validateScript that throws runs BEFORE target resolution, BEFORE any job/batch row exists, and BEFORE the scheduler is ever kicked', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const audit = createAuditLogger(db)
    let kicked = false
    const scheduler: Scheduler = { kick: () => void (kicked = true), start: () => {}, stop: () => {} }

    expect(() =>
      createBatch(
        {
          db,
          scheduler,
          audit,
          onJobStatus: () => {},
          // Mirrors what the real script executor now throws for a params
          // object that fails the published schema (script.ts's
          // `validateParams`) — same code, same `issues` shape.
          validateScript: () => {
            throw new EnkakuError('invalid_job_params', 'videos: must be at most 2000', undefined, [
              { path: 'videos', message: 'must be at most 2000' },
            ])
          },
        },
        { scriptId: 'checkout', params: { videos: 9999 }, target: { deviceIds: ['d1', 'd2'] }, concurrency: 0, order: 'as-listed' },
      ),
    ).toThrow(EnkakuError)

    // Nothing exists for a device to be claimed against — the strongest form
    // of "no device is claimed" is "there is no job".
    expect(db.select().from(jobs).all().length).toBe(0)
    expect(db.select().from(batches).all().length).toBe(0)
    // Both devices are completely untouched — still `online`, never targeted.
    expect(db.select().from(devices).all().every((d) => d.status === 'online')).toBe(true)
    // The scheduler — the thing that actually assigns a queued job to a
    // device — was never even kicked.
    expect(kicked).toBe(false)
  })

  test('the thrown error carries the field-level issue, unchanged, for the route to turn into { error: { issues } }', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const audit = createAuditLogger(db)
    const scheduler: Scheduler = { kick: () => {}, start: () => {}, stop: () => {} }

    let caught: EnkakuError | undefined
    try {
      createBatch(
        {
          db,
          scheduler,
          audit,
          onJobStatus: () => {},
          validateScript: () => {
            throw new EnkakuError('invalid_job_params', 'videos: must be at most 2000', undefined, [
              { path: 'videos', message: 'must be at most 2000' },
            ])
          },
        },
        { scriptId: 'checkout', params: { videos: 9999 }, target: { deviceIds: ['d1'] }, concurrency: 0, order: 'as-listed' },
      )
    } catch (err) {
      caught = err as EnkakuError
    }

    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('invalid_job_params')
    expect(caught?.issues).toEqual([{ path: 'videos', message: 'must be at most 2000' }])
  })
})
