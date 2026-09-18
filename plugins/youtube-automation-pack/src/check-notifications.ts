import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { flatten, rowsById } from './tree'
import { YOUTUBE_PACKAGE, relaunch, tapNode, waitForTree } from './youtube'
import { dismissPopups } from './popups'

/**
 * `check-notifications` — open YouTube's notifications (bell) screen and read it.
 *
 * Reading only. It never taps a notification, never subscribes, never marks
 * anything read beyond what opening the screen does by itself.
 *
 * ## The anchors, measured (owner's moto g06 power, 720x1640, en-US, 2026-09-18)
 *
 * The bell is in the HOME toolbar, not the bottom navigation:
 * `menu_item_view` with `desc="Notifications"`, bounds `[552,70][636,154]`.
 * Its sibling at `[636,70][720,154]` is Search — one wrong 84px and the run
 * opens the search box instead, which is why the bell is matched by its
 * description rather than its position.
 *
 * The screen itself is `filter_bar` carrying `chip_cloud_chip_modern_text`
 * chips ("All", "Mentions"), under a toolbar whose title is "Notifications".
 * `__fixtures__/screen-notifications-empty.json` is the captured empty state.
 *
 * ## Why the empty-state text is NOT the anchor
 *
 * The captured screen says "Your notifications live here" — and that string is
 * present only while the account has nothing. Keying the screen check on it
 * would mean a populated account fails to be recognised, which is the one case
 * this member exists to read. So `onNotifications` keys on `filter_bar` plus
 * the toolbar title, both of which are there either way, and emptiness is
 * REPORTED (`empty: true`) rather than assumed.
 */

const paramsSchema = z.object({
  maxItems: z.number().int().min(5).max(80).default(30).describe('How many notification lines to read before stopping.').meta(ui({ title: 'Max items' })),
})

const resultSchema = z.object({
  items: z.array(z.string()).describe('The notification lines on screen, top first. Empty on an account with none.').meta(ui({ title: 'Notifications', summary: true })),
  empty: z.boolean().describe('The screen was reached and genuinely had no notifications — never a stand-in for "could not tell".').meta(ui({ title: 'Empty', summary: true })),
  filters: z.array(z.string()).describe('The filter chips offered ("All", "Mentions").').meta(ui({ title: 'Filters' })),
  steps: z.array(z.string()).describe('Each step reached, in order — where a failed run stopped.').meta(ui({ title: 'Steps' })),
})

/** How long to wait for the notifications screen after tapping the bell. */
const NOTIFICATIONS_ENTER_TIMEOUT_MS = 20_000

/** Words that are chrome on this screen, never a notification. */
const CHROME = /^(all|mentions|semua|sebutan|home|shorts|create|subscriptions|you|beranda|buat|langganan|anda|notifications|notifikasi|search|telusuri|navigate up|more options)$/i

/** The bell in the home toolbar. Matched by description — its Search sibling is 84px away. */
export function notificationsBellOf(tree: UiNode): UiNode | null {
  return (
    flatten(tree).find(
      (n) => n.clickable && (n.packageName === '' || n.packageName === YOUTUBE_PACKAGE) && /^(notifications|notifikasi|pemberitahuan)$/i.test(n.desc.trim()),
    ) ?? null
  )
}

/**
 * Is the notifications screen on screen?
 *
 * `filter_bar` is the structural anchor; the title is the bilingual confirmation.
 * Either alone is weaker than it looks — `filter_bar` is a generic YouTube id
 * that other browse surfaces also use, and a title can be a heading inside a
 * feed — so both are required.
 */
export function onNotifications(tree: UiNode): boolean {
  if (rowsById(tree, 'filter_bar').length === 0) return false
  return flatten(tree).some((n) => /^(notifications|notifikasi|pemberitahuan)$/i.test(n.text.trim()))
}

