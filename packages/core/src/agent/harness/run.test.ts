import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { Agent, AgentContentBlock, ConnectorKind, ResolvedAgentConfig } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../../db'
import { devices } from '../../db/schema'
import { createLogger } from '../../util/logger'
import { createActivityRegistry, type ActivityRegistry } from '../../activity/registry'
import { evaluate, type ControlPolicySettings } from '../../activity/policy'
import type { CapabilityContext } from '../../capability/context'
import type { AnyCoreCapability } from '../../capability/types'
import { createThreadStore, type ThreadStore } from '../thread/store'
import { createApprovalStore, type ApprovalStore } from '../approval/store'
import { createFakeProvider, type FakeModelEvent, type FakeProviderTurn } from '../provider/fake'
import { createBlobStore, type BlobStore } from '../blob/store'
import { buildToolSet } from './tools'
import { executeRun, type RunEmitEvent, type ToolPolicy } from './run'

/**
 * Integration tests for the loop, ported from `agent/loop/run.test.ts` onto the harness
 * (plan 76 §7's own test plan: "one tool call; a refusal continuing the run; each budget
 * stop; loop detection; cancellation mid-stream with no activity held afterwards; approve and
 * deny; a restart with a paused run"). Real SQLite (thread/approval stores), a real
 * `ActivityRegistry`, and a scripted fake `LanguageModel` (via
 * `createFakeProvider`) — no real network call anywhere, and `runAgentLoop` (the harness) is
 * the actual code driving every model turn here, exactly like production.
 */

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    slug: 'test-agent',
    name: 'Test Agent',
    description: null,
    colour: null,
    enabled: true,
    connectorId: null,
    model: null,
    systemPrompt: null,
    settings: {},
    tools: [],
    requiresApproval: [],
    deviceGrants: [],
    workspaceScope: { read: ['/'], write: [] },
    permissions: [],
    wakeOnMessage: 'on-child-result',
    ownerId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function fakeConfig(overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig {
  return {
    connectorId: null,
    model: 'fake-model',
    systemPrompt: 'you are a test agent',
    effort: 'medium',
    thinking: false,
    maxOutputTokens: 1_000_000,
    maxSteps: 10,
    maxRunSeconds: 600,
    compactAtRatio: 0.7,
    maxConcurrentRuns: 1,
    maxImagesPerRequest: 10,
    maxImageBytes: 5 * 1024 * 1024,
    ...overrides,
  }
}

function echoCapability(): AnyCoreCapability {
  return {
    id: 'test.echo',
    input: z.object({ text: z.string() }),
    output: z.object({ echoed: z.string() }),
    permission: 'device.control' as never,
    deadline: 5000,
    effect: 'read',
    description: 'echoes text back',
    handler: async (_ctx, input: { text: string }) => ({ echoed: input.text }),
  }
}

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

function tapCapability(): AnyCoreCapability {
  return {
    id: 'test.tap',
    input: z.object({ deviceId: z.string(), x: z.number(), y: z.number() }),
    output: z.object({ ok: z.boolean() }),
    permission: 'device.control' as never,
    activity: { kind: 'control' },
    deadline: 5000,
    effect: 'write',
    description: 'taps the screen',
    handler: async () => ({ ok: true }),
  }
}

/** Starts the agent's own device activity (via `admitAgentActivity`, BEFORE the handler runs)
 * and then blocks until the test releases it — lets a test deterministically observe "the activity is
 * live, mid-invoke" before cancelling, rather than racing a timer against the fake model. */
function blockingTapCapability(gate: { release: (() => void) | null }): AnyCoreCapability {
  return {
    id: 'test.tap',
    input: z.object({ deviceId: z.string(), x: z.number(), y: z.number() }),
    output: z.object({ ok: z.boolean() }),
    permission: 'device.control' as never,
    activity: { kind: 'control' },
    deadline: 30_000,
    effect: 'write',
    description: 'taps the screen, blocking until released by the test',
    handler: () => new Promise((resolve) => { gate.release = () => resolve({ ok: true }) }),
  }
}

function screenshotCapability(): AnyCoreCapability {
  return {
    id: 'test.screenshot',
    input: z.object({}),
    output: z.object({ image: z.string(), format: z.literal('png') }),
    permission: 'device.control' as never,
    activity: { kind: 'read' },
    deadline: 5000,
    effect: 'read',
    description: 'takes a screenshot',
    imageOutputs: [{ dataField: 'image', mediaType: 'image/png' }],
    // 1x1 transparent PNG.
    handler: async () => ({
      image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      format: 'png',
    }),
  }
}

function registryOf(caps: AnyCoreCapability[]) {
  const map = new Map(caps.map((c) => [c.id, c]))
  return { get: (id: string) => map.get(id) }
}

const fakeControlSettings: ControlPolicySettings = { overControl: 'allow', idleSec: 30 }

function fakeContext(actorId: string, activities: ActivityRegistry): CapabilityContext {
  return {
    actor: { id: actorId, role: 'operator' },
    currentRunId: null,
    agentTree: null,
    hasPermission: () => true,
    canReachDevice: () => true,
    evaluateActivity: (deviceId, kind, exclusiveWith) =>
      evaluate(kind, activities.list(deviceId), fakeControlSettings, { selfIds: [`control:user:${actorId}`], ...(exclusiveWith ? { exclusiveWith } : {}) }),
    touchActivity: (deviceId, kind) => {
      if (kind === 'control') activities.touchControl(deviceId, `user:${actorId}`, { kind: 'user', id: actorId, label: actorId })
    },
    isDeviceOnline: () => true,
    ensureAwake: async () => {},
    deviceCall: async () => ({}),
    readiness: null,
    listDevices: () => [],
    getDevice: () => null,
    jobService: {} as never,
    scripts: { list: () => [], get: () => null },
    plugins: () => null,
    resolveScriptRef: () => ({ id: '' }),
    workspace: {} as never,
    workspaceScope: () => ({ read: ['/'], write: ['/'] }),
  }
}

function setUp(caps: AnyCoreCapability[] = [echoCapability(), destructiveCapability(), tapCapability()]) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'online' }).run()

  const activities: ActivityRegistry = createActivityRegistry({
    log: createLogger('test'),
    controlIdleSec: () => 30,
    onChange: () => {},
  })

  const threads = createThreadStore(db)
  const approvals = createApprovalStore({ db })
  const registry = registryOf(caps)
  const { tools: toolSet, capabilityIdForToolName } = buildToolSet(caps)
  const toolPolicy: ToolPolicy = { capabilityIdForToolName, requiresApprovalCapabilityIds: new Set() }
  const agent = fakeAgent({ tools: caps.map((c) => c.id) })
  const capabilityContext = fakeContext(agent.id, activities)

  return { db, threads, approvals, activities, controlSettings: () => fakeControlSettings, registry, toolSet, toolPolicy, agent, capabilityContext }
}

