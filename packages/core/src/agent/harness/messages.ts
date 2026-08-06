import type { ModelMessage } from 'ai'
import type { AgentContentBlock, AgentImageRef, AgentMessage, ToolResultContent } from '@enkaku/protocol'

/**
 * Stored rows ↔ `ModelMessage[]` (plan 76 §3.4, §4.1) — the harness works in
 * the AI SDK's own message shape; Enkaku persists `agent_messages` rows with
 * its own content blocks (plan 66 §4.1, plan 70 §4.2). The stored rows stay
 * the source of truth; `ModelMessage[]` is the wire built from them for each
 * request. This module replaces `agent/loop/run.ts`'s old `toProviderMessages`
 * PLUS `agent/provider/message-mapping.ts`'s `toAiSdkMessages` PLUS
 * `agent/loop/request.ts`'s `resolveImagesForRequest` — those three used to
 * be three steps (stored → `ProviderMessage[]` → resolved `ProviderMessage[]`
 * → AI SDK `ModelMessage[]`) because a provider-agnostic intermediate shape
 * sat between storage and the wire; now that the wire IS the AI SDK shape,
 * one function does the whole job.
 *
 * `system`-role messages (operational notes — a cancellation record) are
 * NEVER sent to the provider; `thinking` blocks are dropped for the same
 * reason as before (display only, never replayed).
 */

/** Resolves a blob id to base64 bytes at request-assembly time (plan 70 §4.4, §4.5) — the ONLY place
 * base64 is ever materialised; it is never stored. Null when the blob no longer exists. */
export type ResolveBlob = (blobId: string) => { mediaType: string; data: string } | null

export interface ToModelMessagesOptions {
  /** Omitted when the run carries no images at all (nothing to resolve). */
  resolveBlob?: ResolveBlob
  maxImagesPerRequest?: number
}

type FileContentPart = { type: 'file'; data: { type: 'data'; data: string }; mediaType: string }
type PlaceholderPart = { type: 'text'; text: string }

/** A dropped image's stand-in (plan 70 §3.6) — states plainly that a picture existed and what it
 * was, so the model never silently loses the fact. */
function imagePlaceholder(b: AgentImageRef): string {
  const size = b.width && b.height ? `, ${b.width}×${b.height}` : ''
  return `[image dropped from context — ${b.mediaType}${size}, over the per-request image budget]`
}

function resolveOrDrop(b: AgentImageRef, resolveBlob: ResolveBlob, keep: boolean): FileContentPart | PlaceholderPart {
  if (!keep) return { type: 'text', text: imagePlaceholder(b) }
  const resolved = resolveBlob(b.blobId)
  if (!resolved) return { type: 'text', text: `[image no longer available — ${b.mediaType}]` }
  return { type: 'file', data: { type: 'data', data: resolved.data }, mediaType: resolved.mediaType }
}

/** Counts every image block across the whole window, in order — oldest first — deciding which
 * `maxImages` (the newest) survive resolution and which are replaced by a placeholder. Mirrors
 * `loop/request.ts`'s old `resolveImagesForRequest` windowing exactly. */
function makeImageKeepDecider(messages: AgentMessage[], maxImages: number): () => boolean {
  let total = 0
  for (const m of messages) for (const b of m.content) if (b.type === 'image') total++
  for (const m of messages)
    for (const b of m.content)
      if (b.type === 'tool_result') for (const c of b.content) if (c.type === 'image') total++
  let dropBudget = Math.max(0, total - maxImages)
  return () => {
    if (dropBudget > 0) {
      dropBudget--
      return false
    }
    return true
  }
}

/** Stored rows → the AI SDK's own `ModelMessage[]` — the request wire built fresh on every call
 * (plan 66 §3.4/§3.5: compaction and windowing are views, never edits of the stored record). */
export function toModelMessages(messages: AgentMessage[], opts: ToModelMessagesOptions = {}): ModelMessage[] {
  const maxImages = opts.resolveBlob ? (Number.isFinite(opts.maxImagesPerRequest) && (opts.maxImagesPerRequest ?? 0) >= 0 ? opts.maxImagesPerRequest! : 10) : 0
  const decideKeep = opts.resolveBlob ? makeImageKeepDecider(messages, maxImages) : () => false
  const resolveImage = (b: AgentImageRef): FileContentPart | PlaceholderPart =>
    opts.resolveBlob ? resolveOrDrop(b, opts.resolveBlob, decideKeep()) : { type: 'text', text: imagePlaceholder(b) }

  const out: ModelMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      const toolContent: NonNullable<Extract<ModelMessage, { role: 'tool' }>['content']> = []
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue
        const hasImage = b.content.some((c) => c.type === 'image')
        const output = b.isError
          ? { type: 'error-text' as const, value: b.content.map((c) => (c.type === 'text' ? c.text : `[image, ${c.mediaType}]`)).join(' ') }
          : hasImage
            ? { type: 'content' as const, value: b.content.map((c) => (c.type === 'text' ? { type: 'text' as const, text: c.text } : resolveImage(c))) }
            : { type: 'text' as const, value: b.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ') }
        toolContent.push({ type: 'tool-result', toolCallId: b.toolUseId, toolName: b.toolUseId, output })
      }
      if (toolContent.length > 0) out.push({ role: 'tool', content: toolContent })
      continue
    }

    if (m.role === 'assistant') {
      const assistantContent: NonNullable<Extract<ModelMessage, { role: 'assistant' }>['content']> = []
      for (const b of m.content) {
        if (b.type === 'text') assistantContent.push({ type: 'text', text: b.text })
        else if (b.type === 'tool_use') assistantContent.push({ type: 'tool-call', toolCallId: b.id, toolName: b.name, input: b.input })
        else if (b.type === 'image') assistantContent.push(resolveImage(b))
        // 'thinking' — intentionally dropped (display only, never replayed).
      }
      if (assistantContent.length > 0) out.push({ role: 'assistant', content: assistantContent })
      continue
    }

    // 'user'
    const userContent: NonNullable<Extract<ModelMessage, { role: 'user' }>['content']> = []
    for (const b of m.content) {
      if (b.type === 'text') userContent.push({ type: 'text', text: b.text })
      else if (b.type === 'image') userContent.push(resolveImage(b))
      // 'tool_use'/'tool_result' never appear on a 'user'-role stored message.
    }
    if (userContent.length > 0) out.push({ role: 'user', content: userContent })
  }
  return out
}

/** One newly-generated assistant `ModelMessage` (the harness step's own response) → the stored
 * content blocks Enkaku persists (plan 66 §3.1, §4.1) — the inverse direction, used ONLY for the
 * model's OWN turn. Tool results are never derived from this: they are appended directly by
 * whichever code actually ran the capability (`harness/run.ts`'s `processPendingCalls`), which is
 * what keeps `agent_messages.seq` correctly ordered (the assistant's `tool_use` must be persisted
 * before any `tool_result` answering it — see that module's comment). */
export function assistantBlocksFromModelMessage(content: Extract<ModelMessage, { role: 'assistant' }>['content']): AgentContentBlock[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  const out: AgentContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text' && part.text) out.push({ type: 'text', text: part.text })
    else if (part.type === 'reasoning' && part.text) out.push({ type: 'thinking', text: part.text })
    else if (part.type === 'tool-call') out.push({ type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input })
  }
  return out
}

export type { ToolResultContent }
