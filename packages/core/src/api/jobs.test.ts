import { describe, expect, test } from 'bun:test'
import type { JobDetail, JobInfo } from '@enkaku/protocol'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import { createJobRoutes } from './jobs'

function fakeJobInfo(scriptId: string): JobInfo {
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
  }
}

/** Records exactly what `enqueue` was called with, so the route's resolution logic is what's under test — not the service. */
function fakeService(): JobService & {
  calls: Parameters<JobService['enqueue']>[0][]
  cancelCalls: Array<{ jobId: string; opts?: { cancelDescendants?: boolean } }>
  listCalls: Parameters<JobService['list']>[0][]
} {
  const calls: Parameters<JobService['enqueue']>[0][] = []
  const cancelCalls: Array<{ jobId: string; opts?: { cancelDescendants?: boolean } }> = []
  const listCalls: Parameters<JobService['list']>[0][] = []
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
    get: (): JobDetail | null => null,
    list: (filter) => {
      listCalls.push(filter)
      return { jobs: [], nextCursor: null, total: 0 }
    },
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
