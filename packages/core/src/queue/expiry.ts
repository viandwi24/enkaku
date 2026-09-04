import type { JobInfo } from '@enkaku/protocol'
import type { JobRunRow } from '../db/schema'
import type { Logger } from '../util/logger'
import { rowToJobInfo, type JobStore } from './job-store'

export interface ExpiryReaper {
  start(): void
  stop(): void
  /** Runs the sweep once, immediately — used by tests and by `start()`'s first tick. */
  sweepOnce(): JobRunRow[]
}

/**
 * The expiry reaper (plan 21 §4.3, re-keyed to runs by plan 211): a `queued`
 * RUN past its `expiresAt` becomes `expired` instead of waiting forever. A
 * `running` run whose `heartbeatExpiresAt` has passed is finished externally
 * with `HEARTBEAT_EXPIRED` (spec §10.2, plan 21 §4.3).
 */
export function createExpiryReaper(deps: {
  jobStore: JobStore
  intervalMs: number
  log: Logger
  onJobStatus: (info: JobInfo) => void
  /** A batch member run expired → recompute the batch's cached status (plan 20 §4.5, plan 21 §4.3). */
  onBatchChanged: (batchId: string, deviceId?: string) => void
  /** A running run's heartbeat expired (plan 205 §4.7) — wired to `host.finishExternally(runId, 'failed', reason, 'HEARTBEAT_EXPIRED')` in `daemon.ts`. */
  onHeartbeatExpired: (runId: string) => void
  /** Expires overdue agent approvals on this SAME cadence (plan 66 §4.3). */
  sweepApprovals?: () => void
}): ExpiryReaper {
  let timer: ReturnType<typeof setInterval> | null = null

  function sweepOnce(): JobRunRow[] {
    deps.sweepApprovals?.()
    const expired = deps.jobStore.expireQueued()
    for (const run of expired) {
      deps.log.warn(`run ${run.id} expired: queue timeout (device ${run.deviceId})`)
      const job = deps.jobStore.get(run.jobId)
      if (job) {
        deps.onJobStatus(rowToJobInfo(job, run))
        if (job.batchId) deps.onBatchChanged(job.batchId, run.deviceId)
      }
    }
    for (const run of deps.jobStore.expiredRunning()) {
      deps.log.warn(`run ${run.id} heartbeat expired (device ${run.deviceId})`)
      deps.onHeartbeatExpired(run.id)
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
