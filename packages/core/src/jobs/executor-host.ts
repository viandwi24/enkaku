import { RESULT_LIMITS, type JobInfo, type ResultOutcome, type ResultStatus, type SummaryField } from '@enkaku/protocol'
import type { JobRow } from '../db/schema'
import type { DeviceHealth } from '../device/health'
import type { ActivityRegistry } from '../activity/registry'
import { rowToJobInfo, type JobStore } from '../queue/job-store'
import type { Logger } from '../util/logger'
import type { ExecutorRegistry } from './executor'
import { classifyFailure, type ClassifiedFailure } from './failure-class'
import { recordResult } from './result-store'

export interface ExecutorHostDeps {
  registry: ExecutorRegistry
  jobStore: JobStore
  /** Lazy: the activity registry and the host reference each other during wiring. */
  activities: () => ActivityRegistry
  log: Logger
  jobTtlSec: number
  heartbeatMs: number
  onJobStatus: (info: JobInfo) => void
  /** Kick scheduler setelah device bebas. */
  onFinished: () => void
  /**
   * A batch member job reached a terminal state — recompute the batch's
   * cached status (plan 20 §4.5).
   *
   * Plan 94 §3.8, §4.8, step 94.7 — `deviceId` is passed ONLY from a real
   * terminal settle (below), never from `requeueForRebind` (that job is
   * going back to `queued`, not completing a repetition) — the one signal
   * `groups/status.ts`'s `recomputeBatchStatus` needs to call
   * `BatchPacer.onMemberSettled` instead of just recomputing counts.
   */
  onBatchChanged?: (batchId: string, deviceId?: string) => void
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
  /** Lazy, like `activities` — the health tracker and the host are wired independently in daemon.ts. */
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
  /**
   * The kind of `job.scriptId`'s row — 'script' (the default) or 'workflow'
   * (plan 99 §3.1, §4.5). Read fresh per start, like `pickRebindDevice`
   * above. Undefined behaves exactly as before this field existed: `start()`
   * falls back to `'script'`, which is `ExecutorRegistry.get`'s own default.
   */
  scriptKind?: (scriptId: string) => import('../db/schema').ScriptKind
  /**
   * `job.maxResultBytes` (plan 97 §3.4, §3.8, §4.5) — read fresh per settle,
   * the same freshness convention `timeoutIsInfra`/`rebindOnInfra` above
   * already use. Undefined defaults to `RESULT_LIMITS.defaultMaxResultBytes`
   * (65_536, the schema's own default) — a caller that has not wired the
   * live farm setting still gets the correct out-of-the-box behaviour, just
   * not a live-tunable one.
   */
  maxResultBytes?: () => number
  /**
   * The cached `summaryFields()` for the script version that ran (plan 97
   * §3.6, §4.5) — computed ONCE per script version and cached on the
   * registry entry, never recomputed per job (a farm settles thousands of
   * jobs). Undefined, or a callback returning `[]`, both mean "no summary
   * fields for this script" — the same state every script is in today,
   * since `scripts.result_schema` itself is not yet persisted anywhere this
   * step can read (a later step's own work; see `result-store.ts`'s doc
   * comment).
   */
  resultSummaryFields?: (scriptId: string) => SummaryField[]
  /**
   * Plan 97 §3.7, §4.3, §4.6, §5 step 97.7 — a `job.progress` push that
   * survived `ExecutorHost.progress`'s own size check. Broadcasting (`hub.broadcast`
   * in `daemon.ts`) is the ONLY thing this does; nothing here writes a
   * column — progress is live state, never history (§3.7). Undefined means
   * the host has not wired a broadcaster, the same "caller can leave a sink
   * unwired" shape `onJobStatus`/`onJobFinished` above already allow, though
   * in practice this one is always wired since it costs nothing when unused.
   */
  onProgress?: (jobId: string, deviceId: string, value: unknown) => void
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
  /**
   * Plan 97 §3.7, §4.3, §5 step 97.7 — one coalesced `progress` push from a
   * running job's child (`@enkaku/session`'s `JobRunnerDeps.onProgress`,
   * wired to this in `daemon.ts`). A no-op for a job that already settled
   * (a message racing the settle path — nothing left to report progress
   * ON). Re-measures the value itself (never trusts a size the child did
   * not report — unlike a result's `outcome.bytes`, §3.8, a progress push
   * carries no such field) and drops anything over
   * `RESULT_LIMITS.maxProgressBytes`, logging exactly ONE `warn` for the
   * FIRST oversize push of a given job, never one per push — a script
   * emitting an oversized value in a loop must not also flood the log.
   * Never touches `jobStore`/the DB: progress is live state, not history
   * (§3.7's own "a result is a commitment; a progress is an observation").
   */
  progress(jobId: string, value: unknown): void
  stopAll(): void
}

const CANCEL_GRACE_MS = 5000

