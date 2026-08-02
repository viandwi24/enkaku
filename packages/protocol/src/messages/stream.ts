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

/** Rotation or resize — the frame dimensions changed. */
export const StreamMetaMessage = z.object({
  type: z.literal('stream.meta'),
  payload: z.object({ streamId: z.number().int(), width: z.number(), height: z.number() }),
})

/**
 * The session stopped server-side (device unplugged, capture failed
 * repeatedly). Without this message a viewer just sees the last frame freeze
 * and assumes the network is slow.
 */
export const StreamEndedMessage = z.object({
  type: z.literal('stream.ended'),
  payload: z.object({ deviceId: z.string(), reason: z.string() }),
})

/** Phases a session goes through before the first frame (Plan 17 §3.3). */
export const SessionPhaseSchema = z.enum([
  'connecting', // opening the adb transport
  'waking', // wake + keyguard + keep-awake
  'starting-video', // push jar, launch server, connect sockets
  'waiting-frame', // sockets up, no picture yet
  'ready', // first frame delivered
])
export type SessionPhase = z.infer<typeof SessionPhaseSchema>

export const SessionProgressMessage = z.object({
  type: z.literal('session.progress'),
  payload: z.object({
    deviceId: z.string(),
    phase: SessionPhaseSchema,
    /** Optional human-readable detail, e.g. 'ui-server fell back to dump'. */
    detail: z.string().optional(),
  }),
})
export type SessionProgress = z.infer<typeof SessionProgressMessage>
