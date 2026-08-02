import type { JobInfo } from '@enkaku/protocol'
import type { JobRow } from '../db/schema'
import type { DeviceStateMachine } from '../device/state-machine'
import type { LeaseManager } from '../lease/lease-manager'
import { rowToJobInfo, type JobStore } from '../queue/job-store'
import type { Logger } from '../util/logger'
import type { ExecutorRegistry } from './executor'

export interface ExecutorHostDeps {
  registry: ExecutorRegistry
  jobStore: JobStore
  states: DeviceStateMachine
  /** Lazy: LeaseManager and the host reference each other during wiring. */
  leases: () => LeaseManager
  log: Logger
  jobTtlSec: number
  heartbeatMs: number
  onJobStatus: (info: JobInfo) => void
  /** Kick scheduler setelah device bebas. */
  onFinished: () => void
  /** A batch member job reached a terminal state — recompute the batch's cached status (plan 20 §4.5). */
  onBatchChanged?: (batchId: string) => void
  /** Main-stream device event: job.finished (plan 18 §4.2). */
  onJobFinished?: (deviceId: string, jobId: string, status: string, durationMs: number) => void
}

export interface ExecutorHost {
  start(job: JobRow): void
  /** Abort a running executor (cancel or force-release). */
  abort(jobId: string): boolean
  isRunning(jobId: string): boolean
  finishExternally(jobId: string, status: 'failed' | 'cancelled', error: string): void
  stopAll(): void
}

const CANCEL_GRACE_MS = 5000

/**
 * Wraps every run: the lease heartbeat (spec §10.2), writing the final status,
 * releasing the device (JOB_FINISHED), broadcasting job.status, kicking the scheduler.
 */
export function createExecutorHost(deps: ExecutorHostDeps): ExecutorHost {
  const running = new Map<string, { controller: AbortController; heartbeat: ReturnType<typeof setInterval> }>()

  function settle(job: JobRow, status: 'success' | 'failed' | 'cancelled', data: { result?: unknown; error?: string }) {
    const entry = running.get(job.id)
    if (entry) {
      clearInterval(entry.heartbeat)
      running.delete(job.id)
    }
    const updated = deps.jobStore.finish(job.id, status, data)
    deps.leases().clearJobLease(job.deviceId)
    deps.states.apply(job.deviceId, 'JOB_FINISHED')
    if (updated) deps.onJobStatus(rowToJobInfo(updated))
    deps.log.info(`job ${job.id} finished: ${status}${data.error ? ` (${data.error})` : ''}`)
    const durationMs = job.startedAt ? Date.now() - job.startedAt.getTime() : 0
    deps.onJobFinished?.(job.deviceId, job.id, status, durationMs)
    if (job.batchId) deps.onBatchChanged?.(job.batchId)
    deps.onFinished()
  }

  return {
    start(job) {
      const executor = deps.registry.get(job.scriptId)
      if (!executor) {
        settle(job, 'failed', { error: `unknown_script: ${job.scriptId}` })
        return
      }
      const controller = new AbortController()
      const heartbeat = setInterval(() => {
        if (!deps.jobStore.renewLease(job.id, deps.jobTtlSec)) {
          deps.log.warn(`heartbeat for job ${job.id} failed (it is no longer running)`)
        }
      }, deps.heartbeatMs)
      running.set(job.id, { controller, heartbeat })
      deps.leases().noteJobLease(job.deviceId, job.id, deps.jobTtlSec)

      const ctx = {
        signal: controller.signal,
        heartbeat: () => void deps.jobStore.renewLease(job.id, deps.jobTtlSec),
        log: deps.log.child(`job:${job.id.slice(0, 8)}`),
      }

      executor
        .run(job, ctx)
        .then((result) => {
          if (!running.has(job.id)) return // already settled elsewhere (reaper or cancel)
          settle(job, 'success', { result })
        })
        .catch((err: unknown) => {
          if (!running.has(job.id)) return
          const message = err instanceof Error ? err.message : String(err)
          const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : null
          settle(job, code === 'job_cancelled' ? 'cancelled' : 'failed', { error: message })
        })
    },

    abort(jobId) {
      const entry = running.get(jobId)
      if (!entry) return false
      entry.controller.abort()
      // A stubborn executor (no settle within the grace period) → stop the
      // heartbeat and let the reaper expire its lease (an in-process M3 limit).
      setTimeout(() => {
        const still = running.get(jobId)
        if (still) {
          clearInterval(still.heartbeat)
          deps.log.warn(`job ${jobId} did not settle within ${CANCEL_GRACE_MS}ms — heartbeat stopped, waiting for the reaper`)
        }
      }, CANCEL_GRACE_MS)
      return true
    },

    isRunning(jobId) {
      return running.has(jobId)
    },

    finishExternally(jobId, status, error) {
      const job = deps.jobStore.get(jobId)
      if (!job) return
      const entry = running.get(jobId)
      entry?.controller.abort()
      settle(job, status, { error })
    },

    stopAll() {
      for (const [, entry] of running) {
        clearInterval(entry.heartbeat)
        entry.controller.abort()
      }
      running.clear()
    },
  }
}