/**
 * Wraps every run: the job heartbeat (spec §10.2), writing the final status,
 * ending the job's activity marker, broadcasting job.status, kicking the
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
  /**
   * Plan 97 §3.7, §5 step 97.7 — "one `warn` per job, not per emit": a jobId
   * enters this set the FIRST time its progress is dropped for size, so
   * every push after the first from the same job is dropped silently.
   * Cleared on settle, mirroring `crashHandlers` exactly — a jobId is never
   * reused, but this keeps the set from growing unbounded across a
   * long-lived daemon regardless.
   */
  const warnedProgress = new Set<string>()
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
    deps.activities().end(job.deviceId, `job:${job.id}`)
    if (requeued) deps.onJobStatus(rowToJobInfo(requeued))
    deps.log.info(`job ${job.id} requeued after an infra failure (${code}) — now targets device ${newDeviceId}`)
    deps.onJobRebound?.(job.deviceId, job.id, newDeviceId, code)
    // No deviceId here (see `onBatchChanged`'s own comment) — this job is not settling, it's going back to `queued`.
    if (job.batchId) deps.onBatchChanged?.(job.batchId)
    deps.onFinished()
  }

  function settle(
    job: JobRow,
    status: 'success' | 'failed' | 'cancelled',
    data: {
      result?: unknown
      error?: string
      code?: string
      phase?: string
      /** Plan 98 §4.8, H1 — whatever `ctx.onPeakRss` captured for this job, if anything. */
      peakRssBytes?: number
      /**
       * Plan 97 §3.3, §4.3, §4.5 — whatever `ctx.onResultOutcome` captured
       * for this job, if the executor that ran it produced one. Absent for
       * every non-script executor (sleep, install, workflow — none of which
       * declare a result schema at all) and for a pre-plan-97 bundle; either
       * way `recordResult` below treats a missing outcome as `undeclared`,
       * never as an error.
       */
      outcome?: ResultOutcome
    },
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
    warnedProgress.delete(job.id)

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

    // Plan 97 §3.3, §3.4, §3.8, §4.5, §5 step 97.4 — a SUCCESS settle always
    // asks (an executor that never calls `onResultOutcome` still settles
    // `resultStatus: 'undeclared'`, §4.3's uniform rule). A `failed`/
    // `cancelled` settle asks ONLY when the executor actually reported an
    // outcome (97.4's `finish()` salvage, `partial`) — the overwhelming
    // majority of failures have nothing to report, and `recorded === null`
    // below leaves every result_* column untouched for them, the same
    // pattern `peakRssBytes` already uses for "nothing to report".
    const recorded =
      status === 'success' || data.outcome !== undefined
        ? recordResult({
            value: data.result,
            outcome: data.outcome,
            summary: deps.resultSummaryFields?.(job.scriptId) ?? [],
            maxResultBytes: deps.maxResultBytes?.() ?? RESULT_LIMITS.defaultMaxResultBytes,
            // Plan 97 §3.5, step 97.4 — `partial` must never overwrite an
            // already-recorded `valid` (see `result-store.ts`'s own doc
            // comment on `existingStatus` for why this is a defensive guard
            // rather than something reachable under today's
            // single-settle-per-job call graph).
            existingStatus: job.resultStatus as ResultStatus | null,
          })
        : null

    const updated = deps.jobStore.finish(job.id, status, {
      // `recorded.result` — never `data.result` directly — once `recorded`
      // exists: `oversize` nulls it out even when the executor (incorrectly)
      // sent one, and every other status is `recorded.result` verbatim
      // (§3.3: the column is exactly what the script returned, never
      // reshaped).
      result: recorded ? recorded.result : data.result,
      error: data.error,
      failureClass,
      // Plan 60 §3.4 — recorded so the Summary tab can say WHERE it failed.
      // Only ever set from what the executor reported; a settle with no phase
      // (an external finish, a cancel) leaves the column untouched.
      ...(data.phase !== undefined ? { errorPhase: data.phase } : {}),
      // Plan 98 §4.8, H1 — recorded unconditionally, success or failure alike.
      // Undefined (an executor with no subprocess, or a settle that never ran
      // one — `finishExternally`, "unknown_script") leaves the column
      // untouched rather than overwriting a real number with null.
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
    deps.activities().end(job.deviceId, `job:${job.id}`)
    if (updated) deps.onJobStatus(rowToJobInfo(updated))
    deps.log.info(`job ${job.id} finished: ${status}${data.error ? ` (${data.error})` : ''}`)
    const durationMs = job.startedAt ? Date.now() - job.startedAt.getTime() : 0
    deps.onJobFinished?.(job.deviceId, job.id, status, durationMs)
    if (job.batchId) deps.onBatchChanged?.(job.batchId, job.deviceId)
    deps.onFinished()
  }

  return {
    start(job) {
      const kind = deps.scriptKind?.(job.scriptId) ?? 'script'
      const executor = deps.registry.get(job.scriptId, kind)
      if (!executor) {
        settle(job, 'failed', { error: `unknown_script: ${job.scriptId}`, code: 'unknown_script' })
        return
      }
      const controller = new AbortController()
      const heartbeat = setInterval(() => {
        if (!deps.jobStore.renewHeartbeat(job.id, deps.jobTtlSec)) {
          deps.log.warn(`heartbeat for job ${job.id} failed (it is no longer running)`)
        }
        deps.activities().touch(job.deviceId, `job:${job.id}`)
      }, deps.heartbeatMs)
      const entry: RunningEntry = { controller, heartbeat, hold: null }
      running.set(job.id, entry)

      // Plan 98 §4.8, H1 — captured by `ctx.onPeakRss` below (only the script
      // executor calls it today) and carried into BOTH settle branches further
      // down, so a peak is recorded whether the job succeeded or failed.
      let peakRssBytes: number | undefined
      // Plan 97 §3.3, §4.5 — captured by `ctx.onResultOutcome` below (only
      // the script executor and the remote bridge call it today) and carried
      // into the success settle branch, mirroring `peakRssBytes` above.
      let resultOutcome: ResultOutcome | undefined
      const ctx = {
        signal: controller.signal,
        heartbeat: () => {
          void deps.jobStore.renewHeartbeat(job.id, deps.jobTtlSec)
          deps.activities().touch(job.deviceId, `job:${job.id}`)
        },
        log: deps.log.child(`job:${job.id.slice(0, 8)}`),
        onCrash: (cb: (e: { package: string; exception: string; message: string }) => void) => {
          crashHandlers.set(job.id, cb)
        },
        onPeakRss: (bytes: number) => {
          peakRssBytes = bytes
        },
        onResultOutcome: (outcome: ResultOutcome) => {
          resultOutcome = outcome
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
          settle(job, 'success', {
            result,
            ...(peakRssBytes !== undefined ? { peakRssBytes } : {}),
            ...(resultOutcome !== undefined ? { outcome: resultOutcome } : {}),
          })
        })
        .catch((err: unknown) => {
          if (!running.has(job.id)) return
          const message = err instanceof Error ? err.message : String(err)
          const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : undefined
          // The script phase the failure happened in (plan 60 §3.4), attached
          // by the script executor onto the error it throws.
          const phase = err instanceof Error && 'phase' in err ? String((err as { phase: unknown }).phase) : undefined
          // Plan 97 §3.5, §4.5, step 97.4 — a `finish()` salvage riding the
          // thrown error, the same way `code`/`phase` already do
          // (`executors/script.ts`/`executors/remote.ts` both attach it —
          // `JobExecutor.run()` rejects on failure and has no resolved value
          // left to carry one on).
          const partialResult = err instanceof Error && 'partialResult' in err ? (err as { partialResult: unknown }).partialResult : undefined
          settle(job, code === 'job_cancelled' ? 'cancelled' : 'failed', {
            error: message,
            code,
            ...(phase && phase !== 'undefined' ? { phase } : {}),
            ...(peakRssBytes !== undefined ? { peakRssBytes } : {}),
            ...(partialResult !== undefined ? { result: partialResult } : {}),
            ...(resultOutcome !== undefined ? { outcome: resultOutcome } : {}),
          })
        })
    },

    abort(jobId) {
      const entry = running.get(jobId)
      if (!entry) return false
      entry.controller.abort()
      // A stubborn executor (no settle within the grace period) → stop the
      // heartbeat and let the reaper expire the job's own heartbeat (an in-process M3 limit).
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

    progress(jobId, value) {
      // A message racing the settle path — the job already finished and
      // there is nothing left to report progress ON. Silent, not a warning:
      // this is a normal race, not a script error.
      if (!running.has(jobId)) return
      const job = deps.jobStore.get(jobId)
      if (!job) return
      let bytes: number
      try {
        bytes = new TextEncoder().encode(JSON.stringify(value)).length
      } catch {
        // Unserialisable (e.g. a circular reference that somehow survived
        // the child's own IPC boundary) — treated exactly like oversize:
        // dropped, warned once, never crashes the job.
        bytes = Number.POSITIVE_INFINITY
      }
      if (bytes > RESULT_LIMITS.maxProgressBytes) {
        if (!warnedProgress.has(jobId)) {
          warnedProgress.add(jobId)
          deps.log.warn(
            `job ${jobId} progress dropped: ${Number.isFinite(bytes) ? `${bytes} bytes` : 'unserialisable value'}, over the ${RESULT_LIMITS.maxProgressBytes}-byte cap — further oversize pushes from this job will not be logged again`,
          )
        }
        return
      }
      deps.onProgress?.(jobId, job.deviceId, value)
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
