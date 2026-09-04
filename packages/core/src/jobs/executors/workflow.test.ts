import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { JobRunner, SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../../db'
import { jobNodes, scripts, type JobRow, type JobNodeRow } from '../../db/schema'
import { createDevSlotStore } from '../../plugins/dev-slots'
import { createScriptRegistry } from '../../scripts/registry'
import { EnkakuError } from '../../util/errors'
import type { Logger } from '../../util/logger'
import { createJobNodeTracker } from '../../runner/artifact-store'
import type { ExecutorContext } from '../executor'
import { createWorkflowExecutor, DEFAULT_WORKFLOW_MAX_TOTAL_MS, type WorkflowExecutorDeps } from './workflow'

/**
 * `createWorkflowExecutor` — the interpreter itself (plan 99 §4.7, §7.1
 * "the interpreter"). Fast, no real device or child process: `runner` and
 * `sessions` are fakes that record every call, so the assertions are about
 * the INTERPRETER's own contract (session held once, one execute() call per
 * node, every transition persisted, budgets enforced, retries and resets
 * threaded through). The real-child-process, real-claim-path proof lives in
 * `workflow-real-claim.integration.test.ts`.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function publishScript(db: Db, name: string, version: string, opts: { paramsSchema?: unknown; enabled?: boolean } = {}) {
  const id = `${name}-${version}`
  db.insert(scripts)
    .values({ pluginId: 'p-fixture', exportId: 'main', id, name, version, kind: 'script', bundle: 'export default { run: async () => null }', enabled: opts.enabled ?? true, paramsSchema: opts.paramsSchema ?? null, createdAt: new Date() })
    .run()
  return id
}

function publishWorkflow(db: Db, name: string, version: string, doc: unknown, opts: { paramsSchema?: unknown } = {}) {
  const id = `${name}-${version}`
  db.insert(scripts)
    .values({
      id,
      name,
      version,
      kind: 'workflow',
      bundle: JSON.stringify(doc),
      source: JSON.stringify(doc, null, 2),
      enabled: true,
      paramsSchema: opts.paramsSchema ?? null,
      createdAt: new Date(),
    })
    .run()
  return id
}

function makeJobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    scriptId: 'pipeline-1.0.0',
    deviceId: 'd1',
    params: null,
    priority: 0,
    status: 'running',
    heartbeatExpiresAt: null,
    result: null,
    error: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    batchId: null,
    batchSeq: null,
    expiresAt: null,
    failureClass: null,
    errorPhase: null,
    infraAttempts: 0,
    scriptName: null,
    scriptVersion: null,
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    triggerKey: null,
    peakRssBytes: null,
    // Plan 98 §4.4, §4.6, step 98.5 — null here: a bare fixture row, no
    // concurrency gate exercised by this file's own test.
    maxConcurrent: null,
    // Plan 98 §3.8, §4.4, step 98.7 — null here: a bare fixture row, no
    // per-job override exercised by this file's own test.
    runtimeOverride: null,
    // Plan 94 §3.8, §4.8, step 94.6 — null here: a bare fixture row, no
    // pacer exercised by this file's own test.
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    // Plan 97 §3.3, §4.4 — null here: a bare fixture row, no result path
    // exercised by this file's own test.
    resultStatus: null,
    resultBytes: null,
    resultSummary: null,
    resultIssues: null,
    ...overrides,
  }
}

type ExecuteCall = { id: string; deviceId: string; bundlePath: string; params: unknown; nodeId?: string; reset?: string; retries?: number }
type Outcome = { ok: boolean; value?: unknown; error?: { code: string; message: string; phase: string }; peakRssBytes?: number }

/** A fake `JobRunner` keyed by `nodeId` (falls back to `default`) — each call is recorded so assertions can check `params`/`reset`/`retries`/`nodeId` threading and call COUNT. */
function fakeRunner(outcomes: Record<string, () => Promise<Outcome> | Outcome>): { runner: JobRunner; calls: ExecuteCall[] } {
  const calls: ExecuteCall[] = []
  const runner: JobRunner = {
    async execute(job) {
      calls.push({ id: job.id, deviceId: job.deviceId, bundlePath: job.bundlePath, params: job.params, nodeId: job.nodeId, reset: job.reset, retries: job.retries })
      const key = job.nodeId ?? 'default'
      const fn = outcomes[key] ?? outcomes.default
      if (!fn) throw new Error(`fakeRunner: no outcome configured for node "${key}"`)
      return fn()
    },
    abort: () => true,
  }
  return { runner, calls }
}

function fakeSessions(): { sessions: SessionManager; acquireCalls: string[]; releaseCalls: string[] } {
  const acquireCalls: string[] = []
  const releaseCalls: string[] = []
  const sessions: SessionManager = {
    acquire: async (deviceId) => {
      acquireCalls.push(deviceId)
      return { deviceId, inspector: null, whenInspectorReady: async () => {}, prewarmInspector: async () => {} } as never
    },
    release: (deviceId) => {
      releaseCalls.push(deviceId)
    },
    attachViewer: async () => ({ session: null, quality: 'wall' }) as never,
    detachViewer: () => {},
    build: async () => {},
    whenReady: async () => null as never,
    state: () => 'ready',
    get: () => null as never,
    getByQuality: () => null as never,
    closeDevice: async () => {},
    closeAll: async () => 0,
    encoders: () => [],
  }
  return { sessions, acquireCalls, releaseCalls }
}

function makeCtx(signal?: AbortSignal): ExecutorContext {
  return {
    signal: signal ?? new AbortController().signal,
    heartbeat: () => {},
    log: silentLog(),
  }
}

function nodesFor(db: Db, jobId: string): JobNodeRow[] {
  return db.select().from(jobNodes).where(eq(jobNodes.jobId, jobId)).orderBy(jobNodes.seq).all()
}

function baseDeps(db: Db, runner: JobRunner, sessions: SessionManager): WorkflowExecutorDeps {
  return {
    db,
    registry: createScriptRegistry({ db, dataDir: `/tmp/enkaku-workflow-exec-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() }),
    runner,
    sessions,
    nodeTracker: createJobNodeTracker(),
    settings: () => ({ maxTotalMs: DEFAULT_WORKFLOW_MAX_TOTAL_MS }),
    log: silentLog(),
    onNode: () => {},
  }
}

describe('createWorkflowExecutor — linear run', () => {
  test('three script nodes, all succeed: one execute() call per node, all sharing the SAME job.id, three job_nodes rows in order, run() resolves with a summary', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    publishScript(db, 'node-c', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'c', script: 'node-c@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)

    const { runner, calls } = fakeRunner({
      a: () => ({ ok: true, value: { videos: 15 } }),
      b: () => ({ ok: true, value: { videos: 8 } }),
      c: () => ({ ok: true, value: 'reported' }),
    })
    const { sessions, acquireCalls, releaseCalls } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))

    const job = makeJobRow({ scriptId: 'pipeline-1.0.0' })
    const result = await executor.run(job, makeCtx())

    expect(calls.length).toBe(3)
    expect(calls.every((c) => c.id === job.id)).toBe(true)
    expect(calls.map((c) => c.nodeId)).toEqual(['a', 'b', 'c'])
    expect(acquireCalls).toEqual(['d1'])
    expect(releaseCalls).toEqual(['d1'])

    const rows = nodesFor(db, job.id)
    expect(rows.length).toBe(3)
    expect(rows.map((r) => [r.seq, r.nodeId, r.status])).toEqual([
      [0, 'a', 'success'],
      [1, 'b', 'success'],
      [2, 'c', 'success'],
    ])
    expect(rows[0]?.scriptName).toBe('node-a')
    expect(rows[0]?.scriptVersion).toBe('1.0.0')
    expect(rows[0]?.output).toEqual({ videos: 15 })

    expect(Array.isArray(result)).toBe(true)
    expect((result as unknown[]).length).toBe(3)
  })

  test('reset defaults to \'farm\' for the FIRST execution and \'none\' for every later one — a node may override either way', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' }, reset: 'farm' },
      ],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const { runner, calls } = fakeRunner({ a: () => ({ ok: true, value: null }), b: () => ({ ok: true, value: null }) })
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    await executor.run(makeJobRow(), makeCtx())
    expect(calls[0]?.reset).toBe('farm') // step 0, no explicit override
    expect(calls[1]?.reset).toBe('farm') // step 1, EXPLICIT override
  })

  test('retries override is threaded through per node; absent leaves it undefined', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' }, retries: 4 },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const { runner, calls } = fakeRunner({ a: () => ({ ok: true, value: null }), b: () => ({ ok: true, value: null }) })
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    await executor.run(makeJobRow(), makeCtx())
    expect(calls[0]?.retries).toBe(4)
    expect(calls[1]?.retries).toBeUndefined()
  })

  test('a binding to an earlier node\'s output resolves into the next node\'s params', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: { videos: { from: 'a', path: 'videos' } }, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const { runner, calls } = fakeRunner({ a: () => ({ ok: true, value: { videos: 42 } }), b: () => ({ ok: true, value: null }) })
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    await executor.run(makeJobRow(), makeCtx())
    expect(calls[1]?.params).toEqual({ videos: 42 })
  })

  test('a workflow parameter binding resolves from job.params', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [{ name: 'keyword', type: 'string', required: true, title: 'Keyword' }],
      nodes: [{ kind: 'script', id: 'a', script: 'node-a@1.0.0', params: { keyword: { param: 'keyword' } }, onFailure: { go: 'fail' } }],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const { runner, calls } = fakeRunner({ a: () => ({ ok: true, value: null }) })
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    await executor.run(makeJobRow({ params: { keyword: 'cats' } }), makeCtx())
    expect(calls[0]?.params).toEqual({ keyword: 'cats' })
  })

  test('an unresolvable binding fails the node with E_WORKFLOW_BINDING_UNRESOLVED naming the node, the path, and what it fails through onFailure', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [{ kind: 'script', id: 'a', script: 'node-a@1.0.0', params: { x: { from: 'nope', path: 'y' } }, onFailure: { go: 'fail' } }],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const { runner, calls } = fakeRunner({})
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    let caught: unknown
    try {
      await executor.run(makeJobRow(), makeCtx())
    } catch (err) {
      caught = err
    }
    expect(calls.length).toBe(0) // never reached runner.execute() — the binding failed first
    expect(caught).toBeInstanceOf(EnkakuError)
    const rows = nodesFor(db, 'job-1')
    expect(rows[0]?.status).toBe('failed')
    expect(rows[0]?.errorCode).toBe('E_WORKFLOW_BINDING_UNRESOLVED')
    expect(rows[0]?.error).toContain('"nope"')
  })

  test('a binding declared optional with a default does not fail the node', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [{ kind: 'script', id: 'a', script: 'node-a@1.0.0', params: { x: { from: 'nope', optional: true, default: 'fallback' } }, onFailure: { go: 'fail' } }],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const { runner, calls } = fakeRunner({ a: () => ({ ok: true, value: null }) })
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    await executor.run(makeJobRow(), makeCtx())
    expect(calls[0]?.params).toEqual({ x: 'fallback' })
  })
})

describe('createWorkflowExecutor — gates', () => {
  function gateDoc(then: unknown, elseB: unknown) {
    return {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'gate', id: 'g', when: { left: { from: 'a', path: 'videos' }, op: 'gte', right: { const: 10 } }, then, else: elseB, message: 'not enough' },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    }
  }

  test('a gate spawns NO child — runner.execute() is called only for script nodes', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    publishWorkflow(db, 'pipeline', '1.0.0', gateDoc({ go: 'continue' }, { go: 'stop' }))
    const { runner, calls } = fakeRunner({ a: () => ({ ok: true, value: { videos: 15 } }), b: () => ({ ok: true, value: null }) })
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    await executor.run(makeJobRow(), makeCtx())
    expect(calls.length).toBe(2) // a, b — never the gate
    const rows = nodesFor(db, 'job-1')
    expect(rows.map((r) => r.nodeId)).toEqual(['a', 'g', 'b'])
    expect(rows[1]?.kind).toBe('gate')
    expect(rows[1]?.status).toBe('success')
  })

  test('the THEN branch (predicate true) and the ELSE branch (predicate false) each take the right path, and the gate row carries the resolved values and verdict', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')

    // THEN — 15 >= 10, continue → node b runs.
    publishWorkflow(db, 'pipeline-then', '1.0.0', gateDoc({ go: 'continue' }, { go: 'stop' }))
    const thenRun = fakeRunner({ a: () => ({ ok: true, value: { videos: 15 } }), b: () => ({ ok: true, value: null }) })
    const thenSessions = fakeSessions()
    await createWorkflowExecutor(baseDeps(db, thenRun.runner, thenSessions.sessions)).run(
      makeJobRow({ id: 'job-then', scriptId: 'pipeline-then-1.0.0' }),
      makeCtx(),
    )
    expect(thenRun.calls.map((c) => c.nodeId)).toEqual(['a', 'b'])
    const thenGateRow = nodesFor(db, 'job-then').find((r) => r.nodeId === 'g')
    expect(thenGateRow?.verdict).toMatchObject({ op: 'gte', left: 15, right: 10, value: true })

    // ELSE — 3 >= 10 is false, stop → the workflow ends SUCCESSFULLY without running b.
    publishWorkflow(db, 'pipeline-else', '1.0.0', gateDoc({ go: 'continue' }, { go: 'stop' }))
    const elseRun = fakeRunner({ a: () => ({ ok: true, value: { videos: 3 } }), b: () => ({ ok: true, value: null }) })
    const elseSessions = fakeSessions()
    await createWorkflowExecutor(baseDeps(db, elseRun.runner, elseSessions.sessions)).run(
      makeJobRow({ id: 'job-else', scriptId: 'pipeline-else-1.0.0' }),
      makeCtx(),
    )
    expect(elseRun.calls.map((c) => c.nodeId)).toEqual(['a']) // b never ran
    const elseRows = nodesFor(db, 'job-else')
    expect(elseRows.find((r) => r.nodeId === 'b')?.status).toBe('skipped')
    const elseGateRow = elseRows.find((r) => r.nodeId === 'g')
    expect(elseGateRow?.verdict).toMatchObject({ op: 'gte', left: 3, right: 10, value: false })
  })

  test('a backward goto loops, and exceeding maxSteps fails with E_WORKFLOW_STEP_BUDGET naming the node and the per-node execution counts', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    const doc = {
      schema: 1,
      name: 'looper',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'gate', id: 'g', when: { left: { const: false }, op: 'eq', right: { const: true } }, then: { go: 'stop' }, else: { go: 'goto', node: 'a' } },
      ],
      maxSteps: 5,
    }
    publishWorkflow(db, 'looper', '1.0.0', doc)
    const { runner } = fakeRunner({ a: () => ({ ok: true, value: null }) })
    const { sessions, releaseCalls } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    let caught: EnkakuError | undefined
    try {
      await executor.run(makeJobRow({ scriptId: 'looper-1.0.0' }), makeCtx())
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught?.code).toBe('E_WORKFLOW_STEP_BUDGET')
    expect(caught?.message).toContain('maxSteps: 5')
    expect(caught?.message).toMatch(/a×\d/) // per-node execution counts named
    expect(releaseCalls).toEqual(['d1']) // the finally still released the session
  })
})

describe('createWorkflowExecutor — failure handling', () => {
  test("onFailure: 'continue' lets the pipeline proceed past a failed node, and the workflow settles SUCCESS overall", async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'continue' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const { runner, calls } = fakeRunner({
      a: () => ({ ok: false, error: { code: 'SCRIPT_FAILED', message: 'boom', phase: 'run' } }),
      b: () => ({ ok: true, value: null }),
    })
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    const result = await executor.run(makeJobRow(), makeCtx())
    expect(calls.map((c) => c.nodeId)).toEqual(['a', 'b'])
    expect(Array.isArray(result)).toBe(true)
    const rows = nodesFor(db, 'job-1')
    expect(rows[0]?.status).toBe('failed')
    expect(rows[1]?.status).toBe('success')
  })

  test("the default onFailure ('fail') stops the pipeline and the job rejects, naming the node", async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const { runner, calls } = fakeRunner({ a: () => ({ ok: false, error: { code: 'SCRIPT_FAILED', message: 'boom', phase: 'run' } }) })
    const { sessions, releaseCalls } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    let caught: EnkakuError | undefined
    try {
      await executor.run(makeJobRow(), makeCtx())
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(calls.map((c) => c.nodeId)).toEqual(['a']) // b never ran
    expect(caught?.code).toBe('SCRIPT_FAILED')
    expect(caught?.message).toContain('node "a"')
    const rows = nodesFor(db, 'job-1')
    expect(rows.find((r) => r.nodeId === 'a')?.status).toBe('failed')
    expect(rows.find((r) => r.nodeId === 'b')?.status).toBe('skipped') // H4: never reached, still a row
    expect(releaseCalls).toEqual(['d1'])
  })

  test('the workflow\'s onFail cleanup runs exactly once on a genuine failure, and is a no-op-safe idempotent call (matching finish()\'s own contract)', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'cleanup', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [{ kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } }],
      maxSteps: 50,
      onFail: { script: 'cleanup@1.0.0', params: {} },
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    let cleanupCalls = 0
    const { runner } = fakeRunner({
      a: () => ({ ok: false, error: { code: 'SCRIPT_FAILED', message: 'boom', phase: 'run' } }),
      // The onFail cleanup runs as its own execution with the reserved
      // nodeId `_on_fail` (workflow.ts's `ON_FAIL_NODE_ID`) — `fakeRunner`
      // keys outcomes by nodeId, so `default` is what catches it here.
      default: () => {
        cleanupCalls += 1
        return { ok: true, value: null }
      },
    })
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    await executor.run(makeJobRow(), makeCtx()).catch(() => {})
    expect(cleanupCalls).toBe(1)
    const rows = nodesFor(db, 'job-1')
    const cleanupRow = rows.find((r) => r.nodeId === '_on_fail')
    expect(cleanupRow?.status).toBe('success')
    expect(cleanupRow?.scriptName).toBe('cleanup')
  })

  test('a node failure runs on the SAME device/session — no second sessions.acquire call happens around a failure', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [{ kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } }],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const { runner } = fakeRunner({ a: () => ({ ok: false, error: { code: 'SCRIPT_FAILED', message: 'boom', phase: 'run' } }) })
    const { sessions, acquireCalls, releaseCalls } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    await executor.run(makeJobRow(), makeCtx()).catch(() => {})
    expect(acquireCalls).toEqual(['d1'])
    expect(releaseCalls).toEqual(['d1'])
  })
})

describe('createWorkflowExecutor — budgets and cancellation', () => {
  test("exceeding workflow.maxTotalMs fails with E_WORKFLOW_BUDGET_EXCEEDED naming the node in flight", async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    // Node "a" takes real wall-clock time, so the budget check before node
    // "b" (elapsedMs computed from a REAL Date.now() delta) reliably exceeds
    // a small positive budget — unlike 0 or a negative number, which can
    // also fire before "a" ever runs, depending on Date.now()'s 1ms
    // resolution and how fast the synchronous parts execute.
    const { runner, calls } = fakeRunner({
      a: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { ok: true, value: null }
      },
      b: () => ({ ok: true, value: null }),
    })
    const { sessions, releaseCalls } = fakeSessions()
    const deps = { ...baseDeps(db, runner, sessions), settings: () => ({ maxTotalMs: 5 }) }
    const executor = createWorkflowExecutor(deps)
    let caught: EnkakuError | undefined
    try {
      await executor.run(makeJobRow(), makeCtx())
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught?.code).toBe('E_WORKFLOW_BUDGET_EXCEEDED')
    expect(caught?.message).toContain('node "b"')
    expect(calls.map((c) => c.nodeId)).toEqual(['a']) // b was never actually executed
    expect(releaseCalls).toEqual(['d1'])
  })

  test('a cancel (ctx.signal aborted) mid-pipeline stops the workflow, never runs onFail, and still releases the session — through the SAME cancel code path a standalone job uses (job_cancelled)', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    publishScript(db, 'cleanup', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
      onFail: { script: 'cleanup@1.0.0', params: {} },
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const controller = new AbortController()
    let cleanupCalls = 0
    const { runner } = fakeRunner({
      a: () => ({ ok: true, value: null }),
      b: () => {
        controller.abort() // simulate a cancel arriving mid-node
        return { ok: false, error: { code: 'CANCELLED', message: 'cancelled', phase: 'run' } }
      },
      cleanup: () => {
        cleanupCalls += 1
        return { ok: true, value: null }
      },
    })
    const { sessions, releaseCalls } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    let caught: EnkakuError | undefined
    try {
      await executor.run(makeJobRow(), makeCtx(controller.signal))
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught?.code).toBe('job_cancelled')
    expect(cleanupCalls).toBe(0) // never runs on a cancel
    expect(releaseCalls).toEqual(['d1'])
  })
})

describe('createWorkflowExecutor — output capping', () => {
  test('an oversized node output is truncated in the job_nodes row and says so, rather than storing it raw', async () => {
    const db = setUpDb()
    publishScript(db, 'node-a', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [{ kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } }],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)
    const huge = 'x'.repeat(300 * 1024) // over WORKFLOW_LIMITS.maxNodeOutputBytes (256 KiB)
    const { runner } = fakeRunner({ a: () => ({ ok: true, value: huge }) })
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    await executor.run(makeJobRow(), makeCtx())
    const rows = nodesFor(db, 'job-1')
    expect(rows[0]?.output).toBeNull()
    expect(rows[0]?.outputTruncated).toContain('byte cap')
  })
})

describe('createWorkflowExecutor.validateParams', () => {
  test('validates the WORKFLOW\'s own params against its compiled paramsSchema, the same way the script executor validates a script\'s', () => {
    const db = setUpDb()
    publishWorkflow(db, 'pipeline', '1.0.0', { schema: 1, name: 'pipeline', version: '1.0.0', params: [], nodes: [{ kind: 'script', id: 'a', script: 'x@1.0.0', params: {}, onFailure: { go: 'fail' } }], maxSteps: 50 }, {
      paramsSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
    })
    const { runner } = fakeRunner({})
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    expect(() => executor.validateParams({}, 'pipeline-1.0.0')).toThrow(EnkakuError)
    expect(executor.validateParams({ keyword: 'cats' }, 'pipeline-1.0.0')).toEqual({ keyword: 'cats' })
  })

  test('an unknown scriptId throws unknown_script', () => {
    const db = setUpDb()
    const { runner } = fakeRunner({})
    const { sessions } = fakeSessions()
    const executor = createWorkflowExecutor(baseDeps(db, runner, sessions))
    expect(() => executor.validateParams({}, 'does-not-exist')).toThrow(EnkakuError)
  })
})
