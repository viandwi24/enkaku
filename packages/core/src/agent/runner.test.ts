import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createLogger } from '../util/logger'
import { createActivityRegistry, type ActivityRegistry } from '../activity/registry'
import type { ControlPolicySettings } from '../activity/policy'
import { createDeviceStateMachine } from '../device/state-machine'
import type { CapabilityContextDeps } from '../capability/context'
import { buildCapabilityRegistry, type CapabilityRegistry } from '../capability/registry'
import type { AnyCoreCapability } from '../capability/types'
import { createAgentStore } from './agent-store'
import { createConnectorStore } from './connector-store'
import { createThreadStore } from './thread/store'
import { createApprovalStore } from './approval/store'
import { createTreeStore } from './tree/store'
import { createBlobStore, type BlobStore } from './blob/store'
import { createFakeProvider, type FakeProviderTurn } from './provider/fake'
import { createAgentRunner, type RunEmitEvent, type RunnerDeps } from './runner'
import type { ServerMessage } from '@enkaku/protocol'

/**
 * Runner-specific orchestration (plan 66 §4.3, §4.4) — concurrency
 * queueing, cancelling a still-queued run, approval-decision wiring, and
 * restart/sweep wiring. The loop's own control flow (budgets, tool
 * execution, cancellation-mid-run) is exhaustively covered in
 * `loop/run.test.ts`; this file only exercises what `runner.ts` itself
 * adds around it. `createProvider` is injected so this NEVER makes a real
 * network call — see `RunnerDeps.createProvider`.
 */

function destructiveCapability(): AnyCoreCapability {
  return {
    id: 'test.destructive',
    input: z.object({ path: z.string() }),
    output: z.object({ ok: z.boolean() }),
    permission: 'device.control' as never,
    deadline: 5000,
    effect: 'destructive',
    description: 'deletes something',
    handler: async () => ({ ok: true }),
  }
}

/** A fake capability under a REAL plugin's own capability id (plan 77 §4.5's test below) — the
 * plugin-grouping lookup keys on id alone, so this is enough to exercise the real gating logic
 * without touching a live device. */
function destructiveCapabilityWithId(id: string): AnyCoreCapability {
  return { ...destructiveCapability(), id, permission: 'device.control' as never }
}

function echoCapability(): AnyCoreCapability {
  return {
    id: 'test.echo',
    input: z.object({ text: z.string() }),
    output: z.object({ echoed: z.string() }),
    permission: 'device.control' as never,
    deadline: 5000,
    effect: 'read',
    description: 'echoes',
    handler: async (_ctx, input: { text: string }) => ({ echoed: input.text }),
  }
}

