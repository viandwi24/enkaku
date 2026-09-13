import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { all, rowsById } from './tree'
import { INSTAGRAM_PACKAGE, backToNav, capture, openTab, relaunch, waitForTree } from './instagram'
import { between, frameOf, makeRng, sleep, tapNodeJittered } from './behavior'
import { onHomeFeed } from './scroll-feed'

/**
 * `watch-stories` — open the story tray and watch other people's stories.
 *
 * Anchors measured on the owner's moto g06 power (Instagram 446.0, id-ID,
 * 2026-09-14): the tray's buttons are described "Cerita <author>, N dari M,
 * Belum dilihat." (`__fixtures__/screen-home-stories.json`; the first is the
 * account's own "Cerita Anda" and is skipped), and the viewer carries
 * `reel_viewer_header_container`, `reel_viewer_title` (the author) and
 * `toolbar_like_button` "Suka Cerita" (`__fixtures__/screen-story-viewer.json`).
 *
 * A frame is advanced by a tap on the right of the screen, an author is
 * skipped by a swipe left. Never replies, reacts or follows; liking a story is
 * off by default.
 */

const paramsSchema = z.object({
  frames: z.number().int().min(1).max(60).default(12).describe('How many story frames to watch.').meta(ui({ title: 'Frames' })),
  skipAuthorProbability: z.number().min(0).max(1).default(0.2).describe('Chance to swipe past the rest of an author\'s stories instead of tapping to the next frame.').meta(ui({ title: 'Skip chance' })),
  likeProbability: z.number().min(0).max(1).default(0).describe('Chance to press the story\'s heart. Off by default.').meta(ui({ title: 'Like chance' })),
  seed: z.number().int().min(0).default(0).describe('RNG seed; 0 derives one from the job so every run differs.').meta(ui({ title: 'Seed (0 = random)' })),
})

const resultSchema = z.object({
  framesSeen: z.number().int().meta(ui({ title: 'Frames', summary: true })),
  authors: z.array(z.string()).meta(ui({ title: 'Authors', summary: true })),
  skipped: z.number().int().meta(ui({ title: 'Skipped authors' })),
  liked: z.number().int().meta(ui({ title: 'Liked' })),
  trayEmpty: z.boolean().describe('True when the tray held no one else\'s stories to open.').meta(ui({ title: 'Tray empty' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

export interface TrayStory {
  node: UiNode
  author: string
  unseen: boolean
}

/** Other accounts' stories in the tray, left to right. The account's own story is left out. */
export function trayStories(tree: UiNode): TrayStory[] {
  return all(tree, (n) => n.clickable && /^(cerita|story)\s/i.test(n.desc.trim()) && /,\s*\d+\s*(dari|of)\s*\d+/i.test(n.desc))
    .sort((a, b) => a.bounds.left - b.bounds.left)
    .map((node) => {
      const m = node.desc.match(/^(?:cerita|story)\s+(.+?),\s*(\d+)\s*(?:dari|of)\s*\d+/i)
      return { node, author: m?.[1] ?? '', index: Number(m?.[2] ?? -1), unseen: /belum dilihat|not seen|unseen/i.test(node.desc) }
    })
    .filter((s) => s.index > 0)
    .map(({ node, author, unseen }) => ({ node, author, unseen }))
}

/** The story viewer is on screen. */
export function inStoryViewer(tree: UiNode): boolean {
  return rowsById(tree, 'reel_viewer_header_container').length > 0 || rowsById(tree, 'toolbar_like_button').length > 0
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'watch-stories',
  icon: 'play',
  node: { category: 'device', icon: 'play', summary: ['frames'], keywords: ['instagram', 'stories', 'watch', 'warm-up'] },
  title: 'Watch stories',
  description: 'Opens the story tray and watches other accounts\' stories with human-shaped timing. Never replies, reacts or follows.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 20 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(ctx.params.seed || (Date.now() ^ Number(ctx.job.attempt)) >>> 0)
    const steps: string[] = []
    const authors: string[] = []
    let framesSeen = 0
    let skipped = 0
    let liked = 0

    const feed = await openTab(ctx, 'feed_tab', (t) => onHomeFeed(t) && trayStories(t).length > 0, 12_000)
    const stories = trayStories(feed.tree)
    if (stories.length === 0) {
      await capture(ctx, 'ig-stories-tray', feed.tree)
      steps.push('tray has no one else\'s stories')
      return { framesSeen: 0, authors, skipped, liked, trayEmpty: true, steps }
    }
    const first = stories.find((s) => s.unseen) ?? (stories[0] as TrayStory)
    await tapNodeJittered(ctx, first.node)
    const viewer = await waitForTree(ctx, inStoryViewer, { budgetMs: 12_000 })
    if (!viewer.ok) {
      await capture(ctx, 'ig-stories-viewer', viewer.tree)
      throw new Error(`tapped ${first.author}'s story but the viewer did not open — see artifact ig-stories-viewer`)
    }
    steps.push(`opened:${first.author}`)
    const frame = await frameOf(ctx)

    for (let i = 0; i < ctx.params.frames; i++) {
      const tree = await ctx.device.dump()
      if (!inStoryViewer(tree)) {
        steps.push('the tray ran out')
        break
      }
      framesSeen += 1
      const author = rowsById(tree, 'reel_viewer_title')[0]?.text.trim() ?? ''
      if (author !== '' && !authors.includes(author)) authors.push(author)
      ctx.progress({ frame: i + 1, of: ctx.params.frames, authors: authors.length })
      await sleep(between(rng, 2_500, 8_000))

      if (rng() < ctx.params.likeProbability) {
        const heart = rowsById(tree, 'toolbar_like_button').find((n) => n.clickable)
        if (heart && /^(suka cerita|like story|suka|like)$/i.test(heart.desc.trim())) {
          await tapNodeJittered(ctx, heart)
          liked += 1
          steps.push(`like:${author}`)
          await sleep(700)
        }
      }

      if (i === ctx.params.frames - 1) break
      if (rng() < ctx.params.skipAuthorProbability) {
        const y = Math.round(between(rng, 0.35, 0.55) * frame.height)
        await ctx.device.swipe({ x: Math.round(frame.width * 0.85), y }, { x: Math.round(frame.width * 0.12), y: y + Math.round(between(rng, -20, 20)) }, Math.round(between(rng, 220, 340)))
        skipped += 1
        steps.push(`skip:${author}`)
      } else {
        await ctx.device.tap({ point: { x: Math.round(between(rng, 0.72, 0.92) * frame.width), y: Math.round(between(rng, 0.3, 0.6) * frame.height) } })
      }
      await sleep(between(rng, 600, 1_200))
    }

    await backToNav(ctx)
    steps.push('done')
    return { framesSeen, authors, skipped, liked, trayEmpty: false, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE).catch(() => {})
  },
}

export default script
