import { describe, expect, test } from 'bun:test'
import type { ArtifactApi, DeviceApi, FarmApi, JobsApi, KvApi, KvListItem, PluginStorage, ScriptContext, ScriptLogger } from '@enkaku/sdk'
import { QueueItemSchema, claimNext, orderCandidates, queueKeyFor, settleClaim, type QueueItem } from './queue'

/**
 * The work queue (plan 113 §5 step 113.7, §6 criteria 7–8). `orderCandidates` is pure — no `ctx`,
 * no clock but the caller's own `nowSec` — so the CAS collision (criterion 7) is forced with a fake
 * store rather than merely hoped for, exactly as the plan's own test plan (§7) asks.
 */

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    version: 1,
    artifactId: 'art-1',
    caption: null,
    status: 'pending',
    claimedBy: null,
    claimedAt: null,
    postedAt: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  }
}

function listed(key: string, value: QueueItem, version = 1): KvListItem {
  return { key, value, secret: false, hint: null, version, expiresAt: null, updatedAt: 0 }
}

describe('queueKeyFor', () => {
  test('prefixes with QUEUE_PREFIX so a writer and a reader never drift', () => {
    expect(queueKeyFor('artifact-123')).toBe('queue:artifact-123')
  })
})

describe('QueueItemSchema — .strict() and a literal version, for the same reason accounts.ts uses them', () => {
  test('parses a well-formed entry', () => {
    expect(QueueItemSchema.safeParse(item()).success).toBe(true)
  })

  test('refuses an unknown field', () => {
    const withExtra = { ...item(), extra: 'nope' }
    expect(QueueItemSchema.safeParse(withExtra).success).toBe(false)
  })

  test('refuses a version other than the literal 1', () => {
    expect(QueueItemSchema.safeParse({ ...item(), version: 2 }).success).toBe(false)
  })
})

describe('orderCandidates — the claim protocol\'s pure half', () => {
  test('pending candidates are always preferred over a stale claimed one', () => {
    const now = 1_000_000
    const items = [listed('queue:a', item({ status: 'claimed', claimedAt: now - 10_000, claimedBy: 'dev-x' })), listed('queue:b', item({ status: 'pending' }))]
    expect(orderCandidates(items, 'in-order', now, 1_800).map((c) => c.key)).toEqual(['queue:b'])
  })

  test('a stale claimed entry becomes eligible only when NO pending item exists', () => {
    const now = 1_000_000
    const stale = listed('queue:a', item({ status: 'claimed', claimedAt: now - 2_000, claimedBy: 'dev-x' }))
    expect(orderCandidates([stale], 'in-order', now, 1_800).map((c) => c.key)).toEqual(['queue:a'])
  })

  test('a claimed entry YOUNGER than staleClaimSec is not eligible at all', () => {
    const now = 1_000_000
    const fresh = listed('queue:a', item({ status: 'claimed', claimedAt: now - 100, claimedBy: 'dev-x' }))
    expect(orderCandidates([fresh], 'in-order', now, 1_800)).toEqual([])
  })

  test('a posted or failed entry is never a candidate, stale or not', () => {
    const now = 1_000_000
    const items = [listed('queue:a', item({ status: 'posted', claimedAt: now - 10_000 })), listed('queue:b', item({ status: 'failed', claimedAt: now - 10_000 }))]
    expect(orderCandidates(items, 'in-order', now, 1_800)).toEqual([])
  })

  test('"in-order" is stable, ascending by key — independent of the order list() happened to return', () => {
    const now = 1_000_000
    const items = [listed('queue:c', item()), listed('queue:a', item()), listed('queue:b', item())]
    expect(orderCandidates(items, 'in-order', now, 1_800).map((c) => c.key)).toEqual(['queue:a', 'queue:b', 'queue:c'])
    // The reversed input produces the IDENTICAL order — proving this is an explicit sort, not an
    // assumption riding on list()'s own order.
    expect(
      orderCandidates([...items].reverse(), 'in-order', now, 1_800).map((c) => c.key),
    ).toEqual(['queue:a', 'queue:b', 'queue:c'])
  })

  test('"random" reaches every candidate over enough draws', () => {
    const now = 1_000_000
    const items = ['queue:a', 'queue:b', 'queue:c'].map((k) => listed(k, item()))
    const firstPicks = new Set<string>()
    for (let i = 0; i < 200; i++) {
      firstPicks.add(orderCandidates(items, 'random', now, 1_800)[0]?.key as string)
    }
    expect(firstPicks).toEqual(new Set(['queue:a', 'queue:b', 'queue:c']))
  })

  test('throws when a stored entry no longer matches QueueItemSchema — the same fail-loud posture as ctx.kv.get(key, schema)', () => {
    const bad = listed('queue:a', { version: 1, artifactId: 'x' } as unknown as QueueItem)
    expect(() => orderCandidates([bad], 'in-order', 1_000_000, 1_800)).toThrow()
  })
})

