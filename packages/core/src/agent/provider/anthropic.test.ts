import { describe, expect, test } from 'bun:test'
import { buildAnthropicRequestBody, createAnthropicAdapter, pinnedModelFallback, testAnthropicConnection } from './anthropic'
import type { CountTokensRequest } from './types'

/**
 * These tests never touch the network (plan 65's "no real API calls to
 * Anthropic in tests" constraint) — every test either calls the pure
 * `buildAnthropicRequestBody` directly, or injects a fake `fetch` into
 * `createAnthropicAdapter`/`testAnthropicConnection` that answers from an
 * in-memory fixture.
 */

function baseRequest(overrides: Partial<CountTokensRequest> = {}): CountTokensRequest {
  return {
    model: 'claude-opus-5',
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    effort: 'medium',
    thinking: true,
    maxOutputTokens: 4096,
    ...overrides,
  }
}

describe('buildAnthropicRequestBody', () => {
  test('sends thinking: {type: "adaptive"} when thinking is on, never budget_tokens', () => {
    const body = buildAnthropicRequestBody(baseRequest({ thinking: true }))
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.thinking).not.toHaveProperty('budget_tokens')
    expect(JSON.stringify(body)).not.toContain('budget_tokens')
  })

  test('sends thinking: {type: "disabled"} when thinking is off — still never budget_tokens', () => {
    const body = buildAnthropicRequestBody(baseRequest({ thinking: false }))
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(JSON.stringify(body)).not.toContain('budget_tokens')
  })

  test('effort is output_config.effort, not a token budget', () => {
    const body = buildAnthropicRequestBody(baseRequest({ effort: 'high' }))
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  test('always streams', () => {
    const body = buildAnthropicRequestBody(baseRequest())
    expect(body.stream).toBe(true)
  })

  test('fallbacks is the literal string "default"', () => {
    const body = buildAnthropicRequestBody(baseRequest())
    expect(body.fallbacks).toBe('default')
  })

  test('the cache breakpoint lands on the LAST tool definition, not the first or none', () => {
    const body = buildAnthropicRequestBody(
      baseRequest({
        tools: [
          { name: 'device.tap', description: 'Tap a point.', inputSchema: { type: 'object' } },
          { name: 'device.find', description: 'Find an element.', inputSchema: { type: 'object' } },
          { name: 'fs.read', description: 'Read a file.', inputSchema: { type: 'object' } },
        ],
      }),
    )
    expect(body.tools).toHaveLength(3)
    expect(body.tools[0]?.cache_control).toBeUndefined()
    expect(body.tools[1]?.cache_control).toBeUndefined()
    expect(body.tools[2]?.cache_control).toEqual({ type: 'ephemeral' })
    // The system prompt carries no breakpoint of its own once tools exist — one shared prefix.
    expect(body.system[0]?.cache_control).toBeUndefined()
  })

  test('tool order is preserved exactly as given — never reordered or re-sorted', () => {
    const body = buildAnthropicRequestBody(
      baseRequest({
        tools: [
          { name: 'z.last', description: 'z', inputSchema: {} },
          { name: 'a.first', description: 'a', inputSchema: {} },
        ],
      }),
    )
    expect(body.tools.map((t) => t.name)).toEqual(['z.last', 'a.first'])
  })

  test('with no tools, the cache breakpoint falls back to the system block', () => {
    const body = buildAnthropicRequestBody(baseRequest({ tools: [] }))
    expect(body.tools).toHaveLength(0)
    expect(body.system[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('the system prompt is the stable prefix — no time-varying content is added by the builder', () => {
    const prompt = 'You are a fixed, static system prompt with no timestamp.'
    const body = buildAnthropicRequestBody(
      baseRequest({
        systemPrompt: prompt,
        tools: [{ name: 'device.tap', description: 'Tap a point.', inputSchema: { type: 'object' } }],
      }),
    )
    expect(body.system).toEqual([{ type: 'text', text: prompt }])
  })
})

describe('pinnedModelFallback', () => {
  test('is non-empty and includes the default model', () => {
    const models = pinnedModelFallback()
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === 'claude-opus-5')).toBe(true)
  })

  test('returns a fresh array each call (a caller mutating it cannot corrupt the pinned list)', () => {
    const a = pinnedModelFallback()
    a.push({ id: 'mutated', contextWindow: 1, supportsThinking: false })
    const b = pinnedModelFallback()
    expect(b.some((m) => m.id === 'mutated')).toBe(false)
  })
})

/** A fake `fetch` answering a fixed status/JSON body — never touches the network. Cast through `unknown` because Bun's `typeof fetch` also carries a `preconnect` static this stub does not need. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('createAnthropicAdapter — listModels (stubbed transport)', () => {
  test('parses a live models page into ModelInfo[]', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'test-key',
      fetch: fakeFetch(200, {
        data: [
          {
            id: 'claude-opus-5',
            type: 'model',
            display_name: 'Claude Opus 5',
            created_at: '2026-01-01T00:00:00Z',
            max_input_tokens: 500_000,
            max_tokens: 64_000,
            capabilities: { thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } } },
          },
          {
            id: 'claude-haiku-4-5',
            type: 'model',
            display_name: 'Claude Haiku 4.5',
            created_at: '2025-01-01T00:00:00Z',
            max_input_tokens: 200_000,
            max_tokens: 8_192,
            capabilities: null,
          },
        ],
        has_more: false,
        first_id: 'claude-opus-5',
        last_id: 'claude-haiku-4-5',
      }),
    })
    const models = await adapter.listModels()
    expect(models).toEqual([
      { id: 'claude-opus-5', contextWindow: 500_000, supportsThinking: true },
      { id: 'claude-haiku-4-5', contextWindow: 200_000, supportsThinking: false },
    ])
  })
})

describe('testAnthropicConnection (stubbed transport)', () => {
  test('reports ok on a successful call', async () => {
    const result = await testAnthropicConnection({
      apiKey: 'test-key',
      fetch: fakeFetch(200, { data: [], has_more: false, first_id: null, last_id: null }),
    })
    expect(result.status).toBe('ok')
  })

  test('reports unauthenticated on a 401', async () => {
    const result = await testAnthropicConnection({
      apiKey: 'bad-key',
      fetch: fakeFetch(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    })
    expect(result.status).toBe('unauthenticated')
    expect(result.message).toBeTruthy()
  })

  test('reports unreachable on a 500', async () => {
    const result = await testAnthropicConnection({
      apiKey: 'test-key',
      fetch: fakeFetch(500, { type: 'error', error: { type: 'api_error', message: 'internal server error' } }),
    })
    expect(result.status).toBe('unreachable')
  })
})


describe('countTokens() — exact, never estimated, for Anthropic (plan 75 §4.3, criterion 10)', () => {
  test('returns {tokens, estimated: false} from the count_tokens endpoint', async () => {
    const fetchImpl = fakeFetch(200, { input_tokens: 1234 })
    const adapter = createAnthropicAdapter({ apiKey: 'test-key', fetch: fetchImpl })
    const result = await adapter.countTokens(baseRequest())
    expect(result).toEqual({ tokens: 1234, estimated: false })
  })
})

describe('languageModel() — an AI SDK LanguageModel for Plan 76 (plan 75 §4.2, criterion 11)', () => {
  test('returns something callable as a LanguageModel, without making a network call', () => {
    const adapter = createAnthropicAdapter({ apiKey: 'test-key' })
    const model = adapter.languageModel('claude-opus-5')
    expect(model).toBeTruthy()
  })
})
