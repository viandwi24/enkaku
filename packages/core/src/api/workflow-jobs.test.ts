import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { createRunStore } from '../jobs/runs/store'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobRuns, workflowSteps } from '../db/schema'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createJobService } from '../services/job-service'
import type { AuthEnv } from '../auth/middleware'
import { createWorkflowJobRoutes } from './workflow-jobs'

/**
 * `api/workflow-jobs.test.ts` (plan 211 §7.1, G11) — the workflow job's own
 * step timeline (`GET /:id/runs/:runId/steps`) and resuming a settled run
 * (`POST /:id/resume`), against a real `JobStore`/`RunStore`/`JobService`
 * (an in-memory db) rather than a hand-rolled fake — this route's own logic
 * IS the join between `jobService.get()`'s `JobDetail` and `workflow_steps`,
 * so faking either would test the mock, not the route.
 */

function setUp(): { db: Db; app: Hono<AuthEnv> } {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const db = opened.db
  db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'online' }).run()

  const jobStore = createJobStore(db)
  const runs = createRunStore(db)
  const scheduler: Scheduler = { kick: () => {}, start: () => {}, stop: () => {} }
  const host: ExecutorHost = {
    start: () => {},
    abort: () => false,
    isRunning: () => false,
    finishExternally: () => {},
    notifyCrash: () => false,
    progress: () => {},
    stopAll: () => {},
  }
  const jobService = createJobService({ jobStore, runs, registry: new ExecutorRegistry(), scheduler, host, log: { debug() {}, info() {}, warn() {}, error() {}, child: () => null as never }, onJobStatus: () => {} })

  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u@test', role: 'operator' })
    await next()
  })
  app.route('/', createWorkflowJobRoutes({ db, runs, jobService, scheduler }))
  return { db, app }
}

describe('GET /:id/runs/:runId/steps', () => {
  test('lists steps in seq order and reports finalized once the run settles', async () => {
    const { db, app } = setUp()
    const runs = createRunStore(db)
    const job = runs.createJob({ kind: 'workflow', workflowName: 'wf', deviceId: 'd1', params: null, scriptName: null, scriptVersion: null, batchId: null, batchSeq: null })
    const run = runs.addRun(job.id, { trigger: 'manual' })
    db.insert(workflowSteps).values({ id: 's2', runId: run.id, seq: 1, stepId: 'step-b', kind: 'script', status: 'success' }).run()
    db.insert(workflowSteps).values({ id: 's1', runId: run.id, seq: 0, stepId: 'step-a', kind: 'script', status: 'success' }).run()
    // `settle` only ever touches a `running` row (`RunStore`'s own doc
    // comment) — `addRun` leaves a fresh run `queued`.
    db.update(jobRuns).set({ status: 'running' }).where(eq(jobRuns.id, run.id)).run()
    runs.settle(run.id, { status: 'success' })

    const res = await app.request(`/${job.id}/runs/${run.id}/steps`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { stepId: string; seq: number }[]; finalized: boolean }
    expect(body.items.map((s) => s.stepId)).toEqual(['step-a', 'step-b'])
    expect(body.finalized).toBe(true)
  })

  test('a non-workflow (script) job answers 404', async () => {
    const { db, app } = setUp()
    const runs = createRunStore(db)
    const job = runs.createJob({ kind: 'script', scriptId: 'internal:sleep', deviceId: 'd1', params: null, scriptName: null, scriptVersion: null, batchId: null, batchSeq: null })
    const run = runs.addRun(job.id, { trigger: 'manual' })

    const res = await app.request(`/${job.id}/runs/${run.id}/steps`)
    expect(res.status).toBe(404)
  })
})

describe('POST /:id/resume (plan 211 §4.8, G11)', () => {
  test('resume adds a run with trigger resume and answers 201', async () => {
    const { db, app } = setUp()
    const runs = createRunStore(db)
    const job = runs.createJob({ kind: 'workflow', workflowName: 'wf', deviceId: 'd1', params: null, scriptName: null, scriptVersion: null, batchId: null, batchSeq: null })
    const run = runs.addRun(job.id, { trigger: 'manual' })
    db.insert(workflowSteps).values({ id: 's1', runId: run.id, seq: 0, stepId: 'step-a', kind: 'script', status: 'success' }).run()
    db.insert(workflowSteps).values({ id: 's2', runId: run.id, seq: 1, stepId: 'step-b', kind: 'script', status: 'failed', error: 'boom' }).run()
    db.update(jobRuns).set({ status: 'running' }).where(eq(jobRuns.id, run.id)).run()
    runs.settle(run.id, { status: 'failed', error: 'boom' })

    const res = await app.request(`/${job.id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { runId: string; resumedFromRunId: string; resumedFromStep: number }
    expect(body.resumedFromRunId).toBe(run.id)
    // No `fromStep` in the body — defaults to the first step that did not succeed.
    expect(body.resumedFromStep).toBe(1)

    const newRun = runs.getRun(body.runId)
    expect(newRun?.trigger).toBe('resume')
    expect(newRun?.resumedFromRunId).toBe(run.id)
    const job2 = runs.getJob(job.id)
    expect(job2?.runCount).toBe(2)
  })

  test('resuming a still-running workflow job is refused (job_not_terminal)', async () => {
    const { db, app } = setUp()
    const runs = createRunStore(db)
    const job = runs.createJob({ kind: 'workflow', workflowName: 'wf', deviceId: 'd1', params: null, scriptName: null, scriptVersion: null, batchId: null, batchSeq: null })
    runs.addRun(job.id, { trigger: 'manual' }) // left 'queued' — not terminal either

    const res = await app.request(`/${job.id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(409)
  })

  test('the old POST /api/jobs/:id/resume path is gone (plan 211 G11 — the route lives only under /api/workflow-jobs now)', async () => {
    // `createJobRoutes` (api/jobs.ts) mounts no `/:id/resume` handler at all
    // any more — proven directly against the source, not a live route,
    // since this suite mounts `workflow-jobs.ts`'s routes alone.
    const source = await Bun.file(new URL('./jobs.ts', import.meta.url)).text()
    expect(source).not.toMatch(/'\/:id\/resume'/)
  })
})
