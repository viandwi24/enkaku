import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AgentWriteInput, ServerMessage } from '@enkaku/protocol'
import { AGENT_TREE_CAPABILITIES } from '../capability/agent'
import { openDb, runMigrations, type Db } from '../db'
import { devices, users } from '../db/schema'
import { createLogger } from '../util/logger'
import { createActivityRegistry } from '../activity/registry'
import { createDeviceStateMachine } from '../device/state-machine'
import type { CapabilityContextDeps } from '../capability/context'
import { buildCapabilityRegistry, type CapabilityRegistry } from '../capability/registry'
import type { AnyCoreCapability } from '../capability/types'
import { createAgentStore } from './agent-store'
import { createConnectorStore } from './connector-store'
import { createThreadStore } from './thread/store'
import { createApprovalStore } from './approval/store'
import { createTreeStore } from './tree/store'
import { createFakeProvider, type FakeModelEvent, type FakeProviderTurn } from './provider/fake'
import { createAgentRunner, type RunEmitEvent } from './runner'

/**
 * Plan 67's integration test plan (§7): every "Integration (fake provider)"
 * bullet, the restart scenario, and the acceptance criteria that need real
 * wiring (not just the pure `tree/authority.test.ts`/`tree/caps.test.ts`
 * unit tests) — the capability path (`capability/agent.ts`) through
 * `invoke()` through `agent/runner.ts`'s tree machinery, end to end. No real
 * Anthropic call anywhere: every agent's provider is a scripted
 * `createFakeProvider`, selected per test by its connector's `apiKey`.
 */

function echoCapability(): AnyCoreCapability {
  return {
    id: 'test.echo',
    input: z.object({ text: z.string() }),
    output: z.object({ echoed: z.string() }),
    permission: 'agent.run',
    deadline: 5_000,
    effect: 'read',
    description: 'echoes',
    handler: async (_ctx, input: { text: string }) => ({ echoed: input.text }),
  }
}

function slowCapability(ms: number): AnyCoreCapability {
  return {
    id: 'test.slow',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permission: 'agent.run',
    deadline: 30_000,
    effect: 'read',
    description: 'deliberately slow',
    handler: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), ms)),
  }
}

function deviceTapCapability(): AnyCoreCapability {
  return {
    id: 'test.device.tap',
    input: z.object({ deviceId: z.string() }),
    output: z.object({ ok: z.boolean() }),
    permission: 'device.control',
    activity: { kind: 'control' },
    deadline: 30_000,
    effect: 'write',
    description: 'test device tap',
    handler: async (_ctx, input: { deviceId: string }) => ({ ok: true, deviceId: input.deviceId }),
  }
}

/** Holds its device.control claim until released by the test — long enough to assert the claim is
 * genuinely held mid-run (cascade-cancel tests). Keyed by deviceId (via the shared `releases` map)
 * so ONE capability definition can back several concurrently-held devices — the registry refuses a
 * duplicate capability id (plan 63 §6.2), so this can only be registered once per test. */
function holdDeviceCapability(releases: Map<string, () => void>): AnyCoreCapability {
  return {
    id: 'test.device.hold',
    input: z.object({ deviceId: z.string() }),
    output: z.object({ ok: z.boolean() }),
    permission: 'device.control',
    activity: { kind: 'control' },
    deadline: 60_000,
    effect: 'write',
    description: 'holds the claim until released',
    handler: (_ctx, input: { deviceId: string }) => new Promise((resolve) => releases.set(input.deviceId, () => resolve({ ok: true }))),
  }
}

/** Blocks a run at a deterministic point until the TEST releases it — used to synchronise two
 * concurrently-spawned runs without racing on real timers. */
function gateCapability(gate: { release: (() => void) | null }): AnyCoreCapability {
  return {
    id: 'test.gate',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permission: 'agent.run',
    deadline: 30_000,
    effect: 'read',
    description: 'blocks until released by the test',
    handler: () => new Promise((resolve) => { gate.release = () => resolve({ ok: true }) }),
  }
}

function textTurn(text: string): FakeModelEvent[] {
  return [{ type: 'text_delta', text }, { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }]
}

function toolTurn(id: string, name: string, input: unknown): FakeModelEvent[] {
  return [{ type: 'tool_call', id, name, input }, { type: 'done' }]
}

/** A loosely-typed view of the AI SDK's own `LanguageModelV3CallOptions.prompt` — the fake model's
 * turn functions read this to inspect what happened earlier (plan 76 §3.7: this replaces the old
 * `req: ProviderRequest` parameter, which read Enkaku's OWN `ProviderMessage[]` shape; the harness
 * hands the model the AI SDK's shape instead, so the fixtures read THAT now). */
interface FakePromptOptions {
  prompt: { role: string; content: unknown }[]
}

/** Extracts a spawn tool_result's `runId` from the request history — lets a scripted turn use the
 * child's runId in a FOLLOW-UP tool call without the test hard-coding it. Plan 70 §3.2: a
 * `tool_result`'s own `content` is a BLOCK ARRAY now (text and/or image), never a bare string — this
 * reads the first text block, exactly like the loop itself does for a non-image capability. */
