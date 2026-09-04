import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { flatten } from './tree'
import { IG, readableStrings, sleep, tapNodeJittered } from './behavior'

const paramsSchema = z.object({
  query: z.string().min(1).describe('Keyword to search.').meta(ui({ title: 'Keyword' })),
  tab: z.enum(['Teratas','Akun','Audio','Tagar','Reels']).default('Teratas').meta(ui({ title: 'Results tab' })),
  openDelayMs: z.number().int().min(0).max(10_000).default(1_500).meta(ui({ title: 'Settle (ms)' })),
})
const resultSchema = z.object({
  query: z.string().meta(ui({ title: 'Keyword', summary: true })),
  tab: z.string().meta(ui({ title: 'Tab' })),
  readableNodes: z.number().int().meta(ui({ title: 'Readable nodes', summary: true })),
  sample: z.array(z.string()).meta(ui({ title: 'Sample' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'search-keyword',
  title: 'Search keyword',
  description: 'Searches Instagram for a keyword and reports what the results page exposes — opens nothing.',
  params: paramsSchema, result: resultSchema, timeout: 5 * 60_000,
  async prepare(ctx) { await ctx.device.app.forceStop(IG); await ctx.device.app.launch(IG); await sleep(5_000) },
  async run(ctx) {
    const home = await ctx.device.dump()
    const tab = flatten(home).find((n) => n.resourceId.endsWith('search_tab') && n.clickable)
    if (!tab) throw new Error('search_tab not found')
    await tapNodeJittered(ctx, tab)
    await sleep(2_000)
    // Type keyword: Instagram search bar is an EditText — use device.type()
    const tree = await ctx.device.dump()
    const input = flatten(tree).find((n) => n.className?.includes('EditText') && n.bounds.top < 300)
    if (input) { await tapNodeJittered(ctx, input); await sleep(500); await ctx.device.type(ctx.params.query); await sleep(1_000) }
    await ctx.device.key('ENTER')
    await sleep(ctx.params.openDelayMs)
    const results = await ctx.device.dump()
    const strings = readableStrings(results, 250)
    return { query: ctx.params.query, tab: ctx.params.tab, readableNodes: strings.length, sample: strings.slice(0, 10), steps: ['search-done'] }
  },
  async finish(ctx) { if (ctx.error) await ctx.artifact.screenshot('failed'); await ctx.device.app.forceStop(IG) },
}
export default script
