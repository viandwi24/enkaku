import { z } from 'zod'

export const StorageUsageKindSchema = z.enum(['jobsAndLogs', 'traceFrames', 'artifacts', 'audit'])
export type StorageUsageKind = z.infer<typeof StorageUsageKindSchema>

export const StorageUsageRowSchema = z.object({
  kind: StorageUsageKindSchema,
  bytes: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative(),
  /** Unix seconds; when the cache was last recomputed, not when this response was served. */
  computedAt: z.number().int().nonnegative(),
})

/** `GET /api/storage/usage` (plan 224, MVP 09 §6). Always a cache read — see `packages/core/src/retention/storage-usage.ts`'s doc comment for why. */
export const StorageUsageResponseSchema = z.object({
  kinds: z.array(StorageUsageRowSchema),
  totalBytes: z.number().int().nonnegative(),
})
