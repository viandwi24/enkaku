import { z } from 'zod'
import { BatchInfoSchema } from '../messages/batch'
import { JobInfoSchema, JobStatusSchema } from '../messages/job'
import { ResultStatusSchema } from '../schema/result'
import { JsonSchemaNodeSchema } from './json-schema'
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
  /**
   * The device's HUMAN name, already composed with its number — `#7 Pixel 6`,
   * or the bare label for a device with no reservation (plan 124 §3.7, via
   * the core's `formatDeviceLabel`).
   *
   * Pre-composed here, unlike `DeviceRef.number`/`MirrorMember.number` which
   * carry the number as their own field, because this row has no other
   * identity a caller could compose against: a batch artifact outlives the
   * device that produced it, and the Studio table rendering it holds no
   * `DeviceInfo` for a device that has since been forgotten. A second
   * `deviceNumber` field would therefore be null exactly when it was needed.
   *
   * The archive route deliberately does NOT slug this string into its ZIP
   * entry names — see `collectBatchArtifacts` in
   * `packages/core/src/api/batches.ts`, which keeps the raw label for that
   * path (plan 124 §3.7: "a `#` in a filename is a new problem").
   */
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

/**
 * One member's own result, for the batch-wide results table (2026-08-28).
 *
 * Every member gets a row, always — a table that silently drops members is
 * worse than no table on a farm where "which three devices did not do the
 * thing" IS the question. `result` is what may be absent, and when it is,
 * `omitted` says why in a word rather than leaving a blank cell to be read as
 * "the script returned nothing".
 */
export const BatchMemberResultSchema = z.object({
  jobId: z.string(),
  deviceId: z.string(),
  batchSeq: z.number().int().nullable().default(null),
  status: JobStatusSchema,
  resultStatus: ResultStatusSchema.nullable().default(null),
  resultSummary: z.string().nullable().default(null),
  /** The script's own return value. Absent when `omitted` says so, and when the job has not settled. */
  result: z.unknown().optional(),
  /**
   * Why `result` is not here.
   *
   * - `budget` — the response hit its byte ceiling before reaching this row.
   *   `GET /api/jobs/:id` still has it; the row links there.
   * - `too-large` — this ONE result is bigger than the whole budget, so no
   *   response could ever carry it inline.
   * - `unfinished` — the job has not settled, so there is nothing to carry.
   */
  omitted: z.enum(['budget', 'too-large', 'unfinished']).optional(),
})
export type BatchMemberResult = z.infer<typeof BatchMemberResultSchema>

/**
 * `GET /api/batches/:id/results`.
 *
 * `resultSchema` is inlined here for the SAME reason `JobDetailSchema` inlines
 * it (plan 97 §4.6): a second fetch could resolve to a different script version
 * after a rollback, and the table would then render one version's values
 * through another version's schema. A batch pins one script version across
 * every member, so one schema is the correct shape.
 *
 * `omittedCount`/`budgetBytes` are reported, never implied. A results view that
 * quietly showed 37 of 40 rows' values would be the exact failure this repo has
 * paid for before (plan 134: an unmeasured thing must never read as a measured
 * one).
 */
export const BatchResultsResponseSchema = z.object({
  items: z.array(BatchMemberResultSchema),
  resultSchema: JsonSchemaNodeSchema.nullable().default(null),
  /** How many rows carry no `result`. Zero when every settled member's value fitted. */
  omittedCount: z.number().int(),
  /** The ceiling this response was assembled under, so the number above is legible rather than mysterious. */
  budgetBytes: z.number().int(),
})
export type BatchResultsResponse = z.infer<typeof BatchResultsResponseSchema>
