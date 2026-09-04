'use client'

import { useEffect, useMemo, useState } from 'react'
import { Paperclip, X } from 'lucide-react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import type { AgentCommand, AgentRun, AgentTreeNode } from '@enkaku/protocol'
import {
  AgentCommandsResponseSchema,
  AgentResponseSchema,
  ApprovalResponseSchema,
  ConnectorModelsResponseSchema,
  FarmAgentSettingsResponseSchema,
  RunResponseSchema,
  ThreadMessagesResponseSchema,
  TreeResponseSchema,
  UploadBlobResponseSchema,
} from '@enkaku/protocol'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
import {
  PromptInput,
  PromptInputButton,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
import { ApprovalCard } from './ApprovalCard'
import { ChildRunCard } from './ChildRunCard'
import { ModelCombobox } from './ModelCombobox'
import { ToolCallCard } from './ToolCallCard'
import { UsageBadge } from './UsageBadge'
import { Button, cn, ErrorState, LoadingRows, api, useAction } from '@enkaku/ui'
import {
  historyToUIMessages,
  type AgentChatApprovalData,
  type AgentChatRunFinishedData,
  type AgentChatRunStartedData,
  type AgentChatToolCallData,
  type AgentChatUIMessage,
} from '@/lib/agent-chat'
import { resolveForDisplay, type Agent, type AgentDefaults, type ModelInfo } from '@/lib/agents'
import { coreBase } from '@/lib/ws'

/**
 * Plan 78 §4.2 — replaces `Transcript.tsx` + `Composer.tsx`. `chat-panel.tsx`'s
 * shape, minus the trading-specific pieces (§2): `useChat` against
 * `POST /api/v1/threads/:id/chat` (the `fetch` bridge in
 * `packages/core/src/api/agent-chat-stream.ts` — see its header comment for
 * why `agentUIResponse()` itself could not be used directly), `Conversation`
 * wrapping ported `Message`/`Reasoning`, `PromptInput` at the foot, and
 * Enkaku's own kept cards (`ApprovalCard`, `ChildRunCard`, `ToolCallCard`)
 * mounted for the concepts upstream has no notion of (§3.1).
 *
 * History loads over HTTP first (`GET /threads/:id/messages`,
 * `historyToUIMessages`), THEN `useChat` streams from there — fetch-then-
 * subscribe still holds (§3.5); nothing replays a snapshot. The parent
 * mounts this with `key={threadId}` (unchanged from `Transcript`'s own
 * contract), so a thread switch is a fresh mount rather than an in-place
 * reset — `useChat`'s own state starts clean for it.
 */

interface DerivedRunState {
  id: string
  threadId: string
  status: string
  stopReason: string | null
  errorClass: string | null
  usage: AgentChatRunFinishedData['usage']
}

/** Scans every message's parts for the LATEST `data-runStarted`/`data-runFinished` — the run this
 * turn is (or was) driving. Data parts land on whichever message was "current" when the server
 * wrote them (plan 78's bridge never opens a text span before them), so this walks every message,
 * not just the last one, and keeps only the most recent state seen. */
function applyRunEvent(state: DerivedRunState | null, part: AgentChatUIMessage['parts'][number]): DerivedRunState | null {
  if (part.type === 'data-runStarted') {
    const d = part.data as AgentChatRunStartedData
    const carriedOver: Pick<DerivedRunState, 'stopReason' | 'errorClass' | 'usage'> =
      state !== null && state.id === d.runId ? { stopReason: state.stopReason, errorClass: state.errorClass, usage: state.usage } : { stopReason: null, errorClass: null, usage: null }
    return { id: d.runId, threadId: d.threadId, status: d.status, ...carriedOver }
  }
  if (part.type === 'data-runFinished') {
    const d = part.data as AgentChatRunFinishedData
    if (state === null) return null
    return { id: state.id, threadId: state.threadId, status: d.status, stopReason: d.stopReason, errorClass: d.errorClass, usage: d.usage }
  }
  return state
}

function deriveRunState(messages: AgentChatUIMessage[]): DerivedRunState | null {
  const allParts = messages.flatMap((m) => m.parts)
  return allParts.reduce<DerivedRunState | null>(applyRunEvent, null)
}

/** How many `data-child` parts have been seen, across every message — a cheap signal to re-fetch the run tree without diffing its contents (mirrors `Transcript.tsx`'s own `agent.child.*` → `loadTree` reaction). */
function countChildSignals(messages: AgentChatUIMessage[]): number {
  let n = 0
  for (const m of messages) for (const part of m.parts) if (part.type === 'data-child') n++
  return n
}

function toAgentRunShape(s: DerivedRunState): AgentRun {
  return {
    id: s.id,
    threadId: s.threadId,
    status: s.status as AgentRun['status'],
    stopReason: s.stopReason as AgentRun['stopReason'],
    errorClass: s.errorClass as AgentRun['errorClass'],
    error: null,
    steps: 0,
    usage: s.usage,
    startedAt: null,
    finishedAt: null,
    parentRunId: null,
    rootRunId: s.id,
    depth: 1,
    awaited: false,
    deviceGrantsOverride: null,
  }
}

export function Chat({
  threadId,
  agent,
  onAgentChange,
  onRunChange,
  onTreeChange,
  embedded,
}: {
  threadId: string
  agent?: Agent | null
  onAgentChange?(agent: Agent): void
  onRunChange?(run: AgentRun | null): void
  onTreeChange?(nodes: AgentTreeNode[], rootRunId: string | null): void
  embedded?: boolean
}) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [treeNodes, setTreeNodes] = useState<AgentTreeNode[]>([])
  const [expandedChildId, setExpandedChildId] = useState<string | null>(null)
  const [farmDefaults, setFarmDefaults] = useState<AgentDefaults | null>(null)
  const [models, setModels] = useState<{ models: ModelInfo[]; fallback: boolean } | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [commands, setCommands] = useState<AgentCommand[]>([])
  // Plan 83 §3.3 — a failed STREAM (a transport-level failure: bad URL, network drop, a non-2xx
  // response, or `agent-chat-stream.ts`'s own `execute()` throwing before any run exists — e.g. a
  // disabled agent) previously said NOTHING at all: `useChat` never had `onError` wired, and
  // nothing ever read `chat.error`. `streamError` is that missing surface; `lastUserMessage` is
  // what Retry re-sends.
  const [streamError, setStreamError] = useState<string | null>(null)
  const [lastUserMessage, setLastUserMessage] = useState<{ text: string; attachments: string[] } | null>(null)
  // Plan 83 §3.3 — the four background fetches (commands, farm defaults, the model list, the run
  // tree) used to `.catch(() => undefined)`: a failure was genuinely invisible, not merely
  // unobtrusive. `backgroundError` is a single, low-emphasis note for the three of those four that
  // have no dedicated failed-state UI of their own; the model list gets its OWN distinct state
  // (`modelsError`, above) because criterion 8 asks for it specifically — an empty dropdown reads
  // as "no models exist", which is a different (and false) claim from "the fetch failed".
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const { run: doAction, isPending } = useAction()

  // Plan 78 §3.6 — the assembled slash-command list every `AgentPlugin.commands` contributes
  // (plan 77 §4.3, inert until this composer). Fetched once; a plugin adding a command needs no
  // change here to appear (criterion 8) — the NEXT load of any thread just has one more entry.
  useEffect(() => {
    void api('/api/v1/agent-commands', AgentCommandsResponseSchema)
      .then((b) => setCommands(b.commands))
      .catch((e) => setBackgroundError(`Slash commands failed to load — ${e instanceof Error ? e.message : String(e)}`))
  }, [])

  const transport = useMemo(
    () =>
      new DefaultChatTransport<AgentChatUIMessage>({
        api: `${coreBase()}/api/v1/threads/${threadId}/chat`,
        // A session COOKIE (not a bearer header) is how the core authenticates today — `include` so
        // it rides along even across the :3001→:7700 dev-mode origin split. `fetch`, never
        // `EventSource` (plan 78 §3.4): only `fetch` can carry this at all, and no credential ever
        // appears in the URL.
        credentials: 'include',
        prepareSendMessagesRequest: ({ messages, body }) => {
          const last = messages[messages.length - 1]
          const text = last?.parts.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('') ?? ''
          const attachments = (body as { attachments?: string[] } | undefined)?.attachments ?? []
          return { body: { text, attachments } }
        },
      }),
    [threadId],
  )

  const chat = useChat<AgentChatUIMessage>({
    transport,
    // Plan 83 §3.3 — the whole point of this plan's finding: a rejected/errored stream previously
    // left the UI in exactly the state a slow one leaves it in (nothing). `err` here is a genuine
    // transport-level failure (the fetch itself failing, a non-2xx response, or a malformed chunk)
    // — an agent RUN failing is a different, already-visible thing (`run.status`/`errorClass`,
    // rendered below).
    onError: (err) => setStreamError(err instanceof Error ? err.message : String(err)),
  })
  const { messages, setMessages, sendMessage, status, stop } = chat

  // Fetch-then-subscribe (plan 78 §3.5, `CLAUDE.md`) — history over HTTP, THEN `useChat` streams
  // from there. `key={threadId}` at the call site (`agents/detail/page.tsx`, unchanged) makes a
  // thread switch a fresh mount, so this only ever needs to run once.
  useEffect(() => {
    let cancelled = false
    api(`/api/v1/threads/${threadId}/messages`, ThreadMessagesResponseSchema)
      .then((b) => {
        if (cancelled) return
        setMessages(historyToUIMessages(b.messages))
        setLoaded(true)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  useEffect(() => {
    // Plan 212 §4.7 — agent defaults moved off `/api/settings` onto their own route.
    void api('/api/agents/settings', FarmAgentSettingsResponseSchema)
      .then((b) => setFarmDefaults(b.settings.defaults))
      .catch((e) => setBackgroundError(`Farm defaults failed to load — ${e instanceof Error ? e.message : String(e)}`))
  }, [])

  const connectorId = agent?.connectorId ?? farmDefaults?.connectorId ?? null
  useEffect(() => {
    if (!connectorId) {
      setModels(null)
      setModelsError(null)
      return
    }
    setModelsError(null)
    void api(`/api/connectors/${connectorId}/models`, ConnectorModelsResponseSchema)
      .then((b) => {
        setModels(b)
        setModelsError(null)
      })
      // Criterion 8 — a failed fetch sets a DISTINCT error state rather than `setModels(null)`,
      // which is indistinguishable from "still loading" or "this connector genuinely has no
      // models" (`ModelCombobox` renders `modelsError` as a named failure, not an empty list).
      .catch((e) => setModelsError(e instanceof Error ? e.message : String(e)))
  }, [connectorId])

  const runState = useMemo(() => deriveRunState(messages), [messages])
  const run = runState ? toAgentRunShape(runState) : null
  const childSignal = useMemo(() => countChildSignals(messages), [messages])

  useEffect(() => onRunChange?.(run), [run?.id, run?.status, run?.stopReason]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!run?.id) return
    void api(`/api/v1/runs/${run.id}/tree`, TreeResponseSchema)
      .then((b) => {
        setTreeNodes(b.nodes)
        onTreeChange?.(b.nodes, b.rootRunId)
      })
      .catch((e) => setBackgroundError(`The run tree failed to load — ${e instanceof Error ? e.message : String(e)}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.status, childSignal])

  const decideApproval = (approvalId: string, decision: 'approve' | 'deny') => {
    void doAction(`approval-${decision}-${approvalId}`, () => api(`/api/v1/approvals/${approvalId}`, ApprovalResponseSchema, { method: 'POST', json: { decision } }), {
      failure: 'Could not record the decision',
    })
  }

  // Stop is two things, not one (§4.2): `stop()` only aborts THIS client's read of the stream —
  // the run keeps executing server-side unless the SAME REST cancel every other Stop/Cancel button
  // already calls (`agents/detail/page.tsx`'s header, `runs/:id/cancel`) is also called here.
  const stopRun = () => {
    stop()
    if (run) void doAction('stop', () => api(`/api/v1/runs/${run.id}/cancel`, RunResponseSchema, { method: 'POST' }), { failure: 'Could not stop the run' })
  }

  const resolved = agent && farmDefaults ? resolveForDisplay(farmDefaults, agent) : null

  const patchAgent = (patch: { model?: string; settings?: Agent['settings'] }) => {
    if (!agent) return
    void doAction('composer-agent-patch', () => api(`/api/agents/${agent.id}`, AgentResponseSchema, { method: 'PATCH', json: patch }), {
      failure: 'Could not update the agent',
      onSuccess: (b) => onAgentChange?.(b.agent),
    })
  }

  // Plan 83 §3.2, §4.2 — `submit` awaits only what must happen BEFORE the send (attachment
  // uploads): `PromptInput` (`prompt-input.tsx`, unedited) clears the composer once its own
  // `onSubmit` resolves, and — on the async path — deliberately does NOT clear if it throws, so an
  // upload failure keeps the typed text for a retry (criterion 10). `sendMessage` itself resolves
  // only once the WHOLE turn finishes, so awaiting it here would hold the composer hostage for the
  // entire reply (§3.2's own diagnosis) — it is fired and left to stream in the background instead
  // (criterion 9), with `onError` above as the failure channel now that the text is no longer the
  // only sign something is wrong.
  const submit = async (message: PromptInputMessage) => {
    const attachmentIds: string[] = []
    for (const f of message.files) {
      const blob = await fetch(f.url).then((r) => r.blob())
      const file = new File([blob], f.filename ?? 'attachment', { type: f.mediaType })
      const info = await api('/api/v1/blobs', UploadBlobResponseSchema, { method: 'POST', body: file })
      attachmentIds.push(info.blobId)
    }
    setStreamError(null)
    setLastUserMessage({ text: message.text ?? '', attachments: attachmentIds })
    void sendMessage({ text: message.text }, { body: { attachments: attachmentIds } }).catch(() => undefined) // failures surface via onError above, not here
  }

  const retry = () => {
    if (!lastUserMessage) return
    setStreamError(null)
    void sendMessage({ text: lastUserMessage.text }, { body: { attachments: lastUserMessage.attachments } }).catch(() => undefined)
  }

  const directChildren = treeNodes.filter((n) => n.parentRunId === run?.id)

  if (error) return <ErrorState message={error} onRetry={() => setError(null)} />
  if (!loaded) return <LoadingRows rows={4} />

  return (
    <div className={cn('flex min-h-0 flex-col', embedded ? 'max-h-96 rounded-md border' : 'flex-1')}>
      <Conversation className="flex-1">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState title="Nothing here yet" description="Send a message to start the conversation." />
          ) : (
            messages.map((m) => <ChatMessage key={m.id} message={m} onDecideApproval={decideApproval} isPendingApproval={(id, decision) => isPending(`approval-${decision}-${id}`)} />)
          )}

          {status === 'submitted' && (
            <Message from="assistant">
              <MessageContent>
                <Shimmer>Thinking…</Shimmer>
              </MessageContent>
            </Message>
          )}

          {run && ['succeeded', 'failed', 'cancelled'].includes(run.status) && (
            <div className="mx-auto max-w-[85%] space-y-1.5 text-center">
              <p className="text-[11.5px] text-fg-subtle">
                run {run.status}
                {run.stopReason ? ` — ${run.stopReason}` : ''}
                {run.errorClass ? ` (${run.errorClass})` : ''}
              </p>
              {run.usage && (
                <div className="inline-block rounded-md border bg-surface px-3 py-1.5 text-left">
                  <UsageBadge usage={run.usage} compact />
                </div>
              )}
            </div>
          )}

          {run && directChildren.length > 0 && (
            <div className="mx-auto max-w-[85%] space-y-1.5">
              <p className="text-[11px] font-medium text-fg-subtle">Sub-agents ({directChildren.length})</p>
              {directChildren.map((n) => (
                <div key={n.runId} className="space-y-1.5">
                  <ChildRunCard node={n} expanded={expandedChildId === n.runId} onToggle={() => setExpandedChildId((id) => (id === n.runId ? null : n.runId))} />
                  {expandedChildId === n.runId && (
                    <div className="ml-4">
                      <Chat key={n.threadId} threadId={n.threadId} embedded />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Plan 83 §3.3 — a failed stream now says something, immediately, in the chat, rather than
          leaving the UI indistinguishable from a slow one. `Retry` re-sends the exact last user
          message via the same non-awaited `sendMessage` path `submit` uses. */}
      {streamError && (
        <div className="mx-2 mb-2 flex items-start justify-between gap-3 rounded-md border border-led-danger/30 bg-led-danger/10 px-3 py-2 text-[12.5px]">
          <div>
            <p className="font-medium text-led-danger">The message failed to send</p>
            <p className="text-fg-muted">{streamError}</p>
          </div>
          {lastUserMessage && (
            <Button variant="outline" size="sm" onClick={retry} className="shrink-0">
              Retry
            </Button>
          )}
        </div>
      )}
      {backgroundError && !streamError && (
        <p className="mx-2 mb-1.5 text-[11px] text-fg-subtle">{backgroundError}</p>
      )}

      <PromptInputProvider>
      <PromptInput
        className="p-2 pt-0"
        onSubmit={submit}
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        maxFiles={10}
        maxFileSize={8 * 1024 * 1024}
      >
        <AttachmentStrip />
        <div className="relative">
          <SlashCommandMenu commands={commands} />
          {/* `min-h-11` sizes the box for one line instead of the shared
              `Textarea`'s 4rem default.

              This used to also carry `items-start`, added by plan 83 to
              un-centre the placeholder. It never did anything: the centring
              came from `InputGroup`, which flips to `flex-col` when a footer
              with `data-align=block-end` is present but kept `items-center`
              — turning a harmless vertical centring into a horizontal one for
              every child. Fixed at that source (`ui/input-group.tsx`), which
              is why nothing is needed here. */}
          <PromptInputTextarea placeholder="Message the agent… (/ for commands)" className="min-h-11" />
        </div>
        <PromptInputFooter>
          <PromptInputTools>
            <AttachButton disabled={status !== 'ready'} />
          </PromptInputTools>
          <div className="flex items-center gap-1">
            {agent && resolved && (
              <>
                <ModelCombobox
                  value={resolved.model}
                  options={models?.models.map((m) => m.id) ?? []}
                  onValueChange={(v) => patchAgent({ model: v })}
                  disabled={isPending('composer-agent-patch')}
                  error={modelsError}
                />
                <PromptInputSelect
                  value={resolved.effort}
                  onValueChange={(v) => patchAgent({ settings: { ...agent.settings, effort: v as 'low' | 'medium' | 'high' } })}
                  disabled={isPending('composer-agent-patch')}
                >
                  <PromptInputSelectTrigger aria-label="Effort">
                    <PromptInputSelectValue />
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    <PromptInputSelectItem value="low">low</PromptInputSelectItem>
                    <PromptInputSelectItem value="medium">medium</PromptInputSelectItem>
                    <PromptInputSelectItem value="high">high</PromptInputSelectItem>
                  </PromptInputSelectContent>
                </PromptInputSelect>
              </>
            )}
            <PromptInputSubmit status={status} onStop={stopRun} />
          </div>
        </PromptInputFooter>
      </PromptInput>
      </PromptInputProvider>
    </div>
  )
}

/**
 * Plan 78 §3.6 — a plugin's `commands` (plan 77 §4.3) finally have somewhere to appear: typing
 * "/" opens a popover of every assembled command, filtered live against what follows it. Reads
 * and writes the SAME controlled text `PromptInput` submits from (`usePromptInputController`,
 * which is why this composer is wrapped in `PromptInputProvider` — the popover is a SIBLING of the
 * textarea, not a descendant, so it needs its own way to reach that state).
 */
function SlashCommandMenu({ commands }: { commands: AgentCommand[] }) {
  const controller = usePromptInputController()
  const value = controller.textInput.value
  const match = /^\/(\S*)$/.exec(value)
  if (!match || commands.length === 0) return null
  const query = (match[1] ?? '').toLowerCase()
  const filtered = commands.filter((c) => c.name.toLowerCase().startsWith(query))
  if (filtered.length === 0) return null
  return (
    <div className="absolute bottom-full left-0 z-10 mb-1 w-72 overflow-hidden rounded-md border bg-popover shadow-md">
      <PromptInputCommand>
        <PromptInputCommandList>
          <PromptInputCommandEmpty>No matching command.</PromptInputCommandEmpty>
          <PromptInputCommandGroup>
            {filtered.map((c) => (
              <PromptInputCommandItem key={c.name} value={c.name} onSelect={() => controller.textInput.setInput(`/${c.name} `)}>
                <span className="readout shrink-0">/{c.name}</span>
                <span className="truncate text-fg-subtle">{c.description}</span>
              </PromptInputCommandItem>
            ))}
          </PromptInputCommandGroup>
        </PromptInputCommandList>
      </PromptInputCommand>
    </div>
  )
}

function AttachButton({ disabled }: { disabled?: boolean }) {
  const attachments = usePromptInputAttachments()
  return (
    <PromptInputButton disabled={disabled} tooltip="Attach an image" onClick={() => attachments.openFileDialog()}>
      <Paperclip className="size-4" aria-hidden />
    </PromptInputButton>
  )
}

function AttachmentStrip() {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null
  return (
    <div className="flex w-full flex-wrap items-start justify-start gap-2 px-2 pt-2">
      {attachments.files.map((f) => (
        <div key={f.id} className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element -- a staged local blob/data URL */}
          <img src={f.url} alt={f.filename ?? 'attachment'} className="size-14 rounded border object-cover" />
          <button
            type="button"
            onClick={() => attachments.remove(f.id)}
            aria-label="Remove attachment"
            className="absolute -right-1.5 -top-1.5 flex size-4.5 items-center justify-center rounded-full bg-fg text-bg"
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}

function ChatMessage({
  message,
  onDecideApproval,
  isPendingApproval,
}: {
  message: AgentChatUIMessage
  onDecideApproval(id: string, decision: 'approve' | 'deny'): void
  isPendingApproval(id: string, decision: 'approve' | 'deny'): boolean
}) {
  if (message.role === 'system') {
    const text = message.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ')
    return <p className="text-center text-[12px] italic text-fg-subtle">{text}</p>
  }
  return (
    <Message from={message.role}>
      <MessageContent className="w-full">
        {message.parts.map((part, i) => {
          if (part.type === 'text' && part.text) return <MessageResponse key={i}>{part.text}</MessageResponse>
          if (part.type === 'reasoning' && part.text) {
            return (
              <Reasoning key={i} isStreaming={part.state === 'streaming'}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            )
          }
          if (part.type === 'file' && part.mediaType.startsWith('image/')) {
            // eslint-disable-next-line @next/next/no-img-element -- a core-served blob URL
            return <img key={i} src={part.url} alt="Attached image" className="max-h-64 w-auto rounded border" />
          }
          if (part.type === 'data-toolCall') {
            const data = part.data as AgentChatToolCallData
            return (
              <ToolCallCard
                key={i}
                name={data.capabilityId}
                input={data.input}
                status={data.status === 'started' ? 'running' : data.ok ? 'ok' : 'error'}
                durationMs={data.durationMs}
                resultContent={data.resultContent ?? null}
              />
            )
          }
          if (part.type === 'data-approval') {
            const data = part.data as AgentChatApprovalData
            if (data.status !== 'pending') return null
            return (
              <ApprovalCard
                key={i}
                approval={{
                  id: data.approvalId,
                  runId: '',
                  threadId: '',
                  capabilityId: data.capabilityId ?? '',
                  toolCallId: '',
                  input: data.input,
                  status: data.status,
                  decidedBy: data.decidedBy ?? null,
                  decidedAt: null,
                  expiresAt: data.expiresAt ?? 0,
                  createdAt: Math.floor(Date.now() / 1000),
                }}
                onDecide={(decision) => onDecideApproval(data.approvalId, decision)}
                pendingDecision={isPendingApproval(data.approvalId, 'approve') ? 'approve' : isPendingApproval(data.approvalId, 'deny') ? 'deny' : null}
              />
            )
          }
          // `data-runStarted`/`data-runFinished`/`data-child` carry no inline UI of their own — they
          // are consumed by `Chat`'s own state derivation instead (run status, the Sub-agents list).
          return null
        })}
      </MessageContent>
    </Message>
  )
}
