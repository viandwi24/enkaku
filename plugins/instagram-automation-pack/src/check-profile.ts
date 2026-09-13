import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { rowsById } from './tree'
import { INSTAGRAM_PACKAGE, capture, openTab, relaunch } from './instagram'

/**
 * `check-profile` — read the signed-in account's own profile header.
 *
 * Every value comes from its own id, measured on the owner's moto g06 power
 * (Instagram 446.0, id-ID, 2026-09-14, `__fixtures__/screen-profile-empty.json`):
 * `action_bar_title` (the handle), `profile_header_familiar_post_count_value`,
 * `…followers_value`, `…following_value`, `profile_header_full_name_above_vanity`.
 * Up to 0.2.0 this read a "N postingan" sentence that this build no longer
 * writes — the number and its label are separate nodes — and returned blanks.
 */

const paramsSchema = z.object({})
const resultSchema = z.object({
  username: z.string().meta(ui({ title: 'Username', summary: true })),
  fullName: z.string().meta(ui({ title: 'Name' })),
  posts: z.string().meta(ui({ title: 'Posts', summary: true })),
  followers: z.string().meta(ui({ title: 'Followers', summary: true })),
  following: z.string().meta(ui({ title: 'Following' })),
  bio: z.string().meta(ui({ title: 'Bio' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const textOf = (tree: UiNode, id: string): string => rowsById(tree, id)[0]?.text.trim() ?? ''

/** The profile header's readings, by id. Empty strings where a value is not on screen. */
export function readProfile(tree: UiNode): { username: string; fullName: string; posts: string; followers: string; following: string; bio: string } {
  const bioNode = rowsById(tree, 'profile_header_bio_text')[0]
  return {
    username: textOf(tree, 'action_bar_title'),
    fullName: textOf(tree, 'profile_header_full_name_above_vanity') || textOf(tree, 'profile_header_full_name'),
    posts: textOf(tree, 'profile_header_familiar_post_count_value'),
    followers: textOf(tree, 'profile_header_familiar_followers_value'),
    following: textOf(tree, 'profile_header_familiar_following_value'),
    bio: bioNode ? (bioNode.text.trim() || bioNode.desc.trim()) : '',
  }
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'check-profile',
  icon: 'users',
  node: { category: 'device', icon: 'users', summary: [], keywords: ['instagram', 'profile', 'followers'] },
  title: 'Check profile',
  description: 'Opens the logged-in profile page and reads username, stats, and bio — never edits or follows anyone.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 8 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const profile = await openTab(ctx, 'profile_tab', (t) => rowsById(t, 'profile_header_familiar_post_count_value').length > 0)
    const tree = await capture(ctx, 'ig-profile', profile.tree)
    if (!profile.ok) throw new Error('the profile header did not appear after the profile tab — see artifact ig-profile')
    const read = readProfile(tree)
    return { ...read, steps: [`profile: ${read.username}`] }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE).catch(() => {})
  },
}

export default script
