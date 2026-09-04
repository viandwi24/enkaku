import { RESULT_LIMITS, type JobInfo, type ResultOutcome, type ResultStatus, type SummaryField } from '@enkaku/protocol'
import type { JobRow, JobRunRow } from '../db/schema'
import type { DeviceHealth } from '../device/health'
import type { ActivityRegistry } from '../activity/registry'
import { rowToJobInfo, type JobStore } from '../queue/job-store'
import type { RunStore } from './runs/store'
import type { RunWatcher } from './runs/watcher'
import type { Logger } from '../util/logger'
import type { ExecutorRegistry } from './executor'
import { classifyFailure, type ClassifiedFailure } from './failure-class'
import { recordResult } from './result-store'

/** `job:<runId>` for a script job, `workflow-job:<runId>` for a workflow job (plan 211 §3.2 decision 9). */
function activityIdFor(job: JobRow, run: JobRunRow): string {
  return job.kind === 'workflow' ? `workflow-job:${run.id}` : `job:${run.id}`
}

export interface ExecutorHostDeps {
  registry: ExecutorRegistry
  /** Selects the orchestrator for a `kind: 'workflow'` job (plan 211 §4.5) — a lookup on `job.kind`, never a `ScriptKind` fallback slot. */
  workflowExecutor: () => import('./executor').JobExecutor
  jobStore: JobStore
  runs: RunStore
  watcher: RunWatcher
  /** Lazy: the activity registry and the host reference each other during wiring. */
  activities: () => ActivityRegistry
  log: Logger
  jobTtlSec: number
  heartbeatMs: number
  onJobStatus: (info: JobInfo) => void
  /** Kick scheduler setelah device bebas. */
  onFinished: () => void
  onBatchChanged?: (batchId: string, deviceId?: string) => void
  /** Main-stream device event: job.finished (plan 18 §4.2). */
  onJobFinished?: (deviceId: string, jobId: string, status: string, durationMs: number) => void
  classify?: (err: unknown) => ClassifiedFailure
  timeoutIsInfra: () => boolean
  rebindOnInfra: () => boolean
  health?: () => DeviceHealth | null
  deviceSerial: (deviceId: string) => string | null
  pickRebindDevice?: (job: JobRow) => string | null
  onJobRebound?: (deviceId: string, jobId: string, newDeviceId: string, code: string) => void
  readinessHold?: (deviceId: string, reason: 'job') => Promise<{ release(): void }>
  maxResultBytes?: () => number
  resultSummaryFields?: (scriptId: string) => SummaryField[]
  onProgress?: (jobId: string, deviceId: string, value: unknown) => void
}

export interface ExecutorHost {
  start(job: JobRow, run: JobRunRow): void
  /** Abort a running executor (cancel or force-release). */
  abort(runId: string): boolean
  isRunning(runId: string): boolean
  finishExternally(runId: string, status: 'failed' | 'cancelled', error: string, code?: string): void
  notifyCrash(runId: string, e: { package: string; exception: string; message: string }): boolean
  progress(runId: string, value: unknown): void
  stopAll(): void
}

const CANCEL_GRACE_MS = 5000

interface RunningEntry {
  job: JobRow
  run: JobRunRow
  controller: AbortController
  heartbeat: ReturnType<typeof setInterval>
  hold: { release(): void } | null
}

/**
 * Wraps every run: the heartbeat (spec §10.2), writing the final status
 * through `RunStore.settle`, ending the run's activity marker, broadcasting
 * job.status, kicking the scheduler, notifying `RunWatcher` — and, since
 * plan 36, classifying every `failed` settle.
 */
