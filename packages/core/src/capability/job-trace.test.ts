import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { JobDetail, JobTraceEvent } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { jobEvents } from '../db/schema'
import { createJobRoutes } from '../api/jobs'
import { createTraceFrameStore, type TraceFrameStore } from '../jobs/trace/frame-store'
import type { JobService } from '../services/job-service'
import { createWorkspaceStore } from '../workspace/store'
import { createMcpServer } from '../mcp/server'
import { buildCoreCapabilityRegistry } from './index'
import { createCapabilityContext, type CapabilityContext, type CapabilityContextDeps } from './context'
import { invoke } from './invoke'
import { jobTrace, jobTraceFrame, jobTraceUi, JOB_TRACE_CAPABILITIES } from './job-trace'

/**
 * Plan 130 §4.1, step 130.1 — `job.trace`/`.trace.ui`/`.trace.frame`.
 *
 * The core claim under test is EQUIVALENCE with the already-verified REST routes (plan 130 §0.1):
 * every "returns what the route returns" test below seeds the same `job_events`/`TraceFrameStore`
 * data, drives BOTH the capability (through `invoke()`) and the real `createJobRoutes` app for the
 * identical input, and asserts the bodies are deeply equal — not merely "shaped the same".
 *
 * The MCP describe block at the bottom follows `mcp/server.test.ts`'s own shape (as plan 130 §5
 * step 130.1 asks) but lives here rather than editing that file, which is outside this task's
 * edit scope (`packages/core/src/capability/`, `agent/plugins/automation.ts`, and their tests).
 */

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function setUp(): { db: Db; dataDir: string; store: TraceFrameStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-job-trace-cap-'))
  tmpDirs.push(dataDir)
  return { db: opened.db, dataDir, store: createTraceFrameStore({ dataDir }) }
}

function seedEvent(db: Db, jobId: string, seq: number, overrides: Partial<typeof jobEvents.$inferInsert> = {}): void {
  db.insert(jobEvents)
    .values({ id: `${jobId}-${seq}`, jobId, seq, atMs: 1_000 + seq, attempt: 1, kind: 'action', name: 'tap', ...overrides })
    .run()
}

function fakeJobDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    jobId: 'job-1',
    deviceId: 'd1',
    scriptId: 'x',
    scriptName: null,
    scriptVersion: null,
    status: 'success',
    error: null,
    failureClass: null,
    priority: 0,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    batchId: null,
    batchSeq: null,
    expiresAt: null,
    errorPhase: null,
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    peakRssBytes: null,
    assistCount: 0,
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    resultStatus: null,
    resultSummary: null,
    result: null,
    params: null,
    resultBytes: null,
    resultIssues: null,
    resultSchema: null,
    ...overrides,
  }
}

/** A `JobService` whose `get()` is the only method the capabilities under test call — `enqueue`/`cancel`/`list` throw if reached, exactly like `api/jobs.test.ts`'s own `fakeService` would flag an unexpected call. */
function fakeJobService(getResult: JobDetail | null): JobService {
  return {
    enqueue: () => {
      throw new Error('not used')
    },
    cancel: () => {
      throw new Error('not used')
    },
    get: () => getResult,
    list: () => ({ jobs: [], nextCursor: null, total: 0 }),
  } as unknown as JobService
}

const QUOTAS = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }

function contextDepsFor(db: Db, service: JobService, traceStore?: TraceFrameStore): CapabilityContextDeps {
  return {
    db,
    leases: { getLease: () => null, getHolder: () => null } as unknown as CapabilityContextDeps['leases'],
    states: { current: () => 'idle' } as unknown as CapabilityContextDeps['states'],
    sessions: () => null,
    readiness: () => null,
    transfer: null,
    jobService: service,
    workspace: createWorkspaceStore(db, () => QUOTAS),
    ...(traceStore ? { traceStore } : {}),
  }
}

function ctxFor(db: Db, service: JobService, traceStore?: TraceFrameStore): CapabilityContext {
  return createCapabilityContext(contextDepsFor(db, service, traceStore), { id: 'u1', role: 'operator' })
}

/** Mounts `createJobRoutes` behind an authenticated-operator middleware, mirroring `api/jobs.test.ts`'s own `withUser` — the REST comparison must actually reach the route's handler, not be refused at `requirePermission('job.view')` before it. */
function restAppFor(service: JobService, deps?: Parameters<typeof createJobRoutes>[1]): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'op@example.com', role: 'operator' })
    await next()
  })
  wrapper.route('/', createJobRoutes(service, deps))
  return wrapper
}

