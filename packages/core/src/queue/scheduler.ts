import { rowToJobInfo, type JobStore } from './job-store'
import type { ExecutorHost } from '../jobs/executor-host'
import type { ActivityRegistry } from '../activity/registry'
import type { DeviceActivity, JobInfo } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

export interface Scheduler {
  /** Idempotent and coalescing — safe to call from anywhere. */
  kick(): void
  start(): void
  stop(): void
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** The job-over-fresh-control wait's own cap (plan 205 §3.2 item 6, MVP 12 §3): a constant, not a setting. */
export const MAX_CONTROL_WAIT_SEC = 60

export interface SchedulerDeps {
  jobStore: JobStore
  host: ExecutorHost
  log: Logger
  jobTtlSec: number
  fallbackIntervalMs: number
  onJobStatus: (info: JobInfo) => void
  /** The claim starts a `job:<id>` activity inside a SQL transaction; notify watchers (closeIfIdle, readiness reconcile — plan 205 §4.7 renames this from onDeviceBusy since devices.status is never flipped to "busy" any more). */
  onJobClaimed: (deviceId: string) => void
  /** Main-stream device event: job.started (plan 18 §4.2). */
  onJobStarted?: (deviceId: string, jobId: string, scriptId: string) => void
  /**
   * A queued job waits while a `control` marker is live on its device (plan
   * 205 §3.2 item 6, MVP 12 §3) instead of interrupting whatever a person is
   * mid-gesture on — the renamed and reworked "quiet gate" (plan 71 §3.7).
   * Read fresh on every loop tick.
   */
  activities: Pick<ActivityRegistry, 'liveControls' | 'devicesWith' | 'start'>
  /**
   * The wait is visible (plan 71 §3.7, criterion 11; plan 94 §3.8, §4.8,
   * step 94.6 adds the `reason: 'paced'` case alongside it) — broadcast
   * while it is in progress, and once more with `waiting: false` the
   * moment it ends (claimed, or nothing left to wait for). `conflicting` is
   * only ever non-null for `reason: 'control'`.
   */
  onJobWaiting?: (info: {
    jobId: string
    deviceId: string
    waiting: boolean
    reason: 'control' | 'paced'
    conflicting: DeviceActivity | null
    remainingSec: number
  }) => void
}

/**
 * An event-driven scheduler with a fallback interval (plan 04 §4.4). One loop
 * only (the core is single-process): if the loop is already running, a kick just
 * sets a dirty flag. The per-device constraint falls out of the SQL claim
 * (d.status='online' plus a NOT EXISTS running-job guard, plan 205 §4.7).
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  let looping = false
  let dirty = false
  let timer: ReturnType<typeof setInterval> | null = null

  // Plan 71 §3.7, reworked by plan 205 §3.2 item 6 — the FIRST time a device
  // was observed blocked by a live control marker, per device (not per job):
  // `MAX_CONTROL_WAIT_SEC` is measured from here, and a brief re-touch that
  // refreshes the marker does NOT reset this clock, so a device that keeps
  // getting briefly touched still cannot make a job wait past the cap.
  // In-memory only: a core restart starts the cap over.
  const waitStartedAt = new Map<string, number>()
  // The device ids reported as "waiting" on the PREVIOUS tick, with which
  // reason — used only to send one final `waiting: false` (carrying that
  // same reason; the schema requires one) the moment a device stops
  // waiting, rather than only the (silent) fact that no more `job.waiting`
  // events arrive.
  let previouslyWaiting = new Map<string, 'control' | 'paced'>()

  /**
   * Every device with a queued job that a live control marker currently
   * blocks, plus how long is left — never longer than `MAX_CONTROL_WAIT_SEC`
   * (plan 71 §3.7, criterion 12, reworked by plan 205 §4.7). Devices past
   * their cap are NOT returned (they may proceed) and their wait
   * bookkeeping is cleared.
   *
   * `exclude` is the full set passed to `claimNext`'s exclusion list — it
   * also carries every device with a live `install` activity (policy row
   * "job over install = forbid"), which `waiting` deliberately omits: those
   * are excluded from claiming silently, never reported as waiting (an
   * install has no "go quiet and let the job through" ending to wait for).
   */
  function computeControlBlocked(): { waiting: Map<string, number>; exclude: Map<string, number> } {
    const waiting = new Map<string, number>()
    const now = nowSec()
    const queuedDeviceIds = deps.jobStore.queuedDeviceIds()
    for (const deviceId of queuedDeviceIds) {
      const live = deps.activities.liveControls(deviceId)
      if (live.length === 0) {
        waitStartedAt.delete(deviceId)
        continue
      }
      let startedAt = waitStartedAt.get(deviceId)
      if (startedAt === undefined) {
        startedAt = now
        waitStartedAt.set(deviceId, startedAt)
      }
      const waitedSoFar = now - startedAt
      if (waitedSoFar >= MAX_CONTROL_WAIT_SEC) {
        // The cap expired — the job proceeds; it is never dropped, only no
        // longer made to wait (plan 71 §3.7, criterion 12).
        waitStartedAt.delete(deviceId)
        continue
      }
      waiting.set(deviceId, Math.max(0, MAX_CONTROL_WAIT_SEC - waitedSoFar))
    }
    const exclude = new Map(waiting)
    for (const deviceId of deps.activities.devicesWith('install')) {
      if (!exclude.has(deviceId)) exclude.set(deviceId, 0)
    }
    return { waiting, exclude }
  }

