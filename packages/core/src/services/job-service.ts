import type { JobInfo, JobStatus } from '@enkaku/protocol'
import type { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { rowToJobInfo, type JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

export interface JobService {
  enqueue(input: { scriptId: string; deviceId: string; params: unknown; priority?: number }): JobInfo
  cancel(jobId: string): JobInfo
  get(jobId: string): JobInfo | null
  list(filter: { deviceId?: string; status?: JobStatus; limit?: number; offset?: number }): {
    jobs: JobInfo[]
    total: number
  }
}

/** Satu jalur kode untuk REST & WS (plan 04 §4.7). */
export function createJobService(deps: {
  jobStore: JobStore
  registry: ExecutorRegistry
  scheduler: Scheduler
  host: ExecutorHost
  log: Logger
  onJobStatus: (info: JobInfo) => void
}): JobService {
  return {
    enqueue(input) {
      const executor = deps.registry.get(input.scriptId)
      if (!executor) throw new EnkakuError('unknown_script', `script tidak dikenal: ${input.scriptId}`)
      const params = executor.validateParams(input.params)
      const row = deps.jobStore.enqueue({
        scriptId: input.scriptId,
        deviceId: input.deviceId,
        params,
        priority: input.priority ?? 0,
      })
      const info = rowToJobInfo(row)
      deps.onJobStatus(info)
      deps.scheduler.kick()
      return info
    },

    cancel(jobId) {
      const job = deps.jobStore.get(jobId)
      if (!job) throw new EnkakuError('job_not_found', `job tidak ada: ${jobId}`)
      if (job.status === 'queued') {
        const cancelled = deps.jobStore.cancelQueued(jobId)
        if (!cancelled) throw new EnkakuError('job_not_cancellable', 'job keburu berubah status')
        const info = rowToJobInfo(cancelled)
        deps.onJobStatus(info)
        return info
      }
      if (job.status === 'running') {
        if (!deps.host.abort(jobId)) {
          // Tidak ada executor hidup (mis. setelah restart) → tutup langsung.
          deps.host.finishExternally(jobId, 'cancelled', 'dibatalkan (executor tidak aktif)')
        }
        return rowToJobInfo(deps.jobStore.get(jobId) ?? job)
      }
      throw new EnkakuError('job_not_cancellable', `job berstatus ${job.status}`)
    },

    get(jobId) {
      const row = deps.jobStore.get(jobId)
      return row ? rowToJobInfo(row) : null
    },

    list(filter) {
      const { rows, total } = deps.jobStore.list({
        deviceId: filter.deviceId,
        status: filter.status,
        limit: filter.limit ?? 50,
        offset: filter.offset ?? 0,
      })
      return { jobs: rows.map(rowToJobInfo), total }
    },
  }
}
