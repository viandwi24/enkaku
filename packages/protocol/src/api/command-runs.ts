import { z } from 'zod'
import { CommandCountsSchema, CommandMemberSchema, CommandOutputSchema, CommandRunStatusSchema, CommandTargetSchema } from '../command/target'
import { pageSchema } from './pagination'

/**
 * `packages/core/src/api/command-runs.ts`'s response envelopes (plan 93
 * §4.3, §4.4, step 93.4).
 */

/** The list-page shape — no member bodies, matching `GET /api/batches` (plan 30). */
export const CommandRunSummarySchema = z.object({
  id: z.string(),
  cmd: z.string(),
  target: CommandTargetSchema,
  savedCommandId: z.string().nullable(),
  stageFirstN: z.number().int(),
  stage: z.number().int(),
  concurrency: z.number().int(),
  status: CommandRunStatusSchema,
  acknowledged: z.boolean(),
  createdBy: z.string().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  counts: CommandCountsSchema,
})
export type CommandRunSummary = z.infer<typeof CommandRunSummarySchema>

/**
 * `GET /api/command-runs/:id` — run plus every member (wire-shaped, no
 * stdout/stderr) plus every DISTINCT output preview, the fetch half of
 * fetch-then-subscribe (plan 93 §3.17, §4.4).
 */
export const CommandRunDetailSchema = CommandRunSummarySchema.extend({
  members: z.array(CommandMemberSchema),
  outputs: z.array(CommandOutputSchema),
})
export type CommandRunDetail = z.infer<typeof CommandRunDetailSchema>

/** `POST /api/command-runs` — the run and its initial (all-`pending`) members, plus every device the target excluded before it started (plan 93 §3.4, §4.4). */
export const CommandRunCreateResponseSchema = z.object({
  run: CommandRunSummarySchema,
  members: z.array(CommandMemberSchema),
  skipped: z.array(z.object({ deviceId: z.string(), reason: z.string() })),
})

export const CommandRunDetailResponseSchema = z.object({ run: CommandRunDetailSchema })

/** `POST .../cancel`, `POST .../continue` — the run's own current summary after the action. */
export const CommandRunActionResponseSchema = z.object({ run: CommandRunSummarySchema })

export const CommandRunDeleteResponseSchema = z.object({ deleted: z.boolean() })

/** `GET /api/command-runs?...` (keyset, `api/pagination.ts`). */
export const CommandRunsPageResponseSchema = pageSchema(CommandRunSummarySchema)
