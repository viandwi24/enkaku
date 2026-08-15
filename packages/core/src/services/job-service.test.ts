import { describe, expect, test } from 'bun:test'
import type { JobRunner } from '@enkaku/session'
import type { JobSettings } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { scripts, type JobRow } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { createScriptExecutor } from '../jobs/executors/script'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry } from '../scripts/registry'
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
    peakRssBytes: null,
    assistCount: 0,
    // Plan 98 §4.4, §4.6, step 98.5 — null here: a bare fixture row.
    maxConcurrent: null,
    // Plan 98 §3.8, §4.4, step 98.7 — null here: a bare fixture row, no
    // per-job override exercised unless a test overrides it.
    runtimeOverride: null,
    // Plan 94 §3.8, §4.8, step 94.6 — null here: a bare fixture row, no
    // pacer exercised unless a test overrides it.
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    // Plan 97 §3.3, §4.4 — null here: a bare fixture row, no result path
    // exercised unless a test overrides it.
    resultStatus: null,
    resultBytes: null,
    resultSummary: null,
    resultIssues: null,
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
 * `JobExecutor.requires` (plan 93 §3.12, §4.6, step 93.8) — closes F10: a
 * standalone `POST /api/jobs {scriptId:'internal:install'}` used to check no
 * permission at all. `registry` here registers a fake `internal:install`
 * with the SAME `requires: {gate:'files', setting:'transfer.enabled'}`
 * declaration the real `jobs/executors/install.ts` carries, so this proves
 * `enqueue()` actually reads it, not merely that the executor declares it.
 */
function fakeRegistryWithInstall(): ExecutorRegistry {
  const registry = new ExecutorRegistry()
  registry.register('internal:sleep', { validateParams: (p) => p, run: async () => undefined })
  registry.register('internal:install', {
    validateParams: (p) => p,
    run: async () => undefined,
    requires: { gate: 'files', setting: 'transfer.enabled' },
  })
  return registry
}

