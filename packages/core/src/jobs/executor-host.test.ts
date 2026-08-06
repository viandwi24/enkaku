import { describe, expect, test } from 'bun:test'
import type { DeviceHealth } from '../device/health'
import type { DeviceStateMachine } from '../device/state-machine'
import type { JobRow } from '../db/schema'
import type { LeaseManager } from '../lease/lease-manager'
import type { JobStore } from '../queue/job-store'
import type { Logger } from '../util/logger'
import { ExecutorRegistry } from './executor'
import { createExecutorHost, type ExecutorHostDeps } from './executor-host'

/**
 * executor-host tests (plan 36 §7): the final settle classifies every
 * `failed` job, feeds plan 23's health tracker ONLY for device-blaming
 * failures, and requeues a batch member for rebind instead of settling it
 * terminally when the failure is infra and the farm allows it.
 */

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    scriptId: 'test-script',
    deviceId: 'dev-1',
    params: null,
    priority: 0,
    status: 'running',
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
    // Denormalised at enqueue (plan 82 §3.4) so a job can name its script
    // without a join. Null here: this helper builds a bare row, and nothing
    // in these tests reads either field.
    scriptName: null,
    scriptVersion: null,
    // Plan 81 §4.1 lineage — null/0 here: this helper builds a bare row,
    // and nothing in these tests reads any of these fields either.
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    triggerKey: null,
    ...overrides,
  }
}

interface Recorded {
  finishCalls: Array<{ jobId: string; status: string; data: { result?: unknown; error?: string; failureClass?: string | null } }>
  requeueCalls: Array<{ jobId: string; newDeviceId: string }>
  stateEvents: Array<{ deviceId: string; event: string }>
  clearedLeases: string[]
  healthNotes: Array<{ serial: string; outcome: string; code?: string }>
  rebindEvents: Array<{ deviceId: string; jobId: string; newDeviceId: string; code: string }>
}

function makeDeps(job: JobRow, opts: { rebindOnInfra?: boolean; timeoutIsInfra?: boolean; pickRebindDevice?: string | null } = {}): {
  deps: ExecutorHostDeps
  recorded: Recorded
} {
  const recorded: Recorded = { finishCalls: [], requeueCalls: [], stateEvents: [], clearedLeases: [], healthNotes: [], rebindEvents: [] }

  const jobStore: JobStore = {
    enqueue: () => job,
    get: () => job,
    list: () => ({ rows: [], nextCursor: null, total: 0 }),
    scriptNames: () => new Map(),
    claimNext: () => null,
    queuedDeviceIds: () => [],
    nextQueuedJobId: () => null,
    finish: (jobId, status, data) => {
      recorded.finishCalls.push({ jobId, status, data })
      return { ...job, status, error: data.error ?? null, failureClass: data.failureClass ?? null }
    },
    requeueForRebind: (jobId, newDeviceId) => {
      recorded.requeueCalls.push({ jobId, newDeviceId })
      return { ...job, status: 'queued', deviceId: newDeviceId, infraAttempts: (job.infraAttempts ?? 0) + 1 }
    },
    cancelQueued: () => null,
    cancelQueuedDescendants: () => 0,
    listByBatch: () => [],
    cancelQueuedInBatch: () => 0,
    renewLease: () => true,
    expiredRunning: () => [],
    expireQueued: () => [],
    failOrphanRunning: () => 0,
    runningByDevice: () => null,
  }

  const states: DeviceStateMachine = {
    apply: (deviceId, event) => {
      recorded.stateEvents.push({ deviceId, event })
      return { changed: true, from: 'busy', to: 'idle' }
    },
    current: () => 'busy',
  }

  const leases: LeaseManager = {
    acquireManual: () => {
      throw new Error('not used')
    },
    touchManual: () => {},
    releaseManual: () => false,
    releaseAllForClient: () => {},
    noteJobLease: () => {},
    clearJobLease: (deviceId) => recorded.clearedLeases.push(deviceId),
    getLease: () => null,
    getHolder: () => null,
    lastManualReleaseAt: () => null,
    lastManualHolder: () => null,
    checkInputAllowed: () => ({ ok: true }),
    startReaper: () => {},
    stopReaper: () => {},
  }

  const health: DeviceHealth = {
    note: (serial, outcome, code) => recorded.healthNotes.push({ serial, outcome, code }),
    consecutiveFailures: () => 0,
    start: () => {},
    stop: () => {},
  }

  const deps: ExecutorHostDeps = {
    registry: new ExecutorRegistry(),
    jobStore,
    states,
    leases: () => leases,
    log: silentLog(),
    jobTtlSec: 60,
    heartbeatMs: 1000,
    onJobStatus: () => {},
    onFinished: () => {},
    timeoutIsInfra: () => opts.timeoutIsInfra ?? false,
    rebindOnInfra: () => opts.rebindOnInfra ?? true,
    health: () => health,
    deviceSerial: (deviceId) => `serial-${deviceId}`,
    pickRebindDevice: () => (opts.pickRebindDevice === undefined ? 'dev-2' : opts.pickRebindDevice),
    onJobRebound: (deviceId, jobId, newDeviceId, code) => recorded.rebindEvents.push({ deviceId, jobId, newDeviceId, code }),
  }

  return { deps, recorded }
}

