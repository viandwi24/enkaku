import { z } from 'zod'

/**
 * Device readiness (plan 43 §3.1, §3.2): a SECOND axis beside `DeviceStatus`,
 * never merged into it — `DeviceStatus` feeds the scheduler (`idle` means
 * "eligible for a job"), and overloading it with "asleep"/"awake" would make
 * every `status === 'idle'` check ambiguous. A device can be `idle` + `hot`,
 * `busy` + `hot`, or `idle` + `asleep` — both axes stay meaningful.
 *
 * Kept in its own file (rather than `device.ts` or `settings.ts`) so both can
 * import it without a cycle: `settings.ts` needs it for
 * `readiness.defaultDesired`, and `device.ts` needs it for `DeviceInfo` and
 * the WS messages — `device.ts` already imports FROM `settings.ts`
 * (`BatteryStateSchema`), so the reverse import would have cycled.
 */
export const ReadinessSchema = z.enum(['asleep', 'awake', 'hot'])
export type Readiness = z.infer<typeof ReadinessSchema>

/** Why `actual` cannot reach `desired` right now (plan 43 §4.1). */
export const ReadinessBlockedReasonSchema = z.enum(['offline', 'quarantined', 'hot_budget_full', 'locked', 'error'])
export type ReadinessBlockedReason = z.infer<typeof ReadinessBlockedReasonSchema>

/**
 * `desired` is persisted and survives a restart; `actual` is re-derived from
 * live session state on every read and NEVER persisted (plan 43 §3.3) — a
 * restart must re-derive it, never restore it, or the UI could show a state
 * that is not real.
 */
export const DeviceReadinessSchema = z.object({
  /** What was asked for; persisted. */
  desired: ReadinessSchema,
  /** What is true now; derived, never stored. */
  actual: ReadinessSchema,
  /** Set when `actual` cannot reach `desired`. */
  blocked: ReadinessBlockedReasonSchema.nullable().default(null),
  /** Unix seconds the `actual` level was reached. */
  since: z.number().int(),
})
export type DeviceReadiness = z.infer<typeof DeviceReadinessSchema>
