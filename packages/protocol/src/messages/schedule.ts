import { z } from 'zod'
import { BatchOrderSchema } from './batch'

/** Plan 21 §3.2 — three honest choices for a schedule due while its previous run is still going. */
export const OnOverlapSchema = z.enum(['skip', 'queue', 'cancel-previous'])
export type OnOverlap = z.infer<typeof OnOverlapSchema>

/** Plan 21 §3.4 — `once` collapses every missed fire into a single run; there is no "run all missed". */
export const CatchUpSchema = z.enum(['skip', 'once'])
export type CatchUp = z.infer<typeof CatchUpSchema>

/** Plan 21 §4.1 — one row per fire decision, including the ones that ran nothing. */
export const ScheduleRunOutcomeSchema = z.enum(['dispatched', 'skipped-overlap', 'skipped-missed', 'no-targets', 'error'])
export type ScheduleRunOutcome = z.infer<typeof ScheduleRunOutcomeSchema>

/** A schedule triggers a batch on a cron expression, in a stated timezone (plan 21 §1). */
export const ScheduleInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  cron: z.string(),
  timezone: z.string(),
  scriptId: z.string(),
  params: z.unknown(),
  clusterId: z.string().nullable(),
  deviceIds: z.array(z.string()),
  concurrency: z.number().int(),
  order: BatchOrderSchema,
  onOverlap: OnOverlapSchema,
  queueTimeoutSec: z.number().int().nullable(),
  catchUp: CatchUpSchema,
  jitterSec: z.number().int(),
  priority: z.number().int(),
  lastFiredAt: z.number().nullable(),
  lastBatchId: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  /** The next fire time, computed on read (plan 21 §4.4) — null if disabled or the cron is invalid. */
  nextFireAt: z.number().nullable().default(null),
})
export type ScheduleInfo = z.infer<typeof ScheduleInfoSchema>

export const ScheduleRunInfoSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  /** When it was due, not when it ran — jitter separates the two (plan 21 §3.6). */
  dueAt: z.number(),
  firedAt: z.number().nullable(),
  outcome: ScheduleRunOutcomeSchema,
  batchId: z.string().nullable(),
  detail: z.string().nullable(),
  missedCount: z.number().int(),
})
export type ScheduleRunInfo = z.infer<typeof ScheduleRunInfoSchema>

/** Broadcast on every fire decision, so the schedules screen updates without polling (plan 21 §4.5). */
export const ScheduleFiredMessage = z.object({
  type: z.literal('schedule.fired'),
  payload: z.object({
    scheduleId: z.string(),
    outcome: ScheduleRunOutcomeSchema,
    batchId: z.string().nullable().default(null),
    dueAt: z.number(),
  }),
})
export type ScheduleFiredEvent = z.infer<typeof ScheduleFiredMessage>
