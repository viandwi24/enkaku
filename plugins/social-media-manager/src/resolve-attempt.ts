import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { GroupSchema, groupKeyFor, withProgress, type RowState } from './groups'
import { PLATFORM_IDS } from './platforms'
import {
  MANUAL_JOB_PREFIX,
  MARK_ACTIONS,
  POST_PREFIX,
  PostSchema,
  RESOLUTIONS,
  isJobGone,
  markPost,
  markTarget,
  postKeyFor,
  settleJob,
  type JobCheck,
  type MarkAction,
  type Post,
} from './posts'

/**
 * Force what the farm recorded about one video on one platform, by hand (0.21.0; widened in 0.23.0).
 *
 * The cases that asked for it, from the owner's production farm (2026-09-14):
 *
 * - Instagram posted the Reel, the script could not see it and reported `unverified`, and the row sat
 *   at "Needs a look" with nothing to press (0.21.0).
 * - YouTube Shorts landed on the channel while the farm recorded `failed` — "neither the trim screen
 *   nor the Shorts editor appeared", or a run force-stopped after its upload had already gone through.
 *   Retry failed would post those twice.
 * - A video posted by hand outside the farm, whose platform was still waiting for a phone.
 * - And the other way: something marked posted that is not on the account, which must be retryable.
 *
 * So the member takes one `action` (`posts.ts` `MARK_ACTIONS`): `mark-posted`, `unmark-posted` or
 * `mark-failed`. Every rule lives in `posts.ts`'s `markPost` (pure, tested, with the transition table
 * written out); this member reads the row with its version, asks `job.get` about a still-queued target
 * (only a settled or vanished job may be marked posted), and writes back with `setIfVersion`, so a
 * router tick that settled the same row a moment earlier is re-read rather than overwritten. After a
 * write it recounts the session's progress so the header agrees at once instead of at the next tick.
 */

const params = z.object({
  videoArtifactId: z.string().min(1).describe('The video whose post is being marked.').meta(ui({ title: 'Video' })),
  platform: z.enum(PLATFORM_IDS).describe('The platform being marked.').meta(ui({ title: 'Platform' })),
  action: z
    .enum(MARK_ACTIONS)
    .optional()
    .describe(
      'mark-posted: the video is on the account, so it is never sent there again. unmark-posted: it is not, so Retry failed sends it again. mark-failed: a not-confirmed post was checked and is not there.',
    )
    .meta(ui({ title: 'Action' })),
  deviceId: z
    .string()
    .min(1)
    .optional()
    .describe('The phone whose attempt is marked. Optional when there is one attempt, or nothing was sent and the video has its own phone.')
    .meta(ui({ title: 'Phone' })),
  jobId: z
    .string()
    .min(1)
    .optional()
    .describe('The attempt\'s job, when known. When given, the attempt must still be that job — anything else is refused.')
    .meta(ui({ title: 'Job' })),
  resolution: z
    .enum(RESOLUTIONS)
    .optional()
    .describe('The 0.21.0 name for the action, still accepted: posted is mark-posted, failed is mark-failed. Ignored when action is given.')
    .meta(ui({ title: 'Resolution (older)' })),
  note: z.string().max(300).optional().describe('Optional: what was seen on the account.').meta(ui({ title: 'Note' })),
})

const result = z.object({
  videoArtifactId: z.string().meta(ui({ title: 'Video', summary: true })),
  platform: z.string().meta(ui({ title: 'Platform', summary: true })),
  action: z.string().describe('The hand action that was applied.').meta(ui({ title: 'Action', summary: true })),
  state: z.string().describe('The attempt\'s state now: success or failed.').meta(ui({ title: 'Attempt', summary: true })),
  manual: z.boolean().describe('Whether a manual attempt was recorded because nothing had been sent.').meta(ui({ title: 'Manual' })),
  platformState: z.string().describe('The platform\'s rolled-up state after the change.').meta(ui({ title: 'Platform state' })),
})

/** How many times a write that lost a race to the router is re-read and tried again. */
const WRITE_ATTEMPTS = 3

