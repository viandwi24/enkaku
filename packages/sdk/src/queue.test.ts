import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createQueue, orderCandidates, queueItemSchema, type QueueItem } from './queue'
import type { KvApi, KvListItem, KvListResult, KvSetOptions } from './types'

const PayloadSchema = z.object({ caption: z.string() })
type Payload = z.infer<typeof PayloadSchema>
const ItemSchema = queueItemSchema(PayloadSchema) as unknown as z.ZodType<QueueItem<Payload>>

/**
 * An in-memory KV with the two properties the queue actually depends on:
 * versions increment on write, and `setIfVersion` fails when the version moved.
 * Anything simpler would let the CAS tests pass without a CAS.
 */
function fakeKv(): KvApi & { seed(key: string, value: unknown): void; raw: Map<string, { value: unknown; version: number }> } {
  const store = new Map<string, { value: unknown; version: number }>()
  return {
    raw: store,
    seed(key, value) {
      store.set(key, { value, version: 1 })
    },
    async get() {
      throw new Error('the queue must not use get() — it reports no version')
    },
    async getRaw(key: string) {
      return store.get(key)?.value ?? null
    },
    async set(key: string, value: unknown, _opts?: KvSetOptions) {
      const version = (store.get(key)?.version ?? 0) + 1
      store.set(key, { value, version })
      return { version }
    },
    async setIfVersion(key: string, value: unknown, expectedVersion: number) {
      const current = store.get(key)
      if (!current || current.version !== expectedVersion) return null
      const version = current.version + 1
      store.set(key, { value, version })
      return { version }
    },
    async increment() {
      throw new Error('not used')
    },
    async delete(key: string) {
      return store.delete(key)
    },
    async list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListResult> {
      const prefix = opts?.prefix ?? ''
      const items: KvListItem[] = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({
          key,
          value: entry.value,
          secret: false,
          hint: null,
          version: entry.version,
          expiresAt: null,
          updatedAt: 0,
        }))
      return { items, nextCursor: null }
    },
  }
}

const item = (over: Partial<QueueItem<Payload>> & { id: string }): QueueItem<Payload> => ({
  version: 1,
  payload: { caption: 'c' },
  status: 'pending',
  claimedBy: null,
  claimedAt: null,
  settledAt: null,
  attempts: 0,
  lastError: null,
  ...over,
})

const listed = (key: string, value: unknown, version = 1): KvListItem => ({
  key,
  value,
  secret: false,
  hint: null,
  version,
  expiresAt: null,
  updatedAt: 0,
})

describe('orderCandidates', () => {
  test('pending items are preferred, and a stale claim is not touched while any pending exists', () => {
    const rows = [
      listed('q:a', item({ id: 'a', status: 'claimed', claimedBy: 'd1', claimedAt: 0 })),
      listed('q:b', item({ id: 'b' })),
    ]
    const out = orderCandidates(rows, ItemSchema, 'in-order', 10_000, 1_800)
    expect(out.map((c) => c.item.id)).toEqual(['b'])
  })

  test('only when nothing is pending does a stale claim become a candidate', () => {
    const rows = [listed('q:a', item({ id: 'a', status: 'claimed', claimedBy: 'd1', claimedAt: 0 }))]
    expect(orderCandidates(rows, ItemSchema, 'in-order', 10_000, 1_800).map((c) => c.item.id)).toEqual(['a'])
  })

  test('a claim that is not yet stale is never a candidate', () => {
    const rows = [listed('q:a', item({ id: 'a', status: 'claimed', claimedBy: 'd1', claimedAt: 9_000 }))]
    expect(orderCandidates(rows, ItemSchema, 'in-order', 10_000, 1_800)).toEqual([])
  })

  test('done and failed are terminal — never candidates, however old', () => {
    const rows = [
      listed('q:a', item({ id: 'a', status: 'done', settledAt: 0 })),
      listed('q:b', item({ id: 'b', status: 'failed', settledAt: 0, lastError: 'x' })),
    ]
    expect(orderCandidates(rows, ItemSchema, 'in-order', 10_000, 1_800)).toEqual([])
  })

  test('in-order is key-ascending, not whatever order list() returned', () => {
    const rows = [listed('q:c', item({ id: 'c' })), listed('q:a', item({ id: 'a' })), listed('q:b', item({ id: 'b' }))]
    expect(orderCandidates(rows, ItemSchema, 'in-order', 0, 1_800).map((c) => c.item.id)).toEqual(['a', 'b', 'c'])
  })

  /** A shape this code cannot understand must never be silently skipped — that is indistinguishable from an empty queue. */
  test('an entry with an incompatible shape throws, naming the key', () => {
    const rows = [listed('q:a', { version: 2, id: 'a' })]
    expect(() => orderCandidates(rows, ItemSchema, 'in-order', 0, 1_800)).toThrow(/q:a/)
  })
})

