'use client'

import { useSyncExternalStore } from 'react'
import type { AdbServerPhase, DeviceInfo, ServerMessage } from '@enkaku/protocol'
import { HealthResponseSchema, JobsPageResponseSchema } from '@enkaku/protocol'
import { fetchDevices } from './api'
import { coreBase, ws } from './ws'

/**
 * Everything the shell shows that is not navigation: the two status-bar
 * counters and the health dot (plan 213 §4.3).
 *
 * The rule this file exists to enforce: NOTHING here runs on a repeating
 * timer. The previous shell (deleted by this plan) polled four endpoints on
 * every `job.status`, and the farm-wide operations registry ran a periodic
 * refresh over four more. Both are replaced by one snapshot at mount and the
 * pushes the core already broadcasts (MVP 13 A.6). A repeating timer in this
 * file is a defect; `GREP_213_POLL` fails the build over it.
 */
export interface DeviceCounts {
  /** `status === 'online'`. */
  online: number
  /** Every admitted device, whatever its status. */
  total: number
}

export interface JobCounts {
  /** Live `job` and `workflow-job` activities across every device. Exact, never seeded. */
  running: number
  /** Seeded once and maintained by `job.status`; see the drift note below. */
  queued: number
}

/**
 * What the dot and the sentence beside it say. Precedence, highest first:
 * `offline` (the socket is down, so nothing else here can be trusted), then
 * `adb` (every device is about to drop), then `provisioning` (first run),
 * then `degraded`, then `ok`.
 */
export type HealthState =
  | { kind: 'offline' }
  | { kind: 'adb'; phase: AdbServerPhase; detail: string }
  | { kind: 'provisioning'; detail: string }
  | { kind: 'degraded'; detail: string }
  | { kind: 'ok' }

export interface ShellState {
  devices: DeviceCounts
  jobs: JobCounts
  health: HealthState
  /** From `GET /api/health`; the avatar popover shows it. Null until the first read lands. */
  version: string | null
  /** `'local' | 'orchestrator'`, from the same read. */
  mode: string
}

const EMPTY_STATE: ShellState = {
  devices: { online: 0, total: 0 },
  jobs: { running: 0, queued: 0 },
  health: { kind: 'offline' },
  version: null,
  mode: 'local',
}

/** Copied verbatim from the deleted first-run provisioning banner (plan 213 §3.6) — no wording is lost. */
const PROVISION_PHASE_LABEL: Record<'download' | 'verify' | 'extract' | 'activate', string> = {
  download: 'Downloading',
  verify: 'Verifying',
  extract: 'Extracting',
  activate: 'Activating',
}

/** Copied verbatim from the deleted adb-restart banner (plan 213 §3.6) — no wording is lost. */
const ADB_PHASE_LABEL: Record<AdbServerPhase, string> = {
  draining: 'Draining',
  stopping: 'Stopping the adb server',
  swapping: 'Swapping the adb binary',
  starting: 'Starting the adb server',
  reattaching: 'Reattaching network devices',
  reconciling: 'Reconciling',
  done: 'Done',
  failed: 'Failed',
}

/**
 * Ref-counted the way the farm-wide operations registry and `WsClient`
 * already are, so nothing runs on `/login` or `/setup` (plan 213 §4.3).
 */
class ShellStateStoreImpl {
  private subscribers = new Set<() => void>()
  private snapshot: ShellState = EMPTY_STATE

  // Device counts (rule 3).
  private onlineIds = new Set<string>()
  private total = 0

  // Running jobs (rule 4).
  private jobActivityIds = new Set<string>()

  // Queued jobs (rule 5).
  private queuedBase = 0
  private queuedIds = new Set<string>()

