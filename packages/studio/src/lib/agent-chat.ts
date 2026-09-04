import type { AgentContentBlock, AgentMessage, ToolResultContent } from '@enkaku/protocol'
import type { UIMessage } from 'ai'
import { coreBase } from './ws'

/**
 * Plan 78 §4.2, §4.4 — replaces `agent-transcript.ts`'s reducer (deleted:
 * `Transcript.tsx`, the only thing that drove it, is gone too). What is
 * still genuinely needed — the pure helpers `ToolCallCard` and the composer
 * still call, plus HOW a persisted `AgentMessage[]` history becomes the
 * `initialMessages` `useChat` wants — lives here instead.
 *
 * `useChat`'s own `messages` state is the transcript now (fed by
 * `POST /api/v1/threads/:id/chat`'s streamed `UIMessageChunk`s, built
 * server-side in `packages/core/src/api/agent-chat-stream.ts` — the SAME
 * `data-toolCall`/`data-approval`/`data-child`/`data-runStarted`/
 * `data-runFinished` shapes are mirrored below because Studio cannot import
 * server-only `@enkaku/core` code (the same constraint `lib/agents.ts`'s
 * hand-mirrored `ConnectorKind` already lives under, plan 75's own note).
 */

export type AgentChatToolCallData = {
  callId: string
  capabilityId: string
  input?: unknown
  status: 'started' | 'finished'
  ok?: boolean
  durationMs?: number
  resultContent?: ToolResultContent[]
  isError?: boolean
}

export type AgentChatApprovalData = {
  approvalId: string
  capabilityId?: string
  input?: unknown
  expiresAt?: number
  status: 'pending' | 'approved' | 'denied' | 'expired'
  decidedBy?: string | null
}

export type AgentChatChildData = {
  childRunId: string
  childThreadId?: string
  agentId?: string
  depth?: number
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'queued' | 'paused'
  stopReason?: string | null
}

export type AgentChatRunStartedData = {
  runId: string
  threadId: string
  status: string
}

export type AgentChatRunFinishedData = {
  status: string
  stopReason: string | null
  errorClass: string | null
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null } | null
}

export type AgentChatDataParts = {
  runStarted: AgentChatRunStartedData
  toolCall: AgentChatToolCallData
  approval: AgentChatApprovalData
  child: AgentChatChildData
  runFinished: AgentChatRunFinishedData
}

/**
 * The wire tool name (`device_screenshot`) reversed to a capability id
 * (`device.screenshot`) — moved verbatim from `agent-transcript.ts`. See
 * that file's original comment (now here): Anthropic tool names must match
 * `^[a-zA-Z0-9_-]{1,128}$`, so `.` becomes `_` on the wire; no capability id
 * in the registry contains an underscore, so the reverse is unambiguous.
 */
export function wireNameToCapabilityId(name: string): string {
  return name.replace(/_/g, '.')
}

/** A `tool_result`'s own content is a BLOCK ARRAY (plan 70 §3.2) — text and/or one or more images. */
export function findImageBlock(content: unknown): Extract<AgentContentBlock, { type: 'image' }> | null {
  if (!Array.isArray(content)) return null
  const found = content.find((b): b is Extract<AgentContentBlock, { type: 'image' }> => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'image')
  return found ?? null
}