function lastToolResultRunId(options: FakePromptOptions): string | null {
  const messages = options.prompt
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content
    if (!Array.isArray(content)) continue
    for (const block of content as { type?: string; output?: unknown }[]) {
      if (block.type !== 'tool-result') continue
      const output = block.output as { type?: string; value?: unknown } | undefined
      const text = output?.type === 'text' ? output.value : undefined
      if (typeof text !== 'string') continue
      try {
        const parsed = JSON.parse(text) as { runId?: string }
        if (parsed.runId) return parsed.runId
      } catch {
        // not JSON — not a spawn result.
      }
    }
  }
  return null
}

function historyHasToolUse(options: FakePromptOptions, toolName: string): boolean {
  return options.prompt.some((m) => Array.isArray(m.content) && (m.content as { type?: string; toolName?: string }[]).some((b) => b.type === 'tool-call' && b.toolName === toolName))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000, stepMs = 4): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

interface EmittedEntry {
  runId: string
  event: RunEmitEvent
}

function setUp(caps: AnyCoreCapability[]) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'SER1', label: 'Phone 1', status: 'online' }).run()
  db.insert(devices).values({ id: 'd2', stableId: 's2', serial: 'SER2', label: 'Phone 2', status: 'online' }).run()
  db.insert(users).values({ id: 'u1', email: 'u1@test', role: 'operator', passwordHash: null, createdAt: new Date() }).run()

  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const activities = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
  const controlSettings = () => ({ overControl: 'allow' as const, idleSec: 30 })

  const allCaps = [...caps, ...AGENT_TREE_CAPABILITIES]
  const registry: CapabilityRegistry = buildCapabilityRegistry(allCaps.map((cap) => ({ cap, file: 'test' })))
  const threads = createThreadStore(db)
  const approvals = createApprovalStore({ db })
  const treeStore = createTreeStore(db)
  const agentsStore = createAgentStore({ db, registry })
  const connectors = createConnectorStore({ db, dataDir: mkdtempSync(join(tmpdir(), 'enkaku-tree-test-')) })

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

  const emittedLog: EmittedEntry[] = []
  const published: { threadId: string; msg: ServerMessage }[] = []
  const finishedEvents: { runId: string; threadId: string; status: string }[] = []
  const startedEvents: { runId: string; threadId: string }[] = []

  const turnsByApiKey = new Map<string, FakeProviderTurn[]>()

  /** A connector + agent pair with a distinct credential, so `createProvider` can route each
   * agent's OWN turn script (fake providers cannot otherwise tell two agents apart). */
  function createAgent(slug: string, turns: FakeProviderTurn[], overrides: Partial<AgentWriteInput> = {}, ownerId: string | null = 'u1') {
    const connector = connectors.create({ name: `${slug}-connector`, kind: 'anthropic', credential: `sk-ant-${slug}` })
    turnsByApiKey.set(`sk-ant-${slug}`, turns)
    // Defaults to NEVER auto-waking (plan 67 §3.3's own default is 'on-child-result', but these
    // fixture agents script "always spawn/act the same way regardless of history" turn arrays —
    // a real model would read an injected completion message and respond accordingly, but a fixed
    // script cannot, and letting it be woken again would replay the same script forever. Tests that
    // specifically exercise wake-on-completion opt back in via `overrides.wakeOnMessage`.
    const agent = agentsStore.create({ slug, name: slug, connectorId: connector.id, model: 'fake-model', wakeOnMessage: 'never', ...overrides }, ownerId)
    return agent
  }

  function makeRunner(opts: { maxOutputTokens?: number; maxConcurrentRuns?: number; maxRunSeconds?: number; maxSteps?: number } = {}) {
    return createAgentRunner({
      threads,
      approvals,
      agents: agentsStore,
      connectors,
      registry,
      capContextDeps,
      activities,
      controlSettings,
      tree: treeStore,
      settings: () =>
        ({
          agentDefaults: {
            connectorId: null,
            model: 'fake-model',
            systemPrompt: '',
            effort: 'medium',
            thinking: false,
            maxOutputTokens: opts.maxOutputTokens ?? 100_000,
            maxSteps: opts.maxSteps ?? 20,
            maxRunSeconds: opts.maxRunSeconds ?? 600,
            compactAtRatio: 0.9,
            maxConcurrentRuns: opts.maxConcurrentRuns ?? 5,
          },
        }) as never,
      modelListCache: { get: async () => ({ models: [{ id: 'fake-model', contextWindow: 200_000, supportsThinking: false }], fallback: false }), invalidate: () => {} },
      roleOf: () => 'operator',
      emit: (_thread, run, event) => emittedLog.push({ runId: run.id, event }),
      onRunStarted: (thread, run) => startedEvents.push({ runId: run.id, threadId: thread.id }),
      onRunFinished: (thread, run) => finishedEvents.push({ runId: run.id, threadId: thread.id, status: run.status }),
      publishToThread: (threadId, msg) => published.push({ threadId, msg }),
      createProvider: (_kind, connDeps) => createFakeProvider({ turns: turnsByApiKey.get(connDeps.apiKey) ?? [] }),
      log: createLogger('test'),
    })
  }

  /** The device-tree's own `agent:<rootRunId>` claim marker, or null — the direct equivalent of the deleted manual-control-grant lookup for these tests' purposes (plan 205 §4.4, §5 step 205.8). */
  const agentHolderOf = (deviceId: string) => activities.list(deviceId).find((a) => a.kind === 'agent') ?? null

  return { db, threads, approvals, treeStore, activities, agentHolderOf, agentsStore, connectors, emittedLog, published, finishedEvents, startedEvents, createAgent, makeRunner }
}

