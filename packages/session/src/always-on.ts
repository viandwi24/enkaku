import type { TrackedDevice } from '@enkaku/adb'
import type { PrepStep, SessionManager } from './manager'
import type { DeviceSnapshotSource } from './types'
import type { Logger } from './logger'

export const PREP_STEP_COUNT = 5
export const REBUILD_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000] as const
export const DEFAULT_BUILDS_PER_USB_ROOT = 4
/** Farm-wide ceiling on concurrent builds; `ENKAKU_SESSION_BUILD_CEILING` overrides it (MVP 12 §3). */
export const SESSION_BUILD_FARM_CEILING = 16
export const SCRCPY_FALLBACK_AFTER_FAILURES = 4
export const INSPECTOR_PREWARM_DELAY_MS = 2_000
export const USB_ROOT_CACHE_MS = 5_000
export const NETWORK_ROOT = 'network'
export const UNKNOWN_ROOT = 'unknown'

export function prepLabel(step: PrepStep): string {
  return `Preparing, step ${step} of ${PREP_STEP_COUNT}`
}
export function recoveringLabel(attempt: number): string {
  return `Recovering, attempt ${attempt}`
}
export const PREP_QUEUED_LABEL = 'Preparing, queued'

/** `3-1.4.3` → `3`; undefined → `network`. Pure, exported for the test. */
export function usbRootOf(usb: string | undefined): string {
  if (!usb) return NETWORK_ROOT
  const dash = usb.indexOf('-')
  return dash < 0 ? usb : usb.slice(0, dash)
}

/** Backoff for the n-th consecutive failure (1-based); the last value repeats. */
export function rebuildDelayMs(attempt: number): number {
  return REBUILD_BACKOFF_MS[Math.min(attempt, REBUILD_BACKOFF_MS.length) - 1] ?? REBUILD_BACKOFF_MS[REBUILD_BACKOFF_MS.length - 1]!
}

/**
 * The seam to plan 205's activity registry (`packages/core/src/activity/registry.ts`),
 * which `@enkaku/session` cannot import directly (core depends on session, never
 * the other way — `00-overview.md` §4.1). `daemon.ts` adapts the real
 * `ActivityRegistry` to this shape; a caller with no registry wired (a test,
 * or a core built without plan 205) gets `noopActivityPort`.
 *
 * The real registry's `start` takes a caller-supplied `id` and is idempotent
 * on it (a second `start` with the same id is an `update`) — this port's
 * `start` returns the id it used, so a caller never has to invent its own
 * convention; the always-on builder always passes `prep:<deviceId>`.
 */
export interface ActivityPort {
  start(
    deviceId: string,
    input: {
      kind: 'prep' | 'wake'
      label: string
      actor: { kind: 'system'; id: string; label: string }
      meta?: Record<string, unknown>
    },
  ): string
  update(deviceId: string, id: string, patch: { label?: string; meta?: Record<string, unknown> }): void
  end(deviceId: string, id: string): void
}
export const noopActivityPort: ActivityPort = { start: () => crypto.randomUUID(), update: () => {}, end: () => {} }
export const ALWAYS_ON_ACTOR = { kind: 'system', id: 'always-on', label: 'Enkaku' } as const

export type DeviceBuildState = 'none' | 'queued' | 'preparing' | 'ready' | 'recovering'

export interface AlwaysOnDeps {
  sessions: Pick<SessionManager, 'build' | 'closeDevice' | 'get'>
  devices: DeviceSnapshotSource
  /** `AdbClient.listDevices` (host:devices-l), the only source of `usb:`. */
  listDevices: () => Promise<TrackedDevice[]>
  /** `lookupDeviceNumber` by device id; null sorts last. */
  deviceNumber: (deviceId: string) => number | null
  activities: ActivityPort
  buildsPerUsbRoot: () => number
  farmCeiling?: () => number
  log: Logger
  /** Injectable for tests; default `setTimeout`/`clearTimeout`/`Date.now`. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void; now: () => number }
}

export interface AlwaysOn {
  /** Enable the pump. Calls before `start()` are queued, not dropped. */
  start(): void
  deviceOnline(deviceId: string): void
  deviceOffline(deviceId: string): void
  /** Wired to `SessionManagerDeps.onSessionEnded`; schedules a rebuild with backoff. */
  sessionEnded(deviceId: string, reason: string): void
  stateOf(deviceId: string): { state: DeviceBuildState; step: PrepStep | null; attempt: number; usbRoot: string | null }
  stats(): { running: number; queued: number; perRoot: Record<string, { running: number; queued: number }>; buildsPerUsbRoot: number; farmCeiling: number }
  /** Cancel every timer; resolves when no build is running. */
  stop(): Promise<void>
}

