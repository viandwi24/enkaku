import { describe, expect, test } from 'bun:test'
import type { DeviceStateMachine } from '../device/state-machine'
import { openDb, runMigrations } from '../db'
import { devices, jobs } from '../db/schema'
import type { LeaseManager } from '../lease/lease-manager'
import { createJobStore } from '../queue/job-store'
import { RESULT_LIMITS } from '@enkaku/protocol'
import type { Logger } from '../util/logger'
import { ExecutorRegistry } from './executor'
import { createExecutorHost, type ExecutorHostDeps } from './executor-host'

/**
 * Plan 97 §3.7, §4.3, §5 step 97.7 — `ExecutorHost.progress`'s three
 * guarantees, each one the plan calls out by name:
 *
 *   1. A push over `RESULT_LIMITS.maxProgressBytes` is dropped, with exactly
 *      ONE `warn` for the job no matter how many oversize pushes follow (a
 *      script emitting a bad value in a loop must not also flood the log).
 *   2. A push for a job that already settled (or never started) is a silent
 *      no-op — no warning, no broadcast, nothing to report progress ON.
 *   3. NO DB write anywhere on this path — asserted here by literally
 *      counting `UPDATE` statements against a REAL sqlite handle, not by
 *      inspecting the code.
 */

function silentLog(): { log: Logger; warnings: string[] } {
  const warnings: string[] = []
  const l = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: () => {},
    child: () => l,
  }
  return { log: l as unknown as Logger, warnings }
}

function neverSettles(): Promise<unknown> {
  return new Promise(() => {})
}

const dummyStates: DeviceStateMachine = {
  apply: () => ({ changed: true, from: 'busy', to: 'idle' }),
  current: () => 'busy',
}

const dummyLeases: LeaseManager = {
  acquireManual: () => {
    throw new Error('not used')
  },
  touchManual: () => {},
  releaseManual: () => false,
  releaseAllForClient: () => {},
  noteJobLease: () => {},
  clearJobLease: () => {},
  getLease: () => null,
  getHolder: () => null,
  lastManualReleaseAt: () => null,
  lastManualHolder: () => null,
  checkInputAllowed: () => ({ ok: true }),
  startReaper: () => {},
  stopReaper: () => {},
}

