import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * An end-to-end example: open Settings, wait for its UI, take a screenshot,
 * then clean up state in `finish` (spec §11.1).
 */
export default defineScript({
  id: 'open-settings',
  version: '1.0.0',
  params: z.object({
    package: z.string().default('com.android.settings'),
    waitText: z.string().default('Settings'),
  }),
  timeout: 60_000,
  retries: 1,

  async prepare(ctx) {
    ctx.log.info(`preparing ${ctx.params.package}`)
    await ctx.device.app.forceStop(ctx.params.package)
    await ctx.device.app.launch(ctx.params.package)
  },

  async run(ctx) {
    const node = await ctx.device.waitFor({ text: ctx.params.waitText }, { timeout: 15_000 })
    await ctx.artifact.screenshot('settings-open')
    ctx.log.info(`found "${ctx.params.waitText}"`, { bounds: node.bounds })
    return { ok: true, foundText: ctx.params.waitText }
  },

  async finish(ctx) {
    // finish MUST be stateless and idempotent — it may depend on ctx alone.
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(ctx.params.package)
  },
})
