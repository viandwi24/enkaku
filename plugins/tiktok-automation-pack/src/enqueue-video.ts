import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { QueueItemSchema, queueKeyFor, type QueueItem } from './queue'

/**
 * Writes ONE entry to the post queue (plan 113 §3.3, §4.4) — the write half of the "content" surface
 * view built in step 113.10 (`index.ts`'s `content` view, `addVideo` action).
 *
 * ## Why this is a script and not a plain `kv.set` action
 *
 * The surface's declarative write actions (`kv.set`/`kv.delete`) can only key a write off a `Binding`,
 * and a `Binding` has no concatenation — no operators, no string interpolation, no calls (plan 108
 * §3.4, `binding.ts`'s own evaluator). So nothing declarative can compute `queue:<artifactId>` from a
 * freshly-picked artifact id the way `queueKeyFor` does here. That is not true of `retryItem`/
 * `removeItem` in `index.ts`'s surface: a row already read off the queue carries its own exact key
 * (`$entry.key`, echoed straight from `kv.list`), so THOSE two stay plain `kv.set`/`kv.delete` actions
 * with no script behind them at all. Only the CREATE path needs real code, and this member is that
 * code, reached through a declarative `form` → `job` action (`then: { kind: 'job', … }`).
 *
 * ## The device this runs on does nothing
 *
 * A `job` action always dispatches to some device — every script is queued against a device-bound job
 * queue, which is a structural fact about the whole system, not a plugin-surface gap — even though this
 * member's own work is a single farm-wide KV write (`storage.global`) that touches no device at all.
 * The surface's `addVideo` action therefore declares `device: 'picker'`, and the operator picks any
 * online device to run this on; `ctx.device` is never referenced below. Recorded here so the choice
 * reads as a deliberate, named trade-off rather than an oversight.
 */

const params = z.object({
  artifactId: z
    .string()
    .min(1)
    .describe('The uploaded video to queue.')
    .meta(ui({ title: 'Video', kind: 'artifact', group: 'Video' })),
  caption: z
    .string()
    .max(2_200)
    .optional()
    .describe('Left blank, a queued run falls back to the captions file (§4.5) instead.')
    .meta(ui({ title: 'Caption', group: 'Video' })),
})

const result = z.object({
  key: z.string().describe('The queue entry key written.').meta(ui({ title: 'Queue key' })),
  artifactId: z.string().describe('The video queued.').meta(ui({ title: 'Video', summary: true })),
  caption: z
    .string()
    .nullable()
    .describe('The caption stored, or null when a queued run will fall back to the captions file instead.')
    .meta(ui({ title: 'Caption' })),
})

const enqueueVideo: PluginMemberScript<typeof params, typeof result> = {
  id: 'enqueue-video',
  title: 'Add a video to the post queue',
  description:
    'Writes one entry to the farm-wide post queue, keyed by the video\'s own artifact id. Used by the "content" screen\'s Add video button; nothing on the device is touched.',
  params,
  result,
  // Generous for a single KV round trip — this member does no device work at all, so there is no
  // app-launch storm or screen walk to budget for, only the storage call itself.
  timeout: 15_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const { artifactId, caption } = ctx.params
    const key = queueKeyFor(artifactId)
    const trimmed = caption?.trim()
    const nextCaption = trimmed && trimmed.length > 0 ? trimmed : null

    // Never stomp a claim in flight: an entry another device is actively working (`status: 'claimed'`)
    // must not be silently reset to `pending` by an operator re-adding the same artifact — that would
    // let two devices believe they may post the same video (queue.ts §3.3's whole reason to exist).
    // Read through `QueueItemSchema`, which throws on a shape this code cannot understand — the same
    // fail-loud posture `queue.ts` itself takes, rather than guessing at an entry a newer version wrote.
    const existing = await ctx.storage.global.get(key, QueueItemSchema)
    if (existing && existing.status === 'claimed') {
      throw Object.assign(
        new Error(`"${artifactId}" is already queued and currently claimed by a device — wait for it to settle before re-adding it`),
        { code: 'E_QUEUE_ITEM_CLAIMED' },
      )
    }

    // A fresh item, or a re-add: history (`postedAt`/`attempts`) survives a re-add, everything else
    // resets to a clean `pending` claim so the item is immediately eligible again.
    const item: QueueItem = {
      version: 1,
      artifactId,
      caption: nextCaption,
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      postedAt: existing?.postedAt ?? null,
      attempts: existing?.attempts ?? 0,
      lastError: null,
    }
    await ctx.storage.global.set(key, item)
    ctx.log.info(`queued "${artifactId}"`, { key, hasCaption: nextCaption !== null })

    return { key, artifactId, caption: nextCaption }
  },
}

export default enqueueVideo
