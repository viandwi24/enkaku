import { join, normalize } from 'node:path'
import { Hono, type Context } from 'hono'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  defaultFarmSettings,
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
import { artifacts, devices, jobEvents, jobRuns, jobs } from '../db/schema'
import { deleteJobsWithHistory } from '../jobs/purge'
import { buildRunExportEntries, exportFileName, MAX_EXPORT_EVENTS, type ExportArtifact } from '../jobs/trace/export'
import { rowToJobRunInfo } from '../queue/job-store'
import type { RunStore } from '../jobs/runs/store'
import type { TraceFrameStore } from '../jobs/trace/frame-store'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'
import { createZipStream, ZipTooLargeError } from './zip-stream'

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
  E_TRANSFER_TOO_LARGE: 413,
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
  /**
   * The archive ceiling `GET /:id/runs/:runId/export.zip` refuses above,
   * read live so a settings change applies to the next download. The SAME
   * `transfer.maxArchiveBytes` the batch bulk-pull archive already uses —
   * one farm-wide answer to "how big may a zip this server builds get",
   * not a second knob meaning almost the same thing.
   */
  archiveSettings?: () => { maxArchiveBytes: number }
}

/** A trace content address as it appears in a filename: 64 lowercase hex digits, the same shape `frame-store.ts` enforces on its own side. */
const TRACE_HASH_RE = /^[0-9a-f]{64}$/

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
      // `excludeKind=workflow` is what lets the Jobs tab stop mixing pipelines
      // in with the scripts they ran (owner, 2026-09-05). Exclusion rather
      // than `kind=script`, so a kind added later still shows up on the list
      // that means "everything else" instead of silently disappearing.
      excludeKind: c.req.query('excludeKind') ?? undefined,
      rootJobId: c.req.query('rootJobId') ?? undefined,
      parentWorkflowJobId: c.req.query('parentWorkflowJobId') ?? undefined,
      scheduleId: c.req.query('scheduleId') ?? undefined,
      // A `simulate` run never touched a device (plan 309 §3.4, G4) — off
      // the list by default, shown only when a caller asks explicitly.
      includeSimulate: ['1', 'true'].includes(c.req.query('includeSimulate') ?? ''),
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
      pinned: r.pinned,
    }))
    return typedJson(c, RunArtifactsResponseSchema, { items })
  })

  /**
   * `GET /:id/runs/:runId/export.zip` — one run's whole debug story as a zip
   * somebody outside this farm can open: the timeline as prose and as data,
   * the logs, the input and output, every captured frame and UI tree, and
   * every artifact the run saved. `jobs/trace/export.ts` decides the layout
   * and writes the README that explains it; this handler's job is only to
   * gather the four sources and hand them over.
   *
   * `job.view`, the same gate the trace and artifact reads beside it already
   * use: a bundle is a read of data those routes already serve one piece at
   * a time, never a new door onto it.
   *
   * Two orderings here are load-bearing:
   *
   * 1. **The size refusal happens inside `createZipStream`, before this
   *    handler writes a byte** — `zip-stream.ts`'s own module doc explains
   *    why (once a status line is sent there is no turning it into a 413).
   * 2. **Every capture is opened lazily, one at a time, by the zip writer.**
   *    A run with two hundred frames streams in ~one frame of memory. Nothing
   *    below may read a frame, a UI tree or an artifact eagerly to "check" it.
   */
  app.get('/:id/runs/:runId/export.zip', requirePermission('job.view'), (c) => {
    const { job, run } = mustGetRun(c)
    const db = deps.db
    if (!db) throw new EnkakuError('E_UNSUPPORTED', 'exporting a run is not available on this host')

    // One page past the ceiling, so "there were more" is known rather than
    // guessed from a full page (the same +1 trick every keyset route here uses).
    const rows = db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.runId, run.id))
      .orderBy(asc(jobEvents.seq), asc(jobEvents.id))
      .limit(MAX_EXPORT_EVENTS + 1)
      .all()
    const eventsTruncated = rows.length > MAX_EXPORT_EVENTS
    const events = (eventsTruncated ? rows.slice(0, MAX_EXPORT_EVENTS) : rows).map(toTraceEvent)

    const dataDir = deps.dataDir
    const exported: ExportArtifact[] = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, run.id))
      .all()
      .map((r) => {
        const info: ArtifactInfo = {
          id: r.id,
          runId: r.runId,
          deviceId: r.deviceId,
          kind: r.kind as ArtifactInfo['kind'],
          label: r.label,
          path: r.path,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : 0,
          pinned: r.pinned,
        }
        // Defence in depth against a stored path escaping app-data, mirroring
        // `api/artifacts.ts`'s `/:id/content` and `api/batches.ts`'s archive:
        // a download route is where a future regression in whoever writes
        // these rows would first become exploitable. A refused or vanished
        // file is recorded as missing (the manifest and README both say so),
        // never silently dropped.
        const rel = normalize(r.path)
        if (!dataDir || rel.startsWith('..')) return { info, abs: null, sizeBytes: 0 }
        const file = Bun.file(join(dataDir, rel))
        return file.size > 0 ? { info, abs: join(dataDir, rel), sizeBytes: file.size } : { info, abs: null, sizeBytes: 0 }
      })

    // The trace is the PERSISTED log record and the one a settled run always
    // has. The live buffer is the fallback for a run whose trace holds no log
    // events at all — a workflow job, or a host with no tee wired. Which one
    // was used is written into the bundle rather than left for the reader to
    // infer from a suspiciously short file.
    const traceLogs = events
      .filter((e) => e.kind === 'log')
      .map((e) => ({
        ts: e.atMs,
        level: e.name,
        source: typeof e.meta?.source === 'string' ? e.meta.source : 'script',
        msg: typeof e.meta?.msg === 'string' ? e.meta.msg : '',
        ...(e.meta?.fields !== undefined ? { fields: e.meta.fields } : {}),
      }))
    const buffered = traceLogs.length === 0 ? (deps.logBuffer?.get(run.id) ?? []) : []
    const logs =
      traceLogs.length > 0
        ? { lines: traceLogs, source: 'trace' as const }
        : buffered.length > 0
          ? { lines: buffered.map((l) => ({ ts: l.ts, level: l.level, source: l.source, msg: l.msg, ...(l.fields ? { fields: l.fields } : {}) })), source: 'buffer' as const }
          : { lines: [], source: 'none' as const }

    const device = db.select({ label: devices.label }).from(devices).where(eq(devices.id, run.deviceId)).get()
    const traceStore = deps.traceStore
    // `runDir` validates the run id; the hash comes off a `job_events` row and
    // is re-checked here anyway, because this is the one place a path is built
    // from it without `frame-store.ts`'s own guards in the way.
    const traceDir = traceStore ? traceStore.runDir(run.id) : null
    const capturePath = (hash: string, ext: string): string | null =>
      traceDir && TRACE_HASH_RE.test(hash) ? join(traceDir, `${hash}.${ext}`) : null

    const runInfo = rowToJobRunInfo(run)
    const entries = buildRunExportEntries({
      job,
      run: runInfo,
      result: { value: run.result, bytes: run.resultBytes, status: run.resultStatus ?? null, issues: run.resultIssues },
      events,
      eventsTruncated,
      artifacts: exported,
      logs,
      deviceLabel: device?.label ?? null,
      openFrame: (hash) => {
        const abs = capturePath(hash, 'png')
        if (!abs) return null
        const file = Bun.file(abs)
        return file.size > 0 ? { size: file.size, stream: () => file.stream() } : null
      },
      readUiTree: async (hash) => (traceStore ? await traceStore.readUiTree(run.id, hash) : null),
      uiTreeSize: (hash) => {
        const abs = capturePath(hash, 'json.gz')
        return abs ? Bun.file(abs).size : 0
      },
    })

    // Falls back to the SCHEMA's default rather than to no cap at all, the
    // same way `api/batches.ts`'s archive route does: a host that has not
    // wired `archiveSettings` should build a bounded zip, not an unbounded one.
    const maxTotalBytes = deps.archiveSettings?.().maxArchiveBytes ?? defaultFarmSettings().advanced.transferCaps.maxArchiveBytes
    let stream: ReadableStream<Uint8Array>
    try {
      stream = createZipStream(entries, { maxTotalBytes })
    } catch (err) {
      if (err instanceof ZipTooLargeError) throw new EnkakuError('E_TRANSFER_TOO_LARGE', err.message)
      throw err
    }
    deps.audit?.record({
      userId: c.get('user')?.id ?? null,
      action: 'job.run.export',
      target: run.id,
      meta: { jobId: job.jobId, runSeq: run.seq, events: events.length, artifacts: exported.length, truncated: eventsTruncated },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${exportFileName(job, runInfo)}"`,
      },
    })
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
