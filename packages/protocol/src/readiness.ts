import { z } from 'zod'
import { ObservedScreenSchema } from './power'

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
 *
 * ### Why `observed` sits BESIDE `actual` and never replaces it (plan 125 §4.2)
 *
 * They answer two different questions, and collapsing them would lose one of
 * the answers:
 *
 * - `actual` is the scheduling-relevant BOOKKEEPING value the whole system
 *   already reasons about — "does this core hold a session or a keep-awake for
 *   this device". Plan 125 §0.3 quotes `rawActual` complete to make the point:
 *   it says nothing whatsoever about the phone, and it was never meant to.
 *   Every `readiness.actual === 'asleep'` check in Studio and in the core
 *   depends on exactly that meaning, so it keeps it.
 * - `observed` is what the phone itself answered when we asked (plan 125 §3.6)
 *   — the first thing in this codebase that actually probes `dumpsys power`.
 *   It is what the UI may show a human, and it is allowed to disagree with
 *   `actual`: a phone whose screen is genuinely lit reads `actual: 'asleep'`
 *   whenever this core did not light it.
 *
 * `null` means "no probe has ever been taken for this device", and an
 * `ObservedScreen` whose `state` is `unknown` means "we asked and could not
 * tell". Neither may be rendered as `off` (plan 125 acceptance criterion 5) —
 * the same discipline plan 89 §3.5 applies to `unavailable`, and the same
 * reason `deriveHealth` refuses to word `unverified` as success.
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
  /**
   * The last screen observation (plan 125 §3.6, §4.2), or `null` when none was
   * ever taken. Derived like `actual`, never persisted.
   *
   * **Deliberately `.optional()` rather than `.default(null)`**, unlike
   * `blocked` above, and for the reason plan 125 §10 already records for
   * `myUserId` in 125.5: a required output field would have forced a
   * mechanical edit to ~30 Studio test files that build a `DeviceInfo`
   * literal, several of them in another worker's territory mid-flight, for
   * zero behavioural gain. An omitted value is field-for-field identical to
   * `null` — every core producer (`computeReadiness`,
   * `staticReadinessFallback`) writes the key explicitly, so the wire always
   * carries it; only hand-written literals may leave it out.
   */
  observed: ObservedScreenSchema.nullable().optional(),
})
export type DeviceReadiness = z.infer<typeof DeviceReadinessSchema>
