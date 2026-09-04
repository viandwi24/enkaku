import { resolveAgentConfig, type Agent, type AgentTreeNode, type FarmSettings, type ServerMessage } from '@enkaku/protocol'
import type { AgentApproval, AgentContentBlock, AgentImageMediaType, AgentMessage, AgentRun, AgentRunStatus, AgentThread } from '@enkaku/protocol'
import type { CapabilityRegistry } from '../capability/registry'
import type { CapabilityContextDeps, AgentSpawnInput, AgentSpawnResult, AgentStatusResult, AgentCancelResult, AgentTreeOps } from '../capability/context'
import type { AuditLogger } from '../auth/audit'
import type { Role } from '../auth/service'
import type { ActivityRegistry } from '../activity/registry'
import type { ControlPolicySettings } from '../activity/policy'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import type { AgentStore } from './agent-store'
import type { BlobStore } from './blob/store'
import type { ConnectorStore } from './connector-store'
import { createProviderAdapter, type ModelListCache, type ProviderConnectionDeps } from './provider'
import type { ProviderAdapter } from './provider/types'
import type { ApprovalStore } from './approval/store'
import type { ThreadStore } from './thread/store'
import type { TreeStore } from './tree/store'
import { checkDepthCap, checkTreeSizeCap } from './tree/caps'
import { effectiveAuthorityForRun, type AuthorityLookupDeps } from './tree/authority'
import { createAgentCapabilityContext, type TreeRunContext } from './harness/context'
import { buildToolSet } from './harness/tools'
import { executeRun, type InboxDrain, type RunEmitEvent, type ToolPolicy } from './harness/run'
import { assembleSystemPrompt } from './plugins'

/**
 * Orchestrates runs (plan 66 §4.3, §4.4; plan 67 spawns/messages/cascade):
 * concurrency (`maxConcurrentRuns` queues rather than rejects), cancellation
 * (an in-memory flag per run — meaningful only while the process holding it
 * is alive, which is exactly `agent_runs.status = 'running'`'s own
 * lifetime), and restart recovery. `harness/run.ts`'s `executeRun` is the
 * algorithm; this module is everything around calling it: building the
 * provider, the tool policy, the capability context, turning its emitted
 * events into broadcasts — and, for plan 67, the ONLY thing with the
 * machinery to launch and await a run, which is why `agent.spawn`'s
 * `waitFor: true`, cascading cancellation, and the tree's shared device
 * lock all live here rather than in `capability/agent.ts`.
 */

export interface AgentRunner {
  /** `POST /api/v1/threads` (plan 66 §4.4). `deviceScope` (plan 73 §4.6) narrows every run this thread ever starts. */
  createThread(input: { agentId: string; title?: string | null; deviceScope?: string[] | null; createdBy?: string | null }): AgentThread
  /** `POST /api/v1/threads/:id/messages` — appends the user's message and starts (or queues) a run.
   * `attachments` (plan 70 §3.5, §4.2) names blob ids already uploaded via `POST /api/v1/blobs`. */
  postMessage(threadId: string, text: string, postedBy: string | null, attachments?: string[]): AgentRun
  /** `POST /api/v1/runs/:id/cancel`, `agent.run.cancel`, and `agent.cancel` (plan 66 §3.7, plan 67
   * §3.5) — cascades to every descendant, depth-first, before itself. Idempotent. */
  cancelRun(runId: string, cancelledBy: string | null): void
  /** `POST /api/v1/approvals/:id` (plan 66 §3.6) — resumes the paused run on a decision. */
  decideApproval(approvalId: string, decision: 'approve' | 'deny', decidedBy: string | null): AgentApproval
  /** Called once at boot: `running` rows are marked `interrupted`; `paused` rows are left alone
   * (plan 66 §4.3, criterion 9); every recovered run's still-active descendants are cascaded too
   * (plan 67 §3.5, criterion 13 — "a parent... interrupted by a restart cancels its children"). */
  recoverAfterRestart(): void
  /** The shared reaper cadence calls this instead of running its own timer (plan 66 §4.3). */
  sweepExpiredApprovals(): void
  /** `GET /api/v1/runs/:id/tree` (plan 67 §4.4, §4.5) — the flat node list Studio's tree view
   * reconstructs into a tree client-side, including which devices each node currently drives. */
  getTree(anyRunIdInTree: string): { rootRunId: string; nodes: AgentTreeNode[] }
  /** Plan 68 §3.5, §4.2 — a schedule firing: resolves the thread (new or reused), appends the prompt
   * as the firing's user message, and starts (or queues) a run through the EXACT SAME `launch`/
   * `enqueue` machinery `postMessage` uses. No parallel execution path — a scheduled run is an
   * ordinary run (§3.5): same budgets, same approval gate (via the thread's own `onApprovalRequired`),
   * same cancellation, same audit. */
  runScheduledFiring(input: ScheduledFiringInput): ScheduledFiringResult
  /** Farm-wide count of scheduled-origin runs currently active — the scheduled-concurrency ceiling (plan 68 §3.3). */
  countActiveScheduledRuns(): number
  /** Farm-wide output tokens spent by scheduled-origin runs since `windowStart` — the spend cap (plan 68 §3.3). */
  spentOutputTokensSince(windowStart: Date): number
  /** A run's current status, or null if it no longer exists — for a schedule's own overlap tracking (plan 68 §4.2). */
  runStatus(runId: string): AgentRunStatus | null
}

/** Plan 68 §4.2 — `AgentRunner.runScheduledFiring`'s input, built by `schedules/runner.ts`'s agent branch. */
export interface ScheduledFiringInput {
  agentId: string
  /** For audit/attribution — `createdBy` on the thread when a fresh one is created. */
  scheduleId: string
  prompt: string
  threadMode: 'new' | 'continue'
  /** The reused thread id when `threadMode === 'continue'` and one already exists; null otherwise (including the schedule's very first firing). */
  existingThreadId: string | null
  onApprovalRequired: 'deny' | 'pause'
  /** Narrows the run's device grants (plan 68 §3.1) — null/empty means no extra narrowing (the agent's own grants apply unchanged). */
  deviceIds: string[] | null
}

export interface ScheduledFiringResult {
  runId: string
  threadId: string
}

