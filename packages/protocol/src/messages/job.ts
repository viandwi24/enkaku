import { z } from 'zod'
import { JsonSchemaNodeSchema } from '../api/json-schema'
import { DeviceActivitySchema } from '../activity'
import { RESULT_LIMITS, ResultStatusSchema } from '../schema/result'
import { ParamIssueSchema } from '../schema/validate'

/** Jobs (MVP 04, MVP 14). */

/**
 * `expired` (plan 21 §3.3, §4.1) is distinct from `failed`: `failed` says the
 * script ran and did not work, `expired` says the job never got a device
 * before its queue deadline. Collapsing them makes a farm capacity problem
 * look like a script bug.
 */
export const JobStatusSchema = z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'expired'])
export type JobStatus = z.infer<typeof JobStatusSchema>

/** Why an execution exists (MVP 14 §1, plan 211). Shown in the Jobs detail meta line. */
export const RunTriggerSchema = z.enum(['manual', 'rerun', 'schedule', 'batch', 'resume', 'workflow-step'])
export type RunTrigger = z.infer<typeof RunTriggerSchema>

/** 'script' or 'workflow' (MVP 05 §1.2), visible per row in the one Jobs list (MVP 15 §1). */
export const JobKindSchema = z.enum(['script', 'workflow'])
export type JobKind = z.infer<typeof JobKindSchema>

/** Params for the `internal:sleep` dummy executor (M3 — queue validation without automation). */
export const SleepJobParamsSchema = z.object({
  durationMs: z.number().int().min(0).max(3_600_000),
  /** Simulate a job failing partway through. */
  failAfterMs: z.number().int().min(0).optional(),
  /** Simulate a job that ignores cancellation — exercises the heartbeat-expiry path. */
  ignoreCancel: z.boolean().default(false),
})
export type SleepJobParams = z.infer<typeof SleepJobParamsSchema>

// ---- client → server ----

export const JobEnqueueMessage = z.object({
  type: z.literal('job.enqueue'),
  id: z.string().optional(),
  payload: z.object({
    scriptId: z.string(),
    deviceId: z.string(),
    params: z.unknown(),
    priority: z.number().int().default(0),
  }),
})

export const JobCancelMessage = z.object({
  type: z.literal('job.cancel'),
  id: z.string().optional(),
  payload: z.object({ jobId: z.string() }),
})

// ---- server → client ----

/**
 * One execution of a job (MVP 14 §1). The list projection deliberately omits
 * `result` and `params`, exactly as `JobInfo` always has (F18): a result can
 * be large and a run list is not the place for it.
 */
export const JobRunInfoSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  seq: z.number().int().min(1),
  trigger: RunTriggerSchema,
  status: JobStatusSchema,
  deviceId: z.string(),
  priority: z.number().int(),
  /** Unix seconds. */
  createdAt: z.number().int(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  expiresAt: z.number().nullable().default(null),
  notBefore: z.number().int().nullable().default(null),
  batchRepeat: z.number().int().nullable().default(null),
  pacedDelayMs: z.number().int().nullable().default(null),
  error: z.string().nullable(),
  failureClass: z.string().nullable().default(null),
  errorPhase: z.string().nullable().default(null),
  infraAttempts: z.number().int().min(0).default(0),
  peakRssBytes: z.number().int().nullable().default(null),
  resultStatus: ResultStatusSchema.nullable().default(null),
  resultSummary: z.string().max(RESULT_LIMITS.maxSummaryChars).nullable().default(null),
  resumedFromRunId: z.string().nullable().default(null),
  resumedFromStep: z.number().int().nullable().default(null),
})
export type JobRunInfo = z.infer<typeof JobRunInfoSchema>

/** One run in full (the detail read): the run plus what it produced. */
export const JobRunDetailSchema = JobRunInfoSchema.extend({
  result: z.unknown(),
  resultBytes: z.number().int().nullable().default(null),
  resultIssues: z.array(ParamIssueSchema).nullable().default(null),
  resultSchema: JsonSchemaNodeSchema.nullable().default(null),
})
export type JobRunDetail = z.infer<typeof JobRunDetailSchema>

