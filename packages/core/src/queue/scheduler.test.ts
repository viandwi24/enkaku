import { describe, expect, spyOn, test } from 'bun:test'
import type { JobRow, JobRunRow } from '../db/schema'
import type { RunStore } from '../jobs/runs/store'
import { createLogger } from '../util/logger'
import { createScheduler, MAX_CONTROL_WAIT_SEC, type SchedulerDeps } from './scheduler'
import type { ClaimedJob, JobStore } from './job-store'
import type { ExecutorHost } from '../jobs/executor-host'
import type { ActivityKind, DeviceActivity } from '@enkaku/protocol'

/**
 * Plan 205 §3.2 item 6, §4.7 — "job over fresh control": a live control
 * marker delays a job; ended 15s ago (no live marker at all) does not; the
 * `MAX_CONTROL_WAIT_SEC` cap expires and the job proceeds; the waiting state
 * is observable throughout, naming the conflicting activity. A live
 * `install` activity excludes a device from claiming silently (the policy
 * row "job over install = forbid"), without ever being reported as waiting.
 *
 * Re-keyed to runs by plan 211 §4.6, §4.9: the claim, `nextQueuedRunId` and
 * `onJobWaiting` all carry a run id now, alongside the job id.
 *
 * `Scheduler.kick()` calls an internally-async `loop()` whose body never
 * actually `await`s anything (every dependency below is synchronous, exactly
 * like the real `JobStore`/`ExecutorHost` methods it stands in for) — so by
 * the time `kick()` returns, every synchronous effect (broadcasts, claims)
 * has already happened. Tests assert immediately, with no `await` needed.
 */

function fakeJobRow(id: string): JobRow {
  return {
    id,
    kind: 'script',
    scriptId: 'script-1',
    workflowName: null,
    workflowDoc: null,
    deviceId: 'unused',
    params: null,
    batchId: null,
    batchSeq: null,
    scheduleId: null,
    parentWorkflowJobId: null,
    stepSeq: null,
    scriptName: 'internal:sleep',
    scriptVersion: null,
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    triggerKey: null,
    createdBy: null,
    createdAt: new Date(),
    latestRunId: null,
    runCount: 1,
  } as unknown as JobRow
}

function fakeRunRow(id: string, jobId: string, deviceId: string, notBefore: number | null = null): JobRunRow {
  return {
    id,
    jobId,
    seq: 1,
    trigger: 'manual',
    status: 'queued',
    deviceId,
    scriptName: 'internal:sleep',
    priority: 0,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    heartbeatExpiresAt: null,
    expiresAt: null,
    notBefore,
    batchRepeat: null,
    pacedDelayMs: null,
    result: null,
    error: null,
    failureClass: null,
    errorPhase: null,
    infraAttempts: 0,
    peakRssBytes: null,
    maxConcurrent: null,
    runtimeOverride: null,
    resultStatus: null,
    resultBytes: null,
    resultSummary: null,
    resultIssues: null,
    resumedFromRunId: null,
    resumedFromStep: null,
  } as unknown as JobRunRow
}

