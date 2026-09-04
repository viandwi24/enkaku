import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { flatten } from './tree'
import {
  between, frameOf, IG, keywordBoost, makeRng, pickDwell, readableStrings,
  sleep, sweepAck, tapNodeJittered, verifiedSwipeUp,
} from './behavior'

/**
 * `scroll-reels` — browse Instagram Reels with human-shaped dwell and randomised
 * verified swipes.  When a reel's caption, author, or audio title contains any of
 * the operator's keywords, the chance of liking and opening the comments is
 * boosted (keyword tilt — the base probability stays untouched on non-matches).
 *
 * Measured on OPPO CPH2173 (1080×2412), Indonesian locale, 2026-09-04:
 * like button `like_button` desc "Suka", comment button `comment_button` "Komentar",
 * caption in `clips_caption_component`, author in `clips_author_username`.
 * The like toggle goes to "Batal suka" when pressed (or stays "Suka" when already
 * liked) — the script reads the state to avoid double-taps.
 */

const paramsSchema = z.object({
  reels: z.number().int().min(1).max(80).default(10).describe('Max reels to view.').meta(ui({ title: 'Reels to watch' })),
  likeProbability: z.number().min(0).max(1).default(0.1).describe('Base chance to press like on a reel.').meta(ui({ title: 'Like chance' })),
  commentProbability: z.number().min(0).max(1).default(0.05).describe('Base chance to open the comment sheet.').meta(ui({ title: 'Comment chance' })),
  keywordBoostFactor: z.number().min(1).max(10).default(3).describe('Multiplier applied to like/comment chance when a keyword matches the reel.').meta(ui({ title: 'Keyword boost' })),
  keywords: z.array(z.string()).default([]).describe('Keywords to tilt behaviour toward. A reel whose caption or author contains any of these gets the boosted chance.').meta(ui({ title: 'Keywords' })),
})

const resultSchema = z.object({
  reelsViewed: z.number().int().meta(ui({ title: 'Viewed', summary: true })),
  advanced: z.number().int().meta(ui({ title: 'Advanced', summary: true })),
  liked: z.number().int().meta(ui({ title: 'Liked', summary: true })),
  commentsOpened: z.number().int().meta(ui({ title: 'Comments', summary: true })),
  keywordMatches: z.number().int().describe('Reels whose text contained at least one keyword.').meta(ui({ title: 'Keyword matches', summary: true })),
  dwellLabels: z.array(z.string()).meta(ui({ title: 'Dwell' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

function reelText(tree: UiNode): string {
  return readableStrings(tree, 0).join(' ')
}

function likeState(tree: UiNode): 'liked' | 'not-liked' | 'unknown' {
  const nodes = flatten(tree).filter((n) => {
    const v = n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top
    return v && n.resourceId.includes('like_button')
  })
  for (const n of nodes) {
    const d = n.desc.trim().toLowerCase()
    if (d.includes('batal suka') || d.includes('unlike')) return 'liked'
    if (d === 'suka' || d === 'like') return 'not-liked'
  }
  return 'unknown'
}

function likeButtonOf(tree: UiNode): UiNode | null {
  return flatten(tree).find((n) => n.resourceId.includes('like_button') && n.clickable) ?? null
}

function commentButtonOf(tree: UiNode): UiNode | null {
  return flatten(tree).find((n) => n.resourceId.includes('comment_button') && n.clickable) ?? null
}

/** Close the comment sheet — measured on hardware: the X / back area or the swipe-down handle. */
async function closeComments(ctx: ScriptContext<unknown>, rng: () => number): Promise<void> {
  await ctx.device.key('BACK')
  await sleep(between(rng, 600, 1_200))
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'scroll-reels',
  title: 'Scroll Reels',
  description: 'Browses Instagram Reels with randomised verified swipes. Keywords in caption/author boost like & comment probability.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 45 * 60_000,

  async prepare(ctx) {
    await ctx.device.app.forceStop(IG)
    await ctx.device.app.launch(IG)
    await sleep(5_000)
  },

  async run(ctx) {
    const rng = makeRng(Date.now() >>> 0)
    const steps: string[] = []
    const dwellLabels: string[] = []
    let liked = 0, commentsOpened = 0, advanced = 0, kwMatches = 0, viewed = 0

    // Navigate to Reels tab
    const home = await ctx.device.dump()
    const clipsTab = flatten(home).find((n) => n.resourceId.endsWith('clips_tab') && n.clickable)
    if (!clipsTab) throw new Error('clips_tab not on bottom nav — see first artifact')
    await tapNodeJittered(ctx, clipsTab)
    await sleep(between(rng, 4_000, 7_000))
    sweepAck(ctx).catch(() => {})
    steps.push('reels-tab')

    const frame = await frameOf(ctx)

    for (let i = 0; i < ctx.params.reels; i++) {
      ctx.progress({ reel: i + 1, of: ctx.params.reels, liked, commentsOpened })
      viewed += 1
      const tree = await ctx.device.dump()
      const text = reelText(tree)
      const matched = ctx.params.keywords.length > 0 && ctx.params.keywords.some((k) => k.trim() !== '' && text.toLowerCase().includes(k.toLowerCase()))
      if (matched) kwMatches += 1
      const likeP = keywordBoost(text, ctx.params.keywords, ctx.params.likeProbability, ctx.params.keywordBoostFactor)
      const comP = keywordBoost(text, ctx.params.keywords, ctx.params.commentProbability, ctx.params.keywordBoostFactor)

      const dwell = pickDwell(rng)
      dwellLabels.push(dwell.label)
      await sleep(dwell.ms)

      if (rng() < likeP && likeState(tree) === 'not-liked') {
        const btn = likeButtonOf(tree)
        if (btn) { await tapNodeJittered(ctx, btn); liked += 1; steps.push(`like:${matched ? 'kw-boosted' : 'base'}`); await sleep(600) }
      }
      if (rng() < comP) {
        const btn = commentButtonOf(tree)
        if (btn) { await tapNodeJittered(ctx, btn); commentsOpened += 1; steps.push(`comment:${matched ? 'kw-boosted' : 'base'}`); await closeComments(ctx, rng) }
      }
      if (i < ctx.params.reels - 1) {
        if (await verifiedSwipeUp(ctx, frame, rng)) advanced += 1
        else { steps.push(`stuck at reel ${i + 1}`); break }
      }
    }
    steps.push('done')
    return { reelsViewed: viewed, advanced, liked, commentsOpened, keywordMatches: kwMatches, dwellLabels, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(IG)
  },
}

export default script
