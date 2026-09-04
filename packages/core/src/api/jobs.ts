import { Hono, type Context } from 'hono'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  JobCancelResponseSchema,
  JobDeleteResponseSchema,
  JobHistoryClearRequestSchema,
  JobHistoryClearResponseSchema,
  JobLogsResponseSchema,
  JobResponseSchema,
  JobRunResponseSchema,
  JobRunsResponseSchema,
  JobStatusSchema,
  JobTraceEventSchema,
  JobTraceResponseSchema,
  JobsPageResponseSchema,
  RunArtifactsResponseSchema,
  type ArtifactInfo,
  type JobTraceEvent,
} from '@enkaku/protocol'
import type { JobLogEntry } from '@enkaku/session'
import { canCancelJob } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { artifacts, jobEvents, jobRuns, jobs } from '../db/schema'
import { deleteJobsWithHistory } from '../jobs/purge'
import { rowToJobRunInfo } from '../queue/job-store'
import type { RunStore } from '../jobs/runs/store'
import type { TraceFrameStore } from '../jobs/trace/frame-store'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = {
  device_not_found: 404,
  job_not_found: 404,
  run_not_found: 404,
  unknown_script: 400,
  invalid_job_params: 400,
  job_not_cancellable: 409,
  device_unavailable: 409,
  device_busy: 409,
  E_BAD_REQUEST: 400,
  'auth.forbidden': 403,
  script_not_found: 404,
  script_version_not_found: 404,
  script_ref_unresolved: 409,
  script_disabled: 409,
  E_RUNTIME_UNSUPPORTED: 400,
  E_RUNTIME_ENVELOPE_INVALID: 400,
  E_RUNTIME_OVER_CEILING: 400,
  job_not_settled: 409,
  E_UNSUPPORTED: 501,
  E_TRACE_CORRUPT: 500,
}

export interface JobRoutesDeps {
  runs: RunStore
  log?: Logger
  /** What a RUNNING run has logged so far, keyed by run id (plan 211). */
  logBuffer?: { get(runId: string): JobLogEntry[]; truncated(runId: string): boolean }
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
  audit?: AuditLogger
  db?: Db
  traceStore?: TraceFrameStore
  dataDir?: string
}

/** Whether a run may be deleted — everything except `queued`/`running` (plan 128 §4.3, plan 211). */
function isSettled(status: string): boolean {
  return status !== 'queued' && status !== 'running'
}

function toTraceEvent(row: typeof jobEvents.$inferSelect): JobTraceEvent {
  const parsed = JobTraceEventSchema.safeParse(row)
  if (!parsed.success) {
    throw new EnkakuError('E_TRACE_CORRUPT', `job_events row ${row.id} does not match JobTraceEventSchema`)
  }
  return parsed.data
}

