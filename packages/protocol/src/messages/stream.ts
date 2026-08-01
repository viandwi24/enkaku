import { z } from 'zod'

/** Stream video (spec §13). Request-reply pakai korelasi `id`. */

export const StreamStartMessage = z.object({
  type: z.literal('stream.start'),
  id: z.string(),
  payload: z.object({ deviceId: z.string() }),
})

export const StreamStartedMessage = z.object({
  type: z.literal('stream.started'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    streamId: z.number().int().min(0).max(255),
    codec: z.enum(['png', 'h264']),
    width: z.number(),
    height: z.number(),
  }),
})

export const StreamStopMessage = z.object({
  type: z.literal('stream.stop'),
  payload: z.object({ streamId: z.number().int() }),
})

/** Rotasi/resize — dimensi frame berubah. */
export const StreamMetaMessage = z.object({
  type: z.literal('stream.meta'),
  payload: z.object({ streamId: z.number().int(), width: z.number(), height: z.number() }),
})
