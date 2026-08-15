import { rowToJobInfo, type JobStore } from './job-store'
import type { ExecutorHost } from '../jobs/executor-host'
import type { JobInfo, LeaseHolder } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

export interface Scheduler {
  /** Idempotent and coalescing — safe to call from anywhere. */
  kick(): void
  start(): void
  stop(): void
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

export interface SchedulerDeps {
  jobStore: JobStore
  host: ExecutorHost
  log: Logger
  jobTtlSec: number
  fallbackIntervalMs: number
  onJobStatus: (info: JobInfo) => void
  /** The claim flips the device to busy inside a SQL transaction; notify watchers. */
  onDeviceBusy: (deviceId: string) => void
  /** Main-stream device event: job.started (plan 18 §4.2). */
  onJobStarted?: (deviceId: string, jobId: string, scriptId: string) => void
  /**
   * A job waits for its target device to go quiet before claiming it (plan
   * 71 §3.7) instead of interrupting whatever a person is mid-gesture on.
   * Both settings are read fresh on every loop tick, the same pattern every
   * other settings-derived accessor in `daemon.ts` uses.
   */
  quiet?: {
    quietPeriodSec: () => number
    maxWaitSec: () => number
    lastManualReleaseAt: (deviceId: string) => number | null
    lastManualHolder: (deviceId: string) => LeaseHolder | null
  }
  /**
   * The wait is visible (plan 71 §3.7, criterion 11; plan 94 §3.8, §4.8,
   * step 94.6 adds the `reason: 'paced'` case alongside it) — broadcast
   * while it is in progress, and once more with `waiting: false` the
   * moment it ends (claimed, or nothing left to wait for). `heldBy` is
   * only ever non-null for `reason: 'quiet'`.
   */
  onJobWaiting?: (info: {
    jobId: string
    deviceId: string
    waiting: boolean
    reason: 'quiet' | 'paced'
    heldBy: LeaseHolder | null
    remainingSec: number
  }) => void
}

/**
 * An event-driven scheduler with a fallback interval (plan 04 §4.4). One loop
 * only (the core is single-process): if the loop is already running, a kick just
 * sets a dirty flag. The per-device constraint falls out of the SQL claim
 * (d.status='idle').
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  let looping = false
  let dirty = false
  let timer: ReturnType<typeof setInterval> | null = null

  // Plan 71 §3.7 — the FIRST time a device was observed blocked by the quiet
  // gate, per device (not per job): the `maxWaitSec` cap is measured from
  // here, and — unlike `lastManualReleaseAt` — a brief manual reacquire that
  // resets the QUIET gap does NOT reset this clock, so a device that keeps
  // getting briefly touched still cannot make a job wait past the cap.
  // In-memory only: a core restart starts the cap over, the same accepted
  // simplification `agent/loop/run.ts`'s per-run lease bookkeeping makes.
  const waitStartedAt = new Map<string, number>()
  // The device ids reported as "waiting" on the PREVIOUS tick, with which
  // reason — used only to send one final `waiting: false` (carrying that
  // same reason; the schema requires one) the moment a device stops
  // waiting, rather than only the (silent) fact that no more `job.waiting`
  // events arrive.
  let previouslyWaiting = new Map<string, 'quiet' | 'paced'>()

  /** Every device with a queued job that the quiet gate currently blocks, plus how long is left — never longer than `maxWaitSec` (plan 71 §3.7, criterion 12). Devices past their cap are NOT returned (they may proceed) and their wait bookkeeping is cleared. */
  function computeQuietBlocked(): Map<string, number> {
    const blocked = new Map<string, number>()
    if (!deps.quiet) return blocked
    const { quietPeriodSec, maxWaitSec, lastManualReleaseAt } = deps.quiet
    const quietSec = quietPeriodSec()
    const capSec = maxWaitSec()
    const now = nowSec()
    for (const deviceId of deps.jobStore.queuedDeviceIds()) {
      const releasedAt = lastManualReleaseAt(deviceId)
      if (releasedAt === null) {
        waitStartedAt.delete(deviceId)
        continue // never manually held — nothing to be quiet about
      }
      const sinceRelease = now - releasedAt
      if (sinceRelease >= quietSec) {
        waitStartedAt.delete(deviceId)
        continue // already quiet long enough
      }
      let startedAt = waitStartedAt.get(deviceId)
      if (startedAt === undefined) {
        startedAt = now
        waitStartedAt.set(deviceId, startedAt)
      }
      const waitedSoFar = now - startedAt
      if (waitedSoFar >= capSec) {
        // The cap expired — the job proceeds; it is never dropped, only no
        // longer made to wait (plan 71 §3.7, criterion 12).
        waitStartedAt.delete(deviceId)
        continue
      }
      blocked.set(deviceId, Math.max(0, Math.min(quietSec - sinceRelease, capSec - waitedSoFar)))
    }
    return blocked
  }

