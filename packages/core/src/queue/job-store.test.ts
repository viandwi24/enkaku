import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobRuns } from '../db/schema'
import { createRunStore } from '../jobs/runs/store'
import { createJobStore } from './job-store'

/**
 * The claim query (plan 20 §4.2, §7, rewritten by plan 211 §4.6) is the only
 * place device booking is made race-free (spec §10.3). It now claims RUNS,
 * not jobs — these tests are written against the new gate: a batch's
 * `concurrency` must never be exceeded, `maxConcurrent` counts running runs
 * by script name, `not_before` is respected, and a workflow job's own step
 * run is admitted onto the device its parent already holds while every
 * other run stays blocked.
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' | 'quarantined' = 'online') {
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

/** A job plus one queued run, through the same `RunStore` production code uses. */
function seedJobAndRun(
  db: Db,
  input: {
    deviceId: string
    priority?: number
    batchId?: string | null
    batchSeq?: number | null
    scriptName?: string | null
    maxConcurrent?: number | null
    notBefore?: number | null
    parentWorkflowJobId?: string | null
    kind?: 'script' | 'workflow'
  },
) {
  const runs = createRunStore(db)
  const kind = input.kind ?? 'script'
  const job = runs.createJob({
    kind,
    scriptId: kind === 'script' ? 'internal:sleep' : undefined,
    workflowName: kind === 'workflow' ? 'wf' : undefined,
    deviceId: input.deviceId,
    params: { durationMs: 1000 },
    scriptName: input.scriptName ?? null,
    scriptVersion: null,
    batchId: input.batchId ?? null,
    batchSeq: input.batchSeq ?? null,
    parentWorkflowJobId: input.parentWorkflowJobId ?? null,
    stepSeq: input.parentWorkflowJobId ? (seq += 1) : null,
  })
  const run = runs.addRun(job.id, {
    trigger: input.batchId ? 'batch' : 'manual',
    priority: input.priority ?? 0,
    maxConcurrent: input.maxConcurrent ?? null,
    notBefore: input.notBefore ?? null,
  })
  return { job, run }
}

describe('claimNext — claims one run at a time per device', () => {
  test('a standalone job is claimed exactly once', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const { run } = seedJobAndRun(db, { deviceId: 'd1' })

    const first = store.claimNext(60)
    expect(first?.run.id).toBe(run.id)
    expect(first?.run.status).toBe('running')

    const second = store.claimNext(60)
    expect(second).toBeNull()
  })

  test('two queued runs on one online device claim strictly one at a time', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedJobAndRun(db, { deviceId: 'd1' })
    seedJobAndRun(db, { deviceId: 'd1' })

    const first = store.claimNext(60)
    expect(first).not.toBeNull()
    const second = store.claimNext(60)
    expect(second).toBeNull()
  })

  test('an offline device claims nothing', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1', 'offline')
    seedJobAndRun(db, { deviceId: 'd1' })
    expect(store.claimNext(60)).toBeNull()
  })
})

describe('claimNext — the workflow parent exemption (plan 211 §3.2 decision 8)', () => {
  test('a workflow step run is claimed while its own parent workflow job is running on that device', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')

    // The workflow job's own run holds the device.
    const { job: workflowJob, run: workflowRun } = seedJobAndRun(db, { deviceId: 'd1', kind: 'workflow' })
    const claimedWorkflow = store.claimNext(60)
    expect(claimedWorkflow?.run.id).toBe(workflowRun.id)

    // Its own step run is claimable even though the device already has a running run.
    const { run: stepRun } = seedJobAndRun(db, { deviceId: 'd1', parentWorkflowJobId: workflowJob.id })
    const claimedStep = store.claimNext(60)
    expect(claimedStep?.run.id).toBe(stepRun.id)
  })

  test('an unrelated run is not claimed while a workflow job runs on that device', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')

    const { job: workflowJob } = seedJobAndRun(db, { deviceId: 'd1', kind: 'workflow' })
    store.claimNext(60) // claims the workflow job's own run

    seedJobAndRun(db, { deviceId: 'd1' }) // an ordinary, unrelated job
    expect(store.claimNext(60)).toBeNull()

    // A second workflow job's own run is also blocked — the exemption is scoped to ITS OWN parent.
    seedJobAndRun(db, { deviceId: 'd1', kind: 'workflow' })
    expect(store.claimNext(60)).toBeNull()
    void workflowJob
  })

  test('a second step of the same workflow is not claimed while the first step runs', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const { job: workflowJob } = seedJobAndRun(db, { deviceId: 'd1', kind: 'workflow' })
    store.claimNext(60)

    seedJobAndRun(db, { deviceId: 'd1', parentWorkflowJobId: workflowJob.id })
    const claimedFirstStep = store.claimNext(60)
    expect(claimedFirstStep).not.toBeNull()

    seedJobAndRun(db, { deviceId: 'd1', parentWorkflowJobId: workflowJob.id })
    expect(store.claimNext(60)).toBeNull()
  })
})

