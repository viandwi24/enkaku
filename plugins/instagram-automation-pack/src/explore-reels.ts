import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { all, treeFrame } from './tree'
import { INSTAGRAM_PACKAGE, backToNav, capture, centre, openTab, relaunch, waitForTree } from './instagram'
import { makeRng } from './behavior'
import { inReelsViewer, watchReels } from './reels'

/**
 * `explore-reels` — open a reel from the Explore grid and keep watching.
 *
 * The Explore grid (`search_tab`, "Cara dan Jelajahi") names each cell
 * "Reel dari <author> di Baris R, Kolom C" or "Foto oleh <author> pada Baris
 * R, Kolom C" — measured on the owner's moto g06 power, Instagram 446.0,
 * 2026-09-14 (`__fixtures__/screen-explore.json`). A reel opened from there
 * plays in the ordinary Reels viewer under a "Jelajahi" header, so the watching
 * itself is `reels.ts`, shared with `scroll-reels`.
 *
 * A different entry into Reels than the Reels tab: Explore is where an account
 * that has watched nothing yet gets shown what the platform thinks it likes.
 */

const paramsSchema = z.object({
  reels: z.number().int().min(1).max(60).default(8).describe('How many reels to watch after opening one from Explore.').meta(ui({ title: 'Reels to watch' })),
  likeProbability: z.number().min(0).max(1).default(0.1).describe('Chance to like a reel (confirmed by reading the button again; never a sponsored one).').meta(ui({ title: 'Like chance' })),
  commentProbability: z.number().min(0).max(1).default(0.05).describe('Chance to open the comment sheet, read it, and close it. Never types.').meta(ui({ title: 'Comment chance' })),
  keywordBoostFactor: z.number().min(1).max(10).default(3).describe('Multiplier applied to like/comment chance when a keyword matches the reel.').meta(ui({ title: 'Keyword boost' })),
  keywords: z.array(z.string()).default([]).describe('A reel whose author, caption or audio contains any of these gets the boosted chance.').meta(ui({ title: 'Keywords' })),
  seed: z.number().int().min(0).default(0).describe('RNG seed; 0 derives one from the job so every run differs.').meta(ui({ title: 'Seed (0 = random)' })),
})

const resultSchema = z.object({
  opened: z.string().describe('The Explore cell that was opened.').meta(ui({ title: 'Opened', summary: true })),
  reelsViewed: z.number().int().meta(ui({ title: 'Viewed', summary: true })),
  advanced: z.number().int().meta(ui({ title: 'Advanced' })),
  likes: z.array(z.enum(['liked', 'already-liked', 'no-button', 'not-confirmed', 'sponsored'])).meta(ui({ title: 'Likes', summary: true })),
  commentsOpened: z.number().int().meta(ui({ title: 'Comments' })),
  keywordMatches: z.number().int().meta(ui({ title: 'Keyword matches', summary: true })),
  authors: z.array(z.string()).meta(ui({ title: 'Authors' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

/** The Explore grid's reel cells (photos left out), top-left first. */
export function exploreReelCells(tree: UiNode): UiNode[] {
  return all(tree, (n) => n.clickable && /^(reel dari|reel by)\s/i.test(n.desc.trim()))
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'explore-reels',
  icon: 'search',
  node: { category: 'device', icon: 'search', summary: ['reels'], keywords: ['instagram', 'explore', 'reels', 'warm-up'] },
  title: 'Explore reels',
  description: 'Opens a random reel from the Explore grid and keeps watching, with optional confirmed likes and comment reading.',
  params: paramsSchema,
  /*
    Its own memory limit (feed loops, 2026-09-21). Every member on the production fleet starts at about
    170 MB before it has done anything, and the farm's default limit is 256 MB. A member that scrolls a
    feed for many minutes, comparing a screenshot before and after every swipe, measured a p90 near
    250 MB and peaks of 260-278 MB, and was killed for it mid-run. Raised for the feed loops only.
  */
  runtime: { maxRssBytes: 512 * 1024 * 1024 },
  result: resultSchema,
  timeout: 30 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(ctx.params.seed || (Date.now() ^ Number(ctx.job.attempt)) >>> 0)
    const steps: string[] = []

    const grid = await openTab(ctx, 'search_tab', (t) => exploreReelCells(t).length >= 2, 20_000)
    if (!grid.ok) {
      await capture(ctx, 'ig-explore-grid', grid.tree)
      throw new Error('the Explore grid did not show any reel — see artifact ig-explore-grid')
    }
    steps.push('explore')

    let opened = ''
    let tree = grid.tree
    for (let attempt = 0; attempt < 2 && opened === ''; attempt++) {
      const h = treeFrame(tree).height
      const cells = exploreReelCells(tree).filter((n) => n.bounds.bottom < h * 0.88)
      if (cells.length === 0) break
      const cell = cells[Math.floor(rng() * cells.length)] as UiNode
      await ctx.device.tap({ point: centre(cell) })
      const viewer = await waitForTree(ctx, inReelsViewer, { budgetMs: 15_000 })
      if (viewer.ok) opened = cell.desc
      else {
        steps.push(`cell did not open: ${cell.desc.slice(0, 60)}`)
        tree = await backToNav(ctx)
      }
    }
    if (opened === '') {
      await capture(ctx, 'ig-explore-not-opened')
      throw new Error('tapped an Explore reel twice and the Reels viewer never opened — see artifact ig-explore-not-opened')
    }
    steps.push('viewer')

    const watched = await watchReels(ctx, {
      count: ctx.params.reels,
      likeProbability: ctx.params.likeProbability,
      commentProbability: ctx.params.commentProbability,
      keywords: ctx.params.keywords,
      keywordBoostFactor: ctx.params.keywordBoostFactor,
      rng,
      steps,
    })
    await backToNav(ctx)
    steps.push('done')
    return {
      opened,
      reelsViewed: watched.viewed,
      advanced: watched.advanced,
      likes: watched.likes,
      commentsOpened: watched.commentsOpened,
      keywordMatches: watched.keywordMatches,
      authors: watched.authors,
      steps,
    }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE).catch(() => {})
  },
}

export default script
