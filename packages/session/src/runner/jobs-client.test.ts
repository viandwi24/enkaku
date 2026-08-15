import { describe, expect, test } from 'bun:test'
import { createJobsApiFor } from './jobs-client'
import type { JobsCall } from './ipc'

const JOB = { id: 'job-1', attempt: 1 }

function summary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    jobId: 'j1',
    scriptName: 'checkout',
    scriptVersion: '1.0.0',
    origin: null,
    pluginName: null,
    status: 'success',
    createdAt: 100,
    startedAt: 101,
    finishedAt: 102,
    durationMs: 1000,
    failureClass: null,
    errorPhase: null,
    error: null,
    triggeredByJobId: null,
    rootJobId: null,
    depth: null,
    resultStatus: null,
    ...overrides,
  }
}

describe('createJobsApiFor (plan 80 §4.2, §4.3)', () => {
  test('list() forwards status/limit/cursor only when given, and validates the returned page', async () => {
    const calls: JobsCall[] = []
    const api = createJobsApiFor(async <T>(call: JobsCall) => {
      calls.push(call)
      return { items: [summary()], nextCursor: 'c1', total: 1 } as T
    }, JOB)
    const page = await api.list({ status: 'queued', limit: 5, cursor: 'abc' })
    expect(calls[0]).toEqual({ method: 'list', status: 'queued', limit: 5, cursor: 'abc' })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBe('c1')
    expect(page.total).toBe(1)
  })

  test('list() with no options sends a bare { method: "list" }', async () => {
    const calls: JobsCall[] = []
    const api = createJobsApiFor(async <T>(call: JobsCall) => {
      calls.push(call)
      return { items: [], nextCursor: null, total: 0 } as T
    }, JOB)
    await api.list()
    expect(calls[0]).toEqual({ method: 'list' })
  })

  test('previous() returns null when the parent answers null', async () => {
    const api = createJobsApiFor(async <T>() => null as T, JOB)
    expect(await api.previous()).toBeNull()
  })

  test('previous() validates and returns a JobSummary', async () => {
    const api = createJobsApiFor(async <T>(call: JobsCall) => {
      expect(call).toEqual({ method: 'previous' })
      return summary({ jobId: 'j2' }) as T
    }, JOB)
    const prev = await api.previous()
    expect(prev?.jobId).toBe('j2')
  })

  test('queuedAfter() forwards limit only when given', async () => {
    const calls: JobsCall[] = []
    const api = createJobsApiFor(async <T>(call: JobsCall) => {
      calls.push(call)
      return [summary({ jobId: 'j3' })] as T
    }, JOB)
    const result = await api.queuedAfter({ limit: 3 })
    expect(calls[0]).toEqual({ method: 'queuedAfter', limit: 3 })
    expect(result.map((j) => j.jobId)).toEqual(['j3'])

    await api.queuedAfter()
    expect(calls[1]).toEqual({ method: 'queuedAfter' })
  })

  test('resultOf() passes the jobId through and returns whatever the parent answers, unvalidated', async () => {
    const calls: JobsCall[] = []
    const api = createJobsApiFor(async <T>(call: JobsCall) => {
      calls.push(call)
      return { anything: 42 } as T
    }, JOB)
    expect(await api.resultOf('job-9')).toEqual({ anything: 42 })
    expect(calls[0]).toEqual({ method: 'resultOf', jobId: 'job-9' })
  })

  test('resultOf() surfaces null for a refusal without throwing', async () => {
    const api = createJobsApiFor(async <T>() => null as T, JOB)
    expect(await api.resultOf('job-9')).toBeNull()
  })
})

