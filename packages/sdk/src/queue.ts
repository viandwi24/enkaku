import { z } from 'zod'
import type { KvApi, KvListItem } from './types'

/**
 * A claimable work queue, on top of the KV a plugin already has (plan 800).
 *
 * **Why this is here and not in the core.** A queue is not a farm concept — no
 * core table, route or screen knows about one. It is a pattern a plugin needs:
 * a list of work, many devices claiming from it, nobody doing the same item
 * twice. Everything it needs already exists in `ctx.storage`, so this is a
 * library over a primitive rather than a new primitive, and a plugin can adopt
 * it without the farm changing at all.
 *
 * **Why it is generic.** `plugins/tiktok-automation-pack/src/queue.ts` invented
 * this protocol for one pack, keyed on an artifact id with a caption beside it.
 * The moment a second pack needed the same thing, the choice was to copy it or
 * to share it — and three near-identical claim protocols that differ subtly is
 * exactly the failure this repo keeps paying for elsewhere. The payload is
 * therefore the CALLER's, validated by the caller's own schema; this module
 * owns only the claim envelope around it.
 *
 * **The protocol**, unchanged from the one it generalises:
 *
 * - Claiming is compare-and-swap. A worker lists candidates, orders them, and
 *   tries `setIfVersion` down that list. Losing one race is not a failure — it
 *   means another worker took that item — so it falls through to the next
 *   candidate. Only a genuinely empty candidate list returns `null`.
 * - `pending` items are always preferred. Only when none exist does a STALE
 *   `claimed` entry become a candidate again, reclaimed through the same CAS so
 *   two workers still cannot both hold it. There is no reaper: the next
 *   `claimNext` call is the whole mechanism.
 * - A stored entry that no longer matches its schema THROWS. There is no
 *   "ignore what I don't recognise" path, because silently skipping an item is
 *   indistinguishable from an empty queue, and silently reclaiming one is worse.
 */

/**
 * `done` and `failed` are terminal; `claimed` is the only one a stale timeout
 * acts on.
 *
 * The vocabulary is deliberately domain-free — `done`, not `posted`. This
 * queue holds whatever a plugin puts in it, and a status naming one plugin's
 * verb would read as a mistake in every other. A plugin adopting this from its
 * own older shape pays for that with `readLegacy` (see `createQueue`), which is
 * where its history belongs rather than here.
 */
export const QUEUE_STATUSES = ['pending', 'claimed', 'done', 'failed'] as const
export type QueueStatus = (typeof QUEUE_STATUSES)[number]

/**
 * 30 minutes. Longer than any single automated walk of an app realistically
 * takes, so a run genuinely still in progress is never mistaken for abandoned;
 * short enough that a crashed run's claim does not block real work for the rest
 * of the day. Nothing but the next `claimNext` revisits it, so this default IS
 * the recovery mechanism, not a hint to one.
 */
export const DEFAULT_STALE_CLAIM_SEC = 1_800

/**
 * The envelope this module owns, around a payload it does not interpret.
 *
 * `version` is a literal and the object is `.strict()`: a value written by a
 * future version of this module must throw rather than be half-understood. A
 * shape change is a version bump, never a silent misread.
 */
export function queueItemSchema<P extends z.ZodTypeAny>(payload: P) {
  return z
    .object({
      version: z.literal(1),
      /** The caller's own identifier for this work — an artifact id, a URL, a row key. Also the KV key's suffix. */
      id: z.string().min(1),
      payload,
      status: z.enum(QUEUE_STATUSES),
      /**
       * Who holds (or last held) the claim. A script knows its own
       * `ctx.job.deviceId` and nothing else that identifies a device, so that
       * is what callers pass. It is a claim MARKER, not an identity: it answers
       * "is somebody already working on this", and a device whose row id
       * changed would at worst leave a claim to go stale and be reclaimed,
       * which is what `staleClaimSec` is for.
       */
      claimedBy: z.string().nullable(),
      /** Unix SECONDS, the repo-wide convention. What `staleClaimSec` measures against. */
      claimedAt: z.number().int().nullable(),
      /** When it reached `done` or `failed`. Unix seconds. */
      settledAt: z.number().int().nullable(),
      attempts: z.number().int().nonnegative(),
      lastError: z.string().max(400).nullable(),
    })
    .strict()
}