  /**
   * Plan 94 §3.8, §4.8, step 94.6 — every device whose next-up queued job
   * (same `nextQueuedJobId` ordering `broadcastWaiting` already uses for
   * the control gate) is not yet due: `jobs.not_before` in the future. Purely
   * informational — unlike the control gate, a paced job does NOT get
   * excluded from `claimNext` device-wide (its own SQL predicate skips only
   * that row; a different, already-due job on the same device stays
   * claimable), so this never feeds `excludeDeviceIds`. Devices whose
   * `notBefore` has already passed are not returned, matching
   * `computeControlBlocked`'s own "past its cap" convention.
   */
  function computePacedBlocked(): Map<string, { jobId: string; remainingSec: number }> {
    const blocked = new Map<string, { jobId: string; remainingSec: number }>()
    if (!deps.onJobWaiting) return blocked
    const now = nowSec()
    for (const deviceId of deps.jobStore.queuedDeviceIds()) {
      const jobId = deps.jobStore.nextQueuedJobId(deviceId)
      if (!jobId) continue
      const job = deps.jobStore.get(jobId)
      if (!job || job.notBefore == null) continue
      const remainingSec = job.notBefore - now
      if (remainingSec <= 0) continue
      blocked.set(deviceId, { jobId, remainingSec })
    }
    return blocked
  }

  function broadcastWaiting(controlBlocked: Map<string, number>, pacedBlocked: Map<string, { jobId: string; remainingSec: number }>): void {
    if (!deps.onJobWaiting) return
    const stillWaiting = new Map<string, 'control' | 'paced'>()
    for (const [deviceId, remainingSec] of controlBlocked) {
      const jobId = deps.jobStore.nextQueuedJobId(deviceId)
      if (!jobId) continue
      stillWaiting.set(deviceId, 'control')
      deps.onJobWaiting({
        jobId,
        deviceId,
        waiting: true,
        reason: 'control',
        conflicting: deps.activities.liveControls(deviceId)[0] ?? null,
        remainingSec,
      })
    }
    for (const [deviceId, paced] of pacedBlocked) {
      // The control gate already reported this device this tick — a device
      // controlled AND paced is rare, but the control gate is what is
      // actually excluding it from claimNext right now (see
      // `computePacedBlocked`'s own comment: pacing is per-row, never
      // device-wide), so it, not pacing, is the reason worth surfacing.
      if (stillWaiting.has(deviceId)) continue
      stillWaiting.set(deviceId, 'paced')
      deps.onJobWaiting({ jobId: paced.jobId, deviceId, waiting: true, reason: 'paced', conflicting: null, remainingSec: paced.remainingSec })
    }
    for (const [deviceId, reason] of previouslyWaiting) {
      if (stillWaiting.has(deviceId)) continue
      const jobId = deps.jobStore.nextQueuedJobId(deviceId)
      if (jobId) deps.onJobWaiting({ jobId, deviceId, waiting: false, reason, conflicting: null, remainingSec: 0 })
    }
    previouslyWaiting = stillWaiting
  }

  async function loop(): Promise<void> {
    if (looping) {
      dirty = true
      return
    }
    looping = true
    try {
      do {
        dirty = false
        const { waiting: controlWaiting, exclude: controlExclude } = computeControlBlocked()
        const pacedBlocked = computePacedBlocked()
        broadcastWaiting(controlWaiting, pacedBlocked)
        for (;;) {
          let claimed
          try {
            // Only the control gate excludes a device wholesale — pacing is
            // per-row and already enforced inside claimNext's own SQL
            // predicate (`computePacedBlocked`'s own comment).
            claimed = deps.jobStore.claimNext(deps.jobTtlSec, [...controlExclude.keys()])
          } catch (err) {
            deps.log.warn(`job claim failed: ${String(err)}`)
            break
          }
          if (!claimed) break
          waitStartedAt.delete(claimed.deviceId)
          deps.log.info(`job claimed: ${claimed.job.id} → device ${claimed.deviceId}`)
          const names = deps.jobStore.scriptNames([claimed.job.scriptId])
          const scriptName = claimed.job.scriptName ?? names.get(claimed.job.scriptId)?.name ?? claimed.job.scriptId
          deps.activities.start(claimed.deviceId, {
            id: `job:${claimed.job.id}`,
            kind: 'job',
            label: `Running ${scriptName}`,
            actor: { kind: 'system', id: 'core', label: 'Scheduler' },
            href: `/jobs/detail?id=${claimed.job.id}`,
          })
          deps.onJobClaimed(claimed.deviceId)
          deps.onJobStatus(rowToJobInfo(claimed.job))
          deps.onJobStarted?.(claimed.deviceId, claimed.job.id, claimed.job.scriptId)
          deps.host.start(claimed.job)
        }
      } while (dirty)
    } finally {
      looping = false
    }
  }

  return {
    kick() {
      void loop()
    },
    start() {
      if (timer) return
      timer = setInterval(() => void loop(), deps.fallbackIntervalMs)
      void loop()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
