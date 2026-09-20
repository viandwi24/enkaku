import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { mergePages, parseCount, ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { all, rowsById } from './tree'
import { between, makeRng, sleep } from './human'
import { capture, captureSafe, frameOf, relaunch, verifiedPageDown, TIKTOK_PACKAGE } from './gesture'
import { PROFIL_TAB_ANCHORS } from './sheet'
import { waitForAnyAnchor } from './sheet'

/**
 * `my-videos` — read the signed-in account's own posts and how many plays each has.
 *
 * Reading only. It opens the Profil tab, reads the grid, scrolls it, and taps
 * NOTHING inside the grid: opening a video would add a view to the account's
 * own count, which is the one thing a recap must never do to the number it
 * came to read.
 *
 * ## What the grid gives, and what it does not (measured 2026-09-21)
 *
 * The owner's moto g06 power, TikTok `id-ID`, account `dewi_purnama280`
 * (`__fixtures__/screen-profile-grid.json`). A cell is a `FrameLayout` holding
 * a `cover` image and a `video_info_container` with one `tv_play_count`
 * TextView — `420`, `73`, `1.655`, `140,1 rb`. That is the WHOLE cell: no
 * caption, no id, no date, not even a description. The first cell is not a
 * video at all but the drafts tile, which carries `tv_draft` ("Draf: 11") and
 * no play count.
 *
 * So a video here has no identity, only a position and a number, and that is
 * what this member reports. Matching those readings to videos across days is
 * the Social Media Manager's job (`recap.ts`), not something this member can
 * fake by opening every video — which would cost a view each, on every run.
 *
 * ## What an account with nothing posted reads as
 *
 * A failure, deliberately, and only in one narrow case. The grid is proved to
 * have LOADED by a play count, a drafts tile or a cover; an account with
 * drafts — which every account on this farm has — therefore reads as an empty
 * list, correctly. An account with no posts AND no drafts is indistinguishable
 * from a grid that has not drawn yet, so this refuses rather than reporting
 * "nothing posted", and the recap keeps whatever it knew. TikTok does draw an
 * empty-state for that case; it has not been measured on hardware, so this
 * pack does not claim to recognise it.
 *
 * ## Why the pages are stitched rather than counted
 *
 * Scrolling a grid whose cells have no identity cannot be done by counting
 * swipes: the grid snaps, and a fling goes further than a drag. Consecutive
 * dumps overlap instead, and `mergePages` (SDK) joins them on that overlap —
 * or reports `truncated` when two pages cannot be shown to meet, rather than
 * appending a guess with a hole in it.
 */

const ARTIFACT_PREFIX = 'my-videos'

const paramsSchema = z.object({
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(6)
    .describe('How many of the newest posts to read. The grid is read newest first, so a small number is the recent ones.')
    .meta(ui({ title: 'Videos to read' })),
})

const VideoSchema = z.object({
  rank: z.number().int().describe('Position in the grid, 0 is newest.'),
  views: z.number().int().describe('Plays, as the grid drew them.'),
  viewsText: z.string().describe('What the grid actually drew — kept so a misparse is visible.'),
  approx: z.boolean().describe('True when the number was rounded for display ("140,1 rb"), so it is not exact.'),
})

const resultSchema = z.object({
  account: z.string().describe('The handle the profile showed, with its @.').meta(ui({ title: 'Account', summary: true })),
  count: z.number().int().describe('How many posts were read.').meta(ui({ title: 'Videos read', kind: 'count', summary: true })),
  totalViews: z.number().int().describe('The plays of those posts added up.').meta(ui({ title: 'Total plays', kind: 'count', summary: true })),
  videos: z.array(VideoSchema).describe('Each post read, newest first.').meta(ui({ title: 'Videos' })),
  truncated: z.boolean().describe('True when the scroll could not be joined to what came before, so the list stops early.').meta(ui({ title: 'Stopped early' })),
  drafts: z.number().int().describe('Unposted drafts the grid reported, or -1 when it said nothing.').meta(ui({ title: 'Drafts' })),
  readAt: z.number().int().describe('When the grid was read, in unix seconds.').meta(ui({ title: 'Read at' })),
  steps: z.array(z.string()).describe('Each step reached, in order.').meta(ui({ title: 'Steps' })),
})

export interface GridCell {
  rank: number
  views: number
  viewsText: string
  approx: boolean
}

/**
 * The account handle the profile header shows.
 *
 * Matched by its `@`, not by a resource id: the header's ids on this build are
 * obfuscated three-letter names (`ss2`, `sv6`) that rotate between TikTok
 * releases, while a handle is the one string on this screen that starts with
 * an `@` and carries no space.
 */
export function readHandle(tree: UiNode): string {
  const node = all(tree, (n) => /^@[A-Za-z0-9._]{2,30}$/.test(n.text.trim()))[0]
  return node ? node.text.trim() : ''
}

/** How many drafts the grid's own tile reported, or -1 when there is no tile. */
export function readDraftCount(tree: UiNode): number {
  const node = rowsById(tree, 'tv_draft')[0]
  if (!node) return -1
  const found = /(\d+)/.exec(node.text)
  return found ? Number(found[1]) : -1
}

/**
 * Every published post on screen, in grid order — top to bottom, left to right.
 *
 * Keyed on `tv_play_count`, which is both the number this member came for and
 * the thing that tells a post from the drafts tile beside it: the drafts tile
 * has no play count, so it never enters the list and never shifts a rank.
 */
export function readProfileGrid(tree: UiNode): GridCell[] {
  const cells = rowsById(tree, 'tv_play_count')
    .filter((n) => n.text.trim() !== '')
    .sort((a, b) => (a.bounds.top !== b.bounds.top ? a.bounds.top - b.bounds.top : a.bounds.left - b.bounds.left))
  const out: GridCell[] = []
  for (const cell of cells) {
    const text = cell.text.trim()
    const read = parseCount(text)
    if (read.value === null) continue
    out.push({ rank: out.length, views: read.value, viewsText: text, approx: read.approx })
  }
  return out
}

/** The profile is drawn and its grid has settled: a handle, and either posts or the drafts tile. */
export function onOwnProfile(tree: UiNode): boolean {
  if (readHandle(tree) === '') return false
  return rowsById(tree, 'tv_play_count').length > 0 || rowsById(tree, 'tv_draft').length > 0 || rowsById(tree, 'cover').length > 0
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'my-videos',
  title: 'My videos',
  description: 'Opens the account\'s own profile and reads how many plays each of its newest posts has. It never opens a video — that would add a view to the number it came to read.',
  icon: 'gauge',
  node: { category: 'device', icon: 'gauge', summary: [], keywords: ['tiktok', 'views', 'recap', 'profile'] },
  params: paramsSchema,
  result: resultSchema,
  timeout: 5 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx: ScriptContext<z.infer<typeof paramsSchema>>) {
    const rng = makeRng(Date.now() & 0x7fffffff)
    const steps: string[] = []
    const want = ctx.params.maxVideos

    const profil = await waitForAnyAnchor(ctx, ARTIFACT_PREFIX, 'home feed (Profil tab)', PROFIL_TAB_ANCHORS, { timeout: 25_000 })
    await ctx.device.tap({ point: { x: Math.round((profil.bounds.left + profil.bounds.right) / 2), y: Math.round((profil.bounds.top + profil.bounds.bottom) / 2) } })
    steps.push('opened the profile tab')

    /*
      Wait for the grid, not merely for the tab. The header draws first and the
      cells arrive after, so a read taken on the header alone would report an
      account with no videos — the exact misreading that would then be merged
      into the recap as "every video disappeared".
    */
    let tree = await ctx.device.dump()
    for (let waited = 0; waited < 20 && !onOwnProfile(tree); waited++) {
      await sleep(1_000)
      tree = await ctx.device.dump()
    }
    if (!onOwnProfile(tree)) {
      await captureSafe(ctx, `${ARTIFACT_PREFIX}-no-profile`)
      throw Object.assign(new Error('the profile grid never appeared after the Profil tab — cannot tell whether this account has no videos or the screen simply did not load'), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    const account = readHandle(tree)
    const drafts = readDraftCount(tree)
    steps.push(`profile: ${account}`)

    const pages: GridCell[][] = [readProfileGrid(tree)]
    let merged = mergePages(pages, (cell) => cell.viewsText)
    const frame = await frameOf(ctx)

    /*
      Scroll only while there is something left to want. A grid that already
      showed six posts is not scrolled at all, which is the common case and the
      one worth being cheap: a recap of a whole farm is one of these per phone
      per platform.
    */
    for (let page = 0; page < 6 && merged.items.length < want && !merged.truncated; page++) {
      const moved = await verifiedPageDown(ctx, frame, rng)
      if (!moved) {
        steps.push('the grid would not scroll any further — this is the end of it')
        break
      }
      await sleep(between(rng, 700, 1_400))
      const next = await ctx.device.dump()
      const read = readProfileGrid(next)
      if (read.length === 0) {
        steps.push('a scroll landed somewhere with no posts on it — stopping here')
        break
      }
      pages.push(read)
      merged = mergePages(pages, (cell) => cell.viewsText)
      tree = next
    }

    await capture(ctx, `${ARTIFACT_PREFIX}-grid`)

    const videos = merged.items.slice(0, want).map((cell, rank) => ({ ...cell, rank }))
    steps.push(`read ${videos.length} post(s)${merged.truncated ? ', stopping early because two scrolls could not be joined' : ''}`)
    if (merged.truncated) ctx.log.warn('two pages of the profile grid could not be joined by their overlap — the list stops at the last page that could be', { account, read: merged.items.length })

    return {
      account,
      count: videos.length,
      totalViews: videos.reduce((sum, v) => sum + v.views, 0),
      videos,
      truncated: merged.truncated,
      drafts,
      readAt: Math.floor(Date.now() / 1000),
      steps,
    }
  },

  async finish(ctx) {
    if (ctx.error) await captureSafe(ctx, `${ARTIFACT_PREFIX}-failed`)
    await ctx.device.app.forceStop(TIKTOK_PACKAGE).catch(() => {})
  },
}

export default script
