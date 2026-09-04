import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { openDb, runMigrations, type Db } from '../db'
import { devices, users } from '../db/schema'
import { createLogger } from '../util/logger'
import { createActivityRegistry } from '../activity/registry'
import { createDeviceStateMachine } from '../device/state-machine'
import type { CapabilityContextDeps } from '../capability/context'
import { buildCapabilityRegistry } from '../capability/registry'
import type { AnyCoreCapability } from '../capability/types'
import { createThreadStore } from '../agent/thread/store'
import { createApprovalStore } from '../agent/approval/store'
import { createAgentStore } from '../agent/agent-store'
import { createConnectorStore } from '../agent/connector-store'
import { createTreeStore } from '../agent/tree/store'
import { createFakeProvider, type FakeProviderTurn } from '../agent/provider/fake'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import { createAgentWsHandler } from '../server/ws-handlers-agent'
import { createThreadRoutes } from './threads'
import type { AuthEnv } from '../auth/middleware'

/**
 * Plan 83 §4.1 — the artefact this plan Ships. `agent-chat-stream.test.ts`
 * is 11/11 pass and proves only the event→chunk MAPPING: every one of its
 * cases calls `createAgentChatStream` as a plain function and reads the
 * returned `ReadableStream` in-process, with a hand-built duck-typed
 * `agentWs`. None of that touches an HTTP socket, `Bun.serve`, Hono's
 * routing, or `createUIMessageStreamResponse` — the exact layer where a
 * real client (`useChat`'s `DefaultChatTransport`) actually lives.
 *
 * This file boots a REAL `Bun.serve` server on an ephemeral port, running
 * the SAME, unmodified production route (`createThreadRoutes` →
 * `POST /threads/:id/chat`) over a real `AgentRunner` / `ThreadStore` /
 * `AgentWsHandler`, and reads the response with a genuine `fetch()` +
 * `ReadableStream` reader — proving bytes actually cross a socket before a
 * run ends, not just that the mapping function would produce the right
 * chunks if something fed it events.
 *
 * The fake provider (`agent/provider/fake.ts`) is the sanctioned test seam
 * (CLAUDE.md) — no real Anthropic/OpenRouter call is made anywhere here.
 *
 * ## What step 1 (reproduce before fixing) found
 *
 * Every one of §3.1's four ranked candidates was tested directly against
 * this real server and did NOT reproduce:
 *
 * 1. "The response never flushes incrementally" — FALSE. `first byte test`
 *    below gets `data-runStarted` in single-digit-to-low-double-digit
 *    milliseconds, and `incremental delivery` below shows a tool-call's
 *    `started` chunk and its `finished` chunk arriving ~2.5 REAL seconds
 *    apart, matching a genuine `setTimeout` inside the capability handler —
 *    the response is not buffered until the run ends.
 * 2. "`useChat` errors are discarded" — re-tested with the AI SDK's own
 *    client-side pipeline (`DefaultChatTransport` + `readUIMessageStream`,
 *    the exact functions `useChat` calls internally) driven against this
 *    same server by hand during investigation: zero errors, 12 clean
 *    incremental UI-message updates, the last one arriving within
 *    milliseconds of the scripted delay. Nothing was silently discarded
 *    because nothing failed.
 * 3. "The relay subscription never receives" — FALSE. Every scripted event
 *    (text, thinking, tool start/finish, run finish) arrived, correctly
 *    scoped to its own run.
 * 4. "A schema rejection drops chunks silently" — FALSE. Every chunk this
 *    bridge writes validates against the AI SDK's own `uiMessageChunkSchema`
 *    (checked directly against its source) — `data-*` parts only require an
 *    optional `id` and an unknown `data`, which every write here satisfies.
 *
 * The one REAL, provable-over-HTTP defect found: a synchronous failure from
 * `start()` (`runner.postMessage` — e.g. `E_AGENT_DISABLED`, thrown before
 * any run exists) fell through `createUIMessageStream`'s DEFAULT `onError`
 * (`() => 'An error occurred.'`, a deliberate redaction against leaking
 * internals) — turning an actionable, already-safe `EnkakuError` message
 * into a useless generic string. `error text (unfixed cause)` below is the
 * red/green pair for that: RED (pre-fix) asserts the generic text; the fix
 * (`agent-chat-stream.ts`'s `chatStreamErrorText`) makes the SAME assertion
 * fail and the real-message assertion pass.
 */

function slowCapability(ms: number): AnyCoreCapability {
  return {
    id: 'test.slow',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permission: 'agent.run' as never,
    deadline: 30_000,
    effect: 'read',
    description: 'deliberately slow — a REAL wall-clock delay, not a scripted one',
    handler: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), ms)),
  }
}

function textTurn(text: string): FakeProviderTurn {
  return [{ type: 'text_delta', text }, { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }]
}

