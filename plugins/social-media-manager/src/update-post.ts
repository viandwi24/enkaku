import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { GroupSchema, groupKeyFor } from './groups'
import { NO_HASHTAG_RULE } from './hashtags'
import { PLATFORM_CAPTION_STORED_MAX } from './platform-captions'
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
  caption: z.string().max(2_200).optional().describe('The caption for the next attempt. Empty is allowed while the video keeps hashtags.').meta(ui({ title: 'Caption' })),
  hashtags: z.array(z.string().max(100)).max(30).optional().describe('The video\'s own hashtags (the session\'s fixed ones and its picked line are added when it posts).').meta(ui({ title: 'Hashtags' })),
  platformCaptions: z
    .object({
      tiktok: z.string().max(PLATFORM_CAPTION_STORED_MAX).optional(),
      instagram: z.string().max(PLATFORM_CAPTION_STORED_MAX).optional(),
      youtube: z.string().max(PLATFORM_CAPTION_STORED_MAX).optional(),
    })
    .strict()
    .optional()
    .describe('A text per platform, posted there instead of the caption and hashtags. An empty text fits that platform\'s caption from the caption and hashtags again; a platform left out is unchanged.')
    .meta(ui({ title: 'Caption per platform' })),
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
      ...(ctx.params.hashtags !== undefined ? { hashtags: ctx.params.hashtags } : {}),
      ...(ctx.params.platformCaptions !== undefined ? { platformCaptions: ctx.params.platformCaptions } : {}),
    }
    // The session's hashtag rule, so a caption edit re-fits each platform's caption with the hashtags it posts with (0.28.0).
    const group = post.groupId !== null ? await ctx.storage.global.get(groupKeyFor(post.groupId), GroupSchema).catch(() => null) : null
    const outcome = applyPostEdit({ post, edit, sessionRows, rule: group?.hashtags ?? NO_HASHTAG_RULE })
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
