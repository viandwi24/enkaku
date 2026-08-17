import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * An end-to-end example: open Settings, wait for its UI, take a screenshot,
 * then clean up state in `finish` (spec §11.1).
 *
 * The script lives inside a plugin because that is the only place a script
 * can live (plan 110 §3.1) — the plugin is what the farm publishes, versions,
 * and rolls back.
 */
export default definePlugin({
  id: 'open-settings',
  version: '1.0.0',
  title: 'Open Settings',
  description: 'The end-to-end example: launch, wait, screenshot, clean up.',
  scripts: [
    {
      id: 'main',
      title: 'Open Settings',
      description: 'Launches an app, waits for a text to appear, and screenshots it.',
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
    },
  ],
})
