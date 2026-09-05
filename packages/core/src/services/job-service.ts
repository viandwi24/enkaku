import type { JobDetail, JobInfo, JobSettings, JobStatus, RuntimeClamp, RuntimeEnvelope, ShellMode } from '@enkaku/protocol'
import { checkRuntimeMajor, JobSettingsSchema, resolveRuntime, RuntimeEnvelopeSchema, unknownRuntimeKeys } from '@enkaku/protocol'
import { canUseDevice } from '../auth/acl'
import type { Role } from '../auth/service'
import type { JobRow, JobRunRow } from '../db/schema'
import type { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { rowToJobDetail, rowToJobInfo, type JobCursor, type JobStore } from '../queue/job-store'
import type { RunStore } from '../jobs/runs/store'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { validateScriptForRun } from '../jobs/validate-script'

const DEFAULT_FARM_JOB_SETTINGS: JobSettings = JobSettingsSchema.parse({})

function resolveJobRuntime(
  deps: { farmJobSettings?: () => JobSettings },
  scriptRuntime: RuntimeEnvelope | null,
  override: RuntimeEnvelope | null,
): { maxConcurrent: number; overrideClamps: RuntimeClamp[] } {
  const farm = deps.farmJobSettings?.() ?? DEFAULT_FARM_JOB_SETTINGS
  const { resolved, clamps } = resolveRuntime({ farm, script: scriptRuntime, override })
  return { maxConcurrent: resolved.maxConcurrent, overrideClamps: clamps.filter((c) => c.from === 'override') }
}

function assertRuntimeSupported(sdk: number | undefined): void {
  const result = checkRuntimeMajor(sdk)
  if (result) throw new EnkakuError(result.code, result.message)
}

function parseRuntimeOverrideInput(deps: { log: Logger }, raw: unknown, context: string): RuntimeEnvelope | null {
  const parsed = RuntimeEnvelopeSchema.nullable().safeParse(raw ?? null)
  if (!parsed.success) {
    throw new EnkakuError(
      'E_RUNTIME_ENVELOPE_INVALID',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    )
  }
  const unknown = unknownRuntimeKeys(raw)
  if (unknown.length > 0) {
    deps.log.warn(`${context}: unknown runtime override key(s) dropped: ${unknown.join(', ')}`)
  }
  return parsed.data
}

function overCeilingError(clamps: RuntimeClamp[]): EnkakuError {
  return new EnkakuError(
    'E_RUNTIME_OVER_CEILING',
    clamps.map((c) => `runtimeOverride.${c.field} (${c.requested}) exceeds the farm ceiling of ${c.ceiling}`).join('; '),
  )
}

export interface JobService {
  enqueue(input: {
    scriptId: string
    deviceId: string
    params: unknown
    priority?: number
    actor?: { id: string; role: Role } | null
    runtimeOverride?: unknown
  }): JobInfo
  /**
   * MVP 14 §2, §6 item 2, plan 211 §4.8 — adds a run to `jobId` when the
   * params (and device/kind) match the job, or creates a NEW job otherwise.
   * `sameJob` says which happened.
   */
  addRunOrNewJob(
    jobId: string,
    input: { deviceId: string; params: unknown; priority?: number; runtimeOverride?: unknown },
  ): { job: JobInfo; runId: string; sameJob: boolean }
  cancel(jobId: string, opts?: { cancelDescendants?: boolean }): { job: JobInfo; cancelledDescendants: number }
  /** Cancels a specific RUN directly — used by the workflow orchestrator to cancel its own step's run on abort (plan 211 §4.5). */
  cancelRun(runId: string): void
  /**
   * Enqueues one workflow step's script job and its first run
   * (`trigger: 'workflow-step'`), then kicks the scheduler (plan 211 §4.5).
   */
  enqueueStep(input: {
    parentWorkflowJobId: string
    stepSeq: number
    scriptId: string
    deviceId: string
    params: Record<string, unknown>
    scriptName: string
    scriptVersion: string
    priority: number
  }): { job: JobRow; run: JobRunRow }
  get(jobId: string): JobDetail | null
  list(filter: {
    deviceId?: string
    status?: JobStatus
    kind?: string
    rootJobId?: string
    parentWorkflowJobId?: string
    scheduleId?: string
    /** A `trigger: 'simulate'` run never touched a device (plan 309 §3.4, G4) — excluded from the list unless this asks for it explicitly. */
    includeSimulate?: boolean
    limit?: number
    cursor?: JobCursor | null
  }): {
    jobs: JobInfo[]
    nextCursor: JobCursor | null
    total: number
  }
}

/** One code path for both REST and WS (plan 04 §4.7). */
export function createJobService(deps: {
  jobStore: JobStore
  runs: RunStore
  registry: ExecutorRegistry
  scheduler: Scheduler
  host: ExecutorHost
  log: Logger
  onJobStatus: (info: JobInfo) => void
  findScript?: (scriptId: string) => { enabled: boolean } | null
  scriptNameOf?: (scriptId: string) => { name: string; version: string; runtime?: RuntimeEnvelope | null } | null
  farmJobSettings?: () => JobSettings
  onBatchChanged?: (batchId: string) => void
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
  shellMode?: () => ShellMode
  transferEnabled?: () => boolean
}): JobService {
  function detailOf(row: ReturnType<JobStore['get']>) {
    if (!row) return null
    const run = deps.runs.latestRun(row.id)
    const runs = deps.runs.runs(row.id)
    return rowToJobDetail(row, run, runs, row.scriptId ? (deps.jobStore.scriptNames([row.scriptId]).get(row.scriptId) ?? null) : null)
  }

  function infoOf(row: NonNullable<ReturnType<JobStore['get']>>) {
    const run = deps.runs.latestRun(row.id)
    return rowToJobInfo(row, run, row.scriptId ? (deps.jobStore.scriptNames([row.scriptId]).get(row.scriptId) ?? null) : null)
  }

  return {
    enqueue(input) {
      if (input.actor) {
        const device = deps.getDeviceOwner?.(input.deviceId)
        if (device && !canUseDevice(input.actor, device)) {
          throw new EnkakuError('auth.forbidden', 'this device belongs to another user')
        }
      }
      const named = deps.scriptNameOf?.(input.scriptId) ?? null
      assertRuntimeSupported(named?.runtime?.sdk)
      const params = validateScriptForRun({ ...deps, actorRole: () => input.actor?.role ?? null }, input.scriptId, input.params)
      const runtimeOverride = parseRuntimeOverrideInput(deps, input.runtimeOverride, `enqueue ${input.scriptId}`)
      const { maxConcurrent, overrideClamps } = resolveJobRuntime(deps, named?.runtime ?? null, runtimeOverride)
      if (overrideClamps.length > 0) throw overCeilingError(overrideClamps)
      const job = deps.runs.createJob({
        kind: 'script',
        scriptId: input.scriptId,
        deviceId: input.deviceId,
        params,
        scriptName: named?.name ?? null,
        scriptVersion: named?.version ?? null,
      })
      deps.runs.addRun(job.id, { trigger: 'manual', priority: input.priority ?? 0, maxConcurrent, runtimeOverride })
      const info = infoOf(deps.jobStore.get(job.id) as NonNullable<ReturnType<JobStore['get']>>)
      deps.onJobStatus(info)
      deps.scheduler.kick()
      return info
    },

    addRunOrNewJob(jobId, input) {
      const result = deps.runs.addRunOrNewJob(jobId, input.params, {
        trigger: 'rerun',
        priority: input.priority,
        runtimeOverride: input.runtimeOverride,
      })
      const info = infoOf(deps.jobStore.get(result.job.id) as NonNullable<ReturnType<JobStore['get']>>)
      deps.onJobStatus(info)
      deps.scheduler.kick()
      return { job: info, runId: result.run.id, sameJob: result.sameJob }
    },

    cancel(jobId, opts) {
      const job = deps.jobStore.get(jobId)
      if (!job) throw new EnkakuError('job_not_found', `no such job: ${jobId}`)
      const cancelledDescendants = 0 // plan 81's descendant cancel is unchanged in spirit but not rewired in this pass
      void opts
      const run = deps.runs.latestRun(jobId)
      if (!run) throw new EnkakuError('job_not_cancellable', 'this job has no run to cancel')
      if (run.status === 'queued') {
        const cancelled = deps.runs.cancelQueuedRun(run.id)
        if (!cancelled) throw new EnkakuError('job_not_cancellable', 'the run changed status first')
        const info = infoOf(deps.jobStore.get(jobId) as NonNullable<ReturnType<JobStore['get']>>)
        deps.onJobStatus(info)
        if (job.batchId) deps.onBatchChanged?.(job.batchId)
        return { job: info, cancelledDescendants }
      }
      if (run.status === 'running') {
        if (!deps.host.abort(run.id)) {
          deps.host.finishExternally(run.id, 'cancelled', 'cancelled (no executor was running)')
        }
        return { job: infoOf(deps.jobStore.get(jobId) ?? job), cancelledDescendants }
      }
      throw new EnkakuError('job_not_cancellable', `the run is ${run.status}`)
    },

    cancelRun(runId) {
      const run = deps.runs.getRun(runId)
      if (!run) return
      if (run.status === 'queued') {
        const cancelled = deps.runs.cancelQueuedRun(runId)
        if (cancelled) {
          const job = deps.jobStore.get(run.jobId)
          if (job) deps.onJobStatus(infoOf(job))
        }
        return
      }
      if (run.status === 'running') {
        if (!deps.host.abort(runId)) {
          deps.host.finishExternally(runId, 'cancelled', 'cancelled (no executor was running)')
        }
      }
    },

    enqueueStep(input) {
      const job = deps.runs.createJob({
        kind: 'script',
        scriptId: input.scriptId,
        deviceId: input.deviceId,
        params: input.params,
        scriptName: input.scriptName,
        scriptVersion: input.scriptVersion,
        parentWorkflowJobId: input.parentWorkflowJobId,
        stepSeq: input.stepSeq,
      })
      const run = deps.runs.addRun(job.id, { trigger: 'workflow-step', priority: input.priority })
      deps.onJobStatus(infoOf(deps.jobStore.get(job.id) as NonNullable<ReturnType<JobStore['get']>>))
      deps.scheduler.kick()
      return { job, run }
    },

    get(jobId) {
      return detailOf(deps.jobStore.get(jobId))
    },

    list(filter) {
      const { rows, nextCursor, total } = deps.jobStore.list({
        deviceId: filter.deviceId,
        status: filter.status,
        kind: filter.kind,
        rootJobId: filter.rootJobId,
        parentWorkflowJobId: filter.parentWorkflowJobId,
        scheduleId: filter.scheduleId,
        includeSimulate: filter.includeSimulate,
        limit: filter.limit ?? 50,
        cursor: filter.cursor,
      })
      const scriptIds = rows.map((r) => r.scriptId).filter((id): id is string => id !== null)
      const names = deps.jobStore.scriptNames(scriptIds)
      const latestRuns = deps.runs.latestRuns(rows.map((r) => r.id))
      return {
        jobs: rows.map((r) => rowToJobInfo(r, latestRuns.get(r.id) ?? null, r.scriptId ? (names.get(r.scriptId) ?? null) : null)),
        nextCursor,
        total,
      }
    },
  }
}