/** A minimal `KvApi` fake — every method not exercised here throws, so an accidental extra call fails loudly instead of silently reading nothing. */
function fakeKv(opts: {
  listItems?: KvListItem[]
  setIfVersion?: (key: string, value: unknown, expectedVersion: number) => Promise<{ version: number } | null>
} = {}): { kv: KvApi; calls: { setIfVersion: Array<{ key: string; value: unknown; expectedVersion: number }> } } {
  const calls = { setIfVersion: [] as Array<{ key: string; value: unknown; expectedVersion: number }> }
  const kv: KvApi = {
    get: async () => {
      throw new Error('unused: get')
    },
    getRaw: async () => {
      throw new Error('unused: getRaw')
    },
    set: async () => {
      throw new Error('unused: set')
    },
    setIfVersion: async (key, value, expectedVersion) => {
      calls.setIfVersion.push({ key, value, expectedVersion })
      return opts.setIfVersion ? opts.setIfVersion(key, value, expectedVersion) : { version: expectedVersion + 1 }
    },
    increment: async () => {
      throw new Error('unused: increment')
    },
    delete: async () => {
      throw new Error('unused: delete')
    },
    list: async () => ({ items: opts.listItems ?? [], nextCursor: null }),
  }
  return { kv, calls }
}

const unused = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`queue.ts should not touch ctx.${String(prop)} in this test`)
    },
  },
)

function fakeCtx(kv: KvApi): ScriptContext<unknown> {
  return {
    device: unused as DeviceApi,
    params: undefined,
    artifact: unused as ArtifactApi,
    log: unused as ScriptLogger,
    job: { id: 'job-1', attempt: 1, deviceId: 'device-1' },
    kv: { device: unused as KvApi, global: unused as KvApi },
    storage: { global: kv, device: unused as KvApi, forDevice: () => unused as KvApi } as PluginStorage,
    farm: unused as FarmApi,
    jobs: unused as JobsApi,
    progress: () => {},
  }
}

describe('claimNext — criterion 7: the CAS collision, forced, not merely observed', () => {
  test('a lost race on the first candidate moves the claim to the NEXT candidate, never to failure', async () => {
    const items = [listed('queue:a', item({ artifactId: 'a' }), 5), listed('queue:b', item({ artifactId: 'b' }), 7)]
    const { kv, calls } = fakeKv({
      listItems: items,
      setIfVersion: async (key) => (key === 'queue:a' ? null : { version: 8 }), // "a" is already claimed by another device by the time we write
    })
    const ctx = fakeCtx(kv)
    const result = await claimNext(ctx, { pick: 'in-order', claimedBy: 'device-2' })
    expect(result?.key).toBe('queue:b')
    expect(result?.item.artifactId).toBe('b')
    expect(result?.item.status).toBe('claimed')
    expect(result?.item.claimedBy).toBe('device-2')
    // Both candidates were tried, in order — the loss on "a" did not abort the run.
    expect(calls.setIfVersion.map((c) => c.key)).toEqual(['queue:a', 'queue:b'])
  })

  test('an empty queue returns null — reported by the caller as "skipped", never a failure', async () => {
    const { kv } = fakeKv({ listItems: [] })
    expect(await claimNext(fakeCtx(kv), { pick: 'in-order', claimedBy: 'device-1' })).toBeNull()
  })

  test('every candidate losing its race also returns null, not a throw — a fully-contested queue is still "skipped"', async () => {
    const items = [listed('queue:a', item())]
    const { kv } = fakeKv({ listItems: items, setIfVersion: async () => null })
    expect(await claimNext(fakeCtx(kv), { pick: 'in-order', claimedBy: 'device-1' })).toBeNull()
  })
})

describe('settleClaim', () => {
  test('re-reads the version through list() (get() reports none) and settles under CAS', async () => {
    const items = [listed('queue:a', item({ status: 'claimed', claimedBy: 'device-1', claimedAt: 900 }), 3)]
    const { kv, calls } = fakeKv({ listItems: items })
    await settleClaim(fakeCtx(kv), 'queue:a', { status: 'posted' })
    expect(calls.setIfVersion).toHaveLength(1)
    expect(calls.setIfVersion[0]?.expectedVersion).toBe(3)
    const written = calls.setIfVersion[0]?.value as QueueItem
    expect(written.status).toBe('posted')
    expect(written.attempts).toBe(1)
    expect(written.postedAt).not.toBeNull()
  })

  test('throws when the key no longer exists — a deleted entry must never look like a settled success', async () => {
    const { kv } = fakeKv({ listItems: [] })
    await expect(settleClaim(fakeCtx(kv), 'queue:missing', { status: 'posted' })).rejects.toThrow()
  })

  test('throws when settling loses its own CAS race — reclaimed or modified mid-run', async () => {
    const items = [listed('queue:a', item({ status: 'claimed' }), 3)]
    const { kv } = fakeKv({ listItems: items, setIfVersion: async () => null })
    await expect(settleClaim(fakeCtx(kv), 'queue:a', { status: 'failed', error: 'boom' })).rejects.toThrow()
  })
})
