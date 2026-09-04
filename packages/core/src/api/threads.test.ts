import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { openDb, runMigrations, type Db } from '../db'
import type { AuthEnv } from '../auth/middleware'
import { devices, users } from '../db/schema'
import { createLogger } from '../util/logger'
import { createActivityRegistry } from '../activity/registry'
import { createDeviceStateMachine } from '../device/state-machine'
import type { CapabilityContextDeps } from '../capability/context'
import { buildCapabilityRegistry } from '../capability/registry'
import { createThreadStore } from '../agent/thread/store'
import { createApprovalStore } from '../agent/approval/store'
import { createAgentStore } from '../agent/agent-store'
import { createConnectorStore } from '../agent/connector-store'
import { createTreeStore } from '../agent/tree/store'
import { createFakeProvider, type FakeProviderTurn } from '../agent/provider/fake'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import { createAgentWsHandler } from '../server/ws-handlers-agent'
import { createThreadRoutes } from './threads'

/**
 * Route-level tests for `packages/core/src/api/threads.ts` — mirroring the
 * adjacent, already-tested routes' own shape (plan 78 §7's own noted gap:
 * no test previously booted this Hono app at all). Focuses on plan 83's new
 * surface — `GET .../delete-preview` and `DELETE /threads/:id` — since the
 * chat-stream route itself has its own dedicated HTTP test file.
 */

function setUp(caps: import('../capability/types').AnyCoreCapability[] = []) {
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
  const connectors = createConnectorStore({ db, dataDir: mkdtempSync(join(tmpdir(), 'enkaku-threads-route-test-')) })
  const treeStore = createTreeStore(db)
  const capContextDeps: CapabilityContextDeps = { db, activities, controlSettings, states, sessions: () => null, readiness: () => null, transfer: null, jobService: {} as never, workspace: {} as never }
  const connector = connectors.create({ name: 'test-connector', kind: 'anthropic', credential: 'sk-ant-fake' })
  const agent = agentsStore.create(
    { slug: `route-test-agent-${crypto.randomUUID()}`, name: 'Route Test Agent', connectorId: connector.id, model: 'fake-model', tools: caps.map((c) => c.id), permissions: ['agent.run'], settings: { maxConcurrentRuns: 1 } },
    'admin-user',
  )

  let agentRunnerRef: AgentRunner | null = null
  const agentWsHandler = createAgentWsHandler({ runner: { cancelRun: (runId, by) => agentRunnerRef?.cancelRun(runId, by) } })
  const turns: FakeProviderTurn[] = [[{ type: 'text_delta', text: 'hi' }, { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'done' }]]
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
        // Plan 212 §4.7 moved agent settings into their own store: the key the
        // runner reads is `defaults`, not the old `agentDefaults`. The `as
        // never` below is why this drifted silently — a cast, not a type.
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
    createProvider: () => createFakeProvider({ turns }),
    log: createLogger('test'),
  })
  agentRunnerRef = runner

  const records: unknown[] = []
  const audit = { record: (entry: unknown) => records.push(entry), list: () => [] } as unknown as Parameters<typeof createThreadRoutes>[0]['audit']
  const threadRoutes = createThreadRoutes({ runner, threads, approvals, agentWs: agentWsHandler, audit })
  // `requirePermission` reads `c.get('user')` — the auth-setting middleware must be registered on
  // an OUTER app mounted BEFORE the routes it guards (Hono composes the handler chain in
  // registration order; adding it to `threadRoutes` itself after its routes are already defined
  // would never run ahead of them, matching how `server/http.ts` really applies `authMiddleware`).
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'admin-user', email: 'admin@test', role: 'admin' } as never)
    await next()
  })
  app.route('/', threadRoutes)
  return { app, threads, runner, agent, auditRecords: records }
}

describe('GET /threads/:id/delete-preview', () => {
  test('reports how many messages and runs the thread carries', async () => {
    const { app, threads, runner, agent } = setUp()
    const thread = runner.createThread({ agentId: agent.id })
    const run = runner.postMessage(thread.id, 'hello', 'admin-user')
    for (let i = 0; i < 50 && runner.runStatus(run.id) !== 'succeeded'; i++) await new Promise((r) => setTimeout(r, 5))
    expect(threads.getRun(run.id)?.status).toBe('succeeded') // fails loudly if the fake provider ever stalls, instead of a false pass below

    const res = await app.request(`/threads/${thread.id}/delete-preview`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { counts: { messages: number; runs: number } }
    expect(body.counts.runs).toBe(1)
    expect(body.counts.messages).toBeGreaterThanOrEqual(1)
  })
})

describe('DELETE /threads/:id', () => {
  test('deletes an idle thread and records an audit entry', async () => {
    const { app, threads, auditRecords } = setUp()
    const thread = threads.createThread({ agentId: 'agent-x' })
    threads.appendMessage({ threadId: thread.id, runId: null, role: 'user', content: [{ type: 'text', text: 'hi' }] })

    const res = await app.request(`/threads/${thread.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: true; counts: { messages: number; runs: number } }
    expect(body.deleted).toBe(true)
    expect(body.counts.messages).toBe(1)
    expect(threads.getThread(thread.id)).toBeNull()
    expect(auditRecords.some((r) => (r as { action: string }).action === 'agent.thread.delete')).toBe(true)
  })

  test('refuses to delete a thread with a running run — 409, thread survives', async () => {
    const { app, threads } = setUp()
    const thread = threads.createThread({ agentId: 'agent-x' })
    const run = threads.createRun(thread.id)
    threads.updateRun(run.id, { status: 'running', startedAt: new Date() })

    const res = await app.request(`/threads/${thread.id}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(threads.getThread(thread.id)).not.toBeNull()
  })

  test('a non-existent thread reports 404', async () => {
    const { app } = setUp()
    const res = await app.request('/threads/does-not-exist', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
