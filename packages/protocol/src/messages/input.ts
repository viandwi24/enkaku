import { z } from 'zod'

/**
 * Manual input (spec §13) — coordinates are ALWAYS normalised 0..1 on the
 * client; the core maps them to device pixels (server-authoritative).
 */
export const NormPointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
export type NormPoint = z.infer<typeof NormPointSchema>

/**
 * A manual drag's real pointer trace (plan 40 §4.6) — batched to the
 * gesture sample interval on the client, then sent once, on pointer-up, the
 * same way `input.swipe` already was. `atMs` is elapsed time since the first
 * sample (always 0), not a wall-clock timestamp, so it survives clock skew
 * and needs no correction server-side.
 */
export const NormGestureSampleSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  atMs: z.number().min(0),
})
export type NormGestureSample = z.infer<typeof NormGestureSampleSchema>

/**
 * The five manual input verbs' bodies, declared once (plan 91 §4.4 — the same
 * "one schema, many consumers" shape `DEVICE_CALL_ARGS` already established,
 * F28). `InputTapMessage` … `InputGestureMessage` below are rebuilt from
 * these fields, WIRE-IDENTICAL to what shipped before this plan — every
 * existing input-message test still passes unchanged against the rebuilt
 * schemas. `MirrorActionSchema` (plan 91 §3.8, §4.4) is the second consumer:
 * the same five bodies, minus `deviceId` — a mirrored action fans out to
 * every live member of a group from one message, so the device id belongs on
 * each `MirrorResult` (`./co-control.ts`), never repeated on the action
 * itself.
 *
 * Each value here is a plain field map (not a `z.object()`), spread directly
 * into a message's `payload`, because `input.*`'s wire payload is flat
 * (`{ deviceId, pos }`, never `{ deviceId, args: { pos } }`) — unlike
 * `DEVICE_CALL_ARGS`, whose two consumers both nest their shared shape under
 * `args`/`.extend()`.
 */
export const INPUT_ACTION_BODIES = {
  tap: {
    pos: NormPointSchema,
    /**
     * Pointer down→up, measured on the client (plan 94 §4.4, closes F4 — a
     * long-press was previously inexpressible on the manual path at all).
     * Optional: absent on an older client, or on a synthesised action with no
     * real pointer to time. `ws-handlers.ts`'s `input.tap` branch then falls
     * back to the device's own `tapJitterMs` range — exactly what it already
     * does for a script's `tap()` call with no explicit hold duration
     * (closes F5: manual and scripted taps no longer silently disagree).
     * A press held past the recorder's own `longPressMs` setting is STILL
     * sent as `input.tap` — never a second message type; the duration alone
     * is what makes it a long-press (plan 94 §3.4, §4.6).
     */
    holdMs: z.number().int().min(0).max(60_000).optional(),
  },
  swipe: { from: NormPointSchema, to: NormPointSchema, durationMs: z.number().int().min(50).max(10_000).default(300) },
  gesture: { samples: z.array(NormGestureSampleSchema).min(2).max(300) },
  key: { keycode: z.number().int().min(0).max(320) },
  text: { text: z.string().min(1).max(1000) },
} as const

export const InputTapMessage = z.object({
  type: z.literal('input.tap'),
  payload: z.object({ deviceId: z.string(), ...INPUT_ACTION_BODIES.tap }),
})

export const InputSwipeMessage = z.object({
  type: z.literal('input.swipe'),
  payload: z.object({ deviceId: z.string(), ...INPUT_ACTION_BODIES.swipe }),
})

export const InputKeyMessage = z.object({
  type: z.literal('input.key'),
  payload: z.object({ deviceId: z.string(), ...INPUT_ACTION_BODIES.key }),
})

/**
 * `id` is REQUIRED (plan 90 §3.3, §4.5, §5 step 90.5) — unlike `input.tap`/`input.swipe`/
 * `input.key`, which are fire-and-forget, `input.text` is now request/reply so the client learns
 * which rung actually carried the text (`InputTextResultMessage.payload.via`) or why none could
 * (a named precondition on `ErrorMessage`, plan 59) — the same `id`-correlated shape
 * `clipboard.get`/`clipboard.set` already use (`./clipboard.ts`).
 */
export const InputTextMessage = z.object({
  type: z.literal('input.text'),
  id: z.string(),
  payload: z.object({ deviceId: z.string(), ...INPUT_ACTION_BODIES.text }),
})

/**
 * `input.text`'s reply (plan 90 §3.3, §4.5) — unicast to the requesting connection only, the same
 * pattern `ClipboardOkMessage` uses. `via` is the rung `resolveTextRoute` actually chose, so an
 * operator (or a plugin author debugging F26's class of confusion) can see which path ran instead
 * of inferring it from side effects.
 */
export const InputTextResultMessage = z.object({
  type: z.literal('input.text.result'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    via: z.enum(['agent-ime', 'scrcpy-text', 'adb-ascii']),
    /**
     * Always false today. The text ladder once had a fourth, clipboard-paste rung that would have
     * set this true, plus a `clipboard.overwritten` device event recorded alongside it; that rung
     * was proven architecturally unreachable in this codebase and removed
     * (docs/plans/96-m61-hotfixes.md §96.7, §96.8). Kept as a boolean rather than deleted, so no
     * existing client that reads it needs a breaking change.
     */
    clobberedClipboard: z.boolean(),
  }),
})

export const InputGestureMessage = z.object({
  type: z.literal('input.gesture'),
  payload: z.object({ deviceId: z.string(), ...INPUT_ACTION_BODIES.gesture }),
})

/**
 * One mirrored input action (plan 91 §3.8, §4.4) — verb-tagged, built from
 * the SAME five bodies `InputTapMessage`…`InputGestureMessage` use above, so
 * a mirrored action can never accept something a single-device action would
 * refuse (or vice versa). No `deviceId` here: `input.mirror`'s envelope
 * (`./co-control.ts`) carries one `groupId` and fans the action out to every
 * live member; the per-device outcome comes back as a `MirrorResult`.
 */
export const MirrorActionSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('tap'), ...INPUT_ACTION_BODIES.tap }),
  z.object({ verb: z.literal('swipe'), ...INPUT_ACTION_BODIES.swipe }),
  z.object({ verb: z.literal('gesture'), ...INPUT_ACTION_BODIES.gesture }),
  z.object({ verb: z.literal('key'), ...INPUT_ACTION_BODIES.key }),
  z.object({ verb: z.literal('text'), ...INPUT_ACTION_BODIES.text }),
])
export type MirrorAction = z.infer<typeof MirrorActionSchema>
