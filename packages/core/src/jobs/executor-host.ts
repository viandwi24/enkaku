import type { JobInfo } from '@enkaku/protocol'
import type { JobRow } from '../db/schema'
import type { DeviceHealth } from '../device/health'
import type { DeviceStateMachine } from '../device/state-machine'
import type { LeaseManager } from '../lease/lease-manager'
import { rowToJobInfo, type JobStore } from '../queue/job-store'
import type { Logger } from '../util/logger'
import type { ExecutorRegistry } from './executor'
import { classifyFailure, type ClassifiedFailure } from './failure-class'

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
  /**
   * Retry classification (plan 36 §3.2, §4.1, §4.3): a single classifier for
   * every `failed` settle, so `jobs.failureClass` and the health feed always
   * agree on why a job died. Defaults to the real table — injectable purely
   * for tests.
   */
  classify?: (err: unknown) => ClassifiedFailure
  /** `job.retry.timeoutIsInfra` — read fresh per settle (plan 36 §4.2), same pattern as `adb.maxConcurrent`. */
  timeoutIsInfra: () => boolean
  /** `job.retry.rebindOnInfra` — read fresh per settle (plan 36 §3.6, §4.2). */
  rebindOnInfra: () => boolean
  /** Lazy, like `leases` — the health tracker and the host are wired independently in daemon.ts. */
  health?: () => DeviceHealth | null
  /** The adb serial for a deviceId — `DeviceHealth.note` is keyed by serial, not deviceId (plan 23 §4.4). */
  deviceSerial: (deviceId: string) => string | null
  /**
   * Plan 36 §3.6: pick another eligible device for a batch member after an
   * infra failure (a sibling batch job's device that is currently idle).
   * Returns null when none is available — the job then requeues in place,
   * on the same device, after the backoff already spent inside the runner.
   */
  pickRebindDevice?: (job: JobRow) => string | null
  /** One `job.retry` main-stream device event for the requeue itself (plan 36 §4.4), `rebound: true`. */
  onJobRebound?: (deviceId: string, jobId: string, newDeviceId: string, code: string) => void
  /**
   * Readiness hold (plan 43 §3.6, §3.7 table, §5 step 43.7): a job on a
   * sleeping device wakes it before it runs; the hold is released the moment
   * the job settles (success, failure, cancel, or a rebind requeue), letting
   * the device drift back toward its `desired` readiness. A job claiming a
   * device is NEVER blocked by this (§4.3 "pre-emption") — `hold()` only
   * guarantees `awake`, it never refuses. Optional so tests that do not wire
   * readiness keep working unchanged.
   */
  readinessHold?: (deviceId: string, reason: 'job') => Promise<{ release(): void }>
}

export interface ExecutorHost {
  start(job: JobRow): void
  /** Abort a running executor (cancel or force-release). */
  abort(jobId: string): boolean
  isRunning(jobId: string): boolean
  finishExternally(jobId: string, status: 'failed' | 'cancelled', error: string, code?: string): void
  /**
   * Delivers a crash event to a running job's executor, IF one is running on
   * this job and it registered an `ctx.onCrash` handler (plan 37 §4.4) — the
   * crash watcher calls this after it has already decided the farm's crash
   * policy matches. Returns whether a handler was found and invoked; a job
   * that finished (or was never running) between the crash and this call
   * simply drops the notification, which is correct — there is nothing left
   * to abort.
   */
  notifyCrash(jobId: string, e: { package: string; exception: string; message: string }): boolean
  stopAll(): void
}

const CANCEL_GRACE_MS = 5000

/**
 * Wraps every run: the lease heartbeat (spec §10.2), writing the final status,
 * releasing the device (JOB_FINISHED), broadcasting job.status, kicking the
 * scheduler — and, since plan 36, classifying every `failed` settle so
 * `jobs.failureClass` is populated, the health tracker is fed only for
 * device-blaming failures, and a batch member can rebind to another device
 * instead of settling terminally failed.
 */
interface RunningEntry {
  controller: AbortController
  heartbeat: ReturnType<typeof setInterval>
  /** Set once the readiness hold resolves — may still be null when `settle` races it (released defensively either way). */
  hold: { release(): void } | null
}