const JobGetOutput = z.object({ status: z.string(), error: z.string().nullable().optional(), result: z.unknown().optional() })

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/** The row and the version it was read at — `KvApi` has no versioned get, so it is found through `list`. */
async function readWithVersion(ctx: ScriptContext<unknown>, key: string): Promise<{ post: Post; version: number } | null> {
  let cursor: string | null = null
  do {
    const opts: { prefix: string; limit: number; cursor?: string } = { prefix: key, limit: 50 }
    if (cursor !== null) opts.cursor = cursor
    const page = await ctx.storage.global.list(opts)
    // A prefix also matches longer keys (`post:abc` finds `post:abcd`), so only the exact key counts.
    const entry = page.items.find((item) => item.key === key)
    if (entry) {
      const parsed = PostSchema.safeParse(entry.value)
      if (!parsed.success) {
        throw codedError('This video\'s row has a shape this version cannot read — it may have been written by a newer version. Nothing was changed.', 'E_CONFLICT')
      }
      return { post: parsed.data, version: entry.version }
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  return null
}

/** Is a queued attempt's job still running? Only asked for `mark-posted` on a `queued` attempt. */
async function checkJob(ctx: ScriptContext<unknown>, jobId: string): Promise<JobCheck> {
  if (jobId.startsWith(MANUAL_JOB_PREFIX) || jobId.startsWith('unqueued:')) return 'gone'
  try {
    const job = await ctx.farm.call('job.get', { jobId }, JobGetOutput)
    return settleJob(job) === null ? 'running' : 'settled'
  } catch (err) {
    return isJobGone(err) ? 'gone' : 'unknown'
  }
}

/**
 * Recount the session's progress from its rows, the way the router does each tick (`withProgress`), so
 * a marked row moves the header at once. Best effort: the router rewrites it within seconds anyway.
 */
export async function refreshGroupProgress(ctx: ScriptContext<unknown>, groupId: string): Promise<void> {
  try {
    const states: RowState[] = []
    let cursor: string | null = null
    do {
      const opts: { prefix: string; limit: number; cursor?: string } = { prefix: POST_PREFIX, limit: 200 }
      if (cursor !== null) opts.cursor = cursor
      const page = await ctx.storage.global.list(opts)
      for (const entry of page.items) {
        const parsed = PostSchema.safeParse(entry.value)
        if (!parsed.success || parsed.data.groupId !== groupId) continue
        for (const id of parsed.data.platforms) states.push(parsed.data.dispatch[id]?.state ?? 'pending')
      }
      cursor = page.nextCursor
    } while (cursor !== null)
    const group = await ctx.storage.global.get(groupKeyFor(groupId), GroupSchema)
    if (!group) return
    const next = withProgress(group, states)
    if (next) await ctx.storage.global.set(groupKeyFor(groupId), next)
  } catch (err) {
    ctx.log.warn('could not recount the session after changing a row — the router does it on its next tick', {
      groupId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'resolve-attempt',
  title: 'Mark a post by hand',
  description:
    'Marks a video as posted on a platform (it is then never sent there again), removes a posted mark (so Retry failed sends it again), or marks a not-confirmed post as failed. Every change is recorded on the attempt.',
  icon: 'upload',
  params,
  result,
  timeout: 60_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const { videoArtifactId, platform } = ctx.params
    const action: MarkAction | null =
      ctx.params.action ?? (ctx.params.resolution === 'posted' ? 'mark-posted' : ctx.params.resolution === 'failed' ? 'mark-failed' : null)
    if (action === null) throw codedError('Say what to do: mark-posted, unmark-posted or mark-failed.', 'E_PARAMS_INVALID')

    const key = postKeyFor(videoArtifactId)
    for (let round = 1; round <= WRITE_ATTEMPTS; round++) {
      const found = await readWithVersion(ctx, key)
      if (!found) throw codedError(`No video ${videoArtifactId} is stored — it may have been removed.`, 'E_NOT_FOUND')

      // A still-queued target may be marked posted only once its job has finished or is gone — ask first.
      let job: JobCheck | null = null
      if (action === 'mark-posted') {
        const target = markTarget(found.post, platform, { deviceId: ctx.params.deviceId, jobId: ctx.params.jobId })
        if (target.ok && target.attempt.state === 'queued') job = await checkJob(ctx, target.attempt.jobId)
      }

      const outcome = markPost({
        post: found.post,
        platform,
        action,
        deviceId: ctx.params.deviceId ?? null,
        jobId: ctx.params.jobId ?? null,
        note: ctx.params.note ?? null,
        now: Math.floor(Date.now() / 1000),
        byJobId: ctx.job.id,
        job,
      })
      if (!outcome.ok) throw codedError(outcome.message, outcome.code)

      const written = await ctx.storage.global.setIfVersion(key, outcome.post, found.version)
      if (written === null) {
        // The router (or another operator) wrote this row between the read and here. Read it again: if
        // the attempt still allows the mark it still applies; if it moved, the next pass refuses by name.
        ctx.log.info('the row changed while marking it — reading it again', { key, round })
        continue
      }

      const platformState = outcome.post.dispatch[platform]?.state ?? 'pending'
      ctx.log.info('marked a post by hand', {
        key,
        platform,
        action,
        deviceId: outcome.attempt.deviceId,
        from: outcome.from ?? 'no attempt',
        to: outcome.attempt.state,
        manual: outcome.manual,
      })
      if (outcome.post.groupId !== null) await refreshGroupProgress(ctx, outcome.post.groupId)
      return { videoArtifactId, platform, action, state: outcome.attempt.state, manual: outcome.manual, platformState }
    }
    throw codedError('This video kept changing while it was being marked. Nothing was changed — refresh the page and try again.', 'E_CONFLICT')
  },
}

export default script
