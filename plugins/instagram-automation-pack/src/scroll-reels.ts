import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { INSTAGRAM_PACKAGE, capture, openTab, relaunch } from './instagram'
import { makeRng } from './behavior'
import { inReelsViewer, watchReels } from './reels'

/**
 * `scroll-reels` — browse the Reels tab with human-shaped dwell and randomised
 * verified swipes. When a reel's caption, author, or audio contains any of the
 * operator's keywords, the chance of liking and opening the comments is
 * boosted (keyword tilt — the base probability stays untouched on non-matches).
 *
 * The viewer loop lives in `reels.ts` (shared with `explore-reels`). Measured
 * first on OPPO CPH2173 (1080×2412, 2026-09-04) and again on the owner's moto
 * g06 power (Instagram 446.0, 2026-09-14): `like_button` "Suka",
 * `comment_button` "Komentar", `clips_author_username`.
 */

const paramsSchema = z.object({
  reels: z.number().int().min(1).max(80).default(10).describe('Max reels to view.').meta(ui({ title: 'Reels to watch' })),
  likeProbability: z.number().min(0).max(1).default(0.1).describe('Base chance to press like on a reel (confirmed by reading the button again; never a sponsored one).').meta(ui({ title: 'Like chance' })),
  commentProbability: z.number().min(0).max(1).default(0.05).describe('Base chance to open the comment sheet, read it and close it. Never types.').meta(ui({ title: 'Comment chance' })),
  keywordBoostFactor: z.number().min(1).max(10).default(3).describe('Multiplier applied to like/comment chance when a keyword matches the reel.').meta(ui({ title: 'Keyword boost' })),
  keywords: z.array(z.string()).default([]).describe('Keywords to tilt behaviour toward. A reel whose caption or author contains any of these gets the boosted chance.').meta(ui({ title: 'Keywords' })),
  seed: z.number().int().min(0).default(0).describe('RNG seed; 0 derives one from the job so every run differs.').meta(ui({ title: 'Seed (0 = random)' })),
})

const resultSchema = z.object({
  reelsViewed: z.number().int().meta(ui({ title: 'Viewed', summary: true })),
  advanced: z.number().int().meta(ui({ title: 'Advanced', summary: true })),
  liked: z.number().int().describe('Likes confirmed on the button.').meta(ui({ title: 'Liked', summary: true })),
  likes: z.array(z.enum(['liked', 'already-liked', 'no-button', 'not-confirmed', 'sponsored'])).describe('One outcome per attempted like.').meta(ui({ title: 'Like outcomes' })),
  commentsOpened: z.number().int().meta(ui({ title: 'Comments', summary: true })),
  keywordMatches: z.number().int().describe('Reels whose text contained at least one keyword.').meta(ui({ title: 'Keyword matches', summary: true })),
  dwellLabels: z.array(z.string()).meta(ui({ title: 'Dwell' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'scroll-reels',
  icon: 'activity',
  node: { category: 'device', icon: 'activity', summary: ['reels'], keywords: ['instagram', 'reels', 'scroll', 'warm-up'] },
  title: 'Scroll Reels',
  description: 'Browses Instagram Reels with randomised verified swipes. Keywords in caption/author boost like & comment probability.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 45 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(ctx.params.seed || (Date.now() ^ Number(ctx.job.attempt)) >>> 0)
    const steps: string[] = []

    const reels = await openTab(ctx, 'clips_tab', inReelsViewer, 20_000)
    if (!reels.ok) {
      await capture(ctx, 'ig-reels-not-open', reels.tree)
      throw new Error('the Reels tab did not show a playing reel — see artifact ig-reels-not-open')
    }
    steps.push('reels-tab')

    const watched = await watchReels(ctx, {
      count: ctx.params.reels,
      likeProbability: ctx.params.likeProbability,
      commentProbability: ctx.params.commentProbability,
      keywords: ctx.params.keywords,
      keywordBoostFactor: ctx.params.keywordBoostFactor,
      rng,
      steps,
    })
    steps.push('done')
    return {
      reelsViewed: watched.viewed,
      advanced: watched.advanced,
      liked: watched.likes.filter((l) => l === 'liked').length,
      likes: watched.likes,
      commentsOpened: watched.commentsOpened,
      keywordMatches: watched.keywordMatches,
      dwellLabels: watched.dwellLabels,
      steps,
    }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE).catch(() => {})
  },
}

export default script