export type QueueItem<P> = {
  version: 1
  id: string
  payload: P
  status: QueueStatus
  claimedBy: string | null
  claimedAt: number | null
  settledAt: number | null
  attempts: number
  lastError: string | null
}

export interface QueueClaim<P> {
  /** The full KV key — pass it back to `settle`, so the caller never rebuilds it and never drifts from `keyFor`. */
  key: string
  item: QueueItem<P>
}

/** How `claimNext` orders equally eligible candidates. `random` exists so twenty devices sharing one queue do not all try the same item first. */
export type QueuePick = 'in-order' | 'random'

export interface Queue<P> {
  keyFor(id: string): string
  /**
   * Adds or replaces an item, as `pending`. Re-adding is how a caller says "do
   * this again", so the claim and the last error always reset.
   *
   * `keepHistory` decides what happens to `attempts` and `settledAt`. Default
   * false — a clean slate, the simplest reading of "queue this". Pass true when
   * the count of past attempts is itself information worth keeping, which is
   * what tells an operator an item keeps failing rather than being new.
   */
  put(id: string, payload: P, opts?: { keepHistory?: boolean }): Promise<void>
  get(id: string): Promise<QueueItem<P> | null>
  list(opts?: { status?: QueueStatus }): Promise<QueueItem<P>[]>
  /** `null` when nothing is claimable. A caller reports that as "nothing to do", never as a failure. */
  claimNext(opts: { claimedBy: string; pick?: QueuePick }): Promise<QueueClaim<P> | null>
  /**
   * Records the outcome. Takes the CLAIM `claimNext` returned, not a bare key,
   * because settling has to prove the claim is still held — see the
   * implementation for why a key alone cannot.
   */
  settle(claim: QueueClaim<P>, outcome: { status: 'done' | 'failed'; error?: string }): Promise<void>
  remove(id: string): Promise<boolean>
}

/**
 * Ascending key order — an explicit sort, never an assumption about what order
 * `list()` happens to return.
 */
