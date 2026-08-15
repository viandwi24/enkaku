import { z } from 'zod'

/** Plan 20 §3.2 — two independent parameters cover every requested execution shape. */
export const BatchOrderSchema = z.enum(['as-listed', 'random'])
export type BatchOrder = z.infer<typeof BatchOrderSchema>

/**
 * Plan 20 §3.5 — a cached projection of the batch's jobs, never incremented.
 *
 * `batches.status` (`db/schema.ts`) gains a SIXTH value, `'stopping'` (plan
 * 94 §3.9, §4.8 — step 94.7 added the column-level value only; step 94.8,
 * this widening, adds the writer, `POST /api/batches/:id/stop`) — a state,
 * not a flag, that `clusters/status.ts`'s `recomputeBatchStatus` never
 * writes and never clobbers away early (see that function's own comment): it
 * is written directly by the stop endpoint, held while any member is still
 * settling, and released back to whatever `computeBatchStatus` derives
 * (`success` | `failed` | `cancelled`) the moment every member is terminal.
 * Widening this one step early (94.7) would have left every exhaustive
 * `BatchStatusValue` switch (Studio's batch-status badge maps included)
 * non-exhaustive for a value the wire could never actually send yet — this
 * step is the one that adds both the writer and the exhaustive handling
 * together.
 */
export const BatchStatusSchema = z.enum(['queued', 'running', 'stopping', 'success', 'failed', 'cancelled'])
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
  /**
   * Plan 36 §4.4 — of `failed`, how many were classified `script` vs
   * `infra`/`load` (`jobs.failureClass`). A batch that fell over because of
   * one bad hub should not read as twenty broken tests. Defaulted so an
   * older cached `BatchStatusEvent` still parses.
   */
  failedScript: z.number().int().default(0),
  failedInfra: z.number().int().default(0),
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

/**
 * The batch's own repeat/stagger configuration (plan 94 §3.7, §4.8, §4.9,
 * step 94.7). `null` means an unpaced batch — every batch dispatched before
 * this plan, and every batch dispatched after it with no `pacing` block on
 * `POST /api/batches` (§4.9's own default). `repeatCount: 1` with every
 * interval `0` is the on-the-wire equivalent of `null` and is normalised to
 * it here, so a client only has one shape to check for "is this batch
 * paced at all".
 */
export const BatchPacingSchema = z
  .object({
    repeatCount: z.number().int(),
    intervalMinMs: z.number().int(),
    intervalMaxMs: z.number().int(),
    deviceIntervalMs: z.number().int(),
  })
  .nullable()
export type BatchPacing = z.infer<typeof BatchPacingSchema>

/**
 * Per-device repetition progress (plan 94 §3.8, §4.8, step 94.7 — "rowToBatchInfo
 * reports planned/completed repetitions per device"). `completed` counts
 * every job row this device has in the batch, terminal or not — a running
 * repetition is not yet completed. Rendering this is Studio's own surface,
 * step 94.10 — this is the wire shape it will read, not built there.
 */
export const BatchDeviceRepeatSchema = z.object({
  deviceId: z.string(),
  completed: z.number().int(),
  planned: z.number().int(),
})
export type BatchDeviceRepeat = z.infer<typeof BatchDeviceRepeatSchema>

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
  /** Plan 94 §3.7, §4.8, step 94.7 — `null` for an unpaced batch. */
  pacing: BatchPacingSchema.default(null),
  /** Plan 94 §3.8, §4.8, step 94.7 — empty for an unpaced batch. */
  repeats: z.array(BatchDeviceRepeatSchema).default([]),
  /**
   * Plan 93 §3.12, §4.2, §4.6, step 93.8, closing F11 — every device that
   * was in the batch's resolved target but never got a job row, with why.
   * Empty for a batch with no skips (or one dispatched before this field
   * existed) — never a distinct "unknown" state, since a batch's target is
   * always resolved once, at dispatch (§3.1), and never re-resolved later.
   */
  skipped: z.array(SkippedDeviceSchema).default([]),
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