export function createExecutorHost(deps: ExecutorHostDeps): ExecutorHost {
  const running = new Map<string, RunningEntry>()
  const crashHandlers = new Map<string, (e: { package: string; exception: string; message: string }) => void>()
  const warnedProgress = new Set<string>()
  const classify = deps.classify ?? ((err: unknown) => classifyFailure(err, { timeoutIsInfra: deps.timeoutIsInfra() }))

  function requeueForRebind(job: JobRow, run: JobRunRow, code: string) {
    const newDeviceId = deps.pickRebindDevice?.(job) ?? job.deviceId
    const requeued = deps.jobStore.requeueForRebind(run.id, newDeviceId)
    deps.activities().end(job.deviceId, activityIdFor(job, run))
    if (requeued) {
      const freshJob = deps.jobStore.get(job.id) ?? job
      deps.onJobStatus(rowToJobInfo(freshJob, requeued))
    }
    deps.log.info(`run ${run.id} (job ${job.id}) requeued after an infra failure (${code}) — now targets device ${newDeviceId}`)
    deps.onJobRebound?.(job.deviceId, job.id, newDeviceId, code)
    if (job.batchId) deps.onBatchChanged?.(job.batchId)
    deps.onFinished()
  }

  function settle(
    job: JobRow,
    run: JobRunRow,
    status: 'success' | 'failed' | 'cancelled',
    data: {
      result?: unknown
      error?: string
      code?: string
      phase?: string
      peakRssBytes?: number
      outcome?: ResultOutcome
    },
  ) {
    const entry = running.get(run.id)
    if (entry) {
      clearInterval(entry.heartbeat)
      running.delete(run.id)
      entry.hold?.release()
    }
    crashHandlers.delete(run.id)
    warnedProgress.delete(run.id)

    let failureClass: string | null = null
    if (status === 'failed') {
      const classified = classify({ code: data.code, message: data.error })
      failureClass = classified.class

      if (classified.blameDevice) {
        const serial = deps.deviceSerial(job.deviceId)
        if (serial) deps.health?.()?.note(serial, 'timeout', classified.code)
        else deps.log.debug(`no serial on record for device ${job.deviceId} — cannot feed the health tracker for run ${run.id}`)
      }

      if (classified.class === 'infra' && job.batchId && deps.rebindOnInfra()) {
        requeueForRebind(job, run, classified.code)
        return
      }
    }

    const recorded =
      status === 'success' || data.outcome !== undefined
        ? recordResult({
            value: data.result,
            outcome: data.outcome,
            summary: job.scriptId ? (deps.resultSummaryFields?.(job.scriptId) ?? []) : [],
            maxResultBytes: deps.maxResultBytes?.() ?? RESULT_LIMITS.defaultMaxResultBytes,
            existingStatus: run.resultStatus as ResultStatus | null,
          })
        : null

    const settled = deps.runs.settle(run.id, {
      status,
      result: recorded ? recorded.result : data.result,
      error: data.error,
      failureClass,
      ...(data.phase !== undefined ? { errorPhase: data.phase } : {}),
      ...(data.peakRssBytes !== undefined ? { peakRssBytes: data.peakRssBytes } : {}),
      ...(recorded
        ? {
            resultStatus: recorded.resultStatus,
            resultBytes: recorded.resultBytes,
            resultSummary: recorded.resultSummary,
            resultIssues: recorded.resultIssues,
          }
        : {}),
    })
    deps.activities().end(job.deviceId, activityIdFor(job, run))
    if (settled) {
      const freshJob = deps.jobStore.get(job.id) ?? job
      deps.onJobStatus(rowToJobInfo(freshJob, settled))
      deps.watcher.notify(settled)
    }
    deps.log.info(`run ${run.id} (job ${job.id}) finished: ${status}${data.error ? ` (${data.error})` : ''}`)
    const durationMs = run.startedAt ? Date.now() - run.startedAt.getTime() : 0
    deps.onJobFinished?.(job.deviceId, job.id, status, durationMs)
    if (job.batchId) deps.onBatchChanged?.(job.batchId, job.deviceId)
    deps.onFinished()
  }

  return {
    start(job, run) {
      const executor = job.kind === 'workflow' ? deps.workflowExecutor() : job.scriptId ? deps.registry.get(job.scriptId) : null
      if (!executor) {
        settle(job, run, 'failed', { error: `unknown_script: ${job.scriptId ?? job.kind}`, code: 'unknown_script' })
        return
      }
      const controller = new AbortController()
      const heartbeat = setInterval(() => {
        if (!deps.jobStore.renewHeartbeat(run.id, deps.jobTtlSec)) {
          deps.log.warn(`heartbeat for run ${run.id} failed (it is no longer running)`)
        }
        deps.activities().touch(job.deviceId, activityIdFor(job, run))
      }, deps.heartbeatMs)
      const entry: RunningEntry = { job, run, controller, heartbeat, hold: null }
      running.set(run.id, entry)

      let peakRssBytes: number | undefined
      let resultOutcome: ResultOutcome | undefined
      const ctx = {
        runId: run.id,
        run,
        signal: controller.signal,
        heartbeat: () => {
          void deps.jobStore.renewHeartbeat(run.id, deps.jobTtlSec)
          deps.activities().touch(job.deviceId, activityIdFor(job, run))
        },
        log: deps.log.child(`run:${run.id.slice(0, 8)}`),
        onCrash: (cb: (e: { package: string; exception: string; message: string }) => void) => {
          crashHandlers.set(run.id, cb)
        },
        onPeakRss: (bytes: number) => {
          peakRssBytes = bytes
        },
        onResultOutcome: (outcome: ResultOutcome) => {
          resultOutcome = outcome
        },
      }

      const runWithReadiness = (async () => {
        entry.hold = (await deps.readinessHold?.(job.deviceId, 'job').catch((err) => {
          deps.log.warn(`readiness hold failed for run ${run.id} on ${job.deviceId}, proceeding anyway: ${String(err)}`)
          return null
        })) ?? null
        return executor.run(job, ctx)
      })()

      runWithReadiness
        .then((result) => {
          if (!running.has(run.id)) return
          settle(job, run, 'success', {
            result,
            ...(peakRssBytes !== undefined ? { peakRssBytes } : {}),
            ...(resultOutcome !== undefined ? { outcome: resultOutcome } : {}),
          })
        })
        .catch((err: unknown) => {
          if (!running.has(run.id)) return
          const message = err instanceof Error ? err.message : String(err)
          const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : undefined
          const phase = err instanceof Error && 'phase' in err ? String((err as { phase: unknown }).phase) : undefined
          const partialResult = err instanceof Error && 'partialResult' in err ? (err as { partialResult: unknown }).partialResult : undefined
          settle(job, run, code === 'job_cancelled' ? 'cancelled' : 'failed', {
            error: message,
            code,
            ...(phase && phase !== 'undefined' ? { phase } : {}),
            ...(peakRssBytes !== undefined ? { peakRssBytes } : {}),
            ...(partialResult !== undefined ? { result: partialResult } : {}),
            ...(resultOutcome !== undefined ? { outcome: resultOutcome } : {}),
          })
        })
    },

    abort(runId) {
      const entry = running.get(runId)
      if (!entry) return false
      entry.controller.abort()
      setTimeout(() => {
        const still = running.get(runId)
        if (still) {
          clearInterval(still.heartbeat)
          deps.log.warn(`run ${runId} did not settle within ${CANCEL_GRACE_MS}ms — heartbeat stopped, waiting for the reaper`)
        }
      }, CANCEL_GRACE_MS)
      return true
    },

    isRunning(runId) {
      return running.has(runId)
    },

    finishExternally(runId, status, error, code) {
      const entry = running.get(runId)
      const run = entry?.run ?? deps.runs.getRun(runId)
      if (!run) return
      const job = deps.jobStore.get(run.jobId)
      if (!job) return
      entry?.controller.abort()
      settle(job, run, status, { error, code })
    },

    notifyCrash(runId, e) {
      const handler = crashHandlers.get(runId)
      if (!handler) return false
      handler(e)
      return true
    },

    progress(runId, value) {
      const entry = running.get(runId)
      if (!entry) return
      let bytes: number
      try {
        bytes = new TextEncoder().encode(JSON.stringify(value)).length
      } catch {
        bytes = Number.POSITIVE_INFINITY
      }
      if (bytes > RESULT_LIMITS.maxProgressBytes) {
        if (!warnedProgress.has(runId)) {
          warnedProgress.add(runId)
          deps.log.warn(
            `run ${runId} progress dropped: ${Number.isFinite(bytes) ? `${bytes} bytes` : 'unserialisable value'}, over the ${RESULT_LIMITS.maxProgressBytes}-byte cap — further oversize pushes from this run will not be logged again`,
          )
        }
        return
      }
      deps.onProgress?.(entry.job.id, entry.job.deviceId, value)
    },

    stopAll() {
      for (const [, entry] of running) {
        clearInterval(entry.heartbeat)
        entry.controller.abort()
      }
      running.clear()
      crashHandlers.clear()
      warnedProgress.clear()
    },
  }
}
