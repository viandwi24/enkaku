import type { JobInfo } from '@enkaku/protocol'
import type { JobRow } from '../db/schema'
import type { Logger } from '../util/logger'
import { rowToJobInfo, type JobStore } from './job-store'

export interface ExpiryReaper {
  start(): void
  stop(): void
  /** Runs the sweep once, immediately — used by tests and by `start()`'s first tick. */
  sweepOnce(): JobRow[]
}

/**
 * The expiry reaper (plan 21 §4.3): a `queued` job past its `expiresAt`
 * becomes `expired` instead of waiting forever. Since plan 205 §4.7 it also
 * sweeps the job heartbeat: a `running` job whose `heartbeatExpiresAt` has
 * passed is finished externally with `HEARTBEAT_EXPIRED` — the lease manager
 * that used to run this sweep on its own interval is deleted, and this is
 * the one reaper left standing (spec §10.2, plan 21 §4.3).
 */
export function createExpiryReaper(deps: {
  jobStore: JobStore
  intervalMs: number
  log: Logger
  onJobStatus: (info: JobInfo) => void
  /**
   * A batch member job expired → recompute the batch's cached status (plan
   * 20 §4.5, plan 21 §4.3). `deviceId` (plan 94 §3.8, §4.8, step 94.7) is
   * always passed here — an expired repetition never ran, but it is still
   * settled from the pacer's point of view (`BatchPacer.onMemberSettled`):
   * a device that cannot be reached should not permanently stall the rest
   * of its schedule.
   */
  onBatchChanged: (batchId: string, deviceId?: string) => void
  /**
   * A running job's heartbeat expired (plan 205 §4.7) — wired to
   * `host.finishExternally(jobId, 'failed', reason, 'HEARTBEAT_EXPIRED')` in
   * `daemon.ts`, exactly as the deleted lease manager's own reaper did.
   */
  onHeartbeatExpired: (jobId: string) => void
  /**
   * Expires overdue agent approvals on this SAME cadence (plan 66 §4.3:
   * "a sweeper expires overdue approvals on the same timer the job reaper
   * uses rather than adding a second scheduler"). Optional so every
   * existing caller/test that predates Plan 66 keeps compiling unchanged.
   */
  sweepApprovals?: () => void
}): ExpiryReaper {
  let timer: ReturnType<typeof setInterval> | null = null

  function sweepOnce(): JobRow[] {
    deps.sweepApprovals?.()
    const expired = deps.jobStore.expireQueued()
    for (const row of expired) {
      deps.log.warn(`job ${row.id} expired: queue timeout (device ${row.deviceId})`)
      deps.onJobStatus(rowToJobInfo(row))
      if (row.batchId) deps.onBatchChanged(row.batchId, row.deviceId)
    }
    for (const row of deps.jobStore.expiredRunning()) {
      deps.log.warn(`job ${row.id} heartbeat expired (device ${row.deviceId})`)
      deps.onHeartbeatExpired(row.id)
    }
    return expired
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void sweepOnce(), deps.intervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    sweepOnce,
  }
}
