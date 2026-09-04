import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createLogger } from '../util/logger'
import { createActivityRegistry } from '../activity/registry'
import { createDeviceStateMachine } from '../device/state-machine'
import type { CapabilityContextDeps } from '../capability/context'
import { buildCapabilityRegistry, type CapabilityRegistry } from '../capability/registry'
import type { AnyCoreCapability } from '../capability/types'
import { createAgentStore } from './agent-store'
import type { ConnectorKind } from '@enkaku/protocol'
import { createConnectorStore } from './connector-store'
import { createThreadStore } from './thread/store'
import { createApprovalStore } from './approval/store'
import { createTreeStore } from './tree/store'
import { createAgentRunner } from './runner'

/**
 * Plan 75 criterion 8: "An `openrouter` connector can be created, tested,
 * and used by an agent end to end against a fake transport." — and §7's
 * "Integration (fake transport): a full run on each connector kind — one
 * tool call, one text turn, usage recorded."
 *
 * Unlike `runner.test.ts` (which injects `createProvider` to bypass the
 * real adapter entirely), this file deliberately does NOT override
 * `createProvider` — it goes through the REAL `createProviderAdapter` (the
 * connector `kind` branch in `provider/index.ts`) and only fakes the
 * network at the `fetch` seam (`RunnerDeps.fetch`), so it is the one test
 * in this plan proving the whole pipeline (connector kind -> real adapter
 * -> the AI SDK -> a scripted wire response -> ProviderEvent -> the loop)
 * actually connects end to end, for BOTH connector kinds. Still never a
 * real network call (criterion 13).
 */

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

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** One Anthropic-shaped SSE turn: a tool call OR text, then usage, then message_stop. */
function anthropicTurn(opts: { text?: string; toolCall?: { id: string; name: string; input: unknown } }): string {
  const lines: string[] = []
  lines.push(sseChunk('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }))
  if (opts.text !== undefined) {
    lines.push(sseChunk('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    lines.push(sseChunk('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: opts.text } }))
    lines.push(sseChunk('content_block_stop', { type: 'content_block_stop', index: 0 }))
  }
  if (opts.toolCall) {
    lines.push(sseChunk('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: opts.toolCall.id, name: opts.toolCall.name, input: {} } }))
    lines.push(sseChunk('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(opts.toolCall.input) } }))
    lines.push(sseChunk('content_block_stop', { type: 'content_block_stop', index: 0 }))
  }
  lines.push(sseChunk('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
  lines.push(sseChunk('message_stop', { type: 'message_stop' }))
  return lines.join('')
}

/** One OpenAI/OpenRouter-shaped SSE turn: a tool call OR text, then a finish chunk carrying usage. */
function openRouterTurn(opts: { text?: string; toolCall?: { id: string; name: string; input: unknown } }): string {
  const chunks: string[] = []
  const line = (payload: unknown) => chunks.push(`data: ${JSON.stringify(payload)}\n\n`)
  if (opts.text !== undefined) {
    line({ id: 'gen1', model: 'openai/gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: opts.text } }] })
  }
  if (opts.toolCall) {
    line({ id: 'gen1', model: 'openai/gpt-5', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: opts.toolCall.id, type: 'function', function: { name: opts.toolCall.name, arguments: '' } }] } }] })
    line({ id: 'gen1', model: 'openai/gpt-5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(opts.toolCall.input) } }] } }] })
  }
  line({ id: 'gen1', model: 'openai/gpt-5', choices: [{ index: 0, delta: {}, finish_reason: opts.toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  chunks.push('data: [DONE]\n\n')
  return chunks.join('')
}

/**
 * Anthropic's adapter makes a SECOND real request per turn beyond the
 * streamed one — `countTokens()` hits `/v1/messages/count_tokens` directly
 * (`run.ts`'s `tokenEstimator`, called before every `stream()`). This fake
 * must answer that URL with `{input_tokens}` JSON, not the next scripted
 * SSE turn, or it desyncs the turn counter and `countTokens()` throws
 * trying to parse an SSE body as its expected JSON shape. OpenRouter's
 * `countTokens()` never touches the network at all (plan 75 §4.3's cached
 * estimate), so this branch is Anthropic-only in practice.
 */
function sseFetch(turns: string[]): typeof fetch {
  let call = 0
  return (async (url: string) => {
    if (typeof url === 'string' && url.includes('count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 42 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = turns[call] ?? turns[turns.length - 1]!
    call++
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof fetch
}

function setUp(kind: ConnectorKind) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'SER1', label: 'Phone', status: 'online' }).run()

  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const activities = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
  const controlSettings = () => ({ overControl: 'allow' as const, idleSec: 30 })

  const caps = [echoCapability()]
  const registry: CapabilityRegistry = buildCapabilityRegistry(caps.map((cap) => ({ cap, file: 'test' })))
  const threads = createThreadStore(db)
  const approvals = createApprovalStore({ db, ttlSec: 3600 })
  const agentsStore = createAgentStore({ db, registry })
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-e2e-test-'))
  const connectors = createConnectorStore({ db, dataDir })

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

  const connector = connectors.create({ name: `${kind}-e2e`, kind, credential: `fake-${kind}-key` })
  const agent = agentsStore.create(
    { slug: `e2e-${kind}-agent`, name: `E2E ${kind} Agent`, connectorId: connector.id, model: kind === 'openrouter' ? 'openai/gpt-5' : 'claude-opus-5', tools: caps.map((c) => c.id), settings: { maxConcurrentRuns: 1 } },
    null,
  )

  const finishedEvents: { threadId: string; runId: string; status: string }[] = []
  const treeStore = createTreeStore(db)

  function makeRunner(turns: string[]) {
    return createAgentRunner({
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
            model: agent.model,
            systemPrompt: 'You are a test agent.',
            effort: 'medium',
            thinking: false,
            maxOutputTokens: 4096,
            maxSteps: 10,
            maxRunSeconds: 600,
            compactAtRatio: 0.7,
            maxConcurrentRuns: 1,
          },
        }) as never,
      modelListCache: { get: async () => ({ models: [{ id: agent.model ?? 'fake-model', contextWindow: 200_000, supportsThinking: false }], fallback: false }), invalidate: () => {} },
      roleOf: () => 'operator',
      emit: () => {},
      onRunStarted: () => {},
      onRunFinished: (thread, run) => finishedEvents.push({ threadId: thread.id, runId: run.id, status: run.status }),
      tree: treeStore,
      publishToThread: () => {},
      // Deliberately NOT overriding `createProvider` — this exercises the real
      // `createProviderAdapter(kind, ...)` branch, only faking the network.
      fetch: sseFetch(turns),
      log: createLogger('test'),
    })
  }

  return { db, dataDir, threads, connectors, connector, agent, finishedEvents, makeRunner }
}

describe.each([['anthropic'], ['openrouter']] as const)('end-to-end against a fake transport — connector kind %s (plan 75 criterion 8, §7)', (kind) => {
  test('a real connector runs one tool call then one text turn, and usage is recorded', async () => {
    const env = setUp(kind)
    const turn1 = kind === 'anthropic' ? anthropicTurn({ toolCall: { id: 'call_1', name: 'test_echo', input: { text: 'ping' } } }) : openRouterTurn({ toolCall: { id: 'call_1', name: 'test_echo', input: { text: 'ping' } } })
    const turn2 = kind === 'anthropic' ? anthropicTurn({ text: 'all done' }) : openRouterTurn({ text: 'all done' })
    const runner = env.makeRunner([turn1, turn2])

    const thread = runner.createThread({ agentId: env.agent.id })
    const run = runner.postMessage(thread.id, 'please echo ping', 'user:u1')

    for (let i = 0; i < 100 && env.finishedEvents.length === 0; i++) await noopWaiter(10)

    expect(env.finishedEvents.some((e) => e.runId === run.id && e.status === 'succeeded')).toBe(true)
    const finalRun = env.threads.getRun(run.id)!
    expect(finalRun.usage?.inputTokens).toBeGreaterThan(0)
    expect(finalRun.usage?.outputTokens).toBeGreaterThan(0)

    const messages = env.threads.listMessages(thread.id)
    // The capability's permission check is orthogonal to what this test verifies (the connector's
    // wiring through the real AI SDK adapter) — `ownerRole: null` here means EVERY permission is
    // denied by design (`effectivePermissions` returns `[]` for a null owner, `agent-store.ts`), so
    // the tool call is correctly refused as `E_FORBIDDEN` rather than executed. What matters for
    // criterion 8 is that the round trip happened at all: a real `tool_use` was parsed off the wire,
    // dispatched through `invoke()`, its result appended, and the loop continued to a second turn.
    const toolCall = messages.find((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('"tool_use"') && JSON.stringify(m.content).includes('call_1'))
    expect(toolCall).toBeTruthy()
    const toolResult = messages.find((m) => m.role === 'tool' && JSON.stringify(m.content).includes('call_1'))
    expect(toolResult).toBeTruthy()
    const finalText = messages.find((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('all done'))
    expect(finalText).toBeTruthy()
  })

  test('the connector can be tested end to end against a scripted fake transport — never a real network call', async () => {
    const env = setUp(kind)
    const listModelsBody =
      kind === 'anthropic'
        ? { data: [{ id: 'claude-opus-5', type: 'model', display_name: 'Opus 5', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 200_000, max_tokens: 8192, capabilities: null }], has_more: false, first_id: 'claude-opus-5', last_id: 'claude-opus-5' }
        : { data: [{ id: 'openai/gpt-5', context_length: 128_000 }] }
    const fetchImpl = (async () => new Response(JSON.stringify(listModelsBody), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    // A second store over the SAME db/dataDir, this one with the fake transport wired in — `test()`
    // goes through the real `testProviderConnection(kind, ...)` branch (`provider/index.ts`), exactly
    // as `POST /connectors/:id/test` does, and never touches the network.
    const testableConnectors = createConnectorStore({ db: env.db, dataDir: env.dataDir, fetch: fetchImpl })
    const result = await testableConnectors.test(env.connector.id)
    expect(result.status).toBe('ok')
  })
})
