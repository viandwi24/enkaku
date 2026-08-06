import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel, ModelMessage } from 'ai'
import { z } from 'zod'
import type { Effort, ModelInfo } from '@enkaku/protocol'
import { EnkakuError } from '../../util/errors'
import type { CountTokensRequest, ProviderAdapter, ProviderToolDef, TokenCount } from './types'

/**
 * The Anthropic `ProviderAdapter` — plan 65 §3.3, §4.3 first shipped this on
 * the direct `@anthropic-ai/sdk`; plan 75 §3.3, §4.2 moved it onto the
 * Vercel AI SDK (`@ai-sdk/anthropic`); plan 76 §3.7 removes `stream()`
 * entirely (criterion 13) — `harness/run.ts` drives the model itself,
 * through `languageModel()`. All that is left here is `listModels()`,
 * `countTokens()` (Anthropic's own REST endpoint, no AI SDK equivalent),
 * and `languageModel()`.
 *
 * No file in this package imports `@anthropic-ai/sdk` (plan 75 criterion 4)
 * — not even for types, which is why the request-shape types below
 * (`AnthropicTextBlock` etc.) are hand-rolled rather than imported.
 */

const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'

const PINNED_MODEL_FALLBACK: ModelInfo[] = [
  { id: 'claude-opus-5', contextWindow: 200_000, supportsThinking: true },
  { id: 'claude-sonnet-5', contextWindow: 200_000, supportsThinking: true },
  { id: 'claude-haiku-4-5', contextWindow: 200_000, supportsThinking: true },
]

/** Exported so `agent/provider/index.ts` can serve it, labelled, when a live `listModels()` call fails (criterion 9). */
export function pinnedModelFallback(): ModelInfo[] {
  return PINNED_MODEL_FALLBACK.map((m) => ({ ...m }))
}

// ---------------------------------------------------------------------------
// The raw Anthropic Messages API request shape — hand-rolled (never imported
// from `@anthropic-ai/sdk`, criterion 4). `buildAnthropicRequestBody` is a
// plain, independently-testable object builder that never touches the
// network: `countTokens()` is its only caller.
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

interface AnthropicImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: (AnthropicTextBlock | AnthropicImageBlock)[]
  is_error?: boolean
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock

