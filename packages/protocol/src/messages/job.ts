import { z } from 'zod'
import { JsonSchemaNodeSchema } from '../api/json-schema'
import { LeaseHolderSchema } from '../device'
import { RESULT_LIMITS, ResultStatusSchema } from '../schema/result'
import { ParamIssueSchema } from '../schema/validate'

/** Jobs and leases (spec §10, §13). */

/**
 * `expired` (plan 21 §3.3, §4.1) is distinct from `failed`: `failed` says the
 * script ran and did not work, `expired` says the job never got a device
 * before its queue deadline. Collapsing them makes a farm capacity problem
 * look like a script bug.
 */
export const JobStatusSchema = z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'expired'])
export type JobStatus = z.infer<typeof JobStatusSchema>

/** Params for the `internal:sleep` dummy executor (M3 — queue validation without automation). */
export const SleepJobParamsSchema = z.object({
  durationMs: z.number().int().min(0).max(3_600_000),
  /** Simulate a job failing partway through. */
  failAfterMs: z.number().int().min(0).optional(),
  /** Simulate a job that ignores cancellation — exercises the lease-expiry path. */
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

export const LeaseAcquireMessage = z.object({
  type: z.literal('lease.acquire'),
  id: z.string().optional(),
  payload: z.object({
    deviceId: z.string(),
    /**
     * The id of the holder the CALLER BELIEVES currently holds the device
     * (plan 71 §3.4) — a person's clientId/userId or an agent's root run id
     * (`LeaseHolder.id`). Omitted for an ordinary acquire (device believed
     * free). When present and the device is actually held by someone else,
     * this is a takeover attempt: refused with `lease_holder_changed` if the
     * real holder no longer matches (compare-and-swap, same reasoning as
     * plan 64 §3.4's `ifMatch`), refused unconditionally for a job's lease.
     */
    takeOverFrom: z.string().optional(),
  }),
})

export const LeaseReleaseMessage = z.object({
  type: z.literal('lease.release'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

// ---- server → client ----

export const JobInfoSchema = z.object({
  jobId: z.string(),
  deviceId: z.string(),
  scriptId: z.string(),
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
   * Plan 91 §3.5, §4.9 — how many times a human sent input to this job's
   * device while it was running (a co-control/assist action). `0` for every
   * job, including one written before this column existed — never null, so a
   * job list can badge it with no guard. `GET /api/jobs/:id/assists` is the
   * detail (who, when, what); this is just the headline count.
   */
  assistCount: z.number().int().min(0).default(0),
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
  /** 'standalone' | 'plugin' | 'dev' (plan 82 §3.3) once that column exists. */
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

/**
 * The status of one workflow NODE EXECUTION (plan 99 §4.6, `job_nodes.status`)
 * — the same domain the DB column's own comment names, mirrored here so
 * `job.status`'s `node` block below and `GET /api/jobs/:id/nodes` (step 99.8)
 * can both validate against one Zod schema instead of a bare string.
 */
export const JobNodeStatusSchema = z.enum(['running', 'success', 'failed', 'skipped', 'skipped-on-resume', 'cancelled'])
export type JobNodeStatus = z.infer<typeof JobNodeStatusSchema>

export const JobStatusEventMessage = z.object({
  type: z.literal('job.status'),
  payload: JobInfoSchema.extend({
    /** Attempt number (1-based) and the script phase currently running (M4).
     * `reset` (plan 35 §3.5, §4.4) is the pre-job device reset — it always
     * runs before `prepare`, and only for a 'full' attempt. */
    attempt: z.number().int().optional(),
    phase: z.enum(['reset', 'prepare', 'run', 'finish']).nullable().optional(),
    /**
     * Plan 99 §4.9 — which workflow node is CURRENTLY executing, for a
     * `kind: 'workflow'` job only. `total` is the document's node COUNT, not
     * `maxSteps` (a loop can run more executions than there are nodes — this
     * is "how many rows in the list", the number a `node 2/4` badge needs).
     * Absent for every non-workflow job — every `job.status` payload before
     * this plan keeps parsing unchanged.
     */
    node: z
      .object({
        id: z.string(),
        seq: z.number().int(),
        total: z.number().int(),
        kind: z.enum(['script', 'gate']),
        /** `'tiktok/auto-scroll@1.4.0'` for a script node; null for a gate (no script) or before resolution. */
        script: z.string().nullable(),
        status: JobNodeStatusSchema,
      })
      .nullable()
      .optional(),
  }),
})

/** Realtime per-job log (M4). */
export const JobLogMessage = z.object({
  type: z.literal('job.log'),
  payload: z.object({
    jobId: z.string(),
    ts: z.number(),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    source: z.enum(['script', 'stdout', 'stderr', 'runner']),
    msg: z.string(),
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
})

/**
 * Exactly one of `jobId` / `deviceId` is set (plan 24 §4.6): a job artifact
 * (the pre-existing case) carries `jobId` and a null `deviceId`; a
 * device-scoped artifact ("save last N lines" from the Monitor tab) is the
 * reverse. Both fields are nullable rather than a discriminated union so
 * every existing `job.artifact` payload — which always has `jobId` set —
 * keeps parsing unchanged.
 */
export const ArtifactInfoSchema = z.object({
  id: z.string(),
  jobId: z.string().nullable().default(null),
  deviceId: z.string().nullable().default(null),
  kind: z.enum(['screenshot', 'log', 'file', 'video']),
  label: z.string().nullable(),
  path: z.string(),
  sizeBytes: z.number().nullable(),
  createdAt: z.number(),
  /**
   * Plan 99 §3.2, §4.6 — the workflow node that produced this artifact; null
   * for every artifact of a non-workflow job (every row before this plan) and
   * for a device-scoped artifact (which has no job, let alone a node).
   * Stamped by `runner/artifact-store.ts`'s node-scoped wrapper, not by the
   * child boundary — a node script never learns this field exists.
   *
   * `.optional()` (unlike `jobId`/`deviceId` above) is deliberate, not an
   * oversight: dozens of PRE-EXISTING test files across `packages/core/src`
   * (several under concurrent edit by other workers this same day — the
   * ws-handlers/mirror/presence/crash-watcher suites) build an `ArtifactInfo`
   * literal by hand with no `nodeId` field at all. Making the FIELD required
   * would force every one of those to add `nodeId: null`, which is exactly
   * the wide, unrelated blast radius a workflow-scoped column must not have
   * (plan 99 §3.1's containment doctrine, applied to a wire shape rather than
   * a `kind` comparison). `z.parse()` still defaults an absent value to
   * `null`; only the TS-inferred type is relaxed.
   */
  nodeId: z.string().nullable().default(null).optional(),
})
export type ArtifactInfo = z.infer<typeof ArtifactInfoSchema>

export const JobArtifactMessage = z.object({
  type: z.literal('job.artifact'),
  payload: z.object({ jobId: z.string(), artifact: ArtifactInfoSchema }),
})

export const LeaseAcquiredMessage = z.object({
  type: z.literal('lease.acquired'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string(), expiresAt: z.number() }),
})

export const LeaseReleasedMessage = z.object({
  type: z.literal('lease.released'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

/**
 * Broadcast whenever manual control changes hands, to EVERY connected client.
 *
 * `lease.acquired` only reaches the client that asked, so a second person
 * watching the same device saw nothing: their page kept offering "Take
 * control", and the only feedback was an error after clicking. This carries no
 * identity — a viewer already knows whether the lease is its own — just the
 * fact that the device is being driven by someone.
 */
export const LeaseChangedMessage = z.object({
  type: z.literal('lease.changed'),
  payload: z.object({
    deviceId: z.string(),
    /**
     * The full holder (plan 71 §3.2), or `null` when the device is free —
     * replaces the plain `held: boolean` this message used to carry. A
     * consumer that only needs the boolean computes `heldBy !== null`;
     * nothing is lost, and the wire stops carrying a fact ("held") that was
     * never sufficient to draw a badge or a takeover dialog.
     */
    heldBy: LeaseHolderSchema.nullable(),
    expiresAt: z.number().nullable(),
  }),
})

export const LeaseRevokedMessage = z.object({
  type: z.literal('lease.revoked'),
  payload: z.object({
    deviceId: z.string(),
    reason: z.enum(['idle_timeout', 'disconnected', 'quarantined', 'taken-over', 'adb-server-restart']),
    /**
     * Who took the lease (plan 71 §3.5) — a resolved label, e.g. "Rina" or
     * "checkout-bot". Null for every reason other than `taken-over` (an idle
     * timeout, a disconnect, or a quarantine has no taker).
     */
    takenBy: z.string().nullable().default(null),
  }),
})

/**
 * A queued job is waiting before it can claim its target device — broadcast
 * while the wait is in progress so it is legible rather than looking stuck,
 * and once more with `waiting: false` the moment the job actually claims
 * the device (or, for `reason: 'quiet'`, the wait's own `maxWaitSec` cap
 * expires and the job proceeds anyway).
 *
 * Two distinct reasons share this one message, plan 94 §3.8, §4.8, step
 * 94.6 (`reason: 'paced'`) added alongside plan 71 §3.7's original
 * (`reason: 'quiet'`) rather than a second message type, because both are
 * the same shape of fact from a Studio job list's point of view: "this
 * queued job cannot claim its device yet, and here is how long that is
 * expected to last." `heldBy` is only ever non-null for `'quiet'` — a
 * paced wait has no lease holder to name, it is simply not due yet
 * (`jobs.not_before`, unix seconds).
 *
 * Rendering this (e.g. Studio's "waiting — next repetition in 4s" line) is
 * a LATER step's own surface (94.10) — this message only proves the reason
 * and remaining seconds reach the wire.
 */
export const JobWaitingMessage = z.object({
  type: z.literal('job.waiting'),
  payload: z.object({
    jobId: z.string(),
    deviceId: z.string(),
    waiting: z.boolean(),
    /** 'quiet' (plan 71 §3.7 — waiting for a manually-held device to go quiet) | 'paced' (plan 94 §3.8, §4.8, step 94.6 — waiting on the job's own `notBefore`). */
    reason: z.enum(['quiet', 'paced']),
    /** Who the device is waiting to go quiet from — null once free, and always null for `reason: 'paced'` (no lease holder is involved). */
    heldBy: LeaseHolderSchema.nullable(),
    /** Seconds remaining before the wait is satisfied: the quiet gate (or its `maxWaitSec` cap) for `'quiet'`, `notBefore - now` for `'paced'`. */
    remainingSec: z.number().int().min(0),
  }),
})

// ---- Plan 99 §4.9, step 99.8: the node timeline and resume ----

/**
 * One node execution's failure, as the timeline reports it (plan 99 §4.9).
 *
 * A local two-field object rather than a shared `ErrorSchema`, because this
 * package has no such schema: the only precedents are `ShellReplyErrorSchema`
 * and `ClipboardReplyErrorSchema` in `tunnel.ts`, both `{ code, message }`
 * declared locally for exactly this reason. This mirrors that pair's shape so
 * a future consolidation is a rename, not a redesign — and it maps 1:1 onto
 * the two columns the row actually has (`job_nodes.error_code`,
 * `job_nodes.error`).
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
 * `seq` is part of the shape rather than an implementation detail, and it is
 * what the timeline is ordered and keyed by. `nodeId` is NOT unique within a
 * job: the table's unique index is `(job_id, seq)` and its `(job_id, node_id)`
 * index is deliberately non-unique, because a loop re-executes the same
 * document node and each pass is its own row. A timeline keyed on `nodeId`
 * alone would silently collapse every iteration of a loop into one entry.
 *
 * Timestamps are unix SECONDS, matching `JobInfoSchema.startedAt`/`finishedAt`
 * above and the repo-wide rule that DB timestamps are integer unix seconds
 * (Drizzle `mode: 'timestamp'`). Not `z.date()`: this schema validates a JSON
 * HTTP body, and JSON has no date type — a `z.date()` field would reject every
 * real response.
 *
 * The nullable fields are nullable because the COLUMN is: `scriptId`,
 * `scriptName` and `scriptVersion` are all null for a `gate` node, which has
 * no script at all.
 */
export const JobNodeSchema = z.object({
  /** 0-based execution order within the job. Exceeds the document's node count when a loop ran. */
  seq: z.number().int(),
  /** The document's node id. Repeats across rows when a loop re-executed it. */
  nodeId: z.string(),
  kind: z.enum(['script', 'gate']),
  /** Resolved at execution, never `@latest` — what actually ran. Null for a gate. */
  scriptId: z.string().nullable().default(null),
  scriptName: z.string().nullable().default(null),
  scriptVersion: z.string().nullable().default(null),
  status: JobNodeStatusSchema,
  duration: z.object({
    /** Unix seconds; null while the node has not started (or never did — a skipped row). */
    startedAt: z.number().nullable().default(null),
    finishedAt: z.number().nullable().default(null),
    /** Server-computed convenience; null whenever either endpoint above is null. */
    elapsedMs: z.number().int().nullable().default(null),
  }),
  attempts: z.object({
    /**
     * Attempts spent on THIS execution — straight from `job_nodes.attempts`.
     * Named `current` to keep the peer-facing shape, but it is a completed
     * count, not an in-flight index.
     */
    current: z.number().int().min(0).default(0),
    /**
     * The node's retry BUDGET. Nullable because no column stores it: it comes
     * from the workflow document the job ran, so a caller reading a row whose
     * document is gone gets an honest null rather than a fabricated number.
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
    /** A gate's PredicateTrace and the branch it took (plan 99 §3.7). Null for a script node. */
    verdict: z.unknown(),
  }),
  /** Set on seq 0 of a resumed job (plan 99 §3.5); null on every other row. */
  resumedFromJobId: z.string().nullable().default(null),
  resumedFromNode: z.string().nullable().default(null),
})
export type JobNode = z.infer<typeof JobNodeSchema>

/**
 * `GET /api/jobs/:id/nodes` (plan 99 §4.9, step 99.8).
 *
 * `finalized` says the parent job has settled, which is what tells a poller to
 * stop and a "Resume from here" control that it may appear: resume is refused
 * with `409` while the job is not terminal.
 */
export const JobNodesResponseSchema = z.object({
  jobId: z.string(),
  nodes: z.array(JobNodeSchema),
  finalized: z.boolean(),
})
export type JobNodesResponse = z.infer<typeof JobNodesResponseSchema>

/**
 * `POST /api/jobs/:id/resume` request body (plan 99 §3.5, §4.9).
 *
 * `fromNode` omitted means "the first node that did not succeed" — the common
 * case, and the one the job page's own button sends.
 */
export const JobResumeRequestSchema = z.object({
  fromNode: z.string().optional(),
})
export type JobResumeRequest = z.infer<typeof JobResumeRequestSchema>

/**
 * `POST /api/jobs/:id/resume` response (plan 99 §3.5, §4.9) — resume creates a
 * NEW job rather than restarting the old one, so the original stays readable.
 * `resumedFromNode` is echoed resolved: a request that omitted `fromNode` gets
 * back the node the server actually chose.
 */
export const JobResumeResponseSchema = z.object({
  newJobId: z.string(),
  resumedFromJobId: z.string(),
  resumedFromNode: z.string(),
  status: z.enum(['created', 'queued', 'running']),
})
export type JobResumeResponse = z.infer<typeof JobResumeResponseSchema>

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
  payload: z.object({ jobId: z.string(), deviceId: z.string(), value: z.unknown() }),
})
