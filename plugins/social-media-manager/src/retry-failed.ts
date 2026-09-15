import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { platformById } from './platforms'
import { PostSchema, failedDevices, nextRound, postKeyFor, rollUp, stateFor, withRetired, withSummary, type Attempt, type Post } from './posts'
import { GroupSchema, groupKeyFor, type Group } from './groups'
import { NO_HASHTAG_RULE, composePostText, hashtagsFor } from './hashtags'

/**
 * The text a retry sends — the same the router sends (0.19.0): the caption and the session's fixed hashtags, the line
 * this video was given, and its own. The session row is read once per call and shared through `cache`.
 */
async function postTextFor(ctx: ScriptContext<unknown>, post: Post, cache: Map<string, Group | null>): Promise<string> {
  let group: Group | null = null
  if (post.groupId !== null) {
    if (!cache.has(post.groupId)) cache.set(post.groupId, await ctx.storage.global.get(groupKeyFor(post.groupId), GroupSchema).catch(() => null))
    group = cache.get(post.groupId) ?? null
  }
  return composePostText(post.caption, hashtagsFor({ rule: group?.hashtags ?? NO_HASHTAG_RULE, line: post.hashtagLine, own: post.hashtags }))
}

const groupCache = new Map<string, Group | null>()

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
      const failedHere = failedDevices(state)
      if (failedHere.length === 0) continue

      /*
        One video, one phone (0.12.0). A row of a one-per-phone session is re-sent to ITS phone and no
        other — never back to wherever an earlier attempt happened to fail. On the owner's production
        farm a retry sent a video to a phone that had already posted a different one; a phone that
        another video owns is exactly where this member used to go. A session row that has no phone
        yet is left for the session's own Retry, which binds it to one first (`pickAssignment`).
      */
      const sessionRow = post.groupId !== null && post.maxDevices === 1
      if (sessionRow && post.assignedDeviceId === null) {
        skipped.push(`${platformId}: this video has no phone of its own yet — use the session's "Retry failed", which gives it one before re-sending`)
        continue
      }
      const failed = sessionRow ? [post.assignedDeviceId as string] : failedHere

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
      // The failures being replaced are KEPT, as history (0.12.0), so the page can say "this red line
      // is from an earlier attempt" instead of losing it — and so a second failure does not erase the
      // first. Nothing that decides dispatch reads `history`.
      const retired: Attempt[] = state.attempts.filter((a) => a.state === 'failed')
      const round = nextRound(state)
      const now = Math.floor(Date.now() / 1000)
      /*
        The phone's name comes off the attempt being replaced rather than from
        a fresh `device.list`: this member re-sends to the SAME phones, so the
        name already recorded is the right one, and a phone that has gone
        offline since would otherwise lose the only name the row ever had. The
        router refreshes it on its next pass either way.
      */
      const namedBefore = new Map(state.attempts.map((a) => [a.deviceId, a.deviceName]))
      const postText = await postTextFor(ctx, post, groupCache)
      if (postText === '') {
        skipped.push(`${platformId}: this video has no caption or hashtags yet — write one before retrying`)
        continue
      }
      /*
        One job per phone at a time (0.26.0). A session row's phone is the only phone it may use, so
        its failed platforms are handed back to the router as waiting, and the router sends them one
        after another as the phone frees up — the same as the first send (0.25.0). Enqueuing all of
        them here put three jobs on one phone at once, which the table called three "Running".
      */
      if (sessionRow) {
        dispatch[platformId] = withSummary({ ...state, attempts: kept, history: withRetired(state.history, retired), state: rollUp(kept), deviceCount: kept.length, note: null })
        platforms.push(platformId)
        requeued += failed.length
        continue
      }
      for (const deviceId of failed) {
        try {
          const job = await ctx.farm.call(
            'job.run',
            {
              scriptRef: platform.script,
              deviceId,
              params: { source: 'direct', videoArtifactId: post.videoArtifactId, caption: postText },
            },
            JobRunOutput,
          )
          kept.push({ jobId: job.jobId, deviceId, deviceName: namedBefore.get(deviceId) ?? null, state: 'queued', error: null, at: now, settledAt: null, round })
          requeued += 1
        } catch (err) {
          // The phone keeps its failed attempt, so the next retry finds it
          // again rather than losing it to a refusal that may be temporary.
          const message = err instanceof Error ? err.message : String(err)
          kept.push({
            jobId: `unqueued:${deviceId}`,
            deviceId,
            deviceName: namedBefore.get(deviceId) ?? null,
            state: 'failed',
            error: message.slice(0, 300),
            at: now,
            settledAt: now,
            round,
          })
          skipped.push(`${deviceId}: ${message}`.slice(0, 200))
        }
      }

      dispatch[platformId] = withSummary({ ...state, attempts: kept, history: withRetired(state.history, retired), state: rollUp(kept), deviceCount: kept.length })
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
