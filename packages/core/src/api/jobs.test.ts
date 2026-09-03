import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, test } from 'bun:test'
import type { JobDetail, JobInfo, JobNodeInfo, JobTraceEvent } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, jobEvents, jobs } from '../db/schema'
import { createTraceFrameStore, type TraceFrameStore } from '../jobs/trace/frame-store'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import { createJobRoutes, type JobRoutesDeps } from './jobs'

function fakeJobInfo(scriptId: string, overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    jobId: 'job-1',
    deviceId: 'd1',
    scriptId,
    scriptName: null,
    scriptVersion: null,
    status: 'queued',
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
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    resultStatus: null,
    resultSummary: null,
    ...overrides,
  }
}

function fakeJobDetail(scriptId: string, overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    ...fakeJobInfo(scriptId),
    result: null,
    params: null,
    resultBytes: null,
    resultIssues: null,
    resultSchema: null,
    ...overrides,
  }
}

/** Records exactly what `enqueue` was called with, so the route's resolution logic is what's under test — not the service. */
function fakeService(
  opts: {
    getResult?: JobDetail | null
    nodesResult?: { items: JobNodeInfo[]; finalized: boolean }
    /** Returned by `resume()` on success; ignored when `resumeError` is set. */
    resumeResult?: JobInfo
    /** Thrown by `resume()`, e.g. `new EnkakuError('job_not_terminal', ...)`. */
    resumeError?: EnkakuError
  } = {},
): JobService & {
  calls: Parameters<JobService['enqueue']>[0][]
  cancelCalls: Array<{ jobId: string; opts?: { cancelDescendants?: boolean } }>
  listCalls: Parameters<JobService['list']>[0][]
  nodesCalls: string[]
  resumeCalls: Array<{ jobId: string; input?: { fromNode?: string } }>
} {
  const calls: Parameters<JobService['enqueue']>[0][] = []
  const cancelCalls: Array<{ jobId: string; opts?: { cancelDescendants?: boolean } }> = []
  const listCalls: Parameters<JobService['list']>[0][] = []
  const nodesCalls: string[] = []
  const resumeCalls: Array<{ jobId: string; input?: { fromNode?: string } }> = []
  const getResult = opts.getResult === undefined ? fakeJobDetail('x', { jobId: 'job-1', deviceId: 'd1' }) : opts.getResult
  return {
    calls,
    cancelCalls,
    listCalls,
    nodesCalls,
    resumeCalls,
    enqueue(input) {
      calls.push(input)
      return fakeJobInfo(input.scriptId)
    },
    cancel(jobId, opts) {
      cancelCalls.push({ jobId, opts })
      return { job: fakeJobInfo('x'), cancelledDescendants: opts?.cancelDescendants ? 4 : 0 }
    },
    get: (): JobDetail | null => getResult,
    list: (filter) => {
      listCalls.push(filter)
      return { jobs: [], nextCursor: null, total: 0 }
    },
    nodes: (jobId) => {
      nodesCalls.push(jobId)
      return opts.nodesResult ?? { items: [], finalized: false }
    },
    resume: (jobId, input) => {
      resumeCalls.push({ jobId, input })
      if (opts.resumeError) throw opts.resumeError
      return opts.resumeResult ?? fakeJobInfo('pipeline-1.0.0', { jobId: 'job-2', deviceId: 'd1' })
    },
  }
}

/** Mounts `createJobRoutes` behind a user-setting middleware, mirroring `devices.test.ts`'s `withUser` — `role: null` means no user (an auth-less test harness). */
function withUser(role: 'admin' | 'operator' | null, service: JobService, deps?: JobRoutesDeps) {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', createJobRoutes(service, deps))
  return wrapper
}

function fakeAudit(): AuditLogger & { calls: Parameters<AuditLogger['record']>[0][] } {
  const calls: Parameters<AuditLogger['record']>[0][] = []
  return {
    calls,
    record: (input) => {
      calls.push(input)
    },
    list: () => [],
  }
}

