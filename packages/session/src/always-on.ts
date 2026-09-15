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
/**
 * How long a built session may sit at `waiting-frame` before the build is
 * called a failure.
 *
 * `SessionManager.build()` RESOLVES at step 4: it starts the display and
 * returns. Step 5 (`ready`) is emitted from the first-frame handler in
 * `session.ts`, so a device that never produces a frame leaves the record at
 * `preparing` with nothing left to move it — `runBuild`'s catch never fires,
 * no rebuild is scheduled, and no timer exists. The device sits at
 * "Preparing, step 4 of 5" for the life of the core, its screen never
 * appears, and `retry-prepare` is refused BY that activity: the only way out
 * is blocked by the thing you are trying to get out of (owner's emulator,
 * 2026-09-06).
 *
 * Generous on purpose. A healthy scrcpy first frame arrives in well under a
 * second; a cold-booted emulator or a phone waking from deep sleep can take
 * several. Anything past this is not slow, it is not coming.
 */
export const FIRST_FRAME_TIMEOUT_MS = 30_000
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

/**
 * ± this fraction is added to every rebuild delay.
 *
 * Without it, a USB hub that drops twenty phones at once schedules twenty
 * rebuilds on the SAME millisecond, and they reach the per-root and farm caps
 * as one wave, retry as one wave, and fail as one wave. Spread by ±30%, the
 * 1 s rung lands anywhere in 0.7–1.3 s and the 30 s rung in 21–39 s.
 */
export const REBUILD_JITTER = 0.3

/**
 * Backoff for the n-th consecutive failure (1-based); the last value repeats.
 * `rng` returns [0, 1); 0.5 is the unjittered midpoint, which is the default
 * so a caller without an rng (and every test that asserts the schedule) sees
 * the documented numbers.
 */
export function rebuildDelayMs(attempt: number, rng: () => number = () => 0.5): number {
  const base = REBUILD_BACKOFF_MS[Math.min(attempt, REBUILD_BACKOFF_MS.length) - 1] ?? REBUILD_BACKOFF_MS[REBUILD_BACKOFF_MS.length - 1]!
  const spread = (Math.min(Math.max(rng(), 0), 1) * 2 - 1) * REBUILD_JITTER
  return Math.round(base * (1 + spread))
}

/**
 * Where a RECOVERING build is, for the words over the tile (Studio's
 * `device-state.ts`). `queued` covers both the backoff wait and the wait for
 * a build slot — from the tile's point of view both are "not started yet".
 * `building` is steps 1–3, `waiting-frame` is step 4: the scrcpy server is up
 * and the picture has not arrived.
 */
export type RecoveryStep = 'queued' | 'building' | 'waiting-frame'

export function recoveryStepOf(step: PrepStep): RecoveryStep {
  return step >= 4 ? 'waiting-frame' : 'building'
}

/** The pump's sort key: device number ascending, unnumbered devices last, then id. */
interface BuildKey {
  number: number | null
  id: string
}

