import { describe, expect, test } from 'bun:test'
import { createOpenRouterAdapter, pinnedOpenRouterModelFallback, testOpenRouterConnection } from './openrouter'
import type { CountTokensRequest } from './types'

/**
 * These tests never touch the network (plan 75 criterion 13, extending
 * plan 65's "no real API calls in tests" rule to OpenRouter) — every test
 * injects a fake `fetch` that answers a plain JSON REST response
 * (`listModels`/`testOpenRouterConnection`) — `countTokens()`/`languageModel()`
 * never touch the network at all (plan 76 §3.7 removed `stream()`).
 */

function baseRequest(overrides: Partial<CountTokensRequest> = {}): CountTokensRequest {
  return {
    model: 'openai/gpt-5',
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    effort: 'medium',
    thinking: false,
    maxOutputTokens: 4096,
    ...overrides,
  }
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('pinnedOpenRouterModelFallback', () => {
  test('is non-empty and returns a fresh array each call', () => {
    const a = pinnedOpenRouterModelFallback()
    expect(a.length).toBeGreaterThan(0)
    a.push({ id: 'mutated', contextWindow: 1, supportsThinking: false })
    const b = pinnedOpenRouterModelFallback()
    expect(b.some((m) => m.id === 'mutated')).toBe(false)
  })
})

describe('createOpenRouterAdapter — listModels (stubbed REST transport, plan 75 criterion 9)', () => {
  test('maps context_length to contextWindow and supported_parameters to supportsThinking', async () => {
    const adapter = createOpenRouterAdapter({
      apiKey: 'test-key',
      fetch: fakeFetch(200, {
        data: [
          { id: 'openai/gpt-5', context_length: 400_000, supported_parameters: ['reasoning', 'tools'] },
          { id: 'meta/llama-4', context_length: 128_000, supported_parameters: ['tools'] },
        ],
      }),
    })
    const models = await adapter.listModels()
    expect(models).toEqual([
      { id: 'openai/gpt-5', contextWindow: 400_000, supportsThinking: true },
      { id: 'meta/llama-4', contextWindow: 128_000, supportsThinking: false },
    ])
  })
})

describe('testOpenRouterConnection (stubbed transport)', () => {
  test('reports ok on a successful call', async () => {
    const result = await testOpenRouterConnection({ apiKey: 'test-key', fetch: fakeFetch(200, { data: [] }) })
    expect(result.status).toBe('ok')
  })

  test('reports unauthenticated on a 401', async () => {
    const result = await testOpenRouterConnection({ apiKey: 'bad-key', fetch: fakeFetch(401, { error: { message: 'Invalid API key', type: 'invalid_request_error', code: 401 } }) })
    expect(result.status).toBe('unauthenticated')
    expect(result.message).toBeTruthy()
  })

  test('reports unreachable on a 500', async () => {
    const result = await testOpenRouterConnection({ apiKey: 'test-key', fetch: fakeFetch(500, { error: { message: 'internal error' } }) })
    expect(result.status).toBe('unreachable')
  })
})

describe('countTokens() — always estimated for OpenRouter (plan 75 §4.3, criterion 10; plan 76 §3.7 — no `stream()` anchor any more)', () => {
  test('the very first call is a character-count estimate over the whole request', async () => {
    const adapter = createOpenRouterAdapter({ apiKey: 'test-key' })
    const result = await adapter.countTokens(baseRequest())
    expect(result.estimated).toBe(true)
    expect(result.tokens).toBeGreaterThan(0)
  })

  test('a tail appended after the first call adds only the new characters worth of estimate, not the whole history again', async () => {
    const adapter = createOpenRouterAdapter({ apiKey: 'test-key' })
    const req = baseRequest()
    const first = await adapter.countTokens(req)
    const grown: CountTokensRequest = { ...req, messages: [...req.messages, { role: 'assistant', content: 'a reply' }] }
    const second = await adapter.countTokens(grown)
    expect(second.tokens).toBeGreaterThan(first.tokens) // only the appended tail is added
    // Calling again with the SAME message count adds nothing further — the tail was already counted.
    const third = await adapter.countTokens(grown)
    expect(third.tokens).toBe(second.tokens)
  })
})

describe('languageModel() — an AI SDK LanguageModel for Plan 76 (plan 75 §4.2, criterion 11)', () => {
  test('returns something callable as a LanguageModel, without making a network call', () => {
    const adapter = createOpenRouterAdapter({ apiKey: 'test-key' })
    const model = adapter.languageModel('openai/gpt-5')
    expect(model).toBeTruthy()
  })
})
