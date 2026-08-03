import { z } from 'zod'

/**
 * Manual input (spec §13) — coordinates are ALWAYS normalised 0..1 on the
 * client; the core maps them to device pixels (server-authoritative).
 */
export const NormPointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
export type NormPoint = z.infer<typeof NormPointSchema>

export const InputTapMessage = z.object({
  type: z.literal('input.tap'),
  payload: z.object({ deviceId: z.string(), pos: NormPointSchema }),
})

export const InputSwipeMessage = z.object({
  type: z.literal('input.swipe'),
  payload: z.object({
    deviceId: z.string(),
    from: NormPointSchema,
    to: NormPointSchema,
    durationMs: z.number().int().min(50).max(10_000).default(300),
  }),
})

export const InputKeyMessage = z.object({
  type: z.literal('input.key'),
  payload: z.object({ deviceId: z.string(), keycode: z.number().int().min(0).max(320) }),
})

export const InputTextMessage = z.object({
  type: z.literal('input.text'),
  payload: z.object({ deviceId: z.string(), text: z.string().min(1).max(1000) }),
})

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

export const InputGestureMessage = z.object({
  type: z.literal('input.gesture'),
  payload: z.object({ deviceId: z.string(), samples: z.array(NormGestureSampleSchema).min(2).max(300) }),
})
