import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { all, flatten, rowsById, treeFrame, within } from './tree'
import { INSTAGRAM_PACKAGE, capture, centre, dismissPromos, navTab, promoDismissButton, relaunch, waitForTree } from './instagram'

/**
 * `check-inbox` — open the inbox and read its thread list. Never opens a chat.
 *
 * Measured through the farm's own reader on the owner's moto g06 power
 * (Instagram 446.0, 2026-09-14, `__fixtures__/screen-inbox-empty.json`): the
 * inbox is `direct_inbox_action_bar` over `inbox_refreshable_thread_list_recyclerview`,
 * with "Pesan" and "Permintaan" section labels. Three things the first routed
 * runs taught, each of which made the member report the wrong words:
 *
 * - an "Memperkenalkan instan" announcement sheet can cover the inbox — closed
 *   with its "not now" button, and a sheet still up fails the run;
 * - the reader keeps the home feed's nodes in the tree after the tab changes,
 *   some of them far off screen (x = -1419) — so the inbox is recognised by its
 *   own anchor, never by the feed's absence, and off-screen nodes are dropped;
 * - an account with no threads shows "Akun untuk diikuti", suggested accounts
 *   with Ikuti buttons — those are not threads, and are left out.
 */

const paramsSchema = z.object({
  maxItems: z.number().int().min(5).max(100).default(30).meta(ui({ title: 'Max items' })),
})
const resultSchema = z.object({
  unreadBadge: z.string().meta(ui({ title: 'Badge', summary: true })),
  sections: z.array(z.string()).meta(ui({ title: 'Sections', summary: true })),
  items: z.array(z.string()).meta(ui({ title: 'Items' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const CHROME_WORDS = /^(beranda|reels|pesan|profil|cara dan jelajahi|home|search|profile|messages|kembali|back|cari|search|memuat…|loading…|diverifikasi|verified|ikuti|follow|lihat semua|see all|pesan baru|new message)$/i
const SECTION_WORDS = /^(pesan|permintaan|messages|requests|catatan anda|your note|akun untuk diikuti|suggested for you)$/i

/** The inbox is on screen, by its own anchors. */
export function onInbox(tree: UiNode): boolean {
  return rowsById(tree, 'direct_inbox_action_bar').length > 0 || rowsById(tree, 'inbox_refreshable_thread_list_recyclerview').length > 0
}

/** Instagram's own readable strings below `minTop` and inside the frame, system UI left out, de-duplicated. */
export function inboxStrings(tree: UiNode, minTop: number): string[] {
  const { width } = treeFrame(tree)
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of flatten(tree)) {
    if (n.packageName !== INSTAGRAM_PACKAGE || n.bounds.top < minTop || n.bounds.left < 0 || n.bounds.right > width) continue
    for (const raw of [n.text, n.desc]) {
      const v = raw.trim()
      if (v === '' || seen.has(v) || CHROME_WORDS.test(v)) continue
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/** The thread list's words: everything in the list that is not a section label, a suggested-account cell, or the notes row. */
export function inboxItems(tree: UiNode): { sections: string[]; items: string[] } {
  const list = rowsById(tree, 'inbox_refreshable_thread_list_recyclerview')[0]
  const scope = list ?? tree
  const suggestions = rowsById(tree, 'igds_people_cell')
  const search = rowsById(tree, 'search_row')
  const excluded = (n: UiNode): boolean => suggestions.some((cell) => within(n, cell)) || search.some((row) => within(n, row))
  const strings = inboxStrings(scope, 0).filter((s) => {
    const node = all(scope, (n) => n.text.trim() === s || n.desc.trim() === s)[0]
    return node ? !excluded(node) : true
  })
  // Read straight off the nodes, not `strings`: "Pesan" is also the bottom-nav label, so the chrome filter drops it.
  const { width } = treeFrame(tree)
  const sections = [...new Set(all(scope, (n) => n.packageName === INSTAGRAM_PACKAGE && n.bounds.left >= 0 && n.bounds.right <= width && SECTION_WORDS.test(n.text.trim())).map((n) => n.text.trim()))]
  // The notes row ("Tambahkan catatan", "Tuangkan ide…", "Peta", "Lokasi nonaktif") sits above the "Pesan" label.
  const pesan = all(scope, (n) => /^(pesan|messages)$/i.test(n.text.trim()))[0]
  const items = strings.filter((s) => {
    if (SECTION_WORDS.test(s)) return false
    const node = all(scope, (n) => n.text.trim() === s || n.desc.trim() === s)[0]
    return !pesan || !node || node.bounds.top > pesan.bounds.bottom
  })
  return { sections, items }
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'check-inbox',
  icon: 'list',
  node: { category: 'device', icon: 'list', summary: ['maxItems'], keywords: ['instagram', 'inbox', 'messages', 'warm-up'] },
  title: 'Check inbox (DMs)',
  description: 'Opens the Instagram inbox, reports the unread badge and the list of message threads — never taps into a chat.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 8 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const steps: string[] = []
    const home = await ctx.device.dump()
    const tab = navTab(home, 'direct_tab')
    if (!tab) {
      await capture(ctx, 'ig-inbox-no-tab', home)
      throw new Error('direct_tab not found — see artifact ig-inbox-no-tab')
    }
    // The badge sits on the tab itself, so read it before leaving the home screen.
    const badge = flatten(home).find((n) => n.packageName === INSTAGRAM_PACKAGE && /^\d+\+?$/.test(n.text.trim()) && n.bounds.top >= tab.bounds.top - 40 && n.bounds.left >= tab.bounds.left && n.bounds.right <= tab.bounds.right)?.text.trim() ?? ''
    await ctx.device.tap({ point: centre(tab) })
    let opened = await waitForTree(ctx, (t) => onInbox(t) || promoDismissButton(t) !== null, { budgetMs: 12_000 })
    if (promoDismissButton(opened.tree)) {
      await dismissPromos(ctx)
      opened = await waitForTree(ctx, (t) => onInbox(t) && promoDismissButton(t) === null, { budgetMs: 8_000 })
    }
    // Threads load after the list chrome ("Memuat…"); give them a moment before reading.
    const settled = await waitForTree(ctx, (t) => onInbox(t) && all(t, (n) => /^(memuat…|loading…)$/i.test(n.desc.trim())).length === 0, { budgetMs: 8_000 })
    const tree = await capture(ctx, 'ig-inbox', settled.tree)
    if (promoDismissButton(tree)) throw new Error('an Instagram announcement sheet is still covering the inbox after "not now" — see artifact ig-inbox')
    if (!onInbox(tree)) throw new Error('tapped the inbox tab but the inbox did not open — see artifact ig-inbox')
    if (!settled.ok) steps.push('threads were still loading')
    const { sections, items } = inboxItems(tree)
    steps.push(`inbox: ${items.length} items, badge=${badge}`)
    return { unreadBadge: badge, sections, items: items.slice(0, ctx.params.maxItems), steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE).catch(() => {})
  },
}

export default script
