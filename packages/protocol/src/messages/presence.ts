import { z } from 'zod'

/** Who is watching a device, live (plan 31 §4.1). */

export const ViewerSchema = z.object({
  /** The WS connection id. Stable for the life of the tab. */
  sessionId: z.string(),
  /** Display name; null in local mode where there is one implicit admin. */
  userLabel: z.string().nullable(),
  /** Unix seconds — when this viewer opened the stream. */
  since: z.number(),
  /** Exactly one viewer in the list may be true. */
  holdsControl: z.boolean(),
})
export type Viewer = z.infer<typeof ViewerSchema>

export const DeviceViewersMessage = z.object({
  type: z.literal('device.viewers'),
  payload: z.object({ deviceId: z.string(), viewers: z.array(ViewerSchema) }),
})
export type DeviceViewersEvent = z.infer<typeof DeviceViewersMessage>

/**
 * Sent once, right after the WS opens, so the client can mark "this tab" in
 * its own viewer list without guessing (plan 31 §4.1). Small on purpose —
 * any future per-connection feature can piggyback on it.
 */
export const HelloMessage = z.object({
  type: z.literal('hello'),
  payload: z.object({ sessionId: z.string() }),
})
export type HelloEvent = z.infer<typeof HelloMessage>
