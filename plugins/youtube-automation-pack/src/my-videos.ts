import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { countBefore, mergePages, ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { flatten } from './tree'
import { YOUTUBE_PACKAGE, capture, relaunch, sleep, tapNode, waitForTree } from './youtube'
import { dismissPopups } from './popups'
import { accountNameOf, onYouPage, youTabOf } from './check-profile'

/**
 * `my-videos` — read the signed-in channel's own uploads and their view counts.
 *
 * Reading only: You tab → View channel → the channel's own content tab. It
 * never plays a video, which would add a view to the number it came to read,
 * and never opens Analytics or Edit channel.
 *
 * ## Why YouTube is the easy one (measured 2026-09-21)
 *
 * On the owner's moto g06 power, `en-US`, a channel's Shorts cell describes
 * itself in one string:
 *
 * ```
 * 2026 Solar Eclipse @ 50,000 Feet, 246 thousand views - play Short
 * ```
 *
 * and a Videos row likewise:
 *
 * ```
 * NASA Moon Base: The First Six Months - 1 minute, 7 seconds - Go to channel - NASA - 482 thousand views - 12 days ago - play video
 * ```
 *
 * So YouTube hands over TITLE and views together, which neither TikTok's nor
 * Instagram's grid does. A recap built on this can match a video to yesterday's
 * reading by name rather than by position, which is the difference between a
 * merge that survives a new upload and one that guesses.
 *
 * `__fixtures__/screen-channel-shorts-grid.json` and
 * `screen-channel-videos-list.json` are those two screens;
 * `screen-channel-own-empty.json` is the owner's own channel, which has a
 * Shorts tab holding nothing but Drafts — the case a reader must not report as
 * an error.
 *
 * ## Why the count is never taken from the whole description
 *
 * The title carries numbers of its own. `parseCount` on that first string
 * answers 2026 — the year in the title — so the count is read backwards from
 * the word it belongs to (`countBefore`, SDK), and that rule has its own test.
 */

const VIEWS = /\bviews?\b|penayangan|kali ditonton|x ditonton/i

/** How long a channel tab gets to draw its list before it is taken at its word as empty. */
const TAB_LOAD_BUDGET_MS = 10_000

const paramsSchema = z.object({
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(6)
    .describe('How many of the newest uploads to read. The tab is newest first, so a small number is the recent ones.')
    .meta(ui({ title: 'Videos to read' })),
  tab: z
    .enum(['auto', 'shorts', 'videos'])
    .default('auto')
    .describe('Which of the channel\'s tabs to read. "auto" prefers Shorts, which is what this farm posts, and falls back to Videos.')
    .meta(ui({ title: 'Channel tab', labels: { auto: 'Whatever the channel has', shorts: 'Shorts', videos: 'Videos' } })),
})

const VideoSchema = z.object({
  rank: z.number().int().describe('Position in the tab, 0 is newest.'),
  title: z.string().describe('The video\'s title, as the channel page drew it.'),
  views: z.number().int().describe('Views, as the page drew them.'),
  viewsText: z.string().describe('The whole description the count was read out of — kept so a misparse is visible.'),
  approx: z.boolean().describe('True when the number was rounded for display ("246 thousand"), so it is not exact.'),
  age: z.string().describe('How long ago the page says it was posted, or empty when the layout does not say.'),
})

const resultSchema = z.object({
  account: z.string().describe('The channel name the You page showed.').meta(ui({ title: 'Channel', summary: true })),
  tab: z.string().describe('Which channel tab was actually read.').meta(ui({ title: 'Tab read', summary: true })),
  count: z.number().int().describe('How many uploads were read.').meta(ui({ title: 'Videos read', kind: 'count', summary: true })),
  totalViews: z.number().int().describe('The views of those uploads added up.').meta(ui({ title: 'Total views', kind: 'count', summary: true })),
  videos: z.array(VideoSchema).describe('Each upload read, newest first.').meta(ui({ title: 'Videos' })),
  truncated: z.boolean().describe('True when a scroll could not be joined to what came before, so the list stops early.').meta(ui({ title: 'Stopped early' })),
  readAt: z.number().int().describe('When the channel was read, in unix seconds.').meta(ui({ title: 'Read at' })),
  steps: z.array(z.string()).describe('Each step reached, in order.').meta(ui({ title: 'Steps' })),
})

export interface ChannelVideo {
  rank: number
  title: string
  views: number
  viewsText: string
  approx: boolean
  age: string
}

/** The channel page's own tab bar — Home, Videos, Shorts, Live, Posts, Playlists. */
export function channelTabs(tree: UiNode): UiNode[] {
  return flatten(tree).filter((n) => n.resourceId.endsWith(':id/tabs_bar_text_tab_view') && n.desc.trim() !== '')
}

/** The tab whose name matches, in either language, or `null`. */
export function channelTab(tree: UiNode, which: 'shorts' | 'videos'): UiNode | null {
  const names = which === 'shorts' ? /^shorts?$/i : /^(videos|video)$/i
  return channelTabs(tree).find((n) => names.test(n.desc.trim())) ?? null
}

/**
 * Read one page of a channel's content tab.
 *
 * `layout` is passed rather than sniffed. The two layouts put the title in
 * different places — Shorts ends it with a comma before the count, Videos
 * separates every field with ` - ` — and guessing which from the text would
 * mean keying on `play Short` / `play video`, which are English.
 */
export function readChannelPage(tree: UiNode, layout: 'shorts' | 'videos'): ChannelVideo[] {
  const rows: { node: UiNode; title: string; views: number; approx: boolean; age: string }[] = []
  for (const node of flatten(tree)) {
    const desc = node.desc.trim()
    if (desc === '') continue
    const reading = countBefore(desc, VIEWS)
    if (reading.value === null) continue
    // A parent and its child can both carry the description. The first one
    // found depth-first is the outer row; anything inside it is the same video.
    if (rows.some((row) => row.node.desc.trim() === desc)) continue
    rows.push({ node, title: titleOf(desc, layout), views: reading.value, approx: reading.approx, age: ageOf(desc, layout) })
  }
  rows.sort((a, b) => (a.node.bounds.top !== b.node.bounds.top ? a.node.bounds.top - b.node.bounds.top : a.node.bounds.left - b.node.bounds.left))
  return rows.map((row, rank) => ({ rank, title: row.title, views: row.views, viewsText: row.node.desc.trim(), approx: row.approx, age: row.age }))
}

/** The title, given which layout wrote the description. */
function titleOf(desc: string, layout: 'shorts' | 'videos'): string {
  if (layout === 'videos') return (desc.split(' - ')[0] ?? '').trim()
  // Shorts: `<title>, <count> views - play Short`. The count's own clause is
  // the last comma-separated run, so everything before that last comma is the
  // title — including any commas the title itself carries.
  const cut = desc.lastIndexOf(',')
  return (cut === -1 ? desc : desc.slice(0, cut)).trim()
}

/**
 * How long ago the page says it went up, or empty.
 *
 * Only the Videos layout carries it (`... - 482 thousand views - 12 days ago -
 * play video`). Reported rather than parsed into a date: "2 weeks ago" is not
 * a timestamp and pretending otherwise would put a made-up date on a row.
 */
function ageOf(desc: string, layout: 'shorts' | 'videos'): string {
  if (layout !== 'videos') return ''
  const parts = desc.split(' - ').map((part) => part.trim())
  const at = parts.findIndex((part) => VIEWS.test(part))
  return at >= 0 && at + 1 < parts.length ? (parts[at + 1] as string) : ''
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'my-videos',
  title: 'My videos',
  description: 'Opens the signed-in channel and reads the title and view count of its newest uploads. It never plays a video — that would add a view to the number it came to read.',
  icon: 'gauge',
  node: { category: 'device', icon: 'gauge', summary: ['maxVideos'], keywords: ['youtube', 'views', 'recap', 'channel'] },
  params: paramsSchema,
  result: resultSchema,
  timeout: 6 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx: ScriptContext<z.infer<typeof paramsSchema>>) {
    const steps: string[] = []
    const want = ctx.params.maxVideos

    let tree = (await dismissPopups(ctx, await ctx.device.dump())).tree
    const youTab = youTabOf(tree)
    if (!youTab) {
      await capture(ctx, 'yt-my-videos-no-nav', tree)
      throw Object.assign(new Error('the bottom navigation had no "You" tab — YouTube is not showing its own home screen'), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    await tapNode(ctx, youTab)
    const you = await waitForTree(ctx, onYouPage, { budgetMs: 20_000 })
    if (!you.ok) {
      await capture(ctx, 'yt-my-videos-no-you', you.tree)
      throw Object.assign(new Error('the "You" page never appeared after its tab'), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    const account = accountNameOf(you.tree)
    steps.push(`account: ${account || 'signed out'}`)
    if (account === '') {
      await capture(ctx, 'yt-my-videos-signed-out', you.tree)
      throw Object.assign(new Error('the "You" page showed no account — this phone is signed out of YouTube'), { code: 'E_SIGNED_OUT' })
    }

    const viewChannel = flatten(you.tree).find((n) => n.clickable && /^(view channel|lihat channel|lihat saluran)$/i.test(n.desc.trim()))
    if (!viewChannel) {
      await capture(ctx, 'yt-my-videos-no-channel-link', you.tree)
      throw Object.assign(new Error('the "You" page had no "View channel" control — cannot reach this account\'s own uploads'), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    await tapNode(ctx, viewChannel)
    const channel = await waitForTree(ctx, (t) => channelTabs(t).length > 0, { budgetMs: 20_000 })
    if (!channel.ok) {
      await capture(ctx, 'yt-my-videos-no-channel', channel.tree)
      throw Object.assign(new Error('the channel page never drew its tab bar after "View channel"'), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    steps.push('opened the channel')
    tree = channel.tree

    /*
      Which tab. `auto` prefers Shorts because that is what this farm's
      `post-video` publishes; a channel with no Shorts tab falls back to
      Videos, and one with neither is a channel that has posted nothing —
      reported as an empty list, not as a failure.
    */
    const order: ('shorts' | 'videos')[] = ctx.params.tab === 'auto' ? ['shorts', 'videos'] : [ctx.params.tab]
    let layout: 'shorts' | 'videos' | null = null
    let first: ChannelVideo[] = []
    let tried = 0
    for (const candidate of order) {
      const tab = channelTab(tree, candidate)
      if (!tab) continue
      tried += 1
      await tapNode(ctx, tab)
      /*
        WAIT for the tab's content rather than sleeping a fixed second and
        reading whatever is there. A tab read too early is an empty tab, and an
        empty tab merged into the recap is every video on the account leaving
        the window at once.
      */
      const loaded = await waitForTree(ctx, (t) => readChannelPage(t, candidate).length > 0, { budgetMs: TAB_LOAD_BUDGET_MS })
      tree = loaded.tree
      first = readChannelPage(tree, candidate)
      layout = candidate
      /*
        Nothing on it. Under `auto` that is a reason to try the next tab, not
        to stop: the owner's own channel carries a Shorts tab holding only
        drafts, and a channel with both tabs could easily have its uploads in
        the other one.
      */
      if (first.length > 0) {
        steps.push(`reading the ${candidate} tab`)
        break
      }
      if (ctx.params.tab !== 'auto') break
      steps.push(`the ${candidate} tab has nothing on it`)
    }
    if (layout === null) {
      await capture(ctx, 'yt-my-videos-no-tab', tree)
      steps.push('this channel has no Shorts or Videos tab — nothing has been posted from it')
      return { account, tab: 'none', count: 0, totalViews: 0, videos: [], truncated: false, readAt: Math.floor(Date.now() / 1000), steps }
    }
    if (first.length === 0) {
      /*
        Every tab tried and every one empty. That IS the answer — a channel
        that has posted nothing — and it is distinguishable from a screen that
        did not load, because the tab bar this walked through only exists on a
        loaded channel page and the wait above gave the list its time.
      */
      await capture(ctx, 'yt-my-videos-tab', tree)
      steps.push(`nothing has been posted from this channel (${tried} tab${tried === 1 ? '' : 's'} checked)`)
      return { account, tab: layout, count: 0, totalViews: 0, videos: [], truncated: false, readAt: Math.floor(Date.now() / 1000), steps }
    }

    const pages: ChannelVideo[][] = [first]
    let merged = mergePages(pages, (video) => video.viewsText)

    for (let page = 0; page < 6 && merged.items.length < want && !merged.truncated; page++) {
      const before = await ctx.device.screenshot()
      await ctx.device.swipe({ x: 360, y: 1_250 }, { x: 360, y: 700 }, 320, { easing: 'easeInOutCubic' })
      await sleep(1_800)
      const after = await ctx.device.screenshot()
      if (before.length === after.length && before.every((byte, i) => byte === after[i])) {
        steps.push('the list would not scroll any further — this is the end of it')
        break
      }
      const next = await ctx.device.dump()
      const read = readChannelPage(next, layout)
      if (read.length === 0) {
        steps.push('a scroll landed somewhere with no videos on it — stopping here')
        break
      }
      pages.push(read)
      merged = mergePages(pages, (video) => video.viewsText)
      tree = next
    }

    await capture(ctx, 'yt-my-videos-tab', tree)

    const videos = merged.items.slice(0, want).map((video, rank) => ({ ...video, rank }))
    steps.push(`read ${videos.length} upload(s)${merged.truncated ? ', stopping early because two scrolls could not be joined' : ''}`)
    if (merged.truncated) ctx.log.warn('two pages of the channel tab could not be joined by their overlap — the list stops at the last page that could be', { account, read: merged.items.length })

    return {
      account,
      tab: layout,
      count: videos.length,
      totalViews: videos.reduce((sum, v) => sum + v.views, 0),
      videos,
      truncated: merged.truncated,
      readAt: Math.floor(Date.now() / 1000),
      steps,
    }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('yt-my-videos-failed').catch(() => {})
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE).catch(() => {})
  },
}

export default script
