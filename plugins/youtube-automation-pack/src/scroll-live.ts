import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { capture, firstMatch, sleep, tapNode, waitForTree, YOUTUBE_PACKAGE } from './youtube'
import { flatten } from './tree'
import { SEARCH_ENTRY, SEARCH_FIELD, adEvidence, clickableFor, hasResultRows, playerEvidence, skipControlOf, titleFromRow } from './search-channel'
import { between, browseComments, bytesEqual, keywordBoost, makeRng, pick, pressLike, readableStrings } from './behavior'

/**
 * `scroll-live` — browse the list of LIVE streams, then optionally open one
 * and watch it.
 *
 * The list is reached through search (the query defaults to "live") — the one
 * path measured to work on this farm's app build without depending on an A/B'd
 * channel tab. Browsing is randomised flings with human dwell between them,
 * each one byte-verified to actually have moved the list; opening is a pick
 * among the rows the list itself marks LIVE, so the run never claims to have
 * watched a live stream from a recorded upload.
 */

const paramsSchema = z.object({
  query: z
    .string()
    .min(1)
    .default('live')
    .describe('What to search for; the list scrolled is the search results for this.')
    .meta(ui({ title: 'Search query' })),
  scrolls: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(8)
    .describe('Randomised flings down the results before opening a stream (or before finishing, when not opening).')
    .meta(ui({ title: 'Scrolls' })),
  open: z
    .enum(['none', 'first-live', 'random-live'])
    .default('first-live')
    .describe('Stop after browsing, or open a row the list itself marks as LIVE.')
    .meta(ui({ title: 'Open a stream', labels: { none: 'No — browse only', 'first-live': 'The first live row', 'random-live': 'A random live row' } })),
  watchMs: z
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(45_000)
    .describe('How long to stay on the stream once opened. Ignored when not opening.')
    .meta(ui({ title: 'Watch for (ms)' })),
  skipAds: z.boolean().default(true).describe('Press YouTube\'s own "Skip ad" control when an advert runs.').meta(ui({ title: 'Skip skippable ads' })),
  likeProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Chance to press like while on the stream. A signed-out device reports `not-signed-in`, never a fake like.')
    .meta(ui({ title: 'Like chance' })),
  commentProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Chance to open the comment section, scroll it, and close it. Reading only.')
    .meta(ui({ title: 'Comment chance' })),
  keywordBoostFactor: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe('Multiplier applied to like/comment chance when a keyword matches the stream title or channel.')
    .meta(ui({ title: 'Keyword boost' })),
  keywords: z.array(z.string()).default([]).describe('Keywords to tilt behaviour toward; matched against the stream title read off its row.').meta(ui({ title: 'Keywords' })),
  seed: z.number().int().min(0).default(0).describe('RNG seed; 0 derives one per run.').meta(ui({ title: 'Seed (0 = random)' })),
})

