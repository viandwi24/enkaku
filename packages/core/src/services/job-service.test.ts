import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobRuns } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { createRunStore, type RunStore } from '../jobs/runs/store'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createJobService, type JobService } from './job-service'

/**
 * `JobService.cancel`'s cascade and `cancelMany` — against a real in-memory
 * `JobStore`/`RunStore`, with a host that only records which runs it was asked
 * to abort (the host's own escalation is `jobs/executor-host.test.ts`'s).
 */

interface Harness {
  db: Db
  runs: RunStore
  service: JobService
  /** Every run id `host.abort` was called with, in order. */
  aborted: string[]
  /** Every run id the watcher was told settled. */
  notified: string[]
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
  const notified: string[] = []
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
  const service = createJobService({
    jobStore,
    runs,
    registry: new ExecutorRegistry(),
    scheduler,
    host,
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => null as never },
    onJobStatus: () => {},
    watcher: { notify: (run) => notified.push(run.id) },
  })
  return { db, runs, service, aborted, notified }
}

interface Lineage {
  kind?: 'script' | 'workflow'
  deviceId?: string
  parentWorkflowJobId?: string
  triggeredByJobId?: string
  rootJobId?: string
  depth?: number
}

function makeJob(h: Harness, status: 'queued' | 'running' | 'success', lineage: Lineage = {}): { jobId: string; runId: string } {
  const common = { deviceId: lineage.deviceId ?? 'd1', params: null, scriptName: null, scriptVersion: null }
  const job =
    lineage.kind === 'workflow'
      ? h.runs.createJob({ kind: 'workflow', workflowName: 'wf', ...common })
      : h.runs.createJob({
          kind: 'script',
          scriptId: 'internal:sleep',
          ...common,
          parentWorkflowJobId: lineage.parentWorkflowJobId ?? null,
          stepSeq: lineage.parentWorkflowJobId ? 0 : null,
          triggeredByJobId: lineage.triggeredByJobId ?? null,
          rootJobId: lineage.rootJobId ?? null,
          depth: lineage.depth ?? 0,
        })
  const run = h.runs.addRun(job.id, { trigger: 'manual' })
  if (status !== 'queued') h.db.update(jobRuns).set({ status }).where(eq(jobRuns.id, run.id)).run()
  return { jobId: job.id, runId: run.id }
}

describe('JobService.cancel — a workflow job takes its steps with it', () => {
  test('by default a workflow cascades: the workflow run and its running step are both aborted', () => {
    const h = setUp()
    const wf = makeJob(h, 'running', { kind: 'workflow' })
    const step = makeJob(h, 'running', { parentWorkflowJobId: wf.jobId })

    const result = h.service.cancel(wf.jobId)

    // The workflow first — its own abort is what stops the orchestrator
    // enqueuing another step — then the step.
    expect(h.aborted).toEqual([wf.runId, step.runId])
    expect(result.cancelledDescendants).toBe(1)
  })

  test('a step still queued is cancelled, and the watcher hears so a waiting workflow is not left hanging', () => {
    const h = setUp()
    const wf = makeJob(h, 'running', { kind: 'workflow' })
    const step = makeJob(h, 'queued', { parentWorkflowJobId: wf.jobId })

    const result = h.service.cancel(wf.jobId)

    expect(h.runs.getRun(step.runId)?.status).toBe('cancelled')
    expect(h.notified).toContain(step.runId)
    expect(result.cancelledDescendants).toBe(1)
  })

  test('cancelDescendants: false leaves the steps alone', () => {
    const h = setUp()
    const wf = makeJob(h, 'running', { kind: 'workflow' })
    const step = makeJob(h, 'queued', { parentWorkflowJobId: wf.jobId })

    const result = h.service.cancel(wf.jobId, { cancelDescendants: false })

    expect(h.aborted).toEqual([wf.runId])
    expect(h.runs.getRun(step.runId)?.status).toBe('queued')
    expect(result.cancelledDescendants).toBe(0)
  })

  test('cancelRun on a queued step notifies the watcher too', () => {
    const h = setUp()
    const wf = makeJob(h, 'running', { kind: 'workflow' })
    const step = makeJob(h, 'queued', { parentWorkflowJobId: wf.jobId })

    h.service.cancelRun(step.runId)

    expect(h.runs.getRun(step.runId)?.status).toBe('cancelled')
    expect(h.notified).toEqual([step.runId])
  })
})

