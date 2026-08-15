import { z } from 'zod'

/**
 * The recorder's WS surface (plan 94 §3.10, §4.9, step 94.3) — three
 * client→server messages and two server→client ones. `packages/protocol/src/
 * recording.ts` (step 94.1) already declared the DOCUMENT a recording
 * compiles to; this file is only the live control channel while one is open.
 *
 * There is exactly one active recording per device, held by whoever holds
 * that device's manual lease — `recording.start`/`.stop`/`.cancel` are gated
 * by the SAME `checkInputAllowed` gate `input.*` already uses
 * (`packages/core/src/lease/lease-manager.ts`), never a parallel check (plan
 * 94's own brief: "if you find yourself writing a second permission check,
 * stop and report").
 */

// ---- client -> server ----

/**
 * Opens a recording on `deviceId`. Refused `E_RECORDING_ACTIVE` when one is
 * already open on this device (plan 94 §4.6) — never silently joined or
 * restarted; refused with the lease's own codes (`no_lease`,
 * `not_lease_holder`, `device_busy`, `device_unavailable`) when the caller
 * does not hold input on this device at all.
 */
export const RecordingStartMessage = z.object({
  type: z.literal('recording.start'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

/**
 * Ends the recording normally and resolves it into a `RecordingDoc` (§4.6's
 * `finishAndBuild`). A no-op error (`E_NO_RECORDING`) when nothing is open on
 * this device.
 */
export const RecordingStopMessage = z.object({
  type: z.literal('recording.stop'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

/** Discards the recording in progress — no document is built. Same `E_NO_RECORDING` refusal as `recording.stop` when nothing is open. */
export const RecordingCancelMessage = z.object({
  type: z.literal('recording.cancel'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

// ---- server -> client ----

/**
 * Why a recording ended on its own, without an explicit `recording.stop`
 * (plan 94 §4.6's bounds, §4.9). Absent on a plain operator-requested stop —
 * a recording that ends because it was asked to has nothing to explain.
 */
export const RecordingStoppedReasonSchema = z.enum(['max-steps', 'max-duration', 'lease-lost'])
export type RecordingStoppedReason = z.infer<typeof RecordingStoppedReasonSchema>

/**
 * Reply to `recording.start`/`.stop`/`.cancel`, and a push whenever a bound
 * (§4.6) or a lease loss ends the recording without one. `startedAt` is null
 * exactly when `active` is false. `stepCount` is live — it is also pushed on
 * a cadence independent of `recording.step` (below) so a client that only
 * cares about the count/duration does not need to count `recording.step`
 * pushes itself.
 */
export const RecordingStateMessage = z.object({
  type: z.literal('recording.state'),
  id: z.string().optional(),
  payload: z.object({
    deviceId: z.string(),
    active: z.boolean(),
    stepCount: z.number().int().nonnegative(),
    startedAt: z.number().int().nullable(),
    stoppedReason: RecordingStoppedReasonSchema.optional(),
  }),
})

/**
 * A wire-owned copy of `RecordingStepSchema`'s `kind` literals
 * (`./recording.ts`) — the same "a wire message owns its own vocabulary,
 * independent of the internal type that happens to produce it today"
 * reasoning `AssistEndReasonSchema` (`./co-control.ts`) already documents for
 * its own duplicated enum.
 */
export const RecordingStepKindWireSchema = z.enum(['tap', 'longPress', 'gesture', 'swipe', 'key', 'text'])

/**
 * Pushed once per step as a recording fills in (plan 94 §4.10 — the record
 * mode's step strip). Deliberately thin: no target, no screenshot, no
 * candidate — a client that wants the full step waits for the finished
 * `RecordingDoc` (`recording.stop`'s resolution, step 94.5's review panel).
 * `hasCandidate` alone is enough for the step strip to show a dot.
 */
export const RecordingStepMessage = z.object({
  type: z.literal('recording.step'),
  payload: z.object({
    deviceId: z.string(),
    index: z.number().int().nonnegative(),
    kind: RecordingStepKindWireSchema,
    hasCandidate: z.boolean(),
  }),
})
