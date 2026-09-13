import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { rowsById, treeFrame } from './tree'
import { INSTAGRAM_PACKAGE, capture, openTab, relaunch } from './instagram'
import { between, bytesEqual, frameOf, keywordBoost, makeRng, pickDwell, sleep, tapNodeJittered } from './behavior'

/**
 * `scroll-feed` — read the home feed the way a person does: scroll a little,
 * stop on a post, sometimes like it, move on.
 *
 * Anchors measured on the owner's moto g06 power (Instagram 446.0, id-ID,
 * 2026-09-14, `__fixtures__/screen-feed-post.json`): each post opens with
 * `row_feed_profile_header` (description "<author> memposting photo pada …"),
 * its media `row_feed_photo_imageview` ("Foto oleh <author>, N suka"), and its
 * action row `row_feed_button_like` ("Suka"), `row_feed_button_comment`,
 * `row_feed_button_share`, `row_feed_button_save`.
 *
 * Never follows, comments, shares or saves; the "Ikuti" buttons on suggested
 * cards are never touched. A like is confirmed by reading the button again,
 * and a sponsored post is never liked.
 */

const paramsSchema = z.object({
  posts: z.number().int().min(1).max(80).default(15).describe('How many feed posts to stop on.').meta(ui({ title: 'Posts' })),
  likeProbability: z.number().min(0).max(1).default(0.1).describe('Chance to like a post (never a sponsored one).').meta(ui({ title: 'Like chance' })),
  keywordBoostFactor: z.number().min(1).max(10).default(3).describe('Multiplier applied to the like chance when a keyword matches the post.').meta(ui({ title: 'Keyword boost' })),
  keywords: z.array(z.string()).default([]).describe('A post whose author or description contains any of these gets the boosted chance.').meta(ui({ title: 'Keywords' })),
  seed: z.number().int().min(0).default(0).describe('RNG seed; 0 derives one from the job so every run differs.').meta(ui({ title: 'Seed (0 = random)' })),
})

