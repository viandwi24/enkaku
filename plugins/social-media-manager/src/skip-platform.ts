import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { PLATFORM_IDS } from './platforms'
import { postKeyFor, setPlatformSkip } from './posts'
import { readWithVersion, refreshGroupProgress } from './resolve-attempt'

/**
 * Turn one platform of one video off, or back on (0.45.0).
 *
 * The button behind the session page's **Skip** / **Enable**, and the member a
 * session's own skip rules are undone one cell at a time with. The owner's
 * case: twenty phones, three platforms, and two phones that have no YouTube
 * channel. Sending there produces a failed run on a real phone for something
 * that was never meant to happen, and a session that reads as broken when it
 * is finished.
 *
 * Every rule lives in `posts.ts`'s `setPlatformSkip` (pure, tested, with the
 * transition table written out). This member only reads the row with its
 * version and writes it back with `setIfVersion`, so a router tick that settled
 * the same row a moment earlier is re-read rather than overwritten — the same
 * shape `resolve-attempt` uses, and it shares that module's two helpers rather
 * than growing a second copy of them.
 *
 * **Nothing is sent by enabling.** The platform goes back to `pending` and the
 * router sends it at the row's next turn, exactly as if it had never been
 * skipped; on a session already started, that is within a tick.
 */

const params = z.object({
  videoArtifactId: z.string().min(1).describe('The video whose platform is being skipped or enabled.').meta(ui({ title: 'Video' })),
  platform: z.enum(PLATFORM_IDS).describe('The platform to skip or enable for this video.').meta(ui({ title: 'Platform' })),
  skip: z
    .boolean()
    .default(true)
    .describe('true skips it: nothing is sent and the cell reads Skipped. false enables it again, and it goes out at the video\'s next turn.')
    .meta(ui({ title: 'Skip' })),
  note: z.string().max(300).optional().describe('Optional: why, in your words. Shown on the cell in place of the default sentence.').meta(ui({ title: 'Note' })),
})

const result = z.object({
  videoArtifactId: z.string().meta(ui({ title: 'Video', summary: true })),
  platform: z.string().meta(ui({ title: 'Platform', summary: true })),
  state: z.string().describe('The platform\'s state now: skipped, or pending once enabled.').meta(ui({ title: 'State', summary: true })),
  changed: z.boolean().describe('False when it was already in that state and nothing was written.').meta(ui({ title: 'Changed' })),
})

/** How many times a write that lost a race to the router is re-read and tried again. */
const WRITE_ATTEMPTS = 3

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'skip-platform',
  title: 'Skip or enable a platform',
  description:
    'Turns one platform off for one video — nothing is sent there, and the cell reads Skipped instead of failing on the phone — or turns it back on, which sends it at the video\'s next turn.',
  icon: 'upload',
  params,
  result,
  timeout: 60_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const { videoArtifactId, platform, skip } = ctx.params
    const key = postKeyFor(videoArtifactId)

    for (let round = 1; round <= WRITE_ATTEMPTS; round++) {
      const found = await readWithVersion(ctx, key)
      if (!found) throw codedError(`No video ${videoArtifactId} is stored — it may have been removed.`, 'E_NOT_FOUND')

      const outcome = setPlatformSkip({
        post: found.post,
        platform,
        skip,
        note: ctx.params.note ?? null,
        now: Math.floor(Date.now() / 1000),
      })
      if (!outcome.ok) throw codedError(outcome.message, outcome.code)

      // Already in that state: nothing to write, and nothing to race over. Two operators pressing
      // Skip on the same cell both get the answer they asked for rather than one of them a conflict.
      if (!outcome.changed) {
        return { videoArtifactId, platform, state: outcome.state.state, changed: false }
      }

      const written = await ctx.storage.global.setIfVersion(key, outcome.post, found.version)
      if (written === null) {
        ctx.log.info('the row changed while skipping a platform — reading it again', { key, platform, round })
        continue
      }

      ctx.log.info(skip ? 'platform skipped for this video' : 'platform enabled again for this video', { key, platform, state: outcome.state.state })
      if (outcome.post.groupId !== null) await refreshGroupProgress(ctx, outcome.post.groupId)
      return { videoArtifactId, platform, state: outcome.state.state, changed: true }
    }
    throw codedError('This video kept changing while it was being updated. Nothing was changed — refresh the page and try again.', 'E_CONFLICT')
  },
}

export default script