describe('tree — waitFor: true (plan 67 §3.2, criterion 1)', () => {
  test("returns the child's final output as the tool result; the parent's step count is unchanged by the wait", async () => {
    const env = setUp([echoCapability()])
    const parent = env.createAgent('parent', [
      toolTurn('c1', 'agent_spawn', { agent: 'child', prompt: 'go do it', waitFor: true }),
      (_i, req) => {
        const rid = lastToolResultRunId(req)
        return [{ type: 'text_delta', text: `child said: ${rid}` }, { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }]
      },
    ], { tools: ['agent.spawn'], permissions: ['agent.run'] })
    env.createAgent('child', [textTurn('child final answer')], { tools: ['test.echo'], permissions: ['agent.run'] })
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('child')!.id)

    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: parent.id })
    const run = runner.postMessage(thread.id, 'please spawn', 'user:u1')

    await waitUntil(() => env.finishedEvents.some((e) => e.runId === run.id))
    const finished = env.threads.mustGetRun(run.id)
    expect(finished.status).toBe('succeeded')
    // Exactly two model turns: the spawn call, and the follow-up text — the wait itself never
    // incremented `steps` (plan 67 §3.2's "consumes no steps while parked").
    expect(finished.steps).toBe(2)

    const messages = env.threads.listMessages(thread.id)
    const toolResult = messages.find((m) => m.role === 'tool')!
    expect(JSON.stringify(toolResult.content)).toContain('child final answer')
  })
})

describe('tree — waitFor: false (plan 67 §3.2, §3.3, criterion 2, 8)', () => {
  test('returns a runId immediately; the completion arrives later as an injected message and wakes the parent (default wakeOnMessage)', async () => {
    // The parent has EXACTLY one turn (spawn, then a plain text reply) so it finishes and drops out
    // of `active` almost immediately; the child is deliberately made SLOWER (a real capability delay)
    // so it is guaranteed to still be running when the parent goes idle — this is what makes
    // "wakes the parent" (rather than "delivered into the still-running original run", an equally
    // valid but DIFFERENT code path this plan also supports) the deterministic outcome here.
    const env = setUp([slowCapability(80)])
    // Guarded by history, not call index: safe to be invoked again by the WOKEN run this test
    // expects — without the guard, the woken run would spawn ANOTHER child2, which would wake
    // AGAIN once IT finishes, forever (exactly the "perpetual motion" risk plan 67 §3.3 warns
    // about, and worth guarding against explicitly rather than assuming it cannot happen here).
    const parentTurn: FakeProviderTurn = (_i, req) =>
      !historyHasToolUse(req, 'agent_spawn') ? [{ type: 'tool_call', id: 'c1', name: 'agent_spawn', input: { agent: 'child2', prompt: 'go', waitFor: false } }, { type: 'done' }] : textTurn('spawned, moving on')
    const parent = env.createAgent(
      'parent2',
      [parentTurn, parentTurn],
      // This test is specifically about the default wake behaviour — opt back into it.
      { tools: ['agent.spawn'], permissions: ['agent.run'], wakeOnMessage: 'on-child-result' },
    )
    env.createAgent('child2', [toolTurn('s1', 'test_slow', {}), textTurn('child2 finished on its own')], { tools: ['test.slow'], permissions: ['agent.run'] })
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('child2')!.id)

    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: parent.id })
    const run = runner.postMessage(thread.id, 'spawn detached', 'user:u1')

    // The PARENT's own run finishes quickly — it never waited for the child.
    await waitUntil(() => env.finishedEvents.some((e) => e.runId === run.id))
    expect(env.threads.mustGetRun(run.id).status).toBe('succeeded')

    // A SECOND run appears on the same thread once the child's (slower) result wakes it
    // (wakeOnMessage defaults to 'on-child-result').
    await waitUntil(() => env.threads.listRuns(thread.id).length >= 2)
    await waitUntil(() => env.finishedEvents.filter((e) => e.threadId === thread.id).length >= 2)

    const allMessages = env.threads.listMessages(thread.id)
    expect(allMessages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('child2 finished on its own'))).toBe(true)
  })
})

