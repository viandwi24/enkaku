import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { relaunch, TIKTOK_PACKAGE } from './gesture'
import { clearDrafts, clearOverFeed, draftsPhrase, measureFrame } from './post-video'

/**
 * `clear-drafts` — delete every TikTok draft on the phone's current account, on its own (1.46.0).
 *
 * The owner asked (2026-09-16) for draft cleaning as a script of its own on every platform, triggered from the Social
 * Media Manager page, while `post-video` moved its own cleaning to AFTER posting. This is `post-video`'s `clearDrafts`
 * unchanged — own profile → "Draf: N" → "Pilih" → "Pilih semua" → "Hapus" → the confirmation's own "Hapus" — so the two
 * can never disagree about what a draft or a deletion looks like. A dry run opens select mode, backs out, and reports
 * the count. Deleting a draft is permanent.
 */

const paramsSchema = z.object({
  dryRun: z
    .boolean()
    .default(false)
    .describe('Open the Drafts folder and its select mode, report how many drafts there are, and delete nothing.')
    .meta(ui({ title: 'Dry run' })),
})

const resultSchema = z.object({
  found: z.number().int().nullable().describe('How many drafts the account had; null when the count could not be read.').meta(ui({ title: 'Found', summary: true })),
  removed: z.number().int().nullable().describe('How many were deleted — 0 in a dry run.').meta(ui({ title: 'Removed', summary: true })),
  dryRun: z.boolean().meta(ui({ title: 'Dry run' })),
  reason: z.string().meta(ui({ title: 'Reason' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'clear-drafts',
  title: 'Clear drafts',
  description: 'Deletes every TikTok draft on this phone\'s account (Profil → Draf → Pilih semua → Hapus). Permanent. A dry run only counts them.',
  icon: 'x',
  node: { category: 'device', icon: 'x', summary: ['found', 'removed'], keywords: ['drafts', 'clean', 'delete'] },
  params: paramsSchema,
  result: resultSchema,
  timeout: 5 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const frame = await measureFrame(ctx)
    await clearOverFeed(ctx, 'opening the own profile')
    const drafts = await clearDrafts(ctx, { frame, dryRun: ctx.params.dryRun })
    const reason =
      drafts.found === 0 ? 'no drafts to delete' : ctx.params.dryRun ? `dry run: would delete ${draftsPhrase(drafts.found)}` : `deleted ${draftsPhrase(drafts.removed)}`
    return { ...drafts, reason }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })
  },
}

export default script