describe('ExecutorHost.progress (plan 97 §3.7, §5 step 97.7)', () => {
  test('a job that never started (or already settled) is a silent no-op — no broadcast, no warning', () => {
    const { log, warnings } = silentLog()
    const broadcasts: Array<{ jobId: string; deviceId: string; value: unknown }> = []
    const deps: ExecutorHostDeps = {
      registry: new ExecutorRegistry(),
      jobStore: {
        enqueue: () => {
          throw new Error('not used')
        },
        get: () => {
          throw new Error('jobStore.get must not be reached for a job that never started')
        },
        list: () => ({ rows: [], nextCursor: null, total: 0 }),
        scriptNames: () => new Map(),
        claimNext: () => null,
        queuedDeviceIds: () => [],
        nextQueuedJobId: () => null,
        finish: () => {
          throw new Error('finish must not be called by the progress path')
        },
        requeueForRebind: () => null,
        cancelQueued: () => null,
        cancelQueuedDescendants: () => 0,
        listByBatch: () => [],
        cancelQueuedInBatch: () => 0,
        renewLease: () => true,
        expiredRunning: () => [],
        expireQueued: () => [],
        failOrphanRunning: () => 0,
        runningByDevice: () => null,
        assists: () => [],
      },
      states: dummyStates,
      leases: () => dummyLeases,
      log,
      jobTtlSec: 60,
      heartbeatMs: 1000,
      onJobStatus: () => {},
      onFinished: () => {},
      timeoutIsInfra: () => false,
      rebindOnInfra: () => true,
      deviceSerial: () => null,
      onProgress: (jobId, deviceId, value) => broadcasts.push({ jobId, deviceId, value }),
    }
    const host = createExecutorHost(deps)

    host.progress('no-such-job', { videos: 1 })

    expect(broadcasts).toEqual([])
    expect(warnings).toEqual([])
  })

  test('a push within the cap reaches onProgress with (jobId, deviceId, value); an oversize push is dropped with exactly ONE warn no matter how many follow', async () => {
    const { log, warnings } = silentLog()
    const broadcasts: Array<{ jobId: string; deviceId: string; value: unknown }> = []
    const job = {
      id: 'job-1',
      scriptId: 'test-script',
      deviceId: 'dev-1',
      params: null,
      priority: 0,
      status: 'running' as const,
      leaseExpiresAt: null,
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
      assistCount: 0,
      maxConcurrent: null,
      runtimeOverride: null,
      notBefore: null,
      batchRepeat: null,
      pacedDelayMs: null,
      resultStatus: null,
      resultBytes: null,
      resultSummary: null,
      resultIssues: null,
    }
    const deps: ExecutorHostDeps = {
      registry: new ExecutorRegistry(),
      jobStore: {
        enqueue: () => job,
        get: () => job,
        list: () => ({ rows: [], nextCursor: null, total: 0 }),
        scriptNames: () => new Map(),
        claimNext: () => null,
        queuedDeviceIds: () => [],
        nextQueuedJobId: () => null,
        finish: () => {
          throw new Error('finish must not be called by the progress path')
        },
        requeueForRebind: () => null,
        cancelQueued: () => null,
        cancelQueuedDescendants: () => 0,
        listByBatch: () => [],
        cancelQueuedInBatch: () => 0,
        renewLease: () => true,
        expiredRunning: () => [],
        expireQueued: () => [],
        failOrphanRunning: () => 0,
        runningByDevice: () => null,
        assists: () => [],
      },
      states: dummyStates,
      leases: () => dummyLeases,
      log,
      jobTtlSec: 60,
      heartbeatMs: 1000,
      onJobStatus: () => {},
      onFinished: () => {},
      timeoutIsInfra: () => false,
      rebindOnInfra: () => true,
      deviceSerial: () => null,
      onProgress: (jobId, deviceId, value) => broadcasts.push({ jobId, deviceId, value }),
    }
    deps.registry.register('test-script', { validateParams: (p) => p, run: () => neverSettles() })
    const host = createExecutorHost(deps)
    host.start(job)

    host.progress(job.id, { videos: 3, watchSeconds: 90 })
    expect(broadcasts).toEqual([{ jobId: job.id, deviceId: job.deviceId, value: { videos: 3, watchSeconds: 90 } }])
    expect(warnings).toEqual([])

    // Oversize: a string well over `maxProgressBytes` (4 KiB).
    const oversize = 'x'.repeat(RESULT_LIMITS.maxProgressBytes + 1)
    for (let i = 0; i < 10; i++) host.progress(job.id, oversize)

    // The in-cap push is still the only broadcast — none of the ten oversize
    // pushes reached onProgress.
    expect(broadcasts).toEqual([{ jobId: job.id, deviceId: job.deviceId, value: { videos: 3, watchSeconds: 90 } }])
    // Exactly one warning for the whole job, not one per oversize push.
    expect(warnings.length).toBe(1)

    host.stopAll()
  })

  test('10 000 progress pushes against a REAL sqlite handle execute ZERO UPDATE statements — the whole point of "progress is not a result" (plan 97 §3.7)', async () => {
    const { db, sqlite } = openDb(':memory:')
    runMigrations(db)
    db.insert(devices).values({ id: 'dev-1', stableId: 'stable-dev-1', serial: 'serial-dev-1', label: 'device 1', status: 'busy' }).run()
    db.insert(jobs)
      .values({ id: 'job-1', scriptId: 'test-script', deviceId: 'dev-1', params: {}, priority: 0, status: 'running', createdAt: new Date(), startedAt: new Date() })
      .run()
    const jobStore = createJobStore(db)

    // A deliberate test-only monkey-patch (not production code): every
    // drizzle-orm/bun-sqlite query — `.run()`, `.get()`, `.all()` alike —
    // goes through `client.prepare(sql)` (drizzle-orm's own bun-sqlite
    // session), so intercepting `prepare` counts every statement, not just
    // the ones this test happens to know the shape of.
    let updateCount = 0
    const originalPrepare = sqlite.prepare.bind(sqlite) as (...a: unknown[]) => unknown
    ;(sqlite as unknown as { prepare: (...a: unknown[]) => unknown }).prepare = (...args: unknown[]) => {
      const sql = args[0]
      if (typeof sql === 'string' && /^\s*UPDATE/i.test(sql)) updateCount++
      return originalPrepare(...args)
    }

    const { log } = silentLog()
    const broadcasts: unknown[] = []
    const deps: ExecutorHostDeps = {
      registry: new ExecutorRegistry(),
      jobStore,
      states: dummyStates,
      leases: () => dummyLeases,
      log,
      jobTtlSec: 60,
      heartbeatMs: 100_000,
      onJobStatus: () => {},
      onFinished: () => {},
      timeoutIsInfra: () => false,
      rebindOnInfra: () => true,
      deviceSerial: () => null,
      onProgress: (jobId, deviceId, value) => broadcasts.push({ jobId, deviceId, value }),
    }
    deps.registry.register('test-script', { validateParams: (p) => p, run: () => neverSettles() })
    const host = createExecutorHost(deps)
    const row = jobStore.get('job-1')!
    host.start(row)

    for (let i = 0; i < 10_000; i++) host.progress('job-1', { i })

    expect(broadcasts.length).toBe(10_000)
    expect(updateCount).toBe(0)

    host.stopAll()
  })
})