describe('tree — agent.send delivered at a turn boundary, never mid tool-call (plan 67 §3.3, criterion 6)', () => {
  test('a message queued while a slow capability is in flight is delivered strictly AFTER it finishes', async () => {
    const env = setUp([slowCapability(150)])
    const parent = env.createAgent(
      'sender',
      [
        toolTurn('c1', 'agent_spawn', { agent: 'receiver', prompt: 'work', waitFor: false }),
        (_i, req) => toolTurn('c2', 'agent_send', { runId: lastToolResultRunId(req), message: 'hello mid-flight' }),
        textTurn('sent it'),
      ],
      // The child's effective tools are the INTERSECTION with the parent's own (plan 67 §3.4) —
      // `test.slow` must be here too, or the receiver's own `test.slow` grant would be intersected
      // away to nothing even though it is configured on the receiver's own record.
      { tools: ['agent.spawn', 'agent.send', 'test.slow'], permissions: ['agent.run'] },
    )
    env.createAgent('receiver', [toolTurn('s1', 'test_slow', {}), textTurn('receiver done')], { tools: ['test.slow'], permissions: ['agent.run'] })
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('receiver')!.id)

    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: parent.id })
    runner.postMessage(thread.id, 'go', 'user:u1')

    const childThread = () => env.threads.listThreads({ agentId: env.agentsStore.getBySlug('receiver')!.id })[0]
    await waitUntil(() => childThread() !== undefined)
    const cThread = childThread()!
    const cRuns = () => env.threads.listRuns(cThread.id)
    await waitUntil(() => cRuns().length > 0 && cRuns()[0]!.status === 'succeeded')

    const childRunId = cRuns()[0]!.id
    const childEvents = env.emittedLog.filter((e) => e.runId === childRunId)
    const slowFinishedIdx = childEvents.findIndex((e) => e.event.type === 'tool.finished' && e.event.capabilityId === 'test.slow')
    const deliveredIdx = childEvents.findIndex((e) => e.event.type === 'inbox.delivered')
    expect(slowFinishedIdx).toBeGreaterThanOrEqual(0)
    expect(deliveredIdx).toBeGreaterThanOrEqual(0)
    expect(deliveredIdx).toBeGreaterThan(slowFinishedIdx)

    const childMessages = env.threads.listMessages(cThread.id)
    expect(childMessages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('hello mid-flight'))).toBe(true)
  })
})

describe('tree — agent.reply reaches the parent the same way as agent.send (plan 67 §3.3, criterion 7)', () => {
  test("a child's agent.reply is delivered into the parent's thread at its next turn boundary", async () => {
    // The parent spawns the child (waitFor: false) and then waits on a gate, so the reply arrives
    // while the parent is genuinely mid-run — the same deterministic shape criterion 6 already uses.
    const parentGate = { release: null as (() => void) | null }
    const env = setUp([gateCapability(parentGate)])
    const parent = env.createAgent(
      'reply-parent',
      [toolTurn('c1', 'agent_spawn', { agent: 'reply-child', prompt: 'work', waitFor: false }), toolTurn('g1', 'test_gate', {}), textTurn('got the reply')],
      // Includes `agent.reply` even though the parent never calls it itself — a child's effective
      // tools are the INTERSECTION with the parent's own (plan 67 §3.4).
      { tools: ['agent.spawn', 'test.gate', 'agent.reply'], permissions: ['agent.run'] },
    )
    env.createAgent('reply-child', [toolTurn('r1', 'agent_reply', { message: 'checking in' }), textTurn('replied')], { tools: ['agent.reply'], permissions: ['agent.run'] })
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('reply-child')!.id)

    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: parent.id })
    runner.postMessage(thread.id, 'go', 'user:u1')

    await waitUntil(() => parentGate.release !== null)
    parentGate.release!()

    await waitUntil(() => env.finishedEvents.filter((e) => e.threadId === thread.id).some((e) => e.status === 'succeeded'))
    const parentMessages = env.threads.listMessages(thread.id)
    expect(parentMessages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('checking in'))).toBe(true)
  })
})

describe('tree — agent.send / agent.reply cannot address a run outside the tree (plan 67 §4.2, criterion 15)', () => {
  test('agent.send to an unrelated run is refused before any delivery', async () => {
    const env = setUp([echoCapability()])
    const a = env.createAgent('a-solo', [toolTurn('c1', 'agent_send', { runId: 'not-a-descendant', message: 'hi' }), textTurn('done')], {
      tools: ['agent.send'],
      permissions: ['agent.run'],
    })
    void a
    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: a.id })
    const run = runner.postMessage(thread.id, 'go', 'user:u1')
    await waitUntil(() => env.finishedEvents.some((e) => e.runId === run.id))
    expect(env.threads.mustGetRun(run.id).status).toBe('succeeded') // refusal is a tool_result, not a run failure
    const toolResult = env.threads.listMessages(thread.id).find((m) => m.role === 'tool')!
    expect((toolResult.content[0] as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(toolResult.content)).toContain('E_NOT_DESCENDANT')
  })

  test('agent.reply with no parent (a root run) is refused', async () => {
    const env = setUp([echoCapability()])
    const a = env.createAgent('a-root', [toolTurn('c1', 'agent_reply', { message: 'hi' }), textTurn('done')], { tools: ['agent.reply'], permissions: ['agent.run'] })
    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: a.id })
    const run = runner.postMessage(thread.id, 'go', 'user:u1')
    await waitUntil(() => env.finishedEvents.some((e) => e.runId === run.id))
    const toolResult = env.threads.listMessages(thread.id).find((m) => m.role === 'tool')!
    expect((toolResult.content[0] as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(toolResult.content)).toContain('E_NO_PARENT')
  })
})