describe('readLegacy — the caller owns its own history', () => {
  /**
   * A plugin that kept its own queue before adopting this one has rows on real
   * farms in its own shape, and the envelope here is `.strict()`. Without a
   * translation, adoption would greet an operator with a hard failure on data
   * they cannot get back — so the hook exists, and it belongs to the CALLER:
   * baking one plugin's history into this module would make every other plugin
   * carry a translation for a shape it never wrote.
   */
  const legacy = { v: 1, key: 'a', text: 'hi', state: 'waiting' }
  const translate = (raw: unknown): unknown => {
    const row = raw as Record<string, unknown>
    if (!row || typeof row !== 'object' || 'payload' in row) return raw
    return {
      version: 1,
      id: row.key,
      payload: { caption: row.text },
      status: row.state === 'waiting' ? 'pending' : row.state,
      claimedBy: null,
      claimedAt: null,
      settledAt: null,
      attempts: 0,
      lastError: null,
    }
  }

  test('an entry in an older shape is readable through the hook', async () => {
    const kv = fakeKv()
    kv.seed('queue:a', legacy)
    const queue = createQueue({ kv, payload: PayloadSchema, readLegacy: translate })
    expect((await queue.get('a'))?.payload).toEqual({ caption: 'hi' })
  })

  test('an older entry is claimable, so adoption does not strand queued work', async () => {
    const kv = fakeKv()
    kv.seed('queue:a', legacy)
    const queue = createQueue({ kv, payload: PayloadSchema, readLegacy: translate })
    expect((await queue.claimNext({ claimedBy: 'd1' }))?.item.id).toBe('a')
  })

  test('the translation is read-only — what gets written back is the new shape', async () => {
    const kv = fakeKv()
    kv.seed('queue:a', legacy)
    const queue = createQueue({ kv, payload: PayloadSchema, readLegacy: translate })
    const claim = await queue.claimNext({ claimedBy: 'd1' })
    await queue.settle(claim!, { status: 'done' })
    expect(kv.raw.get('queue:a')?.value).toMatchObject({ id: 'a', payload: { caption: 'hi' }, status: 'done' })
  })

  test('without the hook, an older entry fails loudly rather than being half-read', async () => {
    const kv = fakeKv()
    kv.seed('queue:a', legacy)
    expect(createQueue({ kv, payload: PayloadSchema }).list()).rejects.toThrow(/queue:a/)
  })
})

