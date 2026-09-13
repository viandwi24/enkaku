import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { rowsById } from './tree'
import { INSTAGRAM_PACKAGE, capture, centre, openTab, relaunch, waitForTree } from './instagram'
import { onHomeFeed } from './scroll-feed'

/**
 * `check-activity` — open the notifications (heart) screen and read it.
 *
 * On Instagram 446.0 (the owner's moto g06 power, id-ID, 2026-09-14) the heart
 * is `notification` in the HOME FEED's top bar — not the bottom navigation's
 * `direct_tab`, which is "Pesan", the inbox. Up to 0.2.0 this member tapped
 * `direct_tab` and read the inbox under the notifications' name.
 *
 * The screen is headed by `activity_feed_header_row` sections. An account with
 * nothing to report shows only "Disarankan untuk Anda" — suggested people with
 * "Ikuti" buttons — and those are suggestions, not notifications: they are left
 * out of `items` and the section is reported by name
 * (`__fixtures__/screen-activity-suggestions.json`). Never follows or replies.
 */

const paramsSchema = z.object({ maxItems: z.number().int().min(5).max(80).default(30).meta(ui({ title: 'Max items' })) })
const resultSchema = z.object({
  items: z.array(z.string()).meta(ui({ title: 'Notifications', summary: true })),
  sections: z.array(z.string()).describe('The section headers on the screen, suggestions included.').meta(ui({ title: 'Sections', summary: true })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const SUGGESTION_SECTION = /disarankan|suggested|suggestions/i
const BUTTON_WORDS = /^(ikuti|follow|abaikan|dismiss|ikuti balik|follow back|mengikuti|following|lihat semua|see all)$/i

/** The notifications screen is on screen. */
export function onActivity(tree: UiNode): boolean {
  return rowsById(tree, 'activity_feed_header_row').length > 0
}

/** Section headers, top first. */
export function activitySections(tree: UiNode): UiNode[] {
  return rowsById(tree, 'activity_feed_header_row').sort((a, b) => a.bounds.top - b.bounds.top)
}

/** Notification lines: text under a non-suggestion header, button labels left out. */
export function activityItems(tree: UiNode): string[] {
  const sections = activitySections(tree)
  const out: string[] = []
  const walk = (n: UiNode): void => {
    const value = (n.text.trim() || n.desc.trim())
    if (value !== '' && !BUTTON_WORDS.test(value) && n.resourceId.indexOf('activity_feed_header_row') === -1) {
      const header = sections.filter((s) => s.bounds.bottom <= n.bounds.top + 1).pop()
      if (header && !SUGGESTION_SECTION.test(header.text) && !out.includes(value)) out.push(value)
    }
    for (const child of n.children) walk(child)
  }
  walk(tree)
  return out
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'check-activity',
  icon: 'bell',
  node: { category: 'device', icon: 'bell', summary: ['maxItems'], keywords: ['instagram', 'notifications', 'activity', 'warm-up'] },
  title: 'Check notifications',
  description: 'Opens the Instagram notifications (heart) screen and reads its items — never likes, follows, or replies.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 8 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const steps: string[] = []
    /*
      The heart is a REQUIREMENT, not an attempt (0.2.0's lesson): a run that
      never reached the screen must not report "no notifications".
    */
    const feed = await openTab(ctx, 'feed_tab', (t) => onHomeFeed(t) && rowsById(t, 'notification').length > 0)
    const heart = rowsById(feed.tree, 'notification').find((n) => n.clickable)
    if (!heart) {
      await capture(ctx, 'ig-activity-no-heart', feed.tree)
      throw new Error('the home feed has no notifications (heart) button — see artifact ig-activity-no-heart')
    }
    await ctx.device.tap({ point: centre(heart) })
    const screen = await waitForTree(ctx, onActivity, { budgetMs: 15_000 })
    const tree = await capture(ctx, 'ig-activity', screen.tree)
    if (!screen.ok) throw new Error('tapped the heart but the notifications screen did not open — see artifact ig-activity')
    const sections = activitySections(tree).map((n) => n.text.trim())
    const items = activityItems(tree).slice(0, ctx.params.maxItems)
    steps.push(`activity: ${items.length} items in ${sections.length} sections`)
    await ctx.device.key('BACK')
    return { items, sections, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE).catch(() => {})
  },
}

export default script