describe('tree — canSpawn defaults to none (plan 67 §3.4, criterion 5)', () => {
  test('a non-granted spawn is refused, naming both agents, as a tool_result — the parent continues', async () => {
    const env = setUp([echoCapability()])
    const parent = env.createAgent('ungranted-parent', [toolTurn('c1', 'agent_spawn', { agent: 'ungranted-child', prompt: 'go' }), textTurn('ok, could not spawn')], {
      tools: ['agent.spawn'],
      permissions: ['agent.run'],
    })
    env.createAgent('ungranted-child', [textTurn('never runs')], { tools: [], permissions: ['agent.run'] })
    // No grantSpawn call — the default.

    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: parent.id })
    const run = runner.postMessage(thread.id, 'go', 'user:u1')
    await waitUntil(() => env.finishedEvents.some((e) => e.runId === run.id))
    expect(env.threads.mustGetRun(run.id).status).toBe('succeeded')
    const toolResult = env.threads.listMessages(thread.id).find((m) => m.role === 'tool')!
    expect((toolResult.content[0] as { isError?: boolean }).isError).toBe(true)
    const text = JSON.stringify(toolResult.content)
    expect(text).toContain('ungranted-parent')
    expect(text).toContain('ungranted-child')
  })
})

describe('tree — caps fail the SPAWN call, not the run (plan 67 §3.6, criterion 9, 10)', () => {
  test('depth beyond the default cap (3) fails agent.spawn with a named error; the parent continues', async () => {
    const env = setUp([echoCapability()])
    // A real chain, spawned through agent.spawn itself: root (depth 1) → mid (depth 2) → leaf
    // (depth 3). The leaf then attempts ONE more spawn, which would put a child at depth 4 —
    // beyond the default cap — and must be refused as a tool_result, not a run failure.
    const root = env.createAgent(
      'depth-root',
      [toolTurn('c1', 'agent_spawn', { agent: 'depth-mid', prompt: 'go', waitFor: false }), textTurn('spawned mid')],
      { tools: ['agent.spawn'], permissions: ['agent.run'] },
    )
    env.createAgent(
      'depth-mid',
      [toolTurn('c1', 'agent_spawn', { agent: 'depth-leaf', prompt: 'go', waitFor: false }), textTurn('spawned leaf')],
      { tools: ['agent.spawn'], permissions: ['agent.run'] },
    )
    env.createAgent(
      'depth-leaf',
      [toolTurn('c1', 'agent_spawn', { agent: 'depth-mid', prompt: 'too deep', waitFor: false }), textTurn('could not go deeper')],
      { tools: ['agent.spawn'], permissions: ['agent.run'] },
    )
    env.treeStore.grantSpawn(root.id, env.agentsStore.getBySlug('depth-mid')!.id)
    env.treeStore.grantSpawn(env.agentsStore.getBySlug('depth-mid')!.id, env.agentsStore.getBySlug('depth-leaf')!.id)
    env.treeStore.grantSpawn(env.agentsStore.getBySlug('depth-leaf')!.id, env.agentsStore.getBySlug('depth-mid')!.id)

    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: root.id })
    runner.postMessage(thread.id, 'go', 'user:u1')

    const leafThread = () => env.threads.listThreads({ agentId: env.agentsStore.getBySlug('depth-leaf')!.id })[0]
    await waitUntil(() => leafThread() !== undefined)
    const lThread = leafThread()!
    await waitUntil(() => env.threads.listRuns(lThread.id).length > 0 && env.threads.listRuns(lThread.id)[0]!.status === 'succeeded')

    const leafRun = env.threads.listRuns(lThread.id)[0]!
    expect(leafRun.depth).toBe(3)
    const toolResult = env.threads.listMessages(lThread.id).find((m) => m.role === 'tool')!
    expect((toolResult.content[0] as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(toolResult.content)).toContain('E_DEPTH_LIMIT')
  })

  test('the run-count cap (25, cumulative for the tree) fails a further spawn the same way', async () => {
    const env = setUp([echoCapability()])
    const spawnTurns: FakeProviderTurn[] = []
    // Prompts vary per call — three IDENTICAL consecutive tool calls would trip plan 66's own
    // loop detector first, which is a different (and already separately tested) budget.
    for (let i = 0; i < 24; i++) spawnTurns.push(toolTurn(`c${i}`, 'agent_spawn', { agent: 'size-child', prompt: `go ${i}`, waitFor: false }))
    spawnTurns.push(toolTurn('c-over', 'agent_spawn', { agent: 'size-child', prompt: 'go over', waitFor: false }))
    spawnTurns.push(textTurn('done trying'))

    const root = env.createAgent('size-root', spawnTurns, { tools: ['agent.spawn'], permissions: ['agent.run'] })
    // The child agent has no scripted turns at all — it is never expected to run to completion;
    // only that creating its RUN ROW is what the cap counts (plan 67 §3.6: "the whole tree, for its
    // lifetime"). An unscripted fake provider throws, which the runner records as a failed run —
    // still one MORE run in the tree, which is exactly what is being counted here.
    env.createAgent('size-child', [], { tools: [], permissions: ['agent.run'] })
    env.treeStore.grantSpawn(root.id, env.agentsStore.getBySlug('size-child')!.id)

    const runner = env.makeRunner({ maxConcurrentRuns: 50, maxSteps: 30 })
    const thread = runner.createThread({ agentId: root.id })
    const run = runner.postMessage(thread.id, 'go', 'user:u1')

    await waitUntil(() => env.finishedEvents.some((e) => e.runId === run.id), 8000)
    await waitUntil(() => env.threads.listRunsForRoot(run.id).length === 25, 8000)

    const messages = env.threads.listMessages(thread.id)
    const toolResults = messages.filter((m) => m.role === 'tool')
    const refused = toolResults.find((m) => JSON.stringify(m.content).includes('E_TREE_SIZE_LIMIT'))
    expect(refused).toBeDefined()
    expect(env.threads.mustGetRun(run.id).status).toBe('succeeded') // the cap failed the CALL, not the run
  }, 12_000) // 26 real spawns against SQLite comfortably exceeds bun:test's default 5s timeout
})

