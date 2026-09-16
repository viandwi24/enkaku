import type { ScriptContext } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { rowsById } from './tree'
import { between, frameOf, keywordBoost, pickDwell, readableStrings, sleep, tapNodeJittered, verifiedSwipeUp } from './behavior'

/**
 * The Reels viewer, shared by `scroll-reels` (the Reels tab) and
 * `explore-reels` (a reel opened from Explore, which is the same viewer under
 * a "Jelajahi" header).
 *
 * Anchors measured on the owner's moto g06 power (Instagram 446.0, id-ID,
 * 2026-09-14, `__fixtures__/screen-reels-viewer.json`) and on the OPPO CPH2173
 * the pack was first written on: `like_button` "Suka", `comment_button`
 * "Komentar", `clips_author_username`, the media's own "Reel oleh <author>".
 */

export type LikeOutcome = 'liked' | 'already-liked' | 'no-button' | 'not-confirmed' | 'sponsored'

/** How often a reel is scrolled back over and re-read — measured against the TikTok pack's own 5%. */
const BACK_SCROLL_CHANCE = 0.05
/** How often the phone is simply put down for a while. TikTok's auto-scroll uses 3% for the same reason. */
const IDLE_CHANCE = 0.03

/** Is the Reels viewer on screen? Its rail's like and comment buttons appear nowhere else. */
export function inReelsViewer(tree: UiNode): boolean {
  return rowsById(tree, 'like_button').length > 0 && rowsById(tree, 'comment_button').length > 0
}

/** The like button's state, read from its description. */
export function reelLikeState(tree: UiNode): 'liked' | 'not-liked' | 'unknown' {
  for (const n of rowsById(tree, 'like_button')) {
    const d = n.desc.trim().toLowerCase()
    if (d.includes('batal suka') || d.includes('unlike') || d.includes('disukai') || d === 'liked') return 'liked'
    if (d === 'suka' || d === 'like') return 'not-liked'
  }
  return 'unknown'
}

/** A sponsored reel carries "Bersponsor"/"Sponsored" somewhere readable. */
export function isSponsored(tree: UiNode): boolean {
  return readableStrings(tree).some((s) => /^(bersponsor|sponsored|iklan)$/i.test(s.trim()))
}

/** The words a keyword can match: author, caption, audio, the media's own description. */
export function reelWords(tree: UiNode): string {
  return readableStrings(tree).join(' ')
}

export interface WatchReelsOptions {
  count: number
  likeProbability: number
  commentProbability: number
  keywords: string[]
  keywordBoostFactor: number
  rng: () => number
  steps: string[]
}

export interface WatchReelsResult {
  viewed: number
  advanced: number
  likes: LikeOutcome[]
  commentsOpened: number
  keywordMatches: number
  dwellLabels: string[]
  authors: string[]
  stuckAt: number
}

/** Watch `count` reels in the viewer that is already on screen. */
export async function watchReels(ctx: ScriptContext<unknown>, opts: WatchReelsOptions): Promise<WatchReelsResult> {
  const { rng, steps } = opts
  const out: WatchReelsResult = { viewed: 0, advanced: 0, likes: [], commentsOpened: 0, keywordMatches: 0, dwellLabels: [], authors: [], stuckAt: -1 }
  const frame = await frameOf(ctx)

  for (let i = 0; i < opts.count; i++) {
    const tree = await ctx.device.dump()
    if (!inReelsViewer(tree)) {
      steps.push(`left the viewer before reel ${i + 1}`)
      break
    }
    out.viewed += 1
    const author = rowsById(tree, 'clips_author_username')[0]?.text.trim() ?? ''
    if (author !== '' && !out.authors.includes(author)) out.authors.push(author)
    ctx.progress({ reel: i + 1, of: opts.count, likes: out.likes.length, comments: out.commentsOpened })

    const text = reelWords(tree)
    const matched = opts.keywords.some((k) => k.trim() !== '' && text.toLowerCase().includes(k.trim().toLowerCase()))
    if (matched) out.keywordMatches += 1
    const likeP = keywordBoost(text, opts.keywords, opts.likeProbability, opts.keywordBoostFactor)
    const commentP = keywordBoost(text, opts.keywords, opts.commentProbability, opts.keywordBoostFactor)

    const dwell = pickDwell(rng)
    out.dwellLabels.push(dwell.label)
    await sleep(dwell.ms)

    if (rng() < likeP) {
      out.likes.push(await pressReelLike(ctx, tree))
      steps.push(`like:${out.likes[out.likes.length - 1]}${matched ? ':kw' : ''}`)
    }
    if (rng() < commentP) {
      const btn = rowsById(tree, 'comment_button').find((n) => n.clickable)
      if (btn) {
        await tapNodeJittered(ctx, btn)
        out.commentsOpened += 1
        await sleep(between(rng, 2_500, 6_000))
        await ctx.device.key('BACK')
        await sleep(between(rng, 700, 1_300))
        steps.push(`comments${matched ? ':kw' : ''}`)
      }
    }
    /*
      Going back, and going away (2026-09-17).

      A survey of this pack against TikTok's found the two behaviours missing here entirely: TikTok
      scrolls back over a reel it just passed (5%) and takes a real break (3%), and this loop did
      neither — it advanced, every time, forever. That regularity is a pattern of its own, and it was
      the single biggest difference between the two packs.

      The back-scroll is the first thing in this pack to use the API's own human gesture: `scroll`
      with `human` draws its corridor, reach, duration and easing per call, so nothing here computes
      geometry. Both probabilities are constants rather than parameters on purpose — they are
      behaviour, not an operator's choice, and adding two params would change the contract of both
      members that share this loop.
    */
    if (i > 0 && rng() < BACK_SCROLL_CHANCE) {
      await ctx.device.scroll({ direction: 'down', human: true })
      await sleep(between(rng, 1_800, 5_000))
      await ctx.device.scroll({ direction: 'up', human: true })
      await sleep(between(rng, 700, 1_400))
      steps.push('looked back')
    }
    if (rng() < IDLE_CHANCE) {
      const idleMs = Math.round(between(rng, 25_000, 75_000))
      steps.push(`idle ${Math.round(idleMs / 1_000)}s`)
      await sleep(idleMs)
    }

    if (i < opts.count - 1) {
      if (await verifiedSwipeUp(ctx, frame, rng)) out.advanced += 1
      else {
        out.stuckAt = i + 1
        steps.push(`stuck at reel ${i + 1}`)
        break
      }
    }
  }
  return out
}

/** Press like on the reel in `tree`, and confirm it by reading the button again. */
async function pressReelLike(ctx: ScriptContext<unknown>, tree: UiNode): Promise<LikeOutcome> {
  if (isSponsored(tree)) return 'sponsored'
  const state = reelLikeState(tree)
  if (state === 'liked') return 'already-liked'
  const btn = rowsById(tree, 'like_button').find((n) => n.clickable)
  if (!btn) return 'no-button'
  await tapNodeJittered(ctx, btn)
  await sleep(900)
  return reelLikeState(await ctx.device.dump()) === 'liked' ? 'liked' : 'not-confirmed'
}
