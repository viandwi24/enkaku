import type { ActivityActor, ActivityKind, DeviceActivity, LastControl } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

export const DEFAULT_CONTROL_IDLE_SEC = 30
export const LAST_CONTROL_TAIL_SEC = 120
/** How often expired control markers and stale tails are swept. */
export const SWEEP_INTERVAL_MS = 1_000

export interface StartActivityInput {
  id: string
  kind: ActivityKind
  label: string
  actor: ActivityActor
  href?: string
  meta?: Record<string, unknown>
}

export interface ActivityRegistryDeps {
  log: Logger
  /** Read fresh on every sweep, like every other farm setting. */
  controlIdleSec: () => number
  /** Fired on every change; `daemon.ts` wires it to `hub.broadcast({ type: 'device.activity', ... })` and to the event recorder (`activity.started` / `activity.ended`). */
  onChange: (deviceId: string, change: 'added' | 'updated' | 'ended', activity: DeviceActivity, lastControl: LastControl | null) => void
  /** Injectable clock, unix milliseconds. Tests pass a fake. */
  now?: () => number
}

export interface ActivityRegistry {
  /** Idempotent on `id`: a second `start` with the same id is an `update`. */
  start(deviceId: string, input: StartActivityInput): DeviceActivity
  /** Refreshes `updatedAt` and merges `label`/`meta`/`href`. Returns null when the id is not live. */
  update(deviceId: string, id: string, patch: { label?: string; meta?: Record<string, unknown>; href?: string }): DeviceActivity | null
  /** Refreshes `updatedAt` only (a job heartbeat, a transfer chunk). */
  touch(deviceId: string, id: string): void
  end(deviceId: string, id: string): boolean
  /** Ends every live activity whose id matches; used by WS close for `command:*` of that client and by the drain in `cycle()`. */
  endWhere(predicate: (deviceId: string, activity: DeviceActivity) => boolean): number
  /** Creates or refreshes the marker `control:<clientId>` (MVP 04 §1.2). */
  touchControl(deviceId: string, clientId: string, actor: ActivityActor): DeviceActivity
  /** The live marker for this client, or null. */
  controlOf(deviceId: string, clientId: string): DeviceActivity | null
  /** Any live control marker on the device, most recently updated first. */
  liveControls(deviceId: string): DeviceActivity[]
  list(deviceId: string): DeviceActivity[]
  /** Every device that has at least one live activity of the kind. */
  devicesWith(kind: ActivityKind): string[]
  lastControl(deviceId: string): LastControl | null
  /** Drops every in-memory entry and re-projects from the sources; called once at boot after the job store's orphan sweep. */
  rebuild(sources: {
    runningJobs: () => Array<{ id: string; deviceId: string; label: string; startedAt: number }>
    transfers: () => Array<{ deviceId: string; transferId: string; kind: 'push' | 'pull' | 'install'; label: string; startedAt: number }>
    preparing: () => Array<{ deviceId: string; component: string; since: number }>
  }): void
  startSweep(): void
  stopSweep(): void
}

const SYSTEM_ACTOR: ActivityActor = { kind: 'system', id: 'core', label: 'Scheduler' }

function controlId(clientId: string): string {
  return `control:${clientId}`
}

