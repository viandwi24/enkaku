import { describe, expect, test } from 'bun:test'
import type { JobRow } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { EnkakuError } from '../util/errors'
import type { JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import type { Logger } from '../util/logger'
import { createJobService } from './job-service'

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function fakeRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    scriptId: 'internal:sleep',
    deviceId: 'dev-1',
    params: null,
    priority: 0,
    status: 'queued',
    leaseExpiresAt: null,
    result: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
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
    ...overrides,
  }
}

function fakeJobStore(row: JobRow): JobStore {
  return { enqueue: () => row, scriptNames: () => new Map() } as unknown as JobStore
}

function fakeRegistry(): ExecutorRegistry {
  const registry = new ExecutorRegistry()
  registry.register('internal:sleep', { validateParams: (p) => p, run: async () => undefined })
  return registry
}

function fakeScheduler(): Scheduler {
  return { kick: () => {}, start: () => {}, stop: () => {} }
}

/**
 * `canUseDevice` on `enqueue` (plan 34 §3.5, §4.4) — before this plan, a job
 * enqueued for ANY device ran regardless of `devices.ownerId`. These tests
 * exercise `JobService.enqueue` directly (both the HTTP and WS `job.enqueue`
 * call sites are thin wrappers around this one function).
 */
describe('createJobService.enqueue — canUseDevice (plan 34 §3.5, §4.4)', () => {
  test('an operator is refused enqueueing on a device owned by another user', () => {
    const service = createJobService({
      jobStore: fakeJobStore(fakeRow()),
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      getDeviceOwner: () => ({ ownerId: 'someone-else' }),
    })

    expect(() =>
      service.enqueue({
        scriptId: 'internal:sleep',
        deviceId: 'dev-1',
        params: {},
        actor: { id: 'u1', role: 'operator' },
      }),
    ).toThrow(EnkakuError)
  })

  test('an admin may enqueue on a device owned by another user', () => {
    const service = createJobService({
      jobStore: fakeJobStore(fakeRow()),
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      getDeviceOwner: () => ({ ownerId: 'someone-else' }),
    })

    const info = service.enqueue({
      scriptId: 'internal:sleep',
      deviceId: 'dev-1',
      params: {},
      actor: { id: 'admin-1', role: 'admin' },
    })
    expect(info.jobId).toBe('job-1')
  })

  test('a device with ownerId: null is unaffected — the pre-plan-34 default', () => {
    const service = createJobService({
      jobStore: fakeJobStore(fakeRow()),
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      getDeviceOwner: () => ({ ownerId: null }),
    })

    const info = service.enqueue({
      scriptId: 'internal:sleep',
      deviceId: 'dev-1',
      params: {},
      actor: { id: 'u1', role: 'operator' },
    })
    expect(info.jobId).toBe('job-1')
  })

  test('with no actor and no getDeviceOwner configured, enqueue is unaffected — every pre-plan-34 caller (tests, unwired hosts)', () => {
    const service = createJobService({
      jobStore: fakeJobStore(fakeRow()),
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    const info = service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })
    expect(info.jobId).toBe('job-1')
  })
})

/**
 * `result` on the detail response and nowhere else (plan 60 §3.3, §4.3).
 *
 * `ScriptDefinition.run`'s return value has been documented as "Return value
 * → jobs.result" since M4 and stored on the row ever since — and `get` never
 * returned it, so the operator who ran the job could not see what it reported
 * without opening SQLite. For a farm whose scripts exist to REPORT things,
 * that is the same as no return value at all.
 */
describe('createJobService — the script’s return value (plan 60 §3.3, §4.3)', () => {
  const finished = fakeRow({
    status: 'success',
    result: { ok: true, url: 'whoer.net', addressBar: 'whoer.net' },
    finishedAt: new Date(),
  })

  const service = (row: JobRow) =>
    createJobService({
      jobStore: {
        get: () => row,
        list: () => ({ rows: [row], nextCursor: null, total: 1 }),
        scriptNames: () => new Map(),
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

  test('get() carries what the script returned', () => {
    expect(service(finished).get('job-1')?.result).toEqual({ ok: true, url: 'whoer.net', addressBar: 'whoer.net' })
  })

  test('list() does not — a result can be large, and fifty of them is not what a list is for', () => {
    const listed = service(finished).list({})
    expect(listed.jobs).toHaveLength(1)
    expect(listed.jobs[0]).not.toHaveProperty('result')
  })

  test('a job that returned nothing reports null rather than being absent', () => {
    expect(service(fakeRow({ status: 'success' })).get('job-1')?.result).toBeNull()
  })

  test('the phase a failure happened in travels with it (plan 60 §3.4)', () => {
    const failed = fakeRow({ status: 'failed', error: 'the address bar reads ""', errorPhase: 'run' })
    expect(service(failed).get('job-1')?.errorPhase).toBe('run')
    // Unlike `result`, this one IS small enough for a list.
    expect(service(failed).list({}).jobs[0]?.errorPhase).toBe('run')
  })
})

/**
 * `cancel()` (plan 81 §4.4) — `cancelledDescendants` is opt-in via
 * `opts.cancelDescendants`, defaulting to 0 when not asked for; it never
 * changes whether the CALLER'S OWN job can be cancelled.
 */
describe('createJobService.cancel — cancelledDescendants (plan 81 §4.4)', () => {
  function serviceWithStore(row: JobRow, opts: { cancelDescendantsReturns?: number } = {}) {
    const calls: string[] = []
    const jobStore = {
      get: () => row,
      cancelQueued: () => ({ ...row, status: 'cancelled' }) as JobRow,
      cancelQueuedDescendants: (jobId: string) => {
        calls.push(jobId)
        return opts.cancelDescendantsReturns ?? 0
      },
    } as unknown as JobStore
    const service = createJobService({
      jobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: { abort: () => true, finishExternally: () => {} } as unknown as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })
    return { service, calls }
  }

  test('without the option, cancelledDescendants is 0 and cancelQueuedDescendants is never called', () => {
    const { service, calls } = serviceWithStore(fakeRow({ status: 'queued' }))
    const result = service.cancel('job-1')
    expect(result.cancelledDescendants).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test('with the option, the count from cancelQueuedDescendants is returned', () => {
    const { service, calls } = serviceWithStore(fakeRow({ status: 'queued' }), { cancelDescendantsReturns: 3 })
    const result = service.cancel('job-1', { cancelDescendants: true })
    expect(result.cancelledDescendants).toBe(3)
    expect(calls).toEqual(['job-1'])
  })

  test('cancel-with-descendants also works for a RUNNING job — it triggered children and kept going', () => {
    const { service, calls } = serviceWithStore(fakeRow({ status: 'running' }), { cancelDescendantsReturns: 2 })
    const result = service.cancel('job-1', { cancelDescendants: true })
    expect(result.job.status).toBe('running') // the running job itself is aborted via host.abort, not settled here
    expect(result.cancelledDescendants).toBe(2)
    expect(calls).toEqual(['job-1'])
  })
})