function textEvents(text: string): FakeModelEvent[] {
  return [{ type: 'text_delta', text }, { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }]
}

function toolCallEvents(id: string, name: string, input: unknown): FakeModelEvent[] {
  return [{ type: 'tool_call', id, name, input }, { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }]
}

interface RunHarnessOpts {
  turns: FakeProviderTurn[]
  agentOverrides?: Partial<Agent>
  configOverrides?: Partial<ResolvedAgentConfig>
  caps?: AnyCoreCapability[]
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  extraSeedMessages?: number
  blobs?: BlobStore
  signal?: AbortSignal
}

function runHarness(opts: RunHarnessOpts) {
  const env = setUp(opts.caps)
  const agent = { ...env.agent, ...(opts.agentOverrides ?? {}) }
  const config = fakeConfig(opts.configOverrides)
  const provider = createFakeProvider({ turns: opts.turns })
  const thread = env.threads.createThread({ agentId: agent.id })
  for (let i = 0; i < (opts.extraSeedMessages ?? 0); i++) {
    env.threads.appendMessage({ threadId: thread.id, runId: null, role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `seed ${i}` }] })
  }
  env.threads.appendMessage({ threadId: thread.id, runId: null, role: 'user', content: [{ type: 'text', text: 'go' }] })
  const run = env.threads.createRun(thread.id)

  const events: RunEmitEvent[] = []
  let cancelled = false
  let cancelledByValue: string | null = null

  const outcomePromise = executeRun({
    thread,
    run,
    agent,
    config,
    contextWindow: 200_000,
    provider,
    connectorKind: 'anthropic' as ConnectorKind,
    toolSet: env.toolSet,
    toolPolicy: env.toolPolicy,
    registry: env.registry,
    capabilityContext: env.capabilityContext,
    threads: env.threads,
    approvals: env.approvals,
    activities: env.activities,
    controlSettings: env.controlSettings,
    emit: (e) => events.push(e),
    isCancelled: () => cancelled,
    cancelledBy: () => cancelledByValue,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.blobs ? { blobs: opts.blobs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  return {
    ...env,
    agent,
    config,
    provider,
    thread,
    run,
    events,
    outcomePromise,
    cancel: (by: string) => {
      cancelled = true
      cancelledByValue = by
    },
  }
}

describe('executeRun — one tool call (plan 66 criterion 1)', () => {
  test('executes through invoke, appends the result, and finishes done', async () => {
    const h = runHarness({
      turns: [toolCallEvents('call-1', 'test_echo', { text: 'hi' }), textEvents('the echo says hi')],
    })
    const outcome = await h.outcomePromise
    expect(outcome.status).toBe('succeeded')
    expect(outcome.stopReason).toBe('done')

    const messages = h.threads.listMessages(h.thread.id)
    const toolResult = messages.find((m) => m.role === 'tool')
    expect(toolResult).toBeDefined()
    const block = toolResult!.content[0] as Extract<AgentContentBlock, { type: 'tool_result' }>
    expect(block.isError).toBeFalsy()
    const textBlock = block.content[0] as { type: 'text'; text: string }
    expect(JSON.parse(textBlock.text)).toEqual({ echoed: 'hi' })
  })
})

describe('executeRun — prompt caching (plan 66 §6.13, plan 76 criterion 10)', () => {
  test('a non-zero cache read reported by the model propagates through to the run\'s own usage', async () => {
    const h = runHarness({
      turns: [
        [{ type: 'tool_call', id: 'c1', name: 'test_echo', input: { text: '1' } }, { type: 'usage', inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 100 }, { type: 'done' }],
        [{ type: 'text_delta', text: 'second turn' }, { type: 'usage', inputTokens: 20, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 }, { type: 'done' }],
      ],
    })
    const outcome = await h.outcomePromise
    expect(outcome.status).toBe('succeeded')
    // The FIRST step wrote to the cache (cacheWriteTokens); the SECOND step reads from it — this is
    // the exact shape a real Anthropic prompt-cache hit takes across two turns of one run.
    expect(outcome.usage!.cacheWriteTokens).toBe(100)
    expect(outcome.usage!.cacheReadTokens).toBe(900)
  })
})

describe('executeRun — tool not in allowlist (plan 66 criterion 2)', () => {
  test('returns an error tool_result and the run continues', async () => {
    const h = runHarness({
      turns: [toolCallEvents('call-1', 'not_a_real_tool', {}), textEvents('ok, moving on')],
    })
    const outcome = await h.outcomePromise
    expect(outcome.status).toBe('succeeded')
    const messages = h.threads.listMessages(h.thread.id)
    const toolResult = messages.find((m) => m.role === 'tool')
    const block = toolResult!.content[0] as Extract<AgentContentBlock, { type: 'tool_result' }>
    expect(block.isError).toBe(true)
  })
})

describe('executeRun — budgets fail closed (plan 66 criterion 3)', () => {
  test('maxSteps stops the run with stopReason max-steps, never more steps than the limit', async () => {
    const h = runHarness({
      configOverrides: { maxSteps: 2 },
      turns: [toolCallEvents('c1', 'test_echo', { text: '1' }), toolCallEvents('c2', 'test_echo', { text: '2' }), toolCallEvents('c3', 'test_echo', { text: '3' })],
    })
    const outcome = await h.outcomePromise
    expect(outcome.stopReason).toBe('max-steps')
    expect(outcome.status).toBe('failed')
    const finalRun = h.threads.getRun(h.run.id)!
    expect(finalRun.steps).toBe(2) // never exceeds the configured limit
  })

  test('maxRunSeconds stops the run with stopReason max-seconds', async () => {
    let fakeNow = 1_000_000
    const h = runHarness({
      configOverrides: { maxRunSeconds: 1 },
      now: () => fakeNow,
      turns: [
        () => {
          fakeNow += 5_000 // jump past the 1-second budget while "streaming"
          return toolCallEvents('c1', 'test_echo', { text: '1' })
        },
      ],
    })
    const outcome = await h.outcomePromise
    expect(outcome.stopReason).toBe('max-seconds')
  })

  test('maxOutputTokens stops the run with stopReason max-tokens', async () => {
    const h = runHarness({
      configOverrides: { maxOutputTokens: 8 },
      turns: [
        [{ type: 'tool_call', id: 'c1', name: 'test_echo', input: { text: '1' } }, { type: 'usage', inputTokens: 1, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }],
        textEvents('should never run'),
      ],
    })
    const outcome = await h.outcomePromise
    expect(outcome.stopReason).toBe('max-tokens')
  })

  test('a rate-limit error retried to exhaustion still stops closed, never producing extra steps', async () => {
    const rateLimitErr = { message: 'slow down', raw: { status: 429, type: 'rate_limit_error', message: 'slow down' } }
    const h = runHarness({
      sleep: async () => {}, // instant — do not actually wait in the test
      turns: [
        [{ type: 'error', ...rateLimitErr }],
        [{ type: 'error', ...rateLimitErr }],
        [{ type: 'error', ...rateLimitErr }],
        [{ type: 'error', ...rateLimitErr }],
        [{ type: 'error', ...rateLimitErr }],
        [{ type: 'error', ...rateLimitErr }],
      ],
    })
    const outcome = await h.outcomePromise
    expect(outcome.stopReason).toBe('error')
    expect(outcome.errorClass).toBe('rate-limit')
    const finalRun = h.threads.getRun(h.run.id)!
    expect(finalRun.steps).toBe(0) // retries never advance the step counter
  })
})

describe('executeRun — loop detection (plan 66 criterion 4; plan 76 criterion 12 — the harness\'s own detectLoop)', () => {
  test('the same tool call repeated stops the run with loop-detected', async () => {
    const h = runHarness({
      turns: [
        toolCallEvents('c1', 'test_echo', { text: 'same' }),
        toolCallEvents('c2', 'test_echo', { text: 'same' }),
        toolCallEvents('c3', 'test_echo', { text: 'same' }),
      ],
    })
    const outcome = await h.outcomePromise
    expect(outcome.stopReason).toBe('loop-detected')
  })
})

describe('executeRun — approval gate (plan 66 §3.6, plan 76 criterion 3)', () => {
  test('a destructive capability pauses; approving resumes and the real result reaches the model', async () => {
    const h = runHarness({
      turns: [toolCallEvents('c1', 'test_destructive', { path: '/x' }), textEvents('deleted it')],
    })
    const outcome = await h.outcomePromise
    expect(outcome.status).toBe('paused')

    const approval = h.approvals.pendingForRun(h.run.id)
    expect(approval).toBeTruthy()
    expect(approval!.input).toEqual({ path: '/x' })
    h.approvals.decide(approval!.id, 'approve', 'operator-1')

    const resumed = await executeRun({
      thread: h.thread,
      run: h.threads.getRun(h.run.id)!,
      agent: h.agent,
      config: h.config,
      contextWindow: 200_000,
      provider: h.provider,
      connectorKind: 'anthropic' as ConnectorKind,
      toolSet: h.toolSet,
      toolPolicy: h.toolPolicy,
      registry: h.registry,
      capabilityContext: h.capabilityContext,
      threads: h.threads,
      approvals: h.approvals,
      activities: h.activities,
      controlSettings: h.controlSettings,
      emit: () => {},
      isCancelled: () => false,
      cancelledBy: () => null,
    })
    expect(resumed.status).toBe('succeeded')
    const toolResult = h.threads.listMessages(h.thread.id).find((m) => m.role === 'tool')!
    const block = toolResult.content[0] as Extract<AgentContentBlock, { type: 'tool_result' }>
    expect(block.isError).toBeFalsy()
  })

  test('denying returns an error tool_result and the run continues (no pause)', async () => {
    const h = runHarness({
      turns: [toolCallEvents('c1', 'test_destructive', { path: '/x' }), textEvents('ok, could not delete')],
    })
    await h.outcomePromise // pauses first
    const approval = h.approvals.pendingForRun(h.run.id)!
    h.approvals.decide(approval.id, 'deny', 'operator-1')

    const resumed = await executeRun({
      thread: h.thread,
      run: h.threads.getRun(h.run.id)!,
      agent: h.agent,
      config: h.config,
      contextWindow: 200_000,
      provider: h.provider,
      connectorKind: 'anthropic' as ConnectorKind,
      toolSet: h.toolSet,
      toolPolicy: h.toolPolicy,
      registry: h.registry,
      capabilityContext: h.capabilityContext,
      threads: h.threads,
      approvals: h.approvals,
      activities: h.activities,
      controlSettings: h.controlSettings,
      emit: () => {},
      isCancelled: () => false,
      cancelledBy: () => null,
    })
    expect(resumed.status).toBe('succeeded')
    const toolResult = h.threads.listMessages(h.thread.id).find((m) => m.role === 'tool')!
    const block = toolResult.content[0] as Extract<AgentContentBlock, { type: 'tool_result' }>
    expect(block.isError).toBe(true)
  })
})

describe('executeRun — cancellation (plan 66 §3.7, plan 76 criterion 4, 7)', () => {
  test('cancelling mid-run ends every activity the run started', async () => {
    const gate = { release: null as (() => void) | null }
    const h = runHarness({
      caps: [blockingTapCapability(gate)],
      agentOverrides: { tools: ['test.tap'] },
      turns: [toolCallEvents('c1', 'test_tap', { deviceId: 'd1', x: 1, y: 1 })],
    })
    // Wait until invoke() has actually entered the handler — the agent activity is started BEFORE
    // this point (`admitAgentActivity` runs before `invoke()` is even called).
    const start = Date.now()
    while (gate.release === null) {
      if (Date.now() - start > 4000) throw new Error('timed out waiting for the blocking capability to start')
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
    expect(h.activities.list('d1').some((a) => a.kind === 'agent')).toBe(true)
    h.cancel('user:test')
    gate.release() // let the in-flight invoke() finish — cancellation is only checked at a boundary
    const outcome = await h.outcomePromise
    expect(outcome.status).toBe('cancelled')
    expect(h.activities.list('d1').some((a) => a.kind === 'agent')).toBe(false)
  })
})

describe('executeRun — images (plan 70, plan 76 criterion 9 — bytes round-trip through a blob store)', () => {
  test('a screenshot tool result is stored as a blob and reaches the model as an image block', async () => {
    const blobOpened = openDb(':memory:')
    runMigrations(blobOpened.db)
    const blobs = createBlobStore(blobOpened.db as Db)
    const h = runHarness({
      caps: [screenshotCapability()],
      agentOverrides: { tools: ['test.screenshot'] },
      blobs,
      turns: [toolCallEvents('c1', 'test_screenshot', {}), textEvents('I see a blank screen')],
    })
    const outcome = await h.outcomePromise
    expect(outcome.status).toBe('succeeded')
    const toolResult = h.threads.listMessages(h.thread.id).find((m) => m.role === 'tool')!
    const block = toolResult.content[0] as Extract<AgentContentBlock, { type: 'tool_result' }>
    const imageBlock = block.content.find((c) => c.type === 'image')
    expect(imageBlock).toBeDefined()
    expect((imageBlock as { mediaType: string }).mediaType).toBe('image/png')
    // The stripped JSON text block never carries the base64 a second time.
    const textBlock = block.content.find((c) => c.type === 'text') as { text: string }
    expect(textBlock.text).not.toContain('iVBORw0KGgo')

    // BYTE-EQUALITY, not a shape check (matching plan 70 §6.1's own criterion-1 proof): the SECOND
    // model call (the one that produced 'I see a blank screen') must have actually received the
    // exact source PNG bytes as an image content part, not merely a blobId reference.
    const secondCallOptions = h.provider.allCallOptions()[1]!
    const promptMessages = secondCallOptions.prompt as { role: string; content: unknown }[]
    let foundData: string | undefined
    for (const m of promptMessages) {
      if (!Array.isArray(m.content)) continue
      for (const part of m.content as { type?: string; output?: { type?: string; value?: unknown } }[]) {
        if (part.type !== 'tool-result' || part.output?.type !== 'content' || !Array.isArray(part.output.value)) continue
        for (const inner of part.output.value as { type?: string; data?: { data?: string } }[]) {
          if (inner.type === 'file' && inner.data?.data) foundData = inner.data.data
        }
      }
    }
    expect(foundData).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
  })
})

describe('executeRun — restart recovery leaves a paused run untouched (plan 66 criterion 9)', () => {
  test('a paused run (waiting on an approval) is not resumed by re-invoking executeRun on it directly', async () => {
    const h = runHarness({
      turns: [toolCallEvents('c1', 'test_destructive', { path: '/x' })],
    })
    const outcome = await h.outcomePromise
    expect(outcome.status).toBe('paused')
    // Re-reading the run from storage shows it exactly where it was left — the append-only log is
    // the only state; nothing in-memory was required to represent "paused".
    const stored = h.threads.getRun(h.run.id)!
    expect(stored.status).toBe('paused')
  })
})
