import { z } from 'zod'

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