export function createJobRoutes(service: JobService, deps: JobRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  // `POST /` (the public enqueue) is removed by plan 207 (MVP 07): `run-script`
  // is an actions API verb now (`POST /api/actions/run-script`).

  app.post('/history/clear', requirePermission('job.history.purge'), async (c) => {
    const db = deps.db
    if (!db) throw new EnkakuError('E_UNSUPPORTED', 'clearing job history is not available on this host')
    const raw = (await c.req.json().catch(() => ({}))) ?? {}
    const body = JobHistoryClearRequestSchema.safeParse(raw)
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    }
    const { before, deviceId, status } = body.data
    const filters = [deviceId !== undefined ? eq(jobs.deviceId, deviceId) : undefined].filter((f) => f !== undefined)
    const matched = db
      .select({ id: jobs.id, latestRunId: jobs.latestRunId })
      .from(jobs)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .all()
    const runIds = matched.map((m) => m.latestRunId).filter((id): id is string => id !== null)
    const runsById = new Map(runIds.length > 0 ? db.select().from(jobRuns).where(inArray(jobRuns.id, runIds)).all().map((r) => [r.id, r]) : [])
    const deletable: string[] = []
    let skipped = 0
    for (const row of matched) {
      const run = row.latestRunId ? runsById.get(row.latestRunId) : undefined
      const statusOk = !status || status.length === 0 || (run && status.includes(run.status as (typeof status)[number]))
      const ageOk = before === undefined || (run?.finishedAt ? Math.floor(run.finishedAt.getTime() / 1000) < before : true)
      if (run && isSettled(run.status) && statusOk && ageOk) deletable.push(row.id)
      else if (statusOk) skipped += 1
    }
    const deleted = deleteJobsWithHistory(db, deletable, { dataDir: deps.dataDir, traceStore: deps.traceStore, log: deps.log })
    deps.audit?.record({
      userId: c.get('user')?.id ?? null,
      action: 'job.history.clear',
      target: deviceId ?? 'farm',
      meta: { filter: { before: before ?? null, deviceId: deviceId ?? null, status: status ?? null }, deleted, skipped },
    })
    return typedJson(c, JobHistoryClearResponseSchema, { deleted, skipped })
  })

  app.get('/', (c) => {
    const status = JobStatusSchema.safeParse(c.req.query('status'))
    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const result = service.list({
      deviceId: c.req.query('deviceId') ?? undefined,
      status: status.success ? status.data : undefined,
      kind: c.req.query('kind') ?? undefined,
      rootJobId: c.req.query('rootJobId') ?? undefined,
      parentWorkflowJobId: c.req.query('parentWorkflowJobId') ?? undefined,
      scheduleId: c.req.query('scheduleId') ?? undefined,
      limit,
      cursor: decodeCursor(cursorParam),
    })
    return typedJson(c, JobsPageResponseSchema, {
      items: result.jobs,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor.sortValue, result.nextCursor.id) : null,
      total: result.total,
    })
  })

  app.get('/:id', (c) => {
    const job = service.get(c.req.param('id'))
    if (!job) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    return typedJson(c, JobResponseSchema, { job })
  })

  app.get('/:id/runs', (c) => {
    const job = service.get(c.req.param('id'))
    if (!job) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const items = deps.runs.runs(c.req.param('id')).map(rowToJobRunInfo)
    return typedJson(c, JobRunsResponseSchema, { items, total: items.length })
  })

  function mustGetRun(c: Context<AuthEnv>) {
    const job = service.get(c.req.param('id') ?? '')
    if (!job) throw new EnkakuError('job_not_found', 'no such job')
    const run = deps.runs.getRun(c.req.param('runId') ?? '')
    if (!run || run.jobId !== job.jobId) throw new EnkakuError('run_not_found', 'no such run')
    return { job, run }
  }

  app.get('/:id/runs/:runId', (c) => {
    const { run } = mustGetRun(c)
    const info = rowToJobRunInfo(run)
    return typedJson(c, JobRunResponseSchema, { run: { ...info, result: run.result, resultBytes: run.resultBytes, resultIssues: run.resultIssues as never, resultSchema: null } })
  })

  app.get('/:id/runs/:runId/logs', (c) => {
    const { run } = mustGetRun(c)
    const buf = deps.logBuffer
    return typedJson(c, JobLogsResponseSchema, {
      lines: buf ? buf.get(run.id) : [],
      truncated: buf ? buf.truncated(run.id) : false,
    })
  })

  app.get('/:id/runs/:runId/trace', requirePermission('job.view'), (c) => {
    const { run } = mustGetRun(c)
    const db = deps.db
    if (!db) return typedJson(c, JobTraceResponseSchema, { items: [], nextCursor: null, total: null })

    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const after = decodeCursor(c.req.query('after') ?? cursorParam)
    const kinds: JobTraceEvent['kind'][] = []
    for (const raw of c.req.queries('kind') ?? []) {
      const parsed = JobTraceEventSchema.shape.kind.safeParse(raw)
      if (!parsed.success) throw new EnkakuError('E_BAD_REQUEST', `unknown trace kind "${raw}"`)
      kinds.push(parsed.data)
    }

    const scope = and(eq(jobEvents.runId, run.id), kinds.length > 0 ? inArray(jobEvents.kind, kinds) : undefined)
    const counted = db.select({ n: sql<number>`count(*)` }).from(jobEvents).where(scope).get()
    const rows = db
      .select()
      .from(jobEvents)
      .where(and(scope, keysetWhere(after ? { value: after.sortValue, id: after.id } : null, jobEvents.seq, jobEvents.id, 'asc')))
      .orderBy(asc(jobEvents.seq), asc(jobEvents.id))
      .limit(limit + 1)
      .all()

    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return typedJson(c, JobTraceResponseSchema, {
      items: page.map(toTraceEvent),
      nextCursor: rows.length > limit && last ? encodeCursor(last.seq, last.id) : null,
      total: counted?.n ?? null,
    })
  })

  app.get('/:id/runs/:runId/trace/frames/:hash', requirePermission('job.view'), async (c) => {
    const { run } = mustGetRun(c)
    const bytes = (await deps.traceStore?.readFrame(run.id, c.req.param('hash'))) ?? null
    if (!bytes) return c.json({ error: { code: 'frame_not_found', message: 'no such trace frame' } }, 404)
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'private, immutable' } })
  })

  app.get('/:id/runs/:runId/trace/ui/:hash', requirePermission('job.view'), async (c) => {
    const { run } = mustGetRun(c)
    const node = (await deps.traceStore?.readUiTree(run.id, c.req.param('hash'))) ?? null
    if (!node) return c.json({ error: { code: 'ui_not_found', message: 'no such ui snapshot' } }, 404)
    return c.json(node, 200, { 'cache-control': 'private, immutable' })
  })

  app.get('/:id/runs/:runId/artifacts', requirePermission('job.view'), (c) => {
    const { run } = mustGetRun(c)
    const db = deps.db
    if (!db) return typedJson(c, RunArtifactsResponseSchema, { items: [] })
    const rows = db.select().from(artifacts).where(eq(artifacts.runId, run.id)).all()
    const items: ArtifactInfo[] = rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      deviceId: r.deviceId,
      kind: r.kind as ArtifactInfo['kind'],
      label: r.label,
      path: r.path,
      sizeBytes: r.sizeBytes,
      createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : 0,
    }))
    return typedJson(c, RunArtifactsResponseSchema, { items })
  })

  app.delete('/:id', requirePermission('job.run'), (c) => {
    const id = c.req.param('id')
    const job = service.get(id)
    if (!job) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const user = c.get('user')
    if (user) {
      const device = deps.getDeviceOwner?.(job.deviceId) ?? null
      if (!canCancelJob(user, device)) {
        throw new EnkakuError('auth.forbidden', 'you do not have permission to delete this job')
      }
    }
    const anyUnsettled = job.runs.some((r) => !isSettled(r.status))
    if (anyUnsettled) {
      throw new EnkakuError('job_not_settled', `job ${id} has a run still queued or running — cancel it before deleting it`)
    }
    const db = deps.db
    if (!db) throw new EnkakuError('E_UNSUPPORTED', 'deleting a job is not available on this host')
    const deleted = deleteJobsWithHistory(db, [id], { dataDir: deps.dataDir, traceStore: deps.traceStore, log: deps.log })
    deps.audit?.record({ userId: user?.id ?? null, action: 'job.delete', target: id, meta: { deviceId: job.deviceId, deleted } })
    return typedJson(c, JobDeleteResponseSchema, { jobId: id, deleted })
  })

  app.post('/:id/cancel', (c) => {
    const jobId = c.req.param('id')
    const job = service.get(jobId)
    if (!job) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const user = c.get('user')
    if (user) {
      const device = deps.getDeviceOwner?.(job.deviceId) ?? null
      if (!canCancelJob(user, device)) {
        throw new EnkakuError('auth.forbidden', 'you do not have permission to cancel this job')
      }
    }
    const cancelDescendants = ['1', 'true'].includes(c.req.query('cancelDescendants') ?? '')
    const result = service.cancel(jobId, { cancelDescendants })
    deps.audit?.record({
      userId: user?.id ?? null,
      action: 'job.cancel',
      target: jobId,
      meta: { deviceId: job.deviceId, cancelledDescendants: result.cancelledDescendants },
    })
    return typedJson(c, JobCancelResponseSchema, result)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    }
    throw err
  })

  return app
}
