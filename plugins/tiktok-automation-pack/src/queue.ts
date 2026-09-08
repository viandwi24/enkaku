import { createQueue, queueItemSchema, type Queue, type QueueClaim, type QueueItem, type ScriptContext } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * The work queue `post-video`'s `source: 'queue'` mode claims from (plan 113
 * §3.3, §4.4), now a thin adapter over `@enkaku/sdk`'s generic queue (plan
 * 800).
 *
 * This file used to hold the claim protocol itself. That protocol was good and
 * is unchanged — CAS claiming, `pending` preferred over stale-reclaim, no
 * reaper daemon, fail loud on a shape it cannot read — but it was written for
 * this one pack, and Instagram and YouTube need the same thing. Three
 * near-identical claim protocols that differ subtly is the failure this repo
 * keeps paying for elsewhere, so it moved to the SDK and this file supplies
 * only what is genuinely TikTok's: the payload, and this pack's own history.
 *
 * **Scope: `storage.global`, not `storage.device`** — the opposite of
 * `accounts.ts` in this same pack, and deliberately so. Which accounts are
 * signed in on a phone is a fact ABOUT that phone (plan 108 §3.1: *if
 * forgetting the device should forget the fact, it is device-scoped*). A
 * content calendar is not: twenty devices sharing one queue is the whole point
 * (§3.3, goal 5), and forgetting a device must not forget the video it was
 * going to post.
 */

/** The key prefix every queue entry lives under. UNCHANGED from before the migration — the entries on real farms are under it, and so is the plugin's own surface (`index.ts`). */
export const QUEUE_PREFIX = 'queue:'

/**
 * What this pack stores per item. Everything else an entry carries — status,
 * claim, attempts, error — belongs to the envelope and is the SDK's.
 *
 * `null` means "use the captions file" (§4.5); an entry's own caption wins when
 * it has one (§9 Q6).
 */
export const QueuePayloadSchema = z.object({ caption: z.string().max(2_200).nullable() })
export type QueuePayload = z.infer<typeof QueuePayloadSchema>

export type TikTokQueueItem = QueueItem<QueuePayload>
export type TikTokQueueClaim = QueueClaim<QueuePayload>

/**
 * The shape this pack shipped and has been writing to real farms since plan
 * 113, translated on READ into the envelope the SDK now owns.
 *
 * The old entry was FLAT — `artifactId`, `caption`, `status`, `claimedBy`,
 * `claimedAt`, `postedAt`, `attempts`, `lastError` all at the top level — and
 * the new one nests the pack's own fields under `payload`. The new schema is
 * `.strict()`, so without this an operator upgrading the pack would meet a hard
 * failure on a queue that worked yesterday, on data they cannot get back.
 *
 * Two renames are handled here and nowhere else:
 *   - `status: 'posted'` is the SDK's terminal `done`. The generic vocabulary
 *     is domain-free on purpose; `posted` was this pack's word for it.
 *   - `postedAt` is the SDK's `settledAt`, for the same reason.
 *
 * Never written back: an entry re-settled after this lands stores the new
 * shape, so the legacy form disappears as the queue turns over. A row already
 * in the new shape passes through untouched — detected by `payload` being
 * present, which the flat form never had.
 */
export function readLegacyQueueEntry(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const row = raw as Record<string, unknown>
  // Already migrated — leave it exactly as it is.
  if ('payload' in row) return row

  const status = row.status === 'posted' ? 'done' : row.status
  return {
    version: 1,
    id: row.artifactId,
    payload: { caption: row.caption ?? null },
    status,
    claimedBy: row.claimedBy ?? null,
    claimedAt: row.claimedAt ?? null,
    settledAt: row.postedAt ?? null,
    attempts: row.attempts ?? 0,
    lastError: row.lastError ?? null,
  }
}

/**
 * 30 minutes — the SDK's own default, restated here only because this pack's
 * plan cites it: longer than the six-screen walk `post-video` ever takes even
 * with every modal firing, short enough that a crashed run's claim does not
 * block real work for the rest of the day. There is no reaper (§9 Q5); the next
 * `claimNext` is the whole mechanism.
 */
export { DEFAULT_STALE_CLAIM_SEC } from '@enkaku/sdk'

/** The queue for this context. Built per call rather than at module scope — `ctx.storage` belongs to the run, not to the module. */
export function tiktokQueue(ctx: ScriptContext<unknown>): Queue<QueuePayload> {
  return createQueue({
    kv: ctx.storage.global,
    prefix: QUEUE_PREFIX,
    payload: QueuePayloadSchema,
    readLegacy: readLegacyQueueEntry,
  })
}

/** The key an entry for this artifact lives under — spelled once so a writer and a reader never drift. */
export function queueKeyFor(artifactId: string): string {
  return `${QUEUE_PREFIX}${artifactId}`
}

/**
 * Rewrites every pre-plan-800 entry into the new shape, once, at plugin start.
 *
 * `readLegacyQueueEntry` above keeps the SCRIPTS working on old rows, but it
 * cannot help the plugin's own Studio screen: that table is a `kv.list` over
 * the raw stored values (`index.ts`), so its columns read whatever is actually
 * on disk. Without this, an operator upgrading would see a table where old rows
 * fill the Video and Caption columns and new ones leave them blank — the data
 * would be fine and the screen would look broken, which is its own kind of
 * wrong.
 *
 * Written through `setIfVersion` against the version just listed: an entry a
 * device claims between the list and the write keeps that claim, and this skips
 * it rather than overwriting a live claim with a translated copy. A skipped
 * entry is not lost — scripts still read it through `readLegacyQueueEntry`, and
 * the next start tries again.
 *
 * Idempotent by construction: an entry already carrying `payload` is left
 * alone, so this is a no-op on every start after the first.
 */
export async function migrateLegacyQueueEntries(ctx: {
  storage: ScriptContext<unknown>['storage']
  log: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void }
}): Promise<{ migrated: number; skipped: number }> {
  const kv = ctx.storage.global
  let migrated = 0
  let skipped = 0
  let cursor: string | undefined

  do {
    const page = await kv.list({ prefix: QUEUE_PREFIX, cursor })
    for (const entry of page.items) {
      const raw = entry.value
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || 'payload' in (raw as object)) continue
      const translated = readLegacyQueueEntry(raw)
      // Validate before writing: a row neither shape understands is left exactly
      // as it is, for the schema to refuse loudly at read time, rather than
      // being replaced by a half-built translation.
      const parsed = queueItemSchema(QueuePayloadSchema).safeParse(translated)
      if (!parsed.success) {
        skipped += 1
        ctx.log.warn('left a queue entry unmigrated — it matches neither the old shape nor the new one', { key: entry.key })
        continue
      }
      const written = await kv.setIfVersion(entry.key, translated, entry.version)
      if (written) migrated += 1
      else skipped += 1
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)

  if (migrated > 0 || skipped > 0) {
    ctx.log.info('migrated queue entries to the shared queue shape', { migrated, skipped })
  }
  return { migrated, skipped }
}
