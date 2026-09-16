import { z } from 'zod'

/** Stream video (spec §13). Request-reply pakai korelasi `id`. */

/**
 * The session's video quality profile (Plan 42 §3.5, §4.5): `control` is the
 * device page's full-fidelity picture; `wall` is a low-rate profile for the
 * fleet Wall, so many tiles can decode at once without saturating the
 * browser or the network. Reuse rules live in `@enkaku/session`'s manager —
 * this schema only carries the request/response, never decides anything.
 */
export const QualitySchema = z.enum(['control', 'wall'])
export type Quality = z.infer<typeof QualitySchema>

export const StreamStartMessage = z.object({
  type: z.literal('stream.start'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    /** Defaults to `control` server-side when omitted (every pre-plan-42 caller). */
    quality: QualitySchema.optional(),
  }),
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
    /** The quality this viewer is receiving RIGHT NOW. `wall` for a `control` request while `substitute` is set. */
    quality: QualitySchema,
    /**
     * MVP 11 §1.2: a `control` request is served by the always-on wall encoder until the
     * control encoder's first keyframe; the switch is announced by `stream.meta` carrying
     * `quality: 'control'`. Absent for a `wall` request and once the switch has happened.
     */
    substitute: z.literal('wall').optional(),
    /** The device cannot run a second scrcpy encoder (its display engine is not scrcpy); the viewer stays on `wall`. */
    degradedReason: z.literal('control_encoder_unavailable').optional(),
    degradedDetail: z.string().optional(),
  }),
})

export const StreamStopMessage = z.object({
  type: z.literal('stream.stop'),
  payload: z.object({ streamId: z.number().int() }),
})

/**
 * "An operator is opening Device Control on this device — start its control
 * encoder now."
 *
 * Fire-and-forget, the same shape as `stream.stop`, and it starts nothing the
 * `stream.start` behind it would not have started anyway: the control encoder
 * used to begin building only when the viewer's `stream.start` reached
 * `SessionManager.attachViewer`, so the whole window mount, the device fetch,
 * the decoder construction and one WS round-trip were spent before the build
 * had even been asked for. Sending this on the OPEN GESTURE instead overlaps
 * all of that with the build, and the sharp picture replaces the wall stand-in
 * that much sooner.
 *
 * Deliberately not sent on hover, and never for a wall tile: a control encoder
 * is a second scrcpy process on the phone, so it is started for an explicit
 * "open this device" and nothing else. Safe to repeat — the server-side path
 * no-ops when the entry exists or its build is already in flight.
 */
export const StreamPrepareMessage = z.object({
  type: z.literal('stream.prepare'),
  payload: z.object({ deviceId: z.string() }),
})

/**
 * Ask the encoder for a fresh IDR without restarting the stream (Plan 42
 * §4.1) — sent when a hidden `<video>` becomes visible again: browsers may
 * throttle a hidden canvas/video, so the first frame after unhiding can be
 * stale. Fire-and-forget, the same shape as `stream.stop`; a stream id the
 * server no longer recognises (already stopped) is silently ignored.
 */
export const StreamKeyframeMessage = z.object({
  type: z.literal('stream.keyframe'),
  payload: z.object({ streamId: z.number().int() }),
})

/** Rotation, resize, or the encoder switch (MVP 11 §1.2): `quality` is set only on a switch. */
export const StreamMetaMessage = z.object({
  type: z.literal('stream.meta'),
  payload: z.object({
    streamId: z.number().int(),
    width: z.number(),
    height: z.number(),
    quality: QualitySchema.optional(),
    /** Set with `quality: 'wall'` when the control encoder failed after `substitute` was reported. */
    detail: z.string().optional(),
  }),
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

/** Phases of one session build, in order (plan 206 §3.3). Internal to `@enkaku/session`; no message carries it. */
export const SessionPhaseSchema = z.enum([
  'connecting', // opening the adb transport
  'waking', // wake + keyguard + keep-awake
  'starting-video', // push jar, launch server, connect sockets
  'waiting-frame', // sockets up, no picture yet
  'ready', // first frame delivered
])
export type SessionPhase = z.infer<typeof SessionPhaseSchema>