const resultSchema = z.object({
  postsSeen: z.number().int().describe('Distinct posts that came into view.').meta(ui({ title: 'Seen', summary: true })),
  advanced: z.number().int().describe('Scrolls verified to have moved the feed.').meta(ui({ title: 'Advanced' })),
  likes: z.array(z.enum(['liked', 'already-liked', 'not-confirmed', 'sponsored'])).describe('One outcome per attempted like.').meta(ui({ title: 'Likes', summary: true })),
  sponsoredSeen: z.number().int().meta(ui({ title: 'Sponsored' })),
  keywordMatches: z.number().int().meta(ui({ title: 'Keyword matches', summary: true })),
  authors: z.array(z.string()).meta(ui({ title: 'Authors' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

type LikeOutcome = 'liked' | 'already-liked' | 'not-confirmed' | 'sponsored'

export interface FeedPost {
  header: UiNode
  author: string
  /** Every description and text from the header down to the like row — what keywords match against. */
  words: string
  sponsored: boolean
  like: UiNode | null
}

/** The home feed is on screen. */
export function onHomeFeed(tree: UiNode): boolean {
  return rowsById(tree, 'title_logo').length > 0 || rowsById(tree, 'main_feed_action_bar').length > 0
}

/** The posts whose headers are in view, each paired with the like button below it (before the next header). */
export function feedPosts(tree: UiNode): FeedPost[] {
  const headers = rowsById(tree, 'row_feed_profile_header').sort((a, b) => a.bounds.top - b.bounds.top)
  const likes = rowsById(tree, 'row_feed_button_like')
  const names = rowsById(tree, 'row_feed_photo_profile_name')
  const labels = rowsById(tree, 'secondary_label')
  const media = rowsById(tree, 'row_feed_photo_imageview')
  return headers.map((header, i) => {
    const top = header.bounds.top
    const bottom = headers[i + 1]?.bounds.top ?? Number.POSITIVE_INFINITY
    const inPost = (n: UiNode): boolean => n.bounds.top >= top && n.bounds.top < bottom
    const author = names.find(inPost)?.text.trim() ?? header.desc.split(' ')[0] ?? ''
    const secondary = labels.filter(inPost).map((n) => n.text.trim())
    const words = [header.desc, author, ...secondary, ...media.filter(inPost).map((n) => n.desc)].join(' ')
    const sponsored = secondary.some((s) => /^(bersponsor|sponsored|iklan)$/i.test(s)) || /bersponsor|sponsored/i.test(header.desc)
    return { header, author, words, sponsored, like: likes.find(inPost) ?? null }
  })
}

/** A feed like button's state, from its description. */
export function feedLikeState(node: UiNode): 'liked' | 'not-liked' | 'unknown' {
  const d = node.desc.trim().toLowerCase()
  if (d.includes('batal suka') || d.includes('unlike') || d === 'liked' || d.includes('disukai')) return 'liked'
  if (d === 'suka' || d === 'like') return 'not-liked'
  return 'unknown'
}

async function likeFeedPost(ctx: ScriptContext<unknown>, post: FeedPost): Promise<LikeOutcome | null> {
  if (post.sponsored) return 'sponsored'
  if (!post.like) return null
  const state = feedLikeState(post.like)
  if (state === 'liked') return 'already-liked'
  await tapNodeJittered(ctx, post.like)
  await sleep(900)
  const again = feedPosts(await ctx.device.dump()).find((p) => p.header.desc === post.header.desc)
  return again?.like && feedLikeState(again.like) === 'liked' ? 'liked' : 'not-confirmed'
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'scroll-feed',
  icon: 'activity',
  node: { category: 'device', icon: 'activity', summary: ['posts'], keywords: ['instagram', 'feed', 'scroll', 'warm-up'] },
  title: 'Scroll home feed',
  description: 'Scrolls the Instagram home feed with human-shaped pauses and optional, confirmed likes. Never follows, comments or shares.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 30 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(ctx.params.seed || (Date.now() ^ Number(ctx.job.attempt)) >>> 0)
    const steps: string[] = []
    const likes: LikeOutcome[] = []
    const seen = new Set<string>()
    const authors: string[] = []
    let sponsoredSeen = 0
    let keywordMatches = 0
    let advanced = 0

    const feed = await openTab(ctx, 'feed_tab', onHomeFeed)
    if (!feed.ok) {
      await capture(ctx, 'ig-feed-not-open', feed.tree)
      throw new Error('the home feed did not open — see artifact ig-feed-not-open')
    }
    steps.push('feed')
    const frame = await frameOf(ctx)

    let stalls = 0
    while (seen.size < ctx.params.posts && stalls < 4) {
      const tree = await ctx.device.dump()
      const h = treeFrame(tree).height
      // A post counts once its header has scrolled into the upper part of the screen.
      const fresh = feedPosts(tree).filter((p) => p.header.bounds.top < h * 0.7 && !seen.has(p.header.desc))
      for (const post of fresh) {
        if (seen.size >= ctx.params.posts) break
        seen.add(post.header.desc)
        if (post.author !== '' && !authors.includes(post.author)) authors.push(post.author)
        if (post.sponsored) sponsoredSeen += 1
        const matched = ctx.params.keywords.some((k) => k.trim() !== '' && post.words.toLowerCase().includes(k.trim().toLowerCase()))
        if (matched) keywordMatches += 1
        ctx.progress({ post: seen.size, of: ctx.params.posts, likes: likes.length })

        const dwell = pickDwell(rng)
        await sleep(Math.round(dwell.ms * 0.6))
        const p = keywordBoost(post.words, ctx.params.keywords, ctx.params.likeProbability, ctx.params.keywordBoostFactor)
        // Only like a post whose action row is on screen, above the navigation bar.
        if (rng() < p && post.like && post.like.bounds.top > h * 0.12 && post.like.bounds.bottom < h * 0.88) {
          const outcome = await likeFeedPost(ctx, post)
          if (outcome) {
            likes.push(outcome)
            steps.push(`like:${outcome}${matched ? ':kw' : ''}`)
          }
        }
      }

      const before = await ctx.device.screenshot()
      const x = Math.round(between(rng, 0.2, 0.7) * frame.width)
      const sy = Math.round(between(rng, 0.7, 0.82) * frame.height)
      const ey = Math.round(sy - between(rng, 0.3, 0.55) * frame.height)
      await ctx.device.swipe({ x, y: sy }, { x: Math.round(x + between(rng, -15, 15)), y: ey }, Math.round(between(rng, 220, 420)), { easing: 'easeOutQuad', curvature: Number(between(rng, 0, 0.05).toFixed(3)) })
      await sleep(between(rng, 900, 1_700))
      if (bytesEqual(before, await ctx.device.screenshot())) {
        stalls += 1
        steps.push('scroll did not move')
      } else {
        advanced += 1
        if (fresh.length === 0) stalls += 1
        else stalls = 0
      }
    }
    steps.push('done')
    return { postsSeen: seen.size, advanced, likes, sponsoredSeen, keywordMatches, authors, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE).catch(() => {})
  },
}

export default script
