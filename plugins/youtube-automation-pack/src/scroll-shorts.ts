import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { sleep, tapNode, YOUTUBE_PACKAGE } from './youtube'
import { flatten } from './tree'
import { advanceFeedVerified, browseComments, frameOf, makeRng, between, pickWatchMs, pressLike, keywordBoost, readableStrings } from './behavior'

/**
 * `scroll-shorts` — browse the Shorts feed like a person browsing it.
 *
 * Enters Shorts, then per video: a heavy-tailed dwell, a chance to press like,
 * a chance to read the comment sheet and close it, and a randomised swipe that
 * is byte-verified to actually have turned the page. Every gesture's corridor,
 * start, distance, speed and curvature come from the seeded RNG, so no two
 * swipes are the same and a seeded run still replays exactly.
 *
 * Anchors are the ones measured on hardware 2026-09-03 (see behavior.ts for
 * the note): the rail's "Sukai video ini"/"suka video ini bersama N …" pair,
 * the comment sheet's `close_button` "Tutup", and the account sheet that
 * answers a signed-out like — which is reported as `not-signed-in`, never as a
 * like.
 */

const paramsSchema = z.object({
  videos: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('How many Shorts to view before finishing.')
    .meta(ui({ title: 'Videos to watch' })),
  likeProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0.2)
    .describe('Chance to press like on a Short. 0 never presses; a signed-out device reports `not-signed-in` instead of a fake like.')
    .meta(ui({ title: 'Like chance' })),
  commentProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0.15)
    .describe('Chance to open the comment sheet, scroll a few comments, and close it. Reading only — never types or likes a comment.')
    .meta(ui({ title: 'Comment chance' })),
  commentScrollTimes: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe('How many randomised scrolls inside the comment sheet.')
    .meta(ui({ title: 'Comment scrolls' })),
  keywordBoostFactor: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe('Multiplier applied to like/comment chance when a keyword matches the Short\'s caption or channel.')
    .meta(ui({ title: 'Keyword boost' })),
  keywords: z.array(z.string()).default([]).describe('Keywords to tilt behaviour toward. A Short whose caption or channel name contains any of these gets the boosted chance.').meta(ui({ title: 'Keywords' })),
  seed: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('RNG seed; 0 derives one from the job so every run differs, a fixed number replays one exactly.')
    .meta(ui({ title: 'Seed (0 = random)' })),
})

const resultSchema = z.object({
  videosSeen: z.number().int().describe('Shorts actually on screen and dwelled on.').meta(ui({ title: 'Seen', summary: true })),
  advanced: z.number().int().describe('Swipes verified to have turned the page (byte-diff of two screenshots).').meta(ui({ title: 'Advanced', summary: true })),
  stuckAt: z.number().int().describe('Which video a swipe failed to advance past after three harder attempts; -1 when it never got stuck.').meta(ui({ title: 'Stuck at' })),
  likes: z.array(z.enum(['liked', 'already-liked', 'not-signed-in', 'no-button', 'not-confirmed'])).describe('One outcome per attempted like, in order.').meta(ui({ title: 'Likes' })),
  keywordMatches: z.number().int().describe('Shorts whose readable text contained at least one keyword — the ones whose chances were boosted.').meta(ui({ title: 'Keyword matches', summary: true })),
  comments: z.array(z.enum(['browsed', 'no-button', 'not-signed-in', 'no-close'])).describe('One outcome per comment-sheet visit, in order.').meta(ui({ title: 'Comments' })),
  signedIn: z.boolean().describe('Whether the device could write at all. False whenever any action answered with the account sheet.').meta(ui({ title: 'Signed in', summary: true })),
  steps: z.array(z.string()).describe('Each step reached, in order — where a failed run stopped.').meta(ui({ title: 'Steps' })),
})

const LAUNCH_SETTLE_MS = 5_000

type LikeOutcome = 'liked' | 'already-liked' | 'not-signed-in' | 'no-button' | 'not-confirmed'
type CommentOutcome = 'browsed' | 'no-button' | 'not-signed-in' | 'no-close'

/**
 * The bottom-nav entry into Shorts. Ids are absent on the pivot items
 * (measured), so the desc ladder is the anchor — BUT the ladder is bounded to
 * the nav band: a home feed that happens to carry a Shorts SHELF has a
 * clickable "Shorts" header node earlier in the DFS walk than the tab itself,
 * and tapping that shelf header was measured (2026-09-04, job 24ca474e) to do
 * nothing at all. The nav band is the bottom 15% of the screen (measured
 * [1433,1556] on a 1640-tall display).
 */
