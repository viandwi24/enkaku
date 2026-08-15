import { Hono } from 'hono'
import { JobAssistsResponseSchema, JobCancelResponseSchema, JobCreateResponseSchema, JobLogsResponseSchema, JobNodesResponseSchema, JobResponseSchema, JobStatusSchema, JobsPageResponseSchema, ScriptRefSchema } from '@enkaku/protocol'
import type { JobLogEntry } from '@enkaku/session'
import { z } from 'zod'
import { canCancelJob } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { decodeCursor, encodeCursor, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

/**
 * `POST /:id/resume` (plan 99 §3.5, §4.9, step 99.8). `fromNode` omitted
 * means "the last node this job actually attempted, if it did not succeed"
 * — `JobService.resume`'s own `defaultResumeNode` names exactly which node
 * that resolves to and when it refuses instead.
 */
const ResumeBody = z.object({ fromNode: z.string().min(1).optional() })

// `scriptId` (concrete, unchanged) OR `scriptRef` (`name@version`/`name@latest`,
// plan 62 §4.4) — exactly one. `refine` rather than a union so the error
// message names the actual rule instead of a generic "no variant matched".
const EnqueueBody = z
  .object({
    scriptId: z.string().min(1).optional(),
    scriptRef: ScriptRefSchema.optional(),
    deviceId: z.string().min(1),
    params: z.unknown(),
    priority: z.number().int().optional(),
    /**
     * Plan 98 §3.8, step 98.7 — the operator's own per-job runtime layer,
     * composed by Studio's `RuntimeOverrideSection`. `unknown` deliberately:
     * this route does not itself validate its shape — it crosses the same
     * external boundary `params` does, and `JobService.enqueue()` is the ONE
     * place that validates it against `RuntimeEnvelopeSchema`
     * (`E_RUNTIME_ENVELOPE_INVALID`) and checks it against the farm's own
     * ceiling (`E_RUNTIME_OVER_CEILING`, mapped to 400 below), so there is no
     * second shape to drift from that one. This gap — the field was accepted
     * by neither this body nor `api/batches.ts`'s create-batch body, so an
     * operator's typed override was silently stripped by this route's own
     * Zod parse before `service.enqueue` ever saw it — closed per
     * docs/plans/96-m61-hotfixes.md, continuing that document's numbering.
     */
    runtimeOverride: z.unknown().optional(),
  })
  .refine((b) => (b.scriptId ? 1 : 0) + (b.scriptRef ? 1 : 0) === 1, {
    message: 'exactly one of scriptId or scriptRef is required',
  })

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
}

export interface JobRoutesDeps {
  log?: Logger
  /**
   * Resolves `name@version`/`name@latest` to a concrete `scripts.id` (plan
   * 62 §4.4) — called BEFORE the job row is written, so the stored
   * `scriptId` is always concrete, whichever form the request used. Throws
   * an `EnkakuError` (`script_not_found` | `script_version_not_found` |
   * `script_ref_unresolved` | `script_disabled`) when it cannot resolve.
   */
  resolveScriptRef?: (ref: string) => { id: string }
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
}

export function createJobRoutes(service: JobService, deps?: JobRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.post('/', async (c) => {
    const body = EnqueueBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json(
        { error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } },
        400,
      )
    }
    let scriptId = body.data.scriptId
    if (body.data.scriptRef) {
      if (!deps?.resolveScriptRef) {
        return c.json({ error: { code: 'E_BAD_REQUEST', message: 'scriptRef is not supported here' } }, 400)
      }
      scriptId = deps.resolveScriptRef(body.data.scriptRef).id
    }
    // `canUseDevice` (plan 34 §3.5, §4.4) — refused inside `service.enqueue`
    // with `auth.forbidden` when the device belongs to another user.
    const job = service.enqueue({
      scriptId: scriptId as string, // guaranteed by the refine() above plus the branch just taken
      deviceId: body.data.deviceId,
      params: body.data.params,
      priority: body.data.priority,
      actor: c.get('user'),
      runtimeOverride: body.data.runtimeOverride,
    })
    return typedJson(c, JobCreateResponseSchema, { job }, 201)
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
   * Plan 91 §3.5, §4.9 — every non-job input action recorded against this
   * job's device while it ran: `jobs.assistCount` (on `GET /:id` / the list)
   * says HOW MANY, this says WHAT and BY WHOM. `service.assists()` does the
   * actual indexed range scan over `device_events` (F18); `job_not_found` is
   * mapped to 404 below, the same as every other job route.
   */
  app.get('/:id/assists', (c) => {
    const items = service.assists(c.req.param('id'))
    return typedJson(c, JobAssistsResponseSchema, { items })
  })

  /**
   * The node timeline for a workflow job (plan 99 §3.5, §4.9, step 99.8) —
   * one row per NODE EXECUTION, including the ones the cursor never reached
   * (`status: 'skipped'`) and, once a resumed job has actually run, the ones
   * replayed rather than re-executed (`skipped-on-resume`). `service.nodes()`
   * throws `job_not_found` for a missing job (mapped to 404 below); a job
   * that exists but has not run a node yet (every non-workflow job) answers
   * `{ items: [], finalized }`, the same "empty list, not a 404" convention
   * `/logs` and `/assists` above already use. `finalized` says whether the
   * PARENT job has settled — the same terminal check `/:id/resume` gates on.
   */
  app.get('/:id/nodes', requirePermission('job.view'), (c) => {
    const result = service.nodes(c.req.param('id'))
    return typedJson(c, JobNodesResponseSchema, result)
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