function fakeJobStore(opts: {
  queuedDeviceIds: string[]
  deviceId?: string
  jobId?: string
  runId?: string
  /** Plan 94 §3.8, §4.8, step 94.6 — wired onto the fake run `getRun()` returns, so a test can exercise `computePacedBlocked` the same way `computeControlBlocked` is exercised. `undefined` (the default) matches every fixture row elsewhere in this tree that predates this column. */
  notBefore?: number | null
}): { store: JobStore; runs: RunStore; claimedCalls: string[][] } {
  const deviceId = opts.deviceId ?? 'd1'
  const jobId = opts.jobId ?? 'job-1'
  const runId = opts.runId ?? 'run-1'
  const claimed: string[][] = [] // records the `excludeDeviceIds` argument of every claimNext call
  let alreadyClaimed = false
  const run = fakeRunRow(runId, jobId, deviceId, opts.notBefore ?? null)
  const store: Partial<JobStore> = {
    queuedDeviceIds: () => opts.queuedDeviceIds,
    nextQueuedRunId: (id) => (id === deviceId && !alreadyClaimed ? runId : null),
    scriptNames: () => new Map([['script-1', { name: 'internal:sleep', version: '1.0.0' }]]),
    claimNext: (_jobTtlSec, excludeDeviceIds = []) => {
      claimed.push(excludeDeviceIds)
      if (alreadyClaimed) return null
      if (excludeDeviceIds.includes(deviceId)) return null
      alreadyClaimed = true
      const claimedJob: ClaimedJob = { job: fakeJobRow(jobId), run, deviceId }
      return claimedJob
    },
  }
  const runs: Partial<RunStore> = {
    getRun: (id) => (id === runId ? run : null),
  }
  return { store: store as JobStore, runs: runs as RunStore, claimedCalls: claimed }
}

function fakeHost(): ExecutorHost {
  return { start: () => {}, abort: () => false, isRunning: () => false, finishExternally: () => {}, deliverCrash: () => false } as unknown as ExecutorHost
}