function byKeyAscending<T extends { key: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * Fisher-Yates, so every permutation is equally likely and the result is not
 * biased by key order. `crypto.getRandomValues`, not `Math.random()` — the same
 * choice `groups/dispatch.ts` makes for `order: 'random'`, kept consistent
 * rather than introducing a second RNG. The casts are bounds-safety for
 * `noUncheckedIndexedAccess`; `i` and `j` are in range by the loop's invariant.
 */
function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  if (out.length < 2) return out
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

/** Every entry under `prefix`, paging until the cursor runs out. */
async function listAll(kv: KvApi, prefix: string): Promise<KvListItem[]> {
  const items: KvListItem[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix, cursor })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

/**
 * The claim protocol's pure half: given a raw listing, decide what is claimable
 * and in what order. No clock, no KV, no context — `nowSec` is the caller's —
 * so a test can force a CAS collision from a fixture instead of faking a whole
 * `ScriptContext`.
 *
 * Exported because it is the part worth testing directly, and the part a reader
 * has to understand to trust the rest.
 */
export function orderCandidates<P>(
  items: KvListItem[],
  schema: z.ZodType<QueueItem<P>>,
  pick: QueuePick,
  nowSec: number,
  staleClaimSec: number,
  readLegacy: (raw: unknown) => unknown = (raw) => raw,
): { key: string; item: QueueItem<P>; version: number }[] {
  const parsed = items.map((listed) => {
    const result = schema.safeParse(readLegacy(listed.value))
    if (!result.success) {
      throw new Error(`queue entry "${listed.key}" has an incompatible shape (expected version 1): ${result.error.message}`)
    }
    return { key: listed.key, item: result.data, version: listed.version }
  })

  const pending = parsed.filter((c) => c.item.status === 'pending')
  // Never both at once: a fresh `pending` item is never skipped in favour of
  // reclaiming an older stale one.
  const eligible =
    pending.length > 0
      ? pending
      : parsed.filter((c) => c.item.status === 'claimed' && c.item.claimedAt !== null && nowSec - c.item.claimedAt >= staleClaimSec)

  return pick === 'in-order' ? byKeyAscending(eligible) : shuffled(eligible)
}

export function createQueue<P>(opts: {
  /** Usually `ctx.storage.global` — a queue shared by every device is the point. Pass `ctx.storage.device` only when the work is genuinely a fact about one phone. */
  kv: KvApi
  /** Namespaces the keys within the plugin's own KV. Trailing `:` is added when missing, so `'queue'` and `'queue:'` mean the same thing. */
  prefix?: string
  /** The caller's payload schema. This module never interprets what it validates. */
  payload: z.ZodType<P>
  staleClaimSec?: number
  /**
   * Translates an entry written by an OLDER shape into this one, on read only.
   *
   * A plugin that kept its own queue before adopting this one has rows on real
   * farms in its own shape, and the schema here is `.strict()` — so without
   * this, adoption would greet an operator with a hard failure on a queue that
   * worked yesterday.
   *
   * It belongs to the CALLER, not to this module: the envelope is generic, and
   * baking one plugin's history into it would make every other plugin carry a
   * translation for a shape it never wrote. Applied on every read and never on
   * a write, so the legacy shape disappears as entries are re-settled.
   */
  readLegacy?: (raw: unknown) => unknown
}): Queue<P> {
  const prefix = (opts.prefix ?? 'queue:').endsWith(':') ? (opts.prefix ?? 'queue:') : `${opts.prefix}:`
  const staleClaimSec = opts.staleClaimSec ?? DEFAULT_STALE_CLAIM_SEC
  const schema = queueItemSchema(opts.payload) as unknown as z.ZodType<QueueItem<P>>
  const readLegacy = opts.readLegacy ?? ((raw: unknown) => raw)
  const kv = opts.kv
  const keyFor = (id: string): string => `${prefix}${id}`
  const nowSec = (): number => Math.floor(Date.now() / 1000)

  /**
   * Reads one entry WITH its version.
   *
   * `KvApi.get` does not report a version — only `list` does — so a
   * single-key compare-and-swap has to go through a listing. Listing by the
   * full key as a prefix over-matches whenever another key extends it
   * (`queue:vid1` is a prefix of `queue:vid10`), so the exact key is filtered
   * out of the result rather than assumed to be alone.
   *
   * This is O(matching keys) per call, which is fine for the queue sizes this
   * is for and is the reason `settle` takes a key rather than being called in a
   * loop. A `getWithVersion` on `KvApi` would remove it; that is a core change
   * and has not been made.
   */
  async function readWithVersion(key: string): Promise<{ item: QueueItem<P>; version: number } | null> {
    const listed = await listAll(kv, key)
    const found = listed.find((entry) => entry.key === key)
    if (!found) return null
    const result = schema.safeParse(readLegacy(found.value))
    if (!result.success) {
      throw new Error(`queue entry "${key}" has an incompatible shape (expected version 1): ${result.error.message}`)
    }
    return { item: result.data, version: found.version }
  }

  return {
    keyFor,

    async put(id, payload, putOpts) {
      const previous = putOpts?.keepHistory ? await readWithVersion(keyFor(id)) : null
      const item: QueueItem<P> = {
        version: 1,
        id,
        payload,
        status: 'pending',
        // Always cleared, whatever `keepHistory` says: an item that is pending
        // again is by definition not claimed, and carrying a stale claim marker
        // would let `claimNext`'s stale check reason about a claim nobody holds.
        claimedBy: null,
        claimedAt: null,
        settledAt: previous?.item.settledAt ?? null,
        attempts: previous?.item.attempts ?? 0,
        lastError: null,
      }
      await kv.set(keyFor(id), item)
    },

    async get(id) {
      const found = await readWithVersion(keyFor(id))
      return found?.item ?? null
    },

    async list(listOpts) {
      const items = await listAll(kv, prefix)
      const parsed = items.map((listed) => {
        const result = schema.safeParse(readLegacy(listed.value))
        if (!result.success) {
          throw new Error(`queue entry "${listed.key}" has an incompatible shape (expected version 1): ${result.error.message}`)
        }
        return { key: listed.key, item: result.data }
      })
      const ordered = byKeyAscending(parsed).map((entry) => entry.item)
      return listOpts?.status ? ordered.filter((item) => item.status === listOpts.status) : ordered
    },

    async claimNext({ claimedBy, pick = 'in-order' }) {
      const now = nowSec()
      const candidates = orderCandidates(await listAll(kv, prefix), schema, pick, now, staleClaimSec, readLegacy)
      for (const candidate of candidates) {
        const claimed: QueueItem<P> = { ...candidate.item, status: 'claimed', claimedBy, claimedAt: now }
        const written = await kv.setIfVersion(candidate.key, claimed, candidate.version)
        if (written) return { key: candidate.key, item: claimed }
        // Lost the race for this one candidate — another worker claimed it
        // between the list and the write. That is the mechanism working, so
        // fall through to the next candidate rather than failing the run.
      }
      return null
    },

    /**
     * Records the outcome of a claimed item.
     *
     * **Why this takes the claim and not just a key.** The obvious shape —
     * read the entry, then `setIfVersion` on the version just read — looks
     * like it guards against another worker having reclaimed a stale claim
     * mid-run. It does not: re-reading the version immediately before writing
     * makes the compare almost always succeed, so the CAS only ever covers the
     * microseconds between that read and that write. A run slower than
     * `staleClaimSec`, or a crash-and-resume, would silently stomp whatever the
     * reclaiming worker had written, and report success.
     *
     * So ownership is checked explicitly, against the claim this worker was
     * actually given: the entry must still be `claimed`, by the same
     * `claimedBy`, at the same `claimedAt`. `claimedAt` is what makes it exact
     * — the same device reclaiming the same item later is a DIFFERENT claim,
     * and the older run must not settle it.
     *
     * The version CAS is kept as well, for the narrow read-write window it
     * genuinely does cover.
     *
     * A key with no entry throws too: making the outcome durable is this
     * function's whole job, and discarding it would look like success
     * everywhere else in the run.
     */
    async settle(claim, outcome) {
      const found = await readWithVersion(claim.key)
      if (!found) {
        throw new Error(`settle: no queue entry at "${claim.key}" — it was removed before this claim could be settled`)
      }
      const held =
        found.item.status === 'claimed' &&
        found.item.claimedBy === claim.item.claimedBy &&
        found.item.claimedAt === claim.item.claimedAt
      if (!held) {
        throw new Error(
          `settle: the claim on "${claim.key}" is no longer held by ${claim.item.claimedBy} — it is now ${found.item.status}` +
            `${found.item.claimedBy !== null ? ` (held by ${found.item.claimedBy})` : ''}. This run took too long and the claim went stale, or it was settled already.`,
        )
      }
      const now = nowSec()
      const settled: QueueItem<P> = {
        ...found.item,
        status: outcome.status,
        attempts: found.item.attempts + 1,
        settledAt: now,
        lastError: outcome.status === 'failed' ? (outcome.error ?? null) : null,
      }
      const written = await kv.setIfVersion(claim.key, settled, found.version)
      if (!written) {
        throw new Error(`settle: lost a race writing queue entry "${claim.key}" — it changed between this read and this write`)
      }
    },

    remove(id) {
      return kv.delete(keyFor(id))
    },
  }
}
