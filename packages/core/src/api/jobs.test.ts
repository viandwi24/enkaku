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
  }
}

/** Records exactly what `enqueue` was called with, so the route's resolution logic is what's under test — not the service. */
function fakeService(): JobService & { calls: Parameters<JobService['enqueue']>[0][] } {
  const calls: Parameters<JobService['enqueue']>[0][] = []
  return {
    calls,
    enqueue(input) {
      calls.push(input)
      return fakeJobInfo(input.scriptId)
    },
    cancel: () => fakeJobInfo('x'),
    get: (): JobDetail | null => null,
    list: () => ({ jobs: [], nextCursor: null, total: 0 }),
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