describe('tree — cascading cancellation is depth-first and releases every device claim (plan 67 §3.5, criterion 12)', () => {
  test('cancelling the root cancels every descendant; afterwards no device in the tree is claimed', async () => {
    const releases = new Map<string, () => void>()
    const env = setUp([holdDeviceCapability(releases)])

    // A child's effective tools/permissions are the INTERSECTION with every ancestor's own (plan 67
    // §3.4) — every agent in this chain lists `test.device.hold`/`device.control` even where it
    // never calls it itself, or the intersection would narrow a descendant's grant to nothing.
    const root = env.createAgent(
      'cascade-root',
      [toolTurn('c1', 'agent_spawn', { agent: 'cascade-mid', prompt: 'go', waitFor: false }), textTurn('spawned mid')],
      { tools: ['agent.spawn', 'test.device.hold'], permissions: ['agent.run', 'device.control'] },
    )
    const mid = env.createAgent(
      'cascade-mid',
      // Spawn the leaf FIRST (non-blocking), THEN hold d1 (blocking) — holding first would never
      // let this run reach the spawn call at all.
      [toolTurn('sp1', 'agent_spawn', { agent: 'cascade-leaf', prompt: 'go', waitFor: false }), toolTurn('h1', 'test_device_hold', { deviceId: 'd1' })],
      { tools: ['test.device.hold', 'agent.spawn'], permissions: ['agent.run', 'device.control'] },
    )
    env.createAgent('cascade-leaf', [toolTurn('h2', 'test_device_hold', { deviceId: 'd2' })], { tools: ['test.device.hold'], permissions: ['agent.run', 'device.control'] })
    env.treeStore.grantSpawn(root.id, env.agentsStore.getBySlug('cascade-mid')!.id)
    env.treeStore.grantSpawn(env.agentsStore.getBySlug('cascade-mid')!.id, env.agentsStore.getBySlug('cascade-leaf')!.id)

    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: root.id })
    const rootRun = runner.postMessage(thread.id, 'go', 'user:u1')

    // Wait until BOTH claims (d1 held by mid, d2 held by leaf) are actually acquired.
    await waitUntil(() => env.agentHolderOf('d1') !== null && env.agentHolderOf('d2') !== null)

    runner.cancelRun(rootRun.id, 'user:tester')
    // Cancellation waits for an in-flight capability call to finish rather than aborting it (plan 66
    // §3.7 step 3) — release the blocked `test.device.hold` calls so that happens promptly instead
    // of waiting out their 60s deadline.
    for (const release of releases.values()) release()

    // The root itself may already have finished normally (it only spawns and reports back) — the
    // property that matters is that its DESCENDANTS, still running, are cancelled as a result of
    // cancelling the tree via its root (the manual smoke test's own step 5). Every run in the tree
    // eventually reaches a terminal state.
    await waitUntil(() => {
      const rows = env.threads.listRunsForRoot(rootRun.id)
      return rows.length >= 3 && rows.every((r) => r.status === 'succeeded' || r.status === 'failed' || r.status === 'cancelled')
    })
    const descendants = env.threads.listRunsForRoot(rootRun.id).filter((r) => r.id !== rootRun.id)
    expect(descendants.length).toBeGreaterThanOrEqual(2)
    expect(descendants.every((r) => r.status === 'cancelled')).toBe(true)
    // The assertion that matters (plan 67 §3.5, §8): the ABSENCE of claims afterwards, not the order.
    expect(env.agentHolderOf('d1')).toBeNull()
    expect(env.agentHolderOf('d2')).toBeNull()
  })
})

