import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { mergePages, parseCount, ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { rowsById, treeFrame, within } from './tree'
import { between, makeRng } from './behavior'
import { INSTAGRAM_PACKAGE, capture, centre, openTab, relaunch, sleep, waitForTree } from './instagram'

/**
 * `my-videos` — read the signed-in account's own reels and how many plays each has.
 *
 * Reading only. It opens the profile, switches to the Reels tab, reads the
 * grid and scrolls it. It never opens a reel: playing one adds a view to the
 * number this member came to read.
 *
 * ## What the grid gives (measured 2026-09-21)
 *
 * Owner's moto g06 power, Instagram 446.0, account `bitorex.bkk`
 * (`__fixtures__/screen-profile-reels.json`). The profile's THIRD tab is the
 * one with numbers on it. Its cells are `preview_clip_thumbnail` buttons
 * described `Reel by bitorex.bkk. View Count 140. Double tap to play or
 * pause.`, each holding a `preview_clip_play_count` TextView with the bare
 * number. The first tile is Drafts (`drafts_thumbnail`) and carries no count.
 *
 * The Grid-view tab is deliberately NOT used: its cells describe themselves as
 * `Reel by bitorex.bkk at row 1, column 1` and carry no number at all.
 *
 * ## Why the count is read from the TextView and not from the description
 *
 * "View Count" is English. The same phone's Instagram has shipped `id-ID`
 * strings on other screens, and a reader keyed on an English phrase would
 * return zero videos on a translated build while looking like an account with
 * nothing posted. `preview_clip_play_count` is an id, and ids are not
 * translated — the description is only the fallback.
 *
 * ## Identity
 *
 * There is none here. A cell has a position and a number and nothing else, so
 * that is what this member reports; matching readings to videos across days is
 * the Social Media Manager's job (`recap.ts`).
 */

const paramsSchema = z.object({
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(6)
    .describe('How many of the newest reels to read. The grid is newest first, so a small number is the recent ones.')
    .meta(ui({ title: 'Videos to read' })),
})

const VideoSchema = z.object({
  rank: z.number().int().describe('Position in the grid, 0 is newest.'),
  views: z.number().int().describe('Plays, as the grid drew them.'),
  viewsText: z.string().describe('What the grid actually drew — kept so a misparse is visible.'),
  approx: z.boolean().describe('True when the number was rounded for display, so it is not exact.'),
})

const resultSchema = z.object({
  account: z.string().describe('The handle the profile showed.').meta(ui({ title: 'Account', summary: true })),
  count: z.number().int().describe('How many reels were read.').meta(ui({ title: 'Videos read', kind: 'count', summary: true })),
  totalViews: z.number().int().describe('The plays of those reels added up.').meta(ui({ title: 'Total plays', kind: 'count', summary: true })),
  videos: z.array(VideoSchema).describe('Each reel read, newest first.').meta(ui({ title: 'Videos' })),
  truncated: z.boolean().describe('True when a scroll could not be joined to what came before, so the list stops early.').meta(ui({ title: 'Stopped early' })),
  readAt: z.number().int().describe('When the grid was read, in unix seconds.').meta(ui({ title: 'Read at' })),
  steps: z.array(z.string()).describe('Each step reached, in order.').meta(ui({ title: 'Steps' })),
})

export interface GridCell {
  rank: number
  views: number
  viewsText: string
  approx: boolean
}

/** The account handle from the profile's action bar. */
export function readHandle(tree: UiNode): string {
  const node = rowsById(tree, 'action_bar_title')[0]
  return node ? node.text.trim() || node.desc.trim() : ''
}

/** The profile's three tab icons, by description. `Reels` is the one with numbers on it. */
export function reelsTabOf(tree: UiNode): UiNode | null {
  return rowsById(tree, 'profile_tab_icon_view').find((n) => /^(reels|reel)$/i.test(n.desc.trim())) ?? null
}

/** The Reels grid is drawn — its own recycler, by id. */
export function onReelsTab(tree: UiNode): boolean {
  return rowsById(tree, 'clips_grid_recyclerview').length > 0
}

/**
 * Every reel on screen, in grid order — top to bottom, left to right.
 *
 * The cell is the `preview_clip_thumbnail` button, because that is what always
 * exists; the number is read from the `preview_clip_play_count` TextView
 * inside its bounds, and only from the button's own description when that
 * TextView is not there.
 */
export function readReelsGrid(tree: UiNode): GridCell[] {
  const cells = rowsById(tree, 'preview_clip_thumbnail').sort((a, b) =>
    a.bounds.top !== b.bounds.top ? a.bounds.top - b.bounds.top : a.bounds.left - b.bounds.left,
  )
  const counters = rowsById(tree, 'preview_clip_play_count')
  const out: GridCell[] = []
  for (const cell of cells) {
    const counter = counters.find((n) => within(n, cell))
    const text = counter ? counter.text.trim() : lastNumberIn(cell.desc)
    if (text === '') continue
    const read = parseCount(text)
    if (read.value === null) continue
    out.push({ rank: out.length, views: read.value, viewsText: text, approx: read.approx })
  }
  return out
}

/**
 * The last number-shaped run in a description — the fallback when the count
 * TextView is missing. Last, not first: a handle can carry digits
 * (`user2578127329501`) and it comes before the count in every spelling seen.
 */
function lastNumberIn(desc: string): string {
  const matches = desc.replace(/[  ]/g, ' ').match(/\d[\d.,]*\s*[\p{L}]{0,8}/gu)
  if (!matches || matches.length === 0) return ''
  return (matches[matches.length - 1] as string).trim()
}

/**
 * One gentle, verified scroll of the reels grid.
 *
 * Deliberately NOT `behavior.ts`'s `verifiedSwipeUp`, which reaches 0.55 to
 * 0.75 of a screen. On this layout the grid's cells are 423px tall in a 439px
 * window, so a swipe that long jumps more than two rows and the new page has
 * nothing in common with the old one — `mergePages` would then correctly
 * refuse to join them and the read would stop after three reels. A step
 * shorter than one row always leaves an overlap to join on.
 */
async function gentleScroll(ctx: ScriptContext<unknown>, rng: () => number, frame: { width: number; height: number }): Promise<boolean> {
  for (const distance of [between(rng, 0.14, 0.2), between(rng, 0.22, 0.28)]) {
    const before = await ctx.device.screenshot()
    const x = Math.round(between(rng, 0.2, 0.8) * frame.width)
    const startY = Math.round(between(rng, 0.7, 0.8) * frame.height)
    const endY = Math.max(Math.round(0.12 * frame.height), startY - Math.round(distance * frame.height))
    await ctx.device.swipe({ x, y: startY }, { x: Math.round(x + between(rng, -10, 10)), y: endY }, Math.round(between(rng, 220, 380)), {
      easing: 'easeInOutCubic',
      curvature: Number(between(rng, 0, 0.05).toFixed(3)),
    })
    await sleep(Math.round(between(rng, 1_000, 1_700)))
    const after = await ctx.device.screenshot()
    if (before.length !== after.length || !before.every((byte, i) => byte === after[i])) return true
  }
  return false
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'my-videos',
  title: 'My videos',
  description: 'Opens the account\'s own profile, switches to its Reels tab, and reads how many plays each of the newest reels has. It never opens a reel — that would add a view to the number it came to read.',
  icon: 'gauge',
  node: { category: 'device', icon: 'gauge', summary: [], keywords: ['instagram', 'views', 'recap', 'reels'] },
  params: paramsSchema,
  result: resultSchema,
  timeout: 6 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx: ScriptContext<z.infer<typeof paramsSchema>>) {
    const rng = makeRng(Date.now() & 0x7fffffff)
    const steps: string[] = []
    const want = ctx.params.maxVideos

    const profile = await openTab(ctx, 'profile_tab', (t) => rowsById(t, 'profile_tab_icon_view').length > 0)
    if (!profile.ok) {
      await capture(ctx, 'ig-my-videos-no-profile', profile.tree)
      throw Object.assign(new Error('the profile page did not appear after the profile tab — see artifact ig-my-videos-no-profile'), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    const account = readHandle(profile.tree)
    steps.push(`profile: ${account}`)

    const reelsTab = reelsTabOf(profile.tree)
    if (!reelsTab) {
      await capture(ctx, 'ig-my-videos-no-reels-tab', profile.tree)
      throw Object.assign(new Error('the profile had no Reels tab — this account may not be able to post reels at all'), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    await ctx.device.tap({ point: centre(reelsTab) })
    const opened = await waitForTree(ctx, onReelsTab, { budgetMs: 20_000 })
    if (!opened.ok) {
      await capture(ctx, 'ig-my-videos-no-grid', opened.tree)
      throw Object.assign(new Error('the Reels grid never appeared after its tab — cannot tell an account with no reels from a screen that did not load'), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    steps.push('opened the Reels tab')

    let tree = opened.tree
    const pages: GridCell[][] = [readReelsGrid(tree)]
    let merged = mergePages(pages, (cell) => cell.viewsText)
    const frame = treeFrame(tree)

    for (let page = 0; page < 8 && merged.items.length < want && !merged.truncated; page++) {
      if (!(await gentleScroll(ctx, rng, frame))) {
        steps.push('the grid would not scroll any further — this is the end of it')
        break
      }
      const next = await ctx.device.dump()
      const read = readReelsGrid(next)
      if (read.length === 0) {
        steps.push('a scroll landed somewhere with no reels on it — stopping here')
        break
      }
      pages.push(read)
      merged = mergePages(pages, (cell) => cell.viewsText)
      tree = next
    }

    await capture(ctx, 'ig-my-videos-grid', tree)

    const videos = merged.items.slice(0, want).map((cell, rank) => ({ ...cell, rank }))
    steps.push(`read ${videos.length} reel(s)${merged.truncated ? ', stopping early because two scrolls could not be joined' : ''}`)
    if (merged.truncated) ctx.log.warn('two pages of the reels grid could not be joined by their overlap — the list stops at the last page that could be', { account, read: merged.items.length })

    return {
      account,
      count: videos.length,
      totalViews: videos.reduce((sum, v) => sum + v.views, 0),
      videos,
      truncated: merged.truncated,
      readAt: Math.floor(Date.now() / 1000),
      steps,
    }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('ig-my-videos-failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE).catch(() => {})
  },
}

export default script
