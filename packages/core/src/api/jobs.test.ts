import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { JobBulkCancelResponseSchema, JobCancelResponseSchema } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobRuns } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { createRunStore, type RunStore } from '../jobs/runs/store'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createJobService } from '../services/job-service'
import { createJobRoutes } from './jobs'

/**
 * `api/jobs.ts`'s cancel routes: `POST /cancel` (the bulk stop) and
 * `POST /:id/cancel`'s workflow default — against a real `JobStore`/
 * `RunStore`/`JobService`, an operator who owns nothing, one device anyone
 * may use (d1) and one owned by somebody else (d2).
 */

interface Harness {
  db: Db
  runs: RunStore
  app: Hono<AuthEnv>
  aborted: string[]
  audits: Array<{ action: string; target?: string; meta?: unknown }>
}

function setUp(): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const db = opened.db
  db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'online' }).run()
  db.insert(devices).values({ id: 'd2', stableId: 'stable-d2', serial: 'serial-d2', label: 'd2', status: 'online', ownerId: 'someone-else' }).run()

  const jobStore = createJobStore(db)
  const runs = createRunStore(db)
  const scheduler: Scheduler = { kick: () => {}, start: () => {}, stop: () => {} }
  const aborted: string[] = []
  const host: ExecutorHost = {
    start: () => {},
    abort: (runId) => {
      aborted.push(runId)
      return true
    },
    isRunning: () => true,
    listRunning: () => [],
    finishExternally: () => {},
    notifyCrash: () => false,
    progress: () => {},
    stopAll: () => {},
  }
  const jobService = createJobService({ jobStore, runs, registry: new ExecutorRegistry(), scheduler, host, log: { debug() {}, info() {}, warn() {}, error() {}, child: () => null as never }, onJobStatus: () => {} })
  const audits: Harness['audits'] = []
  const audit = { record: (entry: { action: string; target?: string; meta?: unknown }) => audits.push(entry), list: () => [] } as unknown as AuditLogger
  const getDeviceOwner = (id: string) => db.select({ ownerId: devices.ownerId }).from(devices).where(eq(devices.id, id)).get() ?? null

  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u@test', role: 'operator' })
    await next()
  })
  app.route('/', createJobRoutes(jobService, { runs, getDeviceOwner, audit }))
  return { db, runs, app, aborted, audits }
}

function makeJob(h: Harness, status: 'queued' | 'running' | 'success', opts: { deviceId?: string; kind?: 'workflow'; parentWorkflowJobId?: string } = {}) {
  const common = { deviceId: opts.deviceId ?? 'd1', params: null, scriptName: null, scriptVersion: null }
  const job =
    opts.kind === 'workflow'
      ? h.runs.createJob({ kind: 'workflow', workflowName: 'wf', ...common })
      : h.runs.createJob({ kind: 'script', scriptId: 'internal:sleep', ...common, parentWorkflowJobId: opts.parentWorkflowJobId ?? null, stepSeq: opts.parentWorkflowJobId ? 0 : null })
  const run = h.runs.addRun(job.id, { trigger: 'manual' })
  if (status !== 'queued') h.db.update(jobRuns).set({ status }).where(eq(jobRuns.id, run.id)).run()
  return { jobId: job.id, runId: run.id }
}

const post = (app: Hono<AuthEnv>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('POST /cancel — { jobIds }', () => {
  test('cancels queued, aborts running, refuses a job on a device the operator cannot use, and audits once', async () => {
    const h = setUp()
    const queued = makeJob(h, 'queued')
    const running = makeJob(h, 'running')
    const elsewhere = makeJob(h, 'queued', { deviceId: 'd2' })
    const done = makeJob(h, 'success')

    const res = await post(h.app, '/cancel', { jobIds: [queued.jobId, running.jobId, elsewhere.jobId, done.jobId] })
    expect(res.status).toBe(200)
    const body = JobBulkCancelResponseSchema.parse(await res.json())
    expect(body.cancelledJobIds).toEqual([queued.jobId])
    expect(body.abortedJobIds).toEqual([running.jobId])
    expect(body.refusedJobIds).toEqual([elsewhere.jobId])
    expect(body.notCancellableJobIds).toEqual([done.jobId])
    expect(body.matched).toBe(4)

    expect(h.runs.getRun(queued.runId)?.status).toBe('cancelled')
    expect(h.runs.getRun(elsewhere.runId)?.status).toBe('queued')
    expect(h.aborted).toEqual([running.runId])
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]?.action).toBe('job.cancel.bulk')
    expect(h.audits[0]?.target).toBe('selection')
  })
})