describe('tree — a parent killed by maxRunSeconds cancels its still-running children (plan 67 §3.5, criterion 13)', () => {
  test('two detached children keep running until the parent hits its own wall-clock budget, then both are cancelled', async () => {
    const releases = new Map<string, () => void>()
    const env = setUp([holdDeviceCapability(releases), slowCapability(1_200)])

    const parent = env.createAgent(
      'expiring-parent',
      [
        toolTurn('c1', 'agent_spawn', { agent: 'expiring-child-a', prompt: 'go', waitFor: false }),
        toolTurn('c2', 'agent_spawn', { agent: 'expiring-child-b', prompt: 'go', waitFor: false }),
        // A deliberately slow third call so real wall-clock time crosses the 1-second budget below
        // BEFORE the loop's next top-of-iteration check — deterministic, rather than racing a tiny
        // timeout against however long spawning two children happens to take.
        toolTurn('c3', 'test_slow', {}),
      ],
      // Includes `test.device.hold`/`device.control` even though the parent never calls it itself —
      // a child's effective authority is the INTERSECTION with the parent's own (plan 67 §3.4).
      { tools: ['agent.spawn', 'test.slow', 'test.device.hold'], permissions: ['agent.run', 'device.control'] },
    )
    env.createAgent('expiring-child-a', [toolTurn('h1', 'test_device_hold', { deviceId: 'd1' })], { tools: ['test.device.hold'], permissions: ['agent.run', 'device.control'] })
    env.createAgent('expiring-child-b', [toolTurn('h2', 'test_device_hold', { deviceId: 'd2' })], { tools: ['test.device.hold'], permissions: ['agent.run', 'device.control'] })
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('expiring-child-a')!.id)
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('expiring-child-b')!.id)

    // A short wall-clock budget — comfortably crossed once the slow third call resolves.
    const runner = env.makeRunner({ maxRunSeconds: 1 })
    const thread = runner.createThread({ agentId: parent.id })
    const parentRun = runner.postMessage(thread.id, 'go', 'user:u1')

    await waitUntil(() => env.threads.mustGetRun(parentRun.id).status === 'failed' && env.threads.mustGetRun(parentRun.id).stopReason === 'max-seconds', 6000)
    // The cascade signals cancellation to both children, but each is blocked inside its OWN
    // in-flight `test.device.hold` call — release them so cancellation actually completes promptly
    // instead of waiting out the 60s deadline (plan 66 §3.7 step 3).
    await waitUntil(() => releases.size === 2, 6000)
    for (const release of releases.values()) release()

    // Both children are cancelled as a result (plan 67 §3.5, criterion 13) — polled to their
    // terminal state rather than trusting immediate synchronous cascade ordering.
    await waitUntil(() => {
      const rows = env.threads.listRunsForRoot(parentRun.id).filter((r) => r.id !== parentRun.id)
      return rows.length === 2 && rows.every((r) => r.status === 'cancelled')
    })
    expect(env.agentHolderOf('d1')).toBeNull()
    expect(env.agentHolderOf('d2')).toBeNull()
  })
})

describe('tree — one device holder, sibling contention refused naming the winner (plan 67 §3.7, criterion 14)', () => {
  test('a child may use a device its own ancestor holds; a SIBLING contending for the SAME device is refused, naming the winner', async () => {
    const releases = new Map<string, () => void>()
    const parentGate = { release: null as (() => void) | null }
    const env = setUp([holdDeviceCapability(releases), gateCapability(parentGate), deviceTapCapability()])

    const parent = env.createAgent(
      'device-parent',
      [
        toolTurn('c1', 'agent_spawn', { agent: 'device-child-a', prompt: 'hold it', waitFor: false }),
        toolTurn('g1', 'test_gate', {}),
        toolTurn('c2', 'agent_spawn', { agent: 'device-child-b', prompt: 'try it', waitFor: false }),
        textTurn('done'),
      ],
      // Includes both children's device capabilities even though the parent never calls them itself
      // — a child's effective authority is the INTERSECTION with the parent's own (plan 67 §3.4).
      { tools: ['agent.spawn', 'test.gate', 'test.device.hold', 'test.device.tap'], permissions: ['agent.run', 'device.control'] },
    )
    // Child A claims and HOLDS d1 (a blocking capability) — its claim stays live for the whole test.
    env.createAgent('device-child-a', [toolTurn('h1', 'test_device_hold', { deviceId: 'd1' })], {
      tools: ['test.device.hold'],
      permissions: ['agent.run', 'device.control'],
    })
    // Child B (a SIBLING of A — both children of `parent`, not ancestor/descendant of each other)
    // tries to tap the SAME device while A still holds it.
    env.createAgent('device-child-b', [toolTurn('t1', 'test_device_tap', { deviceId: 'd1' }), textTurn('b done')], {
      tools: ['test.device.tap'],
      permissions: ['agent.run', 'device.control'],
    })
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('device-child-a')!.id)
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('device-child-b')!.id)

    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: parent.id })
    runner.postMessage(thread.id, 'go', 'user:u1')

    // Wait until child A has genuinely claimed the device (the real claim is held) before letting
    // the parent proceed to spawn child B — deterministic, not timing-dependent.
    await waitUntil(() => env.agentHolderOf('d1') !== null)
    await waitUntil(() => parentGate.release !== null)
    parentGate.release!()

    const childBThread = () => env.threads.listThreads({ agentId: env.agentsStore.getBySlug('device-child-b')!.id })[0]
    await waitUntil(() => childBThread() !== undefined)
    const bThread = childBThread()!
    await waitUntil(() => env.threads.listRuns(bThread.id).length > 0 && env.threads.listRuns(bThread.id)[0]!.status === 'succeeded')

    const toolResult = env.threads.listMessages(bThread.id).find((m) => m.role === 'tool')!
    expect((toolResult.content[0] as { isError?: boolean }).isError).toBe(true)
    const text = JSON.stringify(toolResult.content)
    expect(text).toContain('E_DEVICE_CONFLICT')
    expect(text).toContain('is already driving')
    expect(text).toContain('device-child-a') // names the winner, by agent name

    releases.get('d1')?.()
  })
})

