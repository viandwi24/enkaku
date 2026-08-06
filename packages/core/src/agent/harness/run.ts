import { streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import { compact, detectLoop, summarizeStep, runAgentLoop, type StepSummary } from '@enkaku/harness'
import type {
  Agent,
  AgentContentBlock,
  AgentErrorClass,
  AgentMessage,
  AgentRun,
  AgentRunStatus,
  AgentStopReason,
  AgentThread,
  AgentUsage,
  ConnectorKind,
  ResolvedAgentConfig,
  ToolResultContent,
} from '@enkaku/protocol'
import { extractDeviceId, invoke, type CapabilityContext } from '../../capability'
import type { CapabilityRegistry } from '../../capability/registry'
import type { AnyCoreCapability } from '../../capability/types'
import type { AuditLogger } from '../../auth/audit'
import type { LeaseManager } from '../../lease/lease-manager'
import type { ApprovalStore } from '../approval/store'
import type { ThreadStore } from '../thread/store'
import type { BlobStore } from '../blob/store'
import { sniffImageMediaType } from '../blob/store'
import type { ProviderAdapter } from '../provider'
import { buildProviderOptions } from './config'
import { classifyError, retryAfterMs } from './errors'
import { toModelMessages, assistantBlocksFromModelMessage, type ResolveBlob } from './messages'

/**
 * The loop (plan 66 §3.2, plan 76 §3.7 — replaces `agent/loop/run.ts`, which
 * is deleted). This module and nothing else decides what an agent does
 * next; every side effect on the world goes through `invoke()` (plan 63
 * §3.4) — there is no permission, lease, or grant check written here, only
 * the control flow the plans' pseudocode describes, now driving the model
 * through the harness's `runAgentLoop` instead of a hand-rolled provider
 * stream parser (plan 76's whole point).
 *
 * `executeRun` is called both to START a run and to RESUME one (after an
 * approval decision, or a core restart that left it `paused`). Both cases
 * are the SAME code path: at the top of every iteration it re-derives
 * "what tool calls are still pending" straight from the append-only
 * message log (`extractPendingToolCalls`), so there is no separate resume
 * state to reconstruct.
 *
 * `harness/tools.ts`'s `buildToolSet` deliberately gives every tool NO
 * `execute` — every tool call, gated or not, is resolved HERE, by
 * `processPendingCalls`, which is `agent/loop/run.ts`'s own function moved
 * over almost unchanged (see `harness/tools.ts`'s module comment for why).
 */

export interface ToolPolicy {
  /** wire tool name → capability id, for every tool this agent may call. */
  capabilityIdForToolName: Map<string, string>
  /** Registry ids the agent's OWNER additionally requires approval for, beyond the registry's own `effect: 'destructive'` gate (plan 66 §3.6). */
  requiresApprovalCapabilityIds: ReadonlySet<string>
  /** Plan 67 §3.4, criterion 4 — re-checked at every invoke, not only at spawn. Omitted for a root run. */
  isCapabilityCurrentlyAllowed?: (capabilityId: string) => boolean
  /** Plan 68 §3.5 — the THREAD's own setting. Omitted falls back to `'pause'`. */
  onApprovalRequired?: 'pause' | 'deny'
}

/** Plan 67 §3.6 — the tree's SHARED token budget. Omitted, the loop falls back to plan 66's plain per-run check. */
export interface TreeBudget {
  maxOutputTokens: number
  spentSoFar: () => number
}

/** Plan 67 §3.3, §4.3 — the ONLY place a message enters a run: drained at the top of every iteration, never mid tool-call. */
export interface InboxItem {
  id: string
  fromRunId: string | null
  kind: 'message' | 'child-result'
  body: unknown
}
export interface InboxDrain {
  drain(runId: string): InboxItem[]
}

export type RunEmitEvent =
  | { type: 'delta'; kind: 'text' | 'thinking'; text: string }
  | { type: 'message'; message: AgentMessage }
  | { type: 'tool.started'; callId: string; capabilityId: string; input: unknown }
  | { type: 'tool.finished'; callId: string; capabilityId: string; ok: boolean; durationMs: number }
  | { type: 'approval.requested'; approvalId: string; capabilityId: string; input: unknown; expiresAt: number }
  | { type: 'approval.resolved'; approvalId: string; status: 'approved' | 'denied' | 'expired' }
  | { type: 'inbox.delivered'; inboxId: string; fromRunId: string | null; kind: 'message' | 'child-result' }

export interface RunOutcome {
  status: AgentRunStatus
  stopReason: AgentStopReason | null
  errorClass: AgentErrorClass | null
  error: string | null
  usage: AgentUsage | null
}

export interface ExecuteRunDeps {
  thread: AgentThread
  run: AgentRun
  agent: Agent
  config: ResolvedAgentConfig
  /** The model's context window (plan 65 §3.7 — `compactAtRatio` is a fraction of THIS). */
  contextWindow: number
  provider: ProviderAdapter
  /** Which connector kind `provider` was built from — decides `providerOptions` shape (`harness/config.ts`). */
  connectorKind: ConnectorKind
  toolSet: ToolSet
  toolPolicy: ToolPolicy
  registry: Pick<CapabilityRegistry, 'get'>
  capabilityContext: CapabilityContext
  threads: ThreadStore
  approvals: ApprovalStore
  leases: LeaseManager
  markConnectorUnauthenticated?: (message: string) => void
  emit: (event: RunEmitEvent) => void
  isCancelled: () => boolean
  cancelledBy: () => string | null
  /** Aborts a live `streamText` call the instant this run is cancelled — optional so every test that
   * only polls `isCancelled()` keeps compiling; a real host (`agent/runner.ts`) always supplies one,
   * tied to the same cancellation flag `isCancelled` reads. */
  signal?: AbortSignal
  audit?: AuditLogger
  notifyAutoDenied?: (info: { capabilityId: string; toolCallId: string }) => void
  rootRunId?: string
  treeBudget?: TreeBudget
  inbox?: InboxDrain
  deviceLock?: { release(deviceId: string): void }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  blobs?: BlobStore
}

const MAX_RETRIES_PER_STEP = 5
const RETRY_BACKOFF_CAP_MS = 30_000

function nowSecOf(nowMs: () => number): number {
  return Math.floor(nowMs() / 1000)
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }
}