export function createExecutorHost(deps: ExecutorHostDeps): ExecutorHost {
  const running = new Map<string, RunningEntry>()
  /** One crash handler per running job (plan 37 §4.4) — registered by `ctx.onCrash`, cleared on settle. */
  const crashHandlers = new Map<string, (e: { package: string; exception: string; message: string }) => void>()
  const classify = deps.classify ?? ((err: unknown) => classifyFailure(err, { timeoutIsInfra: deps.timeoutIsInfra() }))

  /**
   * A batch member's infra failure is returned to the queue instead of being
   * settled as a terminal failure (plan 36 §3.6): the device it was on is
   * freed exactly as a normal settle would free it, but the job row goes
   * back to `queued` — on another eligible device when one is idle, on the
   * same one otherwise — keeping its original priority and `createdAt` so
   * plan 21's ordering treats it as the old job it is.
   */
  function requeueForRebind(job: JobRow, code: string) {
    const newDeviceId = deps.pickRebindDevice?.(job) ?? job.deviceId
    const requeued = deps.jobStore.requeueForRebind(job.id, newDeviceId)
    deps.leases().clearJobLease(job.deviceId)
    deps.states.apply(job.deviceId, 'JOB_FINISHED')
    if (requeued) deps.onJobStatus(rowToJobInfo(requeued))
    deps.log.info(`job ${job.id} requeued after an infra failure (${code}) — now targets device ${newDeviceId}`)
    deps.onJobRebound?.(job.deviceId, job.id, newDeviceId, code)
    if (job.batchId) deps.onBatchChanged?.(job.batchId)
    deps.onFinished()
  }

  function settle(
    job: JobRow,
    status: 'success' | 'failed' | 'cancelled',
    data: { result?: unknown; error?: string; code?: string; phase?: string },
  ) {
    const entry = running.get(job.id)
    if (entry) {
      clearInterval(entry.heartbeat)
      running.delete(job.id)
      // Released here unconditionally — covers both the normal finish below
      // AND the early `requeueForRebind` return further down, since that
      // branch is reached from right here, after this point (plan 43 §5
      // step 43.7).
      entry.hold?.release()
    }
    crashHandlers.delete(job.id)

    let failureClass: string | null = null
    if (status === 'failed') {
      const classified = classify({ code: data.code, message: data.error })
      failureClass = classified.class

      // Feed plan 23's health tracker ONLY for device-blaming failures — load
      // (E_ADB_BUSY, queue saturation) and script failures never do
      // (acceptance #5, #6).
      if (classified.blameDevice) {
        const serial = deps.deviceSerial(job.deviceId)
        if (serial) deps.health?.()?.note(serial, 'timeout', classified.code)
        else deps.log.debug(`no serial on record for device ${job.deviceId} — cannot feed the health tracker for job ${job.id}`)
      }

      // Rebind only for a genuine infra failure (never `load`, which is a
      // farm-wide condition that moving devices would not fix), only for a
      // batch member (a job pinned to one device was not asking to move),
      // and only when the farm allows it (acceptance #7).
      if (classified.class === 'infra' && job.batchId && deps.rebindOnInfra()) {
        requeueForRebind(job, classified.code)
        return
      }
    }

    const updated = deps.jobStore.finish(job.id, status, {
      result: data.result,
      error: data.error,
      failureClass,
      // Plan 60 §3.4 — recorded so the Summary tab can say WHERE it failed.
      // Only ever set from what the executor reported; a settle with no phase
      // (an external finish, a cancel) leaves the column untouched.
      ...(data.phase !== undefined ? { errorPhase: data.phase } : {}),
    })
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
        settle(job, 'failed', { error: `unknown_script: ${job.scriptId}`, code: 'unknown_script' })
        return
      }
      const controller = new AbortController()
      const heartbeat = setInterval(() => {
        if (!deps.jobStore.renewLease(job.id, deps.jobTtlSec)) {
          deps.log.warn(`heartbeat for job ${job.id} failed (it is no longer running)`)
        }
      }, deps.heartbeatMs)
      const entry: RunningEntry = { controller, heartbeat, hold: null }
      running.set(job.id, entry)
      deps.leases().noteJobLease(job.deviceId, job.id, deps.jobTtlSec)

      const ctx = {
        signal: controller.signal,
        heartbeat: () => void deps.jobStore.renewLease(job.id, deps.jobTtlSec),
        log: deps.log.child(`job:${job.id.slice(0, 8)}`),
        onCrash: (cb: (e: { package: string; exception: string; message: string }) => void) => {
          crashHandlers.set(job.id, cb)
        },
      }

      // Readiness hold FIRST (plan 43 §3.6, §5 step 43.7): a job on a
      // sleeping device wakes it, then proceeds — no manual step. Chained
      // ahead of the executor so a device that started asleep is at least
      // `awake` before the script's own adb work begins. If the job settles
      // (or is cancelled) before the hold resolves, `settle`'s
      // `entry.hold?.release()` still fires — `hold` is assigned onto the
      // SAME `entry` object `running` already holds a reference to.
      const runWithReadiness = (async () => {
        entry.hold = (await deps.readinessHold?.(job.deviceId, 'job').catch((err) => {
          deps.log.warn(`readiness hold failed for job ${job.id} on ${job.deviceId}, proceeding anyway: ${String(err)}`)
          return null
        })) ?? null
        return executor.run(job, ctx)
      })()

      runWithReadiness
        .then((result) => {
          if (!running.has(job.id)) return // already settled elsewhere (reaper or cancel)
          settle(job, 'success', { result })
        })
        .catch((err: unknown) => {
          if (!running.has(job.id)) return
          const message = err instanceof Error ? err.message : String(err)
          const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : undefined
          // The script phase the failure happened in (plan 60 §3.4), attached
          // by the script executor onto the error it throws.
          const phase = err instanceof Error && 'phase' in err ? String((err as { phase: unknown }).phase) : undefined
          settle(job, code === 'job_cancelled' ? 'cancelled' : 'failed', {
            error: message,
            code,
            ...(phase && phase !== 'undefined' ? { phase } : {}),
          })
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

    finishExternally(jobId, status, error, code) {
      const job = deps.jobStore.get(jobId)
      if (!job) return
      const entry = running.get(jobId)
      entry?.controller.abort()
      settle(job, status, { error, code })
    },

    notifyCrash(jobId, e) {
      const handler = crashHandlers.get(jobId)
      if (!handler) return false
      handler(e)
      return true
    },

    stopAll() {
      for (const [, entry] of running) {
        clearInterval(entry.heartbeat)
        entry.controller.abort()
      }
      running.clear()
      crashHandlers.clear()
    },
  }
}
