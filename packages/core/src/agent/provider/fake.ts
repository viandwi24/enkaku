import type { LanguageModel } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { ModelInfo } from '@enkaku/protocol'
import type { CountTokensRequest, ProviderAdapter, TokenCount } from './types'

/**
 * A scripted `ProviderAdapter` for tests (plan 66 §7's "scripted fake
 * provider" — no key is available, and no test anywhere may make a real
 * Anthropic API call). Plan 76 §3.7 rewrites this: `languageModel()` now
 * returns a real AI SDK `LanguageModel` (`ai/test`'s `MockLanguageModelV3`)
 * driven by the SAME scripted-turn shape the old `ProviderEvent`-based fake
 * used (`FakeModelEvent` — deliberately structurally identical, so most
 * existing test scripts only need an import/type-name change, not a
 * rewrite) — `harness/run.ts` calls `provider.languageModel(...)` and hands
 * it straight to the harness's `runAgentLoop`, exactly like the real
 * adapters, so a scripted turn goes through the SAME `streamText()` +
 * `runAgentLoop` machinery the production path uses.
 *
 * Each `languageModel()`/`doStream()` call consumes the next turn from
 * `turns`; a turn is either a fixed event array or a function of the call
 * index, so a test can script conditional behaviour (e.g. "loop forever
 * until cancelled").
 */
export type FakeModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  /** `raw` is handed straight to `harness/errors.ts`'s `classifyError`, which duck-types the OLD
   * `{status,type}` shape directly — no translation layer needed for a fake. */
  | { type: 'error'; message: string; raw?: { status?: number; type?: string; message?: string } }
  | { type: 'done' }

/** The function form receives the raw AI SDK call options for THIS attempt — in particular
 * `options.prompt` (the converted message history so far), which lets a scripted turn read what
 * happened earlier (e.g. a prior tool_result's content) the same way the old `req: ProviderRequest`
 * parameter did, just in the AI SDK's own `LanguageModelV3Prompt` shape rather than Enkaku's. */
export type FakeProviderTurn = FakeModelEvent[] | ((callIndex: number, options: LanguageModelV3CallOptions) => FakeModelEvent[])

export interface FakeProviderDeps {
  turns: FakeProviderTurn[]
  models?: ModelInfo[]
  /** Reports every `countTokens()` call. */
  onRequest?: (req: CountTokensRequest, kind: 'countTokens') => void
  /** A fixed or scripted token estimate for `.countTokens()` — defaults to a cheap deterministic heuristic. */
  countTokensImpl?: (req: CountTokensRequest) => number
}

function buildStreamParts(events: FakeModelEvent[]): { parts: LanguageModelV3StreamPart[]; error: unknown | null } {
  const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }]
  let textOpen = false
  let reasoningOpen = false
  let sawToolCall = false
  let error: unknown | null = null
  let usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  }

  for (const e of events) {
    if (e.type === 'text_delta') {
      if (!textOpen) {
        parts.push({ type: 'text-start', id: 't1' })
        textOpen = true
      }
      parts.push({ type: 'text-delta', id: 't1', delta: e.text })
    } else if (e.type === 'thinking_delta') {
      if (!reasoningOpen) {
        parts.push({ type: 'reasoning-start', id: 'r1' })
        reasoningOpen = true
      }
      parts.push({ type: 'reasoning-delta', id: 'r1', delta: e.text })
    } else if (e.type === 'tool_call') {
      if (textOpen) {
        parts.push({ type: 'text-end', id: 't1' })
        textOpen = false
      }
      sawToolCall = true
      parts.push({ type: 'tool-call', toolCallId: e.id, toolName: e.name, input: JSON.stringify(e.input ?? {}) })
    } else if (e.type === 'usage') {
      usage = {
        inputTokens: { total: e.inputTokens, noCache: Math.max(0, e.inputTokens - e.cacheReadTokens - e.cacheWriteTokens), cacheRead: e.cacheReadTokens, cacheWrite: e.cacheWriteTokens },
        outputTokens: { total: e.outputTokens, text: e.outputTokens, reasoning: 0 },
      }
    } else if (e.type === 'error') {
      error = e.raw ?? { message: e.message }
    }
    // 'done' — no explicit part; the stream simply ends.
  }
  if (textOpen) parts.push({ type: 'text-end', id: 't1' })
  if (reasoningOpen) parts.push({ type: 'reasoning-end', id: 'r1' })
  if (!error) {
    parts.push({ type: 'finish', usage, finishReason: { unified: sawToolCall ? 'tool-calls' : 'stop', raw: undefined } })
  }
  return { parts, error }
}

export function createFakeProvider(deps: FakeProviderDeps): ProviderAdapter & { callCount(): number; allCallOptions(): LanguageModelV3CallOptions[] } {
  let calls = 0
  const allCallOptions: LanguageModelV3CallOptions[] = []

  async function doStream(options: LanguageModelV3CallOptions) {
    allCallOptions.push(options)
    const index = calls
    calls += 1
    const turn = deps.turns[index]
    if (!turn) {
      // Running out of script is a test-authoring bug, not a silent success —
      // fail loudly rather than hanging or returning an empty, believable stream.
      throw new Error(`fake provider: no scripted turn for call #${index} (only ${deps.turns.length} scripted)`)
    }
    const events = typeof turn === 'function' ? turn(index, options) : turn
    const { parts, error } = buildStreamParts(events)
    if (error) {
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.error(error)
          },
        }),
      }
    }
    return { stream: convertArrayToReadableStream(parts) }
  }

  return {
    async listModels() {
      return deps.models ?? [{ id: 'fake-model', contextWindow: 200_000, supportsThinking: true }]
    },

    async countTokens(req: CountTokensRequest) {
      deps.onRequest?.(req, 'countTokens')
      if (deps.countTokensImpl) return { tokens: await deps.countTokensImpl(req), estimated: false }
      const text = req.systemPrompt + req.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('')
      return { tokens: Math.ceil(text.length / 4), estimated: false }
    },

    languageModel(modelId: string): LanguageModel {
      return new MockLanguageModelV3({ modelId, provider: 'fake', doStream }) as unknown as LanguageModel
    },

    callCount: () => calls,
    allCallOptions: () => allCallOptions,
  } satisfies ProviderAdapter & { callCount(): number; allCallOptions(): LanguageModelV3CallOptions[] }
}

export type { TokenCount }
