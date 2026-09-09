import { ui, type PluginMemberScript, type ScriptContext } from '@enkaku/sdk'
import { z } from 'zod'
import { PLATFORM_IDS } from './platforms'
import { PostSchema, newPost, postKeyFor, stateFor } from './posts'

/**
 * Writes ONE post row: a video, a caption, and the platforms it is for.
 *
 * ## Why this is a script and not a declarative `kv.set`
 *
 * The same reason `tiktok/enqueue-video` is (see its own comment): a surface
 * `kv.set` action keys its write off a `Binding`, and a `Binding` has no
 * concatenation — no operators, no interpolation, no calls. Nothing
 * declarative can compute `post:<artifactId>` from an artifact id the operator
 * just picked. The DELETE path needs no script for exactly the mirror reason:
 * a row already read out of `kv.list` carries its own exact key as
 * `$entry.key`, so `removePost` in the surface is a plain `kv.delete` with no
 * code behind it.
 *
 * ## The device this runs on does nothing
 *
 * A `job` action always dispatches to some device — every script is queued
 * against a device-bound job queue, which is a structural fact about the
 * system rather than a plugin-surface gap — even though this member's whole
 * body is one farm-wide KV write that touches no phone. The surface's
 * `addPost` action therefore declares `device: 'picker'` and the operator
 * picks any online phone to run it on; `ctx.device` is never referenced below.
 * Named here so it reads as a deliberate trade-off rather than an oversight.
 */

const params = z.object({
  videoArtifactId: z
    .string()
    .min(1)
    .describe('The uploaded video to post.')
    .meta(ui({ title: 'Video', kind: 'artifact', group: 'Post' })),
  caption: z
    .string()
    .min(1)
    .max(2_200)
    .describe('Typed into the app when the video is posted. Required — see below.')
    .meta(ui({ title: 'Caption', group: 'Post' })),
  platforms: z
    .array(z.enum(PLATFORM_IDS))
    .min(1)
    .describe('Which platforms this video is for. Each one sends to the phones carrying that platform\'s label.')
    .meta(ui({ title: 'Platforms', group: 'Post' })),
})

const result = z.object({
  key: z.string().describe('The post row written.').meta(ui({ title: 'Key' })),
  videoArtifactId: z.string().describe('The video this post carries.').meta(ui({ title: 'Video', summary: true })),
  platforms: z.array(z.string()).describe('The platforms stored, in canonical order.').meta(ui({ title: 'Platforms', summary: true })),
  replaced: z.boolean().describe('Whether an existing post for this same video was updated rather than created.').meta(ui({ title: 'Updated existing' })),
})

const addPost: PluginMemberScript<typeof params, typeof result> = {
  id: 'add-post',
  title: 'Add a post',
  description:
    'Writes one post row — a video, a caption, and the platforms it is for. Used by the Social posts screen’s “New post” button; nothing on the device is touched.',
  icon: 'upload',
  node: { category: 'data', icon: 'upload', summary: ['videoArtifactId'], keywords: ['post', 'social', 'video'] },
  params,
  result,
  /** Generous for a single KV round trip — this member does no device work at all. */
  timeout: 15_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const { videoArtifactId, caption, platforms } = ctx.params
    const key = postKeyFor(videoArtifactId)
    /*
     * Trimmed and refused when empty, rather than stored as whitespace.
     *
     * The caption is REQUIRED, and that is not this plugin's preference: the
     * only dispatch path it uses — `tiktok/post-video` with `source: 'direct'`
     * — refuses an empty caption in its own `resolveDirect`, because the
     * captions-file fallback belongs to its `queue` and `folder` sources and
     * there is nothing to fall back to when the caller names the video itself.
     * Catching it here means the operator is told at the dialog rather than by
     * a failed job on every phone the post reached.
     */
    const nextCaption = caption.trim()
    if (nextCaption.length === 0) {
      throw Object.assign(new Error('A caption is required — the post flow refuses an empty one, so a post stored without it would fail on every phone.'), {
        code: 'E_PARAMS_INVALID',
      })
    }
    const now = Math.floor(Date.now() / 1000)

    // Read through the schema, which THROWS on a shape this build does not
    // understand — the fail-loud posture the whole plugin takes with stored
    // rows. Overwriting a row written by a newer version would be the one way
    // to lose a dispatch record that is already true on a phone.
    const existing = await ctx.storage.global.get(key, PostSchema)

    const next = newPost({ videoArtifactId, caption: nextCaption, platforms, now: existing?.createdAt ?? now })

    if (existing) {
      /*
       * Re-adding a video an operator already posted must never re-post it.
       * Every platform already marked `dispatched` keeps its state verbatim,
       * so the router's "dispatched once, never again" rule survives an edit —
       * a duplicate post is the one failure here nobody can undo from the farm.
       *
       * A platform NEWLY added to the list has no carried state and starts
       * pending, which is exactly the useful case: "I posted this to TikTok
       * last week, now send it to Instagram too."
       */
      for (const id of next.platforms) {
        const carried = stateFor(existing, id)
        // Every state that means "phones have already been given this video"
        // is carried, not just `dispatched`. When outcomes were added,
        // `succeeded`/`partial`/`failed` became reachable here, and carrying
        // only `dispatched` would have reset a finished platform to `pending`
        // — handing the router a post it believes has never been sent, and
        // publishing the same video to the same account a second time.
        if (carried.state !== 'pending') next.dispatch[id] = carried
      }
    }

    await ctx.storage.global.set(key, next)
    ctx.log.info(existing ? 'updated an existing post' : 'created a post', {
      key,
      platforms: next.platforms.join(','),
      caption: `${nextCaption.length} chars`,
    })

    return { key, videoArtifactId, platforms: next.platforms, replaced: existing !== null }
  },
}

export default addPost
