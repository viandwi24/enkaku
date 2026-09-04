import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { flatten } from './tree'
import { IG, readableStrings, sleep, sweepAck, tapNodeJittered } from './behavior'

const paramsSchema = z.object({
  maxItems: z.number().int().min(5).max(100).default(30).meta(ui({ title: 'Max items' })),
})
const resultSchema = z.object({
  unreadBadge: z.string().meta(ui({ title: 'Badge', summary: true })),
  sections: z.array(z.string()).meta(ui({ title: 'Sections', summary: true })),
  items: z.array(z.string()).meta(ui({ title: 'Items' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'check-inbox',
  title: 'Check inbox (DMs)',
  description: 'Opens the Instagram inbox, reports the unread badge and the list of message threads — never taps into a chat.',
  params: paramsSchema, result: resultSchema, timeout: 8 * 60_000,
  async prepare(ctx) { await ctx.device.app.forceStop(IG); await ctx.device.app.launch(IG); await sleep(5_000) },
  async run(ctx) {
    const steps: string[] = []
    const home = await ctx.device.dump()
    const tab = flatten(home).find((n) => n.resourceId.endsWith('direct_tab') && n.clickable)
    if (!tab) throw new Error('direct_tab not found')
    // Use a press (Instagram needs duration on this device)
    await tapNodeJittered(ctx, tab)
    await sleep(3_000); sweepAck(ctx).catch(() => {})
    const tree = await ctx.device.dump()
    const badge = flatten(tree).find((n) => /^\d+\+?$/.test(n.text.trim()) && n.bounds.top > 2000)?.text.trim() ?? ''
    const sections = [...new Set(readableStrings(tree, 96).filter((s) => /permintaan|pesan|aktivitas|catatan/i.test(s) || s === 'Coba bagikan lagu...'))]
    const items = readableStrings(tree, 300).filter((s) => !/beranda|reels|cara|profil|coba/i.test(s)).slice(0, ctx.params.maxItems)
    steps.push(`inbox: ${items.length} items, badge=${badge}`)
    return { unreadBadge: badge, sections, items, steps }
  },
  async finish(ctx) { if (ctx.error) await ctx.artifact.screenshot('failed'); await ctx.device.app.forceStop(IG) },
}
export default script
