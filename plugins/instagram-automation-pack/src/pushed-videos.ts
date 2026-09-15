import type { ScriptContext } from '@enkaku/sdk'

/**
 * The videos this pack's `post-video` pushed onto the phone, cleaned up (the owner, 2026-09-16: old video files pile up).
 *
 * Every run pushes its video to `/sdcard/DCIM/Camera/ig-<job id>-<attempt>.<ext>` and nothing ever removed it. Before
 * pushing the next one, this deletes the files THIS pack pushed that are older than `PUSHED_VIDEO_MAX_AGE_SEC` — never a
 * fresh one, because the app may still be uploading from it in the background, and never a file of any other name, so
 * a person's own camera roll is never touched. Best effort: a phone whose listing or delete fails still posts.
 */
export const PUSHED_VIDEO_DIR = '/sdcard/DCIM/Camera'
/** Six hours: far past any upload this farm has seen finish, and short enough that a busy phone never holds more than a day's worth. */
export const PUSHED_VIDEO_MAX_AGE_SEC = 6 * 60 * 60
const PUSHED_NAME = /^ig-[0-9a-f]{8}-[0-9a-f-]{27}-\d+\.(mp4|mov|m4v|webm|mkv|3gp)$/i

export interface PushedVideoEntry {
  name: string
  path: string
  kind: 'file' | 'dir' | 'other'
  modifiedAt: number | null
}

/** Which of `entries` are this pack's own pushed videos older than `maxAgeSec`. An unknown age is never old. */
export function stalePushedVideos(entries: readonly PushedVideoEntry[], nowSec: number, maxAgeSec: number = PUSHED_VIDEO_MAX_AGE_SEC): PushedVideoEntry[] {
  return entries.filter((e) => e.kind === 'file' && PUSHED_NAME.test(e.name) && e.modifiedAt !== null && nowSec - e.modifiedAt > maxAgeSec)
}

/** Delete this pack's stale pushed videos from the phone. Never throws. Returns how many were deleted. */
export async function removeStalePushedVideos(ctx: ScriptContext<unknown>): Promise<number> {
  try {
    const listing = await ctx.device.fs.list({ path: PUSHED_VIDEO_DIR, limit: 1_000 })
    const stale = stalePushedVideos(listing.entries, Math.floor(Date.now() / 1000))
    let removed = 0
    for (const entry of stale) {
      try {
        await ctx.device.fs.delete({ path: entry.path })
        removed += 1
      } catch (err) {
        ctx.log.warn('could not delete an old pushed video', { path: entry.path, error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (removed > 0) ctx.log.info(`deleted ${removed} old pushed video(s) from the phone`, { dir: PUSHED_VIDEO_DIR })
    return removed
  } catch (err) {
    ctx.log.warn('could not look for old pushed videos on the phone — posting anyway', { error: err instanceof Error ? err.message : String(err) })
    return 0
  }
}
