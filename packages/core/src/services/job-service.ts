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

/** One code path for both REST and WS (plan 04 §4.7). */
export function createJobService(deps: {
  jobStore: JobStore
  registry: ExecutorRegistry
  scheduler: Scheduler
  host: ExecutorHost
  log: Logger
  onJobStatus: (info: JobInfo) => void
  /** Check the `scripts` table for a non-built-in scriptId (M4). */
  findScript?: (scriptId: string) => { enabled: boolean } | null
}): JobService {
  return {
    enqueue(input) {
      if (!deps.registry.isBuiltIn(input.scriptId)) {
        const script = deps.findScript?.(input.scriptId) ?? null
        if (!script) throw new EnkakuError('unknown_script', `unknown script: ${input.scriptId}`)
        if (!script.enabled) throw new EnkakuError('script_disabled', `the script ${input.scriptId} is disabled`)
      }
      const executor = deps.registry.get(input.scriptId)
      if (!executor) throw new EnkakuError('unknown_script', `unknown script: ${input.scriptId}`)
      const params = executor.validateParams(input.params)
      const row = deps.jobStore.enqueue({
        scriptId: input.scriptId,
        deviceId: input.deviceId,
        params,
        priority: input.priority ?? 0,
      })
      const info = rowToJobInfo(row, deps.jobStore.scriptNames([row.scriptId]).get(row.scriptId) ?? null)
      deps.onJobStatus(info)
      deps.scheduler.kick()
      return info
    },

    cancel(jobId) {
      const job = deps.jobStore.get(jobId)
      if (!job) throw new EnkakuError('job_not_found', `no such job: ${jobId}`)
      if (job.status === 'queued') {
        const cancelled = deps.jobStore.cancelQueued(jobId)
        if (!cancelled) throw new EnkakuError('job_not_cancellable', 'the job changed status first')
        const info = rowToJobInfo(cancelled)
        deps.onJobStatus(info)
        return info
      }
      if (job.status === 'running') {
        if (!deps.host.abort(jobId)) {
          // No live executor (after a restart, say) → close it immediately.
          deps.host.finishExternally(jobId, 'cancelled', 'cancelled (no executor was running)')
        }
        return rowToJobInfo(deps.jobStore.get(jobId) ?? job)
      }
      throw new EnkakuError('job_not_cancellable', `the job is ${job.status}`)
    },

    get(jobId) {
      const row = deps.jobStore.get(jobId)
      if (!row) return null
      return rowToJobInfo(row, deps.jobStore.scriptNames([row.scriptId]).get(row.scriptId) ?? null)
    },

    list(filter) {
      const { rows, total } = deps.jobStore.list({
        deviceId: filter.deviceId,
        status: filter.status,
        limit: filter.limit ?? 50,
        offset: filter.offset ?? 0,
      })
      const names = deps.jobStore.scriptNames(rows.map((r) => r.scriptId))
      return { jobs: rows.map((r) => rowToJobInfo(r, names.get(r.scriptId) ?? null)), total }
    },
  }
}
