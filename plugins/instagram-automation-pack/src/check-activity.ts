import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { flatten } from './tree'
import { IG, readableStrings, sleep, tapNodeJittered } from './behavior'

const paramsSchema = z.object({ maxItems: z.number().int().min(5).max(80).default(30).meta(ui({ title: 'Max items' })) })
const resultSchema = z.object({
  items: z.array(z.string()).meta(ui({ title: 'Notifications', summary: true })),
  unreadCount: z.string().meta(ui({ title: 'Unread', summary: true })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'check-activity',
  title: 'Check notifications',
  description: 'Opens the Instagram activity (heart) tab and reads notification items — never likes, follows, or replies.',
  params: paramsSchema, result: resultSchema, timeout: 8 * 60_000,
  async prepare(ctx) { await ctx.device.app.forceStop(IG); await ctx.device.app.launch(IG); await sleep(5_000) },
  async run(ctx) {
    // In modern IG, activity is merged into inbox. Tap the header dropdown to switch to Aktivitas.
    const home = await ctx.device.dump()
    /*
      The tab is a REQUIREMENT, not an attempt.

      This lookup used to be `if (tab) { … }` with no else, so a run that never
      found the tab fell through to the read below, matched none of the
      notification words in whatever screen it was actually looking at, and
      returned `items: []` — a green step meaning "this account has no
      notifications" when the truth was "Instagram was never open". On a phone
      with no Instagram installed at all it reported success four times over.
      `check-inbox` and `check-profile` next door have always thrown here; the
      odd one out was this file.
    */
    const tab = flatten(home).find((n) => n.resourceId.endsWith('direct_tab') && n.clickable)
    if (!tab) throw new Error('direct_tab not found — Instagram is not on the screen it was launched to')
    await tapNodeJittered(ctx, tab)
    await sleep(3_000)
    // Activity may be under a segment/tab "Aktivitas" — read whatever notification-like text exists
    const tree = await ctx.device.dump()
    const all = readableStrings(tree, 200)
    const activityItems = all.filter((s) => /mulai mengikuti|menyukai|berkomentar|mention|notifikasi|aktivitas|followed|liked|commented/i.test(s))
    const unread = flatten(tree).find((n) => /^\d+$/.test(n.text.trim()) && n.bounds.top > 100 && n.bounds.top < 300)?.text.trim() ?? ''
    const steps = [`activity: ${activityItems.length} items, unread=${unread}`]
    return { items: activityItems.slice(0, ctx.params.maxItems), unreadCount: unread, steps }
  },
  async finish(ctx) { if (ctx.error) await ctx.artifact.screenshot('failed'); await ctx.device.app.forceStop(IG) },
}
export default script