describe('createQueue', () => {
  test('put stores a pending item that claimNext then hands out', async () => {
    const kv = fakeKv()
    const queue = createQueue({ kv, payload: PayloadSchema })
    await queue.put('vid1', { caption: 'hello' })

    const claim = await queue.claimNext({ claimedBy: 'device-1' })
    expect(claim?.item.id).toBe('vid1')
    expect(claim?.item.status).toBe('claimed')
    expect(claim?.item.claimedBy).toBe('device-1')
    expect(claim?.item.payload).toEqual({ caption: 'hello' })
  })

  test('an empty queue claims nothing — that is an answer, not a failure', async () => {
    const queue = createQueue({ kv: fakeKv(), payload: PayloadSchema })
    expect(await queue.claimNext({ claimedBy: 'd1' })).toBeNull()
  })

  test('two workers never hold the same item', async () => {
    const kv = fakeKv()
    const queue = createQueue({ kv, payload: PayloadSchema })
    await queue.put('vid1', { caption: 'a' })
    await queue.put('vid2', { caption: 'b' })

    const first = await queue.claimNext({ claimedBy: 'device-1' })
    const second = await queue.claimNext({ claimedBy: 'device-2' })
    expect(first?.item.id).not.toBe(second?.item.id)
  })

  /**
   * The race the CAS exists for: another worker takes the item between this
   * one's list and its write. Losing that race must move to the NEXT candidate,
   * not fail the run.
   */
  test('losing the race for one candidate falls through to the next', async () => {
    const kv = fakeKv()
    const queue = createQueue({ kv, payload: PayloadSchema })
    await queue.put('vid1', { caption: 'a' })
    await queue.put('vid2', { caption: 'b' })

    const realSetIfVersion = kv.setIfVersion.bind(kv)
    let first = true
    kv.setIfVersion = async (key, value, expected) => {
      if (first) {
        first = false
        // Simulate the other worker's write landing first.
        await realSetIfVersion(key, value, expected)
        return null
      }
      return realSetIfVersion(key, value, expected)
    }

    const claim = await queue.claimNext({ claimedBy: 'device-1' })
    expect(claim?.item.id).toBe('vid2')
  })

  test('settle records the outcome, the attempt and the error', async () => {
    const kv = fakeKv()
    const queue = createQueue({ kv, payload: PayloadSchema })
    await queue.put('vid1', { caption: 'a' })
    const claim = await queue.claimNext({ claimedBy: 'd1' })

    await queue.settle(claim!, { status: 'failed', error: 'app crashed' })
    const after = await queue.get('vid1')
    expect(after?.status).toBe('failed')
    expect(after?.attempts).toBe(1)
    expect(after?.lastError).toBe('app crashed')
    expect(after?.settledAt).not.toBeNull()
  })

  test('settling a key that is gone throws rather than looking like success', async () => {
    const queue = createQueue({ kv: fakeKv(), payload: PayloadSchema })
    const orphan = { key: 'queue:gone', item: item({ id: 'gone', status: 'claimed', claimedBy: 'd1', claimedAt: 1 }) }
    expect(queue.settle(orphan, { status: 'done' })).rejects.toThrow(/no queue entry/)
  })

  /** A claim that went stale and was reclaimed must not be stomped silently. */
  test('settling a claim another worker reclaimed throws', async () => {
    const kv = fakeKv()
    const queue = createQueue({ kv, payload: PayloadSchema })
    await queue.put('vid1', { caption: 'a' })
    const claim = await queue.claimNext({ claimedBy: 'd1' })
    // Someone else writes to the same key, moving its version on.
    await kv.set(claim!.key, { ...claim!.item, claimedBy: 'd2' })

    expect(queue.settle(claim!, { status: 'done' })).rejects.toThrow(/no longer held by/)
  })

  /**
   * `queue:vid1` is a prefix of `queue:vid10`. Reading one key by prefix
   * over-matches, so the exact key has to be filtered — otherwise settling
   * `vid1` could read `vid10`'s row.
   */
  test('a key that is a prefix of another key still reads its own row', async () => {
    const kv = fakeKv()
    const queue = createQueue({ kv, payload: PayloadSchema })
    await queue.put('vid1', { caption: 'one' })
    await queue.put('vid10', { caption: 'ten' })

    expect((await queue.get('vid1'))?.payload).toEqual({ caption: 'one' })
    expect((await queue.get('vid10'))?.payload).toEqual({ caption: 'ten' })
  })

  test('list filters by status and is key-ordered', async () => {
    const kv = fakeKv()
    const queue = createQueue({ kv, payload: PayloadSchema })
    await queue.put('b', { caption: 'b' })
    await queue.put('a', { caption: 'a' })
    const claim = await queue.claimNext({ claimedBy: 'd1' })
    await queue.settle(claim!, { status: 'done' })

    expect((await queue.list()).map((i) => i.id)).toEqual(['a', 'b'])
    expect((await queue.list({ status: 'pending' })).map((i) => i.id)).toEqual(['b'])
    expect((await queue.list({ status: 'done' })).map((i) => i.id)).toEqual(['a'])
  })

  test('put on an existing id resets it to pending — re-adding work means do it again', async () => {
    const kv = fakeKv()
    const queue = createQueue({ kv, payload: PayloadSchema })
    await queue.put('vid1', { caption: 'a' })
    const claim = await queue.claimNext({ claimedBy: 'd1' })
    await queue.settle(claim!, { status: 'failed', error: 'x' })

    await queue.put('vid1', { caption: 'b' })
    const after = await queue.get('vid1')
    expect(after?.status).toBe('pending')
    expect(after?.lastError).toBeNull()
    expect(after?.attempts).toBe(0)
  })

  test('the prefix is namespaced, and a missing trailing colon is added', async () => {
    const kv = fakeKv()
    await createQueue({ kv, prefix: 'posts', payload: PayloadSchema }).put('vid1', { caption: 'a' })
    expect([...kv.raw.keys()]).toEqual(['posts:vid1'])
  })

  test('remove deletes the entry', async () => {
    const kv = fakeKv()
    const queue = createQueue({ kv, payload: PayloadSchema })
    await queue.put('vid1', { caption: 'a' })
    expect(await queue.remove('vid1')).toBe(true)
    expect(await queue.get('vid1')).toBeNull()
  })

  test('the payload is validated by the caller-supplied schema, not guessed', async () => {
    const kv = fakeKv()
    kv.seed('queue:bad', { ...item({ id: 'bad' }), payload: { caption: 42 } })
    const queue = createQueue({ kv, payload: PayloadSchema })
    expect(queue.list()).rejects.toThrow(/queue:bad/)
  })
})
