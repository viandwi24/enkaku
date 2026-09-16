import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { flatten } from './tree'
import { INSTAGRAM_PACKAGE, capture, centre, navTab, relaunch, sleep } from './instagram'
import { readableStrings, tapNodeJittered } from './behavior'

const paramsSchema = z.object({
  query: z.string().min(1).describe('Keyword to search.').meta(ui({ title: 'Keyword' })),
  tab: z.enum(['Teratas', 'Akun', 'Audio', 'Tagar', 'Reels']).default('Teratas').meta(ui({ title: 'Results tab' })),
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
  icon: 'search',
  node: { category: 'device', icon: 'search', summary: ['query'], keywords: ['instagram', 'search', 'keyword'] },
  title: 'Search keyword',
  description: 'Searches Instagram for a keyword and reports what the results page exposes — opens nothing.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 5 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const steps: string[] = []
    const home = await ctx.device.dump()
    const tab = navTab(home, 'search_tab')
    if (!tab) throw new Error('search_tab not found')
    await ctx.device.tap({ point: centre(tab) })
    await sleep(2_500)
    const tree = await ctx.device.dump()
    /*
      The Explore search box is not always an EditText (0.10.3). Production 2026-09-16: seven runs failed "the Explore
      screen shows no search field" while the field was right there — `action_bar_search_edit_text` at [23,64][697,130],
      clickable, reading "Cari", but drawn as an `android.widget.Button` on that build. So the id counts as much as the
      class does; both are still required to sit in the top bar, which is what keeps a comment box or a caption field
      further down the screen from ever being mistaken for it.
    */
    const searchIds = ['action_bar_search_edit_text', 'action_bar_search_hints_text_layout']
    const input = flatten(tree).find(
      (n) => n.bounds.top < 320 && (n.className.includes('EditText') || searchIds.some((id) => n.resourceId.endsWith(`/${id}`) || n.resourceId === id)),
    )
    if (!input) {
      await capture(ctx, 'ig-search-no-field', tree)
      throw new Error('the Explore screen shows no search field — see artifact ig-search-no-field')
    }
    await tapNodeJittered(ctx, input)
    await sleep(800)
    /*
      Typed the way a person does (0.10.7). The plain call was already per-character — the farm's
      `natural` profile paces it — but a person also lingers at the end of a word and stops to think
      every few words, which is what `human` adds. Typos stay off: Explore edits its suggestion list
      under the cursor, and a backspace there can commit a suggestion rather than the typed text.
    */
    const typed = await ctx.device.type(ctx.params.query, { human: { typo: { probability: 0 } } })
    steps.push(`typed via ${typed.via}`)
    await sleep(1_000)
    await ctx.device.key('ENTER')
    await sleep(ctx.params.openDelayMs)
    const results = await capture(ctx, 'ig-search-results')
    const strings = readableStrings(results, 250)
    steps.push('search-done')
    return { query: ctx.params.query, tab: ctx.params.tab, readableNodes: strings.length, sample: strings.slice(0, 10), steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE).catch(() => {})
  },
}

export default script
