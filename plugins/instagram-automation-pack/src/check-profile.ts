import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { flatten } from './tree'
import { IG, readableStrings, sleep, tapNodeJittered } from './behavior'

const paramsSchema = z.object({})
const resultSchema = z.object({
  username: z.string().meta(ui({ title: 'Username', summary: true })),
  posts: z.string().meta(ui({ title: 'Posts' })),
  followers: z.string().meta(ui({ title: 'Followers' })),
  following: z.string().meta(ui({ title: 'Following' })),
  bio: z.string().meta(ui({ title: 'Bio' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'check-profile',
  title: 'Check profile',
  description: 'Opens the logged-in profile page and reads username, stats, and bio — never edits or follows anyone.',
  params: paramsSchema, result: resultSchema, timeout: 8 * 60_000,
  async prepare(ctx) { await ctx.device.app.forceStop(IG); await ctx.device.app.launch(IG); await sleep(5_000) },
  async run(ctx) {
    const home = await ctx.device.dump()
    const tab = flatten(home).find((n) => n.resourceId.endsWith('profile_tab') && n.clickable)
    if (!tab) throw new Error('profile_tab not found')
    await tapNodeJittered(ctx, tab)
    await sleep(4_000)
    const tree = await ctx.device.dump()
    const texts = readableStrings(tree, 96)
    // IG profile: first text is usually username, then "X postingan Y pengikut Z mengikuti"
    const username = texts[0] ?? ''
    const stats = texts.find((s) => /postingan|pengikut|mengikuti|posts|followers|following/i.test(s)) ?? ''
    const bio = texts.filter((s) => !/postingan|pengikut|mengikuti|posts|followers|following|edit|profil/i.test(s)).slice(0, 3).join(' ')
    const extract = (label: string, text: string) => {
      const m = text.match(new RegExp(`(\\d+[\\.,]?\\d*)\\s*${label}`, 'i'))
      return m?.[1] ?? ''
    }
    return { username, posts: extract('postingan|posts', stats), followers: extract('pengikut|followers', stats), following: extract('mengikuti|following', stats), bio, steps: [`profile: ${username}`] }
  },
  async finish(ctx) { if (ctx.error) await ctx.artifact.screenshot('failed'); await ctx.device.app.forceStop(IG) },
}
export default script