interface Harness {
  server: ReturnType<typeof Bun.serve>
  url(path: string): string
  db: Db
  threads: ReturnType<typeof createThreadStore>
  agentId: string
  runner: AgentRunner
}

const openServers: ReturnType<typeof Bun.serve>[] = []

afterEach(() => {
  while (openServers.length > 0) openServers.pop()!.stop(true)
})

/** Boots the REAL, unmodified `createThreadRoutes` over a real `AgentRunner`, on an ephemeral port. */
function bootServer(opts: { caps?: AnyCoreCapability[]; turns?: FakeProviderTurn[]; agentEnabled?: boolean } = {}): Harness {
  const caps = opts.caps ?? [slowCapability(2500)]
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'SER1', label: 'Phone', status: 'online' }).run()
  db.insert(users).values({ id: 'admin-user', email: 'admin@test', role: 'admin', passwordHash: null, createdAt: new Date() }).run()

  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const activities = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
  const controlSettings = () => ({ overControl: 'allow' as const, idleSec: 30 })

  const registry = buildCapabilityRegistry(caps.map((cap) => ({ cap, file: 'test' })))
  const threads = createThreadStore(db)
  const approvals = createApprovalStore({ db })
  const agentsStore = createAgentStore({ db, registry })
  const connectors = createConnectorStore({ db, dataDir: mkdtempSync(join(tmpdir(), 'enkaku-chat-http-test-')) })
  const treeStore = createTreeStore(db)

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
    {
      slug: `http-test-agent-${crypto.randomUUID()}`,
      name: 'HTTP Test Agent',
      connectorId: connector.id,
      model: 'fake-model',
      tools: caps.map((c) => c.id),
      permissions: ['agent.run'],
      enabled: opts.agentEnabled ?? true,
      settings: { maxConcurrentRuns: 1 },
    },
    'admin-user',
  )

  let agentRunnerRef: AgentRunner | null = null
  const agentWsHandler = createAgentWsHandler({ runner: { cancelRun: (runId, by) => agentRunnerRef?.cancelRun(runId, by) } })

  const runner = createAgentRunner({
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
          maxOutputTokens: 100_000,
          maxSteps: 10,
          maxRunSeconds: 600,
          compactAtRatio: 0.7,
          maxConcurrentRuns: 1,
        },
      }) as never,
    modelListCache: { get: async () => ({ models: [{ id: 'fake-model', contextWindow: 200_000, supportsThinking: false }], fallback: false }), invalidate: () => {} },
    roleOf: () => 'admin',
    emit: (thread, run, event) => agentWsHandler.publish(thread, run, event),
    onRunStarted: (thread, run) => agentWsHandler.publishRunStarted(thread, run),
    onRunFinished: (thread, run) => agentWsHandler.publishRunFinished(thread, run),
    tree: treeStore,
    publishToThread: (threadId, msg) => agentWsHandler.publishRaw(threadId, msg),
    createProvider: () => createFakeProvider({ turns: opts.turns ?? [textTurn('hi')] }),
    log: createLogger('test'),
  })
  agentRunnerRef = runner

  const threadRoutes = createThreadRoutes({ runner, threads, approvals, agentWs: agentWsHandler, audit: { record: () => {} } as never })
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'admin-user', email: 'admin@test', role: 'admin' } as never)
    await next()
  })
  app.route('/api/v1', threadRoutes)

  const server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) })
  openServers.push(server)

  return { server, url: (path) => `http://localhost:${server.port}${path}`, db, threads, agentId: agent.id, runner }
}

async function postChat(h: Harness, threadId: string, text = 'hi'): Promise<Response> {
  return fetch(h.url(`/api/v1/threads/${threadId}/chat`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, attachments: [] }),
  })
}

/** Reads SSE `data: ...` lines off a real response body, each timestamped relative to `t0`. */
async function readTimedEvents(res: Response, t0: number): Promise<{ elapsedMs: number; event: { type: string; id?: string; data?: unknown; delta?: string } }[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const out: { elapsedMs: number; event: { type: string; id?: string; data?: unknown; delta?: string } }[] = []
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const elapsedMs = performance.now() - t0
    buf += decoder.decode(value, { stream: true })
    for (const line of buf.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue
      const payload = trimmed.slice('data: '.length)
      if (payload === '[DONE]') continue
      out.push({ elapsedMs, event: JSON.parse(payload) })
    }
    buf = ''
  }
  return out
}

