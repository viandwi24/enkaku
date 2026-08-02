import { z } from 'zod'

/** Jobs and leases (spec §10, §13). */

export const JobStatusSchema = z.enum(['queued', 'running', 'success', 'failed', 'cancelled'])
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
  priority: z.number(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
})
export type JobInfo = z.infer<typeof JobInfoSchema>

export const JobStatusEventMessage = z.object({
  type: z.literal('job.status'),
  payload: JobInfoSchema.extend({
    /** Attempt number (1-based) and the script phase currently running (M4). */
    attempt: z.number().int().optional(),
    phase: z.enum(['prepare', 'run', 'finish']).nullable().optional(),
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

export const ArtifactInfoSchema = z.object({
  id: z.string(),
  jobId: z.string(),
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
