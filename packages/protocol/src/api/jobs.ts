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

/** `POST /api/jobs/:id/cancel` — `service.cancel()` returns a bare `JobInfo`, not a `JobDetail`. */
export const JobCancelResponseSchema = z.object({ job: JobInfoSchema })

/** `GET /api/jobs?...` (keyset). */
export const JobsPageResponseSchema = pageSchema(JobInfoSchema)