  /**
   * Plan 94 §3.8, §4.8, step 94.6 — every device whose next-up queued job
   * (same `nextQueuedJobId` ordering `broadcastWaiting` already uses for
   * the quiet gate) is not yet due: `jobs.not_before` in the future. Purely
   * informational — unlike the quiet gate, a paced job does NOT get
   * excluded from `claimNext` device-wide (its own SQL predicate skips only
   * that row; a different, already-due job on the same device stays
   * claimable), so this never feeds `excludeDeviceIds`. Devices whose
   * `notBefore` has already passed are not returned, matching
   * `computeQuietBlocked`'s own "past its cap" convention.
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

  function broadcastWaiting(quietBlocked: Map<string, number>, pacedBlocked: Map<string, { jobId: string; remainingSec: number }>): void {
    if (!deps.onJobWaiting) return
    const stillWaiting = new Map<string, 'quiet' | 'paced'>()
    for (const [deviceId, remainingSec] of quietBlocked) {
      const jobId = deps.jobStore.nextQueuedJobId(deviceId)
      if (!jobId) continue
      stillWaiting.set(deviceId, 'quiet')
      deps.onJobWaiting({
        jobId,
        deviceId,
        waiting: true,
        reason: 'quiet',
        heldBy: deps.quiet ? deps.quiet.lastManualHolder(deviceId) : null,
        remainingSec,
      })
    }
    for (const [deviceId, paced] of pacedBlocked) {
      // The quiet gate already reported this device this tick — a device
      // manually held AND paced is rare, but the quiet gate is what is
      // actually excluding it from claimNext right now (see
      // `computePacedBlocked`'s own comment: pacing is per-row, never
      // device-wide), so it, not pacing, is the reason worth surfacing.
      if (stillWaiting.has(deviceId)) continue
      stillWaiting.set(deviceId, 'paced')
      deps.onJobWaiting({ jobId: paced.jobId, deviceId, waiting: true, reason: 'paced', heldBy: null, remainingSec: paced.remainingSec })
    }
    for (const [deviceId, reason] of previouslyWaiting) {
      if (stillWaiting.has(deviceId)) continue
      const jobId = deps.jobStore.nextQueuedJobId(deviceId)
      if (jobId) deps.onJobWaiting({ jobId, deviceId, waiting: false, reason, heldBy: null, remainingSec: 0 })
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
        const quietBlocked = computeQuietBlocked()
        const pacedBlocked = computePacedBlocked()
        broadcastWaiting(quietBlocked, pacedBlocked)
        for (;;) {
          let claimed
          try {
            // Only the quiet gate excludes a device wholesale — pacing is
            // per-row and already enforced inside claimNext's own SQL
            // predicate (`computePacedBlocked`'s own comment).
            claimed = deps.jobStore.claimNext(deps.jobTtlSec, [...quietBlocked.keys()])
          } catch (err) {
            deps.log.warn(`job claim failed: ${String(err)}`)
            break
          }
          if (!claimed) break
          waitStartedAt.delete(claimed.deviceId)
          deps.log.info(`job claimed: ${claimed.job.id} → device ${claimed.deviceId}`)
          deps.onDeviceBusy(claimed.deviceId)
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
