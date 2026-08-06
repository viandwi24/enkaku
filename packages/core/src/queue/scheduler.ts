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
  /** The wait is visible (plan 71 §3.7, criterion 11) — broadcast while it is in progress, and once more with `waiting: false` the moment it ends (claimed, or nothing left to wait for). */
  onJobWaiting?: (info: { jobId: string; deviceId: string; waiting: boolean; heldBy: LeaseHolder | null; remainingSec: number }) => void
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
  // The device ids reported as "waiting" on the PREVIOUS tick — used only to
  // send one final `waiting: false` the moment a device stops waiting,
  // rather than only the (silent) fact that no more `job.waiting` events
  // arrive.
  let previouslyWaiting = new Set<string>()

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

  function broadcastWaiting(blocked: Map<string, number>): void {
    if (!deps.onJobWaiting || !deps.quiet) return
    const stillWaiting = new Set<string>()
    for (const [deviceId, remainingSec] of blocked) {
      const jobId = deps.jobStore.nextQueuedJobId(deviceId)
      if (!jobId) continue
      stillWaiting.add(deviceId)
      deps.onJobWaiting({ jobId, deviceId, waiting: true, heldBy: deps.quiet.lastManualHolder(deviceId), remainingSec })
    }
    for (const deviceId of previouslyWaiting) {
      if (stillWaiting.has(deviceId)) continue
      const jobId = deps.jobStore.nextQueuedJobId(deviceId)
      if (jobId) deps.onJobWaiting({ jobId, deviceId, waiting: false, heldBy: null, remainingSec: 0 })
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
        const blocked = computeQuietBlocked()
        broadcastWaiting(blocked)
        for (;;) {
          let claimed
          try {
            claimed = deps.jobStore.claimNext(deps.jobTtlSec, [...blocked.keys()])
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
