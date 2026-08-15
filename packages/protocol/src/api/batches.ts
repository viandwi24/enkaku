import { z } from 'zod'
import { BatchInfoSchema } from '../messages/batch'
import { JobInfoSchema } from '../messages/job'
import { pageSchema } from './pagination'

/** `POST /api/batches`, `POST /api/batches/:id/rerun-failed`. */
export const BatchResponseSchema = z.object({ batch: BatchInfoSchema })

/**
 * `GET /api/batches/:id` — ALWAYS returns both `batch` and `jobs` together
 * (`packages/core/src/api/batches.ts`'s `GET /:id`, line ~172). Two Studio
 * call sites used to claim two different narrower shapes for this one
 * route (`{batch}` and `{batch, jobs}`) — both are valid subsets of this
 * single actual shape, not a mismatch.
 */
export const BatchWithJobsResponseSchema = z.object({ batch: BatchInfoSchema, jobs: z.array(JobInfoSchema) })

/**
 * `POST /api/batches/:id/stop` (plan 94 §3.9, §4.9, step 94.8) — REPLACES
 * `POST /:id/cancel` (00-overview §4.3: "cancel some of it" was never a
 * useful verb). `cancelled` is queued members the stop cancelled, `aborted`
 * is running members it aborted, `refused` is members on a device the
 * caller could not `canCancelJob` (F27) — counted, never silently skipped,
 * so an operator without rights to three of twenty devices sees exactly
 * `refused: 3` rather than guessing why fewer than twenty stopped.
 * `refusedDeviceIds` names which, for a UI that wants to say so.
 */
export const BatchStopResponseSchema = z.object({
  cancelled: z.number().int(),
  aborted: z.number().int(),
  refused: z.number().int(),
  refusedDeviceIds: z.array(z.string()).default([]),
})

/** `GET /api/batches?...` (keyset). */
export const BatchesPageResponseSchema = pageSchema(BatchInfoSchema)

/**
 * One row of `GET /api/batches/:id/artifacts` (plan 93 §3.13, §4.4, §4.7,
 * step 93.10) — a device-scoped artifact a batch's own member job produced
 * (F12's fix landed step 93.9: `registerDeviceArtifact` now takes the
 * pulling job's id, so this is a plain join from `artifacts.jobId` through
 * the batch's own `jobs` rows, never a second write path). `deviceLabel` and
 * `stableId` are denormalised from `devices` at read time — a device can be
 * renamed after the pull, and the archive's own directory names (below)
 * always want the CURRENT label. `contentUrl` is the SAME single-artifact
 * download `GET /api/artifacts/:id/content` already serves, so a Studio row
 * needs no second fetch shape for "download just this one".
 */
export const BatchArtifactSchema = z.object({
  artifactId: z.string(),
  jobId: z.string(),
  deviceId: z.string(),
  deviceLabel: z.string(),
  stableId: z.string(),
  /** The original remote filename (`artifacts.label`), never the on-disk epoch-prefixed name. */
  filename: z.string(),
  sizeBytes: z.number().nullable(),
  createdAt: z.number(),
  contentUrl: z.string(),
})
export type BatchArtifactInfo = z.infer<typeof BatchArtifactSchema>

/** `GET /api/batches/:id/artifacts` — unpaged, like `GET /:id`'s own `jobs` array: bounded by the batch's own member count, never an independent unbounded list (plan 30 §2 non-goals). */
export const BatchArtifactsResponseSchema = z.object({ items: z.array(BatchArtifactSchema) })