interface AnthropicMessageParam {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicToolDef {
  name: string
  description: string
  input_schema: unknown
  cache_control?: { type: 'ephemeral' }
}

type AnthropicThinkingConfig = { type: 'adaptive' } | { type: 'enabled'; budget_tokens?: number } | { type: 'disabled' }

export interface AnthropicRequestBody {
  model: string
  max_tokens: number
  system: AnthropicTextBlock[]
  messages: AnthropicMessageParam[]
  tools: AnthropicToolDef[]
  thinking: AnthropicThinkingConfig
  output_config: { effort: Effort }
  fallbacks: 'default'
  stream: true
}

/** A loosely-typed view of an AI SDK `ModelMessage` content part — the AI SDK does not export a
 * single named union for "any content part of any role", so this file reads the fields it needs
 * defensively rather than importing five separate part types. */
interface AiSdkContentPart {
  type?: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  data?: { type?: string; data?: string }
  mediaType?: string
}

/** A tool result's `output` (the AI SDK's `ToolResultOutput` discriminated union) → Anthropic's own
 * `tool_result.content` shape. `harness/messages.ts` only ever produces `'text'`/`'error-text'`/
 * `'content'` (never `'json'`/`'error-json'`), but all four are handled defensively. */
function toAnthropicToolResultContent(output: unknown): (AnthropicTextBlock | AnthropicImageBlock)[] {
  const o = output as { type?: string; value?: unknown } | undefined
  if (!o || typeof o !== 'object') return [{ type: 'text', text: JSON.stringify(output) }]
  if (o.type === 'text' || o.type === 'error-text') return [{ type: 'text', text: String(o.value ?? '') }]
  if (o.type === 'json' || o.type === 'error-json') return [{ type: 'text', text: JSON.stringify(o.value) }]
  if (o.type === 'content' && Array.isArray(o.value)) {
    return (o.value as AiSdkContentPart[]).map((part) =>
      part.type === 'text'
        ? { type: 'text' as const, text: part.text ?? '' }
        : { type: 'image' as const, source: { type: 'base64' as const, media_type: part.mediaType ?? 'application/octet-stream', data: part.data?.data ?? '' } },
    )
  }
  return [{ type: 'text', text: JSON.stringify(output) }]
}

function isErrorOutput(output: unknown): boolean {
  const o = output as { type?: string } | undefined
  return o?.type === 'error-text' || o?.type === 'error-json'
}

/** A resolved `file` content part → Anthropic's own image shape (plan 70 §4.5). Only ever called on
 * a block whose bytes were already resolved (`harness/messages.ts`'s `toModelMessages`) — an
 * unresolved reference reaching here is a bug in the assembly step. */
function toAnthropicImageFromFilePart(part: AiSdkContentPart): AnthropicImageBlock {
  const data = part.data?.data
  if (typeof data !== 'string') {
    throw new Error('an image block reached the Anthropic adapter unresolved — resolveBlob must run before a request is counted')
  }
  return { type: 'image', source: { type: 'base64', media_type: part.mediaType ?? 'application/octet-stream', data } }
}

function toAnthropicMessage(m: ModelMessage): AnthropicMessageParam {
  if (m.role === 'tool') {
    const parts = (Array.isArray(m.content) ? m.content : []) as AiSdkContentPart[]
    return {
      role: 'user',
      content: parts.map((part) => ({
        type: 'tool_result' as const,
        tool_use_id: part.toolCallId ?? '',
        content: toAnthropicToolResultContent(part.output),
        ...(isErrorOutput(part.output) ? { is_error: true as const } : {}),
      })),
    }
  }
  if (m.role === 'assistant') {
    if (typeof m.content === 'string') return { role: 'assistant', content: m.content }
    const blocks: AnthropicContentBlock[] = []
    for (const p of m.content as AiSdkContentPart[]) {
      if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text })
      else if (p.type === 'tool-call') blocks.push({ type: 'tool_use', id: p.toolCallId ?? '', name: p.toolName ?? '', input: p.input })
      else if (p.type === 'file') blocks.push(toAnthropicImageFromFilePart(p))
      // 'reasoning' — dropped (display only, never replayed).
    }
    return { role: 'assistant', content: blocks }
  }
  // 'user' (or 'system', which `harness/messages.ts`/callers never hand this function)
  if (typeof m.content === 'string') return { role: 'user', content: m.content }
  const blocks: (AnthropicTextBlock | AnthropicImageBlock)[] = []
  for (const p of m.content as AiSdkContentPart[]) {
    if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text })
    else if (p.type === 'file') blocks.push(toAnthropicImageFromFilePart(p))
  }
  return { role: 'user', content: blocks }
}

function toAnthropicTool(t: ProviderToolDef): AnthropicToolDef {
  return { name: t.name, description: t.description, input_schema: t.inputSchema }
}

/**
 * Builds the request body. The stable prefix is system prompt, then tool
 * definitions, then conversation (plan 65 §3.4) — the cache breakpoint goes
 * AFTER the tool definitions, so it is placed on the LAST tool's
 * `cache_control` when there are tools, or on the system block itself when
 * there are none.
 */
export function buildAnthropicRequestBody(req: CountTokensRequest): AnthropicRequestBody {
  const tools = req.tools.map(toAnthropicTool)
  const lastTool = tools[tools.length - 1]
  if (lastTool) {
    lastTool.cache_control = { type: 'ephemeral' }
  }
  const systemBlock: AnthropicTextBlock = { type: 'text', text: req.systemPrompt }
  if (tools.length === 0) {
    systemBlock.cache_control = { type: 'ephemeral' }
  }

  return {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    system: [systemBlock],
    messages: req.messages.map(toAnthropicMessage),
    tools,
    // NEVER `{ type: 'enabled', budget_tokens: N }` — rejected with a 400 on Opus 5.
    thinking: { type: req.thinking ? 'adaptive' : 'disabled' },
    output_config: { effort: req.effort },
    fallbacks: 'default',
    stream: true,
  }
}

// ---------------------------------------------------------------------------
// The AI SDK path — `languageModel()` (plan 75 §3.3, §4.2; plan 76 removes
// the `stream()` half — `harness/run.ts` calls `streamText` itself now).
// ---------------------------------------------------------------------------

export interface AnthropicAdapterDeps {
  apiKey: string
  baseUrl?: string | null
  /** Injectable for tests — never hits the network when a fake is supplied. */
  fetch?: typeof fetch
}

