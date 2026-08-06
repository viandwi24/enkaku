import { describe, expect, test } from 'bun:test'
import type { JobRow } from '../db/schema'
import { createLogger } from '../util/logger'
import { createScheduler, type SchedulerDeps } from './scheduler'
import type { ClaimedJob, JobStore } from './job-store'
import type { ExecutorHost } from '../jobs/executor-host'
import type { LeaseHolder } from '@enkaku/protocol'

/**
 * Plan 71 §3.7, §7 — "quiet period": a manual lease released 2s ago delays a
 * job; released 15s ago does not; the cap expires and the job proceeds; the
 * waiting state is observable throughout. A job never waits past
 * `maxWaitSec` (criterion 12), and the wait is visible with the holder and
 * the remaining time (criterion 11).
 *
 * `Scheduler.kick()` calls an internally-async `loop()` whose body never
 * actually `await`s anything (every dependency below is synchronous, exactly
 * like the real `JobStore`/`ExecutorHost` methods it stands in for) — so by
 * the time `kick()` returns, every synchronous effect (broadcasts, claims)
 * has already happened. Tests assert immediately, with no `await` needed.
 */

function fakeJobRow(id: string, deviceId: string): JobRow {
  return {
    id,
    deviceId,
    scriptId: 'script-1',
    status: 'queued',
    priority: 0,
    error: null,
    failureClass: null,
    errorPhase: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    leaseExpiresAt: null,
    attempt: 1,
    batchId: null,
    batchSeq: null,
    expiresAt: null,
    params: null,
    result: null,
  } as unknown as JobRow
}

function fakeJobStore(opts: { queuedDeviceIds: string[]; deviceId?: string; jobId?: string }): JobStore {
  const deviceId = opts.deviceId ?? 'd1'
  const jobId = opts.jobId ?? 'job-1'
  const claimed: string[][] = [] // records the `excludeDeviceIds` argument of every claimNext call
  let alreadyClaimed = false
  const store: Partial<JobStore> & { claimedCalls: string[][] } = {
    claimedCalls: claimed,
    queuedDeviceIds: () => opts.queuedDeviceIds,
    nextQueuedJobId: (id) => (id === deviceId && !alreadyClaimed ? jobId : null),
    claimNext: (_jobTtlSec, excludeDeviceIds = []) => {
      claimed.push(excludeDeviceIds)
      if (alreadyClaimed) return null
      if (excludeDeviceIds.includes(deviceId)) return null
      alreadyClaimed = true
      const claimedJob: ClaimedJob = { job: fakeJobRow(jobId, deviceId), deviceId }
      return claimedJob
    },
  }
  return store as JobStore
}

function fakeHost(): ExecutorHost {
  return { start: () => {}, abort: () => false, isRunning: () => false, finishExternally: () => {}, deliverCrash: () => false } as unknown as ExecutorHost
}

function baseDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    jobStore: fakeJobStore({ queuedDeviceIds: ['d1'] }),
    host: fakeHost(),
    log: createLogger('test'),
    jobTtlSec: 60,
    fallbackIntervalMs: 1_000_000,
    onJobStatus: () => {},
    onDeviceBusy: () => {},
    ...overrides,
  }
}

