import { rowToJobInfo, type JobStore } from './job-store'
import type { RunStore } from '../jobs/runs/store'
import type { ExecutorHost } from '../jobs/executor-host'
import type { ActivityRegistry } from '../activity/registry'
import type { DeviceActivity, JobInfo } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

export interface Scheduler {
  /** Idempotent and coalescing — safe to call from anywhere. */
  kick(): void
  start(): void
  stop(): void
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** The job-over-fresh-control wait's own cap (plan 205 §3.2 item 6, MVP 12 §3): a constant, not a setting. */

export interface SchedulerDeps {
  jobStore: JobStore
  runs: RunStore
  host: ExecutorHost
  log: Logger
  jobTtlSec: number
  fallbackIntervalMs: number
  onJobStatus: (info: JobInfo) => void
  /** The claim starts a `job:<runId>`/`workflow-job:<runId>` activity inside a SQL transaction; notify watchers (readiness reconcile). */
  onJobClaimed: (deviceId: string) => void
  /** Main-stream device event: job.started (plan 18 §4.2). */
  onJobStarted?: (deviceId: string, jobId: string, scriptId: string) => void
  /**
   * A queued run waits while a `control` marker is live on its device (plan
   * 205 §3.2 item 6, MVP 12 §3) instead of interrupting whatever a person is
   * mid-gesture on — the renamed and reworked "quiet gate" (plan 71 §3.7).
   * Read fresh on every loop tick.
   */
  activities: Pick<ActivityRegistry, 'liveControls' | 'devicesWith' | 'start'>
  /**
   * The wait is visible (plan 71 §3.7, criterion 11; plan 94 §3.8, §4.8,
   * step 94.6 adds the `reason: 'paced'` case alongside it) — broadcast
   * while it is in progress, and once more with `waiting: false` the
   * moment it ends (claimed, or nothing left to wait for). `conflicting` is
   * only ever non-null for `reason: 'control'`.
   */
  onJobWaiting?: (info: {
    jobId: string
    runId: string
    deviceId: string
    waiting: boolean
    reason: 'paced'
    conflicting: DeviceActivity | null
    remainingSec: number
  }) => void
}

/**
 * An event-driven scheduler with a fallback interval (plan 04 §4.4). One loop
 * only (the core is single-process): if the loop is already running, a kick just
 * sets a dirty flag. The per-device constraint falls out of the SQL claim
 * (d.status='online' plus a NOT EXISTS running-run guard, plan 205 §4.7,
 * plan 211 §4.6).
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  let looping = false
  let dirty = false
  let timer: ReturnType<typeof setInterval> | null = null

  let previouslyWaiting = new Map<string, 'paced'>()

  /**
   * Devices a queued run must not be claimed on.
   *
   * This used to hold a queued run back while a `control` marker was live —
   * the "quiet gate", carried over from plan 71 and written into MVP 04 §3 as
   * a proposal. The CEO struck it on 2026-09-04 after meeting it on hardware:
   * a job sat queued purely because a person had the device open in Device
   * Control, which reads as the lease the whole programme removed. The model
   * is now the state dot and nothing else — green free, amber a person is
   * driving, red the system is. **A person driving never holds a job back;
   * only a running job holds another job back**, and that exclusion lives in
   * the SQL claim (`d.status='online'` plus the NOT EXISTS running-run guard),
   * not here.
   *
   * `install` stays: an APK write and a job's first `am start` on the same
   * device really do collide, and the policy table already calls that
   * combination `forbid` (`activity/policy.ts`, the `job` row).
   */
  function computeInstallBlocked(): Map<string, number> {
    const exclude = new Map<string, number>()
    for (const deviceId of deps.activities.devicesWith('install')) exclude.set(deviceId, 0)
    return exclude
  }

  /**
   * Plan 94 §3.8, §4.8, step 94.6 — every device whose next-up queued run
   * (same `nextQueuedRunId` ordering `broadcastWaiting` already uses for the
   * control gate) is not yet due: `job_runs.not_before` in the future.
   */
  function computePacedBlocked(): Map<string, { jobId: string; runId: string; remainingSec: number }> {
    const blocked = new Map<string, { jobId: string; runId: string; remainingSec: number }>()
    if (!deps.onJobWaiting) return blocked
    const now = nowSec()
    for (const deviceId of deps.jobStore.queuedDeviceIds()) {
      const runId = deps.jobStore.nextQueuedRunId(deviceId)
      if (!runId) continue
      const run = deps.runs.getRun(runId)
      if (!run || run.notBefore == null) continue
      const remainingSec = run.notBefore - now
      if (remainingSec <= 0) continue
      blocked.set(deviceId, { jobId: run.jobId, runId: run.id, remainingSec })
    }
    return blocked
  }

  function broadcastWaiting(pacedBlocked: Map<string, { jobId: string; runId: string; remainingSec: number }>): void {
    if (!deps.onJobWaiting) return
    const stillWaiting = new Map<string, 'paced'>()
    for (const [deviceId, paced] of pacedBlocked) {
      stillWaiting.set(deviceId, 'paced')
      deps.onJobWaiting({ jobId: paced.jobId, runId: paced.runId, deviceId, waiting: true, reason: 'paced', conflicting: null, remainingSec: paced.remainingSec })
    }
    for (const [deviceId, reason] of previouslyWaiting) {
      if (stillWaiting.has(deviceId)) continue
      const runId = deps.jobStore.nextQueuedRunId(deviceId)
      const run = runId ? deps.runs.getRun(runId) : null
      if (run) deps.onJobWaiting({ jobId: run.jobId, runId: run.id, deviceId, waiting: false, reason, conflicting: null, remainingSec: 0 })
    }
    previouslyWaiting = stillWaiting
  }

  async function loop(): Promise<void> {
    if (looping) {
      dirty = true
      return
    }
    looping = true
    try {
      do {
        dirty = false
        const installExclude = computeInstallBlocked()
        const pacedBlocked = computePacedBlocked()
        broadcastWaiting(pacedBlocked)
        for (;;) {
          let claimed
          try {
            claimed = deps.jobStore.claimNext(deps.jobTtlSec, [...installExclude.keys()])
          } catch (err) {
            deps.log.warn(`job claim failed: ${String(err)}`)
            break
          }
          if (!claimed) break
          deps.log.info(`run claimed: ${claimed.run.id} (job ${claimed.job.id}) → device ${claimed.deviceId}`)
          const names = claimed.job.scriptId ? deps.jobStore.scriptNames([claimed.job.scriptId]) : new Map()
          const scriptName = claimed.job.scriptName ?? (claimed.job.scriptId ? names.get(claimed.job.scriptId)?.name : null) ?? claimed.job.workflowName ?? claimed.job.id
          const activityId = claimed.job.kind === 'workflow' ? `workflow-job:${claimed.run.id}` : `job:${claimed.run.id}`
          deps.activities.start(claimed.deviceId, {
            id: activityId,
            kind: 'job',
            label: `Running ${scriptName}`,
            actor: { kind: 'system', id: 'core', label: 'Scheduler' },
            href: `/jobs/detail?id=${claimed.job.id}&run=${claimed.run.id}`,
          })
          deps.onJobClaimed(claimed.deviceId)
          deps.onJobStatus(rowToJobInfo(claimed.job, claimed.run))
          deps.onJobStarted?.(claimed.deviceId, claimed.job.id, claimed.job.scriptId ?? claimed.job.workflowName ?? '')
          deps.host.start(claimed.job, claimed.run)
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