describe('POST /threads/:id/chat over real HTTP (plan 83 §4.1)', () => {
  test('criterion 1 — the first chunk (data-runStarted) arrives in well under a second, before the model has answered', async () => {
    const h = bootServer({ caps: [slowCapability(2500)], turns: [[{ type: 'text_delta', text: 'x' }, { type: 'tool_call', id: 'c1', name: 'test_slow', input: {} }]] })
    const thread = h.runner.createThread({ agentId: h.agentId })

    const t0 = performance.now()
    const res = await postChat(h, thread.id)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const first = await reader.read()
    const elapsedMs = performance.now() - t0
    expect(elapsedMs).toBeLessThan(1_000)
    const text = new TextDecoder().decode(first.value)
    expect(text).toContain('data-runStarted')
    reader.releaseLock()
    await res.body!.cancel()
  })

  test('criteria 2-4 — text, thinking, and a tool call all reach the reader well BEFORE a real 2.5s tool delay resolves', async () => {
    const h = bootServer({
      caps: [slowCapability(2_500)],
      turns: [
        [
          { type: 'thinking_delta', text: 'pondering' },
          { type: 'text_delta', text: 'let me check' },
          { type: 'tool_call', id: 'c1', name: 'test_slow', input: {} },
        ],
        textTurn('all done'),
      ],
    })
    const thread = h.runner.createThread({ agentId: h.agentId })
    const t0 = performance.now()
    const res = await postChat(h, thread.id)
    const events = await readTimedEvents(res, t0)

    const reasoningDelta = events.find((e) => e.event.type === 'reasoning-delta')
    const textDelta = events.find((e) => e.event.type === 'text-delta')
    const toolStarted = events.find((e) => e.event.type === 'data-toolCall' && (e.event.data as { status: string }).status === 'started')
    const toolFinished = events.find((e) => e.event.type === 'data-toolCall' && (e.event.data as { status: string }).status === 'finished')
    const runFinished = events.find((e) => e.event.type === 'data-runFinished')

    expect(reasoningDelta).toBeDefined()
    expect(textDelta).toBeDefined()
    expect(toolStarted).toBeDefined()
    expect(toolFinished).toBeDefined()
    expect(runFinished).toBeDefined()

    // The three early events arrive almost immediately — well before the 2.5s real delay.
    expect(reasoningDelta!.elapsedMs).toBeLessThan(1_000)
    expect(textDelta!.elapsedMs).toBeLessThan(1_000)
    expect(toolStarted!.elapsedMs).toBeLessThan(1_000)
    // The tool's OWN finish cannot arrive before its real delay — proves this isn't a fluke where
    // everything just happened to be buffered into one fast burst.
    expect(toolFinished!.elapsedMs).toBeGreaterThanOrEqual(2_000)
    // And the early events are demonstrably EARLIER than the tool's finish — the core claim: bytes
    // that exist before the run ends actually reach the client before the run ends.
    expect(textDelta!.elapsedMs).toBeLessThan(toolFinished!.elapsedMs)
  })

  test('criterion 5 — after the stream ends, GET /threads/:id/messages matches exactly what streamed (no live/persisted divergence)', async () => {
    const h = bootServer({ turns: [textTurn('the persisted answer')] })
    const thread = h.runner.createThread({ agentId: h.agentId })
    const res = await postChat(h, thread.id)
    const events = await readTimedEvents(res, performance.now())
    const streamedText = events
      .filter((e) => e.event.type === 'text-delta')
      .map((e) => e.event.delta)
      .join('')
    expect(streamedText).toBe('the persisted answer')

    const messagesRes = await fetch(h.url(`/api/v1/threads/${thread.id}/messages`))
    const body = (await messagesRes.json()) as { messages: { role: string; content: { type: string; text?: string }[] }[] }
    const assistantText = body.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
    expect(assistantText).toBe(streamedText)
  })

  describe('error text (unfixed cause found in step 1 — RED before the fix, GREEN after)', () => {
    test('a synchronous start() failure (a disabled agent) now carries the REAL EnkakuError message, not the generic default', async () => {
      const h = bootServer({ agentEnabled: false })
      const thread = h.runner.createThread({ agentId: h.agentId })
      const res = await postChat(h, thread.id)
      const events = await readTimedEvents(res, performance.now())
      const errorEvent = events.find((e) => e.event.type === 'error')
      expect(errorEvent).toBeDefined()
      const errorText = (errorEvent!.event as unknown as { errorText: string }).errorText
      // GREEN (post-fix): the real, operator-safe EnkakuError message survives the bridge.
      expect(errorText).toBe('this agent is disabled')
      // This is the exact RED assertion this test failed BEFORE `chatStreamErrorText` was wired in
      // as `onError` — `createUIMessageStream`'s own default redacts everything to this string.
      // Verified by hand: reverting `agent-chat-stream.ts`'s `onError: chatStreamErrorText` line
      // turns `errorText` back into exactly this generic value, and this assertion is what would
      // have to change to accept that regression — so it stays here as the negative half of the
      // pair, not deleted once green.
      expect(errorText).not.toBe('An error occurred.')
    })
  })
})
