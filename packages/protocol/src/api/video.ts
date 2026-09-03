import { z } from 'zod'
import { QualitySchema } from '../messages/stream'

/**
 * `POST /api/video/reprofile` (plan 92 §3.8, §4.5, §5 step 92.2) — restarts
 * every open session whose resolved video profile no longer matches the
 * numbers it was built with, carrying subscribers and refcount across the
 * restart. `restarted`/`skippedBusy` are device ids, in no particular order;
 * `unchanged` is a count only (nobody needs to enumerate the sessions that
 * did nothing). Both the manual "apply now" call and the automatic,
 * debounced `settingsStore.onChange` path in `daemon.ts` produce this exact
 * shape — one function (`SessionManager.reprofile`), two callers.
 */
export const VideoReprofileResponseSchema = z.object({
  /** Device ids whose session was restarted to pick up the new numbers. */
  restarted: z.array(z.string()),
  /** Device ids skipped because a job is running (spec §10.1) — never restarted mid-job. */
  skippedBusy: z.array(z.string()),
  /** Open sessions whose resolved profile already matched — nothing to do. */
  unchanged: z.number().int(),
})
export type VideoReprofileResponse = z.infer<typeof VideoReprofileResponseSchema>

/**
 * `GET /api/video/latency?deviceId=<id>` (plan 203 §4.7): the server-side
 * leg of the latency picture, per open `(deviceId, quality)` entry. Nothing
 * here is persisted; a core restart clears it. `streams` is empty for a
 * device with no open session, never a 404: the question "what is open" has
 * an answer either way.
 */
export const VideoLatencyStreamSchema = z.object({
  quality: QualitySchema,
  /** Subscribers on this entry (the entry's refcount). */
  viewers: z.number().int(),
  frames: z.number().int(),
  firstFrameMs: z.number().nullable(),
  ptsIntervalMsP50: z.number(),
  ptsIntervalMsP95: z.number(),
  arrivalJitterMsP95: z.number(),
  lastFrameAgeMs: z.number().nullable(),
  /** `RESET_VIDEO` requests sent for this stream: congestion recoveries, joins, and visibility keyframes. */
  keyframeRequests: z.number().int(),
  /** Frames dropped by the drop-to-keyframe backpressure rule. */
  congestionDrops: z.number().int(),
})
export const VideoLatencyResponseSchema = z.object({
  deviceId: z.string(),
  /** Unix ms at which the snapshot was taken. */
  at: z.number().int(),
  streams: z.array(VideoLatencyStreamSchema),
})
export type VideoLatencyResponse = z.infer<typeof VideoLatencyResponseSchema>