function sumUsage(a: AgentUsage | null, b: AgentUsage): AgentUsage {
  const base = a ?? emptyUsage()
  return {
    inputTokens: base.inputTokens + b.inputTokens,
    outputTokens: base.outputTokens + b.outputTokens,
    cacheReadTokens: base.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: null,
  }
}

interface PendingToolCall {
  id: string
  name: string
  input: unknown
}

/**
 * Derives "what still needs to happen" straight from the append-only log:
 * the last assistant message's `tool_use` blocks that have no matching
 * `tool_result` anywhere after them yet. Empty when the run is between
 * steps (nothing pending) — the same function serves a fresh step and a
 * resume after approval/restart identically.
 */
export function extractPendingToolCalls(messages: AgentMessage[]): PendingToolCall[] {
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }
  if (lastAssistantIdx === -1) return []
  const assistantMsg = messages[lastAssistantIdx]!
  const toolUses = assistantMsg.content.filter((b): b is Extract<AgentContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
  if (toolUses.length === 0) return []

  const resultIds = new Set<string>()
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    for (const b of messages[i]!.content) {
      if (b.type === 'tool_result') resultIds.add(b.toolUseId)
    }
  }
  return toolUses.filter((t) => !resultIds.has(t.id)).map((t) => ({ id: t.id, name: t.name, input: t.input }))
}

