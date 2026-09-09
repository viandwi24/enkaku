import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { YOUTUBE_PACKAGE, capture, firstMatch, relaunch, sleep, tapNode, waitForTree } from './youtube'
import { SEARCH_ENTRY, SEARCH_FIELD, openSearchField, adEvidence, clickableFor, hasResultRows, playerEvidence, resultRowsOf, skipControlOf, titleFromRow } from './search-channel'
import { between, browseComments, keywordBoost, makeRng, pickWatchMs, pressLike, readableStrings, scrollCommentsRandomised, frameOf } from './behavior'

/**
 * `watch-video` — search for a video and watch it with human-like behavior.
 *
 * Searches for a keyword, picks a video (random or top), watches it with
 * human-like dwell times, and optionally interacts with like/comment features.
 * The behavior mimics real human watching patterns with varied watch times,
 * random interactions, and natural scrolling patterns.
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
  skipAds: z.boolean().default(true).describe('Press YouTube\'s own "Skip ad" control when it appears. Only that button.').meta(ui({ title: 'Skip skippable ads' })),
  likeProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe('Chance to press like during the watch. A signed-out device reports `not-signed-in`.')
    .meta(ui({ title: 'Like chance' })),
  commentProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0.05)
    .describe('Chance to open the comment section, scroll it, and close it. Reading only.')
    .meta(ui({ title: 'Comment chance' })),
  keywordBoostFactor: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe('Multiplier applied to like/comment chance when a keyword matches the video title or channel.')
    .meta(ui({ title: 'Keyword boost' })),
  keywords: z.array(z.string()).default([]).describe('Keywords to tilt behaviour toward; the title read off the result row is what gets matched.').meta(ui({ title: 'Keywords' })),
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
  watchTime: z.number().int().describe('How long the video was actually watched (ms).').meta(ui({ title: 'Watch time', summary: true })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'watch-video',
  /** Plan 310 §3.3 — the script's own icon; `node.icon` (same value) stays as a fallback read for a core older than this plan. */
  icon: 'play',
  node: { category: 'device', icon: 'play', summary: ['query'], keywords: ['watch', 'video', 'long'] },
  title: 'Watch Video',
  description: 'Searches YouTube, picks a video, watches it with human-like behavior patterns, and optionally interacts.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 15 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
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
    // No fixed wait here: `openSearchField` polls for the search screen itself.
    // The capture stays, so a failure still carries the page it actually saw.
    const screen = await capture(ctx, '02-search-open')
    const field = await openSearchField(ctx)
    if (!field) fail('type-query', 'the search screen opened with no text field — see artifact 02-search-open')
    await tapNode(ctx, field!)
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
    // The keyword tilt reads the title the row gave us plus whatever the player shows.
    const tiltText = `${videoTitle} ${ctx.params.query} ${readableStrings(player).join(' ')}`
    const likeP = keywordBoost(tiltText, ctx.params.keywords, ctx.params.likeProbability, ctx.params.keywordBoostFactor)
    const comP = keywordBoost(tiltText, ctx.params.keywords, ctx.params.commentProbability, ctx.params.keywordBoostFactor)
    
    // Watch with human-like behavior
    const watchStart = Date.now()
    let lastInteraction = Date.now()
    
    // Watch for a human-like duration with periodic interactions
    while (true) {
      // Check if we should interact (like/comment)
      if (like === 'not attempted' && rng() < likeP * 0.3) { // Reduced chance per check
        like = await pressLike(ctx, rng)
        steps.push(`like:${like}`)
        lastInteraction = Date.now()
      }
      
      if (comments === 'not attempted' && rng() < comP * 0.2) { // Reduced chance per check
        comments = await browseComments(ctx, rng, { scrollTimes: 3 })
        steps.push(`comments:${comments}`)
        lastInteraction = Date.now()
      }
      
      // Human-like pause/check interval
      await sleep(between(rng, 5_000, 15_000))
      
      // Decide watch duration using the same human-like buckets as scroll-shorts
      const watchDecision = pickWatchMs(rng)
      
      // If we've watched long enough, break
      const elapsed = Date.now() - watchStart
      if (elapsed >= watchDecision.ms) {
        steps.push(`watched:${watchDecision.label}`)
        break
      }
      
      // If it's been a while since last interaction, maybe interact
      if (Date.now() - lastInteraction > 30_000 && rng() < 0.4) {
        // Random scroll during watch (simulating user scrolling through recommendations)
        const frame = await frameOf(ctx)
        if (rng() < 0.5) {
          await scrollCommentsRandomised(ctx, frame, rng, 1) // Small scroll
        }
        lastInteraction = Date.now()
      }
    }
    
    const watchTime = Date.now() - watchStart
    steps.push(`watched ${Math.round(watchTime/1000)}s`)

    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    return { 
      query: ctx.params.query, 
      resultCount: rows.length, 
      pickedRank: index + 1, 
      played: true, 
      videoTitle, 
      playEvidence, 
      like, 
      comments, 
      watchTime,
      steps 
    }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
  },
}

export default script