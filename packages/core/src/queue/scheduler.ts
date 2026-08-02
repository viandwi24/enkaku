import { rowToJobInfo, type JobStore } from './job-store'
import type { ExecutorHost } from '../jobs/executor-host'
import type { JobInfo } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

export interface Scheduler {
  /** Idempotent and coalescing — safe to call from anywhere. */
  kick(): void
  start(): void
  stop(): void
}

export interface SchedulerDeps {
  jobStore: JobStore
  host: ExecutorHost
  log: Logger
  jobTtlSec: number
  fallbackIntervalMs: number
  onJobStatus: (info: JobInfo) => void
  /** The claim flips the device to busy inside a SQL transaction; notify watchers. */
  onDeviceBusy: (deviceId: string) => void
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

  async function loop(): Promise<void> {
    if (looping) {
      dirty = true
      return
    }
    looping = true
    try {
      do {
        dirty = false
        for (;;) {
          let claimed
          try {
            claimed = deps.jobStore.claimNext(deps.jobTtlSec)
          } catch (err) {
            deps.log.warn(`job claim failed: ${String(err)}`)
            break
          }
          if (!claimed) break
          deps.log.info(`job claimed: ${claimed.job.id} → device ${claimed.deviceId}`)
          deps.onDeviceBusy(claimed.deviceId)
          deps.onJobStatus(rowToJobInfo(claimed.job))
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
