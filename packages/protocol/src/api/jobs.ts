import { z } from 'zod'
import { JobDetailSchema, JobInfoSchema, JobNodeStatusSchema, JobStatusSchema, JobTraceEventSchema } from '../messages/job'
import { DeviceEventSchema } from '../messages/device-event'
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

/**
 * `GET /api/jobs/:id/assists` (plan 91 §3.5, §4.9) — every non-job input
 * action recorded against this job's device while it ran: an indexed range
 * scan over `device_events` (`idx_device_events_tail(deviceId, stream, at)`),
 * no JSON extraction (F18). `jobs.assistCount` on `JobInfo` is the headline
 * number; this is the detail — who, when, and (in `meta`) exactly what.
 */
export const JobAssistsResponseSchema = z.object({ items: z.array(DeviceEventSchema) })

/**
 * One structured error on a `job_nodes` row (plan 99 §4.6, §4.9, step 99.8)
 * — `job_nodes.error_code`/`job_nodes.error`, the two columns the row
 * actually has, given a shape instead of two loose nullable strings so
 * `JobNodeInfoSchema` below can reuse it in both `attempts.lastError` (what
 * went wrong on the last attempt) and `output.error` (the error attached to
 * the produced result) without restating the same two fields twice.
 */
export const JobNodeErrorSchema = z.object({
  /** `job_nodes.error_code` — null on a row that failed before a code was assigned. */
  code: z.string().nullable().default(null),
  message: z.string(),
})
export type JobNodeError = z.infer<typeof JobNodeErrorSchema>

/**
 * One row of `job_nodes` — one node EXECUTION, not one document node (plan 99
 * §4.9, acceptance #8: "every node execution is a row", including skipped
 * ones).
 *
 * `seq` is what the timeline is ordered and keyed by — it is unique within a
 * job (`idx_job_nodes_seq`), unlike `nodeId`: a loop re-executes the same
 * document node and each pass is its own row, so a timeline keyed on `nodeId`
 * alone would silently collapse every iteration into one entry.
 *
 * `duration`/`attempts`/`output` are nested rather than flat because they are
 * genuinely three different questions a timeline row answers ("when",
 * "how many tries", "what came out"), and grouping them is what lets a UI
 * bind one sub-object to one cell without re-deriving it. `output.truncated`
 * matters in particular: step 99.7 caps a node's output at
 * `WORKFLOW_LIMITS.maxNodeOutputBytes`, so a consumer that cannot tell a
 * capped value from a complete one would quietly mislead.
 *
 * The nullable fields are nullable because the COLUMN is: `scriptId`,
 * `scriptName` and `scriptVersion` are all null for a `gate` node, which has
 * no script at all.
 */
export const JobNodeInfoSchema = z.object({
  /** 0-based execution order within the job. Exceeds the document's node count when a loop ran. */
  seq: z.number().int(),
  /** The document's node id. Repeats across rows when a loop re-executed it. */
  nodeId: z.string(),
  kind: z.enum(['script', 'gate']),
  /** Resolved at execution, never `@latest` — what actually ran. Null for a gate. */
  scriptId: z.string().nullable(),
  scriptName: z.string().nullable(),
  scriptVersion: z.string().nullable(),
  status: JobNodeStatusSchema,
  duration: z.object({
    /** Unix seconds; null while the node has not started (or never did — a skipped row). */
    startedAt: z.number().nullable().default(null),
    finishedAt: z.number().nullable().default(null),
    /** Server-computed convenience; null whenever either endpoint above is null. */
    elapsedMs: z.number().int().nullable().default(null),
  }),
  attempts: z.object({
    /** Attempts spent on THIS execution — straight from `job_nodes.attempts`. A completed count, not an in-flight index. */
    current: z.number().int().min(0).default(0),
    /**
     * The node's retry BUDGET. Nullable because no column stores it: it
     * comes from the workflow document the job ran, so a caller reading a
     * row whose document is gone gets an honest null rather than a
     * fabricated number.
     */
    total: z.number().int().min(0).nullable().default(null),
    lastError: JobNodeErrorSchema.nullable().default(null),
  }),
  output: z.object({
    /** Whatever the node returned. `unknown` for the same reason `JobDetail.result` is. */
    value: z.unknown(),
    /** Set when the value was too large to store: the cap, and what was dropped (`job_nodes.output_truncated`). */
    truncated: z.string().nullable().default(null),
    error: JobNodeErrorSchema.nullable().default(null),
    /** A gate's resolved verdict (left/right values, operator, branch taken) — plan 99 §3.7, §4.4. Null for a script node. */
    verdict: z.unknown(),
  }),
  /** Set on the first row of a job created by `POST /api/jobs/:id/resume` (plan 99 §3.5) — the job it continues from. Null otherwise. */
  resumedFromJobId: z.string().nullable().default(null),
  /** The node id resume started at — set alongside `resumedFromJobId`, null otherwise. */
  resumedFromNode: z.string().nullable().default(null),
})
export type JobNodeInfo = z.infer<typeof JobNodeInfoSchema>