describe('tree — a shared token budget stops runs across the whole tree (plan 67 §3.6, criterion 11)', () => {
  test('children spend counts against the root; exhaustion stops a run with max-tokens', async () => {
    const env = setUp([echoCapability()])
    const parent = env.createAgent(
      'budget-parent',
      [
        toolTurn('c1', 'agent_spawn', { agent: 'budget-child', prompt: 'go', waitFor: true }),
        textTurn('after child'),
      ],
      { tools: ['agent.spawn'], permissions: ['agent.run'] },
    )
    env.createAgent('budget-child', [textTurn('child spends tokens too')], { tools: [], permissions: ['agent.run'] })
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('budget-child')!.id)

    // A tiny SHARED budget: the parent's own first turn (usage 1 output token, per `textTurn`'s
    // fixture) plus the child's turn (1 more) should exhaust a 1-token cap before the parent's
    // second turn.
    const runner = env.makeRunner({ maxOutputTokens: 1 })
    const thread = runner.createThread({ agentId: parent.id })
    const run = runner.postMessage(thread.id, 'go', 'user:u1')

    await waitUntil(() => env.finishedEvents.some((e) => e.runId === run.id))
    const finished = env.threads.mustGetRun(run.id)
    expect(finished.stopReason).toBe('max-tokens')
  })
})

describe('tree — agent.cancel is destructive and passes through the approval gate (plan 67 §4.2, criterion 16)', () => {
  test('agent.cancel pauses for approval; approving cancels the named descendant', async () => {
    const env = setUp([echoCapability()])
    const parent = env.createAgent(
      'cancel-parent',
      [
        toolTurn('c1', 'agent_spawn', { agent: 'cancel-child', prompt: 'go', waitFor: false }),
        (_i, req) => toolTurn('c2', 'agent_cancel', { runId: lastToolResultRunId(req) }),
        textTurn('cancelled it'),
      ],
      { tools: ['agent.spawn', 'agent.cancel'], permissions: ['agent.run'] },
    )
    env.createAgent('cancel-child', [textTurn('child ack')], { tools: [], permissions: ['agent.run'] })
    env.treeStore.grantSpawn(parent.id, env.agentsStore.getBySlug('cancel-child')!.id)

    const runner = env.makeRunner()
    const thread = runner.createThread({ agentId: parent.id })
    const run = runner.postMessage(thread.id, 'go', 'user:u1')

    await waitUntil(() => env.threads.mustGetRun(run.id).status === 'paused')
    const approval = env.approvals.pendingForRun(run.id)!
    expect(approval.capabilityId).toBe('agent.cancel')

    runner.decideApproval(approval.id, 'approve', 'user:u1')
    await waitUntil(() => env.finishedEvents.some((e) => e.runId === run.id && e.status === 'succeeded'))
    expect(env.threads.mustGetRun(run.id).status).toBe('succeeded')
  })
})

describe('tree — restart: a paused root leaves undelivered inbox rows visible (plan 67 §7 restart scenario)', () => {
  test('a running run is marked interrupted on recovery, its children cancelled, and queued messages remain', async () => {
    const env = setUp([echoCapability()])
    const root = env.createAgent('restart-root', [], { tools: ['agent.spawn'], permissions: ['agent.run'] })
    const child = env.createAgent('restart-child', [], { tools: [], permissions: ['agent.run'] })
    env.treeStore.grantSpawn(root.id, child.id)

    const rootThread = env.threads.createThread({ agentId: root.id, origin: 'chat' })
    const rootRun = env.threads.createRun(rootThread.id)
    env.threads.updateRun(rootRun.id, { status: 'running', startedAt: new Date() })
    // The child is `paused` (e.g. awaiting an approval) rather than itself `running` — restart
    // recovery's own blanket query only catches rows that were DIRECTLY `running` (the root); the
    // child's cascade-to-cancelled path (plan 67 §3.5, criterion 13) is what this test is actually
    // exercising, distinct from the root's own direct "interrupted" outcome.
    const childThread = env.threads.createThread({ agentId: child.id, origin: 'spawn' })
    const childRun = env.threads.createRun(childThread.id, { parentRunId: rootRun.id, rootRunId: rootRun.id, depth: 2 })
    env.threads.updateRun(childRun.id, { status: 'paused', startedAt: new Date() })

    // A message queued for the root, never delivered (the root "crashed" before draining it).
    env.treeStore.enqueue({ targetRunId: rootRun.id, fromRunId: childRun.id, kind: 'message', body: { text: 'still here?' } })

    const runner = env.makeRunner()
    runner.recoverAfterRestart()

    expect(env.threads.mustGetRun(rootRun.id).status).toBe('failed')
    await waitUntil(() => env.threads.mustGetRun(childRun.id).status === 'cancelled')
    // The queued message is neither delivered nor dropped — still inspectable.
    const undelivered = env.treeStore.undeliveredFor(rootRun.id)
    expect(undelivered).toHaveLength(1)
    expect(undelivered[0]!.deliveredAt).toBeNull()
  })
})
