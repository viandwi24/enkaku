import { describe, expect, test } from 'bun:test'
import type { DeviceHealth } from '../device/health'
import type { JobRow } from '../db/schema'
import type { ActivityRegistry } from '../activity/registry'
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
    heartbeatExpiresAt: null,
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
    peakRssBytes: null,
    // Plan 98 §4.4, §4.6, step 98.5 — null here: this helper builds a bare
    // row, and nothing in these tests exercises the claim's concurrency gate.
    maxConcurrent: null,
    // Plan 98 §3.8, §4.4, step 98.7 — null here: this helper builds a bare
    // row, and nothing in these tests exercises a per-job override.
    runtimeOverride: null,
    // Plan 94 §3.8, §4.8, step 94.6 — null here: this helper builds a bare
    // row, and nothing in these tests exercises the pacer.
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    // Plan 97 §3.3, §4.4 — null here: this helper builds a bare row; tests
    // that exercise `recordResult`'s wiring pass their own overrides.
    resultStatus: null,
    resultBytes: null,
    resultSummary: null,
    resultIssues: null,
      workflowDoc: null,
    ...overrides,
  }
}

interface Recorded {
  finishCalls: Array<{
    jobId: string
    status: string
    data: {
      result?: unknown
      error?: string
      failureClass?: string | null
      peakRssBytes?: number | null
      resultStatus?: string | null
      resultBytes?: number | null
      resultSummary?: string | null
      resultIssues?: unknown
    }
  }>
  requeueCalls: Array<{ jobId: string; newDeviceId: string }>
  /** Plan 205 §4.7 — replaces the deleted lease manager's `clearJobLease`: the activity registry's `end()` calls, one per settle/rebind. */
  activityEnds: Array<{ deviceId: string; id: string }>
  activityTouches: Array<{ deviceId: string; id: string }>
  healthNotes: Array<{ serial: string; outcome: string; code?: string }>
  rebindEvents: Array<{ deviceId: string; jobId: string; newDeviceId: string; code: string }>
}

function makeDeps(job: JobRow, opts: { rebindOnInfra?: boolean; timeoutIsInfra?: boolean; pickRebindDevice?: string | null } = {}): {
  deps: ExecutorHostDeps
  recorded: Recorded
} {
  const recorded: Recorded = { finishCalls: [], requeueCalls: [], activityEnds: [], activityTouches: [], healthNotes: [], rebindEvents: [] }

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
    renewHeartbeat: () => true,
    expiredRunning: () => [],
    expireQueued: () => [],
    failOrphanRunning: () => 0,
    runningByDevice: () => null,
  }

  /** A minimal fake `ActivityRegistry` — only `end`/`touch` are exercised by `executor-host.ts`. */
  const activities: ActivityRegistry = {
    start: (_deviceId, input) => ({ id: input.id, kind: input.kind, label: input.label, actor: input.actor, startedAt: 0, updatedAt: 0 }),
    update: () => null,
    touch: (deviceId, id) => recorded.activityTouches.push({ deviceId, id }),
    end: (deviceId, id) => {
      recorded.activityEnds.push({ deviceId, id })
      return true
    },
    endWhere: () => 0,
    touchControl: (_deviceId, clientId, actor) => ({ id: `control:${clientId}`, kind: 'control', label: '', actor, startedAt: 0, updatedAt: 0 }),
    controlOf: () => null,
    liveControls: () => [],
    list: () => [],
    devicesWith: () => [],
    lastControl: () => null,
    rebuild: () => {},
    startSweep: () => {},
    stopSweep: () => {},
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
    activities: () => activities,
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
    // The OLD device's job activity is ended exactly as a normal settle would end it.
    expect(recorded.activityEnds).toEqual([{ deviceId: 'dev-1', id: 'job:job-1' }])
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

/**
 * Plan 205 §3.2 item 8: co-control (Assist) and `ctx.onAssist`/`ExecutorHost.notifyAssist`
 * are deleted, not renamed — the describe block that used to live here
 * (plan 91 §3.6, §4.8, §5 step 91.5) is gone.
 */

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

/**
 * Plan 98 §3.9 item 4, §4.4, §4.8, H1 — step 98.2, "measure before limiting":
 * the seam between an executor that measured its own subprocess (`ctx.onPeakRss`)
 * and the job row's `peakRssBytes` column. No limit is enforced here or
 * anywhere in this step — only that the number reaches `jobStore.finish`.
 */
describe('createExecutorHost — ctx.onPeakRss reaches jobStore.finish (plan 98 §4.8, H1)', () => {
  test('a successful job that reported a peak carries it into finish()', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async (_job, ctx) => {
        ctx.onPeakRss?.(314_572_800)
        return 'ok'
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.status).toBe('success')
    expect(recorded.finishCalls[0]?.data.peakRssBytes).toBe(314_572_800)
  })

  test('a FAILED job that reported a peak still carries it into finish() — the measurement is not conditional on success', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async (_job, ctx) => {
        ctx.onPeakRss?.(52_428_800)
        throw Object.assign(new Error('assertion failed'), { code: 'SCRIPT_ERROR' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.status).toBe('failed')
    expect(recorded.finishCalls[0]?.data.peakRssBytes).toBe(52_428_800)
  })

  test('an executor that never calls onPeakRss (no subprocess) omits the field entirely — never a bare 0', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', { validateParams: (p) => p, run: async () => 'ok' })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.status).toBe('success')
    expect(recorded.finishCalls[0]?.data.peakRssBytes).toBeUndefined()
  })
})

