import { Hono } from 'hono'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  JobCancelResponseSchema,
  JobCreateResponseSchema,
  JobDeleteResponseSchema,
  JobHistoryClearRequestSchema,
  JobHistoryClearResponseSchema,
  JobLogsResponseSchema,
  JobNodesResponseSchema,
  JobResponseSchema,
  JobStatusSchema,
  JobTraceEventSchema,
  JobTraceResponseSchema,
  JobsPageResponseSchema,
  type JobStatus,
  type JobTraceEvent,
} from '@enkaku/protocol'
import type { JobLogEntry } from '@enkaku/session'
import { z } from 'zod'
import { canCancelJob } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { jobEvents, jobs } from '../db/schema'
import { deleteJobsWithHistory } from '../jobs/purge'
import type { TraceFrameStore } from '../jobs/trace/frame-store'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

/**
 * `POST /:id/resume` (plan 99 §3.5, §4.9, step 99.8). `fromNode` omitted
 * means "the last node this job actually attempted, if it did not succeed"
 * — `JobService.resume`'s own `defaultResumeNode` names exactly which node
 * that resolves to and when it refuses instead.
 */
const ResumeBody = z.object({ fromNode: z.string().min(1).optional() })

const ERROR_STATUS: Record<string, number> = {
  device_not_found: 404,
  job_not_found: 404,
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
  // `POST /:id/resume` (plan 99 §3.5, §4.9, step 99.8).
  job_not_terminal: 409,
  job_node_not_found: 400,
  // Plan 98 §3.3 S1, §3.8, §4.5, steps 98.6/98.7 — `JobService.enqueue()`/
  // `resume()` throw these three by name (`services/job-service.ts`); this
  // file's own `onError` below maps any UNLISTED `EnkakuError.code` to 500,
  // which every one of these is genuinely a 400 for: an unsupported SDK
  // major, an operator's per-job override that failed shape validation, or
  // one that exceeded the farm's own ceiling.
  E_RUNTIME_UNSUPPORTED: 400,
  E_RUNTIME_ENVELOPE_INVALID: 400,
  E_RUNTIME_OVER_CEILING: 400,
  // Plan 128 §4.3 — `DELETE /:id` on a job that has not settled. A 409, not a
  // 400: the request is well formed and will succeed unchanged once the job
  // stops running, which is precisely what `job_not_cancellable` above means
  // for the opposite verb.
  job_not_settled: 409,
  // The host has no database wired into these routes (a partial harness) —
  // the cascade genuinely cannot run here, and saying "not implemented" is
  // honest where a 500 would send someone looking for a fault.
  E_UNSUPPORTED: 501,
  // `frame-store.ts` raises this for a UI snapshot that is on disk but
  // unreadable. Deliberately NOT a 404: null means "gone", and a corrupt
  // snapshot reported as gone sends a debugger hunting a retention sweep that
  // never ran.
  E_TRACE_CORRUPT: 500,
}

export interface JobRoutesDeps {
  log?: Logger
  /**
   * What a RUNNING job has logged so far. `/ws` has no snapshot replay and the
   * `job.log` artifact does not exist until the job ends, so without this a
   * detail page opened mid-run could show nothing that already happened.
   * Absent on a host with no local runner (matches every other optional
   * dependency here).
   */
  logBuffer?: { get(jobId: string): JobLogEntry[]; truncated(jobId: string): boolean }
  /**
   * `canUseDevice`'s device half (plan 34 §3.5, §4.4) — reused by
   * `canCancelJob` (`auth/acl.ts`) to decide whether an operator without
   * `job.cancel.any` may cancel THIS job, via the device it runs on.
   * Optional, undefined meaning "no ownership data, no restriction", the
   * same default every other optional ACL dep in this codebase uses (a test
   * harness, or a host that has not wired auth).
   */
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
  /**
   * Security audit trail (plan 09 §4.5) — `job.cancel` lands here on every
   * successful cancel, the same convention `batch.cancel`
   * (`api/batches.ts`) and every device mutation in `api/devices.ts` already
   * follow. Optional so an existing test harness keeps compiling unchanged.
   */
  audit?: AuditLogger
  /**
   * The database, for the four routes that read or delete rows `JobService`
   * does not model: `GET /:id/trace` (a keyset page of `job_events`),
   * `DELETE /:id` and `POST /history/clear` (the §4.5 cascade).
   *
   * Optional, like every other dependency in this interface — a harness that
   * does not wire it gets an empty trace page rather than a crash (the same
   * "empty list, never a 404" convention `/logs` and `/nodes` already use),
   * and the two destructive routes answer `E_UNSUPPORTED` (501) rather than
   * pretending to have deleted something.
   */
  db?: Db
  /**
   * Frames and UI-tree snapshots for `GET /:id/trace/frames/:hash` and
   * `/:id/trace/ui/:hash` (plan 128 §3.5). The store validates BOTH the job id
   * and the hash before it builds a path, so these routes hand it the raw URL
   * segments rather than sanitising them here — one guard, at the place that
   * touches the filesystem.
   */
  traceStore?: TraceFrameStore
  /**
   * App-data root, needed by the cascade: artifact `path`s are relative to it
   * and `traces/<jobId>/` lives under it. Without it the row half of a delete
   * still runs and the file half is logged as skipped.
   */
  dataDir?: string
}