/**
 * `GET /api/jobs/:id/nodes` (plan 99 §3.5, §4.9, step 99.8) — a workflow
 * job's node TIMELINE: one entry per `job_nodes` row, which is one entry per
 * NODE EXECUTION, not one per node — a loop runs a node several times and
 * each run is its own row, and every node the cursor never reached is still
 * a row (`status: 'skipped'`), so `items` is never a blank gap (H4). `[]`
 * for a job that is not a workflow, or one that has not executed a node yet
 * — never a 404 for that reason, the same convention `/logs` and `/assists`
 * above already use on this same route group; only a missing JOB 404s.
 *
 * No `jobId` field here — the caller already has it, from the URL. `finalized`
 * is `true` once the PARENT job has settled (the same terminal-status check
 * `POST /:id/resume` itself gates on) — what tells a polling client to stop,
 * and a "Resume from here" control that it may render at all: resume is
 * refused with `409` while the job is not terminal.
 */
export const JobNodesResponseSchema = z.object({
  items: z.array(JobNodeInfoSchema),
  finalized: z.boolean(),
})
export type JobNodesResponse = z.infer<typeof JobNodesResponseSchema>

// ---- Plan 128 (M93 — the job trace timeline), step 128.1, §4.3 ----

/**
 * `GET /api/jobs/:id/trace` (plan 128 §4.3) — a keyset page of `job_events`,
 * ordered and cursored on `seq` (never `atMs`: two events can share a
 * millisecond, and a cursor that cannot separate them either repeats a row or
 * loses one).
 *
 * The same `{ items, nextCursor, total }` envelope every other list endpoint
 * in the core returns (`pageSchema`, plan 30 §4.1) — a trace is a long list
 * read a page at a time, not a bespoke shape.
 *
 * The companion to the `job.trace` WS message rather than a replacement:
 * `/ws` has no snapshot replay, so the Timeline tab fetches this and then
 * subscribes, exactly as the Logs tab already does. `[]` for a job that
 * recorded nothing — never a 404 for that reason, matching `/logs`,
 * `/assists` and `/nodes` on this same route group; only a missing JOB 404s.
 */
export const JobTraceResponseSchema = pageSchema(JobTraceEventSchema)

/**
 * What one run of `deleteJobsWithHistory` actually removed (plan 128 §4.5) —
 * shared by `DELETE /api/jobs/:id` and `POST /api/jobs/history/clear` below,
 * because both call that one function and a caller should not have to learn
 * two vocabularies for one cascade.
 *
 * Counts rather than a bare `ok: true`: the whole point of the cascade is
 * that five things go together, so a response that cannot say how many rows
 * and how many directories went with the job leaves the operator no way to
 * notice when one of the five silently stopped happening.
 */
export const JobPurgeCountsSchema = z.object({
  /** `jobs` rows deleted. */
  jobs: z.number().int().min(0),
  /** `job_events` rows deleted. */
  events: z.number().int().min(0),
  /** `artifacts` rows deleted — their files are unlinked in the same pass. */
  artifacts: z.number().int().min(0),
  /** `job_nodes` rows deleted (0 for every non-workflow job). */
  nodes: z.number().int().min(0),
  /** `traces/<jobId>` directories removed (0 when a job never captured a frame). */
  traceDirs: z.number().int().min(0),
})
export type JobPurgeCounts = z.infer<typeof JobPurgeCountsSchema>

/**
 * `DELETE /api/jobs/:id` (plan 128 §4.3, §4.5) — the job row, its artifacts
 * and their files, its `job_events`, its `job_nodes`, and its trace directory,
 * all in one cascade.
 *
 * Refused with `job_not_settled` while the job is `queued` or `running`
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