function noopWaiter(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function setUp(caps: AnyCoreCapability[] = [echoCapability(), destructiveCapability()], approvalTtlSec = 3600) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'SER1', label: 'Phone', status: 'online' }).run()

  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const activities: ActivityRegistry = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
  const controlSettings = (): ControlPolicySettings => ({ overControl: 'allow', idleSec: 30 })

  const registry: CapabilityRegistry = buildCapabilityRegistry(caps.map((cap) => ({ cap, file: 'test' })))
  const threads = createThreadStore(db)
  const approvals = createApprovalStore({ db, ttlSec: approvalTtlSec })
  const agentsStore = createAgentStore({ db, registry })
  const connectors = createConnectorStore({ db, dataDir: mkdtempSync(join(tmpdir(), 'enkaku-runner-test-')) })

  const capContextDeps: CapabilityContextDeps = {
    db,
    activities,
    controlSettings,
    states,
    sessions: () => null,
    readiness: () => null,
    transfer: null,
    jobService: {} as never,
    workspace: {} as never,
  }

  const connector = connectors.create({ name: 'test-connector', kind: 'anthropic', credential: 'sk-ant-fake' })
  const agent = agentsStore.create(
    { slug: 'runner-test-agent', name: 'Runner Test Agent', connectorId: connector.id, model: 'fake-model', tools: caps.map((c) => c.id), settings: { maxConcurrentRuns: 1 } },
    null,
  )

  const startedEvents: { threadId: string; runId: string }[] = []
  const finishedEvents: { threadId: string; runId: string; status: string }[] = []
  const emitted: RunEmitEvent[] = []
  const treeStore = createTreeStore(db)
  const published: { threadId: string; msg: ServerMessage }[] = []
  const blobs: BlobStore = createBlobStore(db)

  function makeRunner(
    turns: FakeProviderTurn[],
    overrides: { maxOutputTokens?: number; maxConcurrentRuns?: number; notifyAutoDenied?: RunnerDeps['notifyAutoDenied']; withBlobs?: boolean } = {},
  ) {
    return createAgentRunner({
      ...(overrides.withBlobs ? { blobs } : {}),
      threads,
      approvals,
      agents: agentsStore,
      connectors,
      registry,
      capContextDeps,
      activities,
      controlSettings,
      settings: () =>
        ({
          // Plan 212 §4.7: the agent settings store's key is `defaults`.
          defaults: {
            connectorId: connector.id,
            model: 'fake-model',
            systemPrompt: '',
            effort: 'medium',
            thinking: false,
            maxOutputTokens: overrides.maxOutputTokens ?? 100_000,
            maxSteps: 10,
            maxRunSeconds: 600,
            compactAtRatio: 0.7,
            maxConcurrentRuns: overrides.maxConcurrentRuns ?? 1,
          },
        }) as never,
      modelListCache: { get: async () => ({ models: [{ id: 'fake-model', contextWindow: 200_000, supportsThinking: false }], fallback: false }), invalidate: () => {} },
      roleOf: () => 'operator',
      emit: (_thread, _run, event) => emitted.push(event),
      onRunStarted: (thread, run) => startedEvents.push({ threadId: thread.id, runId: run.id }),
      onRunFinished: (thread, run) => finishedEvents.push({ threadId: thread.id, runId: run.id, status: run.status }),
      tree: treeStore,
      publishToThread: (threadId, msg) => published.push({ threadId, msg }),
      createProvider: () => createFakeProvider({ turns }),
      ...(overrides.notifyAutoDenied ? { notifyAutoDenied: overrides.notifyAutoDenied } : {}),
      log: createLogger('test'),
    })
  }

  return { db, threads, approvals, activities, agentsStore, connectors, agent, registry, treeStore, published, startedEvents, finishedEvents, emitted, makeRunner, blobs }
}

function textTurn(text: string): FakeProviderTurn {
  return [{ type: 'text_delta', text }, { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }]
}

describe('createAgentRunner — starting a run', () => {
  test('postMessage appends the user message and launches a run that succeeds', async () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('hi there')])
    const thread = runner.createThread({ agentId: env.agent.id })
    const run = runner.postMessage(thread.id, 'hello', 'user:u1')

    // Wait for the async run to settle.
    for (let i = 0; i < 50 && env.finishedEvents.length === 0; i++) await noopWaiter(5)

    expect(env.finishedEvents.some((e) => e.runId === run.id && e.status === 'succeeded')).toBe(true)
    const messages = env.threads.listMessages(thread.id)
    expect(messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('hello'))).toBe(true)
  })
})

describe('createAgentRunner — concurrency queueing (plan 66 §4.4)', () => {
  test('a second run for an agent at maxConcurrentRuns=1 is queued, not rejected, and launches once the first finishes', async () => {
    const env = setUp()
    // `launch()` registers the run in the in-memory `active` map SYNCHRONOUSLY (before any await),
    // so calling `postMessage` twice back to back — with no `await` between the two calls, exactly
    // as this test does — deterministically finds run1 still occupying the agent's one concurrency
    // slot when run2 is created, without needing an artificial delay.
    const runner = env.makeRunner([textTurn('first done'), textTurn('second done')])
    const thread = runner.createThread({ agentId: env.agent.id })
    const run1 = runner.postMessage(thread.id, 'one', 'user:u1')
    const run2 = runner.postMessage(thread.id, 'two', 'user:u1')

    expect(env.threads.getRun(run2.id)?.status).toBe('queued')

    for (let i = 0; i < 50 && env.finishedEvents.length < 2; i++) await noopWaiter(5)

    expect(env.finishedEvents.filter((e) => e.status === 'succeeded').map((e) => e.runId).sort()).toEqual([run1.id, run2.id].sort())
  })
})

