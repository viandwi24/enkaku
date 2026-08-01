import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * Contoh script e2e: buka Settings, tunggu UI muncul, ambil screenshot,
 * lalu bersihkan state di `finish` (spec §11.1).
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
    ctx.log.info(`menyiapkan ${ctx.params.package}`)
    await ctx.device.app.forceStop(ctx.params.package)
    await ctx.device.app.launch(ctx.params.package)
  },

  async run(ctx) {
    const node = await ctx.device.waitFor({ text: ctx.params.waitText }, { timeout: 15_000 })
    await ctx.artifact.screenshot('settings-terbuka')
    ctx.log.info(`menemukan "${ctx.params.waitText}"`, { bounds: node.bounds })
    return { ok: true, foundText: ctx.params.waitText }
  },

  async finish(ctx) {
    // finish HARUS stateless & idempotent — hanya bergantung pada ctx.
    if (ctx.error) await ctx.artifact.screenshot('gagal')
    await ctx.device.app.forceStop(ctx.params.package)
  },
})