/**
 * Plan 97 §3.3, §3.4, §3.8, §4.5 — `ctx.onResultOutcome` (the `onPeakRss`
 * counterpart this step adds) reaches `settle()`, which calls
 * `result-store.ts`'s `recordResult` and writes its four columns into the
 * SAME `jobStore.finish()` call `peakRssBytes` above already proves reaches.
 * `recordResult` itself is unit-tested alone in `result-store.test.ts`; this
 * describes ONLY the wiring — that the value actually gets there.
 */
describe('createExecutorHost — the result outcome reaches finish() (plan 97 §3.3, §4.5)', () => {
  test('a script executor reporting a valid outcome writes all four result columns', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async (_job, ctx) => {
        ctx.onResultOutcome?.({ status: 'valid', bytes: 12 })
        return { videos: 5 }
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.status).toBe('success')
    const data = recorded.finishCalls[0]?.data ?? ({} as (typeof recorded.finishCalls)[number]['data'])
    expect(data.result).toEqual({ videos: 5 })
    expect(data.resultStatus).toBe('valid')
    expect(typeof data.resultBytes).toBe('number')
    expect(data.resultIssues).toBeNull()
  })

  test('an oversize outcome nulls the stored result even though the executor returned a value', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async (_job, ctx) => {
        // The child never actually sends `value` for a real oversize case
        // (§3.4) — this executor returning one anyway is exactly the
        // defensive case §3.8 names: "the parent re-checks what it can
        // cheaply and independently know" and drops it regardless.
        ctx.onResultOutcome?.({ status: 'oversize', bytes: 52_428_800 })
        return { blob: 'should not survive' }
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    const data = recorded.finishCalls[0]?.data ?? ({} as (typeof recorded.finishCalls)[number]['data'])
    expect(data.resultStatus).toBe('oversize')
    expect(data.result).toBeNull()
    expect(data.resultBytes).toBe(52_428_800)
  })

  test('an executor that never calls onResultOutcome (sleep, install, workflow) still settles undeclared on a SUCCESS — a missing outcome means undeclared (§4.3), the same rule a pre-plan-97 bundle gets', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', { validateParams: (p) => p, run: async () => 'done' })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    const data = recorded.finishCalls[0]?.data ?? ({} as (typeof recorded.finishCalls)[number]['data'])
    expect(data.resultStatus).toBe('undeclared')
    expect(typeof data.resultBytes).toBe('number')
    expect(data.resultSummary).toBeNull()
    expect(data.resultIssues).toBeNull()
    // The raw value is still written to `result` exactly as it always has been.
    expect(data.result).toBe('done')
  })

  test('a FAILED job with no reported outcome still leaves every result_* column untouched — the common case, nothing to report (unchanged by step 97.4)', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async () => {
        throw Object.assign(new Error('boom'), { code: 'SCRIPT_ERROR' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.status).toBe('failed')
    expect(recorded.finishCalls[0]?.data.resultStatus).toBeUndefined()
  })

  /**
   * Plan 97 §3.5, step 97.4 — "a failed run can still say something": once
   * an executor DOES report an outcome alongside a failure (the shape a real
   * `finish()` salvage takes — `child-entry.ts`'s own salvage call always
   * forces `status: 'partial'`, never `valid`/`undeclared`, since it never
   * passes a declared schema), the settle now writes it, closing the gap the
   * previous test (above) used to pin as `97.4's ... not this step's`.
   */
  test('a FAILED job DOES get a resultStatus written when the executor reported one (97.4 closes the gap the test above used to pin)', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async (_job, ctx) => {
        ctx.onResultOutcome?.({ status: 'partial', bytes: 4 })
        throw Object.assign(new Error('boom'), { code: 'SCRIPT_ERROR' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.status).toBe('failed')
    expect(recorded.finishCalls[0]?.data.resultStatus).toBe('partial')
    // The verifiable result names `error`/`failureClass`/`errorPhase` as
    // unchanged from today — a salvage adds a value, it must not touch how
    // the failure itself is classified or reported.
    expect(recorded.finishCalls[0]?.data.error).toBe('boom')
    expect(recorded.finishCalls[0]?.data.failureClass).toBeTruthy()
  })

  test('a CANCELLED job DOES get a resultStatus written when the executor reported one — treated the same as a failure, not only "failed" specifically', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async (_job, ctx) => {
        ctx.onResultOutcome?.({ status: 'partial', bytes: 4 })
        throw Object.assign(new Error('cancelled'), { code: 'job_cancelled' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.status).toBe('cancelled')
    expect(recorded.finishCalls[0]?.data.resultStatus).toBe('partial')
  })

  test('a FAILED job\'s reported partial never overwrites an already-recorded valid — existingStatus threads from job.resultStatus', async () => {
    const job = makeJob({ resultStatus: 'valid' })
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async (_job, ctx) => {
        ctx.onResultOutcome?.({ status: 'partial', bytes: 4 })
        throw Object.assign(new Error('boom'), { code: 'SCRIPT_ERROR' })
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.finishCalls[0]?.status).toBe('failed')
    expect(recorded.finishCalls[0]?.data.resultStatus).toBeUndefined()
  })
})

/**
 * Plan 205 §4.7 — the heartbeat interval also touches the job's own
 * `job:<id>` activity, so a long-running job's marker never looks stale to
 * anything reading the registry (MVP 04 §1.1: "updatedAt: last heartbeat,
 * last progress, or last input").
 */
describe('createExecutorHost — the heartbeat touches the job activity (plan 205 §4.7)', () => {
  test('settle ends the job:<id> activity on the device it ran on', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', { validateParams: (p) => p, run: async () => 'ok' })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.activityEnds).toEqual([{ deviceId: 'dev-1', id: 'job:job-1' }])
  })

  test('ctx.heartbeat() touches the job activity', async () => {
    const job = makeJob()
    const { deps, recorded } = makeDeps(job)
    deps.registry.register('test-script', {
      validateParams: (p) => p,
      run: async (_job, ctx) => {
        ctx.heartbeat()
        return 'ok'
      },
    })
    const host = createExecutorHost(deps)
    host.start(job)
    await Bun.sleep(10)

    expect(recorded.activityTouches).toContainEqual({ deviceId: 'dev-1', id: 'job:job-1' })
  })
})
