import type { KvListItem, ScriptContext } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * The work queue `post-video`'s `source: 'queue'` mode claims from (plan 113 §3.3, §4.4).
 *
 * C6: there is no capability that lists the artifact store, so a member cannot ask the farm what
 * videos exist. The queue is therefore not a listing of anything — it is a list the plugin itself
 * keeps, one KV entry per item under `queue:<artifactId>`, written by an operator through the
 * plugin's own surface (113.10) and read here.
 *
 * **Scope: `storage.global`, not `storage.device`** — the opposite of `accounts.ts` in this same
 * pack, and deliberately so. `accounts.ts` is device-scoped because which accounts are signed in on
 * a phone is a fact ABOUT that phone (plan 108 §3.1: *if forgetting the device should forget the
 * fact, it is device-scoped*). A content calendar is not a fact about any one phone — twenty devices
 * sharing one queue is the whole point (§3.3, goal 5), and forgetting a device must not forget the
 * video it was going to post.
 *
 * Claiming is compare-and-swap (C11, `setIfVersion`): a device lists the pending candidates, orders
 * them by `pick`, and tries `setIfVersion` down that list. A `null` return means another device won
 * the race for that one candidate — not a failure, just a reason to try the next candidate. Only a
 * genuinely empty candidate list makes `claimNext` return `null`, and the caller reports that as
 * `skipped`. There is no reaper daemon (§9 Q5): a stale `claimed` entry (older than `staleClaimSec`)
 * becomes a candidate again the next time no `pending` item is available, reclaimed through the same
 * CAS so two devices still cannot both reclaim it.
 */

/** The key prefix every queue entry lives under in `storage.global`. `list({ prefix })` reads them all. */
export const QUEUE_PREFIX = 'queue:'

/**
 * `version` is a literal, not a range, and the object is `.strict()`, for the same reason
 * `accounts.ts`'s `AccountsSchema` is: a value written by a future member must throw rather than be
 * half-understood. There is no reader here that degrades to "ignore the fields I don't recognise" —
 * a shape change is a version bump, not a silent misread.
 */