describe('createAgentRunner — cancelling a queued run', () => {
  test('cancelling a run that never launched settles it as cancelled without any provider call', async () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('should never be reached by run2')])
    const thread = runner.createThread({ agentId: env.agent.id })
    const run1 = runner.postMessage(thread.id, 'one', 'user:u1')
    const run2 = runner.postMessage(thread.id, 'two', 'user:u1')
    expect(env.threads.getRun(run2.id)?.status).toBe('queued')

    runner.cancelRun(run2.id, 'user:u2')
    expect(env.threads.getRun(run2.id)?.status).toBe('cancelled')

    for (let i = 0; i < 50 && env.finishedEvents.filter((e) => e.runId === run1.id).length === 0; i++) await noopWaiter(5)
    // run2 never ran, so it never appended anything beyond the user message and the cancel note.
    const messages = env.threads.listMessages(thread.id)
    const run2Messages = messages.filter((m) => m.runId === run2.id)
    expect(run2Messages.every((m) => m.role === 'system' || m.role === 'user')).toBe(true)
  })
})

describe('createAgentRunner — approval decision resumes the run', () => {
  test('approving a paused run\'s only pending call resumes it to completion', async () => {
    const env = setUp()
    const runner = env.makeRunner([
      [{ type: 'tool_call', id: 'c1', name: 'test_destructive', input: { path: '/x' } }, { type: 'done' }],
      textTurn('done'),
    ])
    const thread = runner.createThread({ agentId: env.agent.id })
    const run = runner.postMessage(thread.id, 'delete it', 'user:u1')

    for (let i = 0; i < 50 && env.threads.getRun(run.id)?.status !== 'paused'; i++) await noopWaiter(5)
    expect(env.threads.getRun(run.id)?.status).toBe('paused')

    const approval = env.approvals.pendingForRun(run.id)!
    runner.decideApproval(approval.id, 'approve', 'user:u1')

    // `onRunFinished` fires once for the pause itself (the run is not actively executing while it
    // waits) and again once it truly completes — wait for the terminal one specifically.
    for (let i = 0; i < 50 && !env.finishedEvents.some((e) => e.status === 'succeeded'); i++) await noopWaiter(5)
    expect(env.finishedEvents.some((e) => e.runId === run.id && e.status === 'succeeded')).toBe(true)
  })
})

describe('createAgentRunner — restart recovery and approval sweep wiring', () => {
  test('recoverAfterRestart calls onRunFinished for every run it marked interrupted', () => {
    const env = setUp()
    const runner = env.makeRunner([])
    const thread = runner.createThread({ agentId: env.agent.id })
    const run = env.threads.createRun(thread.id)
    env.threads.updateRun(run.id, { status: 'running', startedAt: new Date() })

    runner.recoverAfterRestart()
    expect(env.threads.getRun(run.id)?.status).toBe('failed')
    expect(env.finishedEvents.some((e) => e.runId === run.id)).toBe(true)
  })

  test('sweepExpiredApprovals resumes a run whose only pending approval just expired', async () => {
    // A negative TTL means every approval this store creates is overdue the instant it exists —
    // the same store `runner.ts` calls `.sweepExpired()` on, so this exercises the real wiring
    // (`runner.sweepExpiredApprovals()` → `approvals.sweepExpired()` → resume the run it belongs
    // to), not just the store-level contract already covered in `approval/store.test.ts`.
    const env = setUp([echoCapability(), destructiveCapability()], -1)
    const runner = env.makeRunner([
      [{ type: 'tool_call', id: 'c1', name: 'test_destructive', input: { path: '/x' } }, { type: 'done' }],
      textTurn('done after expiry'),
    ])
    const thread = runner.createThread({ agentId: env.agent.id })
    const run = runner.postMessage(thread.id, 'delete it', 'user:u1')
    for (let i = 0; i < 50 && env.threads.getRun(run.id)?.status !== 'paused'; i++) await noopWaiter(5)
    expect(env.threads.getRun(run.id)?.status).toBe('paused')
    const pending = env.approvals.pendingForRun(run.id)!
    expect(pending).toBeDefined()

    runner.sweepExpiredApprovals()
    expect(env.approvals.get(pending.id)?.status).toBe('expired')

    for (let i = 0; i < 50 && !env.finishedEvents.some((e) => e.status === 'succeeded'); i++) await noopWaiter(5)
    expect(env.finishedEvents.some((e) => e.runId === run.id && e.status === 'succeeded')).toBe(true)
    const messages = env.threads.listMessages(thread.id)
    const toolResult = messages.find((m) => m.role === 'tool')!
    expect((toolResult.content[0] as { isError?: boolean }).isError).toBe(true)
  })
})

