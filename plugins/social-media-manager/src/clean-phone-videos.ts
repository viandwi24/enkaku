import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * `clean-phone-videos` — remove the videos the farm's post scripts left on this phone (0.35.0).
 *
 * The owner (2026-09-16): old video files pile up. Every `post-video` run pushes its video to `/sdcard/DCIM/Camera` as
 * `post-<job>-<attempt>` (TikTok), `ig-…` (Instagram) or `yt-…` (YouTube). The packs now delete their own stale files
 * before each push; this member is the on-demand sweep the Cleanup tab sends to the phones picked — every farm-pushed
 * video older than `olderThanHours`, never a fresh one an app may still be uploading from, and never any other file,
 * so a person's own camera roll is never touched. A dry run only counts.
 */

export const PHONE_VIDEO_DIR = '/sdcard/DCIM/Camera'
const FARM_PUSHED = /^(post|ig|yt)-[0-9a-f]{8}-[0-9a-f-]{27}-\d+\.(mp4|mov|m4v|webm|mkv|3gp)$/i

export interface PhoneFileEntry {
  name: string
  path: string
  kind: 'file' | 'dir' | 'other'
  sizeBytes: number | null
  modifiedAt: number | null
}

/** The farm-pushed videos among `entries` older than `olderThanSec`. An unknown age is never old. */
export function stalePhoneVideos(entries: readonly PhoneFileEntry[], nowSec: number, olderThanSec: number): PhoneFileEntry[] {
  return entries.filter((e) => e.kind === 'file' && FARM_PUSHED.test(e.name) && e.modifiedAt !== null && nowSec - e.modifiedAt > olderThanSec)
}

const params = z.object({
  olderThanHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(6)
    .describe('Only videos pushed longer ago than this are deleted, so an upload still in progress keeps its file.')
    .meta(ui({ title: 'Older than (hours)' })),
  dryRun: z.boolean().default(false).describe('Count the videos and their size, deleting nothing.').meta(ui({ title: 'Dry run' })),
})

const result = z.object({
  found: z.number().int().meta(ui({ title: 'Found', summary: true })),
  removed: z.number().int().meta(ui({ title: 'Removed', summary: true })),
  bytes: z.number().int().describe('The size of what was found (dry run) or removed.').meta(ui({ title: 'Bytes' })),
  failed: z.array(z.string()).describe('Files that could not be deleted, with the reason.').meta(ui({ title: 'Failed' })),
  truncated: z.boolean().describe('The folder held more files than one listing reads; run it again to reach the rest.').meta(ui({ title: 'More left' })),
  reason: z.string().meta(ui({ title: 'Reason', summary: true })),
})

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'clean-phone-videos',
  title: 'Clean phone videos',
  description: 'Deletes the videos the farm\'s post scripts pushed onto this phone (post-/ig-/yt- files in DCIM/Camera) older than the hours given. Never touches any other file.',
  icon: 'x',
  node: { category: 'device', icon: 'x', summary: ['found', 'removed'], keywords: ['cleanup', 'videos', 'storage'] },
  params,
  result,
  timeout: 5 * 60_000,

  async run(ctx) {
    const listing = await ctx.device.fs.list({ path: PHONE_VIDEO_DIR, limit: 1_000 })
    const stale = stalePhoneVideos(listing.entries, Math.floor(Date.now() / 1000), ctx.params.olderThanHours * 3600)
    const size = (list: readonly PhoneFileEntry[]): number => list.reduce((n, e) => n + (e.sizeBytes ?? 0), 0)
    if (ctx.params.dryRun || stale.length === 0) {
      const reason = stale.length === 0 ? 'no old farm videos on this phone' : `dry run: would delete ${stale.length} video(s), ${megabytes(size(stale))}`
      return { found: stale.length, removed: 0, bytes: size(stale), failed: [], truncated: listing.truncated, reason }
    }
    const removed: PhoneFileEntry[] = []
    const failed: string[] = []
    for (const entry of stale) {
      try {
        await ctx.device.fs.delete({ path: entry.path })
        removed.push(entry)
      } catch (err) {
        failed.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    ctx.log.info(`deleted ${removed.length} farm video(s) from the phone`, { bytes: size(removed), failed: failed.length })
    const reason = `deleted ${removed.length} video(s), ${megabytes(size(removed))} freed${failed.length > 0 ? `; ${failed.length} could not be deleted` : ''}`
    return { found: stale.length, removed: removed.length, bytes: size(removed), failed, truncated: listing.truncated, reason }
  },
}

export default script
