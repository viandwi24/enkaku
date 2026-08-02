import { z } from 'zod'

/** Plan 20 §3.2 — two independent parameters cover every requested execution shape. */
export const BatchOrderSchema = z.enum(['as-listed', 'random'])
export type BatchOrder = z.infer<typeof BatchOrderSchema>

/** Plan 20 §3.5 — a cached projection of the batch's jobs, never incremented. */
export const BatchStatusSchema = z.enum(['queued', 'running', 'success', 'failed', 'cancelled'])
export type BatchStatusValue = z.infer<typeof BatchStatusSchema>

export const BatchCountsSchema = z.object({
  total: z.number().int(),
  queued: z.number().int(),
  running: z.number().int(),
  success: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  /** Plan 21 §3.3 — a job that never got a device before its queue deadline. Counted separately from `failed`. */
  expired: z.number().int().default(0),
})
export type BatchCounts = z.infer<typeof BatchCountsSchema>

/**
 * A cluster is a container, not a selector (plan 22.0 §3.1–§3.3, superseding
 * plan 20 §3.1) — its identity only, membership lives on `devices.cluster`.
 */
export const ClusterInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.number(),
  /** Current member count (plan 22.0 §4.2) — a live read, not cached. */
  deviceCount: z.number().int(),
  /** Of `deviceCount`, how many are online and not quarantined right now. */
  usableCount: z.number().int(),
})
export type ClusterInfo = z.infer<typeof ClusterInfoSchema>

export const ResolvedTargetSchema = z.object({
  deviceId: z.string(),
  via: z.enum(['tag', 'explicit', 'cluster']),
})

export const SkippedDeviceSchema = z.object({
  deviceId: z.string(),
  reason: z.string(),
})

export const ClusterPreviewSchema = z.object({
  usable: z.array(ResolvedTargetSchema),
  skipped: z.array(SkippedDeviceSchema),
})
export type ClusterPreview = z.infer<typeof ClusterPreviewSchema>

/** One script run across a resolved set of devices (plan 20 §3.1, §3.5). */
export const BatchInfoSchema = z.object({
  id: z.string(),
  clusterId: z.string().nullable(),
  scriptId: z.string(),
  scriptName: z.string().nullable().default(null),
  scriptVersion: z.string().nullable().default(null),
  params: z.unknown(),
  concurrency: z.number().int(),
  order: BatchOrderSchema,
  status: BatchStatusSchema,
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  counts: BatchCountsSchema,
})
export type BatchInfo = z.infer<typeof BatchInfoSchema>

/** Broadcast whenever a member job changes state (plan 20 §4.5, §4.7). */
export const BatchStatusMessage = z.object({
  type: z.literal('batch.status'),
  payload: z.object({
    batchId: z.string(),
    status: BatchStatusSchema,
    counts: BatchCountsSchema,
  }),
})
export type BatchStatusEvent = z.infer<typeof BatchStatusMessage>