describe('createScheduler — quiet period (plan 71 §3.7, criteria 11, 12)', () => {
  test('a device released 2s ago (quietPeriodSec: 10) blocks the job — not claimed, and the wait is broadcast visibly', () => {
    const jobStore = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const now = Math.floor(Date.now() / 1000)
    const waitingEvents: Array<{ jobId: string; deviceId: string; waiting: boolean; heldBy: LeaseHolder | null; remainingSec: number }> = []
    const holder: LeaseHolder = { kind: 'user', id: 'u1', label: 'Rina', runId: null, takeable: true, acquiredAt: now - 100, expiresAt: null }
    const scheduler = createScheduler(
      baseDeps({
        jobStore,
        quiet: {
          quietPeriodSec: () => 10,
          maxWaitSec: () => 120,
          lastManualReleaseAt: () => now - 2,
          lastManualHolder: () => holder,
        },
        onJobWaiting: (info) => waitingEvents.push(info),
      }),
    )

    scheduler.kick()

    // The device was excluded from the claim — the job was never actually claimed.
    expect((jobStore as unknown as { claimedCalls: string[][] }).claimedCalls.some((ex) => ex.includes('d1'))).toBe(true)
    expect(waitingEvents).toHaveLength(1)
    expect(waitingEvents[0]).toMatchObject({ jobId: 'job-1', deviceId: 'd1', waiting: true, heldBy: holder })
    // ~8s left of the 10s quiet gap (released 2s ago).
    expect(waitingEvents[0]!.remainingSec).toBeGreaterThan(0)
    expect(waitingEvents[0]!.remainingSec).toBeLessThanOrEqual(10)
  })

  test('a device released 15s ago (quietPeriodSec: 10) does NOT block — the job is claimed immediately', () => {
    const jobStore = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const now = Math.floor(Date.now() / 1000)
    const waitingEvents: unknown[] = []
    const scheduler = createScheduler(
      baseDeps({
        jobStore,
        onDeviceBusy: () => {},
        quiet: {
          quietPeriodSec: () => 10,
          maxWaitSec: () => 120,
          lastManualReleaseAt: () => now - 15,
          lastManualHolder: () => null,
        },
        onJobWaiting: (info) => waitingEvents.push(info),
      }),
    )

    scheduler.kick()

    expect(waitingEvents).toHaveLength(0)
    // claimNext was called with an EMPTY exclude list (nothing blocked) and actually claimed the job.
    const calls = (jobStore as unknown as { claimedCalls: string[][] }).claimedCalls
    expect(calls.some((ex) => ex.length === 0)).toBe(true)
  })

  test('a device that has never had a manual lease is never blocked (lastManualReleaseAt: null)', () => {
    const jobStore = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const waitingEvents: unknown[] = []
    const scheduler = createScheduler(
      baseDeps({
        jobStore,
        quiet: {
          quietPeriodSec: () => 10,
          maxWaitSec: () => 120,
          lastManualReleaseAt: () => null,
          lastManualHolder: () => null,
        },
        onJobWaiting: (info) => waitingEvents.push(info),
      }),
    )
    scheduler.kick()
    expect(waitingEvents).toHaveLength(0)
  })

  test('the maxWaitSec cap forces the job to proceed even though the device is still within its quiet period (criterion 12: never waits past the cap)', () => {
    const jobStore = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const now = Math.floor(Date.now() / 1000)
    const scheduler = createScheduler(
      baseDeps({
        jobStore,
        quiet: {
          quietPeriodSec: () => 999, // never satisfied within any reasonable test run
          maxWaitSec: () => 0, // ...but the cap is zero, so the FIRST tick already exceeds it
          lastManualReleaseAt: () => now - 1,
          lastManualHolder: () => null,
        },
        onJobWaiting: () => {},
      }),
    )

    scheduler.kick()

    // The job proceeds — claimed despite the quiet period never being satisfied.
    const calls = (jobStore as unknown as { claimedCalls: string[][] }).claimedCalls
    expect(calls.some((ex) => ex.length === 0)).toBe(true)
  })

  test('a job is never silently dropped by the quiet gate — it keeps its place and is claimed the moment it stops being blocked', () => {
    let releasedAt: number | null = Math.floor(Date.now() / 1000) // "just released" — blocks
    const jobStore = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const scheduler = createScheduler(
      baseDeps({
        jobStore,
        quiet: {
          quietPeriodSec: () => 10,
          maxWaitSec: () => 120,
          lastManualReleaseAt: () => releasedAt,
          lastManualHolder: () => null,
        },
        onJobWaiting: () => {},
      }),
    )

    scheduler.kick() // blocked — not claimed
    expect((jobStore as unknown as { claimedCalls: string[][] }).claimedCalls.at(-1)).toEqual(['d1'])

    // Time passes — the device has now been quiet long enough.
    releasedAt = Math.floor(Date.now() / 1000) - 20
    scheduler.kick()
    expect((jobStore as unknown as { claimedCalls: string[][] }).claimedCalls.at(-1)).toEqual([])
  })

  test('without a `quiet` dependency at all, behaviour is unchanged — nothing is ever blocked (a host that predates this plan)', () => {
    const jobStore = fakeJobStore({ queuedDeviceIds: ['d1'] })
    const scheduler = createScheduler(baseDeps({ jobStore })) // no `quiet` key
    scheduler.kick()
    const calls = (jobStore as unknown as { claimedCalls: string[][] }).claimedCalls
    expect(calls.some((ex) => ex.length === 0)).toBe(true)
  })
})
