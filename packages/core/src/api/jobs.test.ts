import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { JobDetail, JobInfo } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
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
    ...overrides,
  }
}

function fakeJobDetail(scriptId: string, overrides: Partial<JobDetail> = {}): JobDetail {
  return { ...fakeJobInfo(scriptId), result: null, params: null, ...overrides }
}

/** Records exactly what `enqueue` was called with, so the route's resolution logic is what's under test — not the service. */
function fakeService(opts: { getResult?: JobDetail | null } = {}): JobService & {
  calls: Parameters<JobService['enqueue']>[0][]
  cancelCalls: Array<{ jobId: string; opts?: { cancelDescendants?: boolean } }>
  listCalls: Parameters<JobService['list']>[0][]
} {
  const calls: Parameters<JobService['enqueue']>[0][] = []
  const cancelCalls: Array<{ jobId: string; opts?: { cancelDescendants?: boolean } }> = []
  const listCalls: Parameters<JobService['list']>[0][] = []
  const getResult = opts.getResult === undefined ? fakeJobDetail('x', { jobId: 'job-1', deviceId: 'd1' }) : opts.getResult
  return {
    calls,
    cancelCalls,
    listCalls,
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