describe('claimNext — batch and maxConcurrent gates', () => {
  test('batch concurrency counts running runs across member jobs', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedBatch(db, 'b1', 1)
    seedJobAndRun(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    seedJobAndRun(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })

    const first = store.claimNext(60)
    expect(first).not.toBeNull()
    // The batch's concurrency (1) is already spent by the first claim.
    const second = store.claimNext(60)
    expect(second).toBeNull()
  })

  test('maxConcurrent counts running runs by script name', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedJobAndRun(db, { deviceId: 'd1', scriptName: 'auto-scroll', maxConcurrent: 1 })
    seedJobAndRun(db, { deviceId: 'd2', scriptName: 'auto-scroll', maxConcurrent: 1 })

    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).toBeNull()
  })

  test('not_before is respected', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const future = Math.floor(Date.now() / 1000) + 3600
    seedJobAndRun(db, { deviceId: 'd1', notBefore: future })
    expect(store.claimNext(60)).toBeNull()
  })

  test('heartbeat_expires_at is written on claim', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedJobAndRun(db, { deviceId: 'd1' })
    const claimed = store.claimNext(60)
    expect(claimed?.run.heartbeatExpiresAt).not.toBeNull()
  })
})

describe('requeueForRebind', () => {
  test('keeps the run and increments infra_attempts', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const { run } = seedJobAndRun(db, { deviceId: 'd1' })
    const claimed = store.claimNext(60)
    expect(claimed).not.toBeNull()

    const rebound = store.requeueForRebind(run.id, 'd2')
    expect(rebound?.id).toBe(run.id)
    expect(rebound?.status).toBe('queued')
    expect(rebound?.deviceId).toBe('d2')
    expect(rebound?.infraAttempts).toBe(1)
    expect(store.get(run.jobId)?.deviceId).toBe('d2')
  })
})

/**
 * The `status` filter is a filter, not a suggestion — and `total` must obey it.
 *
 * It used to be applied in JavaScript AFTER the page was fetched, while
 * `total` was counted without it. `GET /api/jobs?status=queued` therefore
 * answered `items: []` with `total: 123` on a farm whose queue was empty, and
 * the status bar read "Jobs 0/123" (owner, 2026-09-04). Paging was worse:
 * `limit` counted rows BEFORE the filter, so a caller looking for queued work
 * walked the whole history a page at a time.
 */
/** Sets a run's status directly — the fixture wants the column, not the lifecycle. */
function finishRun(db: Db, runId: string, status: 'success' | 'failed'): void {
  db.update(jobRuns).set({ status, finishedAt: new Date() }).where(eq(jobRuns.id, runId)).run()
}

describe('list({ status }) filters in SQL, and total agrees with items (owner report, 2026-09-04)', () => {
  test('an empty queue reports total 0, not the whole history', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const { run } = seedJobAndRun(db, { deviceId: 'd1' })
    // Straight to the column: `settle` refuses a run that was never claimed,
    // and what this test needs is the STATUS, not the lifecycle around it.
    finishRun(db, run.id, 'failed')

    const store = createJobStore(db)
    expect(store.list({ status: 'queued', limit: 20, cursor: null }).total).toBe(0)
    expect(store.list({ status: 'failed', limit: 20, cursor: null }).total).toBe(1)
    expect(store.list({ limit: 20, cursor: null }).total).toBe(1)
  })

  test('`limit` counts rows AFTER the filter — one queued job among many finished ones is found on the first page', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    for (let i = 0; i < 5; i++) {
      const { run } = seedJobAndRun(db, { deviceId: 'd1' })
      finishRun(db, run.id, 'success')
    }
    const { job: queuedJob } = seedJobAndRun(db, { deviceId: 'd1' })

    const store = createJobStore(db)
    const page = store.list({ status: 'queued', limit: 2, cursor: null })

    expect(page.rows.map((r) => r.id)).toEqual([queuedJob.id])
    expect(page.total).toBe(1)
  })
})
