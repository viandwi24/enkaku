import { z } from 'zod'
import { JobDetailSchema, JobInfoSchema } from '../messages/job'
import { pageSchema } from './pagination'

/**
 * `GET /api/jobs/:id` — a full `JobDetail`. `JobWithPhase`
 * (`packages/studio/src/lib/jobs.ts`) adds a client-only `phase` field
 * pushed later by `job.status`, never present on this response itself.
 *
 * NOT `POST /api/jobs/:id/cancel` — see `JobCancelResponseSchema` below;
 * `service.cancel()` (`packages/core/src/services/job-service.ts`) returns
 * a bare `JobInfo`, with no `result` field, so parsing its response against
 * THIS schema fails at runtime (`JobDetailSchema`'s `result: z.unknown()`
 * is a REQUIRED key under Zod 4, not merely typed `unknown` — a present but
 * absent key rejects). This was plan 72's own migration finding it: the
 * cancel call site originally claimed `JobResponseSchema` here (an easy
 * mistake — cancel "feels like" a detail read), which would have made every
 * job-cancel throw `E_BAD_RESPONSE` in production. Fixed by pointing that
 * call site at the schema actually matching what the route returns.
 */
export const JobResponseSchema = z.object({ job: JobDetailSchema })

/** `POST /api/jobs` — `{job}` is a full `JobInfo`, not just `{jobId}`. */
export const JobCreateResponseSchema = z.object({ job: JobInfoSchema })

/**
 * `POST /api/jobs/:id/cancel` — `service.cancel()` returns a bare `JobInfo`,
 * not a `JobDetail`. `cancelledDescendants` (plan 81 §4.4) counts queued
 * jobs cancelled because `?cancelDescendants=1` was passed — 0 whenever the
 * option was not used, never omitted, so a caller does not have to guess
 * whether the field is simply absent from an older server.
 */
export const JobCancelResponseSchema = z.object({ job: JobInfoSchema, cancelledDescendants: z.number().int().min(0).default(0) })

/** `GET /api/jobs?...` (keyset). */
export const JobsPageResponseSchema = pageSchema(JobInfoSchema)

/**
 * `GET /api/jobs/:id/logs` — what a RUNNING job has logged so far.
 *
 * The companion to the `job.log` WS message, not a replacement: `/ws` has no
 * snapshot replay, so a client fetches this and then subscribes. A FINISHED
 * job answers with an empty list rather than a 404, because from then on its
 * lines live in the `job.log` artifact, which is what a page loads instead.
 *
 * `truncated` is true when a long-running job's oldest retained lines were
 * dropped, so a panel can say so rather than quietly starting mid-story.
 */
export const JobLogLineSchema = z.object({
  jobId: z.string(),
  ts: z.number(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  source: z.enum(['script', 'stdout', 'stderr', 'runner']),
  msg: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
})
export const JobLogsResponseSchema = z.object({ lines: z.array(JobLogLineSchema), truncated: z.boolean() })