function anthropicProvider(deps: AnthropicAdapterDeps) {
  return createAnthropic({
    apiKey: deps.apiKey,
    ...(deps.baseUrl ? { baseURL: deps.baseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  })
}

// ---------------------------------------------------------------------------
// Raw REST calls — `listModels()` and `countTokens()` have no AI SDK
// equivalent, so these talk to Anthropic's REST endpoints directly. Never
// `@anthropic-ai/sdk` (criterion 4); external JSON is Zod-parsed, never cast.
// ---------------------------------------------------------------------------

export class AnthropicApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AnthropicApiError'
    this.status = status
  }
}

const AnthropicErrorBodySchema = z.object({
  error: z.object({ type: z.string().optional(), message: z.string() }),
})

async function anthropicFetchJson(deps: AnthropicAdapterDeps, path: string, init: { method?: string; body?: unknown; extraHeaders?: Record<string, string> } = {}): Promise<unknown> {
  const fetchImpl = deps.fetch ?? fetch
  const base = deps.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL
  const res = await fetchImpl(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'x-api-key': deps.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...init.extraHeaders,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const parsed = AnthropicErrorBodySchema.safeParse(json)
    const message = parsed.success ? parsed.data.error.message : `Anthropic API responded ${res.status}`
    throw new AnthropicApiError(res.status, message)
  }
  return json
}

const AnthropicModelSchema = z.object({
  id: z.string(),
  max_input_tokens: z.number().nullish(),
  capabilities: z
    .object({
      thinking: z
        .object({
          types: z
            .object({
              adaptive: z.object({ supported: z.boolean() }).nullish(),
              enabled: z.object({ supported: z.boolean() }).nullish(),
            })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
})

const AnthropicModelsPageSchema = z.object({
  data: z.array(AnthropicModelSchema),
  has_more: z.boolean(),
  last_id: z.string().nullish(),
})

function mapModelInfo(raw: z.infer<typeof AnthropicModelSchema>): ModelInfo {
  const thinkingTypes = raw.capabilities?.thinking?.types
  const supportsThinking = Boolean(thinkingTypes?.adaptive?.supported || thinkingTypes?.enabled?.supported)
  return {
    id: raw.id,
    contextWindow: raw.max_input_tokens ?? 200_000,
    supportsThinking,
  }
}

const AnthropicCountTokensResponseSchema = z.object({ input_tokens: z.number() })

export function createAnthropicAdapter(deps: AnthropicAdapterDeps): ProviderAdapter {
  return {
    async listModels() {
      const models: ModelInfo[] = []
      let afterId: string | undefined
      for (;;) {
        const query = `limit=100${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`
        const json = await anthropicFetchJson(deps, `/v1/models?${query}`)
        const page = AnthropicModelsPageSchema.parse(json)
        for (const item of page.data) models.push(mapModelInfo(item))
        if (!page.has_more || !page.last_id) break
        afterId = page.last_id
      }
      return models
    },

    async countTokens(req: CountTokensRequest): Promise<TokenCount> {
      const body = buildAnthropicRequestBody(req)
      const json = await anthropicFetchJson(deps, '/v1/messages/count_tokens?beta=true', {
        method: 'POST',
        body: { model: body.model, system: body.system, messages: body.messages, tools: body.tools, thinking: body.thinking },
        extraHeaders: { 'anthropic-beta': 'token-counting-2024-11-01' },
      })
      const parsed = AnthropicCountTokensResponseSchema.parse(json)
      return { tokens: parsed.input_tokens, estimated: false }
    },

    languageModel(modelId: string): LanguageModel {
      return anthropicProvider(deps)(modelId)
    },
  }
}

/** One cheap authenticated call (plan 65 §4.5) — `POST /connectors/:id/test`'s implementation. */
export async function testAnthropicConnection(deps: AnthropicAdapterDeps): Promise<{ status: 'ok' | 'unauthenticated' | 'unreachable'; message: string | null }> {
  try {
    await createAnthropicAdapter(deps).listModels()
    return { status: 'ok', message: null }
  } catch (err) {
    if (err instanceof AnthropicApiError) {
      if (err.status === 401 || err.status === 403) return { status: 'unauthenticated', message: err.message }
      return { status: 'unreachable', message: err.message }
    }
    return { status: 'unreachable', message: err instanceof Error ? err.message : String(err) }
  }
}

export function assertApiKey(apiKey: string | null): string {
  if (!apiKey) throw new EnkakuError('E_NO_CREDENTIAL', 'this connector has no stored credential and ENKAKU_ANTHROPIC_API_KEY is not set')
  return apiKey
}
