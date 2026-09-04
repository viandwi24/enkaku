import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobRuns } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import { createRunStore } from '../jobs/runs/store'
import { createBatch, type BatchDispatchDeps } from '../groups/dispatch'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { createBatchRoutes, type BatchRoutesDeps } from './batches'

/**
 * `api/batches-runs.test.ts` (plan 211 §7.1, G9) — a batch's members are
 * jobs (plan 211 §3.2 decision 3); `POST /:id/rerun` and `POST /:id/
 * rerun-failed` add a RUN to each targeted member job now, never a new
 * job — the job count a batch started with is the job count it keeps,
 * however many times it is rerun.
 */

function setUp(): { db: Db; app: Hono<AuthEnv>; deps: BatchRoutesDeps } {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const db = opened.db
  for (const id of ['d1', 'd2', 'd3']) {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'online' }).run()
  }

  const jobStore = createJobStore(db)
  const runs = createRunStore(db)
  const scheduler: Scheduler = { kick: () => {}, start: () => {}, stop: () => {} }
  const audit = createAuditLogger(db)

  const deps: BatchRoutesDeps = {
    db,
    jobStore,
    runs,
    scheduler,
    audit,
    broadcastBatchStatus: () => {},
    scriptNames: () => new Map(),
    registry: new ExecutorRegistry(),
    findScript: () => ({ enabled: true }),
  }

  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u@test', role: 'operator' })
    await next()
  })
  app.route('/', createBatchRoutes(deps))
  return { db, app, deps }
}

/** A batch of 3 jobs, one per device, through the SAME `createBatch` the actions API and the batch route both call. */
function seedBatch(db: Db, deps: BatchRoutesDeps) {
  const batchDeps: BatchDispatchDeps = { db, runs: deps.runs, scheduler: deps.scheduler, audit: deps.audit, onJobStatus: () => {} }
  const { batch, jobs } = createBatch(batchDeps, {
    scriptId: 'internal:sleep',
    params: {},
    target: { deviceIds: ['d1', 'd2', 'd3'] },
    concurrency: 0,
    order: 'as-listed',
    createdBy: null,
  })
  return { batchId: batch.id, jobs }
}

describe('POST /:id/rerun (plan 211 §3.2 decision 3, G9)', () => {
  test('rerun adds a run to every member job', async () => {
    const { db, app, deps } = setUp()
    const { batchId, jobs } = seedBatch(db, deps)
    expect(jobs).toHaveLength(3)
    for (const j of jobs) expect(deps.runs.getJob(j.id)?.runCount).toBe(1)

    // `/rerun` always targets a named subset (`?only=failed|skipped` — plan
    // 93 §3.12); every member failing is the case where that subset IS
    // every member job, which is exactly what this test names.
    for (const j of jobs) {
      const run = deps.runs.latestRun(j.id)
      if (run) db.update(jobRuns).set({ status: 'failed', failureClass: 'script' }).where(eq(jobRuns.id, run.id)).run()
    }

    const res = await app.request(`/${batchId}/rerun?only=failed`, { method: 'POST' })
    expect(res.status).toBe(201)

    // Still exactly 3 jobs — a rerun never creates a 4th.
    const memberJobs = deps.jobStore.listByBatch(batchId)
    expect(memberJobs).toHaveLength(3)
    for (const j of memberJobs) expect(deps.runs.getJob(j.id)?.runCount).toBe(2)
  })
})

describe('POST /:id/rerun-failed (plan 211 §3.2 decision 3, G9)', () => {
  test('rerun-failed adds a run only to jobs whose latest run failed', async () => {
    const { db, app, deps } = setUp()
    const { batchId, jobs } = seedBatch(db, deps)
    const [j1, j2, j3] = jobs
    // j1 fails, j2 and j3 succeed.
    const run1 = deps.runs.latestRun(j1!.id)!
    db.update(jobRuns).set({ status: 'failed', failureClass: 'script' }).where(eq(jobRuns.id, run1.id)).run()
    for (const j of [j2!, j3!]) {
      const run = deps.runs.latestRun(j.id)!
      db.update(jobRuns).set({ status: 'success' }).where(eq(jobRuns.id, run.id)).run()
    }

    const res = await app.request(`/${batchId}/rerun-failed`, { method: 'POST' })
    expect(res.status).toBe(201)

    // Still exactly 3 jobs.
    const memberJobs = deps.jobStore.listByBatch(batchId)
    expect(memberJobs).toHaveLength(3)
    // Only the failed job gained a run.
    expect(deps.runs.getJob(j1!.id)?.runCount).toBe(2)
    expect(deps.runs.getJob(j2!.id)?.runCount).toBe(1)
    expect(deps.runs.getJob(j3!.id)?.runCount).toBe(1)
  })

  test('a batch with nothing failed or expired refuses with E_NO_TARGETS', async () => {
    const { db, app, deps } = setUp()
    const { batchId, jobs } = seedBatch(db, deps)
    for (const j of jobs) {
      const run = deps.runs.latestRun(j.id)!
      db.update(jobRuns).set({ status: 'success' }).where(eq(jobRuns.id, run.id)).run()
    }

    const res = await app.request(`/${batchId}/rerun-failed`, { method: 'POST' })
    expect(res.status).toBe(409) // E_NO_TARGETS
  })
})
