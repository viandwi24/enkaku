import { z } from 'zod'

/**
 * The device power state Enkaku persists on a phone, and what it found there
 * first (plan 125 §3.3, §4.1).
 *
 * Kept in its own protocol file, like `readiness.ts` beside it and for the
 * same reason: `settings.ts` needs `AwakeApplyResult`-adjacent types for the
 * `prep` block, `device.ts` will need `ObservedScreen` for
 * `DeviceReadinessSchema` (plan 125 step 125.3), and `device.ts` already
 * imports FROM `settings.ts`, so the reverse import would have cycled.
 *
 * Why these live in `@enkaku/protocol` at all rather than next to the code
 * that writes them: `packages/core/src/device/awake-policy.ts` persists a
 * `CapturedPowerState` into a JSON DB column, and CLAUDE.md's rule is that a
 * JSON column is external input — it must come back through Zod, never an
 * `as`-cast. `packages/session/src/power.ts` (the transport-level writer)
 * cannot import from `packages/core`, so the shared shape has to sit in the
 * package both of them already depend on.
 *
 * ### The constraint these types exist to enforce (plan 125 §0.2)
 *
 * The owner's phones live in a sealed phone-farm box: no screen, no hands.
 * The recovery cost of a bad device write is **hardware disassembly**. So
 * every write this subsystem makes is read back and verified before it may
 * be reported as applied, is revertible over adb alone, and never touches
 * Wi-Fi, network configuration, or lock-screen credentials (plan 125 §3.4
 * refuses that whole category outright). `AwakeApplyOutcome` below is the
 * shape of that promise: there is no outcome that means "we wrote it and did
 * not look".
 */

/**
 * What actually happened to ONE setting.
 *
 * - `applied` — we wrote it AND read the new value straight back off the
 *   device. This is the only value that may be reported as success.
 * - `unchanged` — the device already held the value we wanted (or we were
 *   asked to leave it alone), so no write was issued. Also success, and
 *   deliberately distinct from `applied`: skipping the write is how the
 *   1422 ms `svc power stayon` measured in plan 96 §22 stops being paid on
 *   every wake of an already-held device.
 * - `refused` — the write was issued and the read-back did not agree, or the
 *   read-back itself could not be performed. NEVER `applied`. This is plan
 *   125 acceptance criterion 4, and it is the same discipline
 *   `packages/session/src/screen-label.ts`'s `verified: false` already
 *   follows for the lock-screen label tier (plan 89 §3.5).
 */
export const AwakeApplyOutcomeSchema = z.enum(['applied', 'unchanged', 'refused'])
export type AwakeApplyOutcome = z.infer<typeof AwakeApplyOutcomeSchema>

/**
 * What the phone had before Enkaku touched it, so "restore" is a real
 * operation and not a guess (plan 125 §3.3 — the gap plan 89 §3.6 records
 * for the wallpaper tier, deliberately not repeated here).
 *
 * Both values are nullable because "could not be read" is a real answer on a
 * device that is offline, mid-boot, or running a ROM that hides the key.
 * `packages/core/src/device/awake-policy.ts` NEVER persists a capture in
 * which both are null — a null-null capture would satisfy the
 * never-overwrite rule forever and permanently destroy any chance of a real
 * one.
 */
export const CapturedPowerStateSchema = z.object({
  /** `settings get system screen_off_timeout`, in milliseconds. null = could not be read. */
  screenOffTimeoutMs: z.number().int().nullable(),
  /**
   * `settings get global stay_on_while_plugged_in`, kept as the RAW string
   * the device printed rather than a parsed integer.
   *
   * Deliberate: this is what `restore` writes back verbatim, and the value is
   * a bitmask (`BATTERY_PLUGGED_AC=1 | USB=2 | WIRELESS=4 | DOCK=8`) whose
   * set of meaningful bits differs across Android versions. Round-tripping
   * the device's own literal string is the only way to guarantee that what we
   * put back is byte-for-byte what we found — plan 125 acceptance criterion 3.
   */
  stayOnWhilePluggedIn: z.string().nullable(),
  /** Unix seconds (CLAUDE.md: every timestamp in this codebase is integer unix seconds). */
  capturedAt: z.number().int(),
})
export type CapturedPowerState = z.infer<typeof CapturedPowerStateSchema>

/**
 * An OBSERVED screen state (plan 125 §3.6) — the answer to "is this panel
 * lit", asked of the phone itself.
 *
 * `unknown` is a first-class outcome and must never be rendered as `off`
 * (plan 125 acceptance criterion 5). The reason it needs saying: plan 125
 * §0.3 found that `readiness.actual` is pure bookkeeping — `asleep` there
 * means "this core has no session open and has not itself called
 * `wakeDevice`", and says nothing whatsoever about the phone. The whole point
 * of this type is to stop the UI asserting things it never checked, so a
 * probe that could not run has to be able to say so.
 */
export const ObservedScreenSchema = z.object({
  state: z.enum(['on', 'off', 'unknown']),
  /** Why, when `state` is `unknown` — or what the device actually printed, when it is not. Null when there is nothing to add. */
  reason: z.string().nullable(),
  /** Unix seconds. */
  observedAt: z.number().int(),
})
export type ObservedScreen = z.infer<typeof ObservedScreenSchema>

/**
 * The result of one `apply`/`restore` pass: one outcome per setting written,
 * never a single boolean, because the two writes fail independently — a ROM
 * that ignores `screen_off_timeout` may still honour `svc power stayon`, and
 * an operator staring at a boxed phone deserves to know which half took.
 */
export const AwakeApplyResultSchema = z.object({
  screenOffTimeout: AwakeApplyOutcomeSchema,
  stayOn: AwakeApplyOutcomeSchema,
  /** Human-readable, and only ever set when something was refused or skipped for a reason worth naming. */
  reason: z.string().nullable(),
})
export type AwakeApplyResult = z.infer<typeof AwakeApplyResultSchema>
