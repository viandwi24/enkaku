import { z } from 'zod'
import { BatchOrderSchema } from './batch'
import { ScriptRefSchema } from '../script-ref'

/** Plan 21 §3.2 — three honest choices for a schedule due while its previous run is still going. */
export const OnOverlapSchema = z.enum(['skip', 'queue', 'cancel-previous'])
export type OnOverlap = z.infer<typeof OnOverlapSchema>

/** Plan 21 §3.4 — `once` collapses every missed fire into a single run; there is no "run all missed". */
export const CatchUpSchema = z.enum(['skip', 'once'])
export type CatchUp = z.infer<typeof CatchUpSchema>

/**
 * Plan 21 §4.1 — one row per fire decision, including the ones that ran
 * nothing. `spend-cap` (plan 68 §3.3) is its own outcome, distinct from the
 * generic `error` — a schedule refused because the farm-wide ceiling is
 * reached is not malfunctioning, it is doing exactly what it was configured
 * to do.
 */
export const ScheduleRunOutcomeSchema = z.enum(['dispatched', 'skipped-overlap', 'skipped-missed', 'no-targets', 'spend-cap', 'error'])
export type ScheduleRunOutcome = z.infer<typeof ScheduleRunOutcomeSchema>

/**
 * A schedule's work (plan 68 §3.1, §4.1) — a discriminated pair, so one
 * scheduling model (cron, timezone, overlap, jitter, priority, expiry — all
 * of Plan 21) covers both a script and an agent. `ScheduleInfo` ALSO keeps
 * the flat `scriptRef`/`params` fields for backward compatibility with
 * every existing script-schedule caller (Studio, `POST /api/schedules`) —
 * populated only when `target.kind === 'script'`, null for an agent target.
 */
export const ScheduleWorkTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('script'), ref: ScriptRefSchema, params: z.unknown().optional() }),
  z.object({ kind: z.literal('agent'), agentId: z.string().min(1), prompt: z.string().min(1) }),
])
export type ScheduleWorkTarget = z.infer<typeof ScheduleWorkTargetSchema>

/** Plan 68 §3.2 — `new` (default): a fresh thread per firing. `continue`: one long-lived thread. */
export const ScheduleThreadModeSchema = z.enum(['new', 'continue'])
export type ScheduleThreadMode = z.infer<typeof ScheduleThreadModeSchema>

/**
 * Plan 68 §3.5 — `deny` (default): a destructive call is refused at once
 * with a truthful `tool_result`, and the run continues. `pause`: the
 * ordinary approval gate, waits for a human, expires as Plan 66 defines.
 */
export const OnApprovalRequiredSchema = z.enum(['deny', 'pause'])
export type OnApprovalRequired = z.infer<typeof OnApprovalRequiredSchema>

/** A schedule triggers a batch or an agent run on a cron expression, in a stated timezone (plan 21 §1, plan 68 §3.1). */
export const ScheduleInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  cron: z.string(),
  timezone: z.string(),
  /** The work this schedule triggers (plan 68 §3.1). */
  target: ScheduleWorkTargetSchema,
  /** `name@version` or `name@latest` (plan 62 §3.3) — populated only for a `target.kind === 'script'` schedule; null for an agent target. Kept for backward compatibility alongside `target` above. */
  scriptRef: ScriptRefSchema.nullable(),
  params: z.unknown().nullable(),
  clusterId: z.string().nullable(),
  deviceIds: z.array(z.string()),
  concurrency: z.number().int(),
  order: BatchOrderSchema,
  onOverlap: OnOverlapSchema,
  queueTimeoutSec: z.number().int().nullable(),
  catchUp: CatchUpSchema,
  jitterSec: z.number().int(),
  priority: z.number().int(),
  /** Plan 68 §3.2 — only meaningful for an agent target. */
  threadMode: ScheduleThreadModeSchema,
  /** The reused thread when `threadMode === 'continue'`; null otherwise, or before the first firing. */
  threadId: z.string().nullable(),
  /** Plan 68 §3.5 — only meaningful for an agent target. */
  onApprovalRequired: OnApprovalRequiredSchema,
  lastFiredAt: z.number().nullable(),
  lastBatchId: z.string().nullable(),
  /** Plan 68 §4.2 — the most recent agent run this schedule started, for overlap tracking. */
  lastAgentRunId: z.string().nullable(),
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
