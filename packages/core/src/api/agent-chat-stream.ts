import { createUIMessageStream, type UIMessage } from 'ai'
import type { AgentRun, ServerMessage, ToolResultContent } from '@enkaku/protocol'
import type { ServerWebSocket } from 'bun'
import type { AgentWsHandler } from '../server/ws-handlers-agent'
import { EnkakuError } from '../util/errors'

/**
 * Plan 78 §4.3/§4.4 — the bridge from Enkaku's own run machinery to the AI
 * SDK's `fetch` transport.
 *
 * Plan 78's own text assumed the core could return the harness's
 * `agentUIResponse()` (`packages/harness/src/runtime/ui-stream.ts`) as-is.
 * It cannot: `agentUIResponse()` wraps `runAgentLoop` and expects every
 * tool to carry its own `execute()`, but Plan 76 §3's own status header
 * records the OPPOSITE decision on purpose — every generated tool
 * (`harness/tools.ts`) has NO `execute` at all, because a concurrently-
 * executing tool can land its `tool_result` at a lower `seq` than the
 * `tool_use` that produced it. Every call is resolved one loop iteration
 * later by `harness/run.ts`'s `processPendingCalls`, which is also where
 * the approval gate, the lease, and the tree budget all live. Calling
 * `agentUIResponse()` directly would stream text fine and then leave every
 * tool call permanently pending — approvals, screenshots, and child runs
 * would never appear. This file is the real bridge: it drives Enkaku's
 * EXISTING run (`AgentRunner.postMessage`, unchanged) and re-emits the
 * SAME events `agentWs` already broadcasts over `/ws` as AI SDK
 * `UIMessageChunk`s instead, so `useChat`'s `fetch` transport sees them.
 *
 * `/ws` keeps broadcasting to every OTHER subscriber of the thread (another
 * tab, another viewer) exactly as before — this stream is an ADDITIONAL
 * subscriber, built with the same `AgentWsHandler.subscribe` a real
 * WebSocket connection uses, given a duck-typed object that only needs
 * `.readyState`/`.send(json: string)` (everything `ws-handlers-agent.ts`
 * actually calls on it — the `as unknown as ServerWebSocket` cast bridges
 * an internal object shape, not external input, so it is not the `as`-cast
 * the repo's Zod rule is about).
 */

