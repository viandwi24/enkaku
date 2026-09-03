import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { capture, firstMatch, sleep, tapNode, waitForTree, YOUTUBE_PACKAGE } from './youtube'
import { SEARCH_ENTRY, SEARCH_FIELD, adEvidence, clickableFor, hasResultRows, playerEvidence, resultRowsOf, skipControlOf, titleFromRow } from './search-channel'
import { between, browseComments, makeRng, pressLike } from './behavior'

/**
 * `search-play` — search for a video and play one from the ranked results.
 *
 * `pick: 'random'` chooses uniformly among the FIRST PAGE the results showed,
 * which is what "a random one from the results" means to the person typing the
 * query: rank-ordered until the screen ends. `pick: 'top'` takes row 0. The
 * advert that runs before the video is waited out (and optionally dismissed
 * via YouTube's own Skip control), the watch clock only starts after it, and
 * the like/comment chances behave exactly as in `scroll-shorts` — including
 * the honest `not-signed-in` when the account sheet answers.
 */

const paramsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('What to search for.')
    .meta(ui({ title: 'Search query' })),
  pick: z
    .enum(['random', 'top'])
    .default('random')
    .describe('Play a random video from the first page of ranked results, or the top result.')
    .meta(ui({ title: 'Which result', labels: { random: 'Random from the first page', top: 'The top result' } })),
  watchMs: z
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(30_000)
    .describe('How long to watch after any advert clears.')
    .meta(ui({ title: 'Watch for (ms)' })),
  skipAds: z.boolean().default(true).describe('Press YouTube\'s own "Skip ad" control when it appears. Only that button.').meta(ui({ title: 'Skip skippable ads' })),
  likeProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Chance to press like during the watch. A signed-out device reports `not-signed-in`.')
    .meta(ui({ title: 'Like chance' })),
  commentProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Chance to open the comment section, scroll it, and close it. Reading only.')
    .meta(ui({ title: 'Comment chance' })),
  seed: z.number().int().min(0).default(0).describe('RNG seed; 0 derives one per run.').meta(ui({ title: 'Seed (0 = random)' })),
})

const resultSchema = z.object({
  query: z.string().meta(ui({ title: 'Query' })),
  resultCount: z.number().int().describe('How many result rows the first page showed.').meta(ui({ title: 'Results' })),
  pickedRank: z.number().int().describe('1-based rank of the row that was opened. Always 1 when `pick` was `top`.').meta(ui({ title: 'Picked rank', summary: true })),
  played: z.boolean().describe('Whether a player was confirmed on screen.').meta(ui({ title: 'Played', summary: true })),
  videoTitle: z.string().describe('The video that opened, read off its own row before the tap.').meta(ui({ title: 'Video', summary: true })),
  playEvidence: z.string().describe('What proved the video was playing, and whether an advert ran first.').meta(ui({ title: 'Evidence' })),
  like: z.string().describe('Outcome of the like attempt, or `not attempted`.').meta(ui({ title: 'Like' })),
  comments: z.string().describe('Outcome of the comment visit, or `not attempted`.').meta(ui({ title: 'Comments' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'search-play',
  title: 'Search and play',
  description: 'Searches YouTube, picks a random or top video from the ranked first page, waits out any advert, plays it, with optional like and comment reading.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 10 * 60_000,

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
    const results = await capture(ctx, '03-results', loaded.tree)
    steps.push(loaded.ok ? 'results' : 'results(timeout)')
    if (!loaded.ok) fail('results', `no result rows appeared within the budget — see artifact 03-results`)

    // --- pick from the ranked first page --------------------------------------
    const rows = resultRowsOf(results)
    if (rows.length === 0) fail('pick-row', 'the results page reported rows but the walk found none — see artifact 03-results')
    const index = ctx.params.pick === 'top' ? 0 : Math.floor(rng() * rows.length)
    const chosen = rows[index] as UiNode
    const videoTitle = titleFromRow(chosen)
    await tapNode(ctx, chosen.clickable ? chosen : clickableFor(results, chosen))
    steps.push(`picked rank ${index + 1}/${rows.length}`)

    // --- player, advert, watch --------------------------------------------------
    const playing = await waitForTree(ctx, (t) => playerEvidence(t).playing, { budgetMs: 30_000 })
    const player = await capture(ctx, '04-player', playing.tree)
    const evidence = playerEvidence(player)
    if (!evidence.playing) fail('verify-player', 'a result was tapped but nothing that looks like a player appeared — see artifact 04-player')

    let adSeen = false
    if (adEvidence(player).ad) {
      adSeen = true
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
    const playEvidence = `${evidence.via}${adSeen ? ' (after advert)' : ''}`
    steps.push('watching')

    let like = 'not attempted'
    let comments = 'not attempted'
    const until = Date.now() + ctx.params.watchMs
    while (Date.now() < until) {
      await sleep(between(rng, 2_500, 6_000))
      if (like === 'not attempted' && ctx.params.likeProbability > 0 && rng() < ctx.params.likeProbability) {
        like = await pressLike(ctx, rng)
        steps.push(`like:${like}`)
      }
      if (comments === 'not attempted' && ctx.params.commentProbability > 0 && rng() < ctx.params.commentProbability) {
        comments = await browseComments(ctx, rng, { scrollTimes: 4 })
        steps.push(`comments:${comments}`)
      }
    }
    steps.push('watched')

    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    return { query: ctx.params.query, resultCount: rows.length, pickedRank: index + 1, played: true, videoTitle, playEvidence, like, comments, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
  },
}

export default script