interface Record_ {
  state: DeviceBuildState
  step: PrepStep | null
  attempt: number
  failures: number
  usbRoot: string | null
  activityId: string | null
  timer: unknown
}

/** The activity sentence for a build state — shared with `ws-handlers.ts`'s `E_SESSION_PREPARING` message. */
export function buildSentence(info: { state: DeviceBuildState; step: PrepStep | null; attempt: number } | null): string {
  if (!info) return 'Preparing'
  if (info.state === 'recovering') return recoveringLabel(info.attempt)
  if (info.step) return prepLabel(info.step)
  return PREP_QUEUED_LABEL
}

/**
 * The builder: queues a build the instant a device comes online, staggers
 * it by USB root and a farm-wide ceiling, retries a dead or failed build
 * under backoff, and starts the inspector prewarm after the first frame
 * (plan 206 §4.2).
 */
export function createAlwaysOn(deps: AlwaysOnDeps): AlwaysOn {
  const timers = deps.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() }
  const records = new Map<string, Record_>()
  const running = new Set<string>()
  const queued: string[] = []
  let started = false
  let usbRootByDeviceId = new Map<string, string>()
  let usbRootCacheAt = 0
  const runningBuilds = new Set<Promise<void>>()

  function farmCeiling(): number {
    return deps.farmCeiling?.() ?? SESSION_BUILD_FARM_CEILING
  }

  function runningPerRoot(root: string): number {
    let count = 0
    for (const id of running) if ((records.get(id)?.usbRoot ?? UNKNOWN_ROOT) === root) count++
    return count
  }

  async function refreshUsbRoots(): Promise<void> {
    if (timers.now() - usbRootCacheAt < USB_ROOT_CACHE_MS) return
    usbRootCacheAt = timers.now()
    try {
      const list = await deps.listDevices()
      const next = new Map<string, string>()
      for (const d of list) next.set(d.serial, usbRootOf(d.usb))
      usbRootByDeviceId = next
    } catch (err) {
      deps.log.debug(`always-on: listDevices failed, grouping every pending device under ${UNKNOWN_ROOT} for this pass: ${String(err)}`)
      usbRootByDeviceId = new Map()
    }
  }

  function rootFor(deviceId: string): string {
    const row = deps.devices.get(deviceId)
    if (!row) return UNKNOWN_ROOT
    return usbRootByDeviceId.get(row.serial) ?? UNKNOWN_ROOT
  }

  function endActivity(record: Record_, deviceId: string): void {
    if (record.activityId) {
      deps.activities.end(deviceId, record.activityId)
      record.activityId = null
    }
  }

  function onFirstFrame(deviceId: string): void {
    const record = records.get(deviceId)
    if (!record) return
    record.state = 'ready'
    record.failures = 0
    record.attempt = 0
    endActivity(record, deviceId)
    timers.set(() => {
      const s = deps.sessions.get(deviceId)
      if (s && record.state === 'ready') void s.prewarmInspector().catch((err) => deps.log.warn(`inspector prewarm failed for ${deviceId}: ${String(err)}`))
    }, INSPECTOR_PREWARM_DELAY_MS)
  }

  function scheduleRebuild(deviceId: string, why: unknown): void {
    const record = records.get(deviceId)
    if (!record) return
    record.state = 'recovering'
    const delay = rebuildDelayMs(record.attempt)
    if (!record.activityId) {
      record.activityId = deps.activities.start(deviceId, { kind: 'prep', label: recoveringLabel(record.attempt), actor: ALWAYS_ON_ACTOR, meta: { recovering: true, attempt: record.attempt } })
    } else {
      deps.activities.update(deviceId, record.activityId, {
        label: recoveringLabel(record.attempt),
        meta: { recovering: true, attempt: record.attempt, nextRetryAt: timers.now() + delay, reason: String(why) },
      })
    }
    record.timer = timers.set(() => {
      record.state = 'queued'
      if (record.activityId) deps.activities.update(deviceId, record.activityId, { label: PREP_QUEUED_LABEL, meta: { recovering: true, attempt: record.attempt } })
      queued.push(deviceId)
      pump()
    }, delay)
  }

  async function runBuild(deviceId: string): Promise<void> {
    const record = records.get(deviceId)
    if (!record) return
    running.add(deviceId)
    const p = (async () => {
      try {
        await deps.sessions.build(deviceId, {
          requireScrcpy: record.failures < SCRCPY_FALLBACK_AFTER_FAILURES,
          onStep: (step) => {
            record.step = step
            if (record.activityId) deps.activities.update(deviceId, record.activityId, { label: prepLabel(step) })
            if (step === 5) onFirstFrame(deviceId)
          },
        })
      } catch (err) {
        record.failures++
        record.attempt++
        scheduleRebuild(deviceId, err)
      } finally {
        running.delete(deviceId)
        pump()
      }
    })()
    runningBuilds.add(p)
    void p.finally(() => runningBuilds.delete(p))
    await p
  }

  function pump(): void {
    if (!started) return
    void refreshUsbRoots().then(() => {
      queued.sort((a, b) => {
        const na = deps.deviceNumber(a)
        const nb = deps.deviceNumber(b)
        if (na === nb) return a < b ? -1 : a > b ? 1 : 0
        if (na === null) return 1
        if (nb === null) return -1
        return na - nb
      })
      for (const deviceId of [...queued]) {
        if (running.size >= farmCeiling()) return
        const root = rootFor(deviceId)
        if (root !== UNKNOWN_ROOT && runningPerRoot(root) >= deps.buildsPerUsbRoot()) continue
        const idx = queued.indexOf(deviceId)
        if (idx < 0) continue
        queued.splice(idx, 1)
        const record = records.get(deviceId)
        if (!record) continue
        record.state = 'preparing'
        record.usbRoot = root
        void runBuild(deviceId)
      }
    })
  }

  return {
    start() {
      if (started) return
      started = true
      pump()
    },

    deviceOnline(deviceId) {
      const existing = records.get(deviceId)
      if (existing && (existing.state === 'queued' || existing.state === 'preparing' || existing.state === 'ready')) return
      const activityId = deps.activities.start(deviceId, { kind: 'prep', label: PREP_QUEUED_LABEL, actor: ALWAYS_ON_ACTOR })
      records.set(deviceId, { state: 'queued', step: null, attempt: 0, failures: 0, usbRoot: null, activityId, timer: null })
      queued.push(deviceId)
      pump()
    },

    deviceOffline(deviceId) {
      const record = records.get(deviceId)
      if (!record) return
      if (record.timer) timers.clear(record.timer)
      endActivity(record, deviceId)
      records.delete(deviceId)
      const idx = queued.indexOf(deviceId)
      if (idx >= 0) queued.splice(idx, 1)
      running.delete(deviceId)
    },

    sessionEnded(deviceId, reason) {
      const record = records.get(deviceId)
      if (!record || record.state !== 'ready') return
      record.attempt++
      scheduleRebuild(deviceId, reason)
    },

    stateOf(deviceId) {
      const record = records.get(deviceId)
      if (!record) return { state: 'none', step: null, attempt: 0, usbRoot: null }
      return { state: record.state, step: record.step, attempt: record.attempt, usbRoot: record.usbRoot }
    },

    stats() {
      const perRoot: Record<string, { running: number; queued: number }> = {}
      for (const id of running) {
        const root = records.get(id)?.usbRoot ?? UNKNOWN_ROOT
        perRoot[root] ??= { running: 0, queued: 0 }
        perRoot[root].running++
      }
      for (const id of queued) {
        const root = rootFor(id)
        perRoot[root] ??= { running: 0, queued: 0 }
        perRoot[root].queued++
      }
      return { running: running.size, queued: queued.length, perRoot, buildsPerUsbRoot: deps.buildsPerUsbRoot(), farmCeiling: farmCeiling() }
    },

    async stop() {
      started = false
      for (const record of records.values()) if (record.timer) timers.clear(record.timer)
      await Promise.allSettled([...runningBuilds])
    },
  }
}
