import type { JobDetail, JobInfo, JobStatus } from '@enkaku/protocol'
import { canUseDevice } from '../auth/acl'
import type { Role } from '../auth/service'
import type { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { rowToJobDetail, rowToJobInfo, type JobCursor, type JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { validateScriptForRun } from '../jobs/validate-script'

export interface JobService {
  enqueue(input: {
    scriptId: string
    deviceId: string
    params: unknown
    priority?: number
    /**
     * `canUseDevice` (plan 34 §3.5, §4.4) — the caller acting on this device;
     * undefined means "no ownership check" (a test harness, or a host that
     * has not wired auth). Both `POST /api/jobs` and the `job.enqueue` WS
     * message pass this through the SAME choke point rather than duplicating
     * the check at each call site.
     */
    actor?: { id: string; role: Role } | null
  }): JobInfo
  cancel(jobId: string): JobInfo
  /**
   * One job, in full (plan 60 §4.3) — including `result`, the script's own
   * return value. `list` deliberately does not: a result can be large, and
   * fifty of them is not what a list is for.
   */
  get(jobId: string): JobDetail | null
  list(filter: { deviceId?: string; status?: JobStatus; limit?: number; cursor?: JobCursor | null }): {
    jobs: JobInfo[]
    nextCursor: JobCursor | null
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
  /** A batch member job was cancelled while still queued — recompute the batch (plan 20 §4.5). */
  onBatchChanged?: (batchId: string) => void
  /**
   * `canUseDevice`'s device half (plan 34 §3.5, §4.4) — a lookup, not the
   * whole `devices` row, so a caller with no interest in ACL (a test, or a
   * host that has not wired auth) can simply omit it. Undefined means "no
   * ownership check", same as `input.actor` being undefined.
   */
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
}): JobService {
  return {
    enqueue(input) {
      if (input.actor) {
        const device = deps.getDeviceOwner?.(input.deviceId)
        if (device && !canUseDevice(input.actor, device)) {
          throw new EnkakuError('auth.forbidden', 'this device belongs to another user')
        }
      }
      const params = validateScriptForRun(deps, input.scriptId, input.params)
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
        if (cancelled.batchId) deps.onBatchChanged?.(cancelled.batchId)
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
      return rowToJobDetail(row, deps.jobStore.scriptNames([row.scriptId]).get(row.scriptId) ?? null)
    },

    list(filter) {
      const { rows, nextCursor, total } = deps.jobStore.list({
        deviceId: filter.deviceId,
        status: filter.status,
        limit: filter.limit ?? 50,
        cursor: filter.cursor,
      })
      const names = deps.jobStore.scriptNames(rows.map((r) => r.scriptId))
      return { jobs: rows.map((r) => rowToJobInfo(r, names.get(r.scriptId) ?? null)), nextCursor, total }
    },
  }
}