export function createActivityRegistry(deps: ActivityRegistryDeps): ActivityRegistry {
  const now = deps.now ?? (() => Date.now())
  const byDevice = new Map<string, Map<string, DeviceActivity>>()
  const lastControlByDevice = new Map<string, LastControl>()
  let sweepHandle: ReturnType<typeof setInterval> | null = null

  function deviceMap(deviceId: string): Map<string, DeviceActivity> {
    let m = byDevice.get(deviceId)
    if (!m) {
      m = new Map()
      byDevice.set(deviceId, m)
    }
    return m
  }

  function start(deviceId: string, input: StartActivityInput): DeviceActivity {
    const m = deviceMap(deviceId)
    const existing = m.get(input.id)
    const nowSec = Math.floor(now() / 1000)
    if (existing) {
      const updated: DeviceActivity = {
        ...existing,
        label: input.label,
        href: input.href,
        meta: input.meta,
        updatedAt: nowSec,
      }
      m.set(input.id, updated)
      deps.onChange(deviceId, 'updated', updated, null)
      return updated
    }
    const activity: DeviceActivity = {
      id: input.id,
      kind: input.kind,
      label: input.label,
      actor: input.actor,
      startedAt: nowSec,
      updatedAt: nowSec,
      href: input.href,
      meta: input.meta,
    }
    m.set(input.id, activity)
    deps.onChange(deviceId, 'added', activity, null)
    return activity
  }

  function update(deviceId: string, id: string, patch: { label?: string; meta?: Record<string, unknown>; href?: string }): DeviceActivity | null {
    const m = byDevice.get(deviceId)
    const existing = m?.get(id)
    if (!m || !existing) return null
    const updated: DeviceActivity = {
      ...existing,
      label: patch.label ?? existing.label,
      href: patch.href ?? existing.href,
      meta: patch.meta ?? existing.meta,
      updatedAt: Math.floor(now() / 1000),
    }
    m.set(id, updated)
    deps.onChange(deviceId, 'updated', updated, null)
    return updated
  }

  function touch(deviceId: string, id: string): void {
    const m = byDevice.get(deviceId)
    const existing = m?.get(id)
    if (!m || !existing) return
    const updated: DeviceActivity = { ...existing, updatedAt: Math.floor(now() / 1000) }
    m.set(id, updated)
    deps.onChange(deviceId, 'updated', updated, null)
  }

  function end(deviceId: string, id: string): boolean {
    const m = byDevice.get(deviceId)
    const existing = m?.get(id)
    if (!m || !existing) return false
    m.delete(id)
    let lastControl: LastControl | null = null
    if (existing.kind === 'control') {
      lastControl = { actor: existing.actor, endedAt: Math.floor(now() / 1000) }
      lastControlByDevice.set(deviceId, lastControl)
    }
    deps.onChange(deviceId, 'ended', existing, lastControl)
    return true
  }

  function endWhere(predicate: (deviceId: string, activity: DeviceActivity) => boolean): number {
    let count = 0
    for (const [deviceId, m] of byDevice) {
      for (const activity of [...m.values()]) {
        if (predicate(deviceId, activity)) {
          if (end(deviceId, activity.id)) count++
        }
      }
    }
    return count
  }

  function touchControl(deviceId: string, clientId: string, actor: ActivityActor): DeviceActivity {
    const id = controlId(clientId)
    const m = deviceMap(deviceId)
    const existing = m.get(id)
    const nowSec = Math.floor(now() / 1000)
    if (existing) {
      const updated: DeviceActivity = { ...existing, updatedAt: nowSec }
      m.set(id, updated)
      deps.onChange(deviceId, 'updated', updated, null)
      return updated
    }
    const activity: DeviceActivity = {
      id,
      kind: 'control',
      label: `Controlled by ${actor.label}`,
      actor,
      startedAt: nowSec,
      updatedAt: nowSec,
    }
    m.set(id, activity)
    deps.onChange(deviceId, 'added', activity, null)
    return activity
  }

  function controlOf(deviceId: string, clientId: string): DeviceActivity | null {
    return byDevice.get(deviceId)?.get(controlId(clientId)) ?? null
  }

  function liveControls(deviceId: string): DeviceActivity[] {
    const m = byDevice.get(deviceId)
    if (!m) return []
    return [...m.values()].filter((a) => a.kind === 'control').sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function list(deviceId: string): DeviceActivity[] {
    const m = byDevice.get(deviceId)
    if (!m) return []
    return [...m.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  function devicesWith(kind: ActivityKind): string[] {
    const out: string[] = []
    for (const [deviceId, m] of byDevice) {
      for (const activity of m.values()) {
        if (activity.kind === kind) {
          out.push(deviceId)
          break
        }
      }
    }
    return out
  }

  function lastControl(deviceId: string): LastControl | null {
    return lastControlByDevice.get(deviceId) ?? null
  }

  function rebuild(sources: {
    runningJobs: () => Array<{ id: string; deviceId: string; label: string; startedAt: number }>
    transfers: () => Array<{ deviceId: string; transferId: string; kind: 'push' | 'pull' | 'install'; label: string; startedAt: number }>
    preparing: () => Array<{ deviceId: string; component: string; since: number }>
  }): void {
    byDevice.clear()
    lastControlByDevice.clear()
    for (const job of sources.runningJobs()) {
      const m = deviceMap(job.deviceId)
      m.set(`job:${job.id}`, {
        id: `job:${job.id}`,
        kind: 'job',
        label: job.label,
        actor: SYSTEM_ACTOR,
        startedAt: job.startedAt,
        updatedAt: job.startedAt,
        href: `/jobs/detail?id=${job.id}`,
      })
    }
    for (const transfer of sources.transfers()) {
      const m = deviceMap(transfer.deviceId)
      const id = `transfer:${transfer.transferId}`
      m.set(id, {
        id,
        kind: transfer.kind === 'install' ? 'install' : 'transfer',
        label: transfer.label,
        actor: SYSTEM_ACTOR,
        startedAt: transfer.startedAt,
        updatedAt: transfer.startedAt,
      })
    }
    for (const prep of sources.preparing()) {
      const m = deviceMap(prep.deviceId)
      const id = `prep:${prep.component}`
      m.set(id, {
        id,
        kind: 'prep',
        label: `Preparing ${prep.component}`,
        actor: SYSTEM_ACTOR,
        startedAt: prep.since,
        updatedAt: prep.since,
      })
    }
  }

  function sweep(): void {
    const idleSec = deps.controlIdleSec()
    const nowSec = Math.floor(now() / 1000)
    for (const [deviceId, m] of byDevice) {
      for (const activity of [...m.values()]) {
        if (activity.kind === 'control' && activity.updatedAt + idleSec <= nowSec) {
          m.delete(activity.id)
          const tail: LastControl = { actor: activity.actor, endedAt: nowSec }
          lastControlByDevice.set(deviceId, tail)
          deps.onChange(deviceId, 'ended', activity, tail)
        }
      }
    }
    for (const [deviceId, tail] of lastControlByDevice) {
      if (tail.endedAt + LAST_CONTROL_TAIL_SEC <= nowSec) lastControlByDevice.delete(deviceId)
    }
  }

  function startSweep(): void {
    if (sweepHandle) return
    sweepHandle = setInterval(sweep, SWEEP_INTERVAL_MS)
  }

  function stopSweep(): void {
    if (!sweepHandle) return
    clearInterval(sweepHandle)
    sweepHandle = null
  }

  return {
    start,
    update,
    touch,
    end,
    endWhere,
    touchControl,
    controlOf,
    liveControls,
    list,
    devicesWith,
    lastControl,
    rebuild,
    startSweep,
    stopSweep,
  }
}