async function traceViaRest(db: Db, service: JobService, jobId: string, query: string): Promise<unknown> {
  const app = restAppFor(service, { db })
  return (await app.request(`/${jobId}/trace${query}`)).json()
}

describe('job.trace (plan 130 §4.1, step 130.1)', () => {
  test('returns exactly what GET /api/jobs/:id/trace returns for the same input, including nextCursor', async () => {
    const { db } = setUp()
    for (let seq = 1; seq <= 5; seq += 1) seedEvent(db, 'job-1', seq)
    const service = fakeJobService(fakeJobDetail())
    const ctx = ctxFor(db, service)

    const capResult = await invoke(jobTrace, ctx, { jobId: 'job-1', limit: 2 })
    const restBody = await traceViaRest(db, service, 'job-1', '?limit=2')

    expect(capResult.ok).toBe(true)
    if (capResult.ok) expect(capResult.output).toEqual(restBody)
  })

  test('paging follows the cursor exactly like the REST route (seq order, never atMs)', async () => {
    const { db } = setUp()
    seedEvent(db, 'job-1', 1, { atMs: 9_000 })
    seedEvent(db, 'job-1', 2, { atMs: 1_000 })
    const service = fakeJobService(fakeJobDetail())
    const ctx = ctxFor(db, service)

    const capResult = await invoke(jobTrace, ctx, { jobId: 'job-1' })
    expect(capResult.ok).toBe(true)
    if (capResult.ok) {
      const output = capResult.output as { items: JobTraceEvent[] }
      expect(output.items.map((e) => e.seq)).toEqual([1, 2])
      expect(output.items.map((e) => e.atMs)).toEqual([9_000, 1_000])
    }
  })

  test('the kind filter works, is repeatable, and matches the REST route\'s filtered set', async () => {
    const { db } = setUp()
    seedEvent(db, 'job-1', 1, { kind: 'action' })
    seedEvent(db, 'job-1', 2, { kind: 'log' })
    seedEvent(db, 'job-1', 3, { kind: 'phase' })
    seedEvent(db, 'job-1', 4, { kind: 'log' })
    const service = fakeJobService(fakeJobDetail())
    const ctx = ctxFor(db, service)

    const one = await invoke(jobTrace, ctx, { jobId: 'job-1', kind: ['log'] })
    const oneRest = await traceViaRest(db, service, 'job-1', '?kind=log')
    expect(one.ok).toBe(true)
    if (one.ok) expect(one.output).toEqual(oneRest)

    const two = await invoke(jobTrace, ctx, { jobId: 'job-1', kind: ['action', 'phase'] })
    const twoRest = await traceViaRest(db, service, 'job-1', '?kind=action&kind=phase')
    expect(two.ok).toBe(true)
    if (two.ok) expect(two.output).toEqual(twoRest)
  })

  test('an unknown job gives job_not_found — never a bare crash', async () => {
    const { db } = setUp()
    const ctx = ctxFor(db, fakeJobService(null))
    const result = await invoke(jobTrace, ctx, { jobId: 'ghost' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('job_not_found')
  })

  test('a job that recorded nothing is an empty page, not a 404', async () => {
    const { db } = setUp()
    const ctx = ctxFor(db, fakeJobService(fakeJobDetail()))
    const result = await invoke(jobTrace, ctx, { jobId: 'job-1' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.output).toEqual({ items: [], nextCursor: null, total: 0 })
  })
})

describe('job.trace.ui (plan 130 §4.1, step 130.1)', () => {
  const node = {
    resourceId: 'com.app:id/post',
    text: 'Post',
    desc: '',
    className: 'android.widget.TextView',
    packageName: 'com.app',
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    clickable: true,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
  }

  test('returns exactly what GET /api/jobs/:id/trace/ui/:hash returns for the same hash', async () => {
    const { db, store } = setUp()
    const hash = await store.putUiTree('job-1', node)
    const service = fakeJobService(fakeJobDetail())
    const ctx = ctxFor(db, service, store)
    const restApp = restAppFor(service, { db, traceStore: store })

    const capResult = await invoke(jobTraceUi, ctx, { jobId: 'job-1', uiHash: hash })
    const restBody = await (await restApp.request(`/job-1/trace/ui/${hash}`)).json()

    expect(capResult.ok).toBe(true)
    if (capResult.ok) expect(capResult.output).toEqual(restBody)
    expect(capResult.ok && capResult.output).toEqual(node)
  })

  test('a missing snapshot gives ui_snapshot_not_found, the REST route\'s own code', async () => {
    const { db, store } = setUp()
    const ctx = ctxFor(db, fakeJobService(fakeJobDetail()), store)
    const result = await invoke(jobTraceUi, ctx, { jobId: 'job-1', uiHash: 'c'.repeat(64) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ui_snapshot_not_found')
  })

  test('a malformed hash is refused, not sanitised — broken once, confirmed, and the guard never bypassed', async () => {
    const { db, store } = setUp()
    const ctx = ctxFor(db, fakeJobService(fakeJobDetail()), store)
    for (const bad of ['not-a-hash', 'A'.repeat(64), '..%2F..%2Fsecret', `${'a'.repeat(63)}.`]) {
      const result = await invoke(jobTraceUi, ctx, { jobId: 'job-1', uiHash: bad })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('E_BAD_REQUEST')
    }
    // The guard restored: a well-formed hash for a real snapshot still works.
    const hash = await store.putUiTree('job-1', node)
    const restored = await invoke(jobTraceUi, ctx, { jobId: 'job-1', uiHash: hash })
    expect(restored.ok).toBe(true)
  })

  test('an unknown job gives job_not_found before the hash is even looked at', async () => {
    const { db, store } = setUp()
    const ctx = ctxFor(db, fakeJobService(null), store)
    const result = await invoke(jobTraceUi, ctx, { jobId: 'ghost', uiHash: 'not-a-hash' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('job_not_found')
  })
})

describe('job.trace.frame (plan 130 §4.1, §3.2, step 130.1)', () => {
  test('returns one base64 PNG whose bytes match the REST route\'s raw bytes for the same hash', async () => {
    const { db, store } = setUp()
    const bytes = new Uint8Array([1, 2, 3, 4])
    const hash = await store.putFrame('job-1', bytes)
    const service = fakeJobService(fakeJobDetail())
    const ctx = ctxFor(db, service, store)
    const restApp = restAppFor(service, { db, traceStore: store })

    const capResult = await invoke(jobTraceFrame, ctx, { jobId: 'job-1', frameHash: hash })
    const restRes = await restApp.request(`/job-1/trace/frames/${hash}`)
    const restBytes = new Uint8Array(await restRes.arrayBuffer())

    expect(capResult.ok).toBe(true)
    if (capResult.ok) {
      const output = capResult.output as { image: string; format: string }
      expect(output.format).toBe('png')
      expect(new Uint8Array(Buffer.from(output.image, 'base64'))).toEqual(restBytes)
      expect(restBytes).toEqual(bytes)
    }
  })

  test('a well-formed hash with no file behind it gives frame_not_found, the REST route\'s own code', async () => {
    const { db, store } = setUp()
    const ctx = ctxFor(db, fakeJobService(fakeJobDetail()), store)
    const result = await invoke(jobTraceFrame, ctx, { jobId: 'job-1', frameHash: 'b'.repeat(64) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('frame_not_found')
  })

  test('a malformed hash is refused, not sanitised — broken once, confirmed, and the guard never bypassed', async () => {
    const { db, store } = setUp()
    const ctx = ctxFor(db, fakeJobService(fakeJobDetail()), store)
    for (const bad of ['not-a-hash', 'A'.repeat(64), '..%2F..%2Fsecret', `${'a'.repeat(63)}.`]) {
      const result = await invoke(jobTraceFrame, ctx, { jobId: 'job-1', frameHash: bad })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('E_BAD_REQUEST')
    }
    // The guard restored: a well-formed hash for a real frame still works.
    const hash = await store.putFrame('job-1', new Uint8Array([9]))
    const restored = await invoke(jobTraceFrame, ctx, { jobId: 'job-1', frameHash: hash })
    expect(restored.ok).toBe(true)
  })

  test('an unknown job gives job_not_found before the hash is even looked at', async () => {
    const { db, store } = setUp()
    const ctx = ctxFor(db, fakeJobService(null), store)
    const result = await invoke(jobTraceFrame, ctx, { jobId: 'ghost', frameHash: 'not-a-hash' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('job_not_found')
  })

  test('never a list or a range: the input schema has no way to ask for more than one frame', () => {
    const shape = jobTraceFrame.input as unknown as { shape: Record<string, unknown> }
    expect(Object.keys(shape.shape).sort()).toEqual(['frameHash', 'jobId'])
  })

  test('a host with no traceStore wired refuses by name (E_NOT_SUPPORTED) rather than crashing', async () => {
    const { db } = setUp()
    const ctx = ctxFor(db, fakeJobService(fakeJobDetail())) // no traceStore
    const result = await invoke(jobTraceFrame, ctx, { jobId: 'job-1', frameHash: 'b'.repeat(64) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_NOT_SUPPORTED')
  })
})

describe('the three trace capabilities are declared correctly (plan 63 §4.3, plan 70 §4.3)', () => {
  test('all three carry permission job.view, lease none, and a non-empty description', () => {
    for (const cap of JOB_TRACE_CAPABILITIES) {
      expect(cap.permission).toBe('job.view')
      expect(cap.lease).toBe('none')
      expect(cap.effect).toBe('read')
      expect(cap.description.length).toBeGreaterThan(10)
    }
  })

  test('job.trace.frame declares imageOutputs against a field that really exists on its own output schema', () => {
    expect(jobTraceFrame.imageOutputs).toEqual([{ dataField: 'image', mediaType: 'image/png' }])
    const shape = jobTraceFrame.output as unknown as { shape: Record<string, unknown> }
    expect('image' in shape.shape).toBe(true)
  })

  test('job.trace and job.trace.ui declare no imageOutputs — job.trace.ui is structured JSON, not a base64 field', () => {
    expect(jobTrace.imageOutputs).toBeUndefined()
    expect(jobTraceUi.imageOutputs).toBeUndefined()
  })

  test('the real capability registry boots with all three ids present, permission job.view, and no duplicate', () => {
    const registry = buildCoreCapabilityRegistry()
    for (const id of ['job.trace', 'job.trace.ui', 'job.trace.frame']) {
      expect(registry.get(id)?.id).toBe(id)
    }
  })
})

// ---- MCP: "the third surface reading the one door" (mcp/server.ts's own comment) ----
//
// Follows `mcp/server.test.ts`'s shape, per plan 130 §5 step 130.1 — kept in this file rather than
// that one, which sits outside this task's edit scope.
function mcpAppAs(role: 'operator' | null, contextDeps: CapabilityContextDeps): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'op@example.com', role })
    await next()
  })
  wrapper.route('/', createMcpServer({ registry: buildCoreCapabilityRegistry(), contextDeps, serverVersion: 'test' }))
  return wrapper
}

async function rpc(app: Hono<AuthEnv>, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()) as Record<string, unknown>
}

describe('MCP server lists the three new tools with no MCP-specific code (plan 63 §4.4)', () => {
  test('tools/list includes job.trace, job.trace.ui and job.trace.frame', async () => {
    const { db } = setUp()
    const app = mcpAppAs('operator', contextDepsFor(db, fakeJobService(fakeJobDetail())))
    const body = await rpc(app, 'tools/list')
    const names = (body.result as { tools: { name: string }[] }).tools.map((t) => t.name)
    expect(names).toContain('job.trace')
    expect(names).toContain('job.trace.ui')
    expect(names).toContain('job.trace.frame')
  })

  test('tools/call for job.trace.frame runs through invoke() end to end — no bypass', async () => {
    const { db, store } = setUp()
    const hash = await store.putFrame('job-1', new Uint8Array([5, 6, 7]))
    const app = mcpAppAs('operator', contextDepsFor(db, fakeJobService(fakeJobDetail()), store))

    const body = await rpc(app, 'tools/call', { name: 'job.trace.frame', arguments: { jobId: 'job-1', frameHash: hash } })
    const result = body.result as { isError: boolean; structuredContent: { image: string; format: string } }
    expect(result.isError).toBe(false)
    expect(result.structuredContent.format).toBe('png')
    expect(new Uint8Array(Buffer.from(result.structuredContent.image, 'base64'))).toEqual(new Uint8Array([5, 6, 7]))
  })

  test('an unauthenticated MCP caller is refused E_FORBIDDEN for job.trace, same as every other capability', async () => {
    const { db } = setUp()
    const app = mcpAppAs(null, contextDepsFor(db, fakeJobService(fakeJobDetail())))
    const body = await rpc(app, 'tools/call', { name: 'job.trace', arguments: { jobId: 'job-1' } })
    const result = body.result as { isError: boolean; structuredContent: { error: { code: string } } }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('E_FORBIDDEN')
  })
})
