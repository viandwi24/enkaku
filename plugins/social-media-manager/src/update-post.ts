import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { PLATFORM_IDS } from './platforms'
import { POST_PREFIX, PostSchema, applyPostEdit, postKeyFor, type Post } from './posts'

/**
 * Change one video of a session after the session was made: its phone, its platforms, its caption.
 *
 * The owner asked for exactly this — a video that went into a session must still be editable, so a
 * retry uses the new phone or platform. Every rule lives in `posts.ts`'s `applyPostEdit` (pure,
 * tested); this member only reads the rows it needs and stores the answer.
 *
 * Nothing is sent by an edit. A newly added platform goes out at the video's next turn; a failed one
 * is re-sent by the session's Retry failed, which goes to the video's (new) phone.
 */

const params = z.object({
  videoArtifactId: z.string().min(1).describe('The video to change.').meta(ui({ title: 'Video' })),
  assignedDeviceId: z
    .string()
    .min(1)
    .optional()
    .describe('The phone this video posts from. A phone another video of the session has is allowed, with a warning.')
    .meta(ui({ title: 'Phone' })),
  platforms: z.array(z.enum(PLATFORM_IDS)).min(1).optional().describe('Where this video posts.').meta(ui({ title: 'Platforms' })),
  caption: z.string().min(1).max(2_200).optional().describe('The caption for the next attempt.').meta(ui({ title: 'Caption' })),
})

const result = z.object({
  videoArtifactId: z.string().meta(ui({ title: 'Video', summary: true })),
  changed: z.array(z.string()).describe('What was changed — phone, platforms, caption. Empty when the edit matched what was stored.').meta(ui({ title: 'Changed', summary: true })),
  warnings: z.array(z.string()).describe('Allowed, but worth knowing: an upload still running, or a phone another video also has.').meta(ui({ title: 'Warnings' })),
})

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'update-post',
  title: 'Edit a video in a session',
  description: 'Changes a video\'s phone, platforms or caption for its next attempt. Warns — without refusing — when the video is uploading or the phone already has another video of the session.',
  icon: 'upload',
  params,
  result,
  timeout: 60_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const key = postKeyFor(ctx.params.videoArtifactId)
    const post = await ctx.storage.global.get(key, PostSchema)
    if (!post) throw Object.assign(new Error(`No video ${ctx.params.videoArtifactId} is stored — it may have been removed.`), { code: 'E_NOT_FOUND' })

    // The session's other rows, only when the phone is changing — ownership is a session-wide question.
    const sessionRows: Post[] = []
    if (ctx.params.assignedDeviceId !== undefined && post.groupId !== null) {
      let cursor: string | null = null
      do {
        const opts: { prefix: string; limit: number; cursor?: string } = { prefix: POST_PREFIX, limit: 500 }
        if (cursor !== null) opts.cursor = cursor
        const page = await ctx.storage.global.list(opts)
        for (const entry of page.items) {
          const parsed = PostSchema.safeParse(entry.value)
          if (parsed.success && parsed.data.groupId === post.groupId) sessionRows.push(parsed.data)
        }
        cursor = page.nextCursor
      } while (cursor !== null)
    }

    const edit = {
      ...(ctx.params.assignedDeviceId !== undefined ? { assignedDeviceId: ctx.params.assignedDeviceId } : {}),
      ...(ctx.params.platforms !== undefined ? { platforms: ctx.params.platforms } : {}),
      ...(ctx.params.caption !== undefined ? { caption: ctx.params.caption } : {}),
    }
    const outcome = applyPostEdit({ post, edit, sessionRows })
    if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code })

    if (outcome.changed.length > 0) {
      await ctx.storage.global.set(key, outcome.post)
      ctx.log.info('edited a video in its session', { key, changed: outcome.changed.join(', ') })
    }
    if (outcome.warnings.length > 0) ctx.log.warn('edit applied with warnings', { key, warnings: outcome.warnings.join(' | ') })
    return { videoArtifactId: post.videoArtifactId, changed: outcome.changed, warnings: outcome.warnings }
  },
}

export default script