export const JobInfoSchema = z.object({
  jobId: z.string(),
  deviceId: z.string(),
  scriptId: z.string(),
  /** 'script' | 'workflow' (MVP 05 §1.5: one Jobs list, kind visible per row). */
  kind: JobKindSchema.default('script'),
  /** The latest run's id, and how many runs this job has. Null/0 only for a job whose runs were all swept (MVP 14 §5). */
  runId: z.string().nullable().default(null),
  runSeq: z.number().int().nullable().default(null),
  runCount: z.number().int().min(0).default(0),
  /** The latest run's trigger; null when there is no run. */
  trigger: RunTriggerSchema.nullable().default(null),
  /** MVP 05 §1.5, "step 3 of workflow job #91". Null for every ordinary job. */
  parentWorkflowJobId: z.string().nullable().default(null),
  stepSeq: z.number().int().nullable().default(null),
  /** Script name and version, so the UI never has to show a raw UUID. */
  scriptName: z.string().nullable().default(null),
  scriptVersion: z.string().nullable().default(null),
  status: JobStatusSchema,
  error: z.string().nullable(),
  /** Plan 36 §3.2, §4.1 — 'infra' | 'script' | 'load'; only ever set for `status: 'failed'`. */
  failureClass: z.string().nullable().default(null),
  priority: z.number(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  /** Plan 20 §4.1 — null for a standalone job. */
  batchId: z.string().nullable().default(null),
  /** Position within the batch (the shuffle for `random` order is baked in here). */
  batchSeq: z.number().int().nullable().default(null),
  /** Plan 21 §3.3, §4.1 — unix seconds; null means "wait forever". */
  expiresAt: z.number().nullable().default(null),
  /**
   * Plan 60 §3.4, §4.4 — the script phase a failure happened in ('prepare' |
   * 'run' | 'finish' | 'reset' | 'timeout' | 'acquire'), so "why did this
   * fail" is answerable on the Summary tab instead of by reading the log.
   * A free string rather than an enum: it carries whatever the runner
   * reported, including the pre-script phases ('acquire') that are not part
   * of the script's own lifecycle. Null for a job that never failed.
   */
  errorPhase: z.string().nullable().default(null),
  /**
   * Plan 81 §4.1 — lineage, straight from the `jobs` row (`rowToJobInfo`).
   * The REST-facing sibling of `JobSummary`'s already-populated lineage
   * fields (plan 81's `ctx.jobs` projection): both read the same three
   * columns, this is just the shape Studio and `GET /api/jobs` see rather
   * than the shape a running script sees. `triggeredByJobId`/`rootJobId`
   * null means "not part of a trigger chain" — a human, a schedule, or a
   * batch created this job directly, which is the common case. `depth` is
   * never actually null (the column defaults to 0 and every existing
   * pre-plan-81 row was backfilled to it), so it stays a plain number here
   * rather than mirroring `JobSummary`'s defensive `.nullable()`.
   */
  triggeredByJobId: z.string().nullable().default(null),
  rootJobId: z.string().nullable().default(null),
  depth: z.number().int().default(0),
  /**
   * Plan 98 §3.9 item 4, §4.4, H1 — the highest RSS the runner ever measured
   * for this job, across every attempt. A byte count, not a duration; null
   * whenever no child ever reported a sample (a job that never ran, or an
   * executor with no subprocess) and for every job predating this field.
   * Recorded unconditionally — no memory LIMIT exists anywhere yet (that is
   * step 98.3); this is the measurement a limit will eventually be chosen
   * from, not an enforcement of one.
   */
  peakRssBytes: z.number().int().nullable().default(null),
  /**
   * Plan 94 §3.7, §3.8, §4.8, step 94.7 — unix seconds; the queue will not
   * claim this job before it (`jobs.notBefore`). Null for every job written
   * before plan 94, and for an ordinary job/batch member this plan never
   * paces. Also carried live in `job.waiting`'s `reason: 'paced'` case
   * (step 94.6) — this is the same value, on the row, once the wait is over.
   */
  notBefore: z.number().int().nullable().default(null),
  /**
   * Plan 94 §3.7, §3.8, §4.8, step 94.7 — 0-based repetition index within
   * the batch, FOR THIS DEVICE (a different axis from `batchSeq` above).
   * Null for a job the pacer never touched.
   */
  batchRepeat: z.number().int().nullable().default(null),
  /**
   * Plan 94 §3.7, §3.8, §4.8, step 94.7 — the delay (milliseconds) actually
   * drawn (or, for repetition 0, the device's stagger) for this repetition —
   * "the delay each completed repetition actually waited", made legible
   * without arithmetic (F29's own house rule). Null for a job the pacer
   * never touched.
   */
  pacedDelayMs: z.number().int().nullable().default(null),
  /**
   * Plan 97 §3.3, §4.6 — the settled result's five-state verdict. `result`
   * itself stays off the list (F18): a result can be large, and fifty of
   * them is not what a list is for. Null while queued/running, and for a
   * job predating this plan.
   */
  resultStatus: ResultStatusSchema.nullable().default(null),
  /**
   * Plan 97 §3.6, §4.1, §4.6 — the one operator-legible line
   * `buildResultSummary` computed once at settle, capped at
   * `RESULT_LIMITS.maxSummaryChars`. Null when the script declared no
   * `summary` fields, when `resultStatus` is not `valid`, or for a job
   * predating this plan.
   */
  resultSummary: z.string().max(RESULT_LIMITS.maxSummaryChars).nullable().default(null),
})
export type JobInfo = z.infer<typeof JobInfoSchema>

/**
 * One job, in full (plan 60 §4.3). `result` is the script's own return value
 * — documented since M4 as "Return value → jobs.result", stored on the row
 * ever since, and until this plan visible only to whoever opened SQLite.
 *
 * Detail only, never the list: a result can be large, and fifty of them is
 * not what a list is for.
 */
export const JobDetailSchema = JobInfoSchema.extend({
  /** Every run this job has, newest first (plan 211 §3.2 decision 12). */
  runs: z.array(JobRunInfoSchema).default([]),
  /** Whatever `run()` returned. `unknown` on purpose — a script may return anything JSON can carry. */
  result: z.unknown(),
  /**
   * What the job was STARTED with — the params the run form, a schedule, a
   * batch or `ctx.jobs.trigger()` supplied.
   *
   * On the row since M4 and, like `result` before plan 60, it reached nobody:
   * a failed job could be read in full except for the one thing that says
   * which inputs produced the failure, which is the first question anyone
   * asks. `unknown` for the same reason `result` is — a script declares its
   * own params schema, so the shape is the script's, not this type's.
   *
   * Deliberately NOT on `JobInfo` (the list) or `JobSummary` (what a
   * neighbouring script sees through `ctx.jobs`): params are script-authored
   * JSON and can carry anything an author put there, so they belong on the
   * single-job read a human asked for, not in a list or a cross-script view.
   */
  params: z.unknown(),
  /**
   * Plan 97 §4.6 — the exact byte count `buildResultOutcome` measured before
   * any check ran, regardless of verdict (including `oversize`, where
   * `result` above is `null`). Null while queued/running and for a job
   * predating this plan.
   */
  resultBytes: z.number().int().nullable().default(null),
  /**
   * Plan 97 §4.6 — the real Zod `safeParse` issues (paths and sentences),
   * present only when `resultStatus` is `invalid`. Never recomputed on
   * read — stored exactly once, at settle.
   */
  resultIssues: z.array(ParamIssueSchema).nullable().default(null),
  /**
   * Plan 97 §4.6 — the result schema of the script VERSION that ran,
   * inlined here rather than left to a second fetch: a second fetch could
   * resolve to a different version after a rollback, and the screen would
   * then render one version's value through another's schema. Null when
   * the pinned script declared no `result`.
   */
  resultSchema: JsonSchemaNodeSchema.nullable().default(null),
})
export type JobDetail = z.infer<typeof JobDetailSchema>

/**
 * One job as `ctx.jobs` sees it (plan 80 §3.3, §4.1) — a projection over the
 * SAME row `JobInfo` reads, deliberately narrower: no `params`, no `result`.
 * Both are script-authored JSON a neighbouring script must never be able to
 * read directly (§3.3) — `ctx.jobs.resultOf()` is the separate, narrowly
 * scoped door to a result.
 *
 * `triggeredByJobId`/`rootJobId`/`depth` are populated from plan 81's
 * lineage columns (null for a job nothing triggered — a pre-plan-81 row, or
 * any job a human/schedule/batch created directly). `origin`/`pluginName`
 * are still always `null`: the plan 82 columns they would read from
 * (plugin/origin on `jobs`) do not exist yet. Declared now so plan 82
 * extends this shape additively instead of widening it later.
 */
export const JobSummarySchema = z.object({
  jobId: z.string(),
  scriptName: z.string().nullable(),
  scriptVersion: z.string().nullable(),
  /** 'plugin' | 'dev' (`ScriptOrigin`, plan 82 §3.3) once that column exists. */
  origin: z.string().nullable(),
  pluginName: z.string().nullable(),
  status: JobStatusSchema,
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  failureClass: z.string().nullable(),
  errorPhase: z.string().nullable(),
  error: z.string().nullable(),
  /** Plan 81 — lineage; null until it lands. */
  triggeredByJobId: z.string().nullable(),
  rootJobId: z.string().nullable(),
  depth: z.number().int().nullable(),
  /**
   * Plan 97 §4.6 — the settled result's five-state verdict ONLY. Never the
   * value, never the summary text: plan 80 §3.3's rule that a neighbouring
   * script reads a result through `ctx.jobs.resultOf()` and nowhere else
   * stands. The status is metadata about the contract, not the payload.
   */
  resultStatus: ResultStatusSchema.nullable(),
})
export type JobSummary = z.infer<typeof JobSummarySchema>

export const JobStatusEventMessage = z.object({
  type: z.literal('job.status'),
  payload: JobInfoSchema.extend({
    /** Attempt number (1-based) and the script phase currently running (M4).
     * `reset` (plan 35 §3.5, §4.4) is the pre-job device reset — it always
     * runs before `prepare`, and only for a 'full' attempt. */
    attempt: z.number().int().optional(),
    phase: z.enum(['reset', 'prepare', 'run', 'finish']).nullable().optional(),
  }),
})

/** Realtime per-job log (M4). Carries `runId` (plan 211): a client subscribes per job and renders per run. */
export const JobLogMessage = z.object({
  type: z.literal('job.log'),
  payload: z.object({
    jobId: z.string(),
    runId: z.string(),
    ts: z.number(),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    source: z.enum(['script', 'stdout', 'stderr', 'runner']),
    msg: z.string(),
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
})

/**
 * Exactly one of `runId` / `deviceId` is set (plan 24 §4.6, renamed from
 * `jobId` by plan 211): a run artifact (the pre-existing case) carries
 * `runId` and a null `deviceId`; a device-scoped artifact ("save last N
 * lines" from the Monitor tab) is the reverse.
 */
export const ArtifactInfoSchema = z.object({
  id: z.string(),
  runId: z.string().nullable().default(null),
  deviceId: z.string().nullable().default(null),
  kind: z.enum(['screenshot', 'log', 'file', 'video']),
  label: z.string().nullable(),
  path: z.string(),
  sizeBytes: z.number().nullable(),
  createdAt: z.number(),
})
export type ArtifactInfo = z.infer<typeof ArtifactInfoSchema>

export const JobArtifactMessage = z.object({
  type: z.literal('job.artifact'),
  payload: z.object({ jobId: z.string(), runId: z.string(), artifact: ArtifactInfoSchema }),
})

/**
 * A queued job is waiting before it can claim its target device — broadcast
 * while the wait is in progress so it is legible rather than looking stuck,
 * and once more with `waiting: false` the moment the job actually claims
 * the device (or, for `reason: 'control'`, the wait's own `MAX_CONTROL_WAIT_SEC`
 * cap expires and the job proceeds anyway).
 *
 * Two distinct reasons share this one message (plan 205 §3.2 item 6 renamed
 * the original `'quiet'` reason to `'control'`; `'paced'` — plan 94 §3.8,
 * §4.8, step 94.6 — is unchanged): both are the same shape of fact from a
 * Studio job list's point of view: "this queued job cannot claim its device
 * yet, and here is how long that is expected to last." `conflicting` is only
 * ever non-null for `'control'` — a paced wait has no conflicting activity to
 * name, it is simply not due yet (`jobs.not_before`, unix seconds).
 *
 * Rendering this (e.g. Studio's "waiting — next repetition in 4s" line) is
 * a LATER step's own surface (94.10) — this message only proves the reason
 * and remaining seconds reach the wire.
 */
export const JobWaitingMessage = z.object({
  type: z.literal('job.waiting'),
  payload: z.object({
    jobId: z.string(),
    runId: z.string(),
    deviceId: z.string(),
    waiting: z.boolean(),
    /** 'control' (plan 205 §3.2 item 6 — waiting for a live control marker to go quiet) | 'paced' (plan 94 §3.8, §4.8, step 94.6 — waiting on the job's own `notBefore`). */
    reason: z.enum(['control', 'paced']),
    /** The live activity the device is waiting to go quiet from — null once free, and always null for `reason: 'paced'`. */
    conflicting: DeviceActivitySchema.nullable(),
    /** Seconds remaining before the wait is satisfied: the control wait (or its `MAX_CONTROL_WAIT_SEC` cap) for `'control'`, `notBefore - now` for `'paced'`. */
    remainingSec: z.number().int().min(0),
  }),
})

/**
 * Plan 97 §3.7, §4.6, §5 step 97.7 — `ctx.progress()`'s live push, one hop
 * from the child all the way to a client: coalesced in the child
 * (`@enkaku/session`'s `child-entry.ts`, at most one per
 * `job.progressIntervalMs`), size-checked and warned-once-per-job in the
 * host (`packages/core/src/jobs/executor-host.ts`'s `ExecutorHost.progress`),
 * and broadcast here with NO DB write anywhere on the path — progress is
 * live state, not history (§3.7's own "a result is a commitment; a progress
 * is an observation"). `value` is deliberately `z.unknown()`, the same as
 * `JobLogMessage.payload.fields` above: this is unvalidated author data, the
 * opposite of a result's schema-checked `outcome`.
 */
export const JobProgressEventMessage = z.object({
  type: z.literal('job.progress'),
  payload: z.object({ jobId: z.string(), runId: z.string(), deviceId: z.string(), value: z.unknown() }),
})

// ---- Plan 128 (M93 — the job trace timeline), step 128.1, §3.3, §4.2 ----
//
// Appended at the end of this file rather than interleaved beside
// `JobLogMessage`, for the same "this file is contested, never interleave"
// reason `JobProgressEventMessage` above already carries.

/**
 * One row of `job_events` (plan 128 §4.1, §4.2) — one thing that happened
 * during a job, on a single millisecond-resolution time axis: a phase
 * boundary, a device action the script took, a log line, an artifact, a
 * progress push, or an error.
 *
 * **`atMs` is unix MILLISECONDS, not seconds** — the deliberate carve-out
 * from `00-overview.md` §4.2's seconds convention, stated in plan 128 §3.3
 * and repeated on the DB column itself. Two taps 180 ms apart are the entire
 * point of a timeline; seconds cannot represent the thing being recorded.
 * Do not "fix" this to match the neighbouring tables.
 *
 * `seq` — not the clock — is the sort key and the keyset cursor: it is a
 * per-job monotonic integer the recorder assigns, so two events landing in
 * the same millisecond still order deterministically and a keyset page stays
 * stable across a concurrent insert.
 *
 * `frameStatus` is never null when the capture policy WANTED a frame (§3.4):
 * a capture that was skipped by policy, skipped because one was already in
 * flight, or that failed outright says so on its own event. A timeline that
 * quietly omitted a frame would read as "nothing happened here", which is
 * the one thing a debugger must not be told.
 */
export const JobTraceEventSchema = z.object({
  id: z.string(),
  /** The RUN this event belongs to (renamed from `jobId`, plan 211). */
  runId: z.string(),
  /** Per-run monotonic, assigned by the recorder. The sort key and the keyset cursor — never the clock. */
  seq: z.number().int(),
  /** Unix MILLISECONDS. See this schema's own doc — deliberately not seconds. */
  atMs: z.number().int(),
  /** 1-based attempt this event belongs to; a rebound job has more than one. */
  attempt: z.number().int(),
  /** Null for an event outside any script phase (the pre-script `acquire` window, for instance). */
  phase: z.enum(['reset', 'prepare', 'run', 'finish']).nullable(),
  kind: z.enum(['phase', 'action', 'log', 'artifact', 'progress', 'error']),
  /** For `action`: the `DeviceCall` method. For `log`: the level. For `phase`: 'start' | 'end'. */
  name: z.string(),
  /** How long the action took. Null for an instantaneous event. */
  durationMs: z.number().int().nullable(),
  /** Whether the action succeeded. Null when the question does not apply (a log line, a phase boundary). */
  ok: z.boolean().nullable(),
  errorCode: z.string().nullable(),
  /** Kind-specific detail; always an object or null. `meta.args` is redacted per plan 128 §4.4. */
  meta: z.record(z.string(), z.unknown()).nullable(),
  /** SHA-256 hex of the frame in `traces/<jobId>/`, or null. */
  frameHash: z.string().nullable(),
  /** Never null when the policy wanted a frame — see this schema's own doc. */
  frameStatus: z.enum(['ok', 'skipped-policy', 'skipped-busy', 'failed']).nullable(),
  /** SHA-256 hex of the gzipped UI tree snapshot, or null. */
  uiHash: z.string().nullable(),
})
export type JobTraceEvent = z.infer<typeof JobTraceEventSchema>

/**
 * The trace's live tail (plan 128 §4.2), mirroring `JobLogMessage`'s shape
 * and placement — one event per message, pushed as the recorder publishes it
 * and BEFORE the row is written (§3.6).
 *
 * The `/ws` contract is unchanged: there is still no snapshot replay, so the
 * Timeline tab fetches `GET /api/jobs/:id/trace` and then subscribes, exactly
 * as the Logs tab already does with `/logs` and `job.log`.
 */
export const JobTraceMessage = z.object({
  type: z.literal('job.trace'),
  payload: z.object({ jobId: z.string(), runId: z.string(), event: JobTraceEventSchema }),
})
