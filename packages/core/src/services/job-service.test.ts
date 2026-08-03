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
    infraAttempts: 0,
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
