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
