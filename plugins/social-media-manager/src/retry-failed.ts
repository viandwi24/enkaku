import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { platformById } from './platforms'
import { PostSchema, failedDevices, postKeyFor, rollUp, stateFor, type Attempt } from './posts'

/**
 * Re-run the phones whose upload failed — and only those.
 *
 * ## Why this is a script and not a `batch` row action
 *
 * `postToTikTokNow` next door is a `batch` with `target: 'picker'`: the
 * operator chooses the phones. That is the right control for "send this
 * somewhere new" and the wrong one for a retry, because the phones are not the
 * operator's to choose — they are a fact already stored on the post. A picker
 * here would invite exactly the mistake a retry must never make: ticking a
 * phone that already posted, and publishing the video to that account twice.
 *
 * So the set comes from `failedDevices`, which reads the attempts the router
 * recorded. Nothing about it is a guess, and nothing about it is adjustable.
 *
 * ## It touches no device itself
 *
 * Like `add-post`, this member does device work only in the sense that it
 * *enqueues* it. Its body is a KV read, N `job.run` calls, and a KV write, so
 * the surface declares `device: 'picker'` and `ctx.device` is never referenced.
 * Named here so it reads as a deliberate trade-off rather than an oversight.
 */

const params = z.object({
  videoArtifactId: z
    .string()
    .min(1)
    .describe('The post to retry, by the video it carries.')
    .meta(ui({ title: 'Video' })),
})

const result = z.object({
  requeued: z.number().int().describe('How many phones were sent the video again.').meta(ui({ title: 'Re-queued', summary: true })),
  platforms: z.array(z.string()).describe('The platforms that had something to retry.').meta(ui({ title: 'Platforms', summary: true })),
  skipped: z.array(z.string()).describe('Phones that could not be re-queued, and why.').meta(ui({ title: 'Skipped' })),
})

const JobRunOutput = z.object({ jobId: z.string() })

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'retry-failed',
  title: 'Re-run failed',
  description:
    'Sends this video again to the phones whose upload failed — and to no others. A phone that already posted is never re-sent, because that would publish the same video to that account twice.',
  icon: 'refresh-cw',
  params,
  result,
  /** Generous for N enqueues and one KV round trip; it does no device work at all. */
  timeout: 60_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const key = postKeyFor(ctx.params.videoArtifactId)
    // Read through the schema, which throws on a shape this build does not
    // understand — the same fail-loud posture the router takes. A retry that
    // half-read a row could re-send to a phone whose success it could not see.
    const post = await ctx.storage.global.get(key, PostSchema)
    if (!post) throw Object.assign(new Error(`No post is stored for ${ctx.params.videoArtifactId}.`), { code: 'E_NOT_FOUND' })

    const dispatch = { ...post.dispatch }
    const platforms: string[] = []
    const skipped: string[] = []
    let requeued = 0

    for (const platformId of post.platforms) {
      const state = stateFor(post, platformId)
      const failed = failedDevices(state)
      if (failed.length === 0) continue

      const platform = platformById(platformId)
      if (!platform || platform.script === null) {
        // Nothing to retry THROUGH. Recorded rather than silently skipped:
        // an operator who pressed a retry is owed the reason it did nothing.
        skipped.push(`${platformId}: this build has no upload flow for it`)
        continue
      }

      /*
        Successes are copied across untouched and failures are replaced with a
        fresh queued attempt, so a phone appears exactly once either way. The
        alternative — appending retries — grows the array without bound and
        makes `rollUp` count one phone twice.
      */
      const kept: Attempt[] = state.attempts.filter((a) => a.state !== 'failed')
      for (const deviceId of failed) {
        try {
          const job = await ctx.farm.call(
            'job.run',
            {
              scriptRef: platform.script,
              deviceId,
              params: { source: 'direct', videoArtifactId: post.videoArtifactId, caption: post.caption },
            },
            JobRunOutput,
          )
          kept.push({ jobId: job.jobId, deviceId, state: 'queued', error: null })
          requeued += 1
        } catch (err) {
          // The phone keeps its failed attempt, so the next retry finds it
          // again rather than losing it to a refusal that may be temporary.
          const message = err instanceof Error ? err.message : String(err)
          kept.push({ jobId: `unqueued:${deviceId}`, deviceId, state: 'failed', error: message.slice(0, 300) })
          skipped.push(`${deviceId}: ${message}`.slice(0, 200))
        }
      }

      dispatch[platformId] = { ...state, attempts: kept, state: rollUp(kept), deviceCount: kept.length }
      platforms.push(platformId)
    }

    if (platforms.length === 0 && skipped.length === 0) {
      return { requeued: 0, platforms: [], skipped: ['nothing had failed — there was nothing to retry'] }
    }

    await ctx.storage.global.set(key, { ...post, dispatch })
    ctx.log.info('re-queued the failed phones', { key, requeued, platforms: platforms.join(',') })
    return { requeued, platforms, skipped }
  },
}

export default script
