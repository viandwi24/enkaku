import { z } from 'zod'

/** Job & lease (spec §10, §13). */

export const JobStatusSchema = z.enum(['queued', 'running', 'success', 'failed', 'cancelled'])
export type JobStatus = z.infer<typeof JobStatusSchema>

/** Params dummy executor `internal:sleep` (M3 — validasi queue tanpa automation). */
export const SleepJobParamsSchema = z.object({
  durationMs: z.number().int().min(0).max(3_600_000),
  /** Simulasi job gagal di tengah jalan. */
  failAfterMs: z.number().int().min(0).optional(),
  /** Simulasi job bandel — untuk menguji jalur lease-expiry. */
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
  payload: JobInfoSchema,
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

export const LeaseRevokedMessage = z.object({
  type: z.literal('lease.revoked'),
  payload: z.object({
    deviceId: z.string(),
    reason: z.enum(['idle_timeout', 'disconnected', 'quarantined']),
  }),
})
