import { z } from 'zod'
import { ArtifactInfoSchema, JobDetailSchema, JobInfoSchema, JobRunDetailSchema, JobRunInfoSchema, JobStatusSchema, JobTraceEventSchema } from '../messages/job'
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

/** `GET /api/jobs/:id/runs/:runId`. */
export const JobRunResponseSchema = z.object({ run: JobRunDetailSchema })

/** `GET /api/jobs/:id/runs`. */
export const JobRunsResponseSchema = z.object({ items: z.array(JobRunInfoSchema), total: z.number().int() })

/** `GET /api/jobs/:id/runs/:runId/artifacts`. */
export const RunArtifactsResponseSchema = z.object({ items: z.array(ArtifactInfoSchema) })

/**
 * `GET /api/jobs/:id/runs/:runId/logs` — what a RUN has logged so far.
 *
 * The companion to the `job.log` WS message, not a replacement: `/ws` has no
 * snapshot replay, so a client fetches this and then subscribes. A FINISHED
 * run answers with an empty list rather than a 404, because from then on its
 * lines live in the `job.log` artifact, which is what a page loads instead.
 *
 * `truncated` is true when a long-running run's oldest retained lines were
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

// ---- Plan 128 (M93 — the job trace timeline), step 128.1, §4.3 ----

/**
 * `GET /api/jobs/:id/runs/:runId/trace` (plan 128 §4.3) — a keyset page of
 * `job_events`, ordered and cursored on `seq` (never `atMs`: two events can
 * share a millisecond, and a cursor that cannot separate them either repeats
 * a row or loses one).
 *
 * The same `{ items, nextCursor, total }` envelope every other list endpoint
 * in the core returns (`pageSchema`, plan 30 §4.1) — a trace is a long list
 * read a page at a time, not a bespoke shape.
 *
 * The companion to the `job.trace` WS message rather than a replacement:
 * `/ws` has no snapshot replay, so the Timeline tab fetches this and then
 * subscribes, exactly as the Logs tab already does. `[]` for a run that
 * recorded nothing — never a 404 for that reason; only a missing job or run
 * 404s.
 */
export const JobTraceResponseSchema = pageSchema(JobTraceEventSchema)

/**
 * What one run of `deleteJobsWithHistory` actually removed (plan 128 §4.5) —
 * shared by `DELETE /api/jobs/:id` and `POST /api/jobs/history/clear` below,
 * because both call that one function and a caller should not have to learn
 * two vocabularies for one cascade.
 *
 * Counts rather than a bare `ok: true`: the whole point of the cascade is
 * that several things go together, so a response that cannot say how many
 * rows and how many directories went with the job leaves the operator no
 * way to notice when one of them silently stopped happening.
 */
export const JobPurgeCountsSchema = z.object({
  /** `jobs` rows deleted. */
  jobs: z.number().int().min(0),
  /** `job_runs` rows deleted (plan 211). */
  runs: z.number().int().min(0),
  /** `job_events` rows deleted. */
  events: z.number().int().min(0),
  /** `artifacts` rows deleted — their files are unlinked in the same pass. */
  artifacts: z.number().int().min(0),
  /** `traces/<runId>` directories removed (0 when a run never captured a frame). */
  traceDirs: z.number().int().min(0),
})
export type JobPurgeCounts = z.infer<typeof JobPurgeCountsSchema>

/**
 * `DELETE /api/jobs/:id` (plan 128 §4.3, §4.5) — the job row, every run it
 * had, their artifacts and files, their `job_events`, and their trace
 * directories, all in one cascade.
 *
 * Refused with `job_not_settled` while any run is `queued` or `running`
 * (cancel it first), so a success response always means the whole cascade
 * ran. `jobId` is echoed so a client deleting several in a loop can match a
 * response to its request without tracking order.
 */
export const JobDeleteResponseSchema = z.object({
  jobId: z.string(),
  deleted: JobPurgeCountsSchema,
})
export type JobDeleteResponse = z.infer<typeof JobDeleteResponseSchema>

/**
 * `POST /api/jobs/history/clear` (plan 128 §4.3) — the bulk form of the same
 * cascade, over whatever the three optional filters select.
 *
 * Every field is optional and they AND together; a body with none of them
 * means "every settled job", which is the "Clear history" button's own case.
 * `before` is unix SECONDS (the `jobs` table's own convention — this is a
 * `finishedAt`/`createdAt` comparison, not a trace timestamp, so §3.3's
 * milliseconds carve-out does not reach here).
 */
export const JobHistoryClearRequestSchema = z.object({
  /** Unix seconds — only jobs that settled before this instant. Omitted means no age bound. */
  before: z.number().int().optional(),
  /** Only this device's jobs. Omitted means every device. */
  deviceId: z.string().optional(),
  /** Only these statuses. Omitted means every SETTLED status; `queued`/`running` jobs are never cleared. */
  status: z.array(JobStatusSchema).optional(),
})
export type JobHistoryClearRequest = z.infer<typeof JobHistoryClearRequestSchema>

/**
 * `POST /api/jobs/history/clear` response (plan 128 §4.3).
 *
 * `skipped` counts jobs the filter matched that were still `queued` or
 * `running` and were therefore left alone — reported rather than silently
 * dropped, so "clear everything" followed by a job that is still there reads
 * as the deliberate refusal it is rather than as a bug.
 */
export const JobHistoryClearResponseSchema = z.object({
  deleted: JobPurgeCountsSchema,
  skipped: z.number().int().min(0).default(0),
})
export type JobHistoryClearResponse = z.infer<typeof JobHistoryClearResponseSchema>