export const QueueItemSchema = z
  .object({
    version: z.literal(1),
    artifactId: z.string().min(1),
    /** `null` means "use the captions file" (§4.5) — the entry's own caption wins when it has one (§9 Q6). */
    caption: z.string().max(2_200).nullable(),
    status: z.enum(['pending', 'claimed', 'posted', 'failed']),
    /**
     * The `ctx.job.deviceId` of the device holding (or that last held) the claim — the device ROW
     * id, not its `stableId`.
     *
     * This field said "stableId" until the member that fills it was written and the two disagreed.
     * A script's own context carries `job.deviceId` and nothing else that identifies a device, and
     * reading the stableId would mean declaring `device.get` in the manifest for a value used only
     * to label a claim. So the field records what the writer can actually know. It is a claim
     * marker, not an identity: it exists to answer "is somebody already working on this", and a
     * re-enrolled device changing row id would at worst leave a claim to go stale and be reclaimed,
     * which is exactly what `staleClaimSec` is for.
     */
    claimedBy: z.string().nullable(),
    /** Unix SECONDS — the farm-wide timestamp convention. What `staleClaimSec` measures against. */
    claimedAt: z.number().int().nullable(),
    postedAt: z.number().int().nullable(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().max(400).nullable(),
  })
  .strict()
export type QueueItem = z.infer<typeof QueueItemSchema>

/** The key an entry for this artifact lives under — spelled once so a writer and a reader never drift. */
export function queueKeyFor(artifactId: string): string {
  return `${QUEUE_PREFIX}${artifactId}`
}

export interface ClaimResult {
  key: string
  item: QueueItem
}

/**
 * 30 minutes. Longer than the six-screen walk `post-video` ever takes, even with every modal in
 * §4.2 firing and a couple of CAS retries — so a run that is genuinely still in progress is never
 * mistaken for abandoned. Short enough that a crashed or killed run's claim does not sit blocking
 * real work for the rest of the day, given that nothing but the next `claimNext` call ever revisits
 * it (§9 Q5 — there is no reaper daemon; this default is the whole mechanism).
 */
export const DEFAULT_STALE_CLAIM_SEC = 1_800

type Kv = ScriptContext<unknown>['storage']['global']

/** Every entry under `prefix`, paging through `nextCursor` until it is `null` (the pattern `proxy-manager`'s supervisor already uses for its own catalogue read). */
async function listAll(kv: Kv, prefix: string): Promise<KvListItem[]> {
  const items: KvListItem[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix, cursor })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

/** Ascending key order — stable across runs because it is an explicit sort, not an assumption about `list()`'s own order. */
function byKeyAscending<T extends { key: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * Fisher-Yates: every permutation equally likely, so the result is not biased by the input's (key)
 * order. `crypto.getRandomValues`, not `Math.random()` — the same choice `groups/dispatch.ts`'s
 * own `shuffle` makes for `order: 'random'`, kept consistent here rather than picking a second RNG.
 * The `as T`/`as number` casts below are bounds-safety casts for `noUncheckedIndexedAccess`, not a
 * cast over untrusted data — `i`/`j` are always in range by the loop's own invariant, exactly as in
 * that other `shuffle`.
 */
function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  const rand = new Uint32Array(out.length)
  crypto.getRandomValues(rand)
  for (let i = out.length - 1; i > 0; i--) {
    const j = (rand[i] as number) % (i + 1)
    const tmp = out[i] as T
    out[i] = out[j] as T
    out[j] = tmp
  }
  return out
}

/**
 * The claim protocol's pure half (§4.4): given a raw KV listing, decide what is claimable and in
 * what order — no device, no context, no clock (`nowSec` is the caller's), so a test can force a
 * CAS collision by handing this a fixed fixture rather than a fake `ScriptContext`.
 *
 * `pending` items are always preferred. Only when NONE exist does a stale `claimed` entry
 * (`claimedAt` older than `staleClaimSec`) become a candidate — never both at once, so a fresh
 * `pending` item is never skipped in favour of reclaiming an older one.
 *
 * Throws when a stored entry no longer matches `QueueItemSchema` — the same fail-loud posture
 * `ctx.kv`'s own `get(key, schema)` takes (see `accounts.ts`'s header): a shape this code cannot
 * understand must never be silently skipped or silently reclaimed.
 */
export function orderCandidates(
  items: KvListItem[],
  pick: 'in-order' | 'random',
  nowSec: number,
  staleClaimSec: number,
): { key: string; item: QueueItem; version: number }[] {
  const parsed = items.map((listed) => {
    const result = QueueItemSchema.safeParse(listed.value)
    if (!result.success) {
      throw new Error(`queue entry "${listed.key}" has an incompatible shape (expected QueueItemSchema version 1): ${result.error.message}`)
    }
    return { key: listed.key, item: result.data, version: listed.version }
  })

  const pending = parsed.filter((candidate) => candidate.item.status === 'pending')
  const eligible =
    pending.length > 0
      ? pending
      : parsed.filter(
          (candidate) => candidate.item.status === 'claimed' && candidate.item.claimedAt !== null && nowSec - candidate.item.claimedAt >= staleClaimSec,
        )

  return pick === 'in-order' ? byKeyAscending(eligible) : shuffled(eligible)
}

/**
 * Claims the next eligible entry, or `null` when nothing is claimable — an empty queue, or every
 * candidate lost its CAS race (which cannot happen: losing one candidate just moves to the next).
 * The caller reports `null` as `outcome: 'skipped'`, never as a failure (§3.6, goal 5).
 */
export async function claimNext(
  ctx: ScriptContext<unknown>,
  opts: { pick: 'in-order' | 'random'; claimedBy: string; staleClaimSec?: number },
): Promise<ClaimResult | null> {
  const staleClaimSec = opts.staleClaimSec ?? DEFAULT_STALE_CLAIM_SEC
  const kv = ctx.storage.global
  const nowSec = Math.floor(Date.now() / 1000)
  const items = await listAll(kv, QUEUE_PREFIX)
  const candidates = orderCandidates(items, opts.pick, nowSec, staleClaimSec)

  for (const candidate of candidates) {
    const claimed: QueueItem = { ...candidate.item, status: 'claimed', claimedBy: opts.claimedBy, claimedAt: nowSec }
    const written = await kv.setIfVersion(candidate.key, claimed, candidate.version)
    if (written) return { key: candidate.key, item: claimed }
    // Lost the CAS race for this one candidate — another device claimed it between our list()
    // and this setIfVersion(). §3.3: that is the mechanism working, not a failure. Fall through
    // and try the next candidate in the same order rather than giving up on the whole run.
  }
  return null
}

/**
 * Records the outcome of a claimed item — the far side of `claimNext`. Re-reads the entry's current
 * version (`list()` is the only `KvApi` call that reports one; `get()` deliberately does not) and
 * writes through `setIfVersion`, because the claim this settles could in principle have gone stale
 * and been reclaimed by another device while this run was still working (a crash-and-resume, or a
 * run slower than `staleClaimSec`) — settling it with a plain overwrite would silently stomp
 * whatever the reclaiming device wrote. That case throws rather than guessing which write should
 * win.
 *
 * A `key` with no entry at all (deleted from the surface mid-run) also throws: `settleClaim`'s whole
 * job is to make the outcome durable, and silently discarding it would look like success everywhere
 * else in the run.
 */
export async function settleClaim(ctx: ScriptContext<unknown>, key: string, outcome: { status: 'posted' | 'failed'; error?: string }): Promise<void> {
  const kv = ctx.storage.global
  const nowSec = Math.floor(Date.now() / 1000)

  // `key` is already the full key, so listing by it as a prefix over-matches when another key
  // extends it (e.g. "queue:vid1" is a prefix of "queue:vid10") — filter to the exact key below.
  const listed = await listAll(kv, key)
  const found = listed.find((item) => item.key === key)
  if (!found) {
    throw new Error(`settleClaim: no queue entry at "${key}" — it was deleted before this claim could be settled`)
  }

  const result = QueueItemSchema.safeParse(found.value)
  if (!result.success) {
    throw new Error(`queue entry "${key}" has an incompatible shape (expected QueueItemSchema version 1): ${result.error.message}`)
  }
  const item = result.data

  const settled: QueueItem = {
    ...item,
    status: outcome.status,
    attempts: item.attempts + 1,
    postedAt: outcome.status === 'posted' ? nowSec : item.postedAt,
    lastError: outcome.status === 'failed' ? (outcome.error ?? null) : null,
  }

  const written = await kv.setIfVersion(key, settled, found.version)
  if (!written) {
    throw new Error(`settleClaim: lost a race writing queue entry "${key}" — it was reclaimed or modified before this claim could be settled`)
  }
}