/**
 * Plan 68 §3.5, §4.2 — a scheduled firing is an ORDINARY run through the
 * exact same `launch`/`enqueue` machinery `postMessage` uses (no parallel
 * execution path). These tests exercise `runScheduledFiring` and the two
 * farm-wide ceilings it feeds (`countActiveScheduledRuns`,
 * `spentOutputTokensSince`) directly on `AgentRunner` — `schedules/runner.
 * ts`'s own tests cover the scheduler-side branch (overlap, jitter, the
 * ceilings read from settings); this file covers what `AgentRunner` itself
 * guarantees once a firing reaches it.
 */
describe('runScheduledFiring — a scheduled firing is an ordinary run (plan 68 §3.5)', () => {
  test("threadMode 'new' creates a fresh, 'schedule'-origin thread per call", async () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('ok'), textTurn('ok again')])

    const first = runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-1',
      prompt: 'check the checkout flow',
      threadMode: 'new',
      existingThreadId: null,
      onApprovalRequired: 'deny',
      deviceIds: null,
    })
    const second = runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-1',
      prompt: 'check the checkout flow',
      threadMode: 'new',
      existingThreadId: null,
      onApprovalRequired: 'deny',
      deviceIds: null,
    })

    expect(first.threadId).not.toBe(second.threadId)
    expect(env.threads.getThread(first.threadId)?.origin).toBe('schedule')
    expect(env.threads.getThread(first.threadId)?.onApprovalRequired).toBe('deny')
    expect(env.threads.getThread(first.threadId)?.createdBy).toBe('schedule:sched-1')

    for (let i = 0; i < 50 && env.finishedEvents.length < 2; i++) await noopWaiter(5)
    expect(env.finishedEvents.filter((e) => e.status === 'succeeded')).toHaveLength(2)
  })

  test("threadMode 'continue' reuses the same thread across firings and keeps its history", async () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('first firing'), textTurn('second firing')])

    const first = runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-2',
      prompt: 'nightly check #1',
      threadMode: 'continue',
      existingThreadId: null,
      onApprovalRequired: 'deny',
      deviceIds: null,
    })
    for (let i = 0; i < 50 && env.finishedEvents.length < 1; i++) await noopWaiter(5)

    const second = runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-2',
      prompt: 'nightly check #2',
      threadMode: 'continue',
      existingThreadId: first.threadId,
      onApprovalRequired: 'deny',
      deviceIds: null,
    })
    for (let i = 0; i < 50 && env.finishedEvents.length < 2; i++) await noopWaiter(5)

    expect(second.threadId).toBe(first.threadId)
    const messages = env.threads.listMessages(first.threadId)
    expect(messages.some((m) => JSON.stringify(m.content).includes('nightly check #1'))).toBe(true)
    expect(messages.some((m) => JSON.stringify(m.content).includes('nightly check #2'))).toBe(true)
  })

  test('deviceIds narrows the run — recorded as deviceGrantsOverride on the run row (plan 68 §3.1, criterion 3)', () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('ok')])
    const { runId } = runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-3',
      prompt: 'check just these',
      threadMode: 'new',
      existingThreadId: null,
      onApprovalRequired: 'deny',
      deviceIds: ['d1'],
    })
    expect(env.threads.getRun(runId)?.deviceGrantsOverride).toEqual(['d1'])
  })

  test('an empty deviceIds list means no extra narrowing (null on the run), not "no devices" (plan 68 §4.2)', () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('ok')])
    const { runId } = runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-4',
      prompt: 'check',
      threadMode: 'new',
      existingThreadId: null,
      onApprovalRequired: 'deny',
      deviceIds: [],
    })
    expect(env.threads.getRun(runId)?.deviceGrantsOverride).toBeNull()
  })

  test('a disabled agent refuses the firing rather than silently doing nothing', () => {
    const env = setUp()
    env.agentsStore.update(env.agent.id, { enabled: false })
    const runner = env.makeRunner([])
    expect(() =>
      runner.runScheduledFiring({
        agentId: env.agent.id,
        scheduleId: 'sched-5',
        prompt: 'check',
        threadMode: 'new',
        existingThreadId: null,
        onApprovalRequired: 'deny',
        deviceIds: null,
      }),
    ).toThrow()
  })

  test("onApprovalRequired: 'deny' refuses a destructive call at once, records it, and lets the run continue to completion (criterion 8)", async () => {
    const env = setUp()
    const denied: { capabilityId: string }[] = []
    const runner = env.makeRunner(
      [
        [{ type: 'tool_call', id: 'c1', name: 'test_destructive', input: { path: '/x' } }, { type: 'done' }],
        textTurn('reported: blocked from deleting /x'),
      ],
      { notifyAutoDenied: (info) => denied.push({ capabilityId: info.capabilityId }) },
    )
    const { runId, threadId } = runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-6',
      prompt: 'delete /x',
      threadMode: 'new',
      existingThreadId: null,
      onApprovalRequired: 'deny',
      deviceIds: null,
    })

    for (let i = 0; i < 50 && env.finishedEvents.length === 0; i++) await noopWaiter(5)

    // Never paused — the whole point of 'deny' (§3.5): no approval row, no wait.
    expect(env.finishedEvents.some((e) => e.runId === runId && e.status === 'succeeded')).toBe(true)
    expect(env.approvals.pendingForRun(runId)).toBeNull()
    expect(denied).toHaveLength(1)
    expect(denied[0]?.capabilityId).toBe('test.destructive')

    const toolResult = env.threads.listMessages(threadId).find((m) => m.role === 'tool')!
    expect((toolResult.content[0] as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(toolResult.content)).toContain('onApprovalRequired: deny')
  })

  test("onApprovalRequired: 'pause' behaves exactly like a chat thread — waits for a human (contrast case for criterion 8)", async () => {
    const env = setUp()
    const runner = env.makeRunner([
      [{ type: 'tool_call', id: 'c1', name: 'test_destructive', input: { path: '/x' } }, { type: 'done' }],
      textTurn('done'),
    ])
    const { runId } = runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-7',
      prompt: 'delete /x',
      threadMode: 'new',
      existingThreadId: null,
      onApprovalRequired: 'pause',
      deviceIds: null,
    })

    for (let i = 0; i < 50 && env.threads.getRun(runId)?.status !== 'paused'; i++) await noopWaiter(5)
    expect(env.threads.getRun(runId)?.status).toBe('paused')
    expect(env.approvals.pendingForRun(runId)).not.toBeNull()
  })

  test('countActiveScheduledRuns counts only schedule-origin active runs, never a chat run (structural half of criterion 7)', async () => {
    const env = setUp()
    // A schedule-origin run parked on an approval (paused counts as active, plan 68 §3.3).
    const scheduledRunner = env.makeRunner([[{ type: 'tool_call', id: 'c1', name: 'test_destructive', input: { path: '/x' } }, { type: 'done' }]])
    const { runId: scheduledRunId } = scheduledRunner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-8',
      prompt: 'delete /x',
      threadMode: 'new',
      existingThreadId: null,
      onApprovalRequired: 'pause',
      deviceIds: null,
    })
    for (let i = 0; i < 50 && env.threads.getRun(scheduledRunId)?.status !== 'paused'; i++) await noopWaiter(5)
    expect(scheduledRunner.countActiveScheduledRuns()).toBe(1)

    // A CHAT-origin run, also paused on an approval — must NOT count toward the scheduled ceiling,
    // which is the structural reason an interactive run can never be blocked by it (criterion 7).
    const chatThread = scheduledRunner.createThread({ agentId: env.agent.id })
    scheduledRunner.postMessage(chatThread.id, 'delete it', 'user:u1')
    // (this agent's maxConcurrentRuns is 1 and is already occupied by the paused scheduled run, so
    // the chat run queues — it still must not count, queued or not, since its thread's origin is
    // 'chat' regardless of whether it ever launches.)
    expect(scheduledRunner.countActiveScheduledRuns()).toBe(1)
  })

  test('spentOutputTokensSince sums only schedule-origin usage — an interactive run never contributes (criterion 7)', async () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('scheduled output')])
    runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-9',
      prompt: 'check',
      threadMode: 'new',
      existingThreadId: null,
      onApprovalRequired: 'deny',
      deviceIds: null,
    })
    for (let i = 0; i < 50 && env.finishedEvents.length < 1; i++) await noopWaiter(5)

    const before = runner.spentOutputTokensSince(new Date(0))
    expect(before).toBeGreaterThan(0)

    // An interactive chat run spending tokens too — must not change the scheduled-only sum.
    const chatRunner = env.makeRunner([textTurn('chat output')])
    const chatThread = chatRunner.createThread({ agentId: env.agent.id })
    chatRunner.postMessage(chatThread.id, 'hi', 'user:u1')
    for (let i = 0; i < 50 && chatRunner.spentOutputTokensSince(new Date(0)) !== before; i++) await noopWaiter(5)
    expect(chatRunner.spentOutputTokensSince(new Date(0))).toBe(before)
  })

  test('runStatus reflects the live status of a scheduled run, and null once it no longer exists', async () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('ok')])
    const { runId } = runner.runScheduledFiring({
      agentId: env.agent.id,
      scheduleId: 'sched-10',
      prompt: 'check',
      threadMode: 'new',
      existingThreadId: null,
      onApprovalRequired: 'deny',
      deviceIds: null,
    })
    for (let i = 0; i < 50 && (runner.runStatus(runId) === 'running' || runner.runStatus(runId) === 'queued'); i++) await noopWaiter(5)
    expect(runner.runStatus(runId)).toBe('succeeded')
    expect(runner.runStatus('no-such-run')).toBeNull()
  })
})

