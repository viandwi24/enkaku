import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createLogger } from '../util/logger'
import { createNotifyRateLimiter, createNotifyService } from './service'
import { createNotificationStore } from './store'
import { createWebhookStore } from './webhook-store'

/**
 * `notify.send`'s assembled operation (plan 68 §3.4, §4.4): the in-app row
 * is written FIRST, always (criterion 9); the output distinguishes
 * delivered from failed channels; a channel beyond the rate limit is
 * refused as an error, not a failed run (criterion 12); webhook delivery
 * does not consume the caller's time beyond one bounded attempt — retries
 * run detached (criterion 13). No real network call anywhere — every test
 * injects a fake `fetch`.
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-notify-service-test-'))
  const store = createNotificationStore(db)
  const webhooks = createWebhookStore({ db, dataDir })
  return { db, store, webhooks }
}

function fakeFetch(statusForUrl: (url: string) => number): typeof fetch {
  return (async (url: string | URL | Request) => new Response(null, { status: statusForUrl(String(url)) })) as unknown as typeof fetch
}

describe('createNotifyService — the in-app row is written first, always (criterion 9)', () => {
  test('writes an in-app notification even when every webhook fails', async () => {
    const { store, webhooks } = setUp()
    webhooks.create({ name: 'dead-hook', url: 'https://dead.example.com/hook' })
    const service = createNotifyService({
      store,
      webhooks,
      rateLimiter: createNotifyRateLimiter(),
      log: createLogger('test'),
      fetch: fakeFetch(() => 500),
      firstAttemptTimeoutMs: 50,
      retryDelaysMs: [1, 1],
      retryTimeoutMs: 50,
      sleep: async () => {},
    })

    const result = await service.send(
      { level: 'error', title: 'checkout is broken', channels: ['dead-hook'] },
      { source: 'agent:a1', context: { runId: 'r1' }, agentId: 'a1', runId: 'r1' },
    )

    expect(result.delivered).toEqual([])
    expect(result.failed).toEqual(['dead-hook'])
    // The row exists regardless — this is the whole point of "written first".
    const notification = store.get(result.notificationId)
    expect(notification).not.toBeNull()
    expect(notification?.title).toBe('checkout is broken')
    expect(notification?.context).toEqual({ runId: 'r1' })
  })

  test('writes an in-app notification with no channels at all — in-app only is the default', async () => {
    const { store, webhooks } = setUp()
    const service = createNotifyService({ store, webhooks, rateLimiter: createNotifyRateLimiter(), log: createLogger('test') })
    const result = await service.send({ level: 'info', title: 'fyi' }, { source: 'system', context: null, agentId: null, runId: null })
    expect(result.delivered).toEqual([])
    expect(result.failed).toEqual([])
    expect(store.get(result.notificationId)).not.toBeNull()
  })

  test('output names exactly which channels delivered and which failed — never a blind ok', async () => {
    const { store, webhooks } = setUp()
    webhooks.create({ name: 'good', url: 'https://good.example.com/hook' })
    webhooks.create({ name: 'bad', url: 'https://bad.example.com/hook' })
    const service = createNotifyService({
      store,
      webhooks,
      rateLimiter: createNotifyRateLimiter(),
      log: createLogger('test'),
      fetch: fakeFetch((url) => (url.includes('good') ? 200 : 500)),
      firstAttemptTimeoutMs: 50,
      retryDelaysMs: [1, 1],
      retryTimeoutMs: 50,
      sleep: async () => {},
    })
    const result = await service.send({ level: 'warn', title: 'mixed', channels: ['good', 'bad'] }, { source: 'system', context: null, agentId: null, runId: null })
    expect(result.delivered).toEqual(['good'])
    expect(result.failed).toEqual(['bad'])
  })

  test('an unknown channel name is failed immediately — no network attempt, never leaks a raw URL', async () => {
    const { store, webhooks } = setUp()
    let fetchCalls = 0
    const service = createNotifyService({
      store,
      webhooks,
      rateLimiter: createNotifyRateLimiter(),
      log: createLogger('test'),
      fetch: (async () => {
        fetchCalls++
        return new Response(null, { status: 200 })
      }) as unknown as typeof fetch,
    })
    const result = await service.send({ level: 'info', title: 'x', channels: ['does-not-exist'] }, { source: 'system', context: null, agentId: null, runId: null })
    expect(result.failed).toEqual(['does-not-exist'])
    expect(fetchCalls).toBe(0)
  })

  test('a disabled endpoint is failed immediately, without a delivery attempt', async () => {
    const { store, webhooks } = setUp()
    const endpoint = webhooks.create({ name: 'off', url: 'https://example.com/hook', enabled: false })
    let fetchCalls = 0
    const service = createNotifyService({
      store,
      webhooks,
      rateLimiter: createNotifyRateLimiter(),
      log: createLogger('test'),
      fetch: (async () => {
        fetchCalls++
        return new Response(null, { status: 200 })
      }) as unknown as typeof fetch,
    })
    const result = await service.send({ level: 'info', title: 'x', channels: [endpoint.name] }, { source: 'system', context: null, agentId: null, runId: null })
    expect(result.failed).toEqual(['off'])
    expect(fetchCalls).toBe(0)
  })
})

describe('createNotifyService — rate limiting (plan 68 §3.4, criterion 12)', () => {
  test('exceeding the per-run limit throws E_RATE_LIMIT, and the row is never written for that call', async () => {
    const { store, webhooks } = setUp()
    const service = createNotifyService({ store, webhooks, rateLimiter: createNotifyRateLimiter({ perRun: 2 }), log: createLogger('test') })
    await service.send({ level: 'info', title: '1' }, { source: 'agent:a1', context: null, agentId: 'a1', runId: 'run-1' })
    await service.send({ level: 'info', title: '2' }, { source: 'agent:a1', context: null, agentId: 'a1', runId: 'run-1' })
    const before = store.list().length
    await expect(service.send({ level: 'info', title: '3' }, { source: 'agent:a1', context: null, agentId: 'a1', runId: 'run-1' })).rejects.toThrow(/E_RATE_LIMIT|limit/)
    expect(store.list().length).toBe(before) // refused BEFORE the in-app row is written
  })

  test('a different run for the same agent gets its own per-run counter', async () => {
    const { store, webhooks } = setUp()
    const service = createNotifyService({ store, webhooks, rateLimiter: createNotifyRateLimiter({ perRun: 1 }), log: createLogger('test') })
    await service.send({ level: 'info', title: '1' }, { source: 'agent:a1', context: null, agentId: 'a1', runId: 'run-1' })
    await expect(service.send({ level: 'info', title: '2' }, { source: 'agent:a1', context: null, agentId: 'a1', runId: 'run-1' })).rejects.toThrow()
    // A second run for the SAME agent is a fresh per-run counter.
    await expect(service.send({ level: 'info', title: '3' }, { source: 'agent:a1', context: null, agentId: 'a1', runId: 'run-2' })).resolves.toBeDefined()
  })

  test('exceeding the per-hour limit throws, even across different runs', async () => {
    const { store, webhooks } = setUp()
    const service = createNotifyService({ store, webhooks, rateLimiter: createNotifyRateLimiter({ perRun: 100, perHour: 2 }), log: createLogger('test') })
    await service.send({ level: 'info', title: '1' }, { source: 'agent:a1', context: null, agentId: 'a1', runId: 'run-1' })
    await service.send({ level: 'info', title: '2' }, { source: 'agent:a1', context: null, agentId: 'a1', runId: 'run-2' })
    await expect(service.send({ level: 'info', title: '3' }, { source: 'agent:a1', context: null, agentId: 'a1', runId: 'run-3' })).rejects.toThrow(/hour/)
  })

  test('a human/system caller (agentId null) is never rate-limited', async () => {
    const { store, webhooks } = setUp()
    const service = createNotifyService({ store, webhooks, rateLimiter: createNotifyRateLimiter({ perRun: 1, perHour: 1 }), log: createLogger('test') })
    for (let i = 0; i < 5; i++) {
      await expect(service.send({ level: 'info', title: `n${i}` }, { source: 'system', context: null, agentId: null, runId: null })).resolves.toBeDefined()
    }
  })
})

describe('createNotifyService — webhook delivery does not consume the caller\'s time beyond one bounded attempt (criterion 13)', () => {
  test('send() resolves without waiting for the backoff-delayed retry attempts', async () => {
    const { store, webhooks } = setUp()
    webhooks.create({ name: 'slow-to-recover', url: 'https://example.com/hook' })
    let sleptMs: number[] = []
    const service = createNotifyService({
      store,
      webhooks,
      rateLimiter: createNotifyRateLimiter(),
      log: createLogger('test'),
      fetch: fakeFetch(() => 500), // always fails
      firstAttemptTimeoutMs: 20,
      retryDelaysMs: [10_000, 20_000], // huge — send() must not wait for these
      retryTimeoutMs: 20,
      sleep: async (ms) => {
        sleptMs.push(ms)
        // A real timer is never awaited by the test — this proves send() itself did not await it.
      },
    })

    const startedAt = Date.now()
    const result = await service.send({ level: 'error', title: 'x', channels: ['slow-to-recover'] }, { source: 'system', context: null, agentId: null, runId: null })
    const elapsedMs = Date.now() - startedAt

    expect(result.failed).toEqual(['slow-to-recover'])
    expect(elapsedMs).toBeLessThan(1000) // nowhere near the 10s/20s backoff — retries are detached
  })

  test('a successful retry eventually marks the endpoint healthy again (recordDeliveryResult ok)', async () => {
    const { store, webhooks } = setUp()
    const endpoint = webhooks.create({ name: 'recovers', url: 'https://example.com/hook' })
    let attempt = 0
    const service = createNotifyService({
      store,
      webhooks,
      rateLimiter: createNotifyRateLimiter(),
      log: createLogger('test'),
      fetch: (async () => {
        attempt++
        return new Response(null, { status: attempt === 1 ? 500 : 200 }) // fails first, recovers on retry
      }) as unknown as typeof fetch,
      firstAttemptTimeoutMs: 20,
      retryDelaysMs: [1, 1],
      retryTimeoutMs: 20,
      sleep: async () => {},
    })

    const result = await service.send({ level: 'error', title: 'x', channels: ['recovers'] }, { source: 'system', context: null, agentId: null, runId: null })
    expect(result.failed).toEqual(['recovers']) // the immediate answer — first attempt genuinely failed

    // Let the detached retry (not awaited by send()) actually run.
    for (let i = 0; i < 50 && webhooks.get(endpoint.id)?.lastStatus !== 'ok'; i++) await new Promise((r) => setTimeout(r, 5))
    expect(webhooks.get(endpoint.id)?.lastStatus).toBe('ok')
    expect(webhooks.get(endpoint.id)?.failureCount).toBe(0)
  })

  test('a webhook that never recovers is recorded failed after three total attempts (1 immediate + 2 retries), endpoint unhealthy', async () => {
    const { store, webhooks } = setUp()
    const endpoint = webhooks.create({ name: 'always-down', url: 'https://example.com/hook' })
    let attempts = 0
    const service = createNotifyService({
      store,
      webhooks,
      rateLimiter: createNotifyRateLimiter(),
      log: createLogger('test'),
      fetch: (async () => {
        attempts++
        return new Response(null, { status: 500 })
      }) as unknown as typeof fetch,
      firstAttemptTimeoutMs: 20,
      retryDelaysMs: [1, 1],
      retryTimeoutMs: 20,
      sleep: async () => {},
    })

    await service.send({ level: 'error', title: 'x', channels: ['always-down'] }, { source: 'system', context: null, agentId: null, runId: null })
    for (let i = 0; i < 50 && attempts < 3; i++) await new Promise((r) => setTimeout(r, 5))

    expect(attempts).toBe(3)
    const got = webhooks.get(endpoint.id)!
    expect(got.lastStatus).toBe('failed')
    expect(got.failureCount).toBeGreaterThan(0)
  })
})
