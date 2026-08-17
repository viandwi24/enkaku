import { describe, expect, test } from 'bun:test'
import { createTransferRegistry } from './transfer-registry'

/**
 * Plan 107 §3.1, §3.4, §4, step 107.2 — the in-memory registry behind
 * `GET /api/transfers`. See `transfer-registry.ts`'s own doc comment for why
 * `progress`/`done` (not a separate `start()`) are the only two write
 * methods: they mirror `TransferBroadcast`'s existing shape exactly, so
 * `daemon.ts`'s single `transferBroadcast` object can feed this registry
 * without threading a new dependency through `runTransfer`'s nine call
 * sites.
 */
describe('createTransferRegistry', () => {
  test('a progress tick creates a running entry, visible in list()', () => {
    let clock = 1_000_000
    const registry = createTransferRegistry(() => clock)
    registry.progress('dev-1', 'transfer-1', 'install', 100, 500)

    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      transferId: 'transfer-1',
      deviceId: 'dev-1',
      kind: 'install',
      state: 'running',
      sent: 100,
      total: 500,
      ok: null,
      error: null,
    })
    expect(list[0]!.startedAt).toBe(Math.floor(clock / 1000))
    expect(list[0]!.updatedAt).toBe(Math.floor(clock / 1000))
  })

  test('a later progress tick updates sent/total/updatedAt on the SAME entry, not a second one', () => {
    let clock = 1_000_000
    const registry = createTransferRegistry(() => clock)
    registry.progress('dev-1', 'transfer-1', 'push', 10, 1000)
    clock += 2_000
    registry.progress('dev-1', 'transfer-1', 'push', 400, 1000)

    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ sent: 400, total: 1000, state: 'running' })
    expect(list[0]!.updatedAt).toBe(Math.floor(clock / 1000))
  })

  test('done() after progress() marks the SAME entry done, keeping its last known sent/total', () => {
    const registry = createTransferRegistry()
    registry.progress('dev-1', 'transfer-1', 'pull', 250, 250)
    registry.done('dev-1', 'transfer-1', 'pull', true)

    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ state: 'done', ok: true, error: null, sent: 250, total: 250 })
  })

  test('done() with NO preceding progress() still creates an entry — an install that fails before its first tick must still be discoverable', () => {
    const registry = createTransferRegistry()
    registry.done('dev-1', 'transfer-1', 'install', false, 'device offline')

    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ state: 'done', ok: false, error: 'device offline', sent: 0, total: null })
  })

  test('a stray progress() AFTER done() does not resurrect the entry as running', () => {
    const registry = createTransferRegistry()
    registry.progress('dev-1', 'transfer-1', 'install', 10, 100)
    registry.done('dev-1', 'transfer-1', 'install', true)
    registry.progress('dev-1', 'transfer-1', 'install', 100, 100)

    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.state).toBe('done')
    expect(list[0]!.sent).toBe(10) // unchanged by the late tick
  })

  test('multiple concurrent transfers across different devices all appear, newest-started first', () => {
    let clock = 1_000_000
    const registry = createTransferRegistry(() => clock)
    registry.progress('dev-1', 'transfer-a', 'install', 1, 10)
    clock += 1_000
    registry.progress('dev-2', 'transfer-b', 'push', 1, 10)
    clock += 1_000
    registry.progress('dev-3', 'transfer-c', 'pull', 1, 10)

    const list = registry.list()
    expect(list.map((r) => r.transferId)).toEqual(['transfer-c', 'transfer-b', 'transfer-a'])
  })

  test('a finished transfer is evicted once its retention window elapses, so the list is not an unbounded history', () => {
    let clock = 1_000_000
    const registry = createTransferRegistry(() => clock)
    registry.done('dev-1', 'transfer-1', 'install', true)
    expect(registry.list()).toHaveLength(1)

    clock += 30_001 // just past RETENTION_MS
    expect(registry.list()).toHaveLength(0)
  })

  test('a RUNNING transfer is never evicted, no matter how long it has been running', () => {
    let clock = 1_000_000
    const registry = createTransferRegistry(() => clock)
    registry.progress('dev-1', 'transfer-1', 'install', 1, 100)

    clock += 10 * 60_000 // ten minutes
    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.state).toBe('running')
  })

  test('two different transferIds on the same device are tracked independently', () => {
    const registry = createTransferRegistry()
    registry.progress('dev-1', 'transfer-a', 'push', 1, 10)
    registry.progress('dev-1', 'transfer-b', 'pull', 2, 20)

    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(new Set(list.map((r) => r.transferId))).toEqual(new Set(['transfer-a', 'transfer-b']))
  })

  describe('origin (plan 106 §5 step 106.8)', () => {
    test('defaults to "operator" when the caller passes none — every pre-106.8 producer keeps validating unchanged', () => {
      const registry = createTransferRegistry()
      registry.progress('dev-1', 'transfer-1', 'install', 1, 10)
      expect(registry.list()[0]).toMatchObject({ origin: 'operator' })
    })

    test('"preparation" set on the FIRST progress() tick is carried through to done()', () => {
      const registry = createTransferRegistry()
      registry.progress('dev-1', 'transfer-1', 'install', 1, 10, 'preparation')
      registry.done('dev-1', 'transfer-1', 'install', true)
      expect(registry.list()[0]).toMatchObject({ origin: 'preparation' })
    })

    test('"preparation" set on done() with no preceding progress() still creates the entry with that origin', () => {
      const registry = createTransferRegistry()
      registry.done('dev-1', 'transfer-1', 'install', false, 'device offline', 'preparation')
      expect(registry.list()[0]).toMatchObject({ origin: 'preparation', state: 'done', ok: false })
    })

    test('origin is fixed at creation — a later call with a different value never overwrites it', () => {
      const registry = createTransferRegistry()
      registry.progress('dev-1', 'transfer-1', 'install', 1, 10, 'preparation')
      registry.progress('dev-1', 'transfer-1', 'install', 5, 10, 'operator')
      expect(registry.list()[0]).toMatchObject({ origin: 'preparation', sent: 5 })
    })
  })
})