export interface RunnerDeps {
  threads: ThreadStore
  approvals: ApprovalStore
  agents: AgentStore
  connectors: ConnectorStore
  registry: CapabilityRegistry
  capContextDeps: CapabilityContextDeps
  activities: ActivityRegistry
  controlSettings: () => ControlPolicySettings
  settings: () => FarmSettings
  modelListCache: ModelListCache
  audit?: AuditLogger
  /** Resolves a userId to its ACL role — same accessor `daemon.ts` already threads through the WS router. */
  roleOf: (userId: string | null) => Role
  /** Broadcasts one event for a run, addressed to its thread — wired to `ws-handlers-agent.ts`'s per-thread fan-out. */
  emit: (thread: AgentThread, run: AgentRun, event: RunEmitEvent) => void
  onRunStarted: (thread: AgentThread, run: AgentRun) => void
  onRunFinished: (thread: AgentThread, run: AgentRun) => void
  /** Plan 67 §4.1 — the run tree's inbox and spawn-grants store. */
  tree: TreeStore
  /** Plan 70 §4.1, §4.4 — content-addressed image storage, threaded straight through to every `executeRun` call. Optional so every pre-plan-70 test keeps compiling unedited; `daemon.ts` always supplies it. */
  blobs?: BlobStore
  /** Broadcasts an already-built message to every subscriber of a THREAD (not necessarily the
   * caller's own) — plan 67's `agent.child.started`/`.finished` are
   * addressed to a DIFFERENT run's thread than the one whose execution produced them (the target's,
   * or the parent's), which `emit` above cannot express. Wired to `ws-handlers-agent.ts`'s
   * `publishRaw`, the same seam `POST /approvals/:id` already uses for the same reason. */
  publishToThread: (threadId: string, msg: ServerMessage) => void
  /** Injectable for tests — never hits the network when a fake is supplied. */
  fetch?: typeof fetch
  /** Overrides the real `createProviderAdapter` — tests inject a scripted `ProviderAdapter` (`provider/fake.ts`) so a full run-through-runner never makes a network call. Production callers never pass this. */
  createProvider?: (kind: import('@enkaku/protocol').ConnectorKind, connDeps: ProviderConnectionDeps) => ProviderAdapter
  /**
   * Plan 68 §3.5 — writes an in-app notification when a run auto-denies a
   * destructive call because its thread's `onApprovalRequired === 'deny'`
   * — the record of the attempt (§3.5: "refused immediately and recorded
   * in a notification"), distinct from `notify.send` (never rate-limited;
   * not an agent tool call — a run does not choose whether this happens).
   * Optional so every pre-plan-68 test keeps compiling unedited; a real
   * host always supplies it (`daemon.ts`).
   */
  notifyAutoDenied?: (info: { thread: AgentThread; run: AgentRun; agent: Agent; capabilityId: string; toolCallId: string }) => void
  log: Logger
}

interface ActiveRun {
  controller: { cancelled: boolean; cancelledBy: string | null }
  promise: Promise<void>
  /** Aborts the live `streamText` call the instant this run is cancelled (plan 76 §3.7) — the
   * harness's `runAgentLoop` takes a real `AbortSignal`, unlike the old hand-rolled stream parser,
   * which only ever polled `isCancelled()`. `undefined` for a settled/never-launched entry
   * (`settleNeverRanAsCancelled`, restart recovery) — nothing is streaming for those. */
  ac?: AbortController
}