const resultSchema = z.object({
  query: z.string().meta(ui({ title: 'Query' })),
  scrollsDone: z.number().int().describe('Flings completed down the list.').meta(ui({ title: 'Scrolls done', summary: true })),
  liveRowsSeen: z.number().int().describe('The largest number of LIVE-marked rows seen on one screen during the browse.').meta(ui({ title: 'Live rows seen', summary: true })),
  opened: z.boolean().describe('Whether a stream was opened and a player confirmed on screen.').meta(ui({ title: 'Opened', summary: true })),
  streamTitle: z.string().describe('The stream that opened, read off its own row. Empty when nothing qualified.').meta(ui({ title: 'Stream' })),
  openEvidence: z.string().describe('What proved a live stream was on screen, or why nothing opened.').meta(ui({ title: 'Evidence', summary: true })),
  like: z.string().describe('Outcome of the like attempt, or `not attempted`.').meta(ui({ title: 'Like' })),
  comments: z.string().describe('Outcome of the comment visit, or `not attempted`.').meta(ui({ title: 'Comments' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

/**
 * Does this node's own words mark a LIVE stream? Measured 2026-09-03 off the
 * failing job 51835e76's artifact: a live row reads
 * `Live Streaming tvOne 24 Jam - … - 4 ribu sedang menonton - Live - putar video`,
 * so the badge is a `- Live -` SEGMENT of the row's description — and there is
 * a companion node, `Ketuk untuk menonton livestream, channel …`. The first
 * version looked for the word LIVE on the `thumbnail_layout` nodes
 * `resultRowsOf` returns, whose descriptions are empty; a list full of live
 * streams read as having none.
 */
function liveSignal(n: UiNode): boolean {
  const d = n.desc.trim()
  if (d === '') return false
  return /[-–]\s*live\b|livestream|live stream|sedang menonton|watching now|langsung\b/i.test(d)
}

function liveRows(tree: UiNode): UiNode[] {
  return flatten(tree).filter((n) => n.clickable && liveSignal(n))
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'scroll-live',
  title: 'Scroll live streams',
  description: 'Searches for LIVE streams, scrolls the results with randomised flings and human dwell, and optionally opens one and watches.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 20 * 60_000,

  async prepare(ctx) {
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    await ctx.device.app.launch(YOUTUBE_PACKAGE)
    await sleep(5_000)
  },

  async run(ctx) {
    const rng = makeRng(ctx.params.seed || Date.now() >>> 0)
    const steps: string[] = []
    const fail = (step: string, message: string): never => {
      steps.push(`${step}: FAILED`)
      throw new Error(`${message} (steps: ${steps.join(' → ')})`)
    }

    // --- search -------------------------------------------------------------
    const home = await capture(ctx, '01-home')
    const entry = firstMatch(home, SEARCH_ENTRY)
    if (!entry) fail('open-search', 'no search button on the YouTube home screen — see artifact 01-home')
    await tapNode(ctx, entry!.node)
    await sleep(between(rng, 1_200, 2_000))
    const screen = await capture(ctx, '02-search-open')
    const field = firstMatch(screen, SEARCH_FIELD)
    if (!field) fail('type-query', 'the search screen opened with no text field — see artifact 02-search-open')
    await tapNode(ctx, field!.node)
    await sleep(between(rng, 400, 800))
    await ctx.device.type(ctx.params.query)
    await ctx.device.key('ENTER')

    const loaded = await waitForTree(ctx, hasResultRows, { budgetMs: 30_000 })
    await capture(ctx, '03-results', loaded.tree)
    steps.push(loaded.ok ? 'results' : 'results(timeout)')
    if (!loaded.ok) fail('results', `no result rows appeared within the budget — see artifact 03-results`)

    // --- browse the list ------------------------------------------------------
    let tree = loaded.tree
    let liveSeen = 0
    let scrollsDone = 0
    for (let i = 0; i < ctx.params.scrolls; i++) {
      ctx.progress({ scroll: i + 1, of: ctx.params.scrolls, steps })
      liveSeen = Math.max(liveSeen, liveRows(tree).length)
      if (ctx.params.open !== 'none' && liveSeen > 0 && i >= 2) break

      const before = await ctx.device.screenshot()
      await ctx.device.fling({ direction: 'down', strength: pick(rng, ['soft', 'normal', 'hard'] as const) })
      await sleep(between(rng, 1_400, 3_600))
      const moved = !bytesEqual(before, await ctx.device.screenshot())
      scrollsDone += 1
      tree = await capture(ctx, `04-browse-${i + 1}`)
      liveSeen = Math.max(liveSeen, liveRows(tree).length)
      steps.push(`scroll ${i + 1}${moved ? '' : ' (no move)'}`)
    }

    if (ctx.params.open === 'none') {
      steps.push('browse-only')
      await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
      return { query: ctx.params.query, scrollsDone, liveRowsSeen: liveSeen, opened: false, streamTitle: '', openEvidence: 'not requested', like: 'not attempted', comments: 'not attempted', steps }
    }

    // --- open one live row ----------------------------------------------------
    const candidates = liveRows(tree)
    if (candidates.length === 0) {
      await capture(ctx, '05-no-live')
      fail('pick-live', 'the list never showed a row marked LIVE within the scroll budget — see artifact 05-no-live')
    }
    const chosen = ctx.params.open === 'random-live' ? pick(rng, candidates) : (candidates[0] as UiNode)
    const streamTitle = titleFromRow(chosen)
    await tapNode(ctx, chosen.clickable ? chosen : clickableFor(tree, chosen))

    const playing = await waitForTree(ctx, (t) => playerEvidence(t).playing, { budgetMs: 30_000 })
    const player = await capture(ctx, '06-player', playing.tree)
    steps.push(playing.ok ? 'player' : 'player(timeout)')
    const evidence = playerEvidence(player)
    if (!evidence.playing) fail('verify-player', 'a live row was tapped but nothing that looks like a player appeared — see artifact 06-player')
    const openEvidence = flatten(player).some(liveSignal) ? `${evidence.via} + LIVE badge` : `${evidence.via} (no LIVE badge visible on the player)`

    // --- advert, if any, then watch --------------------------------------------
    if (adEvidence(player).ad) {
      const started = Date.now()
      let cleared = false
      while (Date.now() - started < 60_000) {
        const t = await ctx.device.dump()
        if (!adEvidence(t).ad) {
          cleared = true
          break
        }
        if (ctx.params.skipAds) {
          const skip = skipControlOf(t)
          if (skip) {
            await tapNode(ctx, skip)
            await sleep(700)
            continue
          }
        }
        await sleep(1_000)
      }
      steps.push(cleared ? 'ad-cleared' : 'ad(timeout)')
    }

    steps.push('watching')
    let like = 'not attempted'
    let comments = 'not attempted'
    const tiltText = `${streamTitle} ${ctx.params.query} ${readableStrings(player).join(' ')}`
    const likeP = keywordBoost(tiltText, ctx.params.keywords, ctx.params.likeProbability, ctx.params.keywordBoostFactor)
    const comP = keywordBoost(tiltText, ctx.params.keywords, ctx.params.commentProbability, ctx.params.keywordBoostFactor)
    const until = Date.now() + ctx.params.watchMs
    while (Date.now() < until) {
      await sleep(between(rng, 3_000, 8_000))
      if (like === 'not attempted' && rng() < likeP) {
        like = await pressLike(ctx, rng)
        steps.push(`like:${like}`)
      }
      if (comments === 'not attempted' && rng() < comP) {
        comments = await browseComments(ctx, rng, { scrollTimes: 4 })
        steps.push(`comments:${comments}`)
      }
    }
    steps.push('watched')

    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    return { query: ctx.params.query, scrollsDone, liveRowsSeen: liveSeen, opened: true, streamTitle, openEvidence, like, comments, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
  },
}

export default script