function pngBytes(): Uint8Array {
  const b = new Uint8Array(40)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13], 8)
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  const dv = new DataView(b.buffer)
  dv.setUint32(16, 10, false)
  dv.setUint32(20, 20, false)
  return b
}

describe('postMessage — attachments (plan 70 §3.5, §4.2, criterion 10)', () => {
  test('a message that is an image with no text is accepted and stored as an image block', async () => {
    const env = setUp()
    const stored = env.blobs.put(pngBytes(), 'image/png')
    const runner = env.makeRunner([textTurn('I see a small image')], { withBlobs: true })
    const thread = runner.createThread({ agentId: env.agent.id })
    const run = runner.postMessage(thread.id, '', 'user:u1', [stored.id])
    expect(run.id).toBeTruthy()

    const messages = env.threads.listMessages(thread.id)
    const userMessage = messages.find((m) => m.role === 'user')!
    expect(userMessage.content).toHaveLength(1)
    expect(userMessage.content[0]).toMatchObject({ type: 'image', blobId: stored.id, mediaType: 'image/png' })
  })

  test('text AND an attachment together produce both blocks', () => {
    const env = setUp()
    const stored = env.blobs.put(pngBytes(), 'image/png')
    const runner = env.makeRunner([textTurn('ok')], { withBlobs: true })
    const thread = runner.createThread({ agentId: env.agent.id })
    runner.postMessage(thread.id, 'what is this?', 'user:u1', [stored.id])

    const messages = env.threads.listMessages(thread.id)
    const userMessage = messages.find((m) => m.role === 'user')!
    expect(userMessage.content.map((b) => b.type)).toEqual(['text', 'image'])
  })

  test('an unknown blob id refuses the whole message rather than silently dropping it', () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('ok')], { withBlobs: true })
    const thread = runner.createThread({ agentId: env.agent.id })
    expect(() => runner.postMessage(thread.id, '', 'user:u1', ['sha256:doesnotexist'])).toThrow()
    expect(env.threads.listMessages(thread.id)).toHaveLength(0) // nothing was appended
  })

  test('neither text nor an attachment refuses (a message needs one or the other)', () => {
    const env = setUp()
    const runner = env.makeRunner([textTurn('ok')], { withBlobs: true })
    const thread = runner.createThread({ agentId: env.agent.id })
    expect(() => runner.postMessage(thread.id, '', 'user:u1')).toThrow()
  })
})

