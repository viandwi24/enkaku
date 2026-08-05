import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * Ask the device what a selector actually resolves to, and report it.
 *
 * Written while chasing a script that passed while doing nothing: `waitFor`
 * matched `com.android.chrome:id/url_bar` and reported bounds covering the
 * whole 720×1640 screen, so the tap that followed landed in the middle of the
 * page instead of the address bar. A node claiming to be the size of the
 * viewport is almost always the wrong node, and there was no way to see that
 * without asking the device directly.
 *
 * Kept as an example because "what does this selector really match" is the
 * first question anyone writing a script has, and the Inspect panel cannot
 * answer it for a selector typed into a script rather than picked in the UI.
 */
export default defineScript({
  id: 'debug-node',
  version: '1.1.0',
  params: z.object({
    /** Resource id to resolve. Exactly one of `id` / `text` / `desc` is used. */
    id: z.string().optional(),
    text: z.string().optional(),
    desc: z.string().optional(),
    /** Launched first when set, so the probe runs against a known app. */
    launch: z.string().optional(),
    settleMs: z.number().int().min(0).default(3_000),
    /** List what the tree actually contains instead of resolving one selector. */
    listTree: z.boolean().default(false),
  }),
  timeout: 60_000,
  retries: 0,

  async run(ctx) {
    const { id, text, desc, launch, settleMs } = ctx.params
    if (launch) {
      await ctx.device.app.launch(launch)
      await new Promise((r) => setTimeout(r, settleMs))
    }

    if (ctx.params.listTree) {
      // What `dump()` really returns, so a selector can be written against
      // reality rather than against what the Inspect panel happened to show
      // a minute ago on a different screen.
      const root = await ctx.device.dump()
      const ids: string[] = []
      const texts: string[] = []
      const walk = (n: { resourceId: string; text: string; className: string; children: unknown[] }): void => {
        if (n.resourceId) ids.push(n.resourceId)
        if (n.text.trim()) texts.push(n.text.trim().slice(0, 40))
        for (const c of n.children) walk(c as typeof n)
      }
      walk(root as never)
      ctx.log.info('tree', { ids: ids.length, texts: texts.length })
      return { ids: [...new Set(ids)].slice(0, 40), texts: texts.slice(0, 25) }
    }

    const sel = id ? { id } : text ? { text } : desc ? { desc } : null
    if (!sel) throw new Error('give one of id / text / desc')

    const node = await ctx.device.find(sel)
    if (!node) {
      ctx.log.warn('selector matched nothing', { sel })
      return { found: false, sel }
    }

    const { left, top, right, bottom } = node.bounds
    const size = { w: right - left, h: bottom - top }
    // The whole point of the probe: a match is not the same as a usable
    // target. `tap` aims at the centre, so oversized bounds mean the tap
    // lands somewhere no one intended.
    const centre = { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) }

    ctx.log.info('resolved', {
      sel,
      className: node.className,
      resourceId: node.resourceId,
      text: node.text,
      desc: node.desc,
      bounds: node.bounds,
      size,
      centre,
      clickable: node.clickable,
      enabled: node.enabled,
    })

    return { found: true, sel, className: node.className, bounds: node.bounds, size, centre, clickable: node.clickable }
  },
})