describe('POST /api/jobs — scriptId vs scriptRef (plan 62 §4.4)', () => {
  test('scriptId (concrete, unchanged) is passed straight through — no resolver called', async () => {
    const service = fakeService()
    const app = createJobRoutes(service)
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptId: 'concrete-id-1', deviceId: 'd1', params: {} }),
    })
    expect(res.status).toBe(201)
    expect(service.calls[0]?.scriptId).toBe('concrete-id-1')
  })

  test('scriptRef is resolved to a concrete scriptId BEFORE the job row is written (acceptance #5)', async () => {
    const service = fakeService()
    const app = createJobRoutes(service, { resolveScriptRef: (ref) => ({ id: `resolved-for-${ref}` }) })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptRef: 'checkout@latest', deviceId: 'd1', params: {} }),
    })
    expect(res.status).toBe(201)
    expect(service.calls[0]?.scriptId).toBe('resolved-for-checkout@latest')
    const body = (await res.json()) as { job: JobInfo }
    expect(body.job.scriptId).toBe('resolved-for-checkout@latest')
  })

  test('both scriptId and scriptRef in the same request is a 400', async () => {
    const service = fakeService()
    const app = createJobRoutes(service, { resolveScriptRef: (ref) => ({ id: ref }) })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptId: 'a', scriptRef: 'checkout@1.0.0', deviceId: 'd1', params: {} }),
    })
    expect(res.status).toBe(400)
    expect(service.calls).toHaveLength(0)
  })

  test('neither scriptId nor scriptRef is a 400', async () => {
    const service = fakeService()
    const app = createJobRoutes(service)
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd1', params: {} }),
    })
    expect(res.status).toBe(400)
  })

  test('an unresolvable scriptRef refuses with the resolver’s coded error, and never calls enqueue', async () => {
    const service = fakeService()
    const app = createJobRoutes(service, {
      resolveScriptRef: () => {
        throw new EnkakuError('script_not_found', 'no such script')
      },
    })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptRef: 'nope@1.0.0', deviceId: 'd1', params: {} }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('script_not_found')
    expect(service.calls).toHaveLength(0)
  })

  test('an invalid scriptRef shape is rejected by validation, never reaching the resolver', async () => {
    const service = fakeService()
    let resolverCalled = false
    const app = createJobRoutes(service, { resolveScriptRef: (ref) => { resolverCalled = true; return { id: ref } } })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptRef: 'not a valid ref', deviceId: 'd1', params: {} }),
    })
    expect(res.status).toBe(400)
    expect(resolverCalled).toBe(false)
  })
})

