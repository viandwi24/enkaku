import type { LanguageModel, ModelMessage } from 'ai'
import type { Effort, ModelInfo } from '@enkaku/protocol'

/**
 * `ProviderAdapter` — the seam Plan 65 §3.3, §4.3 describes. Plan 75 put
 * Anthropic and OpenRouter on the Vercel AI SDK. Plan 76 removes the whole
 * hand-rolled streaming surface (`stream()`, `ProviderEvent`, `ProviderRequest`
 * — criterion 13): the harness's `runAgentLoop` drives a model directly
 * through `languageModel()`'s `LanguageModel`, so nothing in this package
 * translates a provider's stream into Enkaku's own event union any more.
 *
 * What is LEFT is exactly what the AI SDK does not provide on its own:
 * listing models, counting tokens (Anthropic has a real endpoint; OpenRouter
 * estimates), and handing out a `LanguageModel` for a given model id.
 */

export type { ModelInfo }

export interface ProviderToolDef {
  name: string
  description: string
  /** JSON Schema, exactly what `@enkaku/protocol`'s `toJsonSchema` produces for a capability's `input`. */
  inputSchema: unknown
}

/**
 * `countTokens()`'s input (plan 76 §3.7) — replaces the old `ProviderRequest`
 * (which carried Enkaku's own `ProviderMessage[]`, gone with `stream()`).
 * `messages` is the AI SDK's own `ModelMessage[]` — the same shape
 * `harness/messages.ts` builds for `runAgentLoop` — since nothing downstream
 * of storage speaks a provider-agnostic message shape any more.
 */
export interface CountTokensRequest {
  model: string
  systemPrompt: string
  messages: ModelMessage[]
  /** In a FIXED order (the registry's own order — never `Map` insertion order). */
  tools: ProviderToolDef[]
  effort: Effort
  thinking: boolean
  maxOutputTokens: number
}

/**
 * A token count (plan 75 §4.3). Anthropic has a real `count_tokens`
 * endpoint — `estimated: false`. OpenRouter has none, so its adapter
 * estimates from the previous response's own `usage` plus a character
 * count over the appended tail — `estimated: true`.
 */
export interface TokenCount {
  tokens: number
  estimated: boolean
}

export interface ProviderAdapter {
  listModels(): Promise<ModelInfo[]>
  countTokens(req: CountTokensRequest): Promise<TokenCount>
  /** The AI SDK `LanguageModel` for a given model id (plan 75 §4.2) — what `harness/run.ts` hands
   * straight to `runAgentLoop`. */
  languageModel(modelId: string): LanguageModel
}