  // Health (rule 6). `adbState`/`provisioningDetail`/`degradedDetail` are
  // independent overlays recomputed into `health` by `recomputeHealth()`;
  // `healthOk` is the last `GET /api/health` reading.
  private health: HealthState = { kind: 'offline' }
  private adbState: { phase: AdbServerPhase; detail: string } | null = null
  private provisioningDetail: string | null = null
  private degradedDetail: string | null = null
  private healthOk = true
  private version: string | null = null
  private mode = 'local'

  private offHandlers: Array<() => void> = []
  private seedCtrl: AbortController | null = null

  subscribe = (cb: () => void): (() => void) => {
    const first = this.subscribers.size === 0
    this.subscribers.add(cb)
    if (first) this.start()
    return () => {
      this.subscribers.delete(cb)
      if (this.subscribers.size === 0) this.stop()
    }
  }

  getSnapshot = (): ShellState => this.snapshot

  getServerSnapshot = (): ShellState => EMPTY_STATE

  private emit(): void {
    this.snapshot = {
      devices: { online: this.onlineIds.size, total: this.total },
      jobs: { running: this.jobActivityIds.size, queued: this.queuedBase + this.queuedIds.size },
      health: this.health,
      version: this.version,
      mode: this.mode,
    }
    for (const cb of this.subscribers) cb()
  }

  /** `start()` on the first subscriber: registers the three listeners, then runs `seed()` (rule 1). */
  private start(): void {
    const offStatus = ws.onStatus((connected) => {
      if (!connected) {
        this.health = { kind: 'offline' }
        this.emit()
      }
      // `connected === true` does nothing here by itself — `ws.onReconnected`
      // below is what re-seeds and recomputes the real state once the
      // socket is actually open (rule 6: "nothing else changes").
    })
    const offReconnected = ws.onReconnected(() => {
      void this.seed()
    })
    const offMessage = ws.on((m) => this.handleMessage(m))
    this.offHandlers = [offStatus, offReconnected, offMessage]
    void this.seed()
  }

  /** `stop()` on the last subscriber: removes all three and resets to the empty value (rule 1). */
  private stop(): void {
    for (const off of this.offHandlers) off()
    this.offHandlers = []
    this.seedCtrl?.abort()
    this.seedCtrl = null
    this.onlineIds = new Set()
    this.total = 0
    this.jobActivityIds = new Set()
    this.queuedBase = 0
    this.queuedIds = new Set()
    this.health = { kind: 'offline' }
    this.adbState = null
    this.provisioningDetail = null
    this.degradedDetail = null
    this.healthOk = true
    this.version = null
    this.mode = 'local'
    this.snapshot = EMPTY_STATE
  }