/** Every text block's own text, joined — the "plain result" a non-image tool_result renders as. */
export function textOfToolResult(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const parts = content.filter((b): b is Extract<AgentContentBlock, { type: 'text' }> => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text').map((b) => b.text)
  return parts.length > 0 ? parts.join('\n') : null
}

/** `GET /api/v1/blobs/:id` (plan 70 §4.6) — cached by the browser, immutably, by hash. */
export function blobUrl(blobId: string): string {
  return `${coreBase()}/api/v1/blobs/${encodeURIComponent(blobId)}`
}

/** `input.deviceId`, when the capability's input carries one — mirrors `capability/index.ts`'s `extractDeviceId` for display only. */
export function extractDeviceIdForDisplay(input: unknown): string | null {
  if (input && typeof input === 'object' && 'deviceId' in input) {
    const id = (input as { deviceId: unknown }).deviceId
    if (typeof id === 'string') return id
  }
  return null
}

/**
 * Plan 73 §4.2, criterion 4 — the composer's auto-grow cap: given the
 * textarea's natural (`scrollHeight`) and one line's height, how tall to
 * actually render it (never past `maxRows` lines).
 */
export function clampComposerHeight(scrollHeightPx: number, lineHeightPx: number, maxRows = 10): { heightPx: number; overflowing: boolean } {
  const max = lineHeightPx * maxRows
  if (scrollHeightPx <= max) return { heightPx: scrollHeightPx, overflowing: false }
  return { heightPx: max, overflowing: true }
}

/** `sessionStorage` key for a thread's draft (plan 73 §3.2, §4.2, criterion 9). */
export function composerDraftKey(threadId: string): string {
  return `enkaku:composer-draft:${threadId}`
}

// ---------------------------------------------------------------------------
// History → `useChat`'s `initialMessages` (plan 78 §3.5 — fetch-then-
// subscribe still holds: history loads over HTTP, `useChat` streams from
// there; nothing replays a snapshot).
//
// `AgentChatUIMessage` is `ai`'s OWN `UIMessage` type (Studio already
// depends on `ai` directly — this is not the server-only `@enkaku/core`
// boundary `lib/agents.ts`'s hand-mirrored types exist for), parameterised
// with `AgentChatDataParts` above so every `data-*` part built here and in
// `Chat.tsx` is checked against the real union `useChat` consumes, not an
// approximation of it.
// ---------------------------------------------------------------------------

export type AgentChatUIMessage = UIMessage<Record<string, never>, AgentChatDataParts>
export type AgentChatPart = AgentChatUIMessage['parts'][number]

/** Every `tool_result` block across the WHOLE history, keyed by `toolUseId` — a tool_use block on one (assistant) message and its result on a LATER (tool-role) message are matched by this id, exactly like `Transcript.tsx`'s old `toolResultsOf` did per-message, just accumulated across all of them first. */
function toolResultsByCallId(messages: AgentMessage[]): Map<string, { content: ToolResultContent[]; isError: boolean }> {
  const out = new Map<string, { content: ToolResultContent[]; isError: boolean }>()
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'tool_result') out.set(block.toolUseId, { content: block.content, isError: block.isError ?? false })
    }
  }
  return out
}

/**
 * Converts persisted history into the shape `useChat({ initialMessages })`
 * wants. `role: 'tool'` messages contribute no UIMessage of their own —
 * their `tool_result` blocks are folded into the matching `tool_use`'s
 * `data-toolCall` part instead (the SAME shape
 * `agent-chat-stream.ts`'s live bridge produces), so history and a live
 * stream render through exactly one code path in `Chat.tsx`.
 */
export function historyToUIMessages(messages: AgentMessage[]): AgentChatUIMessage[] {
  const results = toolResultsByCallId(messages)
  const out: AgentChatUIMessage[] = []
  for (const m of messages) {
    if (m.role === 'tool') continue // folded into its tool_use's data-toolCall part above
    const parts: AgentChatPart[] = []
    for (const block of m.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text, state: 'done' })
      } else if (block.type === 'thinking') {
        parts.push({ type: 'reasoning', text: block.text, state: 'done' })
      } else if (block.type === 'image') {
        parts.push({ type: 'file', url: blobUrl(block.blobId), mediaType: block.mediaType })
      } else if (block.type === 'tool_use') {
        const result = results.get(block.id)
        const data: AgentChatToolCallData = {
          callId: block.id,
          capabilityId: wireNameToCapabilityId(block.name),
          input: block.input,
          status: 'finished',
          ...(result ? { resultContent: result.content, isError: result.isError } : {}),
        }
        parts.push({ type: 'data-toolCall', id: block.id, data })
      }
      // tool_result blocks appearing directly (rare — usually on their own 'tool'-role message,
      // handled by `results` above) are intentionally not rendered a second time.
    }
    if (parts.length === 0) continue
    out.push({ id: m.id, role: m.role, parts })
  }
  return out
}
