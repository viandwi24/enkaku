import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { PLATFORM_IDS } from './platforms'
import { PostSchema, RESOLUTIONS, postKeyFor, resolveAttempt, type Post } from './posts'

/**
 * Settle a not-confirmed attempt by hand, after an operator has looked at the account (0.21.0).
 *
 * The case that asked for it (2026-09-14): Instagram posted the Reel, the script could not see it
 * and reported `outcome: "unverified"`, and the row sat at "Needs a look" with nothing anyone could
 * do about it from the page. `unverified` is deliberately never retried on its own — if the post
 * DID land, a retry is the same video twice on a real account — so the only honest way forward is
 * a person checking, and this member is where they say what they found:
 *
 * - `posted` — the video is on the account. The attempt becomes `success`.
 * - `failed` — it is not. The attempt becomes `failed`, which is exactly what makes it retryable
 *   through the existing Retry failed (row) and Retry failed (session) — nothing new re-sends here.
 *
 * Every rule lives in `posts.ts`'s `resolveAttempt` (pure, tested); this member only reads the row
 * with its version and writes it back with `setIfVersion`, so a router tick that settled the same
 * row a moment earlier is re-read rather than overwritten. It refuses anything that is not
 * currently not-confirmed: a page open for an hour must not flip an attempt that has since moved.
 */

const params = z.object({
  videoArtifactId: z.string().min(1).describe('The video whose attempt is being resolved.').meta(ui({ title: 'Video' })),
  platform: z.enum(PLATFORM_IDS).describe('The platform the attempt was for.').meta(ui({ title: 'Platform' })),
  deviceId: z.string().min(1).describe('The phone the attempt ran on.').meta(ui({ title: 'Phone' })),
  jobId: z
    .string()
    .min(1)
    .optional()
    .describe('The attempt\'s job, when known. When given, the attempt must still be that job — anything else is refused.')
    .meta(ui({ title: 'Job' })),
  resolution: z.enum(RESOLUTIONS).describe('What the operator found on the account: posted, or failed (which makes it retryable).').meta(ui({ title: 'Resolution' })),
  note: z.string().max(300).optional().describe('Optional: what was seen on the account.').meta(ui({ title: 'Note' })),
})

const result = z.object({
  videoArtifactId: z.string().meta(ui({ title: 'Video', summary: true })),
  platform: z.string().meta(ui({ title: 'Platform', summary: true })),
  state: z.string().describe('The attempt\'s state now: success or failed.').meta(ui({ title: 'Attempt', summary: true })),
  platformState: z.string().describe('The platform\'s rolled-up state after the change.').meta(ui({ title: 'Platform state' })),
})

/** How many times a write that lost a race to the router is re-read and tried again. */
const WRITE_ATTEMPTS = 3

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
        throw Object.assign(new Error('This video\'s row has a shape this version cannot read — it may have been written by a newer version. Nothing was changed.'), {
          code: 'E_CONFLICT',
        })
      }
      return { post: parsed.data, version: entry.version }
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  return null
}

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'resolve-attempt',
  title: 'Resolve a not-confirmed post',
  description:
    'After checking the account on the phone, marks a post the upload script could not confirm as posted, or as failed so Retry failed can send it again. Refuses anything that is not currently not confirmed.',
  icon: 'upload',
  params,
  result,
  timeout: 60_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const key = postKeyFor(ctx.params.videoArtifactId)
    for (let round = 1; round <= WRITE_ATTEMPTS; round++) {
      const found = await readWithVersion(ctx, key)
      if (!found) throw Object.assign(new Error(`No video ${ctx.params.videoArtifactId} is stored — it may have been removed.`), { code: 'E_NOT_FOUND' })

      const outcome = resolveAttempt({
        post: found.post,
        platform: ctx.params.platform,
        deviceId: ctx.params.deviceId,
        jobId: ctx.params.jobId ?? null,
        resolution: ctx.params.resolution,
        note: ctx.params.note ?? null,
        now: Math.floor(Date.now() / 1000),
        byJobId: ctx.job.id,
      })
      if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code })

      const written = await ctx.storage.global.setIfVersion(key, outcome.post, found.version)
      if (written === null) {
        // The router (or another operator) wrote this row between the read and here. Read it again:
        // if the attempt is still not confirmed the decision still applies; if it moved, the next
        // pass refuses by name.
        ctx.log.info('the row changed while resolving — reading it again', { key, round })
        continue
      }

      const platformState = outcome.post.dispatch[ctx.params.platform]?.state ?? 'pending'
      ctx.log.info('resolved a not-confirmed attempt by hand', {
        key,
        platform: ctx.params.platform,
        deviceId: ctx.params.deviceId,
        from: 'unverified',
        to: outcome.attempt.state,
      })
      return { videoArtifactId: ctx.params.videoArtifactId, platform: ctx.params.platform, state: outcome.attempt.state, platformState }
    }
    throw Object.assign(new Error('This video kept changing while it was being marked. Nothing was changed — refresh the page and try again.'), { code: 'E_CONFLICT' })
  },
}

export default script
