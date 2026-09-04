import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { WorkflowResumeRequestSchema, WorkflowResumeResponseSchema, WorkflowStepsResponseSchema, type WorkflowStepInfo } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { workflowSteps } from '../db/schema'
import type { RunStore } from '../jobs/runs/store'
import type { Scheduler } from '../queue/scheduler'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = {
  job_not_found: 404,
  run_not_found: 404,
  job_not_terminal: 409,
  step_not_found: 400,
  'auth.forbidden': 403,
}

function rowToStepInfo(row: typeof workflowSteps.$inferSelect): WorkflowStepInfo {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    stepId: row.stepId,
    kind: row.kind,
    jobId: row.jobId,
    jobRunId: row.jobRunId,
    status: row.status as WorkflowStepInfo['status'],
    startedAt: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : null,
    finishedAt: row.finishedAt ? Math.floor(row.finishedAt.getTime() / 1000) : null,
    input: row.input ?? null,
    output: row.output ?? null,
    outputTruncated: row.outputTruncated,
    takenEdge: row.takenEdge,
    pinned: row.pinned,
    verdict: row.verdict ?? null,
    error: row.error,
    errorCode: row.errorCode,
  }
}

const TERMINAL_RUN_STATUSES = new Set(['success', 'failed', 'cancelled', 'expired'])

/**
 * `GET /api/workflow-jobs/:id/runs/:runId/steps` and `POST /:id/resume`
 * (plan 211 §4.5, §4.8) — the workflow job's own step timeline, and resuming
 * a settled workflow run at an earlier step.
 */
export function createWorkflowJobRoutes(deps: { db: Db; runs: RunStore; jobService: JobService; scheduler: Scheduler }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.get('/:id/runs/:runId/steps', requirePermission('job.view'), (c) => {
    const job = deps.jobService.get(c.req.param('id'))
    if (!job || job.kind !== 'workflow') throw new EnkakuError('job_not_found', 'no such workflow job')
    const run = deps.runs.getRun(c.req.param('runId'))
    if (!run || run.jobId !== job.jobId) throw new EnkakuError('run_not_found', 'no such run')
    const rows = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id)).all().sort((a, b) => a.seq - b.seq)
    const finalized = TERMINAL_RUN_STATUSES.has(run.status)
    return typedJson(c, WorkflowStepsResponseSchema, { items: rows.map(rowToStepInfo), finalized })
  })

  app.post('/:id/resume', requirePermission('job.run'), async (c) => {
    const job = deps.jobService.get(c.req.param('id'))
    if (!job || job.kind !== 'workflow') throw new EnkakuError('job_not_found', 'no such workflow job')
    const latestRun = job.runs[0]
    if (!latestRun || !TERMINAL_RUN_STATUSES.has(latestRun.status)) {
      throw new EnkakuError('job_not_terminal', `job ${job.jobId} is still running — resume only a workflow that has settled`)
    }
    const body = WorkflowResumeRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'invalid resume body')

    let fromStep = body.data.fromStep
    if (fromStep === undefined) {
      const steps = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, latestRun.runId)).all().sort((a, b) => a.seq - b.seq)
      const firstNotSucceeded = steps.find((s) => s.status !== 'success' && s.status !== 'carried-over')
      fromStep = firstNotSucceeded?.seq ?? 0
    } else {
      const exists = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, latestRun.runId)).all().some((s) => s.seq === fromStep)
      if (!exists) throw new EnkakuError('step_not_found', `step ${fromStep} never ran in run ${latestRun.runId}`)
    }

    const resumed = deps.runs.addRun(job.jobId, {
      trigger: 'resume',
      resumedFromRunId: latestRun.runId,
      resumedFromStep: fromStep,
    })
    deps.scheduler.kick()
    const refreshed = deps.jobService.get(job.jobId)
    if (!refreshed) throw new EnkakuError('job_not_found', 'job disappeared mid-resume')
    return typedJson(
      c,
      WorkflowResumeResponseSchema,
      { job: refreshed, runId: resumed.id, resumedFromRunId: latestRun.runId, resumedFromStep: fromStep },
      201,
    )
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