describe('createExecutorHost — health is fed only for device-blaming failures (acceptance #5, #6)', () => {
  test('an infra failure (E_ADB_TIMEOUT) notes the health tracker', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async () => {
        throw Object.assign(new Error('device timed out'), { code: 'E_ADB_TIMEOUT' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)
    expect(recorded.healthNotes).toEqual([{ serial: 'serial-dev-1', outcome: 'timeout', code: 'E_ADB_TIMEOUT' }])
    expect(recorded.finishCalls[0]?.data.failureClass).toBe('infra')
  })

  test('a load failure (E_ADB_BUSY) retries but never notes the health tracker', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async () => {
        throw Object.assign(new Error('queue saturated'), { code: 'E_ADB_BUSY' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)
    expect(recorded.healthNotes).toEqual([])
    expect(recorded.finishCalls[0]?.data.failureClass).toBe('load')
  })

  test('a script failure never notes the health tracker', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async () => {
        throw Object.assign(new Error('assertion failed'), { code: 'SCRIPT_ERROR' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)
    expect(recorded.healthNotes).toEqual([])
    expect(recorded.finishCalls[0]?.data.failureClass).toBe('script')
  })

  test('a successful job never touches the health tracker or failureClass', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', { validateParams: (p) => p, run: async () => 'ok' })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)
    expect(recorded.healthNotes).toEqual([])
    expect(recorded.finishCalls[0]?.data.failureClass).toBeNull()
    expect(recorded.finishCalls[0]?.status).toBe('success')
  })
})

describe('createExecutorHost — batch rebind on an infra failure (plan 36 §3.6, acceptance #7)', () => {
  test('a batch member with rebindOnInfra requeues to another device instead of settling failed', async () => {
    const job = makeJob({ batchId: 'batch-1', batchSeq: 0 })
    const { deps, recorded } = makeDeps(job, { rebindOnInfra: true, pickRebindDevice: 'dev-2' })
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async () => {
        throw Object.assign(new Error('device gone'), { code: 'DEVICE_DISCONNECTED' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    // Requeued, not terminally failed.
    expect(recorded.requeueCalls).toEqual([{ jobId: 'job-1', newDeviceId: 'dev-2' }])
    expect(recorded.finishCalls).toEqual([])
    // The OLD device is still freed exactly as a normal settle would free it.
    expect(recorded.clearedLeases).toEqual(['dev-1'])
    expect(recorded.stateEvents).toEqual([{ deviceId: 'dev-1', event: 'JOB_FINISHED' }])
    expect(recorded.rebindEvents).toEqual([{ deviceId: 'dev-1', jobId: 'job-1', newDeviceId: 'dev-2', code: 'DEVICE_DISCONNECTED' }])
    // Blamed the OLD device's health, same as any other infra failure.
    expect(recorded.healthNotes).toEqual([{ serial: 'serial-dev-1', outcome: 'timeout', code: 'DEVICE_DISCONNECTED' }])
  })

  test('with rebindOnInfra: false, a batch member settles failed like any standalone job', async () => {
    const job = makeJob({ batchId: 'batch-1', batchSeq: 0 })
    const { deps, recorded } = makeDeps(job, { rebindOnInfra: false })
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async () => {
        throw Object.assign(new Error('device gone'), { code: 'DEVICE_DISCONNECTED' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.requeueCalls).toEqual([])
    expect(recorded.finishCalls).toHaveLength(1)
    expect(recorded.finishCalls[0]?.status).toBe('failed')
    expect(recorded.finishCalls[0]?.data.failureClass).toBe('infra')
  })

  test('a standalone job (no batchId) never rebinds even when rebindOnInfra is true', async () => {
    const job = makeJob({ batchId: null })
    const { deps, recorded } = makeDeps(job, { rebindOnInfra: true })
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async () => {
        throw Object.assign(new Error('device gone'), { code: 'DEVICE_DISCONNECTED' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.requeueCalls).toEqual([])
    expect(recorded.finishCalls).toHaveLength(1)
  })

  test('when no eligible sibling device is idle, requeueForRebind still runs, targeting the same device', async () => {
    const job = makeJob({ batchId: 'batch-1', batchSeq: 0 })
    const { deps, recorded } = makeDeps(job, { rebindOnInfra: true, pickRebindDevice: null })
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async () => {
        throw Object.assign(new Error('device gone'), { code: 'DEVICE_DISCONNECTED' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.requeueCalls).toEqual([{ jobId: 'job-1', newDeviceId: 'dev-1' }])
  })
})

describe('createExecutorHost — notifyCrash (plan 37 §4.4)', () => {
  test('a crash is delivered to a running job that registered ctx.onCrash, and settles APP_CRASHED', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    let resolveRun: (() => void) | undefined
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async (_job, ctx) =>
        new Promise((resolve, reject) => {
          ctx.onCrash?.((e) => reject(Object.assign(new Error(`${e.package} crashed`), { code: 'APP_CRASHED' })))
          resolveRun = () => resolve('unused')
        }),
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(5)

    const handled = host.notifyCrash(job.id, { package: 'com.example.app', exception: 'java.lang.NullPointerException', message: 'boom' })
    expect(handled).toBe(true)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.status).toBe('failed')
    expect(recorded.finishCalls[0]?.data.error).toBe('com.example.app crashed')
    expect(recorded.finishCalls[0]?.data.failureClass).toBe('script')
    expect(recorded.healthNotes).toEqual([]) // never blames the device (acceptance #10)
    resolveRun?.()
  })

  test('notifyCrash for a job with no registered handler (or no longer running) is a no-op', async () => {
    const job = makeJob()
    const { deps } = makeDeps(job)
    const host = createExecutorHost(deps)
    expect(host.notifyCrash('no-such-job', { package: 'x', exception: 'y', message: 'z' })).toBe(false)

    deps.registry.register('test-script', { validateParams: (p) => p, run: async () => 'ok' })
    host.start(job)
    await Bun.sleep(10)
    // The job already finished (successfully, without ever calling
    // ctx.onCrash) — its handler entry is gone.
    expect(host.notifyCrash(job.id, { package: 'x', exception: 'y', message: 'z' })).toBe(false)
  })
})

describe('createExecutorHost — an unknown error code classifies script, not infra (acceptance #9)', () => {
  test('a totally unrecognised code fails the job as class "script" and never notes health', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async () => {
        throw Object.assign(new Error('never seen before'), { code: 'SOME_NOVEL_BUG' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.data.failureClass).toBe('script')
    expect(recorded.healthNotes).toEqual([])
  })
})
