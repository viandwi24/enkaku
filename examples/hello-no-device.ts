import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * A script for testing the runner without a device: logs and a file artifact
 * only, touching no device API at all.
 */
export default defineScript({
  id: 'hello-no-device',
  version: '1.0.0',
  params: z.object({
    message: z.string().default('hello'),
    failMe: z.boolean().default(false),
    sleepMs: z.number().int().min(0).max(60_000).default(0),
  }),
  timeout: 20_000,

  async prepare(ctx) {
    ctx.log.info(`prepare: ${ctx.params.message}`)
  },

  async run(ctx) {
    if (ctx.params.sleepMs > 0) await new Promise((r) => setTimeout(r, ctx.params.sleepMs))
    await ctx.artifact.file('note', `message: ${ctx.params.message}\n`, { ext: 'txt' })
    if (ctx.params.failMe) throw new Error('deliberate failure')
    ctx.log.info('run finished')
    return { echoed: ctx.params.message }
  },

  async finish(ctx) {
    ctx.log.info(`finish ran (error: ${ctx.error?.code ?? 'none'})`)
  },
})