describe('POST /cancel — { filter }', () => {
  test('status: queued on one device leaves its running job and every other device alone', async () => {
    const h = setUp()
    const queued = makeJob(h, 'queued')
    makeJob(h, 'running')
    const other = makeJob(h, 'queued', { deviceId: 'd2' })

    const res = await post(h.app, '/cancel', { filter: { deviceId: 'd1', status: 'queued' } })
    expect(res.status).toBe(200)
    const body = JobBulkCancelResponseSchema.parse(await res.json())
    expect(body.cancelledJobIds).toEqual([queued.jobId])
    expect(body.aborted).toBe(0)
    expect(h.aborted).toEqual([])
    expect(h.runs.getRun(other.runId)?.status).toBe('queued')
    expect(h.audits[0]?.target).toBe('d1')
  })

  test('an empty filter means every active job on the farm, still gated per job', async () => {
    const h = setUp()
    makeJob(h, 'queued')
    makeJob(h, 'running')
    makeJob(h, 'queued', { deviceId: 'd2' })

    const body = JobBulkCancelResponseSchema.parse(await (await post(h.app, '/cancel', { filter: {} })).json())
    expect(body.matched).toBe(3)
    expect(body.cancelled).toBe(1)
    expect(body.aborted).toBe(1)
    expect(body.refused).toBe(1)
    expect(h.audits[0]?.target).toBe('farm')
  })

  test('a workflow in the filter takes its steps with it, counted once', async () => {
    const h = setUp()
    const wf = makeJob(h, 'running', { kind: 'workflow' })
    const step = makeJob(h, 'running', { parentWorkflowJobId: wf.jobId })

    const body = JobBulkCancelResponseSchema.parse(await (await post(h.app, '/cancel', { filter: { deviceId: 'd1' } })).json())
    expect(body.aborted).toBe(2)
    expect(body.descendants).toBe(1)
    expect(h.aborted).toEqual([wf.runId, step.runId])
  })
})

describe('POST /cancel — a malformed body is 400, never a guess', () => {
  const bodies: Array<[string, unknown]> = [
    ['an empty object', {}],
    ['both forms at once', { jobIds: ['a'], filter: {} }],
    ['an empty selection', { jobIds: [] }],
    ['more ids than one request may name', { jobIds: Array.from({ length: 501 }, (_, i) => `job-${i}`) }],
    ['an unknown filter key', { filter: { colour: 'red' } }],
    ['a status a cancel cannot act on', { filter: { status: 'failed' } }],
    ['not JSON at all', 'not json'],
  ]
  for (const [name, body] of bodies) {
    test(name, async () => {
      const h = setUp()
      const res = await post(h.app, '/cancel', body)
      expect(res.status).toBe(400)
      expect(h.audits).toHaveLength(0)
    })
  }
})

describe('POST /:id/cancel — a workflow job cascades unless told not to', () => {
  test('no query: the step is cancelled too', async () => {
    const h = setUp()
    const wf = makeJob(h, 'running', { kind: 'workflow' })
    const step = makeJob(h, 'queued', { parentWorkflowJobId: wf.jobId })

    const res = await h.app.request(`/${wf.jobId}/cancel`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(JobCancelResponseSchema.parse(await res.json()).cancelledDescendants).toBe(1)
    expect(h.runs.getRun(step.runId)?.status).toBe('cancelled')
  })

  test('?cancelDescendants=0 leaves the step queued', async () => {
    const h = setUp()
    const wf = makeJob(h, 'running', { kind: 'workflow' })
    const step = makeJob(h, 'queued', { parentWorkflowJobId: wf.jobId })

    const res = await h.app.request(`/${wf.jobId}/cancel?cancelDescendants=0`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(JobCancelResponseSchema.parse(await res.json()).cancelledDescendants).toBe(0)
    expect(h.runs.getRun(step.runId)?.status).toBe('queued')
  })
})
