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

/** `POST /api/batches/:id/cancel`. */
export const BatchCancelResponseSchema = z.object({ cancelled: z.number() })

/** `GET /api/batches?...` (keyset). */
export const BatchesPageResponseSchema = pageSchema(BatchInfoSchema)