function shortsTabOf(tree: UiNode): UiNode | null {
  let height = 0
  for (const n of flatten(tree)) if (n.bounds.bottom > height) height = n.bounds.bottom
  const items = flatten(tree).filter((n) => n.clickable && (n.packageName === '' || n.packageName === YOUTUBE_PACKAGE) && (height === 0 || n.bounds.top > height * 0.85))
  const byName = items.find((n) => /^(shorts)\b/i.test(n.desc.trim()) || n.text.trim().toLowerCase() === 'shorts')
  if (byName) return byName
  return items.find((n) => n.desc.trim().toLowerCase() === 'videokortingen' || n.desc.trim().toLowerCase() === 'video pendek') ?? null
}

/** Are we inside the Shorts player? The rail buttons are the only place these descriptions appear. */
export function inShorts(tree: UiNode): boolean {
  return flatten(tree).some((n) => /^(sukai|suka|like) (video ini|this video)\b/i.test(n.desc.trim()) || n.desc.trim() === 'Video Berikutnya')
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'scroll-shorts',
  node: { category: 'device', icon: 'activity', summary: ['videos'], keywords: ['shorts', 'scroll', 'watch'] },
  title: 'Scroll Shorts',
  description: 'Browses the Shorts feed with randomised, verified swipes and human-shaped dwell, with optional likes and comment reading.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 30 * 60_000,

  async prepare(ctx) {
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    await ctx.device.app.launch(YOUTUBE_PACKAGE)
    await sleep(LAUNCH_SETTLE_MS)
  },

  async run(ctx) {
    const rng = makeRng(ctx.params.seed || (Date.now() ^ Number(ctx.job.attempt)) >>> 0)
    const steps: string[] = []
    const likes: LikeOutcome[] = []
    const comments: CommentOutcome[] = []
    let keywordMatches = 0

    // --- enter Shorts from the bottom nav -----------------------------------
    let tree = await ctx.device.dump()
    const tab = shortsTabOf(tree)
    if (!tab) throw new Error('the Shorts tab was not on the bottom navigation — see the first artifact')
    await tapNode(ctx, tab)
    await sleep(between(rng, 4_000, 6_000))
    tree = await ctx.device.dump()
    if (!inShorts(tree)) throw new Error('tapped the Shorts tab but the Shorts rail never appeared — see artifacts')
    ctx.log.info('youtube: inside the Shorts feed')

    const frame = await frameOf(ctx)
    let stuckAt = -1

    for (let i = 0; i < ctx.params.videos; i++) {
      ctx.progress({ video: i + 1, of: ctx.params.videos, steps })

      // The Short's own words — caption, channel, counts — feed the keyword tilt.
      const text = readableStrings(await ctx.device.dump()).join(' ')
      if (ctx.params.keywords.some((k) => k.trim() !== '' && text.toLowerCase().includes(k.toLowerCase()))) keywordMatches += 1
      const likeP = keywordBoost(text, ctx.params.keywords, ctx.params.likeProbability, ctx.params.keywordBoostFactor)
      const comP = keywordBoost(text, ctx.params.keywords, ctx.params.commentProbability, ctx.params.keywordBoostFactor)

      const dwell = pickWatchMs(rng)
      await sleep(dwell.ms)

      if (rng() < likeP) {
        const outcome = await pressLike(ctx, rng)
        likes.push(outcome)
        ctx.log.info(`youtube: short ${i + 1} like → ${outcome}`)
      }
      if (rng() < comP) {
        const outcome = await browseComments(ctx, rng, { scrollTimes: ctx.params.commentScrollTimes })
        comments.push(outcome)
        ctx.log.info(`youtube: short ${i + 1} comments → ${outcome}`)
      }

      if (i === ctx.params.videos - 1) {
        steps.push(`video ${i + 1} (${dwell.label})`)
        break
      }

      const turned = await advanceFeedVerified(ctx, frame, rng)
      steps.push(`video ${i + 1} (${dwell.label}${turned ? '' : ' STUCK'})`)
      if (!turned) {
        stuckAt = i + 1
        ctx.log.warn(`youtube: the feed did not turn after video ${i + 1} across three harder swipes — stopping`, { attempts: 3 })
        break
      }
      await sleep(between(rng, 300, 900))
    }

    steps.push('done')
    const signedIn = !likes.includes('not-signed-in') && !comments.includes('not-signed-in')
    return {
      videosSeen: steps.filter((s) => s.startsWith('video')).length,
      advanced: steps.filter((s) => s.includes('video') && !s.includes('STUCK')).length,
      stuckAt,
      likes,
      keywordMatches,
      comments,
      signedIn,
      steps,
    }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
  },
}

export default script