export async function executeRun(deps: ExecuteRunDeps): Promise<RunOutcome> {
  const nowMs = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const { thread, agent, config, provider, toolSet, toolPolicy, registry, capabilityContext, threads, approvals, leases, audit } = deps

  let run = deps.run
  if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
    return { status: run.status, stopReason: run.stopReason, errorClass: run.errorClass, error: run.error, usage: run.usage }
  }
  if (run.startedAt === null) {
    run = threads.updateRun(run.id, { status: 'running', startedAt: new Date(nowMs()) })
  } else {
    run = threads.updateRun(run.id, { status: 'running' })
  }
  const runStartedAtSec = run.startedAt!

  const leaseClientId = `agent-run:${deps.rootRunId ?? run.id}`
  const acquiredLeaseDeviceIds = new Set<string>()
  const lostLeaseDeviceIds = new Set<string>()
  const stepSummaries: StepSummary[] = []

  const resolveBlob: ResolveBlob | undefined = deps.blobs
    ? (blobId) => {
        const stored = deps.blobs!.get(blobId)
        return stored ? { mediaType: stored.mediaType, data: Buffer.from(stored.data).toString('base64') } : null
      }
    : undefined

  function releaseAcquiredLeases(): void {
    for (const deviceId of acquiredLeaseDeviceIds) {
      if (deps.deviceLock) {
        deps.deviceLock.release(deviceId)
      } else {
        leases.releaseManual(deviceId, leaseClientId)
      }
    }
    acquiredLeaseDeviceIds.clear()
  }

  function ensureControlLease(deviceId: string): void {
    if (lostLeaseDeviceIds.has(deviceId)) return
    if (acquiredLeaseDeviceIds.has(deviceId)) {
      leases.touchManual(deviceId, leaseClientId)
      return
    }
    try {
      leases.acquireManual(deviceId, leaseClientId, agent.id)
      acquiredLeaseDeviceIds.add(deviceId)
    } catch {
      // Already held (by a human, or another run) — invoke()'s own controlLeaseBlockedBy check
      // refuses and names the real holder; this function never duplicates that check.
    }
  }

  function checkLeaseRevoked(deviceId: string): string | null {
    if (!acquiredLeaseDeviceIds.has(deviceId) || lostLeaseDeviceIds.has(deviceId)) return null
    const current = leases.getLease(deviceId)
    if (current && current.holder === leaseClientId) return null
    acquiredLeaseDeviceIds.delete(deviceId)
    lostLeaseDeviceIds.add(deviceId)
    return `E_LEASE_REVOKED: control of ${deviceId} was taken over by someone else — this run no longer holds it and will not try to reacquire it`
  }

  function statusFor(stopReason: AgentStopReason): AgentRunStatus {
    if (stopReason === 'done') return 'succeeded'
    if (stopReason === 'cancelled') return 'cancelled'
    return 'failed'
  }

  function finish(stopReason: AgentStopReason, errorClass: AgentErrorClass | null, error: string | null, usage: AgentUsage | null): RunOutcome {
    releaseAcquiredLeases()
    const status = statusFor(stopReason)
    threads.updateRun(run.id, { status, stopReason, errorClass, error, usage: usage ?? run.usage, finishedAt: new Date(nowMs()) })
    return { status, stopReason, errorClass, error, usage: usage ?? run.usage }
  }

  function finishCancelled(): RunOutcome {
    const by = deps.cancelledBy() ?? 'unknown'
    const msg = threads.appendMessage({
      threadId: thread.id,
      runId: run.id,
      role: 'system',
      content: [{ type: 'text', text: `Cancelled by ${by} at ${new Date(nowMs()).toISOString()}.` }],
    })
    deps.emit({ type: 'message', message: msg })
    return finish('cancelled', null, `cancelled by ${by}`, null)
  }

  function appendToolResult(toolUseId: string, content: ToolResultContent[], isError: boolean): void {
    const msg = threads.appendMessage({ threadId: thread.id, runId: run.id, role: 'tool', content: [{ type: 'tool_result', toolUseId, content, isError }] })
    deps.emit({ type: 'message', message: msg })
  }

  function textResult(text: string): ToolResultContent[] {
    return [{ type: 'text', text }]
  }

  function buildToolResultContent(cap: AnyCoreCapability, output: unknown): { content: ToolResultContent[]; isError: boolean } {
    if (!cap.imageOutputs || cap.imageOutputs.length === 0 || !output || typeof output !== 'object' || Array.isArray(output)) {
      return { content: textResult(JSON.stringify(output)), isError: false }
    }
    if (!deps.blobs) {
      return { content: textResult(JSON.stringify(output)), isError: false }
    }
    const blobs = deps.blobs
    const maxImageBytes = config.maxImageBytes
    const obj: Record<string, unknown> = { ...(output as Record<string, unknown>) }
    const imageBlocks: ToolResultContent[] = []

    for (const decl of cap.imageOutputs) {
      const raw = obj[decl.dataField]
      if (typeof raw !== 'string') continue

      const declaredMediaType = decl.mediaType ?? (decl.mediaTypeField ? String(obj[decl.mediaTypeField] ?? '') : '')
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(Buffer.from(raw, 'base64'))
      } catch {
        return { content: textResult(`E_BAD_IMAGE: "${cap.id}" field "${decl.dataField}" is not valid base64`), isError: true }
      }

      if (bytes.byteLength > maxImageBytes) {
        return {
          content: textResult(`E_IMAGE_TOO_LARGE: the image from "${cap.id}" (field "${decl.dataField}") is ${bytes.byteLength} bytes, over the ${maxImageBytes}-byte limit`),
          isError: true,
        }
      }

      const sniffed = sniffImageMediaType(bytes)
      if (!sniffed || sniffed !== declaredMediaType) {
        return {
          content: textResult(
            `E_IMAGE_TYPE_MISMATCH: "${cap.id}" declared "${declaredMediaType || '(no media type)'}" for field "${decl.dataField}" but the bytes are ${sniffed ?? 'not a recognised image format'}`,
          ),
          isError: true,
        }
      }

      const stored = blobs.put(bytes, sniffed)
      obj[decl.dataField] = '[stored as an image block below]'
      imageBlocks.push({
        type: 'image',
        blobId: stored.id,
        mediaType: sniffed,
        bytes: stored.bytes,
        ...(stored.width !== null ? { width: stored.width } : {}),
        ...(stored.height !== null ? { height: stored.height } : {}),
      })
    }

    return { content: [{ type: 'text', text: JSON.stringify(obj) }, ...imageBlocks], isError: false }
  }

  // ---------------------------------------------------------------------
  // Tool-call resolution — approval gate, lease acquisition, invoke().
  // Moved from `agent/loop/run.ts`'s `processPendingCalls`, unchanged: every
  // tool call the harness's own step left unresolved (ALL of them —
  // `harness/tools.ts` gives every tool no `execute`) is resolved here.
  // ---------------------------------------------------------------------

  type ToolStepResult = { kind: 'continue' } | { kind: 'paused' } | { kind: 'stop'; outcome: RunOutcome }

  async function processPendingCalls(pending: PendingToolCall[]): Promise<ToolStepResult> {
    for (const call of pending) {
      if (deps.isCancelled()) return { kind: 'stop', outcome: finishCancelled() }

      const capabilityId = toolPolicy.capabilityIdForToolName.get(call.name)
      const cap = capabilityId ? registry.get(capabilityId) : undefined
      if (!capabilityId || !cap) {
        appendToolResult(call.id, textResult(`"${call.name}" is not a tool this agent may use`), true)
        continue
      }
      if (toolPolicy.isCapabilityCurrentlyAllowed && !toolPolicy.isCapabilityCurrentlyAllowed(capabilityId)) {
        appendToolResult(call.id, textResult(`"${call.name}" is no longer within this run's authority (its parent's grants narrowed)`), true)
        continue
      }

      const needsApproval = cap.effect === 'destructive' || toolPolicy.requiresApprovalCapabilityIds.has(capabilityId)
      if (needsApproval) {
        if (toolPolicy.onApprovalRequired === 'deny') {
          appendToolResult(
            call.id,
            textResult(`denied: this thread auto-denies destructive capabilities instead of pausing for approval (onApprovalRequired: deny) — "${call.name}" was not run`),
            true,
          )
          audit?.record({ userId: null, action: 'agent.approval.auto-denied', target: run.id, meta: { capabilityId, threadId: thread.id } })
          deps.notifyAutoDenied?.({ capabilityId, toolCallId: call.id })
          continue
        }
        let approval = approvals.findByToolCallId(run.id, call.id)
        if (!approval) {
          approval = approvals.create({ runId: run.id, capabilityId, toolCallId: call.id, input: call.input })
          deps.emit({ type: 'approval.requested', approvalId: approval.id, capabilityId, input: call.input, expiresAt: approval.expiresAt })
          run = threads.updateRun(run.id, { status: 'paused' })
          return { kind: 'paused' }
        }
        if (approval.status === 'pending') {
          return { kind: 'paused' }
        }
        if (approval.status === 'denied' || approval.status === 'expired') {
          deps.emit({ type: 'approval.resolved', approvalId: approval.id, status: approval.status })
          appendToolResult(call.id, textResult(approval.status === 'expired' ? 'the approval expired without a decision — treated as denied' : 'denied by an operator'), true)
          continue
        }
        deps.emit({ type: 'approval.resolved', approvalId: approval.id, status: 'approved' })
        run = threads.updateRun(run.id, { status: 'running' })
      }

      const deviceId = extractDeviceId(call.input)
      if (deviceId && cap.lease === 'control') {
        const revokedMessage = checkLeaseRevoked(deviceId)
        if (revokedMessage) {
          appendToolResult(call.id, textResult(revokedMessage), true)
          continue
        }
        ensureControlLease(deviceId)
      }

      const startedAt = nowMs()
      deps.emit({ type: 'tool.started', callId: call.id, capabilityId, input: call.input })
      const result = await invoke(cap, capabilityContext, call.input, audit ? { audit } : undefined)
      const durationMs = nowMs() - startedAt
      deps.emit({ type: 'tool.finished', callId: call.id, capabilityId, ok: result.ok, durationMs })
      if (result.ok) {
        const { content, isError } = buildToolResultContent(cap, result.output)
        appendToolResult(call.id, content, isError)
      } else {
        appendToolResult(call.id, textResult(`${result.error.code}: ${result.error.message}`), true)
      }
    }
    return { kind: 'continue' }
  }

  // ---------------------------------------------------------------------
  // One provider turn — the harness's `runAgentLoop`, capped to exactly one
  // step per call (plan 76 §4.2: "only the innermost 'drive the model' call
  // changes"). Enkaku's own retry/backoff/compaction-on-overflow wraps it,
  // exactly as `agent/loop/run.ts`'s `streamOnce` used to wrap its own
  // manual stream parsing.
  // ---------------------------------------------------------------------

  async function runOneModelStep(): Promise<{ kind: 'continue' } | { kind: 'stop'; outcome: RunOutcome }> {
    if (run.steps >= config.maxSteps) return { kind: 'stop', outcome: finish('max-steps', null, `reached the ${config.maxSteps}-step limit`, run.usage) }
    if (deps.treeBudget) {
      if (deps.treeBudget.spentSoFar() >= deps.treeBudget.maxOutputTokens) {
        return { kind: 'stop', outcome: finish('max-tokens', null, `this run tree reached its shared ${deps.treeBudget.maxOutputTokens}-token output budget`, run.usage) }
      }
    } else if ((run.usage?.outputTokens ?? 0) >= config.maxOutputTokens) {
      return { kind: 'stop', outcome: finish('max-tokens', null, `reached the ${config.maxOutputTokens}-token output limit`, run.usage) }
    }

    const model: LanguageModel = provider.languageModel(config.model)
    const providerOptions = buildProviderOptions(deps.connectorKind, config)
    const limit = Math.max(1, Math.floor(deps.contextWindow * 0.9))
    const reserve = Math.max(1, Math.floor(deps.contextWindow * 0.05))
    const summarizeAt = Math.max(1, Math.floor(deps.contextWindow * config.compactAtRatio))

    let attempts = 0
    let forcedCompactionUsed = false
    let forcedHistory: ModelMessage[] | null = null

    for (;;) {
      if (deps.isCancelled()) return { kind: 'stop', outcome: finishCancelled() }
      const elapsedSec = nowSecOf(nowMs) - runStartedAtSec
      if (elapsedSec >= config.maxRunSeconds) return { kind: 'stop', outcome: finish('max-seconds', null, 'wall-clock budget exhausted', run.usage) }

      const history: ModelMessage[] = forcedHistory ?? toModelMessages(threads.listMessages(thread.id), { resolveBlob, maxImagesPerRequest: config.maxImagesPerRequest })
      forcedHistory = null

      let capturedUsage: AgentUsage | null = null
      const consumeStep = async (result: ReturnType<typeof streamText>): Promise<{ aborted: boolean }> => {
        let aborted = false
        try {
          for await (const part of result.fullStream) {
            if (deps.isCancelled()) {
              aborted = true
              break
            }
            if (part.type === 'abort') {
              aborted = true
              break
            } else if (part.type === 'text-delta') {
              deps.emit({ type: 'delta', kind: 'text', text: part.text })
            } else if (part.type === 'reasoning-delta') {
              deps.emit({ type: 'delta', kind: 'thinking', text: part.text })
            } else if (part.type === 'finish') {
              const u = part.totalUsage
              capturedUsage = {
                inputTokens: u.inputTokens ?? 0,
                outputTokens: u.outputTokens ?? 0,
                cacheReadTokens: u.inputTokenDetails.cacheReadTokens ?? 0,
                cacheWriteTokens: u.inputTokenDetails.cacheWriteTokens ?? 0,
                costUsd: null,
              }
            }
          }
        } catch (e) {
          if (deps.isCancelled()) aborted = true
          else throw e
        }
        return { aborted }
      }

      let loopResult: Awaited<ReturnType<typeof runAgentLoop>>
      try {
        loopResult = await runAgentLoop(
          {
            model,
            system: config.systemPrompt,
            tools: toolSet,
            messages: history,
            maxSteps: 1,
            compaction: { limit, reserve },
            summarizeAt,
            compactWire: (msgs: ModelMessage[]) => compact(model, msgs),
            signal: deps.signal,
            providerOptions,
          },
          consumeStep,
        )
      } catch (err) {
        if (deps.isCancelled()) return { kind: 'stop', outcome: finishCancelled() }
        const classified = classifyError(err)

        if (classified.errorClass === 'auth') {
          deps.markConnectorUnauthenticated?.(classified.message)
          return { kind: 'stop', outcome: finish('error', 'auth', classified.message, run.usage) }
        }
        if (classified.errorClass === 'context-overflow') {
          // §3.8: "compact and retry once; if it recurs, stop" — forces a compaction even if under
          // the ratio threshold, by feeding the retried call an explicitly pre-compacted history
          // rather than relying on the normal `summarizeAt` gate (which just failed to prevent this).
          if (forcedCompactionUsed) {
            return { kind: 'stop', outcome: finish('error', 'context-overflow', 'the context window was exceeded even after compaction', run.usage) }
          }
          forcedCompactionUsed = true
          forcedHistory = await compact(model, history)
          continue
        }
        if (classified.errorClass === 'rate-limit' || classified.errorClass === 'overloaded') {
          attempts += 1
          if (attempts > MAX_RETRIES_PER_STEP) {
            return { kind: 'stop', outcome: finish('error', classified.errorClass, classified.message, run.usage) }
          }
          const backoff = Math.min(RETRY_BACKOFF_CAP_MS, 500 * 2 ** attempts)
          const waitMs = retryAfterMs(err) ?? backoff
          const remainingMs = config.maxRunSeconds * 1000 - (nowSecOf(nowMs) - runStartedAtSec) * 1000
          if (remainingMs <= 0) return { kind: 'stop', outcome: finish('max-seconds', null, 'wall-clock budget exhausted while retrying', run.usage) }
          await sleep(Math.max(0, Math.min(waitMs, remainingMs)))
          continue // retried — never counts as a new step
        }
        return { kind: 'stop', outcome: finish('error', classified.errorClass, classified.message, run.usage) }
      }

      if (loopResult.stop === 'aborted') {
        if (deps.isCancelled()) return { kind: 'stop', outcome: finishCancelled() }
        return { kind: 'stop', outcome: finish('error', null, 'the model call was aborted', run.usage) }
      }

      const assistantMsg = loopResult.response.find((m: ModelMessage): m is Extract<ModelMessage, { role: 'assistant' }> => m.role === 'assistant')
      const blocks = assistantMsg ? assistantBlocksFromModelMessage(assistantMsg.content) : []
      if (blocks.length > 0) {
        const assistantMessage = threads.appendMessage({ threadId: thread.id, runId: run.id, role: 'assistant', content: blocks })
        deps.emit({ type: 'message', message: assistantMessage })
      }
      const usage = capturedUsage ?? emptyUsage()
      run = threads.updateRun(run.id, { steps: run.steps + 1, usage: sumUsage(run.usage, usage) })

      const toolCalls = blocks.filter((b): b is Extract<AgentContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      if (toolCalls.length === 0) return { kind: 'stop', outcome: finish('done', null, null, run.usage) }

      stepSummaries.push(summarizeStep(loopResult.response))
      const loopDecision = detectLoop(stepSummaries)
      if (loopDecision) return { kind: 'stop', outcome: finish('loop-detected', null, loopDecision.reason, run.usage) }

      return { kind: 'continue' }
    }
  }

  // ---------------------------------------------------------------------
  // Inbox drain (plan 67 §3.3, §4.3) — the ONLY place a message enters a run.
  // ---------------------------------------------------------------------

  function formatInboxItem(item: InboxItem): string {
    if (item.kind === 'child-result') {
      const b = item.body as { agentName?: string; status?: string; stopReason?: string | null; output?: string | null }
      const stop = b.stopReason ? `, ${b.stopReason}` : ''
      return `[child run finished — ${b.agentName ?? 'agent'}, status: ${b.status ?? 'unknown'}${stop}] ${b.output ?? '(no output)'}`
    }
    const b = item.body as { text?: string; fromAgentName?: string }
    const from = item.fromRunId ? ` from ${b.fromAgentName ?? 'run'} ${item.fromRunId}` : ''
    return `[message${from}] ${b.text ?? ''}`
  }

  function drainInbox(): void {
    if (!deps.inbox) return
    const delivered = deps.inbox.drain(run.id)
    for (const item of delivered) {
      const msg = threads.appendMessage({ threadId: thread.id, runId: run.id, role: 'user', content: [{ type: 'text', text: formatInboxItem(item) }] })
      deps.emit({ type: 'message', message: msg })
      deps.emit({ type: 'inbox.delivered', inboxId: item.id, fromRunId: item.fromRunId, kind: item.kind })
    }
  }

  // ---------------------------------------------------------------------
  // The loop itself (plan 66 §3.2, plan 67 §3.3, §4.3).
  // ---------------------------------------------------------------------

  for (;;) {
    if (deps.isCancelled()) return finishCancelled()
    const elapsedSec = nowSecOf(nowMs) - runStartedAtSec
    if (elapsedSec >= config.maxRunSeconds) return finish('max-seconds', null, 'wall-clock budget exhausted', run.usage)

    const pending = extractPendingToolCalls(threads.listMessages(thread.id))
    if (pending.length > 0) {
      const result = await processPendingCalls(pending)
      if (result.kind === 'paused') {
        releaseAcquiredLeases()
        return { status: 'paused', stopReason: null, errorClass: null, error: null, usage: run.usage }
      }
      if (result.kind === 'stop') return result.outcome
      continue
    }

    // Plan 67 §3.3, §4.3: drained at a genuine turn boundary — ONLY once every `tool_use` from the
    // last assistant message already has its `tool_result` (the check above). Plan 76 §3.7's own
    // constraint tightens this further than the old hand-rolled Anthropic JSON builder needed: the
    // AI SDK's own message validation (`streamText`, reached on every call now) rejects a wire where
    // ANY message sits between a `tool_use` and the `tool_result` answering it — draining here,
    // rather than unconditionally at the top of the loop (`agent/loop/run.ts`'s original ordering),
    // is what keeps an inbox delivery from ever landing in that gap.
    drainInbox()
    if (deps.isCancelled()) return finishCancelled()

    const stepResult = await runOneModelStep()
    if (stepResult.kind === 'stop') return stepResult.outcome
  }
}