export function createAgentRunner(deps: RunnerDeps): AgentRunner {
  const { threads, approvals, agents, connectors, registry, capContextDeps, activities, controlSettings, settings, modelListCache, tree, audit, log } = deps

  // In-memory only — meaningful exactly as long as the run's own executeRun call is alive in
  // THIS process, which is precisely when `agent_runs.status` is 'running' or 'paused'-about-to-run.
  const active = new Map<string, ActiveRun>()
  // Per-agent FIFO of runIds waiting for a concurrency slot (plan 66 §4.4 — "exceeding it queues rather than rejects").
  const queues = new Map<string, string[]>()
  const runOwnerAgentId = new Map<string, string>()
  // Plan 67 §3.2 — resolved once a queued/paused run FINALLY becomes active (or settles without
  // ever becoming active, e.g. cancelled while queued) so `awaitRunTerminal` (a parked `waitFor:
  // true` spawn) never has to poll: it just waits on this promise instead.
  const queueWaiters = new Map<string, Array<(entry: ActiveRun) => void>>()
  // Plan 67 §3.7 — which run(s) currently hold the tree's shared "actively driving" claim on a
  // device. An ancestor/descendant PAIR may both claim the same device (a child may use what its
  // parent holds); two UNRELATED runs (siblings, cousins) may not — the second is refused, naming
  // the first (criterion 14). Cleared as each claiming run finishes.
  const deviceHolders = new Map<string, Set<string>>()

  function activeCountFor(agentId: string): number {
    let n = 0
    for (const [runId, agentIdOfRun] of runOwnerAgentId) {
      if (agentIdOfRun === agentId && active.has(runId)) n++
    }
    return n
  }

  function ownerRoleOf(agent: Agent): Role {
    // Same accessor `daemon.ts` already threads through the WS router (`roleOf`): in local mode it
    // ignores the userId and always answers 'admin' (one implicit admin); in server mode a null
    // owner falls back to the least-privileged 'operator' rather than silently granting admin.
    return deps.roleOf(agent.ownerId)
  }

  // -----------------------------------------------------------------------
  // Plan 67 §3.4 — the live authority lookup every tree-aware context reads.
  // -----------------------------------------------------------------------

  const authorityDeps: AuthorityLookupDeps = {
    getRun: (id) => threads.getRun(id),
    getThread: (id) => threads.getThread(id),
    getAgent: (id) => agents.get(id),
    roleOf: (ownerId) => deps.roleOf(ownerId),
  }

  /** True when `candidateRunId` is a descendant of `ancestorRunId`, at any depth — bounded by the
   * tree's own depth cap, so this never walks far (plan 67 §3.4, §3.7, §4.2). */
  function isDescendantOf(candidateRunId: string, ancestorRunId: string): boolean {
    let cur = threads.getRun(candidateRunId)
    let hops = 0
    while (cur?.parentRunId && hops < 16) {
      if (cur.parentRunId === ancestorRunId) return true
      cur = threads.getRun(cur.parentRunId)
      hops++
    }
    return false
  }

  function areRelated(a: string, b: string): boolean {
    return a === b || isDescendantOf(a, b) || isDescendantOf(b, a)
  }

  function describeRunLabel(runId: string): string {
    const run = threads.getRun(runId)
    const thread = run ? threads.getThread(run.threadId) : null
    const agent = thread ? agents.get(thread.agentId) : null
    return agent ? `${agent.name} (run ${runId})` : `run ${runId}`
  }

  // -----------------------------------------------------------------------
  // Plan 67 §3.7, reworked by plan 205 §4.4, §5 step 205.8 — the tree's shared
  // device lock (claim/release on top of the activity registry, which by
  // itself has no notion of "two DIFFERENT trees" — every run in one tree
  // shares the SAME `agent:<rootRunId>` marker, so the registry's own policy
  // table cannot tell an ancestor/descendant pair using it together from two
  // unrelated trees fighting over it).
  // -----------------------------------------------------------------------

  /** Returns null (granted, and claimed) or a label naming the unrelated run that already drives it. */
  function claimDevice(deviceId: string, runId: string): string | null {
    const holders = deviceHolders.get(deviceId)
    if (!holders || holders.size === 0) {
      deviceHolders.set(deviceId, new Set([runId]))
      return null
    }
    for (const holder of holders) {
      if (!areRelated(holder, runId)) return describeRunLabel(holder)
    }
    holders.add(runId)
    return null
  }

  /** Releases THIS run's claim; the shared `agent:<rootRunId>` activity is ended only once no
   * related run is still using it (an ancestor may still be using the device). */
  function releaseDevice(deviceId: string, runId: string, agentActivityId: string): void {
    const holders = deviceHolders.get(deviceId)
    if (!holders) return
    holders.delete(runId)
    if (holders.size === 0) {
      deviceHolders.delete(deviceId)
      activities.end(deviceId, agentActivityId)
    }
  }

  function buildDeviceLock(runId: string, rootRunId: string): { claim(deviceId: string): string | null; release(deviceId: string): void } {
    const agentActivityId = `agent:${rootRunId}`
    return {
      claim: (deviceId) => claimDevice(deviceId, runId),
      release: (deviceId) => releaseDevice(deviceId, runId, agentActivityId),
    }
  }

  /** Plan 67 §4.2 — the `AgentTreeOps` a run's capability context exposes as `ctx.agentTree`, bound
   * to THIS run already (no `fromRunId`/`callerRunId` parameter anywhere it is used). */
  function buildAgentTreeOps(callerRun: AgentRun): AgentTreeOps {
    return {
      spawn: (input) => spawnChild(callerRun, input),
      send: (targetRunId, message) => sendMessage(callerRun, targetRunId, message),
      reply: (message) => replyMessage(callerRun, message),
      status: (targetRunId) => statusOf(callerRun, targetRunId),
      cancel: (targetRunId) => cancelDescendantForCapability(callerRun, targetRunId),
    }
  }

  async function buildRunEnv(agent: Agent, thread: AgentThread, run: AgentRun) {
    const config = resolveAgentConfig(settings(), agent)
    if (!config.connectorId) {
      throw new EnkakuError('E_NO_CONNECTOR', 'this agent has no connector configured (and the farm has no default connector)')
    }
    const connector = connectors.get(config.connectorId)
    if (!connector) throw new EnkakuError('E_NO_CONNECTOR', `connector ${config.connectorId} no longer exists`)
    const apiKey = connectors.resolveApiKey(config.connectorId)
    if (!apiKey) throw new EnkakuError('E_NO_CREDENTIAL', 'this connector has no stored credential and no fallback env var is set')

    const providerDeps = { apiKey, baseUrl: connector.baseUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) }
    const provider = (deps.createProvider ?? createProviderAdapter)(connector.kind, providerDeps)
    const { models } = await modelListCache.get(connector.id, connector.kind, providerDeps)
    const modelInfo = models.find((m) => m.id === config.model)
    const contextWindow = modelInfo?.contextWindow ?? 200_000

    // Plan 67 §3.4 — the run's LIVE effective authority (its own agent record intersected with
    // every ancestor's, walked fresh): for a root run (no parent) this is byte-for-byte
    // `agent.tools` — the same set plan 66 always used — so a plain, non-spawned run is unaffected.
    const authority = effectiveAuthorityForRun(authorityDeps, run.id)
    const caps = authority.tools.map((id) => registry.get(id)).filter((c): c is NonNullable<typeof c> => c !== undefined)
    const { tools: toolSet, capabilityIdForToolName } = buildToolSet(caps, connector.kind)
    // Plan 77 §4.5 — the agent's own instructions, then every enabled plugin's STATIC prompt
    // section, in registry order, gated to the capabilities this run actually holds (criterion
    // 12). Pure string work over already-resolved values, so this changes nothing about caching:
    // for the SAME agent tools the result is byte-identical every time (criterion 9, 13).
    const promptedConfig = { ...config, systemPrompt: assembleSystemPrompt(config.systemPrompt, new Set(caps.map((c) => c.id))) }
    const toolPolicy: ToolPolicy = {
      capabilityIdForToolName,
      requiresApprovalCapabilityIds: new Set(agent.requiresApproval),
      // Plan 68 §3.5 — the THREAD's own setting, not the agent's: a schedule sets this per firing
      // (its own `onApprovalRequired`), every other origin ('chat', 'spawn') defaults to 'pause' —
      // a human in a chat is already watching, so there is no "nobody will answer" case to degrade
      // out of. Byte-for-byte plan 66's original behaviour for every non-schedule thread.
      onApprovalRequired: thread.onApprovalRequired,
      // Criterion 4: re-checked live at every invoke, not the snapshot above — a running parent
      // demoted (or narrowed) mid-run must narrow this run immediately.
      isCapabilityCurrentlyAllowed: (capabilityId) => effectiveAuthorityForRun(authorityDeps, run.id).tools.includes(capabilityId),
    }

    const ownerRole = ownerRoleOf(agent)
    const treeContext: TreeRunContext = {
      runId: run.id,
      agentActivityId: `agent:${run.rootRunId}`,
      lookup: authorityDeps,
      deviceIdsOverride: run.deviceGrantsOverride,
      deviceLock: buildDeviceLock(run.id, run.rootRunId),
      treeOps: buildAgentTreeOps(run),
    }
    const capabilityContext = createAgentCapabilityContext(capContextDeps, agent, ownerRole, treeContext)
    const markConnectorUnauthenticated = (message: string) => connectors.markUnauthenticated(connector.id, message)

    // Plan 67 §3.6 — the tree's SHARED token budget: the ROOT's own resolved `maxOutputTokens`,
    // spent by every run sharing this run's `rootRunId`.
    const rootConfig = ((): typeof config => {
      if (run.rootRunId === run.id) return config
      const rootRun = threads.getRun(run.rootRunId)
      const rootThread = rootRun ? threads.getThread(rootRun.threadId) : null
      const rootAgent = rootThread ? agents.get(rootThread.agentId) : null
      return rootAgent ? resolveAgentConfig(settings(), rootAgent) : config
    })()
    const treeBudget = {
      maxOutputTokens: rootConfig.maxOutputTokens,
      spentSoFar: () => threads.listRunsForRoot(run.rootRunId).reduce((sum, r) => sum + (r.usage?.outputTokens ?? 0), 0),
    }

    const inbox: InboxDrain = { drain: (runId) => tree.drain(runId) }

    return {
      config: promptedConfig,
      provider,
      connectorKind: connector.kind,
      toolSet,
      toolPolicy,
      contextWindow,
      capabilityContext,
      markConnectorUnauthenticated,
      treeBudget,
      inbox,
      rootRunId: run.rootRunId,
      deviceLock: treeContext.deviceLock!,
    }
  }

  function forget(runId: string): void {
    active.delete(runId)
    runOwnerAgentId.delete(runId)
  }

  /** Resolves any `awaitRunTerminal` callers parked waiting for this run to become active — plan
   * 67 §3.2's parked `waitFor: true` spawn is one of them, and it must never poll. */
  function notifyRunActive(runId: string, entry: ActiveRun): void {
    const waiters = queueWaiters.get(runId)
    if (!waiters) return
    queueWaiters.delete(runId)
    for (const resolve of waiters) resolve(entry)
  }

  /** Plan 67 §3.5, criterion 13 — "a parent that fails, is interrupted, or exceeds a budget
   * cancels its children"; only a genuinely successful completion leaves detached (`waitFor:
   * false`) children running, which is the whole point of that shape (§3.2). Never called for
   * `paused` (not terminal — it is expected to resume). */
  function cascadeIfAbnormal(finishedRun: AgentRun): void {
    if (finishedRun.status === 'failed' || finishedRun.status === 'cancelled') {
      for (const child of threads.listChildRuns(finishedRun.id)) cancelRun(child.id, 'system:parent-terminated')
    }
  }

  /** Runs one `AgentRun` to completion (or a pause), then drains this agent's queue. Never throws — a setup failure is recorded as a failed run instead. */
  function launch(agent: Agent, thread: AgentThread, run: AgentRun): void {
    const controller = { cancelled: false, cancelledBy: null as string | null }
    const ac = new AbortController()
    runOwnerAgentId.set(run.id, agent.id)

    const promise = (async () => {
      let env: Awaited<ReturnType<typeof buildRunEnv>>
      try {
        env = await buildRunEnv(agent, thread, run)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        threads.updateRun(run.id, { status: 'failed', stopReason: 'error', errorClass: null, error: message, finishedAt: new Date() })
        const finished = threads.mustGetRun(run.id)
        deps.onRunFinished(thread, finished)
        cascadeIfAbnormal(finished)
        return
      }

      deps.onRunStarted(thread, threads.getRun(run.id) ?? run)
      if (run.parentRunId) {
        deps.publishToThread(threads.getRun(run.parentRunId) ? threads.mustGetRun(run.parentRunId).threadId : thread.id, {
          type: 'agent.child.started',
          payload: { parentRunId: run.parentRunId, childRunId: run.id, childThreadId: thread.id, agentId: agent.id, depth: run.depth },
        })
      }
      try {
        await executeRun({
          thread,
          run,
          agent,
          config: env.config,
          contextWindow: env.contextWindow,
          provider: env.provider,
          connectorKind: env.connectorKind,
          toolSet: env.toolSet,
          toolPolicy: env.toolPolicy,
          registry,
          capabilityContext: env.capabilityContext,
          threads,
          approvals,
          activities,
          controlSettings,
          markConnectorUnauthenticated: env.markConnectorUnauthenticated,
          emit: (event) => deps.emit(thread, threads.getRun(run.id) ?? run, event),
          isCancelled: () => controller.cancelled,
          cancelledBy: () => controller.cancelledBy,
          signal: ac.signal,
          rootRunId: env.rootRunId,
          treeBudget: env.treeBudget,
          inbox: env.inbox,
          deviceLock: env.deviceLock,
          ...(audit ? { audit } : {}),
          ...(deps.blobs ? { blobs: deps.blobs } : {}),
          ...(deps.notifyAutoDenied
            ? { notifyAutoDenied: (info: { capabilityId: string; toolCallId: string }) => deps.notifyAutoDenied!({ thread, run: threads.getRun(run.id) ?? run, agent, ...info }) }
            : {}),
        })
      } catch (err) {
        log.error(`agent run ${run.id} threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`)
        threads.updateRun(run.id, { status: 'failed', stopReason: 'error', errorClass: null, error: err instanceof Error ? err.message : String(err), finishedAt: new Date() })
      }
      const finished = threads.mustGetRun(run.id)
      deps.onRunFinished(thread, finished)
      if (finished.status !== 'paused') cascadeIfAbnormal(finished)

      if (run.parentRunId) {
        const parentRun = threads.getRun(run.parentRunId)
        if (parentRun) {
          deps.publishToThread(threads.getThread(parentRun.threadId)?.id ?? parentRun.threadId, {
            type: 'agent.child.finished',
            payload: { parentRunId: run.parentRunId, childRunId: run.id, status: finished.status, stopReason: finished.stopReason },
          })
        }
        // A DETACHED child (`awaited === false`) that reaches a TERMINAL state delivers its result
        // to the parent via the inbox (plan 67 §3.2, §3.3) — an AWAITED (`waitFor: true`) parent is
        // instead resolved directly by `awaitRunTerminal` below, through `notifyRunActive`/the
        // settled promise, with no inbox round-trip needed.
        if (!run.awaited && finished.status !== 'paused') {
          deliverChildResultToParent(run, finished)
        }
      }
      drainQueueAfter(agent, run.id)
    })()

    active.set(run.id, { controller, promise, ac })
    notifyRunActive(run.id, { controller, promise, ac })
  }

  /** Drains as many queued runs as there are free concurrency slots. A run whose status changed
   * while it waited (cancelled before ever launching) is skipped rather than resurrected — a
   * queued-then-cancelled run must never run, the same "no error/wait path adds budget back"
   * property the loop itself upholds (plan 66's four load-bearing properties). */
  function drainQueueAfter(agent: Agent, finishedRunId: string): void {
    forget(finishedRunId)
    const queue = queues.get(agent.id)
    if (!queue || queue.length === 0) return
    const config = resolveAgentConfig(settings(), agent)
    while (queue.length > 0 && activeCountFor(agent.id) < config.maxConcurrentRuns) {
      const nextRunId = queue.shift()
      if (!nextRunId) break
      const run = threads.getRun(nextRunId)
      if (!run || run.status !== 'queued') {
        runOwnerAgentId.delete(nextRunId)
        continue
      }
      const thread = threads.getThread(run.threadId)
      if (!thread) continue
      launch(agent, thread, run)
    }
  }

  function createThread(input: { agentId: string; title?: string | null; deviceScope?: string[] | null; createdBy?: string | null }): AgentThread {
    agents.get(input.agentId) // 404s via EnkakuError if the caller's route wraps it — presence check only.
    return threads.createThread({
      agentId: input.agentId,
      title: input.title ?? null,
      origin: 'chat',
      deviceScope: input.deviceScope ?? null,
      createdBy: input.createdBy ?? null,
    })
  }

  /** Plan 70 §3.5, §4.2 — a message referencing an already-uploaded blob (`POST /api/v1/blobs`) by id; unknown to this agent's own history until this call turns it into a stored `AgentImageRef` block. Every attachment must already exist — an unknown id refuses the whole message rather than silently dropping one picture out of several. */
  function attachmentBlocks(attachments: string[] | undefined): Extract<AgentContentBlock, { type: 'image' }>[] {
    if (!attachments || attachments.length === 0) return []
    if (!deps.blobs) throw new EnkakuError('E_BAD_REQUEST', 'attachments are not supported on this server — no blob store is configured')
    return attachments.map((blobId) => {
      const info = deps.blobs!.info(blobId)
      if (!info) throw new EnkakuError('E_BAD_REQUEST', `no such blob: ${blobId}`)
      return {
        type: 'image' as const,
        blobId: info.id,
        // `put()` (the only writer) only ever accepts the four allowed media types, so this is a
        // narrow type-shape assertion on our own internally-produced value, not a cast of external
        // input (matching `provider/anthropic.ts`'s own precedent for this exact reasoning).
        mediaType: info.mediaType as AgentImageMediaType,
        bytes: info.bytes,
        ...(info.width !== null ? { width: info.width } : {}),
        ...(info.height !== null ? { height: info.height } : {}),
      }
    })
  }

  function postMessage(threadId: string, text: string, postedBy: string | null, attachments?: string[]): AgentRun {
    const thread = threads.mustGetThread(threadId)
    const agent = agents.get(thread.agentId)
    if (!agent) throw new EnkakuError('agent_not_found', `no such agent: ${thread.agentId}`)
    if (!agent.enabled) throw new EnkakuError('E_AGENT_DISABLED', 'this agent is disabled')

    // Plan 70 §3.5 — a message that is only an image is legitimate; `content` is text-if-any plus
    // attachments-if-any, never an empty array (the API's own `PostThreadMessageInputSchema`
    // refinement already guarantees at least one of the two, but this stays defensive for any other
    // caller of this function).
    const content: AgentContentBlock[] = []
    if (text.trim().length > 0) content.push({ type: 'text', text })
    content.push(...attachmentBlocks(attachments))
    if (content.length === 0) throw new EnkakuError('E_BAD_REQUEST', 'a message needs text, an attachment, or both')

    const userMessage = threads.appendMessage({ threadId, runId: null, role: 'user', content })
    void userMessage
    // Plan 73 §4.6 — a thread opened "Ask an agent" from a device page carries its own scope;
    // every run it starts (this first one and every later message) is narrowed to it.
    const run = threads.createRun(threadId, thread.deviceScope ? { deviceGrantsOverride: thread.deviceScope } : undefined)

    const config = resolveAgentConfig(settings(), agent)
    if (activeCountFor(agent.id) >= config.maxConcurrentRuns) {
      enqueue(agent.id, run.id)
      return run
    }
    launch(agent, thread, run)
    return run
  }

  function enqueue(agentId: string, runId: string): void {
    runOwnerAgentId.set(runId, agentId) // so a cancel while still queued can find and remove it
    const queue = queues.get(agentId) ?? []
    queue.push(runId)
    queues.set(agentId, queue)
  }

  /** Settles a run that never actually started executing in this process (still `queued`, or `paused` with no live invocation) — the SAME truthful shape a mid-run cancel produces, minus an activity to end (none was ever started). */
  function settleNeverRanAsCancelled(run: AgentRun, cancelledBy: string | null): void {
    threads.appendMessage({ threadId: run.threadId, runId: run.id, role: 'system', content: [{ type: 'text', text: `Cancelled by ${cancelledBy ?? 'unknown'} before it started.` }] })
    threads.updateRun(run.id, { status: 'cancelled', stopReason: 'cancelled', finishedAt: new Date() })
    const agentId = runOwnerAgentId.get(run.id)
    if (agentId) {
      const queue = queues.get(agentId)
      if (queue) queues.set(agentId, queue.filter((id) => id !== run.id))
    }
    runOwnerAgentId.delete(run.id)
    const thread = threads.getThread(run.threadId)
    const finished = threads.mustGetRun(run.id)
    if (thread) deps.onRunFinished(thread, finished)
    // Never resurrects a waiter into thinking this run is "active" — a settled, resolved entry so
    // `awaitRunTerminal` (a `waitFor: true` spawn parked on exactly this run) resolves immediately
    // rather than hanging forever (plan 67 §3.2, §3.6's "no failure path produces more... tokens" —
    // an un-resolved wait would burn the parent's own wall-clock budget for nothing).
    notifyRunActive(run.id, { controller: { cancelled: true, cancelledBy }, promise: Promise.resolve() })
    // A PAUSED run (queued runs never have children — spawning requires an active run) may already
    // have live descendants; a run never outlives its parent (plan 67 §3.5).
    cascadeIfAbnormal(finished)
  }

  function cancelRun(runId: string, cancelledBy: string | null): void {
    const run = threads.getRun(runId)
    if (!run) throw new EnkakuError('run_not_found', `no such run: ${runId}`)
    // Depth-first (plan 67 §3.5): every descendant is cancelled BEFORE this run itself, so a child
    // never tries to deliver a result to a parent that no longer exists. Each recursive call handles
    // its OWN descendants first in turn, so this alone covers the whole subtree at any depth.
    //
    // Cascaded UNCONDITIONALLY — even when THIS run is already terminal: a `waitFor: false` child
    // can still be running long after the run that spawned it finished normally (§3.2's whole
    // point), and "cancel the root" (the manual smoke test's own step 5) must still reach it. Only
    // the "handle myself" half below is skipped once this run is terminal (nothing left to do to it).
    for (const child of threads.listChildRuns(runId)) cancelRun(child.id, cancelledBy)

    // Idempotent: cancelling an already-finished run is a truthful no-op (plan 66 §3.7) — but only
    // for ITSELF; its descendants were still just handled above.
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return

    const entry = active.get(runId)
    if (!entry) {
      // Queued (never launched) or paused (no live invocation right now) — settle it directly.
      if (run.status === 'queued' || run.status === 'paused') settleNeverRanAsCancelled(run, cancelledBy)
      return
    }
    entry.controller.cancelled = true
    entry.controller.cancelledBy = cancelledBy
    entry.ac?.abort()
  }

  function decideApproval(approvalId: string, decision: 'approve' | 'deny', decidedBy: string | null): AgentApproval {
    const approval = approvals.decide(approvalId, decision, decidedBy)
    const run = threads.mustGetRun(approval.runId)
    const thread = threads.mustGetThread(run.threadId)
    const agent = agents.get(thread.agentId)
    if (agent) resumeRun(agent, thread, run)
    return approval
  }

  function resumeRun(agent: Agent, thread: AgentThread, run: AgentRun): void {
    if (active.has(run.id)) return // already running (defensive — should not happen for a 'paused' row)
    // Re-read: `run` can be stale if it was cancelled between pausing and this decision landing.
    const fresh = threads.getRun(run.id)
    if (!fresh || fresh.status !== 'paused') return
    const config = resolveAgentConfig(settings(), agent)
    if (activeCountFor(agent.id) >= config.maxConcurrentRuns) {
      enqueue(agent.id, run.id)
      return
    }
    launch(agent, thread, fresh)
  }

  function recoverAfterRestart(): void {
    const recovered = threads.recoverInterruptedRuns()
    for (const run of recovered) {
      const thread = threads.getThread(run.threadId)
      if (thread) deps.onRunFinished(thread, run)
      // Plan 67 §3.5, criterion 13 — "interrupted by a restart" cancels its children the same way;
      // nothing in this process is executing them anymore either, so waiting for them to notice on
      // their own is not an option (they never will).
      notifyRunActive(run.id, { controller: { cancelled: true, cancelledBy: 'system:restart' }, promise: Promise.resolve() })
      cascadeIfAbnormal(run)
    }
  }

  function sweepExpiredApprovals(): void {
    const overdue = approvals.sweepExpired()
    for (const row of overdue) {
      const run = threads.getRun(row.runId)
      if (!run) continue
      const thread = threads.getThread(run.threadId)
      const agent = thread ? agents.get(thread.agentId) : null
      const approval = approvals.get(row.id)
      if (thread && agent && approval) {
        deps.emit(thread, run, { type: 'approval.resolved', approvalId: approval.id, status: 'expired' })
        resumeRun(agent, thread, run)
      }
    }
  }

  // -----------------------------------------------------------------------
  // Plan 67 — the tree: spawn, messages, status, cascading cancel, the shape.
  // -----------------------------------------------------------------------

  function agentForRun(run: AgentRun): Agent | null {
    const t = threads.getThread(run.threadId)
    return t ? (agents.get(t.agentId) ?? null) : null
  }

  /** The last assistant text, across the whole thread's history for one run — what `agent.spawn`
   * (`waitFor: true`) returns as its tool result, and what a detached child's completion message
   * quotes (plan 67 §3.2, §3.3). */
  function extractFinalText(messages: AgentMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role !== 'assistant') continue
      const text = m.content
        .filter((b): b is Extract<AgentContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      if (text) return text
    }
    return null
  }

  /** Plan 67 §3.3 — the default differs by KIND: a completion the parent itself asked for
   * (`waitFor: false`) is never unsolicited, so it wakes by default; a plain message is not, so it
   * does not, unless the agent opts in with `'always'`. */
  function shouldWake(agent: Agent, kind: 'message' | 'child-result'): boolean {
    if (agent.wakeOnMessage === 'always') return true
    if (agent.wakeOnMessage === 'never') return false
    return kind === 'child-result'
  }

  /** Starts a brand-new (root) run on `thread` — the SAME shape `postMessage` launches, since the
   * run being woken has already fully terminated: there is nothing left in the old tree to be part
   * of, and charging a fresh run against an already-finished tree's spent budget would be wrong. */
  /** `oldRunId` is the finished run this wake-up is on behalf of — any inbox item still queued for
   * it (including the one that just triggered this wake) is re-addressed to the NEW run, since
   * draining only ever happens from a run's OWN loop and the old one's loop will never run again
   * (plan 67 §3.3). Without this, a message that "starts a new run" would still never actually be
   * delivered into it. */
  function wakeIdleThread(agent: Agent, thread: AgentThread, oldRunId: string): void {
    const newRun = threads.createRun(thread.id, thread.deviceScope ? { deviceGrantsOverride: thread.deviceScope } : undefined)
    tree.retarget(oldRunId, newRun.id)
    const config = resolveAgentConfig(settings(), agent)
    if (activeCountFor(agent.id) >= config.maxConcurrentRuns) {
      enqueue(agent.id, newRun.id)
      return
    }
    launch(agent, thread, newRun)
  }

  /** Plan 67 §3.3 — a message to a run that has ALREADY finished always appends to the thread
   * (the caller already did that via `tree.enqueue`); this decides whether it ALSO starts a new run. */
  function maybeWakeIfIdle(targetRunId: string, kind: 'message' | 'child-result'): void {
    if (active.has(targetRunId)) return // running (will drain naturally) or about to be relaunched
    const targetRun = threads.getRun(targetRunId)
    if (!targetRun || (targetRun.status !== 'succeeded' && targetRun.status !== 'failed' && targetRun.status !== 'cancelled')) return
    const targetThread = threads.getThread(targetRun.threadId)
    if (!targetThread) return
    const targetAgent = agents.get(targetThread.agentId)
    if (!targetAgent || !targetAgent.enabled || !shouldWake(targetAgent, kind)) return
    wakeIdleThread(targetAgent, targetThread, targetRun.id)
  }

  /** A DETACHED (`awaited === false`) child's completion, delivered to its parent via the inbox
   * (plan 67 §3.2, §3.3) — an AWAITED parent is instead resolved directly by `awaitRunTerminal`. */
  function deliverChildResultToParent(childRun: AgentRun, childFinished: AgentRun): void {
    if (!childRun.parentRunId) return
    const parentRun = threads.getRun(childRun.parentRunId)
    if (!parentRun) return
    const parentThread = threads.getThread(parentRun.threadId)
    if (!parentThread) return
    const childAgent = agentForRun(childRun)
    const output = extractFinalText(threads.messagesForRun(childRun.id))
    const body = { agentName: childAgent?.name ?? 'agent', status: childFinished.status, stopReason: childFinished.stopReason, output }
    tree.enqueue({ targetRunId: parentRun.id, fromRunId: childRun.id, kind: 'child-result', body })
    maybeWakeIfIdle(parentRun.id, 'child-result')
  }

  /** Plan 67 §3.2 — a parked `waitFor: true` spawn's wait: consumes no steps and makes no provider
   * call, because it is not polling — it waits on `entry.promise` (or, if the run has not even
   * become active yet, on `queueWaiters`), looping across any pause/resume/approval cycle until the
   * run reaches a genuinely TERMINAL state. */
  async function awaitRunTerminal(runId: string): Promise<AgentRun> {
    for (;;) {
      let entry = active.get(runId)
      if (!entry) {
        const current = threads.getRun(runId)
        if (!current) throw new EnkakuError('run_not_found', `no such run: ${runId}`)
        if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'cancelled') return current
        entry = await new Promise<ActiveRun>((resolve) => {
          const waiters = queueWaiters.get(runId) ?? []
          waiters.push(resolve)
          queueWaiters.set(runId, waiters)
        })
      }
      await entry.promise
      const after = threads.mustGetRun(runId)
      if (after.status === 'succeeded' || after.status === 'failed' || after.status === 'cancelled') return after
      // 'paused' (waiting on an approval) — loop back and wait for the NEXT active cycle (resume).
    }
  }

  /** `agent.spawn` (plan 67 §3.2, §3.4, §3.6, §4.2). Enforces `canSpawn` (§3.4), the depth and
   * tree-size caps (§3.6, failing the CALL rather than the run), and places the child correctly in
   * the tree; the authority intersection itself happens live, on every `invoke`, in
   * `loop/context.ts` — this function only needs to record the parent/root/depth/override that
   * intersection reads. */
  async function spawnChild(callerRun: AgentRun, input: AgentSpawnInput): Promise<AgentSpawnResult> {
    const callerAgent = agentForRun(callerRun)
    if (!callerAgent) throw new EnkakuError('agent_not_found', 'the calling run has no agent')

    const childAgent = agents.getBySlug(input.agent) ?? agents.get(input.agent)
    if (!childAgent) throw new EnkakuError('agent_not_found', `no such agent: "${input.agent}"`)
    if (!childAgent.enabled) throw new EnkakuError('E_AGENT_DISABLED', `agent "${childAgent.name}" is disabled`)

    // §3.4 — opt-in per pair, defaulting to none: a new agent cannot spawn anything until named.
    if (!tree.canSpawn(callerAgent.id, childAgent.id)) {
      throw new EnkakuError('E_SPAWN_NOT_GRANTED', `agent "${callerAgent.name}" is not permitted to spawn agent "${childAgent.name}" — grant it with agentSpawnGrants first`)
    }
    // §3.6 — fails the SPAWN call with a named error, not the run.
    checkDepthCap(callerRun.depth)
    checkTreeSizeCap(threads.listRunsForRoot(callerRun.rootRunId).length)

    const childThread = threads.createThread({ agentId: childAgent.id, title: null, origin: 'spawn', createdBy: `run:${callerRun.id}` })
    const childRun = threads.createRun(childThread.id, {
      parentRunId: callerRun.id,
      rootRunId: callerRun.rootRunId,
      depth: callerRun.depth + 1,
      awaited: input.waitFor,
      deviceGrantsOverride: input.deviceIds && input.deviceIds.length > 0 ? input.deviceIds : null,
    })
    threads.appendMessage({ threadId: childThread.id, runId: null, role: 'user', content: [{ type: 'text', text: input.prompt }] })

    const config = resolveAgentConfig(settings(), childAgent)
    if (activeCountFor(childAgent.id) >= config.maxConcurrentRuns) {
      enqueue(childAgent.id, childRun.id)
    } else {
      launch(childAgent, childThread, childRun)
    }

    if (!input.waitFor) return { waited: false, runId: childRun.id }

    // §3.2 — the parent consumes wall-clock but NO STEPS while parked: this `await` never touches
    // `run.steps`, which only `harness/run.ts`'s `runOneModelStep` (a NEW model call) ever increments.
    const finished = await awaitRunTerminal(childRun.id)
    return { waited: true, runId: childRun.id, status: finished.status, stopReason: finished.stopReason, output: extractFinalText(threads.messagesForRun(childRun.id)) }
  }

  /** `agent.send`/`agent.reply` (plan 67 §3.3, §4.2) share this: append to the inbox, broadcast
   * "queued" to the TARGET's thread, and maybe wake it if it has already finished. The descendant
   * (or parent) check happens BEFORE any of that — refused before any state changes, matching §4.2's
   * "refused at input validation, not at delivery". */
  function enqueueTreeMessage(fromRun: AgentRun, targetRun: AgentRun, message: string): { queued: true; inboxId: string } {
    threads.mustGetThread(targetRun.threadId)
    const fromAgent = agentForRun(fromRun)
    const item = tree.enqueue({ targetRunId: targetRun.id, fromRunId: fromRun.id, kind: 'message', body: { text: message, fromAgentName: fromAgent?.name ?? 'agent' } })
    maybeWakeIfIdle(targetRun.id, 'message')
    return { queued: true, inboxId: item.id }
  }

  /** `agent.send` — to a DESCENDANT run only, any depth (plan 67 §4.2). */
  function sendMessage(callerRun: AgentRun, targetRunId: string, message: string): { queued: true; inboxId: string } {
    if (!isDescendantOf(targetRunId, callerRun.id)) {
      throw new EnkakuError('E_NOT_DESCENDANT', `run ${targetRunId} is not a descendant of this run — agent.send can only reach your own descendants`)
    }
    const targetRun = threads.mustGetRun(targetRunId)
    return enqueueTreeMessage(callerRun, targetRun, message)
  }

  /** `agent.reply` — to the calling run's PARENT only; there is no target parameter, so nothing
   * else is expressible (plan 67 §4.2). */
  function replyMessage(callerRun: AgentRun, message: string): { queued: true; inboxId: string } {
    if (!callerRun.parentRunId) throw new EnkakuError('E_NO_PARENT', 'this run has no parent to reply to — it is a root')
    const parentRun = threads.mustGetRun(callerRun.parentRunId)
    return enqueueTreeMessage(callerRun, parentRun, message)
  }

  /** `agent.status` — a DESCENDANT's status, steps, and last message (plan 67 §4.2). */
  function statusOf(callerRun: AgentRun, targetRunId: string): AgentStatusResult {
    if (!isDescendantOf(targetRunId, callerRun.id)) {
      throw new EnkakuError('E_NOT_DESCENDANT', `run ${targetRunId} is not a descendant of this run — agent.status can only see your own descendants`)
    }
    const targetRun = threads.mustGetRun(targetRunId)
    const lastMessage = extractFinalText(threads.messagesForRun(targetRunId))
    return { runId: targetRun.id, status: targetRun.status, stopReason: targetRun.stopReason, steps: targetRun.steps, lastMessage }
  }

  /** Every run in a subtree, target included — for `agent.cancel`'s `cancelledCount` (plan 67 §4.2). */
  function collectSubtreeIds(runId: string): string[] {
    const ids = [runId]
    for (const child of threads.listChildRuns(runId)) ids.push(...collectSubtreeIds(child.id))
    return ids
  }

  /** `agent.cancel` — cancels a DESCENDANT subtree, depth-first (plan 67 §3.5, §4.2). `effect:
   * 'destructive'` (`capability/agent.ts`), so plan 66's approval gate already applies to reaching
   * this at all unless the agent's owner allowlists it. */
  function cancelDescendantForCapability(callerRun: AgentRun, targetRunId: string): AgentCancelResult {
    if (!isDescendantOf(targetRunId, callerRun.id)) {
      throw new EnkakuError('E_NOT_DESCENDANT', `run ${targetRunId} is not a descendant of this run — agent.cancel can only cancel your own descendants`)
    }
    const cancelledCount = collectSubtreeIds(targetRunId).length
    cancelRun(targetRunId, `agent:${callerRun.id}`)
    return { ok: true, cancelledCount }
  }

  /** `GET /api/v1/runs/:id/tree` (plan 67 §4.4, §4.5) — a flat node list for any run's whole tree. */
  function getTree(anyRunIdInTree: string): { rootRunId: string; nodes: AgentTreeNode[] } {
    const anyRun = threads.mustGetRun(anyRunIdInTree)
    const rows = threads.listRunsForRoot(anyRun.rootRunId)
    const nodes: AgentTreeNode[] = rows.map((row) => {
      const t = threads.getThread(row.threadId)
      const agent = t ? agents.get(t.agentId) : null
      const drivingDeviceIds = [...deviceHolders.entries()].filter(([, holders]) => holders.has(row.id)).map(([deviceId]) => deviceId)
      return {
        runId: row.id,
        threadId: row.threadId,
        parentRunId: row.parentRunId,
        depth: row.depth,
        agentId: t?.agentId ?? '',
        agentName: agent?.name ?? '(deleted agent)',
        status: row.status,
        stopReason: row.stopReason,
        steps: row.steps,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        drivingDeviceIds,
      }
    })
    return { rootRunId: anyRun.rootRunId, nodes }
  }

  // -----------------------------------------------------------------------
  // Plan 68 §3.5, §4.2 — a scheduled firing: the same `launch`/`enqueue`
  // machinery `postMessage` uses, no parallel execution path.
  // -----------------------------------------------------------------------

  function runScheduledFiring(input: ScheduledFiringInput): ScheduledFiringResult {
    const agent = agents.get(input.agentId)
    if (!agent) throw new EnkakuError('agent_not_found', `no such agent: ${input.agentId}`)
    if (!agent.enabled) throw new EnkakuError('E_AGENT_DISABLED', 'this agent is disabled')

    // `continue`: reuse the existing thread when it still exists; otherwise (the schedule's first
    // firing, or the thread was deleted) fall through and create one, exactly like `new` would.
    const existing = input.threadMode === 'continue' && input.existingThreadId ? threads.getThread(input.existingThreadId) : null
    const thread =
      existing ??
      threads.createThread({
        agentId: agent.id,
        origin: 'schedule',
        onApprovalRequired: input.onApprovalRequired,
        createdBy: `schedule:${input.scheduleId}`,
      })

    threads.appendMessage({ threadId: thread.id, runId: null, role: 'user', content: [{ type: 'text', text: input.prompt }] })
    const run = threads.createRun(thread.id, {
      deviceGrantsOverride: input.deviceIds && input.deviceIds.length > 0 ? input.deviceIds : null,
    })

    const config = resolveAgentConfig(settings(), agent)
    if (activeCountFor(agent.id) >= config.maxConcurrentRuns) {
      enqueue(agent.id, run.id)
    } else {
      launch(agent, thread, run)
    }
    return { runId: run.id, threadId: thread.id }
  }

  function countActiveScheduledRuns(): number {
    return threads.countActiveScheduledRuns()
  }

  function spentOutputTokensSince(windowStart: Date): number {
    return threads.spentOutputTokensLast24h(windowStart)
  }

  function runStatus(runId: string): AgentRunStatus | null {
    return threads.getRun(runId)?.status ?? null
  }

  return {
    createThread,
    postMessage,
    cancelRun,
    decideApproval,
    recoverAfterRestart,
    sweepExpiredApprovals,
    getTree,
    runScheduledFiring,
    countActiveScheduledRuns,
    spentOutputTokensSince,
    runStatus,
  }
}

export type { RunEmitEvent } from './harness/run'