  /**
   * Exactly three requests, concurrently, each with its own `.catch()` (rule
   * 2). Called from `start()` and from `ws.onReconnected`, and from nowhere
   * else. One `AbortController` per call, aborted when a newer `seed()`
   * starts and on `stop()`.
   */
  private async seed(): Promise<void> {
    this.seedCtrl?.abort()
    const ctrl = new AbortController()
    this.seedCtrl = ctrl

    const devicesPromise = fetchDevices()
      .then((items: DeviceInfo[]) => {
        if (ctrl.signal.aborted) return
        this.total = items.length
        this.onlineIds = new Set(items.filter((d) => d.status === 'online').map((d) => d.id))
        this.jobActivityIds = new Set()
        for (const d of items) {
          for (const activity of d.activities) {
            if (activity.kind === 'job' || activity.kind === 'workflow-job') {
              this.jobActivityIds.add(`${d.id}:${activity.id}`)
            }
          }
        }
      })
      .catch(() => {
        // A failed read leaves this slice of the state where it was.
      })

    const jobsPromise = fetch(`${coreBase()}/api/jobs?status=queued&limit=1`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((body) => {
        if (ctrl.signal.aborted) return
        const parsed = JobsPageResponseSchema.safeParse(body)
        if (parsed.success) this.queuedBase = parsed.data.total ?? 0
        this.queuedIds = new Set()
      })
      .catch(() => {
        // A failed read leaves this slice of the state where it was.
      })

    const healthPromise = fetch(`${coreBase()}/api/health`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((body) => {
        if (ctrl.signal.aborted) return
        const parsed = HealthResponseSchema.safeParse(body)
        if (parsed.success) {
          this.version = parsed.data.version ?? this.version
          this.mode = parsed.data.mode ?? this.mode
          this.healthOk = parsed.data.ok !== false
        }
      })
      .catch(() => {
        // A failed read leaves this slice of the state where it was.
      })

    await Promise.all([devicesPromise, jobsPromise, healthPromise])
    if (ctrl.signal.aborted) return
    this.recomputeHealth()
    this.emit()
  }

  private handleMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'device.added': {
        this.total += 1
        if (m.payload.status === 'online') this.onlineIds.add(m.payload.id)
        this.emit()
        return
      }
      case 'device.removed': {
        this.total = Math.max(0, this.total - 1)
        this.onlineIds.delete(m.payload.id)
        this.emit()
        return
      }
      case 'device.status': {
        if (m.payload.status === 'online') this.onlineIds.add(m.payload.id)
        else this.onlineIds.delete(m.payload.id)
        this.emit()
        return
      }
      case 'device.activity': {
        const kind = m.payload.activity.kind
        if (kind === 'job' || kind === 'workflow-job') {
          const key = `${m.payload.deviceId}:${m.payload.activity.id}`
          if (m.payload.change === 'ended') this.jobActivityIds.delete(key)
          else this.jobActivityIds.add(key)
        }
        this.emit()
        return
      }
      case 'job.status': {
        const { jobId, status } = m.payload
        if (status === 'queued') {
          this.queuedIds.add(jobId)
        } else if (!this.queuedIds.delete(jobId)) {
          // The shell never saw this job enter the queue (it was already
          // queued at seed time) — only `queuedBase` can account for it.
          if (status === 'running' && this.queuedBase > 0) this.queuedBase -= 1
        }
        this.emit()
        return
      }
      case 'tool.provision.progress': {
        const { step, phase, toolId } = m.payload
        if (step === 'done') {
          this.provisioningDetail = null
        } else {
          const label = phase ? PROVISION_PHASE_LABEL[phase] : 'Provisioning'
          this.provisioningDetail = `${label} ${toolId ?? ''}`.trim()
        }
        this.recomputeHealth()
        this.emit()
        return
      }
      case 'adb.server.phase': {
        const { phase, detail } = m.payload
        if (phase === 'done') {
          this.adbState = null
        } else if (phase === 'failed') {
          this.adbState = null
          this.degradedDetail = detail || ADB_PHASE_LABEL.failed
        } else {
          // A fresh attempt in progress supersedes any prior failure.
          this.degradedDetail = null
          this.adbState = { phase, detail: detail ? `${ADB_PHASE_LABEL[phase]} — ${detail}` : ADB_PHASE_LABEL[phase] }
        }
        this.recomputeHealth()
        this.emit()
        return
      }
      default:
        return
    }
  }

  private recomputeHealth(): void {
    if (this.adbState) {
      this.health = { kind: 'adb', phase: this.adbState.phase, detail: this.adbState.detail }
      return
    }
    if (this.provisioningDetail !== null) {
      this.health = { kind: 'provisioning', detail: this.provisioningDetail }
      return
    }
    if (this.degradedDetail !== null) {
      this.health = { kind: 'degraded', detail: this.degradedDetail }
      return
    }
    if (!this.healthOk) {
      this.health = { kind: 'degraded', detail: 'the core reported not ok' }
      return
    }
    this.health = { kind: 'ok' }
  }
}

export type ShellStateStore = Pick<ShellStateStoreImpl, 'subscribe' | 'getSnapshot' | 'getServerSnapshot'>

export const shellStateStore: ShellStateStore = new ShellStateStoreImpl()

export function useShellState(store: ShellStateStore = shellStateStore): ShellState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}