export type AgentChatToolCallData = {
  callId: string
  capabilityId: string
  input?: unknown
  status: 'started' | 'finished'
  ok?: boolean
  durationMs?: number
  /**
   * The tool_result's own content blocks (plan 70 §3.2 — text and/or one or more images, never a
   * bare string) — NOT carried by `agent.tool.finished` itself (only `{ok, durationMs}`), so this
   * is filled in a turn later from the persisted `agent.message` (role `'tool'`) broadcast, matched
   * by `toolUseId === callId`. `device.screenshot`'s inline image (criterion 7) depends on this.
   */
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

export type AgentChatRunFinishedData = {
  status: AgentRun['status']
  stopReason: AgentRun['stopReason']
  errorClass: AgentRun['errorClass']
  usage: AgentRun['usage']
}

/** The run id, the moment it is known — before any token arrives — so the client can load the run
 * tree (`GET /runs/:id/tree`) and drive Stop/cancel without waiting for the first delta. */
export type AgentChatRunStartedData = {
  runId: string
  threadId: string
  status: AgentRun['status']
}

export type AgentChatDataParts = {
  runStarted: AgentChatRunStartedData
  toolCall: AgentChatToolCallData
  approval: AgentChatApprovalData
  child: AgentChatChildData
  runFinished: AgentChatRunFinishedData
}

export type AgentChatUIMessage = UIMessage<{ createdAt?: number }, AgentChatDataParts>

export interface CreateAgentChatStreamOptions {
  agentWs: Pick<AgentWsHandler, 'subscribe' | 'unsubscribe'>
  threadId: string
  /** Called AFTER subscribing (synchronously, before any await) so no event between subscribing and starting the run can be missed. */
  start: () => AgentRun
  signal?: AbortSignal
}

/** A minimal duck-typed subscriber `ws-handlers-agent.ts` can fan events out to — only `.readyState`/`.send()` are ever called on it. */
function createRelayWs(onMessage: (raw: string) => void): ServerWebSocket<unknown> {
  return { readyState: 1, send: (data: string) => onMessage(data) } as unknown as ServerWebSocket<unknown>
}

/**
 * `createUIMessageStream`'s own `onError` defaults to `() => 'An error occurred.'` — a deliberate
 * redaction so a stray internal error never leaks a stack trace or a DB path to a browser tab. That
 * default also swallows the ONE case this bridge can throw before any run exists: `opts.start()`
 * (`runner.postMessage`) rejecting synchronously — no connector configured, no stored credential, a
 * disabled agent (`E_NO_CONNECTOR`/`E_NO_CREDENTIAL`/`E_AGENT_DISABLED`, `runner.ts`). Those
 * `EnkakuError`s already carry an operator-safe message (the same text `POST /threads/:id/messages`
 * — the non-streaming route — returns as `{error:{code,message}}`), so redacting it here only makes
 * a misconfigured agent look like a dead chat instead of naming the fix. An error that is NOT an
 * `EnkakuError` (a genuine internal fault) keeps the generic message — nothing new is leaked.
 */
function chatStreamErrorText(error: unknown): string {
  if (error instanceof EnkakuError) return error.message
  return 'An error occurred.'
}

export function createAgentChatStream(opts: CreateAgentChatStreamOptions) {
  return createUIMessageStream<AgentChatUIMessage>({
    onError: chatStreamErrorText,
    execute: async ({ writer }) => {
      await new Promise<void>((resolve) => {
        // Declared before `relayWs` (which closes over it) so there is no ambiguity about
        // assignment order — `run` is always set synchronously, before `relayWs` can be invoked.
        let run: AgentRun | null = null
        let openTextId: string | null = null
        let openThinkingId: string | null = null
        let idSeq = 0
        let settled = false
        // A `data-toolCall` chunk REPLACES the part's whole `.data` on the client (`@ai-sdk/react`'s
        // own reconciliation — `existingUIPart.data = dataChunk.data`, not a merge), so every write
        // below carries the FULL current object, tracked here, rather than only what changed.
        const toolCalls = new Map<string, AgentChatToolCallData>()
        const writeToolCall = (callId: string, patch: Partial<AgentChatToolCallData>) => {
          const next = { ...(toolCalls.get(callId) ?? { callId, capabilityId: '', status: 'started' as const }), ...patch }
          toolCalls.set(callId, next)
          writer.write({ type: 'data-toolCall', id: callId, data: next })
        }
        const approvals = new Map<string, AgentChatApprovalData>()
        const writeApproval = (approvalId: string, patch: Partial<AgentChatApprovalData>) => {
          const next = { ...(approvals.get(approvalId) ?? { approvalId, status: 'pending' as const }), ...patch }
          approvals.set(approvalId, next)
          writer.write({ type: 'data-approval', id: approvalId, data: next })
        }
        const children = new Map<string, AgentChatChildData>()
        const writeChild = (childRunId: string, patch: Partial<AgentChatChildData>) => {
          const next = { ...(children.get(childRunId) ?? { childRunId, status: 'running' as const }), ...patch }
          children.set(childRunId, next)
          writer.write({ type: 'data-child', id: childRunId, data: next })
        }

        const closeOpenText = () => {
          if (openTextId) {
            writer.write({ type: 'text-end', id: openTextId })
            openTextId = null
          }
        }
        const closeOpenThinking = () => {
          if (openThinkingId) {
            writer.write({ type: 'reasoning-end', id: openThinkingId })
            openThinkingId = null
          }
        }
        const closeOpenSpans = () => {
          closeOpenText()
          closeOpenThinking()
        }

        const finish = () => {
          if (settled) return
          settled = true
          closeOpenSpans()
          opts.agentWs.unsubscribe(relayWs, opts.threadId)
          opts.signal?.removeEventListener('abort', onAbort)
          resolve()
        }

        const onAbort = () => finish()

        const relayWs = createRelayWs((raw) => {
          let msg: ServerMessage
          try {
            msg = JSON.parse(raw) as ServerMessage
          } catch {
            return
          }
          if (!run) return // events between subscribing and `start()` returning are impossible (see below), but keeps this total
          if (!('payload' in msg)) return
          const payload = msg.payload as { runId?: string; parentRunId?: string }
          const runId = payload.runId ?? payload.parentRunId
          if (runId !== undefined && runId !== run.id) return

          switch (msg.type) {
            case 'agent.run.started': {
              writer.write({ type: 'data-runStarted', id: run.id, data: { runId: msg.payload.runId, threadId: msg.payload.threadId, status: msg.payload.status } })
              break
            }
            case 'agent.delta': {
              if (msg.payload.kind === 'text') {
                closeOpenThinking()
                if (!openTextId) {
                  openTextId = `text-${run.id}-${idSeq++}`
                  writer.write({ type: 'text-start', id: openTextId })
                }
                writer.write({ type: 'text-delta', id: openTextId, delta: msg.payload.text })
              } else {
                closeOpenText()
                if (!openThinkingId) {
                  openThinkingId = `reasoning-${run.id}-${idSeq++}`
                  writer.write({ type: 'reasoning-start', id: openThinkingId })
                }
                writer.write({ type: 'reasoning-delta', id: openThinkingId, delta: msg.payload.text })
              }
              break
            }
            case 'agent.tool.started': {
              closeOpenSpans()
              writeToolCall(msg.payload.callId, { capabilityId: msg.payload.capabilityId, input: msg.payload.input, status: 'started' })
              break
            }
            case 'agent.tool.finished': {
              // `{ok, durationMs}` only — the actual result content (an image, for `device.screenshot`
              // — criterion 7) is not in THIS event at all; it arrives a turn later as a persisted
              // `agent.message` (role `'tool'`), handled below.
              writeToolCall(msg.payload.callId, { capabilityId: msg.payload.capabilityId, status: 'finished', ok: msg.payload.ok, durationMs: msg.payload.durationMs })
              break
            }
            case 'agent.message': {
              const { message } = msg.payload
              if (message.runId !== run.id) break
              if (message.role === 'tool') {
                for (const block of message.content) {
                  if (block.type === 'tool_result') writeToolCall(block.toolUseId, { resultContent: block.content, isError: block.isError ?? false })
                }
              }
              break
            }
            case 'agent.approval.requested': {
              closeOpenSpans()
              // The EXACT, untruncated input (criterion 6) — carried through unchanged.
              writeApproval(msg.payload.approvalId, { capabilityId: msg.payload.capabilityId, input: msg.payload.input, expiresAt: msg.payload.expiresAt, status: 'pending' })
              break
            }
            case 'agent.approval.resolved': {
              writeApproval(msg.payload.approvalId, { status: msg.payload.status, decidedBy: msg.payload.decidedBy })
              break
            }
            case 'agent.child.started': {
              writeChild(msg.payload.childRunId, { childThreadId: msg.payload.childThreadId, agentId: msg.payload.agentId, depth: msg.payload.depth, status: 'running' })
              break
            }
            case 'agent.child.finished': {
              writeChild(msg.payload.childRunId, { status: msg.payload.status, stopReason: msg.payload.stopReason })
              break
            }
            case 'agent.run.finished': {
              closeOpenSpans()
              writer.write({
                type: 'data-runFinished',
                data: { status: msg.payload.status, stopReason: msg.payload.stopReason, errorClass: msg.payload.errorClass, usage: msg.payload.usage },
              })
              // A `paused` run (an approval gate) is NOT done — `runner.ts`'s `resumeRun` calls
              // `launch()` again on the SAME run id the moment the approval is decided, which emits
              // a fresh `agent.run.started`/more events this stream is still subscribed to receive.
              // Only a terminal status actually ends the turn.
              if (msg.payload.status === 'succeeded' || msg.payload.status === 'failed' || msg.payload.status === 'cancelled') finish()
              break
            }
            default:
              break
          }
        })

        // Subscribe BEFORE starting the run — synchronously, so no event fired between the two can
        // be missed (a real provider call always awaits network I/O before its first emit).
        opts.agentWs.subscribe(relayWs, opts.threadId)
        try {
          run = opts.start()
        } catch (err) {
          opts.agentWs.unsubscribe(relayWs, opts.threadId)
          throw err
        }
        opts.signal?.addEventListener('abort', onAbort)
        // An immediate, best-effort first look at the run — `agent.run.started`'s real broadcast
        // (written above) still arrives and reconciles this SAME id in place once `launch()` gets
        // there, but a client should not be blind to the run id for that round trip.
        writer.write({ type: 'data-runStarted', id: run.id, data: { runId: run.id, threadId: run.threadId, status: run.status } })
        // A run that is already finished by the time `start()` returns (e.g. denied at once, no
        // model call needed) would otherwise leave this stream open forever waiting for an
        // `agent.run.finished` broadcast that already happened before we could observe it.
        if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
          writer.write({
            type: 'data-runFinished',
            data: { status: run.status, stopReason: run.stopReason, errorClass: run.errorClass, usage: run.usage },
          })
          finish()
        }
      })
    },
  })
}
