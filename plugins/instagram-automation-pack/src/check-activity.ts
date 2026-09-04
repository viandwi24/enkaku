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
    // Try direct_tab first (inbox), then look for activity segment
    const tab = flatten(home).find((n) => n.resourceId.endsWith('direct_tab') && n.clickable)
    if (tab) {
      await tapNodeJittered(ctx, tab)
      await sleep(3_000)
    }
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
