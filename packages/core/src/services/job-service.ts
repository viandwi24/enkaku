import type { JobBulkCancelFilter, JobBulkCancelResponse, JobDetail, JobInfo, JobSettings, JobStatus, RuntimeClamp, RuntimeEnvelope, ShellMode } from '@enkaku/protocol'
import { checkRuntimeMajor, JobSettingsSchema, resolveRuntime, RuntimeEnvelopeSchema, unknownRuntimeKeys } from '@enkaku/protocol'
import { canUseDevice } from '../auth/acl'
import type { Role } from '../auth/service'
import type { JobRow, JobRunRow } from '../db/schema'
import type { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { rowToJobDetail, rowToJobInfo, type JobCursor, type JobStore } from '../queue/job-store'
import type { RunStore } from '../jobs/runs/store'
import type { RunWatcher } from '../jobs/runs/watcher'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { validateScriptForRun } from '../jobs/validate-script'

const DEFAULT_FARM_JOB_SETTINGS: JobSettings = JobSettingsSchema.parse({})

/**
 * The most jobs one filter-form bulk cancel stops. A farm with more active
 * work than this answers `truncated: true` and the operator presses again —
 * a bounded request, never an unbounded walk inside one HTTP call.
 */
export const BULK_CANCEL_FILTER_LIMIT = 2_000

/** A runaway lineage cannot turn one cancel into an unbounded walk. Far above `JOB_TRIGGER_MAX_PER_CHAIN`'s ceiling. */
const MAX_DESCENDANTS = 20_000

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
  /**
   * Cancels the job's latest run (a queued run is cancelled, a running one
   * aborted) and, when `cancelDescendants` is on, every descendant job still
   * queued or running: a workflow job's steps and every job it triggered, at
   * any depth, parents before children. Absent, `cancelDescendants` is ON for
   * a `kind: 'workflow'` job and OFF for a script job — so every door (REST,
   * WS, the capability, a batch stop) cancels a workflow together with its
   * steps. `cancelledDescendants` counts the descendants actually stopped.
   *
   * Throws `job_not_cancellable` only when NOTHING was stopped: a settled
   * job whose cascade still found active descendants is not an error.
   */
  cancel(jobId: string, opts?: { cancelDescendants?: boolean }): { job: JobInfo; cancelledDescendants: number }
  /**
   * `POST /api/jobs/cancel` — cancels many jobs in one pass, parents first so
   * a workflow's steps are stopped (and counted once) through its cascade.
   * `canCancel` gates each NAMED job (`canCancelJob`); a cascade inherits the
   * authority of the job it came from, exactly as the single cancel does.
   */
  cancelMany(input: { jobIds: string[]; canCancel?: (job: JobRow) => boolean; matched?: number; truncated?: boolean }): JobBulkCancelResponse
  /** The job ids `POST /api/jobs/cancel`'s filter form acts on, capped at {@link BULK_CANCEL_FILTER_LIMIT}. */
  resolveCancelFilter(filter: JobBulkCancelFilter): { jobIds: string[]; matched: number; truncated: boolean }
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
    /** Everything EXCEPT this kind — how the Jobs list stops mixing workflow jobs in with the scripts they ran. */
    excludeKind?: string
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

/** What stopping one job's latest run did: cancelled a queued run, aborted a running one, or nothing (no run, or already settled). */
type StopOutcome = 'cancelled' | 'aborted' | null

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
  /**
   * Told about every queued run this service cancels (plan 211 §3.2 decision
   * 14 names `JobService.cancel` as one of the watcher's producers). A
   * RUNNING run reaches the watcher through the host's settle; a queued one
   * never passes through the host, so without this a workflow waiting on a
   * step that was cancelled while still queued would wait forever.
   */
  watcher?: Pick<RunWatcher, 'notify'>
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

  /** The one place a run is stopped: `cancel`, `cancelMany` and every cascade go through it, so there is no second abort path. */
  function stopRun(job: JobRow, run: JobRunRow): StopOutcome {
    if (run.status === 'queued') {
      const cancelled = deps.runs.cancelQueuedRun(run.id)
      if (!cancelled) return null
      deps.watcher?.notify(cancelled)
      deps.onJobStatus(infoOf(deps.jobStore.get(job.id) ?? job))
      if (job.batchId) deps.onBatchChanged?.(job.batchId)
      return 'cancelled'
    }
    if (run.status === 'running') {
      // `abort` is idempotent: a step the workflow orchestrator already
      // cancelled on its own abort answers true again without re-arming
      // anything, so a cascade that reaches it too never double-cancels.
      if (!deps.host.abort(run.id)) {
        deps.host.finishExternally(run.id, 'cancelled', 'cancelled (no executor was running)')
      }
      return 'aborted'
    }
    return null
  }

  function stopLatest(job: JobRow): StopOutcome {
    const run = deps.runs.latestRun(job.id)
    return run ? stopRun(job, run) : null
  }

  /** Breadth-first, so a parent is always stopped before its children — a nested workflow's own abort then cancels its own step first. */
  function descendantsOf(jobId: string): JobRow[] {
    const out: JobRow[] = []
    const seen = new Set<string>([jobId])
    let frontier = [jobId]
    while (frontier.length > 0 && out.length < MAX_DESCENDANTS) {
      const children = deps.jobStore.listChildren(frontier).filter((c) => !seen.has(c.id))
      for (const c of children) seen.add(c.id)
      out.push(...children)
      frontier = children.map((c) => c.id)
    }
    return out
  }

  /**
   * The job FIRST, then its descendants. Order matters for a running
   * workflow: aborting it synchronously fires the orchestrator's own
   * `onAbort`, which cancels its current step and — because the signal is now
   * aborted — can never enqueue the next one. The cascade then finds that
   * step already stopping (and counts it), plus anything the orchestrator
   * does not know about: a step queued but not yet awaited, a job a step
   * triggered.
   */
  function cancelTree(job: JobRow, cascade: boolean): { self: StopOutcome; cancelledIds: string[]; abortedIds: string[] } {
    const self = stopLatest(job)
    const cancelledIds: string[] = []
    const abortedIds: string[] = []
    if (cascade) {
      for (const d of descendantsOf(job.id)) {
        const outcome = stopLatest(d)
        if (outcome === 'cancelled') cancelledIds.push(d.id)
        else if (outcome === 'aborted') abortedIds.push(d.id)
      }
    }
    return { self, cancelledIds, abortedIds }
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
      const cascade = opts?.cancelDescendants ?? job.kind === 'workflow'
      const run = deps.runs.latestRun(jobId)
      if (!cascade) {
        if (!run) throw new EnkakuError('job_not_cancellable', 'this job has no run to cancel')
        if (run.status !== 'queued' && run.status !== 'running') throw new EnkakuError('job_not_cancellable', `the run is ${run.status}`)
      }
      const { self, cancelledIds, abortedIds } = cancelTree(job, cascade)
      const cancelledDescendants = cancelledIds.length + abortedIds.length
      if (self === null && cancelledDescendants === 0) {
        const now = run ? deps.runs.getRun(run.id) : null
        throw new EnkakuError('job_not_cancellable', now ? `the run is ${now.status}` : 'this job has no run to cancel')
      }
      return { job: infoOf(deps.jobStore.get(jobId) ?? job), cancelledDescendants }
    },

    cancelMany(input) {
      const result: JobBulkCancelResponse = {
        matched: input.matched ?? input.jobIds.length,
        cancelled: 0,
        aborted: 0,
        refused: 0,
        notCancellable: 0,
        descendants: 0,
        cancelledJobIds: [],
        abortedJobIds: [],
        refusedJobIds: [],
        notCancellableJobIds: [],
        truncated: input.truncated ?? false,
      }
      const rows: JobRow[] = []
      for (const id of new Set(input.jobIds)) {
        const row = deps.jobStore.get(id)
        if (row) rows.push(row)
        else {
          result.notCancellable += 1
          result.notCancellableJobIds.push(id)
        }
      }
      // Parents first: a workflow job before any step job, and a shallower
      // job in a trigger chain before a deeper one, so a step or a triggered
      // job named in the same request is stopped once, through its parent's
      // cascade, and counted once.
      const rank = (j: JobRow) => (j.parentWorkflowJobId ? 1 : 0) * 1_000_000 + (j.kind === 'workflow' ? 0 : 1) * 100_000 + (j.depth ?? 0)
      rows.sort((a, b) => rank(a) - rank(b))

      const handled = new Set<string>()
      for (const row of rows) {
        if (handled.has(row.id)) continue
        handled.add(row.id)
        if (input.canCancel && !input.canCancel(row)) {
          result.refused += 1
          result.refusedJobIds.push(row.id)
          continue
        }
        const { self, cancelledIds, abortedIds } = cancelTree(row, row.kind === 'workflow')
        if (self === 'cancelled') {
          result.cancelled += 1
          result.cancelledJobIds.push(row.id)
        } else if (self === 'aborted') {
          result.aborted += 1
          result.abortedJobIds.push(row.id)
        } else {
          result.notCancellable += 1
          result.notCancellableJobIds.push(row.id)
        }
        for (const id of cancelledIds) {
          if (handled.has(id)) continue
          handled.add(id)
          result.cancelled += 1
          result.descendants += 1
          result.cancelledJobIds.push(id)
        }
        for (const id of abortedIds) {
          if (handled.has(id)) continue
          handled.add(id)
          result.aborted += 1
          result.descendants += 1
          result.abortedJobIds.push(id)
        }
      }
      return result
    },

    resolveCancelFilter(filter) {
      const { rows, total } = deps.jobStore.listActive({ ...filter, limit: BULK_CANCEL_FILTER_LIMIT })
      return { jobIds: rows.map((r) => r.id), matched: total, truncated: total > rows.length }
    },

    cancelRun(runId) {
      const run = deps.runs.getRun(runId)
      if (!run) return
      const job = deps.jobStore.get(run.jobId)
      if (!job) return
      stopRun(job, run)
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
        excludeKind: filter.excludeKind,
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