/** Plan 77 §4.5 — `buildRunEnv` splices the enabled plugins' STATIC prompt sections onto the
 * agent's own system prompt, gated to the capabilities this run actually holds (criterion 12).
 * `pluginIdForCapabilityId` groups by capability ID ALONE (it does not care about a fake test
 * capability's schema/handler), so a fake capability declared with a REAL plugin's id (e.g.
 * `device.tap`) is enough to exercise the real gating without a live device. */
describe('createAgentRunner — plugin prompt sections reach the model (plan 77 §4.5)', () => {
  test('a capability id belonging to a real plugin adds that plugin\'s section to the system prompt', async () => {
    const deviceTapLike = destructiveCapabilityWithId('device.tap')
    const env = setUp([deviceTapLike])
    let capturedSystem: string | undefined
    const runner = env.makeRunner([
      (_callIndex, options) => {
        const sys = (options as { prompt: { role: string; content: unknown }[] }).prompt.find((m) => m.role === 'system')
        capturedSystem = sys ? String(sys.content) : undefined
        return [{ type: 'text_delta', text: 'ok' }, { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }]
      },
    ])
    const thread = runner.createThread({ agentId: env.agent.id })
    runner.postMessage(thread.id, 'hi', 'user:u1')

    for (let i = 0; i < 50 && env.finishedEvents.length === 0; i++) await noopWaiter(5)

    expect(capturedSystem).toBeDefined()
    expect(capturedSystem).toContain('# Device control')
  })

  test('an agent with no matching capability gets no plugin sections — the base prompt is untouched', async () => {
    const env = setUp([echoCapability()]) // 'test.echo' groups under no real plugin
    let capturedSystem: string | undefined
    const runner = env.makeRunner([
      (_callIndex, options) => {
        const sys = (options as { prompt: { role: string; content: unknown }[] }).prompt.find((m) => m.role === 'system')
        capturedSystem = sys ? String(sys.content) : undefined
        return [{ type: 'text_delta', text: 'ok' }, { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }]
      },
    ])
    const thread = runner.createThread({ agentId: env.agent.id })
    runner.postMessage(thread.id, 'hi', 'user:u1')

    for (let i = 0; i < 50 && env.finishedEvents.length === 0; i++) await noopWaiter(5)

    // The farm's own default system prompt in this test suite is '' (see `settings()` above) —
    // with no plugin section applicable, the assembled prompt stays empty.
    expect(capturedSystem ?? '').toBe('')
  })
})