/** The filter chips offered above the list. */
export function notificationFilters(tree: UiNode): string[] {
  return rowsById(tree, 'chip_cloud_chip_modern_text')
    .sort((a, b) => a.bounds.left - b.bounds.left)
    .map((n) => n.text.trim())
    .filter((v) => v !== '')
}

/**
 * The empty state, by its own marker rather than by "we found nothing".
 *
 * "found nothing" is also what a screen that failed to load looks like, and the
 * two must never report the same thing — `empty` is only ever true when YouTube
 * itself said so.
 *
 * The English marker is measured (2026-09-18 capture). The Indonesian wording
 * is NOT: no empty notifications screen has been captured in that locale, so it
 * is a defensive alternative. The cost of it being wrong is bounded and it is
 * the safe direction — an Indonesian device with no notifications reports
 * `empty: false` with an empty `items`, which understates rather than invents.
 */
export function notificationsEmpty(tree: UiNode): boolean {
  return flatten(tree).some((n) => /notifications live here|notifikasi anda (akan )?(muncul|ada) di sini/i.test(`${n.text} ${n.desc}`.trim()))
}

/**
 * The notification lines.
 *
 * A row is a clickable node whose own description carries the whole line (the
 * shape YouTube uses for its feed rows). Chrome words and the filter chips are
 * excluded, and the bottom navigation is cut off by band rather than by name so
 * a localisation this pack has not seen cannot leak "Subscriptions" into the
 * list.
 */
export function notificationItems(tree: UiNode, maxItems: number): string[] {
  const nodes = flatten(tree)
  let height = 0
  for (const n of nodes) if (n.bounds.bottom > height) height = n.bounds.bottom
  const navTop = height === 0 ? Number.POSITIVE_INFINITY : height * 0.85
  const out: string[] = []
  for (const n of nodes) {
    if (n.bounds.top >= navTop) continue
    const value = (n.desc.trim() || n.text.trim()).replace(/\s+/g, ' ')
    if (value === '' || CHROME.test(value) || out.includes(value)) continue
    // A row says something about a video or a channel; a bare chip does not.
    if (!n.clickable) continue
    out.push(value)
    if (out.length >= maxItems) break
  }
  return out
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'check-notifications',
  icon: 'bell',
  node: { category: 'device', icon: 'bell', summary: ['maxItems'], keywords: ['youtube', 'notifications', 'bell', 'warm-up'] },
  title: 'Check notifications',
  description: 'Opens the YouTube notifications (bell) screen and reads its items — never taps a notification, subscribes, or replies.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 8 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const steps: string[] = []

    const home = (await dismissPopups(ctx, await ctx.device.dump())).tree
    steps.push('home')
    const bell = notificationsBellOf(home)
    if (!bell) {
      await ctx.artifact.screenshot('yt-01-no-bell')
      throw new Error('the notifications bell was not in the YouTube toolbar — see artifact yt-01-no-bell')
    }
    await tapNode(ctx, bell)
    steps.push('tapped the bell')

    /*
      Reaching the screen is a REQUIREMENT, not an attempt. A run that never got
      here must fail, never return `empty: true` — that is the same mistake the
      Instagram pack's `check-activity` shipped in 0.2.0, reading the inbox and
      calling it notifications.
    */
    const opened = await waitForTree(ctx, onNotifications, { budgetMs: NOTIFICATIONS_ENTER_TIMEOUT_MS })
    if (!opened.ok) {
      await ctx.artifact.screenshot('yt-02-no-notifications')
      throw new Error('tapped the bell but the notifications screen never appeared — see artifact yt-02-no-notifications')
    }
    steps.push('notifications screen')

    const tree = opened.tree
    const filters = notificationFilters(tree)
    const empty = notificationsEmpty(tree)
    const items = empty ? [] : notificationItems(tree, ctx.params.maxItems)
    steps.push(empty ? 'empty' : `read ${items.length}`)
    ctx.log.info(`youtube: notifications — ${empty ? 'none' : `${items.length} item(s)`}`, { filters })

    return { items, empty, filters, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
  },
}

export default script