describe('JobService.cancel — triggered jobs (plan 81 §4.4)', () => {
  test('a script job does not cascade unless asked; asked, it reaches triggered jobs at any depth', () => {
    const h = setUp()
    const root = makeJob(h, 'running')
    const child = makeJob(h, 'queued', { triggeredByJobId: root.jobId, rootJobId: root.jobId, depth: 1 })
    const grandchild = makeJob(h, 'queued', { triggeredByJobId: child.jobId, rootJobId: root.jobId, depth: 2 })

    expect(h.service.cancel(root.jobId).cancelledDescendants).toBe(0)
    expect(h.runs.getRun(child.runId)?.status).toBe('queued')

    const result = h.service.cancel(root.jobId, { cancelDescendants: true })
    expect(result.cancelledDescendants).toBe(2)
    expect(h.runs.getRun(child.runId)?.status).toBe('cancelled')
    expect(h.runs.getRun(grandchild.runId)?.status).toBe('cancelled')
  })

  test('a settled job whose cascade still finds active descendants is not an error; with none left it is job_not_cancellable', () => {
    const h = setUp()
    const root = makeJob(h, 'success')
    makeJob(h, 'queued', { triggeredByJobId: root.jobId, rootJobId: root.jobId, depth: 1 })

    expect(h.service.cancel(root.jobId, { cancelDescendants: true }).cancelledDescendants).toBe(1)
    expect(() => h.service.cancel(root.jobId, { cancelDescendants: true })).toThrow('the run is success')
  })

  test('a settled script job with no cascade is still job_not_cancellable', () => {
    const h = setUp()
    const done = makeJob(h, 'success')
    expect(() => h.service.cancel(done.jobId)).toThrow('the run is success')
  })
})

describe('JobService.cancelMany', () => {
  test('parents first, each job counted once, and every job lands in exactly one bucket', () => {
    const h = setUp()
    const wf = makeJob(h, 'running', { kind: 'workflow' })
    const step = makeJob(h, 'running', { parentWorkflowJobId: wf.jobId })
    const queued = makeJob(h, 'queued')
    const settled = makeJob(h, 'success')
    const elsewhere = makeJob(h, 'queued', { deviceId: 'd2' })

    // The step is named BEFORE its workflow: the sort still stops the
    // workflow first, and the step is stopped once, through the cascade.
    const result = h.service.cancelMany({
      jobIds: [step.jobId, 'no-such-job', settled.jobId, queued.jobId, wf.jobId, elsewhere.jobId],
      canCancel: (job) => job.deviceId !== 'd2',
    })

    expect(result.matched).toBe(6)
    expect(result.abortedJobIds.sort()).toEqual([wf.jobId, step.jobId].sort())
    expect(result.aborted).toBe(2)
    expect(result.descendants).toBe(1)
    expect(result.cancelledJobIds).toEqual([queued.jobId])
    expect(result.refusedJobIds).toEqual([elsewhere.jobId])
    expect(result.notCancellableJobIds.sort()).toEqual(['no-such-job', settled.jobId].sort())
    expect(h.aborted.filter((id) => id === step.runId)).toHaveLength(1)
    expect(h.runs.getRun(elsewhere.runId)?.status).toBe('queued')
  })

  test('resolveCancelFilter narrows by device and by latest-run status', () => {
    const h = setUp()
    const queued = makeJob(h, 'queued')
    const running = makeJob(h, 'running')
    makeJob(h, 'success')
    makeJob(h, 'queued', { deviceId: 'd2' })

    expect(h.service.resolveCancelFilter({ status: 'queued', deviceId: 'd1' }).jobIds).toEqual([queued.jobId])
    const active = h.service.resolveCancelFilter({ status: 'active', deviceId: 'd1' })
    expect(active.jobIds.sort()).toEqual([queued.jobId, running.jobId].sort())
    expect(active.matched).toBe(2)
    expect(active.truncated).toBe(false)
    expect(h.service.resolveCancelFilter({ status: 'active' }).matched).toBe(3)
  })
})
