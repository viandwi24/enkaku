import { z } from 'zod'

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
  payload: z.object({ deviceId: z.string() }),
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
})
export type JobDetail = z.infer<typeof JobDetailSchema>

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
    held: z.boolean(),
    expiresAt: z.number().nullable(),
  }),
})

export const LeaseRevokedMessage = z.object({
  type: z.literal('lease.revoked'),
  payload: z.object({
    deviceId: z.string(),
    reason: z.enum(['idle_timeout', 'disconnected', 'quarantined']),
  }),
})