describe('createJobService.enqueue — JobExecutor.requires (plan 93 §3.12, §4.6, step 93.8)', () => {
  test('an operator without device.files, shell.mode: admin, is refused with auth.forbidden', () => {
    const service = createJobService({
      jobStore: fakeJobStore(fakeRow({ scriptId: 'internal:install' })),
      registry: fakeRegistryWithInstall(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      shellMode: () => 'admin',
      transferEnabled: () => true,
    })

    expect(() =>
      service.enqueue({
        scriptId: 'internal:install',
        deviceId: 'dev-1',
        params: {},
        actor: { id: 'u1', role: 'operator' },
      }),
    ).toThrow(EnkakuError)
  })

  test('an admin passes the role gate but transfer.enabled: false still refuses', () => {
    const service = createJobService({
      jobStore: fakeJobStore(fakeRow({ scriptId: 'internal:install' })),
      registry: fakeRegistryWithInstall(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      shellMode: () => 'admin',
      transferEnabled: () => false,
    })

    expect(() =>
      service.enqueue({
        scriptId: 'internal:install',
        deviceId: 'dev-1',
        params: {},
        actor: { id: 'admin-1', role: 'admin' },
      }),
    ).toThrow(EnkakuError)
  })

  test('an admin with transfer.enabled: true and shell.mode: admin succeeds', () => {
    const service = createJobService({
      jobStore: fakeJobStore(fakeRow({ scriptId: 'internal:install' })),
      registry: fakeRegistryWithInstall(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      shellMode: () => 'admin',
      transferEnabled: () => true,
    })

    const info = service.enqueue({
      scriptId: 'internal:install',
      deviceId: 'dev-1',
      params: {},
      actor: { id: 'admin-1', role: 'admin' },
    })
    expect(info.jobId).toBe('job-1')
  })

  test('an operator under shell.mode: operator (widened) passes the role gate', () => {
    const service = createJobService({
      jobStore: fakeJobStore(fakeRow({ scriptId: 'internal:install' })),
      registry: fakeRegistryWithInstall(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      shellMode: () => 'operator',
      transferEnabled: () => true,
    })

    const info = service.enqueue({
      scriptId: 'internal:install',
      deviceId: 'dev-1',
      params: {},
      actor: { id: 'u1', role: 'operator' },
    })
    expect(info.jobId).toBe('job-1')
  })

  test('with shellMode/transferEnabled unwired, the gate is not evaluated — exactly pre-93.8 behaviour', () => {
    const service = createJobService({
      jobStore: fakeJobStore(fakeRow({ scriptId: 'internal:install' })),
      registry: fakeRegistryWithInstall(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    const info = service.enqueue({
      scriptId: 'internal:install',
      deviceId: 'dev-1',
      params: {},
      actor: { id: 'u1', role: 'operator' },
    })
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
/** Plan 91 §3.5, §4.9, §5 step 91.5 — `assists()` delegates to `jobStore.assists()`, but is the ONE place that distinguishes "no assists" from "no such job" (`jobStore.assists()` itself returns `[]` either way). */
describe('createJobService.assists (plan 91 §3.5, §4.9)', () => {
  test('delegates to jobStore.assists() for a job that exists', () => {
    const row = fakeRow({ id: 'job-1' })
    const assistsCalls: string[] = []
    const service = createJobService({
      jobStore: {
        get: () => row,
        assists: (jobId: string) => {
          assistsCalls.push(jobId)
          return [{ id: 'e1', deviceId: row.deviceId, stream: 'input', kind: 'input.tap', actor: 'operator-1', meta: null, at: 1000 }]
        },
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })
    const result = service.assists('job-1')
    expect(assistsCalls).toEqual(['job-1'])
    expect(result).toHaveLength(1)
    expect(result[0]?.actor).toBe('operator-1')
  })

  test('throws job_not_found for a missing job — never a bare empty array standing in for "no such job"', () => {
    const service = createJobService({
      jobStore: {
        get: () => null,
        assists: () => {
          throw new Error('assists() must never be reached for a missing job')
        },
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })
    expect(() => service.assists('no-such-job')).toThrow(EnkakuError)
  })
})

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

/**
 * Plan 95 §5 step 95.6's verifiable result, single-job half (fixes F10):
 * `POST /api/jobs` with an out-of-range value against a published script's
 * `paramsSchema` must be refused BEFORE a device is leased — not merely
 * answer 400 while still having created something a device could be leased
 * against. `enqueue()` calls `validateScriptForRun` (which now reaches the
 * REAL `createScriptExecutor().validateParams`, wired here exactly as
 * `daemon.ts` wires it) before `jobStore.enqueue` and before
 * `scheduler.kick`, so this test proves the ordering by asserting neither
 * was ever called — a test that only checked the thrown error would still
 * pass if the lease had already happened.
 */
describe('createJobService.enqueue — invalid params are refused before any device is leased (plan 95 §5 step 95.6)', () => {
  function setUpDb(): Db {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    return opened.db
  }

  function registryWithScriptExecutor(db: Db): ExecutorRegistry {
    const scriptRegistry = createScriptRegistry({ db, dataDir: `/tmp/enkaku-job-service-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
    const registry = new ExecutorRegistry()
    // `run` is never reached in this test — enqueue() never gets past validateParams.
    registry.setFallback(createScriptExecutor({ registry: scriptRegistry, runner: {} as JobRunner }))
    return registry
  }

  test('{ videos: 9999 } against a max(2000) schema throws invalid_job_params, and jobStore.enqueue / scheduler.kick are never called', () => {
    const db = setUpDb()
    db.insert(scripts)
      .values({
        id: 'checkout',
        name: 'checkout',
        version: '1.0.0',
        bundle: 'export {}',
        enabled: true,
        paramsSchema: { type: 'object', properties: { videos: { type: 'integer', maximum: 2000 } }, required: ['videos'] },
        createdAt: new Date(),
      })
      .run()

    let enqueueCalled = false
    let kicked = false
    const jobStore = {
      enqueue: () => {
        enqueueCalled = true
        return fakeRow()
      },
      scriptNames: () => new Map(),
    } as unknown as JobStore
    const scheduler: Scheduler = { kick: () => void (kicked = true), start: () => {}, stop: () => {} }

    const service = createJobService({
      jobStore,
      registry: registryWithScriptExecutor(db),
      scheduler,
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      findScript: () => ({ enabled: true }),
    })

    let caught: EnkakuError | undefined
    try {
      service.enqueue({ scriptId: 'checkout', deviceId: 'd1', params: { videos: 9999 } })
    } catch (err) {
      caught = err as EnkakuError
    }

    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('invalid_job_params')
    expect(caught?.issues).toEqual([{ path: 'videos', message: 'must be at most 2000' }])
    // The proof: nothing that could lead to a device lease ever ran.
    expect(enqueueCalled).toBe(false)
    expect(kicked).toBe(false)
  })

  test('a params object inside every bound enqueues normally', () => {
    const db = setUpDb()
    db.insert(scripts)
      .values({
        id: 'checkout',
        name: 'checkout',
        version: '1.0.0',
        bundle: 'export {}',
        enabled: true,
        paramsSchema: { type: 'object', properties: { videos: { type: 'integer', maximum: 2000 } }, required: ['videos'] },
        createdAt: new Date(),
      })
      .run()

    const jobStore = { enqueue: () => fakeRow({ scriptId: 'checkout' }), scriptNames: () => new Map() } as unknown as JobStore
    const service = createJobService({
      jobStore,
      registry: registryWithScriptExecutor(db),
      scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      findScript: () => ({ enabled: true }),
    })

    const info = service.enqueue({ scriptId: 'checkout', deviceId: 'd1', params: { videos: 30 } })
    expect(info.jobId).toBe('job-1')
  })
})

/**
 * `nodes()` (plan 99 §3.5, §4.9, step 99.8) — `GET /api/jobs/:id/nodes`.
 * Mirrors `assists()`'s own split above: the store returns `[]` either way,
 * so this is the one place that distinguishes "no nodes yet" from "no such
 * job".
 */
describe('createJobService.nodes (plan 99 §3.5, §4.9, step 99.8)', () => {
  test('delegates to jobStore.nodes() and maps each row through rowToJobNodeInfo, plus finalized from the job\'s own status', () => {
    const row = fakeRow({ id: 'job-1', status: 'failed' })
    const nodesCalls: string[] = []
    const service = createJobService({
      jobStore: {
        get: () => row,
        nodes: (jobId: string) => {
          nodesCalls.push(jobId)
          return [
            {
              id: 'n1',
              jobId: 'job-1',
              seq: 0,
              nodeId: 'a',
              kind: 'script',
              scriptId: 'node-a-1.0.0',
              scriptName: 'node-a',
              scriptVersion: '1.0.0',
              status: 'success',
              attempts: 1,
              startedAt: new Date(1_700_000_000_000),
              finishedAt: new Date(1_700_000_010_000),
              output: { ok: true },
              outputTruncated: null,
              verdict: null,
              error: null,
              errorCode: null,
              resumedFromJobId: null,
              resumedFromNode: null,
            },
          ]
        },
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    const result = service.nodes('job-1')
    expect(nodesCalls).toEqual(['job-1'])
    expect(result.finalized).toBe(true) // 'failed' is terminal
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      nodeId: 'a',
      kind: 'script',
      status: 'success',
      output: { value: { ok: true }, truncated: null, error: null, verdict: null },
    })
  })

  test('finalized is false while the parent job is still running/queued', () => {
    const row = fakeRow({ id: 'job-1', status: 'running' })
    const service = createJobService({
      jobStore: { get: () => row, nodes: () => [] } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })
    expect(service.nodes('job-1').finalized).toBe(false)
  })

  test('throws job_not_found for a missing job — never a bare empty array standing in for "no such job"', () => {
    const service = createJobService({
      jobStore: {
        get: () => null,
        nodes: () => {
          throw new Error('nodes() must never be reached for a missing job')
        },
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })
    expect(() => service.nodes('no-such-job')).toThrow(EnkakuError)
  })
})

/**
 * `resume()` (plan 99 §3.5, §4.9, step 99.8) — `POST /api/jobs/:id/resume`.
 * These exercise the SERVICE's own decision logic (terminal gate, "did
 * fromNode actually run" gate, copying the RESOLVED `scriptId` verbatim)
 * against a fake store; `jobs-workflow-resume.integration.test.ts` proves the
 * same route against a real DB and rows the real workflow executor wrote.
 */
describe('createJobService.resume (plan 99 §3.5, §4.9, step 99.8)', () => {
  function nodeRow(nodeId: string, status: string, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: `n-${nodeId}`,
      jobId: 'job-1',
      seq: 0,
      nodeId,
      kind: 'script',
      scriptId: null,
      scriptName: null,
      scriptVersion: null,
      status,
      attempts: 1,
      startedAt: null,
      finishedAt: null,
      output: null,
      outputTruncated: null,
      verdict: null,
      error: null,
      errorCode: null,
      resumedFromJobId: null,
      resumedFromNode: null,
      ...overrides,
    }
  }

  test('creates a new job for the ORIGINAL job\'s already-resolved scriptId — never re-resolved — and records the resume lineage', () => {
    const original = fakeRow({
      id: 'job-1',
      scriptId: 'pipeline-1.0.0',
      scriptName: 'pipeline',
      scriptVersion: '1.0.0',
      deviceId: 'd1',
      params: { keyword: 'cats' },
      status: 'failed',
      priority: 3,
    })
    const enqueueCalls: Parameters<JobStore['enqueue']>[0][] = []
    const recordResumeCalls: Array<{ jobId: string; input: { resumedFromJobId: string; resumedFromNode: string } }> = []
    let statusEmitted: unknown
    let kicked = false
    const newRow = fakeRow({ id: 'job-2', scriptId: 'pipeline-1.0.0', scriptName: 'pipeline', scriptVersion: '1.0.0', deviceId: 'd1' })
    const service = createJobService({
      jobStore: {
        get: () => original,
        nodes: () => [nodeRow('a', 'success'), nodeRow('b', 'success'), nodeRow('c', 'skipped')],
        enqueue: (input: Parameters<JobStore['enqueue']>[0]) => {
          enqueueCalls.push(input)
          return newRow
        },
        recordResume: (jobId: string, input: { resumedFromJobId: string; resumedFromNode: string }) => {
          recordResumeCalls.push({ jobId, input })
        },
        scriptNames: () => new Map(),
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: { kick: () => void (kicked = true), start: () => {}, stop: () => {} },
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: (info) => {
        statusEmitted = info
      },
    })

    const info = service.resume('job-1', { fromNode: 'b' })

    expect(enqueueCalls).toHaveLength(1)
    // The ONLY correctness property that matters here: the exact resolved
    // scriptId the ORIGINAL job ran, copied verbatim — no resolver, no
    // registry lookup, nothing that could re-resolve `@latest`.
    expect(enqueueCalls[0]?.scriptId).toBe('pipeline-1.0.0')
    expect(enqueueCalls[0]?.deviceId).toBe('d1')
    expect(enqueueCalls[0]?.params).toEqual({ keyword: 'cats' })
    expect(enqueueCalls[0]?.scriptName).toBe('pipeline')
    expect(enqueueCalls[0]?.scriptVersion).toBe('1.0.0')

    expect(recordResumeCalls).toEqual([{ jobId: 'job-2', input: { resumedFromJobId: 'job-1', resumedFromNode: 'b' } }])
    expect(info.jobId).toBe('job-2')
    expect(statusEmitted).toBe(info)
    expect(kicked).toBe(true)
  })

  test('a node that only ever reached status "skipped" is refused (400 job_node_not_found) — the cursor never ran it, even though it is a real node', () => {
    const original = fakeRow({ id: 'job-1', status: 'failed' })
    const service = createJobService({
      jobStore: {
        get: () => original,
        nodes: () => [nodeRow('a', 'success'), nodeRow('c', 'skipped')],
        enqueue: () => {
          throw new Error('enqueue must never be reached — the node-ran gate must refuse first')
        },
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    let caught: EnkakuError | undefined
    try {
      service.resume('job-1', { fromNode: 'c' })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('job_node_not_found')
  })

  test('a node id that never appears at all is refused the same way ("never ran")', () => {
    const original = fakeRow({ id: 'job-1', status: 'failed' })
    const service = createJobService({
      jobStore: {
        get: () => original,
        nodes: () => [nodeRow('a', 'success')],
        enqueue: () => {
          throw new Error('enqueue must never be reached')
        },
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    expect(() => service.resume('job-1', { fromNode: 'does-not-exist' })).toThrow(EnkakuError)
    try {
      service.resume('job-1', { fromNode: 'does-not-exist' })
    } catch (err) {
      expect((err as EnkakuError).code).toBe('job_node_not_found')
    }
  })

  test.each(['queued', 'running'])('a job still %s is refused with job_not_terminal (409) — resume only a settled job', (status) => {
    const original = fakeRow({ id: 'job-1', status })
    const service = createJobService({
      jobStore: {
        get: () => original,
        nodes: () => {
          throw new Error('nodes() must never be reached — the terminal gate must refuse first')
        },
        enqueue: () => {
          throw new Error('enqueue must never be reached')
        },
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    let caught: EnkakuError | undefined
    try {
      service.resume('job-1', { fromNode: 'a' })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('job_not_terminal')
  })

  test.each(['success', 'failed', 'cancelled', 'expired'])('a %s (terminal) job may be resumed', (status) => {
    const original = fakeRow({ id: 'job-1', status })
    const service = createJobService({
      jobStore: {
        get: () => original,
        nodes: () => [nodeRow('a', 'success')],
        enqueue: () => fakeRow({ id: 'job-2' }),
        recordResume: () => {},
        scriptNames: () => new Map(),
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    const info = service.resume('job-1', { fromNode: 'a' })
    expect(info.jobId).toBe('job-2')
  })

  test('throws job_not_found for a missing job', () => {
    const service = createJobService({
      jobStore: {
        get: () => null,
        nodes: () => {
          throw new Error('nodes() must never be reached for a missing job')
        },
      } as unknown as JobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })
    expect(() => service.resume('no-such-job', { fromNode: 'a' })).toThrow(EnkakuError)
  })
})

/**
 * Plan 98 §3.7, §3.8, §4.1, §4.4, §4.6, step 98.5 — `jobs.max_concurrent` is
 * resolved HERE, at enqueue (and at resume — plan 99 §3.5's own "never
 * re-resolve the scriptId" rule does not extend to the cap, which must still
 * reflect the row it is bound to), via `resolveRuntime`, the SAME resolver
 * `timeoutMs`/`maxRssBytes` already go through — never a raw read of
 * `scriptNameOf(...).runtime?.maxConcurrent` with no resolver in between.
 * These tests exercise `createJobService` directly with a capturing fake
 * `JobStore`, asserting the exact `maxConcurrent` value `jobStore.enqueue`
 * was called with — the claim SQL's own gate is `queue/job-store.test.ts`'s
 * job, not this file's.
 */
describe('createJobService.enqueue/resume — maxConcurrent resolution (plan 98 §3.7, §4.6, step 98.5)', () => {
  function capturingJobStore(row: JobRow): { store: JobStore; calls: Parameters<JobStore['enqueue']>[0][] } {
    const calls: Parameters<JobStore['enqueue']>[0][] = []
    const store = {
      enqueue: (input: Parameters<JobStore['enqueue']>[0]) => {
        calls.push(input)
        return row
      },
      get: () => row,
      nodes: () => [],
      recordResume: () => {},
      scriptNames: () => new Map(),
    } as unknown as JobStore
    return { store, calls }
  }

  test('a script declaring runtime.maxConcurrent resolves onto the enqueued row', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      scriptNameOf: () => ({ name: 'login', version: '1.0.0', runtime: { maxConcurrent: 1 } }),
    })

    service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.maxConcurrent).toBe(1)
  })

  test('a script declaring no runtime at all resolves to 0 (unlimited) — never null, which is reserved for a pre-plan-98 row', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      scriptNameOf: () => ({ name: 'login', version: '1.0.0', runtime: null }),
    })

    service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })

    expect(calls[0]?.maxConcurrent).toBe(0)
  })

  test('no scriptNameOf wired at all (a test harness, or a host built before plan 82) still resolves 0, never throws', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      // scriptNameOf deliberately omitted.
    })

    service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })

    expect(calls[0]?.maxConcurrent).toBe(0)
  })

  test('an explicit farmJobSettings getter does not change the resolved maxConcurrent — the field has no farm layer at all (resolveRuntime\'s own doc comment)', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      scriptNameOf: () => ({ name: 'login', version: '1.0.0', runtime: { maxConcurrent: 3 } }),
      // A deliberately unusual farm — if maxConcurrent had a farm layer, this
      // would have to matter. It must not.
      farmJobSettings: () => ({
        resetPolicy: 'aggressive',
        resetTimeoutMs: 60_000,
        resetStrict: true,
        retry: { maxInfraAttempts: 9, backoffBaseMs: 500, backoffMaxMs: 5_000, timeoutIsInfra: true, rebindOnInfra: false },
        crashPolicy: 'any',
        quietPeriodSec: 0,
        maxWaitSec: 0,
        defaultTimeoutMs: 999_999,
        startupTimeoutMs: 5_000,
        maxTimeoutMs: 1_000,
        memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'off', sampleIntervalMs: 250 },
        trigger: { maxDepth: 1, maxPerChain: 1, maxPerJob: 1 },
        // Plan 97 §3.4, §3.7, §4.9 — landed concurrently with this test's own plan.
        maxResultBytes: 65_536,
        progressIntervalMs: 1_000,
      }),
    })

    service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })

    expect(calls[0]?.maxConcurrent).toBe(3)
  })

  test('resume() re-resolves maxConcurrent from the ORIGINAL job\'s pinned scriptId — a resumed job of a capped script stays capped', () => {
    const original = fakeRow({ id: 'job-1', scriptId: 'capped-script-1.0.0', status: 'failed' })
    const newRow = fakeRow({ id: 'job-2', scriptId: 'capped-script-1.0.0' })
    const { store, calls } = capturingJobStore(newRow)
    // capturingJobStore's `get`/`nodes` already return `original`/`[]`, but
    // this test needs `get` to answer the ORIGINAL row specifically and
    // `nodes` to report a failed attempt worth resuming from.
    const jobStore = {
      ...store,
      get: () => original,
      nodes: () => [{ nodeId: 'a', status: 'failed' }],
    } as unknown as JobStore
    const service = createJobService({
      jobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      scriptNameOf: (scriptId) => (scriptId === 'capped-script-1.0.0' ? { name: 'capped-script', version: '1.0.0', runtime: { maxConcurrent: 1 } } : null),
    })

    service.resume('job-1', { fromNode: 'a' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.maxConcurrent).toBe(1)
  })
})

/**
 * Plan 98 §3.3 S1, §4.5, step 98.6 — the version gate wired into BOTH
 * `enqueue()` and `resume()`, the OTHER two of the three write paths onto
 * `jobs` (`jobs/triggers.ts`'s `trigger()` is the third, covered in its own
 * test file against a real `ScriptRegistry`). Exercised here against a
 * capturing fake store, so "no device is ever claimed for it" is provable
 * directly: `jobStore.enqueue` — the row write itself — must never be
 * called when the gate refuses.
 */
describe('createJobService.enqueue/resume — the version gate (plan 98 §3.3 S1, step 98.6)', () => {
  function capturingJobStore(row: JobRow): { store: JobStore; calls: Parameters<JobStore['enqueue']>[0][] } {
    const calls: Parameters<JobStore['enqueue']>[0][] = []
    const store = {
      enqueue: (input: Parameters<JobStore['enqueue']>[0]) => {
        calls.push(input)
        return row
      },
      get: () => row,
      nodes: () => [],
      recordResume: () => {},
      scriptNames: () => new Map(),
    } as unknown as JobStore
    return { store, calls }
  }

  test('a script declaring an unsupported runtime.sdk is refused at enqueue with E_RUNTIME_UNSUPPORTED, naming the declared major and the supported range — jobStore.enqueue is never called', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      scriptNameOf: () => ({ name: 'future-script', version: '1.0.0', runtime: { sdk: 99 } }),
    })

    let caught: EnkakuError | undefined
    try {
      service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('E_RUNTIME_UNSUPPORTED')
    expect(caught?.message).toContain('99')
    expect(calls).toHaveLength(0)
  })

  test('a script declaring no runtime.sdk at all (every pre-plan-98 script) enqueues unaffected', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      scriptNameOf: () => ({ name: 'login', version: '1.0.0', runtime: null }),
    })

    const info = service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })
    expect(info.jobId).toBe('job-1')
    expect(calls).toHaveLength(1)
  })

  test('no scriptNameOf wired at all never refuses — a farm mid-upgrade never runs nothing (plan 59: a precondition is not a failure)', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      // scriptNameOf deliberately omitted.
    })

    const info = service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })
    expect(info.jobId).toBe('job-1')
    expect(calls).toHaveLength(1)
  })

  test('resume() re-checks the version gate against the ORIGINAL job\'s pinned script — refused the same way a fresh enqueue would be', () => {
    const original = fakeRow({ id: 'job-1', scriptId: 'future-script-1.0.0', status: 'failed' })
    const { store, calls } = capturingJobStore(fakeRow({ id: 'job-2' }))
    const jobStore = {
      ...store,
      get: () => original,
      nodes: () => [{ nodeId: 'a', status: 'failed' }],
    } as unknown as JobStore
    const service = createJobService({
      jobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      scriptNameOf: () => ({ name: 'future-script', version: '1.0.0', runtime: { sdk: 99 } }),
    })

    let caught: EnkakuError | undefined
    try {
      service.resume('job-1', { fromNode: 'a' })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('E_RUNTIME_UNSUPPORTED')
    expect(calls).toHaveLength(0)
  })
})

/**
 * Plan 98 §3.8, §4.5, §4.7, step 98.7 — the operator's own per-job override,
 * the layer `resolveRuntime`'s `override` argument has carried since step
 * 98.3 first called it and has been passed `null` for ever since. Exercised
 * against a capturing fake store, mirroring the `maxConcurrent` describe
 * block above exactly, plus the shape-validation and ceiling-refusal paths
 * `scripts/routes.ts`'s publish route already established the convention
 * for (`E_RUNTIME_ENVELOPE_INVALID`, unknown-key warnings never fatal).
 */
describe('createJobService.enqueue/resume — the per-job override (plan 98 §3.8, step 98.7)', () => {
  function capturingJobStore(row: JobRow): { store: JobStore; calls: Parameters<JobStore['enqueue']>[0][] } {
    const calls: Parameters<JobStore['enqueue']>[0][] = []
    const store = {
      enqueue: (input: Parameters<JobStore['enqueue']>[0]) => {
        calls.push(input)
        return row
      },
      get: () => row,
      nodes: () => [],
      recordResume: () => {},
      scriptNames: () => new Map(),
    } as unknown as JobStore
    return { store, calls }
  }

  /** A farm with a real, concrete ceiling on both fields `resolveRuntime` can clamp/refuse. */
  const CEILING_FARM: JobSettings = {
    resetPolicy: 'home',
    resetTimeoutMs: 60_000,
    resetStrict: false,
    retry: { maxInfraAttempts: 3, backoffBaseMs: 500, backoffMaxMs: 5_000, timeoutIsInfra: true, rebindOnInfra: true },
    crashPolicy: 'declared',
    quietPeriodSec: 0,
    maxWaitSec: 0,
    defaultTimeoutMs: 3_600_000,
    startupTimeoutMs: 5_000,
    maxTimeoutMs: 4_000_000, // the ceiling this describe block's timeoutMs tests exercise
    memory: { defaultMaxRssBytes: null, maxRssBytes: 512 * 1024 * 1024, enforce: 'kill' as const, sampleIntervalMs: 2_000 },
    trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
    // Plan 97 §3.4, §3.7, §4.9 — landed concurrently with this describe block's own plan.
    maxResultBytes: 65_536,
    progressIntervalMs: 1_000,
  }

  test('an override under both ceilings enqueues normally, pinned verbatim onto the row', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      farmJobSettings: () => CEILING_FARM,
    })

    const info = service.enqueue({
      scriptId: 'internal:sleep',
      deviceId: 'dev-1',
      params: {},
      runtimeOverride: { timeoutMs: 1_000_000, maxRssBytes: 256 * 1024 * 1024 },
    })

    expect(info.jobId).toBe('job-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.runtimeOverride).toEqual({ timeoutMs: 1_000_000, maxRssBytes: 256 * 1024 * 1024 })
  })

  test('no runtimeOverride at all pins null — identical to every job enqueued before this field existed', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })
    expect(calls[0]?.runtimeOverride).toBeNull()
  })

  test('runtimeOverride.timeoutMs above job.maxTimeoutMs is refused with E_RUNTIME_OVER_CEILING naming both numbers, and no job row is created', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      farmJobSettings: () => CEILING_FARM,
    })

    let caught: EnkakuError | undefined
    try {
      service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {}, runtimeOverride: { timeoutMs: 6_000_000 } })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('E_RUNTIME_OVER_CEILING')
    expect(caught?.message).toContain('6000000')
    expect(caught?.message).toContain('4000000')
    expect(calls).toHaveLength(0)
  })

  test('runtimeOverride.maxRssBytes above job.memory.maxRssBytes is refused the same way', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      farmJobSettings: () => CEILING_FARM,
    })

    let caught: EnkakuError | undefined
    try {
      service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {}, runtimeOverride: { maxRssBytes: 1024 * 1024 * 1024 } })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('E_RUNTIME_OVER_CEILING')
    expect(calls).toHaveLength(0)
  })

  test('a SCRIPT declaration over the ceiling is a different thing — still clamped elsewhere, never refused at enqueue for that reason alone (only the OVERRIDE refuses here)', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      farmJobSettings: () => CEILING_FARM,
      // The SCRIPT's own declared timeout is above the ceiling — §3.8's
      // OTHER branch (clamped and logged at run time, never refused here).
      scriptNameOf: () => ({ name: 'checkout', version: '1.0.0', runtime: { timeoutMs: 9_000_000 } }),
    })

    const info = service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {} })
    expect(info.jobId).toBe('job-1')
    expect(calls).toHaveLength(1)
  })

  test('the farm ceiling still wins even when the override is paired with a script declaration under it — the override never bypasses the ceiling', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      farmJobSettings: () => CEILING_FARM,
      scriptNameOf: () => ({ name: 'checkout', version: '1.0.0', runtime: { timeoutMs: 500_000 } }),
    })

    let caught: EnkakuError | undefined
    try {
      service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {}, runtimeOverride: { timeoutMs: 5_000_000 } })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught?.code).toBe('E_RUNTIME_OVER_CEILING')
    expect(calls).toHaveLength(0)
  })

  test('a shape violation (e.g. retries below its own floor) is refused with E_RUNTIME_ENVELOPE_INVALID — never trusting the caller\'s own checks', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    let caught: EnkakuError | undefined
    try {
      service.enqueue({ scriptId: 'internal:sleep', deviceId: 'dev-1', params: {}, runtimeOverride: { retries: -1 } })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('E_RUNTIME_ENVELOPE_INVALID')
    expect(calls).toHaveLength(0)
  })

  test('an unknown key in the override is stripped and warned, never fatal (§3.3 S3 applies to this layer too) — the job still enqueues with the known fields', () => {
    const { store, calls } = capturingJobStore(fakeRow())
    const warnings: string[] = []
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
      child: () => log,
    } as unknown as Logger
    const service = createJobService({
      jobStore: store,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log,
      onJobStatus: () => {},
    })

    const info = service.enqueue({
      scriptId: 'internal:sleep',
      deviceId: 'dev-1',
      params: {},
      runtimeOverride: { timeoutMs: 60_000, futureField: 'from a newer operator UI' },
    })

    expect(info.jobId).toBe('job-1')
    expect(calls[0]?.runtimeOverride).toEqual({ timeoutMs: 60_000 })
    expect(warnings.some((w) => w.includes('futureField'))).toBe(true)
  })

  test('resume() carries the ORIGINAL job\'s own override forward, re-resolved against the CURRENT farm — not simply copied', () => {
    const original = fakeRow({
      id: 'job-1',
      scriptId: 'pipeline-1.0.0',
      status: 'failed',
      runtimeOverride: { timeoutMs: 1_000_000 },
    })
    const { store, calls } = capturingJobStore(fakeRow({ id: 'job-2' }))
    const jobStore = {
      ...store,
      get: () => original,
      nodes: () => [{ nodeId: 'a', status: 'failed' }],
    } as unknown as JobStore
    const service = createJobService({
      jobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      farmJobSettings: () => CEILING_FARM,
    })

    service.resume('job-1', { fromNode: 'a' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.runtimeOverride).toEqual({ timeoutMs: 1_000_000 })
  })

  test('resume() refuses with E_RUNTIME_OVER_CEILING if the farm ceiling has since tightened below the original override — never silently re-clamped', () => {
    const original = fakeRow({
      id: 'job-1',
      scriptId: 'pipeline-1.0.0',
      status: 'failed',
      runtimeOverride: { timeoutMs: 3_900_000 }, // was under the ceiling when first enqueued
    })
    const { store, calls } = capturingJobStore(fakeRow({ id: 'job-2' }))
    const jobStore = {
      ...store,
      get: () => original,
      nodes: () => [{ nodeId: 'a', status: 'failed' }],
    } as unknown as JobStore
    const service = createJobService({
      jobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
      // The operator tightened the ceiling since the original job ran.
      farmJobSettings: () => ({ ...CEILING_FARM, maxTimeoutMs: 1_000_000 }),
    })

    let caught: EnkakuError | undefined
    try {
      service.resume('job-1', { fromNode: 'a' })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('E_RUNTIME_OVER_CEILING')
    expect(calls).toHaveLength(0)
  })

  test('a job with no override at all resumes with runtimeOverride: null, unaffected', () => {
    const original = fakeRow({ id: 'job-1', scriptId: 'pipeline-1.0.0', status: 'failed', runtimeOverride: null })
    const { store, calls } = capturingJobStore(fakeRow({ id: 'job-2' }))
    const jobStore = {
      ...store,
      get: () => original,
      nodes: () => [{ nodeId: 'a', status: 'failed' }],
    } as unknown as JobStore
    const service = createJobService({
      jobStore,
      registry: fakeRegistry(),
      scheduler: fakeScheduler(),
      host: {} as ExecutorHost,
      log: silentLog(),
      onJobStatus: () => {},
    })

    service.resume('job-1', { fromNode: 'a' })
    expect(calls[0]?.runtimeOverride).toBeNull()
  })
})