function controlActivity(clientId: string, label = 'Rina'): DeviceActivity {
  return {
    id: `control:${clientId}`,
    kind: 'control',
    label: `Controlled by ${label}`,
    actor: { kind: 'user', id: clientId, label },
    startedAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

/** A minimal fake `ActivityRegistry` slice — only the three methods `SchedulerDeps.activities` needs. */
function fakeActivities(opts: { liveControls?: () => DeviceActivity[]; installDevices?: string[] } = {}) {
  const startCalls: Array<{ deviceId: string; id: string; kind: ActivityKind; label: string }> = []
  return {
    liveControls: (_deviceId: string) => opts.liveControls?.() ?? [],
    devicesWith: (kind: ActivityKind) => (kind === 'install' ? (opts.installDevices ?? []) : []),
    start: (deviceId: string, input: { id: string; kind: ActivityKind; label: string; actor: unknown; href?: string }) => {
      startCalls.push({ deviceId, id: input.id, kind: input.kind, label: input.label })
      return { ...input, actor: input.actor, startedAt: 0, updatedAt: 0 } as unknown as DeviceActivity
    },
    startCalls,
  }
}

function baseDeps(jobStore: JobStore, runs: RunStore, overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    jobStore,
    runs,
    host: fakeHost(),
    log: createLogger('test'),
    jobTtlSec: 60,
    fallbackIntervalMs: 1_000_000,
    onJobStatus: () => {},
    onJobClaimed: () => {},
    activities: fakeActivities(),
    ...overrides,
  }
}

describe('createScheduler — control wait (plan 205 §3.2 item 6, §4.7)', () => {
  test('a live control marker blocks the job — not claimed, and the wait is broadcast visibly naming the conflicting activity', () => {
    const { store, runs, claimedCalls } = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const waitingEvents: Array<{ jobId: string; runId: string; deviceId: string; waiting: boolean; reason: 'control' | 'paced'; conflicting: DeviceActivity | null; remainingSec: number }> = []
    const marker = controlActivity('client-1')
    const scheduler = createScheduler(
      baseDeps(store, runs, {
        activities: fakeActivities({ liveControls: () => [marker] }),
        onJobWaiting: (info) => waitingEvents.push(info),
      }),
    )

    scheduler.kick()

    // The device was excluded from the claim — the job was never actually claimed.
    expect(claimedCalls.some((ex) => ex.includes('d1'))).toBe(true)
    expect(waitingEvents).toHaveLength(1)
    expect(waitingEvents[0]).toMatchObject({ jobId: 'job-1', runId: 'run-1', deviceId: 'd1', waiting: true, reason: 'control', conflicting: marker })
    expect(waitingEvents[0]!.remainingSec).toBeGreaterThan(0)
    expect(waitingEvents[0]!.remainingSec).toBeLessThanOrEqual(MAX_CONTROL_WAIT_SEC)
  })

  test('no live control marker at all does NOT block — the job is claimed immediately', () => {
    const { store, runs, claimedCalls } = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const waitingEvents: unknown[] = []
    const scheduler = createScheduler(
      baseDeps(store, runs, {
        activities: fakeActivities({ liveControls: () => [] }),
        onJobWaiting: (info) => waitingEvents.push(info),
      }),
    )

    scheduler.kick()

    expect(waitingEvents).toHaveLength(0)
    // claimNext was called with an EMPTY exclude list (nothing blocked) and actually claimed the job.
    expect(claimedCalls.some((ex) => ex.length === 0)).toBe(true)
  })

  test('the MAX_CONTROL_WAIT_SEC cap forces the job to proceed even though a control marker is still live (never waits past the cap)', () => {
    const realNow = Date.now()
    const nowSpy = spyOn(Date, 'now').mockReturnValue(realNow)
    try {
      const { store, runs, claimedCalls } = fakeJobStore({ queuedDeviceIds: ['d1'] })
      const scheduler = createScheduler(
        baseDeps(store, runs, {
          activities: fakeActivities({ liveControls: () => [controlActivity('client-1')] }),
          onJobWaiting: () => {},
        }),
      )

      // First tick: observed blocked, the wait clock starts here.
      scheduler.kick()
      expect(claimedCalls.at(-1)).toEqual(['d1'])

      // Advance the clock past the cap and tick again — the job proceeds
      // even though the control marker is still live.
      nowSpy.mockReturnValue(realNow + (MAX_CONTROL_WAIT_SEC + 1) * 1000)
      scheduler.kick()
      expect(claimedCalls.at(-1)).toEqual([])
    } finally {
      nowSpy.mockRestore()
    }
  })

  test('a job is never silently dropped by the control gate — it keeps its place and is claimed the moment the marker ends', () => {
    let live: DeviceActivity[] = [controlActivity('client-1')]
    const { store, runs, claimedCalls } = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const scheduler = createScheduler(
      baseDeps(store, runs, {
        activities: fakeActivities({ liveControls: () => live }),
        onJobWaiting: () => {},
      }),
    )

    scheduler.kick() // blocked — not claimed
    expect(claimedCalls.at(-1)).toEqual(['d1'])

    // The marker ends.
    live = []
    scheduler.kick()
    expect(claimedCalls.at(-1)).toEqual([])
  })

  test('without wiring `onJobWaiting` at all, behaviour is unchanged — nothing is ever reported (a host that predates this plan)', () => {
    const { store, runs, claimedCalls } = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const scheduler = createScheduler(baseDeps(store, runs)) // no onJobWaiting
    scheduler.kick()
    expect(claimedCalls.some((ex) => ex.length === 0)).toBe(true)
  })

  test('a device with a live install activity is excluded from claimNext silently — never reported as waiting (policy row "job over install = forbid")', () => {
    const { store, runs, claimedCalls } = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const waitingEvents: unknown[] = []
    const scheduler = createScheduler(
      baseDeps(store, runs, {
        activities: fakeActivities({ liveControls: () => [], installDevices: ['d1'] }),
        onJobWaiting: (info) => waitingEvents.push(info),
      }),
    )

    scheduler.kick()

    expect(waitingEvents).toHaveLength(0)
    expect(claimedCalls.some((ex) => ex.includes('d1'))).toBe(true)
  })

  test('claiming a job starts a job:<runId> activity labelled with the resolved script name', () => {
    const { store, runs } = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const activities = fakeActivities()
    const scheduler = createScheduler(baseDeps(store, runs, { activities }))

    scheduler.kick()

    expect(activities.startCalls).toHaveLength(1)
    expect(activities.startCalls[0]).toMatchObject({ deviceId: 'd1', id: 'job:run-1', kind: 'job' })
    expect(activities.startCalls[0]!.label).toContain('internal:sleep')
  })
})

/**
 * Plan 94 §3.8, §4.8, step 94.6 — the scheduler's own half of the pacer's
 * visibility: `job.waiting` gains `reason: 'control' | 'paced'` (renamed
 * from `'quiet'` by plan 205 §4.7), and a paced job reports its remaining
 * seconds. This only proves the reason and remaining seconds reach
 * `onJobWaiting` (the wire, via `daemon.ts`'s passthrough broadcast) —
 * rendering it (Studio's "waiting — next repetition in 4s" line) is step
 * 94.10's own surface, not this one's.
 */
describe('createScheduler — paced wait (plan 94 §3.8, §4.8, step 94.6)', () => {
  test('a job whose notBefore is in the future is reported waiting with reason: "paced" and a positive remainingSec — and is NOT excluded from claimNext (pacing is per-row, never device-wide)', () => {
    const now = Math.floor(Date.now() / 1000)
    const { store, runs, claimedCalls } = fakeJobStore({ queuedDeviceIds: ['d1'], notBefore: now + 5 })
    const waitingEvents: Array<{ jobId: string; runId: string; deviceId: string; waiting: boolean; reason: 'control' | 'paced'; conflicting: DeviceActivity | null; remainingSec: number }> = []
    const scheduler = createScheduler(baseDeps(store, runs, { onJobWaiting: (info) => waitingEvents.push(info) }))

    scheduler.kick()

    expect(waitingEvents).toHaveLength(1)
    expect(waitingEvents[0]).toMatchObject({ jobId: 'job-1', runId: 'run-1', deviceId: 'd1', waiting: true, reason: 'paced', conflicting: null })
    expect(waitingEvents[0]!.remainingSec).toBeGreaterThan(0)
    expect(waitingEvents[0]!.remainingSec).toBeLessThanOrEqual(5)
    // The control gate's own exclusion list is empty — a paced job's own SQL
    // predicate (job-store.ts) is what keeps it from claiming, not the
    // scheduler excluding its device wholesale.
    expect(claimedCalls.some((ex) => ex.length === 0)).toBe(true)
  })

  test('notBefore null (the overwhelming majority of jobs, and every job before this column existed) never reports a paced wait', () => {
    const { store, runs } = fakeJobStore({ queuedDeviceIds: ['d1'], notBefore: null })
    const waitingEvents: unknown[] = []
    const scheduler = createScheduler(baseDeps(store, runs, { onJobWaiting: (info) => waitingEvents.push(info) }))

    scheduler.kick()

    expect(waitingEvents).toHaveLength(0)
  })

  test('notBefore already in the past does not report a paced wait', () => {
    const now = Math.floor(Date.now() / 1000)
    const { store, runs } = fakeJobStore({ queuedDeviceIds: ['d1'], notBefore: now - 5 })
    const waitingEvents: unknown[] = []
    const scheduler = createScheduler(baseDeps(store, runs, { onJobWaiting: (info) => waitingEvents.push(info) }))

    scheduler.kick()

    expect(waitingEvents).toHaveLength(0)
  })

  test('a device that is both control-blocked AND paced reports "control" — the control gate is what is actually excluding it from claimNext right now', () => {
    const now = Math.floor(Date.now() / 1000)
    const { store, runs } = fakeJobStore({ queuedDeviceIds: ['d1'], notBefore: now + 5 })
    const waitingEvents: Array<{ reason: 'control' | 'paced' }> = []
    const scheduler = createScheduler(
      baseDeps(store, runs, {
        activities: fakeActivities({ liveControls: () => [controlActivity('client-1')] }),
        onJobWaiting: (info) => waitingEvents.push(info),
      }),
    )

    scheduler.kick()

    expect(waitingEvents).toHaveLength(1)
    expect(waitingEvents[0]!.reason).toBe('control')
  })
})
