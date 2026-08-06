import type { ConnectorKind, ModelInfo } from '@enkaku/protocol'
import { EnkakuError } from '../../util/errors'
import { createAnthropicAdapter, pinnedModelFallback, testAnthropicConnection } from './anthropic'
import { createOpenRouterAdapter, pinnedOpenRouterModelFallback, testOpenRouterConnection } from './openrouter'
import type { ProviderAdapter } from './types'

export * from './types'
export { buildAnthropicRequestBody, createAnthropicAdapter, pinnedModelFallback, testAnthropicConnection } from './anthropic'
export type { AnthropicRequestBody } from './anthropic'
export { createOpenRouterAdapter, pinnedOpenRouterModelFallback, testOpenRouterConnection } from './openrouter'

export interface ProviderConnectionDeps {
  apiKey: string
  baseUrl?: string | null
  fetch?: typeof fetch
}

/** The one place a connector `kind` picks its `ProviderAdapter` (plan 65 §3.3, plan 75 §4.2) — `anthropic` and `openrouter` are the two implementations this plan ships; a third `kind` is a new `case`, never a change to this function's callers. */
export function createProviderAdapter(kind: ConnectorKind, deps: ProviderConnectionDeps): ProviderAdapter {
  if (kind === 'anthropic') return createAnthropicAdapter(deps)
  if (kind === 'openrouter') return createOpenRouterAdapter(deps)
  throw new EnkakuError('E_UNKNOWN_PROVIDER', `no provider adapter for connector kind "${kind}"`)
}

export function testProviderConnection(kind: ConnectorKind, deps: ProviderConnectionDeps): Promise<{ status: 'ok' | 'unauthenticated' | 'unreachable'; message: string | null }> {
  if (kind === 'anthropic') return testAnthropicConnection(deps)
  if (kind === 'openrouter') return testOpenRouterConnection(deps)
  throw new EnkakuError('E_UNKNOWN_PROVIDER', `no provider adapter for connector kind "${kind}"`)
}

export function pinnedModelFallbackFor(kind: ConnectorKind): ModelInfo[] {
  if (kind === 'anthropic') return pinnedModelFallback()
  if (kind === 'openrouter') return pinnedOpenRouterModelFallback()
  return []
}

const MODEL_CACHE_TTL_MS = 5 * 60_000

interface CacheEntry {
  models: ModelInfo[]
  expiresAt: number
}

/**
 * A TTL cache over `listModels()`, keyed per connector (plan 65 §3.2: "the
 * list is cached with a TTL and falls back to a small pinned list when the
 * call fails"). One instance lives for the process (`agent/index.ts` builds
 * it once, like every other in-memory cache in this codebase). `now` is
 * injectable purely so a test can exercise TTL expiry without a real
 * 5-minute sleep — production callers never pass it.
 */
export function createModelListCache(now: () => number = Date.now) {
  const cache = new Map<string, CacheEntry>()

  async function get(connectorId: string, kind: ConnectorKind, deps: ProviderConnectionDeps): Promise<{ models: ModelInfo[]; fallback: boolean }> {
    const cached = cache.get(connectorId)
    if (cached && cached.expiresAt > now()) {
      return { models: cached.models, fallback: false }
    }
    try {
      const adapter = createProviderAdapter(kind, deps)
      const models = await adapter.listModels()
      cache.set(connectorId, { models, expiresAt: now() + MODEL_CACHE_TTL_MS })
      return { models, fallback: false }
    } catch {
      // A stale cache entry is still better than the pinned list — only
      // fall all the way back when there is nothing cached at all.
      if (cached) return { models: cached.models, fallback: false }
      return { models: pinnedModelFallbackFor(kind), fallback: true }
    }
  }

  function invalidate(connectorId: string): void {
    cache.delete(connectorId)
  }

  return { get, invalidate }
}

export type ModelListCache = ReturnType<typeof createModelListCache>
