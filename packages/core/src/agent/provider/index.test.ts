import { describe, expect, test } from 'bun:test'
import { createModelListCache } from './index'

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

const okModelsPage = { data: [{ id: 'claude-opus-5', type: 'model', display_name: 'Opus 5', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 300_000, max_tokens: 64_000, capabilities: null }], has_more: false, first_id: 'claude-opus-5', last_id: 'claude-opus-5' }

describe('createModelListCache', () => {
  test('a live call populates the cache and is served again without a second call', async () => {
    let calls = 0
    const fetchSpy: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1
      return fakeFetch(200, okModelsPage)(...args)
    }) as unknown as typeof fetch

    const cache = createModelListCache()
    const first = await cache.get('conn-1', 'anthropic', { apiKey: 'k', fetch: fetchSpy })
    expect(first.fallback).toBe(false)
    expect(first.models[0]?.id).toBe('claude-opus-5')
    expect(calls).toBe(1)

    const second = await cache.get('conn-1', 'anthropic', { apiKey: 'k', fetch: fetchSpy })
    expect(second.models).toEqual(first.models)
    expect(calls).toBe(1) // served from cache, no second network call
  })

  test('falls back to the pinned list, labelled, when the live call fails and nothing is cached', async () => {
    const cache = createModelListCache()
    const result = await cache.get('conn-2', 'anthropic', { apiKey: 'k', fetch: fakeFetch(500, { type: 'error', error: { type: 'api_error', message: 'boom' } }) })
    expect(result.fallback).toBe(true)
    expect(result.models.length).toBeGreaterThan(0)
  })

  test('two connectors cache independently', async () => {
    const cache = createModelListCache()
    await cache.get('conn-a', 'anthropic', { apiKey: 'k', fetch: fakeFetch(200, okModelsPage) })
    const fallback = await cache.get('conn-b', 'anthropic', { apiKey: 'k', fetch: fakeFetch(500, {}) })
    expect(fallback.fallback).toBe(true)
  })

  test('cache expiry: after the TTL elapses, the next call hits the provider again', async () => {
    let calls = 0
    let clock = 0
    const fetchSpy: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1
      return fakeFetch(200, okModelsPage)(...args)
    }) as unknown as typeof fetch
    const cache = createModelListCache(() => clock)

    await cache.get('conn-1', 'anthropic', { apiKey: 'k', fetch: fetchSpy })
    expect(calls).toBe(1)

    // Still within the TTL — served from cache.
    clock += 60_000
    await cache.get('conn-1', 'anthropic', { apiKey: 'k', fetch: fetchSpy })
    expect(calls).toBe(1)

    // Past the 5-minute TTL — a fresh call is made.
    clock += 5 * 60_000 + 1
    await cache.get('conn-1', 'anthropic', { apiKey: 'k', fetch: fetchSpy })
    expect(calls).toBe(2)
  })

  test('invalidate() forces the next call to hit the provider again', async () => {
    let calls = 0
    const fetchSpy: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1
      return fakeFetch(200, okModelsPage)(...args)
    }) as unknown as typeof fetch
    const cache = createModelListCache()
    await cache.get('conn-1', 'anthropic', { apiKey: 'k', fetch: fetchSpy })
    cache.invalidate('conn-1')
    await cache.get('conn-1', 'anthropic', { apiKey: 'k', fetch: fetchSpy })
    expect(calls).toBe(2)
  })
})
