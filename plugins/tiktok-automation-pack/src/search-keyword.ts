import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { between, makeRng, sleep } from './human'
import { searchFor } from './search'
import { capture, relaunch, readableStrings, TIKTOK_PACKAGE } from './gesture'

/**
 * `search-keyword` — run a TikTok keyword search and report what the results
 * page actually holds.
 *
 * Search itself is `search.ts`'s `searchFor`, unchanged: its anchors (the
 * bounds-filtered `Cari` icon, `tv_search_textview` submit, content-confirmed
 * tab selection) are the pack's hardware-measured ones. What this member adds
 * on top is the honest reading: the result page's tab is confirmed by the
 * app's own selected-state rule, then the tree is saved with a screenshot and
 * the readable strings on it are counted. On this build the result GRIDS
 * (Video/LIVE tabs) are Compose and expose nothing to the inspector —
 * `readableNodes: 0` on a full page is that opacity measured, reported rather
 * than papered over.
 *
 * Tabs are limited to the four whose descriptions are unique on the results
 * screen. `Toko` is deliberately not offered: the results tab shares its
 * `desc` verbatim with the bottom-navigation item, and a selector this pack
 * cannot disambiguate is a selector this pack does not tap.
 */

const paramsSchema = z.object({
  query: z.string().min(1).describe('The keyword to search for.').meta(ui({ title: 'Keyword' })),
  tab: z
    .enum(['Teratas', 'Video', 'Pengguna', 'LIVE'])
    .default('Teratas')
    .describe('Which results tab to land on.')
    .meta(ui({ title: 'Results tab' })),
  openDelayMs: z
    .number()
    .int()
    .min(0)
    .max(20_000)
    .default(1_500)
    .describe('Settle time on the results page before the tree is read.')
    .meta(ui({ title: 'Settle (ms)' })),
})

const resultSchema = z.object({
  query: z.string().meta(ui({ title: 'Keyword', summary: true })),
  tab: z.string().meta(ui({ title: 'Tab', summary: true })),
  tabConfirmed: z.boolean().describe('The selected-state proof from the app itself (the chosen tab reports clickable:false).').meta(ui({ title: 'Tab confirmed', summary: true })),
  readableNodes: z.number().int().describe('Non-empty text/description nodes below the tab strip. 0 on the grid tabs is the Compose opacity measured on hardware, not an empty page.').meta(ui({ title: 'Readable nodes', summary: true })),
  sample: z.array(z.string()).describe('Up to 10 of those strings, first-seen order — what the inspector could read at all.').meta(ui({ title: 'Sample' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'search-keyword',
  title: 'Search keyword',
  description: 'Searches TikTok for a keyword, lands on a results tab, and reports what the page really exposes — it opens nothing and never taps a result.',
  node: { category: 'inspect', icon: 'search', summary: ['query', 'tab'], keywords: ['search', 'keyword'] },
  params: paramsSchema,
  result: resultSchema,
  timeout: 5 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(Date.now() >>> 0)
    await sleep(between(rng, 500, 1_500))
    await searchFor(ctx, ctx.params.query, ctx.params.tab)
    await sleep(ctx.params.openDelayMs)
    const tree = await capture(ctx, 'results')

    // Tab selection is already confirmed inside `searchFor` (it throws otherwise); record it again
    // here as a fact of THIS run rather than a guess from the helper's success.
    const selected = (await ctx.device.find({ desc: ctx.params.tab }))?.clickable === false
    const strings = readableStrings(tree, 240)

    return {
      query: ctx.params.query,
      tab: ctx.params.tab,
      tabConfirmed: selected,
      readableNodes: strings.length,
      sample: strings.slice(0, 10),
    }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(TIKTOK_PACKAGE)
  },
}

export default script