/**
 * Whether a job may be deleted — everything except `queued`/`running` (plan
 * 128 §4.3). Written as an exclusion rather than a list of the four settled
 * statuses so a status added later is refused until somebody decides,
 * instead of being deletable by omission.
 */
function isSettled(status: JobStatus): boolean {
  return status !== 'queued' && status !== 'running'
}

/**
 * One `job_events` row as the protocol declares it. Parsed, never cast: `meta`
 * is a JSON column and `kind`/`phase`/`frameStatus` are plain `text`, so what
 * comes back off disk is external input exactly like a request body is
 * (00-overview §4.2). A row that does not fit is a coded 500 rather than a
 * malformed event handed to a client that trusted the schema.
 */
function toTraceEvent(row: typeof jobEvents.$inferSelect): JobTraceEvent {
  const parsed = JobTraceEventSchema.safeParse(row)
  if (!parsed.success) {
    throw new EnkakuError('E_TRACE_CORRUPT', `job_events row ${row.id} does not match JobTraceEventSchema`)
  }
  return parsed.data
}

export function createJobRoutes(service: JobService, deps?: JobRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  // `POST /` (the public enqueue) is removed by plan 207 (MVP 07): `run-script`
  // is an actions API verb now (`POST /api/actions/run-script`), which
  // always creates a batch (even for one device) through `createBatch` —
  // never `JobService.enqueue` directly. Scripts started from inside the
  // farm (a schedule, a plugin) still reach `service.enqueue`/`job.run`
  // exactly as before; only the public HTTP door for a bare job is gone.

  /**
   * "Clear history" (plan 128 §4.3) — the bulk form of `DELETE /:id`'s
   * cascade, over whatever the three optional filters select.
   *
   * **Registered before every `/:id` route on purpose.** `history` is a
   * perfectly good job id as far as a path pattern is concerned, and a router
   * that resolved this to `/:id/clear` would turn "clear the farm's history"
   * into a 404 on a job nobody has — or, worse, into a different verb. The
   * ordering is the guard; do not move it down.
   *
   * A `queued` or `running` job that the filter matched is left alone and
   * counted in `skipped`, for the same reason `DELETE /:id` refuses one: a
   * running job's rows are still being written, and deleting them mid-flight
   * would race the trace recorder's own flush. Reported rather than silently
   * dropped, so "clear everything" followed by a job that is still there reads
   * as the deliberate refusal it is.
   */
  // Plan 128 §4.3, §9 Q4 — `job.history.purge`, NOT `job.run`. This route
  // selects by FILTER, not by a device the caller owns, so `job.run` (an
  // operator permission) would have made bulk erasure of the whole farm's
  // history — every device, every owner, every trace frame — an ordinary
  // operator action. `DELETE /:id` deliberately keeps the looser per-job
  // ownership gate; see the permission's own comment in `auth/acl.ts`.
  app.post('/history/clear', requirePermission('job.history.purge'), async (c) => {
    const db = deps?.db
    if (!db) throw new EnkakuError('E_UNSUPPORTED', 'clearing job history is not available on this host')
    const raw = (await c.req.json().catch(() => ({}))) ?? {}
    const body = JobHistoryClearRequestSchema.safeParse(raw)
    if (!body.success) {
      return c.json(
        { error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } },
        400,
      )
    }
    const { before, deviceId, status } = body.data
    const filters = [
      deviceId !== undefined ? eq(jobs.deviceId, deviceId) : undefined,
      status !== undefined && status.length > 0 ? inArray(jobs.status, status) : undefined,
      // `finishedAt` for a job that ran, `createdAt` for one that never did
      // (an expired or cancelled queue entry has no finish). Unix SECONDS —
      // the `jobs` table's own convention; §3.3's milliseconds carve-out is
      // `job_events.atMs` alone and does not reach here.
      before !== undefined ? sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt}) < ${before}` : undefined,
    ].filter((f) => f !== undefined)
    const matched = db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .all()
    const deletable: string[] = []
    let skipped = 0
    for (const row of matched) {
      const parsed = JobStatusSchema.safeParse(row.status ?? 'queued')
      if (parsed.success && isSettled(parsed.data)) deletable.push(row.id)
      else skipped += 1
    }
    const deleted = deleteJobsWithHistory(db, deletable, {
      dataDir: deps?.dataDir,
      traceStore: deps?.traceStore,
      log: deps?.log,
    })
    deps?.audit?.record({
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
      // Plan 81 §4.5 — every other member of the trigger chain rooted at
      // this job id, for the job detail page's lineage view.
      rootJobId: c.req.query('rootJobId') ?? undefined,
      limit,
      cursor: decodeCursor(cursorParam),
    })
    return typedJson(c, JobsPageResponseSchema, {
      items: result.jobs,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor.sortValue, result.nextCursor.id) : null,
      total: result.total,
    })
  })

  /**
   * The detail response carries `result` — the script's own return value
   * (plan 60 §3.3, §4.3). It has been on the row since M4 and reached nobody:
   * a farm whose scripts exist to report an exit IP, a version, or whether an
   * element was there had no way to show what they reported. The list above
   * still omits it on purpose.
   */
  app.get('/:id', (c) => {
    const job = service.get(c.req.param('id'))
    if (!job) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    return typedJson(c, JobResponseSchema, { job })
  })

  /**
   * What a RUNNING job has logged so far.
   *
   * A client fetches this and then subscribes to `job.log`, the same
   * fetch-then-subscribe shape the device list and the agent chat already use
   * (`CLAUDE.md`: `/ws` has no snapshot replay). Without it, a detail page
   * opened mid-run showed nothing that had already happened, and every earlier
   * line appeared at once when the job ended and its artifact was written.
   *
   * A FINISHED job returns an empty list rather than a 404: its lines live in
   * the `job.log` artifact from then on, which is what the page loads instead.
   * `truncated` is honest about a long-running job whose oldest lines were
   * dropped, so the panel can say so rather than quietly starting late.
   */
  app.get('/:id/logs', (c) => {
    const id = c.req.param('id')
    if (!service.get(id)) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const buf = deps?.logBuffer
    return typedJson(c, JobLogsResponseSchema, {
      lines: buf ? buf.get(id) : [],
      truncated: buf ? buf.truncated(id) : false,
    })
  })

  /**
   * The node timeline for a workflow job (plan 99 §3.5, §4.9, step 99.8) —
   * one row per NODE EXECUTION, including the ones the cursor never reached
   * (`status: 'skipped'`) and, once a resumed job has actually run, the ones
   * replayed rather than re-executed (`skipped-on-resume`). `service.nodes()`
   * throws `job_not_found` for a missing job (mapped to 404 below); a job
   * that exists but has not run a node yet (every non-workflow job) answers
   * `{ items: [], finalized }`, the same "empty list, not a 404" convention
   * `/logs` above already uses. `finalized` says whether the
   * PARENT job has settled — the same terminal check `/:id/resume` gates on.
   */
  app.get('/:id/nodes', requirePermission('job.view'), (c) => {
    const result = service.nodes(c.req.param('id'))
    return typedJson(c, JobNodesResponseSchema, result)
  })

  /**
   * The job trace (plan 128 §4.3) — a keyset page of `job_events`.
   *
   * **The cursor is `seq`, and so is the ORDER BY — never `atMs`.** `seq` is
   * arrival order at the recorder, which is not event order: an `action` is
   * held until its screenshot settles, while a `log` line emits immediately,
   * so an action whose capture took 200 ms lands after a log line that
   * happened during it. That makes `seq` a correct cursor (unique per job,
   * monotonic, stable across concurrent inserts — a page boundary can neither
   * repeat nor lose a row) and the wrong display axis. `atMs` is stamped at
   * `begin()` and is the true axis, and **the CLIENT sorts by `(atMs, seq)`**.
   * Ordering this query by `atMs` would break paging to fix rendering, in the
   * one place where paging correctness is the whole job.
   *
   * `?after=` is the opaque cursor from the previous page's `nextCursor`
   * (`?cursor=` is accepted as an alias, since that is what every other list
   * endpoint in the core calls it). `?kind=` is repeatable and ANDs with
   * nothing else — `?kind=action&kind=error` is "either of these".
   *
   * `[]` for a job that recorded nothing, and for a host with no database
   * wired into these routes — never a 404 for either reason, matching
   * `/logs` and `/nodes` above; only a missing JOB 404s.
   */
  app.get('/:id/trace', requirePermission('job.view'), (c) => {
    const id = c.req.param('id')
    if (!service.get(id)) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const db = deps?.db
    if (!db) return typedJson(c, JobTraceResponseSchema, { items: [], nextCursor: null, total: null })

    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const after = decodeCursor(c.req.query('after') ?? cursorParam)
    const kinds: JobTraceEvent['kind'][] = []
    for (const raw of c.req.queries('kind') ?? []) {
      const parsed = JobTraceEventSchema.shape.kind.safeParse(raw)
      if (!parsed.success) {
        throw new EnkakuError('E_BAD_REQUEST', `unknown trace kind "${raw}"`)
      }
      kinds.push(parsed.data)
    }

    const scope = and(eq(jobEvents.jobId, id), kinds.length > 0 ? inArray(jobEvents.kind, kinds) : undefined)
    const counted = db.select({ n: sql<number>`count(*)` }).from(jobEvents).where(scope).get()
    const rows = db
      .select()
      .from(jobEvents)
      .where(and(scope, keysetWhere(after ? { value: after.sortValue, id: after.id } : null, jobEvents.seq, jobEvents.id, 'asc')))
      // `id` only breaks a tie `seq` cannot produce (it is unique per job) —
      // it is here because `keysetWhere`'s predicate assumes both columns are
      // in the ORDER BY, and a cursor whose sort disagrees with its predicate
      // is the exact bug that helper exists to prevent.
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

  /**
   * One trace frame, addressed by the SHA-256 of its own bytes (plan 128
   * §3.5, §4.3).
   *
   * `private, immutable`: the URL names the content, so these bytes can never
   * change under it — but the content is a screenshot of somebody's phone, so
   * it must never be held by a shared cache.
   *
   * `:id` and `:hash` both arrive from the URL and both become path segments.
   * They are handed to the store UNsanitised on purpose — `frame-store.ts`
   * validates each against its own pattern BEFORE it builds a path, and a
   * second, looser copy of that check here is how the two come to disagree. A
   * refusal surfaces as its `E_BAD_REQUEST` → 400; a hash that is well formed
   * but absent (never captured, or swept) is a 404.
   */
  app.get('/:id/trace/frames/:hash', requirePermission('job.view'), async (c) => {
    const id = c.req.param('id')
    if (!service.get(id)) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const bytes = (await deps?.traceStore?.readFrame(id, c.req.param('hash'))) ?? null
    if (!bytes) return c.json({ error: { code: 'frame_not_found', message: 'no such trace frame' } }, 404)
    return new Response(bytes, {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, immutable' },
    })
  })

  /**
   * The UI tree captured beside an action (plan 128 §4.3) — gunzipped and
   * re-validated on the way out, so what Studio's `InspectorPanel` renders is
   * the same shape a live dump gives it. Same addressing, same guards and the
   * same 404 as the frame route above.
   */
  app.get('/:id/trace/ui/:hash', requirePermission('job.view'), async (c) => {
    const id = c.req.param('id')
    if (!service.get(id)) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const node = (await deps?.traceStore?.readUiTree(id, c.req.param('hash'))) ?? null
    if (!node) return c.json({ error: { code: 'ui_snapshot_not_found', message: 'no such ui snapshot' } }, 404)
    return c.json(node, 200, { 'cache-control': 'private, immutable' })
  })

  /**
   * Delete one job and its whole history (plan 128 §4.3, §4.5): the job row,
   * its artifacts and their files, its `job_events`, its `job_nodes`, and its
   * trace directory — one cascade, `jobs/purge.ts`'s, shared with "clear
   * history" and with device removal so it cannot drift between them.
   *
   * Refused with `job_not_settled` (409) while the job is `queued` or
   * `running`: cancel it first. Deleting a job whose recorder is still
   * flushing rows would race that flush and leave `job_events` behind for a
   * job that no longer exists — the one orphan this storage layout is
   * designed to make impossible.
   *
   * The ownership check is `POST /:id/cancel`'s, not a weaker one. Erasing
   * another operator's run is strictly more destructive than stopping it, so
   * it cannot be the verb with the looser gate.
   */
  app.delete('/:id', requirePermission('job.run'), (c) => {
    const id = c.req.param('id')
    const job = service.get(id)
    if (!job) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const user = c.get('user')
    if (user) {
      const device = deps?.getDeviceOwner?.(job.deviceId) ?? null
      if (!canCancelJob(user, device)) {
        throw new EnkakuError('auth.forbidden', 'you do not have permission to delete this job')
      }
    }
    if (!isSettled(job.status)) {
      throw new EnkakuError('job_not_settled', `job ${id} is ${job.status} — cancel it before deleting it`)
    }
    const db = deps?.db
    if (!db) throw new EnkakuError('E_UNSUPPORTED', 'deleting a job is not available on this host')
    const deleted = deleteJobsWithHistory(db, [id], {
      dataDir: deps?.dataDir,
      traceStore: deps?.traceStore,
      log: deps?.log,
    })
    deps?.audit?.record({
      userId: user?.id ?? null,
      action: 'job.delete',
      target: id,
      meta: { deviceId: job.deviceId, deleted },
    })
    return typedJson(c, JobDeleteResponseSchema, { jobId: id, deleted })
  })

  /**
   * Resume a settled workflow job from an earlier node (plan 99 §3.5, §4.9,
   * step 99.8) — creates a NEW job, never mutates the original. Copies the
   * original job's RESOLVED `scriptId` (never re-resolves `@latest` — a
   * pipeline resumed a week later runs the exact code it started with),
   * `deviceId`, `params`, `scriptName`/`scriptVersion`. The device-ownership
   * check is the SAME `canCancelJob`-style gate `/:id/cancel` below uses —
   * resuming is, like cancelling, ordinary operator work on a device the
   * caller is already allowed to use, not an admin-only action. `409` if the
   * original job has not settled yet; `400` if `fromNode` never actually ran
   * in it (`service.resume` names which).
   */
  app.post('/:id/resume', requirePermission('job.run'), async (c) => {
    const id = c.req.param('id')
    const original = service.get(id)
    if (!original) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const body = ResumeBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json(
        { error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } },
        400,
      )
    }
    const user = c.get('user')
    if (user) {
      const device = deps?.getDeviceOwner?.(original.deviceId) ?? null
      if (!canCancelJob(user, device)) {
        throw new EnkakuError('auth.forbidden', 'you do not have permission to resume this job')
      }
    }
    const job = service.resume(id, { fromNode: body.data.fromNode })
    deps?.audit?.record({
      userId: user?.id ?? null,
      action: 'job.run',
      target: job.jobId,
      // `fromNode: null` means the caller asked for the default (the last
      // node this job attempted) — `service.resume` is what resolved it;
      // the resolved value is readable from the new job's own node timeline.
      meta: { resumedFromJobId: id, fromNode: body.data.fromNode ?? null },
    })
    return typedJson(c, JobCreateResponseSchema, { job }, 201)
  })

  // `service.cancel()` returns a plain `JobInfo` (no `result` field) — a genuine shape mismatch
  // plan 72.5's first pass found (Studio's own call site originally claimed the full-`JobDetail`
  // `JobResponseSchema` here, which would have thrown `E_BAD_RESPONSE` on every cancel in
  // production). `JobCancelResponseSchema` is the schema that actually matches this route; both
  // sides now point at it. `?cancelDescendants=1` (plan 81 §4.4) is opt-in, never automatic — an
  // operator cancelling a runaway chain's root asks for it explicitly.
  //
  // `canCancelJob` (server-authoritative, spec §10.1: Studio hiding the button is never the
  // control) — this route used to call `service.cancel` with no permission or ownership check at
  // all, so any authenticated operator could cancel any job farm-wide. The job is looked up FIRST
  // (rather than letting `service.cancel` 404 on a missing one) because the check needs its
  // `deviceId`; a missing user (a test harness that has not wired auth) skips the check, the same
  // permissive default `service.enqueue`'s own `actor` check above uses.
  app.post('/:id/cancel', (c) => {
    const jobId = c.req.param('id')
    const job = service.get(jobId)
    if (!job) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    const user = c.get('user')
    if (user) {
      const device = deps?.getDeviceOwner?.(job.deviceId) ?? null
      if (!canCancelJob(user, device)) {
        throw new EnkakuError('auth.forbidden', 'you do not have permission to cancel this job')
      }
    }
    const cancelDescendants = ['1', 'true'].includes(c.req.query('cancelDescendants') ?? '')
    const result = service.cancel(jobId, { cancelDescendants })
    deps?.audit?.record({
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
