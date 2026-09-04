import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { between, makeRng, pickWatchMs, sleep } from './human'
import { searchFor } from './search'
import { all } from './tree'
import { capture, frameOf, readGate, readableStrings, relaunch, TIKTOK_PACKAGE, verifiedSwipeUp } from './gesture'

/**
 * `keyword-videos` — search a keyword, open videos from the results, and
 * watch a few with human dwell.
 *
 * The hard measured fact this member is built around (2026-09-03, moto g06
 * power): TikTok's search results grid is Compose and exposes NOTHING to the
 * inspector — a loaded page of the query "live" dumped as 85 nodes with not
 * one label below the tab strip. A row cannot be picked by anchor, so rows are
 * picked by CELL: the grid is two columns over a known tab strip, and the cell
 * centres below are fractions of the real frame, chosen by the run's RNG. Each
 * tap is then PROVED two ways: the screen changed, and the opened player put
 * its readable action rail ("Sukai video. …", "Baca atau tambahkan
 * komentar. …") on the tree. A cell that satisfies neither is reported as a
 * miss, not counted as a play.
 *
 * This pack still writes nothing: no likes, no follows, no comments — the
 * house rule in index.ts holds; inside the player the script only watches and
 * swipes.
 */

const paramsSchema = z.object({
  query: z.string().min(1).describe('The keyword whose videos to watch.').meta(ui({ title: 'Keyword' })),
  videos: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3)
    .describe('How many videos to open and watch, counting from the ones that actually opened.')
    .meta(ui({ title: 'Videos to watch' })),
  maxMisses: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe('Stop after this many cell taps that opened nothing — the grid may have shifted, and a blind tap repeated forever is not browsing.')
    .meta(ui({ title: 'Max missed taps' })),
  keywordBoostFactor: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe('Watch-time TILT applied when the opened video\'s caption or author contains a keyword: probability mass shifts toward the long dwell buckets (the heavy-tailed shape is kept — a matched video is still sometimes skipped, exactly as a real viewer would).')
    .meta(ui({ title: 'Keyword dwell tilt' })),
  keywords: z.array(z.string()).default([]).describe('Keywords to hold attention on. Matched against the caption/hashtags and author read off the opened player.').meta(ui({ title: 'Keywords' })),
})

const resultSchema = z.object({
  query: z.string().meta(ui({ title: 'Keyword', summary: true })),
  played: z.number().int().describe('Videos confirmed on screen with the player rail visible.').meta(ui({ title: 'Played', summary: true })),
  misses: z.number().int().describe('Cell taps that produced no readable player.').meta(ui({ title: 'Misses', summary: true })),
  dwellLabels: z.array(z.string()).describe('The shape of each watch ("skip", "watch", "engaged", "hooked") — the uneven timing the run actually kept.').meta(ui({ title: 'Dwell' })),
  advanced: z.number().int().describe('In-player swipes verified to have changed the screen.').meta(ui({ title: 'Advanced' })),
  cells: z.array(z.string()).describe('Which grid cell (column,row) each tap aimed at — the geometry the run chose, stated as the inference it is.').meta(ui({ title: 'Cells tapped' })),
  keywordMatches: z.number().int().describe('Videos whose caption/author text matched a keyword and got the dwell tilt.').meta(ui({ title: 'Keyword matches', summary: true })),
})

function playerUp(tree: UiNode): boolean {
  return all(tree, (n) => /^(Sukai video|Baca atau tambahkan komentar|Bagikan video)\b/i.test(n.desc.trim())).length >= 2
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'keyword-videos',
  title: 'Watch keyword videos',
  node: { category: 'device', icon: 'search', summary: ['query', 'videos'], keywords: ['search', 'keyword', 'watch'] },
  description: 'Searches a keyword, opens videos from the results grid by measured cell geometry, and watches them with randomised dwell and verified swipes. Never likes, follows, or comments.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 30 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(Date.now() >>> 0)
    await searchFor(ctx, ctx.params.query, 'Video')
    await capture(ctx, 'results')
    const frame = await frameOf(ctx)

    let played = 0
    let misses = 0
    let advanced = 0
    let keywordMatches = 0
    const dwellLabels: string[] = []
    const cells: string[] = []

    while (played < ctx.params.videos) {
      ctx.progress({ played, misses, cells })
      // Two columns, two full rows below the tab strip (ends at y≈0.14h); cell centres are
      // fractions of the REAL frame, never hardcoded pixels — the same rule index.ts records for
      // the feed. Column x 0.27/0.73, row y 0.40/0.72 of height (both measured off the 720×1640 grid).
      const col = Math.floor(rng() * 2)
      const row = Math.floor(rng() * 2)
      cells.push(`${col + 1},${row + 1}`)
      // Cell centres, plus a random ±4% offset — an aimed-at cell hit at a different thumb spot every time.
      await ctx.device.tap({ point: { x: Math.round((col === 0 ? 0.27 : 0.73) * frame.width + between(rng, -0.04, 0.04) * frame.width), y: Math.round((row === 0 ? 0.4 : 0.72) * frame.height + between(rng, -0.03, 0.03) * frame.height) } })
      await sleep(between(rng, 2_500, 4_500))

      const opened = await readGate(ctx, playerUp, { budgetMs: 8_000 })
      if (!opened) {
        misses += 1
        ctx.log.warn(`keyword-videos: cell ${cells[cells.length - 1]} opened no readable player (miss ${misses}/${ctx.params.maxMisses})`)
        await ctx.artifact.screenshot(`miss-${misses}`)
        if (misses >= ctx.params.maxMisses) break
        continue
      }

      played += 1
      // Keyword tilt: the opened player's own words (caption, hashtags, author —
      // readable even when the results grid is not) decide the DWELL, never a
      // like. `pickWatchMs`'s tilt shifts probability mass toward the long
      // buckets while keeping the distribution lumpy: a matched video is still
      // sometimes skipped in a second, because no person is that consistent.
      const playerTree = await ctx.device.dump()
      const text = readableStrings(playerTree).join(' ')
      const matched = ctx.params.keywords.some((k) => k.trim() !== '' && text.toLowerCase().includes(k.toLowerCase()))
      if (matched) keywordMatches += 1
      const dwell = pickWatchMs(rng, matched ? ctx.params.keywordBoostFactor : 0)
      dwellLabels.push(`${dwell.label}${matched ? '+kw' : ''}`)
      await sleep(dwell.ms)

      // Swipe to the next video in the opened feed — TikTok continues the keyword flow upward once
      // a result is open; the swipe is randomised AND byte-verified, so a bounce-back is caught.
      if (played < ctx.params.videos) {
        if (await verifiedSwipeUp(ctx, frame, rng)) advanced += 1
        else ctx.log.warn('keyword-videos: the in-player swipe did not change the screen — re-checking the player before continuing')
      }
    }

    if (played === 0) {
      await ctx.artifact.screenshot('nothing-opened')
      throw new Error(`none of the ${cells.length} grid cells opened a readable player — see artifact nothing-opened`)
    }

    return { query: ctx.params.query, played, misses, dwellLabels, advanced, cells, keywordMatches }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(TIKTOK_PACKAGE)
  },
}

export default script