function compareBuildKeys(a: BuildKey, b: BuildKey): number {
  if (a.number !== b.number) {
    if (a.number === null) return 1
    if (b.number === null) return -1
    return a.number - b.number
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The order the pump offers queued devices to the build slots: device-number
 * order, ROTATED to start just after the last device that was given a slot.
 *
 * Plain number order meant every pass started from #1, so under a mass
 * reconnect the low numbers took every freed slot first, every time, and #70
 * waited behind devices that had already been rebuilt twice. Rotating from a
 * cursor is round-robin: nobody is skipped twice in a row, the per-root and
 * farm caps are untouched, and a boot (no cursor yet) still builds #1 first.
 * Pure, exported for the test.
 */
export function rebuildOrder(ids: readonly string[], numberOf: (id: string) => number | null, after: BuildKey | null): string[] {
  const keyed = ids.map((id) => ({ id, number: numberOf(id) })).sort(compareBuildKeys)
  if (!after) return keyed.map((k) => k.id)
  const pivot = keyed.findIndex((k) => compareBuildKeys(k, after) > 0)
  if (pivot <= 0) return keyed.map((k) => k.id)
  return [...keyed.slice(pivot), ...keyed.slice(0, pivot)].map((k) => k.id)
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
  /** [0, 1) source for the rebuild jitter (`REBUILD_JITTER`); default `Math.random`. A test passes `() => 0.5` for the exact schedule. */
  rng?: () => number
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
  /** The `FIRST_FRAME_TIMEOUT_MS` deadline armed once `build()` resolves, cleared by the first frame. */
  frameTimer: unknown
  /** The last `meta.step` written to the activity, so a build does not re-broadcast the same step for every phase. */
  recoveryStep: RecoveryStep | null
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
  const rng = deps.rng ?? Math.random
  /** The last device given a build slot — `rebuildOrder` starts the next pass just after it. */
  let lastStarted: BuildKey | null = null

  /**
   * Write where a recovering build is into its activity (`meta.step`). Only
   * for a recovery (`attempt > 0`): a first build has no `recovering` meta and
   * Studio renders it as preparing, not reconnecting. The whole meta is
   * written every time because the activity registry replaces `meta`, it does
   * not merge it.
   */
  function markRecoveryStep(deviceId: string, record: Record_, step: RecoveryStep): void {
    if (!record.activityId || record.attempt <= 0) return
    if (record.recoveryStep === step) return
    record.recoveryStep = step
    deps.activities.update(deviceId, record.activityId, { meta: { recovering: true, attempt: record.attempt, step } })
  }

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

  /** Disarm the first-frame deadline — the frame came, or the device went away. */
  function clearFrameDeadline(record: Record_): void {
    if (record.frameTimer !== null && record.frameTimer !== undefined) {
      timers.clear(record.frameTimer)
      record.frameTimer = null
    }
  }

  function onFirstFrame(deviceId: string): void {
    const record = records.get(deviceId)
    if (!record) return
    clearFrameDeadline(record)
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
    if (record) clearFrameDeadline(record)
    if (!record) return
    record.state = 'recovering'
    const delay = rebuildDelayMs(record.attempt, rng)
    record.recoveryStep = 'queued'
    if (!record.activityId) {
      record.activityId = deps.activities.start(deviceId, { kind: 'prep', label: recoveringLabel(record.attempt), actor: ALWAYS_ON_ACTOR, meta: { recovering: true, attempt: record.attempt, step: 'queued' } })
    } else {
      deps.activities.update(deviceId, record.activityId, {
        label: recoveringLabel(record.attempt),
        meta: { recovering: true, attempt: record.attempt, step: 'queued', nextRetryAt: timers.now() + delay, reason: String(why) },
      })
    }
    if (record.timer) timers.clear(record.timer)
    record.timer = timers.set(() => {
      record.timer = null
      // The record may have been replaced or dropped while this waited
      // (`deviceOffline`, or `deviceOnline` cutting the backoff short).
      if (records.get(deviceId) !== record || record.state !== 'recovering') return
      record.state = 'queued'
      if (record.activityId) deps.activities.update(deviceId, record.activityId, { label: PREP_QUEUED_LABEL, meta: { recovering: true, attempt: record.attempt, step: 'queued' } })
      if (!queued.includes(deviceId)) queued.push(deviceId)
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
            else markRecoveryStep(deviceId, record, recoveryStepOf(step))
          },
        })
        /*
          `build()` returned, which means the display started — NOT that a
          frame arrived. Only the first frame emits step 5, and until this
          deadline existed there was nothing else that could ever move the
          record off `preparing`. Arm it unless the frame already beat us
          here (the common case, and why this is a check rather than an
          unconditional set).

          A timeout is routed through `scheduleRebuild`, so it inherits the
          ladder that already exists: backoff, a visible "Recovering,
          attempt N", and `SCRCPY_FALLBACK_AFTER_FAILURES` dropping
          `requireScrcpy` after four tries — which is exactly the escape a
          device whose encoder produces nothing needs.
        */
        if (record.state !== 'ready') {
          record.frameTimer = timers.set(() => {
            record.frameTimer = null
            const live = records.get(deviceId)
            if (!live || live.state === 'ready') return
            live.failures++
            live.attempt++
            deps.log.warn(`always-on: device ${deviceId} produced no first frame within ${FIRST_FRAME_TIMEOUT_MS}ms — rebuilding`)
            // `SessionManager.build()` resolves immediately once its entry
            // already exists (session.ts) — without closing it first, the
            // next `build()` reuses this same frameless entry, never runs a
            // fresh build, never emits step 5 again, and this deadline fires
            // forever against a scrcpy server nobody ever told to stop
            // (owner's moto g06, 2026-09-11: "Recovering, attempt N" looping
            // for 15 minutes with the same device-side process still alive).
            void deps.sessions
              .closeDevice(deviceId)
              .catch((err) => deps.log.warn(`always-on: failed to close the stuck session for ${deviceId} before rebuilding: ${String(err)}`))
              .finally(() => scheduleRebuild(deviceId, new Error(`no first frame within ${FIRST_FRAME_TIMEOUT_MS}ms`)))
          }, FIRST_FRAME_TIMEOUT_MS)
        }
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
      for (const deviceId of rebuildOrder(queued, deps.deviceNumber, lastStarted)) {
        if (running.size >= farmCeiling()) return
        // Never two builds for one device: a device can only be queued once
        // (`scheduleRebuild`/`deviceOnline` guard the push), but a build that
        // is still running must not be started again underneath itself.
        if (running.has(deviceId)) continue
        const root = rootFor(deviceId)
        if (root !== UNKNOWN_ROOT && runningPerRoot(root) >= deps.buildsPerUsbRoot()) continue
        const idx = queued.indexOf(deviceId)
        if (idx < 0) continue
        queued.splice(idx, 1)
        const record = records.get(deviceId)
        if (!record) continue
        lastStarted = { number: deps.deviceNumber(deviceId), id: deviceId }
        record.state = 'preparing'
        record.usbRoot = root
        markRecoveryStep(deviceId, record, 'building')
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
      if (existing && existing.state === 'recovering') {
        /*
          The device came back (a USB flap inside the offline grace) while
          its rebuild was waiting out a backoff. That is fresh evidence the
          link is up, so the wait is cut short — but the SAME record is kept.

          This used to fall through and replace the record while the old
          backoff timer was still armed. The timer then fired against the
          replaced record, pushed the device into the queue a second time,
          and the second "build" resolved at once against the session the
          first had just made — with no step 5, so the first-frame deadline
          armed, fired 30 s later, closed a HEALTHY session and started
          "Reconnecting · 1" all over again.
        */
        if (existing.timer) timers.clear(existing.timer)
        existing.timer = null
        existing.state = 'queued'
        markRecoveryStep(deviceId, existing, 'queued')
        if (!queued.includes(deviceId)) queued.push(deviceId)
        pump()
        return
      }
      const activityId = deps.activities.start(deviceId, { kind: 'prep', label: PREP_QUEUED_LABEL, actor: ALWAYS_ON_ACTOR })
      records.set(deviceId, { state: 'queued', step: null, attempt: 0, failures: 0, usbRoot: null, activityId, timer: null, frameTimer: null, recoveryStep: null })
      if (!queued.includes(deviceId)) queued.push(deviceId)
      pump()
    },

    deviceOffline(deviceId) {
      const record = records.get(deviceId)
      if (!record) return
      if (record.timer) timers.clear(record.timer)
      // The record is about to be deleted; a live frame deadline would fire
      // against a device that is gone and schedule a rebuild for it.
      clearFrameDeadline(record)
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