describe('POST /api/jobs/:id/cancel — cancelDescendants (plan 81 §4.4)', () => {
  test('without the query param, cancelDescendants is false and the response carries 0', async () => {
    const service = fakeService()
    const app = createJobRoutes(service)
    const res = await app.request('/job-1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(service.cancelCalls).toEqual([{ jobId: 'job-1', opts: { cancelDescendants: false } }])
    const body = (await res.json()) as { cancelledDescendants: number }
    expect(body.cancelledDescendants).toBe(0)
  })

  test('?cancelDescendants=1 is opt-in and forwarded to the service, whose count reaches the response', async () => {
    const service = fakeService()
    const app = createJobRoutes(service)
    const res = await app.request('/job-1/cancel?cancelDescendants=1', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(service.cancelCalls).toEqual([{ jobId: 'job-1', opts: { cancelDescendants: true } }])
    const body = (await res.json()) as { cancelledDescendants: number }
    expect(body.cancelledDescendants).toBe(4)
  })
})

// The old second-operator-grant endpoint at this path is gone — plan 205
// §2.4 deleted that whole subsystem, and with it this endpoint's own
// producer on `JobService`. There is nothing left here to test.

describe('POST /api/jobs/:id/cancel — ownership/permission check (security fix, plan 09 §4.4)', () => {
  test('a job that does not exist is a 404 and never reaches the service', async () => {
    const service = fakeService({ getResult: null })
    const app = withUser('operator', service)
    const res = await app.request('/nope/cancel', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(service.cancelCalls).toHaveLength(0)
  })

  // The bug: an operator — the farm's lowest role — could cancel ANY job on
  // ANY device, farm-wide, because this route never checked anything.
  test('an operator without job.cancel.any is refused cancelling a job on a device owned by someone else', async () => {
    const service = fakeService()
    const audit = fakeAudit()
    const app = withUser('operator', service, { getDeviceOwner: () => ({ ownerId: 'someone-else' }), audit })
    const res = await app.request('/job-1/cancel', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
    expect(service.cancelCalls).toHaveLength(0)
    // A refusal is not an action taken — nothing to audit.
    expect(audit.calls).toHaveLength(0)
  })

  test('an operator CAN cancel a job on a device they own — ordinary operator work — and it is audited with both ids', async () => {
    const service = fakeService()
    const audit = fakeAudit()
    const app = withUser('operator', service, { getDeviceOwner: () => ({ ownerId: 'u1' }), audit })
    const res = await app.request('/job-1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(service.cancelCalls).toEqual([{ jobId: 'job-1', opts: { cancelDescendants: false } }])
    expect(audit.calls).toEqual([
      { userId: 'u1', action: 'job.cancel', target: 'job-1', meta: { deviceId: 'd1', cancelledDescendants: 0 } },
    ])
  })

  test('an operator CAN cancel a job on an unowned device (ownerId: null)', async () => {
    const service = fakeService()
    const app = withUser('operator', service, { getDeviceOwner: () => ({ ownerId: null }) })
    const res = await app.request('/job-1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('an admin can cancel any job regardless of device ownership (job.cancel.any)', async () => {
    const service = fakeService()
    const app = withUser('admin', service, { getDeviceOwner: () => ({ ownerId: 'someone-else' }) })
    const res = await app.request('/job-1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(service.cancelCalls).toHaveLength(1)
  })

  test('no `getDeviceOwner` wired (a test harness / host that has not wired auth) is permissive, the same default every optional ACL dep here uses', async () => {
    const service = fakeService()
    const app = withUser('operator', service)
    const res = await app.request('/job-1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('no user in context is permissive too, matching `enqueue`’s own optional-actor convention just above', async () => {
    const service = fakeService()
    const app = withUser(null, service, { getDeviceOwner: () => ({ ownerId: 'someone-else' }) })
    const res = await app.request('/job-1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/jobs — rootJobId (plan 81 §4.5)', () => {
  test('?rootJobId=<id> is forwarded to the service, for the job detail page’s lineage view', async () => {
    const service = fakeService()
    const app = createJobRoutes(service)
    const res = await app.request('/?rootJobId=root-1')
    expect(res.status).toBe(200)
    expect(service.listCalls[0]?.rootJobId).toBe('root-1')
  })

  test('omitted, rootJobId is undefined — an ordinary list is unaffected', async () => {
    const service = fakeService()
    const app = createJobRoutes(service)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(service.listCalls[0]?.rootJobId).toBeUndefined()
  })
})

describe('GET /api/jobs/:id/nodes (plan 99 §3.5, §4.9, step 99.8)', () => {
  test('returns exactly what service.nodes() reports, for the id in the URL', async () => {
    const item: JobNodeInfo = {
      seq: 0,
      nodeId: 'a',
      kind: 'script',
      scriptId: 'node-a-1.0.0',
      scriptName: 'node-a',
      scriptVersion: '1.0.0',
      status: 'success',
      duration: { startedAt: 1000, finishedAt: 1010, elapsedMs: 10_000 },
      attempts: { current: 1, total: null, lastError: null },
      output: { value: { ok: true }, truncated: null, error: null, verdict: null },
      resumedFromJobId: null,
      resumedFromNode: null,
    }
    const service = fakeService({ nodesResult: { items: [item], finalized: true } })
    const app = withUser('operator', service)
    const res = await app.request('/job-1/nodes')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: JobNodeInfo[]; finalized: boolean }
    expect(body.items).toEqual([item])
    expect(body.finalized).toBe(true)
    expect(service.nodesCalls).toEqual(['job-1'])
  })

  test('requires job.view — no user in context is refused (403)', async () => {
    const service = fakeService()
    const app = withUser(null, service)
    const res = await app.request('/job-1/nodes')
    expect(res.status).toBe(403)
    expect(service.nodesCalls).toHaveLength(0)
  })

  test('a missing job is a 404, matching service.nodes()\'s own job_not_found', async () => {
    const service = fakeService()
    service.nodes = () => {
      throw new EnkakuError('job_not_found', 'no such job: nope')
    }
    const app = withUser('operator', service)
    const res = await app.request('/nope/nodes')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('job_not_found')
  })
})

describe('POST /api/jobs/:id/resume (plan 99 §3.5, §4.9, step 99.8)', () => {
  test('happy path: 201, the new job from service.resume(), fromNode forwarded, and audited', async () => {
    const resumed = fakeJobInfo('pipeline-1.0.0', { jobId: 'job-2', deviceId: 'd1' })
    const service = fakeService({ resumeResult: resumed })
    const audit = fakeAudit()
    const app = withUser('operator', service, { getDeviceOwner: () => ({ ownerId: 'u1' }), audit })
    const res = await app.request('/job-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromNode: 'b' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: JobInfo }
    expect(body.job).toEqual(resumed)
    expect(service.resumeCalls).toEqual([{ jobId: 'job-1', input: { fromNode: 'b' } }])
    expect(audit.calls).toEqual([
      { userId: 'u1', action: 'job.run', target: 'job-2', meta: { resumedFromJobId: 'job-1', fromNode: 'b' } },
    ])
  })

  test('fromNode omitted is forwarded as undefined — the service picks the default', async () => {
    const service = fakeService()
    const app = withUser('operator', service, { getDeviceOwner: () => ({ ownerId: 'u1' }) })
    const res = await app.request('/job-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    expect(service.resumeCalls).toEqual([{ jobId: 'job-1', input: { fromNode: undefined } }])
  })

  test('a missing job is a 404 and never reaches service.resume()', async () => {
    const service = fakeService({ getResult: null })
    const app = withUser('operator', service)
    const res = await app.request('/nope/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
    expect(service.resumeCalls).toHaveLength(0)
  })

  test('a job_not_terminal from the service maps to 409', async () => {
    const service = fakeService({ resumeError: new EnkakuError('job_not_terminal', 'still running') })
    const app = withUser('operator', service, { getDeviceOwner: () => ({ ownerId: 'u1' }) })
    const res = await app.request('/job-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('job_not_terminal')
  })

  test('a job_node_not_found from the service maps to 400', async () => {
    const service = fakeService({ resumeError: new EnkakuError('job_node_not_found', 'never ran') })
    const app = withUser('operator', service, { getDeviceOwner: () => ({ ownerId: 'u1' }) })
    const res = await app.request('/job-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromNode: 'ghost' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('job_node_not_found')
  })

  test('requires job.run — no user in context is refused (403)', async () => {
    const service = fakeService()
    const app = withUser(null, service)
    const res = await app.request('/job-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
    expect(service.resumeCalls).toHaveLength(0)
  })

  test('an operator without ownership of the device is refused (canCancelJob-style device check, 403) — never reaches the service', async () => {
    const service = fakeService()
    const app = withUser('operator', service, { getDeviceOwner: () => ({ ownerId: 'someone-else' }) })
    const res = await app.request('/job-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
    expect(service.resumeCalls).toHaveLength(0)
  })

  test('an admin may resume regardless of device ownership', async () => {
    const service = fakeService()
    const app = withUser('admin', service, { getDeviceOwner: () => ({ ownerId: 'someone-else' }) })
    const res = await app.request('/job-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
  })

  test('a malformed fromNode (empty string) is a 400 before the service is ever called', async () => {
    const service = fakeService()
    const app = withUser('operator', service, { getDeviceOwner: () => ({ ownerId: 'u1' }) })
    const res = await app.request('/job-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromNode: '' }),
    })
    expect(res.status).toBe(400)
    expect(service.resumeCalls).toHaveLength(0)
  })
})

// ---- Plan 128 (M93 — the job trace timeline), step 128.6, §4.3 / §4.5 ----

const traceTmpDirs: string[] = []

afterEach(() => {
  while (traceTmpDirs.length > 0) rmSync(traceTmpDirs.pop()!, { recursive: true, force: true })
})

function traceSetUp(): { db: Db; dataDir: string; store: TraceFrameStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-jobs-api-'))
  traceTmpDirs.push(dataDir)
  return { db: opened.db, dataDir, store: createTraceFrameStore({ dataDir }) }
}

function seedEvent(
  db: Db,
  jobId: string,
  seq: number,
  overrides: Partial<typeof jobEvents.$inferInsert> = {},
): void {
  db.insert(jobEvents)
    .values({ id: `${jobId}-${seq}`, jobId, seq, atMs: 1_000 + seq, attempt: 1, kind: 'action', name: 'tap', ...overrides })
    .run()
}

describe('GET /api/jobs/:id/trace (plan 128 §4.3)', () => {
  test('keyset paging is stable across an insert — no row repeated, none lost', async () => {
    const { db } = traceSetUp()
    for (let seq = 1; seq <= 5; seq += 1) seedEvent(db, 'job-1', seq)
    const app = withUser('operator', fakeService(), { db })

    const page1 = (await (await app.request('/job-1/trace?limit=2')).json()) as {
      items: JobTraceEvent[]
      nextCursor: string | null
      total: number | null
    }
    expect(page1.items.map((e) => e.seq)).toEqual([1, 2])
    expect(page1.total).toBe(5)
    expect(page1.nextCursor).not.toBeNull()

    // An event arriving between the two requests — including the out-of-order
    // case §4.3 describes, where a captured action lands with a LATER seq than
    // a log line that happened before it.
    seedEvent(db, 'job-1', 6, { atMs: 1, kind: 'log', name: 'info' })

    const page2 = (await (await app.request(`/job-1/trace?limit=2&after=${encodeURIComponent(page1.nextCursor!)}`)).json()) as {
      items: JobTraceEvent[]
      nextCursor: string | null
    }
    expect(page2.items.map((e) => e.seq)).toEqual([3, 4])

    const page3 = (await (await app.request(`/job-1/trace?limit=2&after=${encodeURIComponent(page2.nextCursor!)}`)).json()) as {
      items: JobTraceEvent[]
      nextCursor: string | null
    }
    expect(page3.items.map((e) => e.seq)).toEqual([5, 6])
    expect(page3.nextCursor).toBeNull()
  })

  test('the query orders by seq, NEVER by atMs — the client owns the display axis', async () => {
    const { db } = traceSetUp()
    // seq 1 happened LAST by the clock; seq 2 happened first. Ordering by
    // atMs here would break the cursor, which is the whole reason it is seq.
    seedEvent(db, 'job-1', 1, { atMs: 9_000 })
    seedEvent(db, 'job-1', 2, { atMs: 1_000 })
    const app = withUser('operator', fakeService(), { db })

    const body = (await (await app.request('/job-1/trace')).json()) as { items: JobTraceEvent[] }
    expect(body.items.map((e) => e.seq)).toEqual([1, 2])
    expect(body.items.map((e) => e.atMs)).toEqual([9_000, 1_000])
  })

  test('?kind= filters, is repeatable, and the total counts the FILTERED set', async () => {
    const { db } = traceSetUp()
    seedEvent(db, 'job-1', 1, { kind: 'action' })
    seedEvent(db, 'job-1', 2, { kind: 'log' })
    seedEvent(db, 'job-1', 3, { kind: 'phase' })
    seedEvent(db, 'job-1', 4, { kind: 'log' })
    const app = withUser('operator', fakeService(), { db })

    const one = (await (await app.request('/job-1/trace?kind=log')).json()) as { items: JobTraceEvent[]; total: number }
    expect(one.items.map((e) => e.seq)).toEqual([2, 4])
    expect(one.total).toBe(2)

    const two = (await (await app.request('/job-1/trace?kind=action&kind=phase')).json()) as { items: JobTraceEvent[] }
    expect(two.items.map((e) => e.kind)).toEqual(['action', 'phase'])
  })

  test('an unknown kind is a 400, not a silently empty page', async () => {
    const { db } = traceSetUp()
    const app = withUser('operator', fakeService(), { db })
    const res = await app.request('/job-1/trace?kind=screenshot')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('E_BAD_REQUEST')
  })

  test('a malformed cursor is a 400', async () => {
    const { db } = traceSetUp()
    const app = withUser('operator', fakeService(), { db })
    expect((await app.request('/job-1/trace?after=not-a-cursor')).status).toBe(400)
  })

  test('another job’s events are never in the page', async () => {
    const { db } = traceSetUp()
    seedEvent(db, 'job-1', 1)
    seedEvent(db, 'job-2', 1)
    const app = withUser('operator', fakeService(), { db })
    const body = (await (await app.request('/job-1/trace')).json()) as { items: JobTraceEvent[] }
    expect(body.items.map((e) => e.jobId)).toEqual(['job-1'])
  })

  test('a missing job is a 404; a job that recorded nothing is an empty page', async () => {
    const { db } = traceSetUp()
    expect((await withUser('operator', fakeService({ getResult: null }), { db }).request('/ghost/trace')).status).toBe(404)
    const body = (await (await withUser('operator', fakeService(), { db }).request('/job-1/trace')).json()) as unknown
    expect(body).toEqual({ items: [], nextCursor: null, total: 0 })
  })

  test('requires job.view — no user in context is refused (403)', async () => {
    const { db } = traceSetUp()
    expect((await withUser(null, fakeService(), { db }).request('/job-1/trace')).status).toBe(403)
  })
})

describe('GET /api/jobs/:id/trace/frames|ui/:hash (plan 128 §3.5, §4.3)', () => {
  test('a stored frame is served as an immutable, private PNG', async () => {
    const { dataDir, store } = traceSetUp()
    const hash = await store.putFrame('job-1', new Uint8Array([1, 2, 3, 4]))
    const app = withUser('operator', fakeService(), { traceStore: store, dataDir })

    const res = await app.request(`/job-1/trace/frames/${hash}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, immutable')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  test('a well-formed hash with no file behind it is a 404 (never captured, or swept)', async () => {
    const { store } = traceSetUp()
    const app = withUser('operator', fakeService(), { traceStore: store })
    const res = await app.request(`/job-1/trace/frames/${'b'.repeat(64)}`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('frame_not_found')
  })

  test('a malformed hash is a 400 — refused before a path is built, never a traversal', async () => {
    const { dataDir, store } = traceSetUp()
    writeFileSync(join(dataDir, 'secret.png'), 'not yours')
    const app = withUser('operator', fakeService(), { traceStore: store, dataDir })

    for (const bad of ['not-a-hash', 'A'.repeat(64), '..%2F..%2Fsecret', `${'a'.repeat(63)}.`]) {
      const res = await app.request(`/job-1/trace/frames/${bad}`)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('E_BAD_REQUEST')
    }
    // The file the traversal was reaching for is still exactly where it was.
    expect(existsSync(join(dataDir, 'secret.png'))).toBe(true)
  })

  test('a stored ui tree is served as JSON, gunzipped', async () => {
    const { store } = traceSetUp()
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
    const hash = await store.putUiTree('job-1', node)
    const app = withUser('operator', fakeService(), { traceStore: store })

    const res = await app.request(`/job-1/trace/ui/${hash}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect((await res.json()) as unknown).toEqual(node)
  })

  test('a missing ui snapshot is a 404', async () => {
    const { store } = traceSetUp()
    const app = withUser('operator', fakeService(), { traceStore: store })
    expect((await app.request(`/job-1/trace/ui/${'c'.repeat(64)}`)).status).toBe(404)
  })
})

describe('DELETE /api/jobs/:id (plan 128 §4.3, §4.5)', () => {
  function seedSettledJob(db: Db, dataDir: string, id: string): { artifactPath: string; traceDir: string } {
    db.insert(jobs).values({ id, scriptId: 's', deviceId: 'd1', status: 'success', createdAt: new Date() }).run()
    seedEvent(db, id, 1)
    const rel = join('artifacts', id, 'a.png')
    mkdirSync(join(dataDir, 'artifacts', id), { recursive: true })
    writeFileSync(join(dataDir, rel), 'bytes')
    db.insert(artifacts).values({ id: `${id}-a`, jobId: id, kind: 'screenshot', path: rel, createdAt: new Date() }).run()
    const traceDir = join(dataDir, 'traces', id)
    mkdirSync(traceDir, { recursive: true })
    writeFileSync(join(traceDir, `${'a'.repeat(64)}.png`), 'frame')
    return { artifactPath: join(dataDir, rel), traceDir }
  }

  test('a settled job leaves no job_events, no artifact row, no artifact file and no trace directory', async () => {
    const { db, dataDir } = traceSetUp()
    const seeded = seedSettledJob(db, dataDir, 'job-1')
    const audit = fakeAudit()
    const service = fakeService({ getResult: fakeJobDetail('s', { jobId: 'job-1', status: 'success' }) })
    const app = withUser('operator', service, { db, dataDir, getDeviceOwner: () => ({ ownerId: 'u1' }), audit })

    const res = await app.request('/job-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown).toEqual({
      jobId: 'job-1',
      deleted: { jobs: 1, events: 1, artifacts: 1, nodes: 0, traceDirs: 1 },
    })
    expect(db.select().from(jobs).all()).toEqual([])
    expect(db.select().from(jobEvents).all()).toEqual([])
    expect(db.select().from(artifacts).all()).toEqual([])
    expect(existsSync(seeded.artifactPath)).toBe(false)
    expect(existsSync(seeded.traceDir)).toBe(false)
    expect(audit.calls.map((a) => a.action)).toEqual(['job.delete'])
  })

  test('a running job is refused with job_not_settled (409) and nothing is deleted', async () => {
    const { db, dataDir } = traceSetUp()
    seedSettledJob(db, dataDir, 'job-1')
    const service = fakeService({ getResult: fakeJobDetail('s', { jobId: 'job-1', status: 'running' }) })
    const app = withUser('operator', service, { db, dataDir, getDeviceOwner: () => ({ ownerId: 'u1' }) })

    const res = await app.request('/job-1', { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('job_not_settled')
    expect(db.select().from(jobs).all()).toHaveLength(1)
    expect(db.select().from(jobEvents).all()).toHaveLength(1)
  })

  test('a queued job is refused too — cancel it first', async () => {
    const { db, dataDir } = traceSetUp()
    const service = fakeService({ getResult: fakeJobDetail('s', { jobId: 'job-1', status: 'queued' }) })
    const app = withUser('operator', service, { db, dataDir, getDeviceOwner: () => ({ ownerId: 'u1' }) })
    expect((await app.request('/job-1', { method: 'DELETE' })).status).toBe(409)
  })

  test('a missing job is a 404', async () => {
    const { db, dataDir } = traceSetUp()
    const app = withUser('operator', fakeService({ getResult: null }), { db, dataDir })
    expect((await app.request('/ghost', { method: 'DELETE' })).status).toBe(404)
  })

  test('an operator without ownership of the device is refused (403) — deleting is not a looser verb than cancelling', async () => {
    const { db, dataDir } = traceSetUp()
    seedSettledJob(db, dataDir, 'job-1')
    const service = fakeService({ getResult: fakeJobDetail('s', { jobId: 'job-1', status: 'success' }) })
    const app = withUser('operator', service, { db, dataDir, getDeviceOwner: () => ({ ownerId: 'someone-else' }) })

    const res = await app.request('/job-1', { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect(db.select().from(jobs).all()).toHaveLength(1)
  })

  test('requires job.run — no user in context is refused (403)', async () => {
    const { db } = traceSetUp()
    expect((await withUser(null, fakeService(), { db }).request('/job-1', { method: 'DELETE' })).status).toBe(403)
  })
})

describe('POST /api/jobs/history/clear (plan 128 §4.3)', () => {
  function seedJobRow(db: Db, id: string, opts: { deviceId?: string; status?: string; finishedAt?: number }): void {
    db.insert(jobs)
      .values({
        id,
        scriptId: 's',
        deviceId: opts.deviceId ?? 'd1',
        status: opts.status ?? 'success',
        createdAt: new Date(0),
        finishedAt: opts.finishedAt === undefined ? null : new Date(opts.finishedAt * 1000),
      })
      .run()
    seedEvent(db, id, 1)
  }

  test('the route is not swallowed by /:id — "history" is a valid job id shape', async () => {
    const { db } = traceSetUp()
    seedJobRow(db, 'job-1', {})
    const app = withUser('admin', fakeService(), { db })
    const res = await app.request('/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { deleted: { jobs: number } }).deleted.jobs).toBe(1)
  })

  test('before: only jobs that settled before the instant', async () => {
    const { db } = traceSetUp()
    seedJobRow(db, 'old', { finishedAt: 1_000 })
    seedJobRow(db, 'new', { finishedAt: 9_000 })
    const app = withUser('admin', fakeService(), { db })

    const res = await app.request('/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before: 5_000 }),
    })
    expect(((await res.json()) as { deleted: { jobs: number } }).deleted.jobs).toBe(1)
    expect(db.select().from(jobs).all().map((j) => j.id)).toEqual(['new'])
    expect(db.select().from(jobEvents).all().map((e) => e.jobId)).toEqual(['new'])
  })

  test('deviceId: only that device’s jobs', async () => {
    const { db } = traceSetUp()
    seedJobRow(db, 'a', { deviceId: 'd1' })
    seedJobRow(db, 'b', { deviceId: 'd2' })
    const app = withUser('admin', fakeService(), { db })

    const res = await app.request('/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd2' }),
    })
    expect(((await res.json()) as { deleted: { jobs: number } }).deleted.jobs).toBe(1)
    expect(db.select().from(jobs).all().map((j) => j.id)).toEqual(['a'])
  })

  test('status: only those statuses', async () => {
    const { db } = traceSetUp()
    seedJobRow(db, 'ok', { status: 'success' })
    seedJobRow(db, 'bad', { status: 'failed' })
    const app = withUser('admin', fakeService(), { db })

    const res = await app.request('/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: ['failed'] }),
    })
    expect(((await res.json()) as { deleted: { jobs: number } }).deleted.jobs).toBe(1)
    expect(db.select().from(jobs).all().map((j) => j.id)).toEqual(['ok'])
  })

  test('a queued or running job the filter matched is SKIPPED and counted, never deleted mid-flight', async () => {
    const { db } = traceSetUp()
    seedJobRow(db, 'done', { status: 'success' })
    seedJobRow(db, 'live', { status: 'running' })
    seedJobRow(db, 'waiting', { status: 'queued' })
    const audit = fakeAudit()
    const app = withUser('admin', fakeService(), { db, audit })

    const res = await app.request('/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = (await res.json()) as { deleted: { jobs: number }; skipped: number }
    expect(body.deleted.jobs).toBe(1)
    expect(body.skipped).toBe(2)
    expect(db.select().from(jobs).all().map((j) => j.id).sort()).toEqual(['live', 'waiting'])
    expect(audit.calls.map((a) => a.action)).toEqual(['job.history.clear'])
  })

  test('the filters AND together', async () => {
    const { db } = traceSetUp()
    seedJobRow(db, 'hit', { deviceId: 'd2', status: 'failed', finishedAt: 1_000 })
    seedJobRow(db, 'wrong-device', { deviceId: 'd1', status: 'failed', finishedAt: 1_000 })
    seedJobRow(db, 'wrong-status', { deviceId: 'd2', status: 'success', finishedAt: 1_000 })
    seedJobRow(db, 'too-recent', { deviceId: 'd2', status: 'failed', finishedAt: 9_000 })
    const app = withUser('admin', fakeService(), { db })

    const res = await app.request('/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before: 5_000, deviceId: 'd2', status: ['failed'] }),
    })
    expect(((await res.json()) as { deleted: { jobs: number } }).deleted.jobs).toBe(1)
    expect(db.select().from(jobs).all().map((j) => j.id).sort()).toEqual(['too-recent', 'wrong-device', 'wrong-status'])
  })

  test('a malformed body is a 400 before anything is deleted', async () => {
    const { db } = traceSetUp()
    seedJobRow(db, 'a', {})
    const app = withUser('admin', fakeService(), { db })
    const res = await app.request('/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: ['not-a-status'] }),
    })
    expect(res.status).toBe(400)
    expect(db.select().from(jobs).all()).toHaveLength(1)
  })

  test('requires job.history.purge — no user in context is refused (403)', async () => {
    const { db } = traceSetUp()
    const res = await withUser(null, fakeService(), { db }).request('/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  // Plan 128 §9 Q4 — the whole reason this route does NOT sit on `job.run`.
  // An operator selecting by filter rather than by a device they own could
  // otherwise erase every run on every device in the farm, including the
  // trace frames that are the only record of what those runs did. If this
  // test ever starts passing with 'operator', the permission has been
  // widened and that has to be a deliberate decision, not a refactor.
  test('an OPERATOR is refused (403) — bulk erasure is not an operator action', async () => {
    const { db } = traceSetUp()
    seedJobRow(db, 'job-1', {})
    const res = await withUser('operator', fakeService(), { db }).request('/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
    // ...and nothing was deleted on the way to being refused.
    expect(db.select().from(jobs).all()).toHaveLength(1)
  })

  test('DELETE /:id is deliberately NOT raised to job.history.purge — an operator still deletes their own settled job', async () => {
    const { db } = traceSetUp()
    seedJobRow(db, 'job-1', {})
    const service = fakeService({ getResult: fakeJobDetail('s', { jobId: 'job-1', status: 'success' }) })
    const res = await withUser('operator', service, { db }).request('/job-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(db.select().from(jobs).all()).toHaveLength(0)
  })
})
