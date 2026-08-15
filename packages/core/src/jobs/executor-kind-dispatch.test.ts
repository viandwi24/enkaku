import { describe, expect, test } from 'bun:test'
import type { ScriptKind } from '../db/schema'
import type { DeviceHealth } from '../device/health'
import type { DeviceStateMachine } from '../device/state-machine'
import type { JobRow } from '../db/schema'
import type { LeaseManager } from '../lease/lease-manager'
import type { JobStore } from '../queue/job-store'
import type { Logger } from '../util/logger'
import type { JobExecutor } from './executor'
import { ExecutorRegistry } from './executor'
import { createExecutorHost, type ExecutorHostDeps } from './executor-host'

/**
 * SELF-DETECTING GAP — fails while the fix is missing, per plan 99 §5 step
 * 99.7's own brief ("if a small edit in another's file is unavoidable, make
 * the gap self-detecting: a test that fails while it is missing, naming the
 * exact lines"). The verbatim fix, repeated here and in this step's report:
 *
 *   1. `ExecutorHostDeps` (`executor-host.ts`) gains one new OPTIONAL field:
 *
 *        /** The kind of `job.scriptId`'s row — 'script' (the default) or
 *         *  'workflow'. Read fresh per start, like `pickRebindDevice` above.
 *         *  Undefined behaves exactly as before this field existed. * /
 *        scriptKind?: (scriptId: string) => import('../db/schema').ScriptKind
 *
 *   2. `start()`'s first line becomes:
 *
 *        const kind = deps.scriptKind?.(job.scriptId) ?? 'script'
 *        const executor = deps.registry.get(job.scriptId, kind)
 *
 *   3. `daemon.ts`'s own `createExecutorHost({...})` call (this step's file,
 *      already correct once (2) exists) gains:
 *
 *        scriptKind: (scriptId) => scriptRegistry.get(scriptId)?.kind ?? 'script',
 *
 * WHY THIS MATTERS: plan 99 §4.5 states, in the design section, "with
 * `ExecutorHost` passing the kind it already read from the row" — as if
 * this were already true. It is not: today `start()` calls the
 * SINGLE-ARGUMENT `deps.registry.get(job.scriptId)`, which is
 * `ExecutorRegistry.get`'s own default (`kind = 'script'`). A `kind:
 * 'workflow'` job reaching the REAL claim path (`job-store.ts`'s
 * `claimNext` → `ExecutorHost.start` → `ExecutorRegistry.get`) today asks
 * for the SCRIPT fallback, never the workflow one `daemon.ts` registers via
 * `executors.setFallback(workflowExecutor, 'workflow')` (pinned separately
 * in `daemon-wiring.test.ts`). Building the workflow executor and
 * registering it correctly (both done by this step) is therefore NOT yet
 * enough to make a workflow job actually run through a real boot.
 *
 * HOW THIS TEST PROVES IT WITHOUT EDITING `executor-host.ts`: the extra
 * `scriptKind` field this test passes is entirely inert against TODAY's
 * `executor-host.ts` — nothing in `start()` reads it, so passing it changes
 * nothing at runtime and this test FAILS (`workflowExecutorCalled` stays
 * `false`). The moment a future edit adds the two lines from (2) above,
 * `start()` begins reading `deps.scriptKind` — which this test ALREADY
 * supplies, unchanged — and the assertion below starts passing with no
 * edit to this file. `ExecutorHostDeps` is extended locally (not by
 * editing `executor-host.ts`) purely so the object literal below type
 * checks; `createExecutorHost` only reads what it reads, so the extra
 * field is inert at runtime either way.
 */

type ExecutorHostDepsWithScriptKind = ExecutorHostDeps & {
  scriptKind?: (scriptId: string) => ScriptKind
}

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    scriptId: 'workflow-1',
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
    scriptName: null,
    scriptVersion: null,
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    triggerKey: null,
    peakRssBytes: null,
    assistCount: 0,
    // Plan 98 §4.4, §4.6, step 98.5 — null here: a bare fixture row, no
    // concurrency gate exercised by this file's own test.
    maxConcurrent: null,
    // Plan 98 §3.8, §4.4, step 98.7 — null here: a bare fixture row, no
    // per-job override exercised by this file's own test.
    runtimeOverride: null,
    // Plan 94 §3.8, §4.8, step 94.6 — null here: a bare fixture row, no
    // pacer exercised by this file's own test.
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    // Plan 97 §3.3, §4.4 — null here: a bare fixture row, no result path
    // exercised by this file's own test.
    resultStatus: null,
    resultBytes: null,
    resultSummary: null,
    resultIssues: null,
    ...overrides,
  }
}

describe("executor-host.ts does not yet pass a job's script kind to ExecutorRegistry.get — GAP against plan 99 §4.5's own text, not a regression this step introduced", () => {
  test('a workflow-kind job, registered ONLY via setFallback(exec, \'workflow\') exactly as daemon.ts does, is reached by a REAL ExecutorHost.start() call once a scriptKind accessor is honoured', async () => {
    const job = makeJob()
    let workflowExecutorCalled = false
    const workflowExecutor: JobExecutor = {
      validateParams: (p) => p,
      run: async () => {
        workflowExecutorCalled = true
        return 'workflow-ran'
      },
    }

    const registry = new ExecutorRegistry()
    // Exactly what daemon.ts does for real (pinned in daemon-wiring.test.ts):
    // register the workflow executor as the 'workflow' KIND fallback, never
    // under the job's literal scriptId — so only a correct kind lookup can
    // ever reach it.
    registry.setFallback(workflowExecutor, 'workflow')

    const jobStore: JobStore = {
      enqueue: () => job,
      get: () => job,
      list: () => ({ rows: [], nextCursor: null, total: 0 }),
      scriptNames: () => new Map(),
      claimNext: () => null,
      queuedDeviceIds: () => [],
      nextQueuedJobId: () => null,
      finish: (jobId, status, data) => ({ ...job, id: jobId, status, error: data.error ?? null, result: data.result ?? null, failureClass: data.failureClass ?? null }),
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
    }
    const states: DeviceStateMachine = { apply: () => ({ changed: true, from: 'busy', to: 'idle' }), current: () => 'busy' }
    const leases: LeaseManager = {
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
    const health: DeviceHealth = { note: () => {}, consecutiveFailures: () => 0, start: () => {}, stop: () => {} }

    const deps: ExecutorHostDepsWithScriptKind = {
      registry,
      jobStore,
      states,
      leases: () => leases,
      log: silentLog(),
      jobTtlSec: 60,
      heartbeatMs: 5000,
      onJobStatus: () => {},
      onFinished: () => {},
      timeoutIsInfra: () => false,
      rebindOnInfra: () => false,
      health: () => health,
      deviceSerial: () => null,
      // The prescribed fix's own accessor shape (see this file's module doc)
      // — inert against today's `executor-host.ts`, consulted the moment the
      // two-line fix lands.
      scriptKind: (scriptId) => (scriptId === job.scriptId ? 'workflow' : 'script'),
    }

    const host = createExecutorHost(deps)

    const settled = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (workflowExecutorCalled) {
          clearInterval(check)
          resolve()
        }
      }, 10)
      setTimeout(() => {
        clearInterval(check)
        resolve()
      }, 500)
    })
    host.start(job)
    await settled

    // THIS is the line that flips from red to green the day `executor-host.ts`
    // is patched per this file's own doc comment — no other edit needed here.
    expect(workflowExecutorCalled).toBe(true)
  })
})
