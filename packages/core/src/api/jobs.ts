import { Hono } from 'hono'
import { JobCancelResponseSchema, JobCreateResponseSchema, JobLogsResponseSchema, JobResponseSchema, JobStatusSchema, JobsPageResponseSchema, ScriptRefSchema } from '@enkaku/protocol'
import type { JobLogEntry } from '@enkaku/session'
import { z } from 'zod'
import type { AuthEnv } from '../auth/middleware'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { decodeCursor, encodeCursor, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

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

  // `service.cancel()` returns a plain `JobInfo` (no `result` field) — a genuine shape mismatch
  // plan 72.5's first pass found (Studio's own call site originally claimed the full-`JobDetail`
  // `JobResponseSchema` here, which would have thrown `E_BAD_RESPONSE` on every cancel in
  // production). `JobCancelResponseSchema` is the schema that actually matches this route; both
  // sides now point at it. `?cancelDescendants=1` (plan 81 §4.4) is opt-in, never automatic — an
  // operator cancelling a runaway chain's root asks for it explicitly.
  app.post('/:id/cancel', (c) => {
    const cancelDescendants = ['1', 'true'].includes(c.req.query('cancelDescendants') ?? '')
    const result = service.cancel(c.req.param('id'), { cancelDescendants })
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
