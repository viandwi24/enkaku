import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { ModelInfo } from '@enkaku/protocol'
import type { CountTokensRequest, ProviderAdapter, TokenCount } from './types'

/**
 * The OpenRouter `ProviderAdapter` (plan 75 §3.3, §4.2, §4.3; plan 76 §3.7
 * removes `stream()` — `harness/run.ts` drives the model itself, through
 * `languageModel()`). What is left:
 *
 * - `listModels()`, unchanged.
 * - No token-counting endpoint, so `countTokens()` always returns
 *   `estimated: true` (plan 75 §4.3). Plan 75 anchored this to a real
 *   `stream()` response's own `usage.inputTokens`; plan 76 removes `stream()`
 *   entirely, and nothing else in this adapter observes a real request's
 *   actual usage any more, so the anchor-refinement half of that scheme is
 *   gone with it — `countTokens()` now only ever accumulates a character-
 *   count estimate over the tail appended since the last call (never the
 *   whole history restringified). Plan 76's `harness/run.ts` does not call
 *   this at all (the compaction threshold there uses the harness's own
 *   `estimateTokens`, per that module's comment) — kept as a public adapter
 *   method for anything else that wants an estimate.
 * - `languageModel()`, unchanged.
 */

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

const PINNED_MODEL_FALLBACK: ModelInfo[] = [
  { id: 'anthropic/claude-opus-5', contextWindow: 200_000, supportsThinking: true },
  { id: 'anthropic/claude-sonnet-5', contextWindow: 200_000, supportsThinking: true },
  { id: 'openai/gpt-5', contextWindow: 128_000, supportsThinking: true },
  { id: 'google/gemini-3-pro', contextWindow: 1_000_000, supportsThinking: false },
]

/** Exported so `agent/provider/index.ts` can serve it, labelled, when a live `listModels()` call fails (criterion 9). */
export function pinnedOpenRouterModelFallback(): ModelInfo[] {
  return PINNED_MODEL_FALLBACK.map((m) => ({ ...m }))
}

export interface OpenRouterAdapterDeps {
  apiKey: string
  baseUrl?: string | null
  /** Injectable for tests — never hits the network when a fake is supplied. */
  fetch?: typeof fetch
}

function openRouterProvider(deps: OpenRouterAdapterDeps) {
  return createOpenRouter({
    apiKey: deps.apiKey,
    ...(deps.baseUrl ? { baseURL: deps.baseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  })
}

export class OpenRouterApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'OpenRouterApiError'
    this.status = status
  }
}

const OpenRouterErrorBodySchema = z.object({
  error: z.object({ message: z.string(), type: z.string().optional(), code: z.union([z.string(), z.number()]).optional() }),
})

async function openRouterFetchJson(deps: OpenRouterAdapterDeps, path: string): Promise<unknown> {
  const fetchImpl = deps.fetch ?? fetch
  const base = deps.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL
  const res = await fetchImpl(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${deps.apiKey}`,
      'content-type': 'application/json',
    },
  })
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const parsed = OpenRouterErrorBodySchema.safeParse(json)
    const message = parsed.success ? parsed.data.error.message : `OpenRouter API responded ${res.status}`
    throw new OpenRouterApiError(res.status, message)
  }
  return json
}

const OpenRouterModelSchema = z.object({
  id: z.string(),
  context_length: z.number().nullish(),
  supported_parameters: z.array(z.string()).nullish(),
})

const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
})

function mapModelInfo(raw: z.infer<typeof OpenRouterModelSchema>): ModelInfo {
  return {
    id: raw.id,
    contextWindow: raw.context_length ?? 128_000,
    supportsThinking: raw.supported_parameters?.includes('reasoning') ?? false,
  }
}

export function createOpenRouterAdapter(deps: OpenRouterAdapterDeps): ProviderAdapter {
  // Plan 75 §4.3's "cached tail estimate": anchored to the real `usage.inputTokens` from the
  // last completed turn (0 until the first one), then bumped by a cheap character-count
  // estimate ONLY over messages appended since — never the whole history restringified.
  let anchorTokens = 0
  let anchoredMessageCount = 0

  function estimateTail(req: CountTokensRequest): number {
    const newMessages = req.messages.slice(anchoredMessageCount)
    let chars = anchoredMessageCount === 0 ? req.systemPrompt.length : 0
    for (const m of newMessages) chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length
    return Math.ceil(chars / 4)
  }

  return {
    async listModels() {
      const json = await openRouterFetchJson(deps, '/models')
      const parsed = OpenRouterModelsResponseSchema.parse(json)
      return parsed.data.map(mapModelInfo)
    },

    async countTokens(req: CountTokensRequest): Promise<TokenCount> {
      const tail = estimateTail(req)
      anchorTokens += tail
      anchoredMessageCount = req.messages.length
      return { tokens: anchorTokens, estimated: true }
    },

    languageModel(modelId: string): LanguageModel {
      return openRouterProvider(deps)(modelId)
    },
  }
}

/** One cheap authenticated call (plan 65 §4.5, extended to OpenRouter by plan 75 criterion 8) — `POST /connectors/:id/test`'s implementation for an `openrouter` connector. */
export async function testOpenRouterConnection(deps: OpenRouterAdapterDeps): Promise<{ status: 'ok' | 'unauthenticated' | 'unreachable'; message: string | null }> {
  try {
    await createOpenRouterAdapter(deps).listModels()
    return { status: 'ok', message: null }
  } catch (err) {
    if (err instanceof OpenRouterApiError) {
      if (err.status === 401 || err.status === 403) return { status: 'unauthenticated', message: err.message }
      return { status: 'unreachable', message: err.message }
    }
    return { status: 'unreachable', message: err instanceof Error ? err.message : String(err) }
  }
}