describe('createJobsApiFor — trigger() (plan 81 §3.3, §4.2, §4.3)', () => {
  test('an explicit key is sent through unchanged', async () => {
    const calls: JobsCall[] = []
    const api = createJobsApiFor(async <T>(call: JobsCall) => {
      calls.push(call)
      return { jobId: 'j-new', deduped: false } as T
    }, JOB)
    const result = await api.trigger({ script: 'checkout@1.0.0', key: 'my-own-key' })
    expect(calls[0]).toEqual({ method: 'trigger', script: 'checkout@1.0.0', key: 'my-own-key' })
    expect(result).toEqual({ jobId: 'j-new', deduped: false })
  })

  test('an omitted key derives `${jobId}:${nodeId ?? \'\'}:${attempt}:${callIndex}`, incrementing per call (plan 99 §4.8, no nodeId)', async () => {
    const calls: JobsCall[] = []
    const api = createJobsApiFor(async <T>(call: JobsCall) => {
      calls.push(call)
      return { jobId: 'j-new', deduped: false } as T
    }, JOB)
    await api.trigger({ script: 'checkout@1.0.0' })
    await api.trigger({ script: 'checkout@1.0.0' })
    // `JOB` carries no `nodeId` — the segment is present but empty, which is
    // the exact same UNIQUENESS the pre-plan-99 shape had (§4.8: "a
    // standalone job... keeps deriving the exact key shape it always has").
    expect(calls.map((c) => (c as { key: string }).key)).toEqual(['job-1::1:0', 'job-1::1:1'])
  })

  test('a fresh client (a new attempt, or a re-run finish() in a fresh process) restarts the call index at 0', async () => {
    const calls: JobsCall[] = []
    const record = async <T>(call: JobsCall) => {
      calls.push(call)
      return { jobId: 'j-new', deduped: false } as T
    }
    const attempt1 = createJobsApiFor(record, { id: 'job-1', attempt: 1 })
    await attempt1.trigger({ script: 'checkout@1.0.0' })
    const attempt1Rerun = createJobsApiFor(record, { id: 'job-1', attempt: 1 })
    await attempt1Rerun.trigger({ script: 'checkout@1.0.0' })
    const attempt2 = createJobsApiFor(record, { id: 'job-1', attempt: 2 })
    await attempt2.trigger({ script: 'checkout@1.0.0' })
    expect(calls.map((c) => (c as { key: string }).key)).toEqual([
      'job-1::1:0', // attempt 1, first call
      'job-1::1:0', // re-run of attempt 1 (a fresh process) reproduces the SAME key
      'job-1::2:0', // attempt 2 is a genuinely different attempt
    ])
  })

  test('forwards params/deviceId/priority/expiresAt only when given', async () => {
    const calls: JobsCall[] = []
    const api = createJobsApiFor(async <T>(call: JobsCall) => {
      calls.push(call)
      return { jobId: 'j-new', deduped: false } as T
    }, JOB)
    await api.trigger({ script: 'checkout@1.0.0' })
    expect(calls[0]).toEqual({ method: 'trigger', script: 'checkout@1.0.0', key: 'job-1::1:0' })

    await api.trigger({ script: 'checkout@1.0.0', params: { a: 1 }, deviceId: 'd2', priority: 3, expiresAt: 500 })
    expect(calls[1]).toEqual({
      method: 'trigger',
      script: 'checkout@1.0.0',
      key: 'job-1::1:1',
      params: { a: 1 },
      deviceId: 'd2',
      priority: 3,
      expiresAt: 500,
    })
  })

  describe('trigger() — nodeId folded into the default key (plan 99 §3.2, §4.8, closes F20)', () => {
    test('two nodes sharing one jobId and one attempt derive DIFFERENT default keys', async () => {
      const calls: JobsCall[] = []
      const record = async <T>(call: JobsCall) => {
        calls.push(call)
        return { jobId: 'j-new', deduped: false } as T
      }
      const node1 = createJobsApiFor(record, { id: 'job-1', attempt: 1, nodeId: 'scroll1' })
      const node2 = createJobsApiFor(record, { id: 'job-1', attempt: 1, nodeId: 'search1' })
      await node1.trigger({ script: 'checkout@1.0.0' })
      await node2.trigger({ script: 'checkout@1.0.0' })
      const keys = calls.map((c) => (c as { key: string }).key)
      expect(keys).toEqual(['job-1:scroll1:1:0', 'job-1:search1:1:0'])
      // This is the failure this test is written to catch: under the OLD key
      // shape (`${jobId}:${attempt}:${idx}`), both of these collapse to the
      // SAME string ('job-1:1:0') — node 2's trigger would silently dedupe
      // into node 1's, a data-loss bug (plan 99 F20).
      expect(new Set(keys).size).toBe(2)
    })

    test('the same node retried (a new attempt) still derives a fresh key', async () => {
      const calls: JobsCall[] = []
      const record = async <T>(call: JobsCall) => {
        calls.push(call)
        return { jobId: 'j-new', deduped: false } as T
      }
      const attempt1 = createJobsApiFor(record, { id: 'job-1', attempt: 1, nodeId: 'scroll1' })
      await attempt1.trigger({ script: 'checkout@1.0.0' })
      const attempt2 = createJobsApiFor(record, { id: 'job-1', attempt: 2, nodeId: 'scroll1' })
      await attempt2.trigger({ script: 'checkout@1.0.0' })
      expect(calls.map((c) => (c as { key: string }).key)).toEqual(['job-1:scroll1:1:0', 'job-1:scroll1:2:0'])
    })
  })

  test('the parent answer is validated against TriggerResult', async () => {
    const api = createJobsApiFor(async <T>() => ({ jobId: 'j-new', deduped: true }) as T, JOB)
    const result = await api.trigger({ script: 'checkout@1.0.0' })
    expect(result).toEqual({ jobId: 'j-new', deduped: true })
  })

  test('a refusal thrown by the parent rejects trigger() — the script sees the throw', async () => {
    const api = createJobsApiFor(async <T>() => {
      throw Object.assign(new Error('trigger refused: too deep'), { code: 'E_TRIGGER_TOO_DEEP' })
      return undefined as T
    }, JOB)
    await expect(api.trigger({ script: 'checkout@1.0.0' })).rejects.toThrow('trigger refused: too deep')
  })
})
