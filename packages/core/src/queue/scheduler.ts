import { rowToJobInfo, type JobStore } from './job-store'
import type { ExecutorHost } from '../jobs/executor-host'
import type { JobInfo } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

export interface Scheduler {
  /** Idempotent & coalescing — aman dipanggil dari mana saja. */
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
  /** Claim mengubah device → busy lewat SQL transaksi; beri tahu pengamat. */
  onDeviceBusy: (deviceId: string) => void
}

/**
 * Scheduler event-driven + fallback interval (plan 04 §4.4). Satu loop
 * saja (core single-process): kalau loop sedang jalan, kick cukup men-set
 * flag dirty. Constraint per-device implicit dari SQL claim (d.status='idle').
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
            deps.log.warn(`claim job gagal: ${String(err)}`)
            break
          }
          if (!claimed) break
          deps.log.info(`job di-claim: ${claimed.job.id} → device ${claimed.deviceId}`)
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
