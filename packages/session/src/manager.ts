import type { AdbClient } from '@enkaku/adb'
import type { FrameMeta, Quality, RotationMode, SessionPhase } from '@enkaku/protocol'
import { SessionError } from './errors'
import type { Logger } from './logger'
import type { RotationOutcome } from './orientation'
import { createSession, type CreateSessionDeps, type DeviceSession } from './session'
import type { DeviceSnapshotSource } from './types'
import { createVideoLatencyTracker, type VideoLatencySnapshot, type VideoLatencyTracker } from './video-latency'
import { sameVideoNumbers, type VideoProfile } from './video-profile'

/** One step of the five-step build sequence (plan 206 §3.3). */
export type PrepStep = 1 | 2 | 3 | 4 | 5

/** How long a control entry lingers after its last viewer detaches (plan 206 §3.4, MVP 11 §1.2). */
export const CONTROL_LINGER_MS = 15_000

export type FrameSink = (chunk: Uint8Array, meta: FrameMeta) => void

/**
 * `stream.start` at `control` quality attaches to the wall entry first and
 * switches once the control entry has produced its first keyframe (plan 206
 * §3.4). `onSwitched`/`onControlFailed` are called at most once, ever, for a
 * given attach.
 */
export interface ViewerHooks {
  /** The control entry produced its first keyframe and this viewer now receives its frames. */
  onSwitched?: (session: DeviceSession) => void
  /** The control build failed after `substitute: 'wall'` was reported; the viewer stays on the wall entry. */
  onControlFailed?: (reason: string) => void
}

export interface ViewerAttach {
  /** The session the viewer is receiving frames from RIGHT NOW. */
  session: DeviceSession
  /** The quality of `session`. */
  quality: Quality
  /** Set when a `control` request is being served by the wall entry while the control entry starts. */
  substitute?: 'wall'
  /** Set when a `control` request cannot ever get a control entry on this device (display engine is not scrcpy). */
  degradedReason?: 'control_encoder_unavailable'
  degradedDetail?: string
}

export type SessionState = 'none' | 'building' | 'ready'

export interface EncoderState {
  engine: 'scrcpy' | 'screencap-loop'
  maxSize: number
  maxFps: number
  bitRate: number
  viewers: number
  bytesPerSec: number
  framesPerSec: number
  sinceSec: number
  /** Unix seconds when the control linger closes the entry; null while it has viewers, and always null for `wall`. */
  lingerEndsAt: number | null
}

export interface EncoderReport {
  deviceId: string
  wall: EncoderState | null
  control: EncoderState | null
}

/** A 5s sliding window of dispatched frames, for `EncoderState.bytesPerSec`/`framesPerSec` (plan 206 §4.3). Pure, exported for the test. */
const RATE_WINDOW_MS = 5_000
export class RateMeter {
  private samples: Array<{ t: number; bytes: number }> = []
  private readonly openedAt: number
  constructor(now: () => number = Date.now) {
    this.now = now
    this.openedAt = now()
  }
  private readonly now: () => number

  private prune(t: number): void {
    while (this.samples.length > 0 && t - this.samples[0]!.t > RATE_WINDOW_MS) this.samples.shift()
  }

  record(bytes: number): void {
    const t = this.now()
    this.samples.push({ t, bytes })
    this.prune(t)
  }

  bytesPerSec(): number {
    const t = this.now()
    this.prune(t)
    if (this.samples.length === 0) return 0
    const totalBytes = this.samples.reduce((sum, s) => sum + s.bytes, 0)
    const spanSec = Math.max(1, (t - this.samples[0]!.t) / 1000)
    return totalBytes / spanSec
  }

  framesPerSec(): number {
    const t = this.now()
    this.prune(t)
    if (this.samples.length === 0) return 0
    const spanSec = Math.max(1, (t - this.samples[0]!.t) / 1000)
    return this.samples.length / spanSec
  }

  sinceSec(): number {
    return Math.max(0, Math.floor((this.now() - this.openedAt) / 1000))
  }
}
export function createRateMeter(now?: () => number): RateMeter {
  return new RateMeter(now)
}

interface Entry {
  deviceId: string
  quality: Quality
  session: DeviceSession
  /** Every sink dispatch reaches: job/readiness holders (`acquire`/`release`) plus every viewer (`attachViewer`/`detachViewer`). */
  frameSubscribers: Set<FrameSink>
  /** The subset of `frameSubscribers` that are WS viewers — never job/readiness sinks. Drives `EncoderState.viewers` and the control linger. */
  viewers: Set<FrameSink>
  /** Whether THIS entry ran the full device-prep sequence — false only for a fast-path `control` build. */
  ownsDevicePrep: boolean
  videoProfile: VideoProfile | null
  latency: VideoLatencyTracker
  rate: RateMeter
  /** Control entry only: true once its own first keyframe has been dispatched — gates the substitute→control switch. */
  live: boolean
  lingerTimer: unknown
  lingerEndsAt: number | null
  /** Plan 209 §4.9: the base (wall) entry's clipboard subscription unsubscribe, null on a control entry (only the base subscribes). */
  clipboardUnsubscribe: (() => void) | null
  /** Unix seconds this entry's forward was opened (plan 223 §4.3). Set once, when `createEntry` receives a `ready` session. */
  openedAt: number
}

export interface ForwardRecord {
  deviceId: string
  quality: Quality
  port: number
  scid: string
  /** Unix seconds this entry's forward was opened. */
  openedAt: number
}

export interface SessionManager {
  /**
   * Attach a frame subscriber to the device's BASE (wall) entry. Never
   * builds — throws `SessionError('device_not_ready', ..., { state })` when
   * there is none. Jobs, the readiness manager, and the capability path use
   * this (plan 206 §4.3).
   */
  acquire(deviceId: string, onFrame: FrameSink): Promise<DeviceSession>
  release(deviceId: string, onFrame: FrameSink): void
  /** Viewer attach (ws-handlers only). Throws `device_not_ready` with `details: { state }` when there is no base entry. */
  attachViewer(deviceId: string, quality: Quality, onFrame: FrameSink, hooks?: ViewerHooks): Promise<ViewerAttach>
  detachViewer(onFrame: FrameSink): void
  /** Build the base entry. Called by the always-on builder (and the node's `startSession`); coalesced per device. */
  build(deviceId: string, opts: { requireScrcpy: boolean; onStep?: (step: PrepStep) => void }): Promise<void>
  /** Resolves with the base session once a build in flight finishes; rejects `device_not_ready` when none is in flight and none exists. */
  whenReady(deviceId: string, timeoutMs?: number): Promise<DeviceSession>
  state(deviceId: string): SessionState
  /** Base entry, else control entry, else null (unchanged resolution for input callers). */
  get(deviceId: string): DeviceSession | null
  getByQuality(deviceId: string, quality: Quality): DeviceSession | null
  closeDevice(deviceId: string): Promise<void>
  closeAll(reason?: string): Promise<number>
  restartAt?(deviceId: string, quality: Quality, detail?: string): Promise<void>
  setRotation?(deviceId: string, mode: RotationMode): Promise<RotationOutcome | null>
  reprofile?(reason: string): Promise<{ restarted: string[]; skippedBusy: string[]; unchanged: number }>
  activeDeviceIds?(): string[]
  /** Encoder states per device, for `GET /api/video/sessions` and `/api/adb/stats`. */
  encoders(): EncoderReport[]
  /** Plan 203 §4.5: per-entry PTS statistics for `GET /api/video/latency`. */
  videoLatency?(deviceId: string): Array<{ quality: Quality; viewers: number } & VideoLatencySnapshot>
  /** Every live scrcpy forward this process currently holds, owner-tagged (plan 223 §4.2/§4.3) — the source for `GET /api/adb/stats`'s `forwards` block and for the soak's forward count. Entries with no scrcpy forward (screencap-loop) are simply absent, not reported with a null port. */
  forwards(): ForwardRecord[]
}

export interface SessionManagerDeps {
  client: AdbClient
  devices: DeviceSnapshotSource
  log: Logger
  makeInspector?: CreateSessionDeps['makeInspector']
  makeScrcpy?: CreateSessionDeps['makeScrcpy']
  /**
   * Plan 90 §3.2, §4.5, §5 step 90.5 — a farm-wide factory for a device-scoped guest-agent client
   * runner, called once per `createEntry` and handed straight to `createSession`'s own
   * `withGuestAgentClient`.
   */
  withGuestAgentClient?: (deviceId: string) => CreateSessionDeps['withGuestAgentClient']
  /** The BASE (wall) session died on its own (device unplugged, capture failed) — the always-on builder reacts by scheduling a rebuild (plan 206 §3.6). */
  onSessionEnded?: (deviceId: string, reason: string) => void
  /** Whether a job is currently running on this device (plan 205 §4.6) — read fresh by `reprofile`. */
  hasRunningJob?: (deviceId: string) => boolean
  /** Device event log: session.opened / session.closed / session.degraded (Plan 18 §4.2). */
  onEvent?: (deviceId: string, kind: string, meta: Record<string, unknown>) => void
  /** Plan 209 §3.2 D10, §4.9: a device-side copy on the BASE (wall) entry only. */
  onClipboardChanged?: (deviceId: string, text: string) => void
  arbiterQueueWaitMs?: () => number
  arbiterMaxQueueDepth?: () => number
  fallbackRetryCount?: () => number
  /**
   * Resolve this device's video profile at the requested quality (plan 92
   * §3.5, §4.2, §4.3) — farm settings plus any per-device override, read
   * fresh on every session build.
   */
  resolveProfile?: (deviceId: string, quality: Quality) => VideoProfile
  /**
   * Is this device's screen already being held awake by something OUTSIDE
   * this session build? (plan 125 §3.7, §4.5 — "one wake per session start,
   * and the readiness manager is the authority.") Read fresh at build time.
   */
  deviceIsAwake?: (deviceId: string) => boolean
  /** Test seam for the control entry's linger timer (plan 206 §3.4); defaults to real `setTimeout`/`clearTimeout`/`Date.now`. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void; now: () => number }
}

/** Plan 100 §4.2 — the composite map key: at most one entry per `(deviceId, quality)` pair. */
function entryKey(deviceId: string, quality: Quality): string {
  return `${deviceId}:${quality}`
}

const PHASE_STEP: Record<SessionPhase, PrepStep> = {
  connecting: 1,
  waking: 2,
  'starting-video': 3,
  'waiting-frame': 4,
  ready: 5,
}

/**
 * One `DeviceSession` per open `(deviceId, quality)` pair — at most two per
 * device (plan 206 §3.4): the base (`wall`) entry, built by the always-on
 * builder and living as long as the device is online, and the `control`
 * entry, built on demand and closed `CONTROL_LINGER_MS` after its last viewer
 * detaches.
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const entries = new Map<string, Entry>()
  /**
   * A subscriber (job/readiness sink or WS viewer sink) is only ever attached
   * to one entry at a time; this inverted index is what lets `release`/
   * `detachViewer` find the right one without trusting the caller to
   * re-supply the right quality.
   */
  const subscriberEntry = new Map<FrameSink, string>()
  const timers = deps.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() }
  /**
   * A `control` viewer attached before the control entry has a cached
   * keyframe sits on the BASE entry (substitute) with its hooks recorded
   * here, keyed by device — not by entry, since the control `Entry` object
   * may not exist yet while its build is still in flight. Drained by
   * `dispatchFrame` the moment the control entry's first keyframe arrives.
   */
  const pendingSwitches = new Map<string, Map<FrameSink, ViewerHooks>>()
  /** Builds in flight, keyed by `entryKey` — a `wall` build and a `control` build for the SAME device are independent. */
  const inFlight = new Map<string, Promise<Entry>>()
  /** Restarts in flight, keyed by `entryKey` (plan 92 §3.8, unchanged mechanism). */
  const upgrading = new Map<string, Promise<void>>()

  function attachSubscriber(key: string, entry: Entry, onFrame: FrameSink): void {
    entry.frameSubscribers.add(onFrame)
    subscriberEntry.set(onFrame, key)
  }

  function attachViewerSink(key: string, entry: Entry, onFrame: FrameSink): void {
    if (entry.lingerTimer) {
      timers.clear(entry.lingerTimer)
      entry.lingerTimer = null
      entry.lingerEndsAt = null
    }
    entry.frameSubscribers.add(onFrame)
    entry.viewers.add(onFrame)
    subscriberEntry.set(onFrame, key)
  }

  const dispatchFrame = (key: string) => (chunk: Uint8Array, meta: FrameMeta) => {
    const entry = entries.get(key)
    if (!entry) return
    entry.latency.record(meta)
    entry.rate.record(chunk.byteLength)
    if (entry.quality === 'control' && !entry.live && meta.keyframe && entry.session.videoKeyframe?.()) {
      entry.live = true
      const pendings = pendingSwitches.get(entry.deviceId)
      if (pendings && pendings.size > 0) {
        const baseEntry = entries.get(entryKey(entry.deviceId, 'wall'))
        for (const [sink, hooks] of pendings) {
          if (baseEntry) {
            baseEntry.frameSubscribers.delete(sink)
            baseEntry.viewers.delete(sink)
          }
          entry.frameSubscribers.add(sink)
          entry.viewers.add(sink)
          subscriberEntry.set(sink, key)
          hooks.onSwitched?.(entry.session)
        }
        pendingSwitches.delete(entry.deviceId)
      }
    }
    for (const cb of entry.frameSubscribers) cb(chunk, meta)
  }

  async function closeEntry(key: string, reason = 'released'): Promise<void> {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    if (entry.lingerTimer) timers.clear(entry.lingerTimer)
    entry.clipboardUnsubscribe?.()
    for (const sub of entry.frameSubscribers) subscriberEntry.delete(sub)
    await entry.session.close().catch((err) => deps.log.warn(`failed to close session ${entry.deviceId}: ${String(err)}`))
    deps.onEvent?.(entry.deviceId, 'session.closed', { reason })
    deps.log.info(`session closed: ${entry.deviceId} (${entry.quality})`)
  }

  /**
   * Build one session for `(deviceId, quality)`. `onStep` is fed only by the
   * always-on builder's own `build()` call (base entries); a control
   * fast-path build, and a `restartAt`/`reprofile` rebuild, pass none.
   */
  async function createEntry(
    deviceId: string,
    quality: Quality,
    fastOpts: { skipDevicePrep?: boolean; requireScrcpy?: boolean } = {},
    onStep?: (step: PrepStep) => void,
  ): Promise<Entry> {
    const row = deps.devices.get(deviceId)
    if (!row) throw new SessionError('device_not_found', `no such device: ${deviceId}`)
    if (row.status === 'offline') {
      throw new SessionError('device_not_ready', `device ${row.label} is offline`, { state: 'none' })
    }

    const key = entryKey(deviceId, quality)
    // Assigned as soon as createSession resolves; onDisplayError compares
    // against it to tell "my session died" from "some other session died".
    let created: DeviceSession | null = null
    const onPhase = onStep ? (phase: SessionPhase) => onStep(PHASE_STEP[phase]) : undefined
    const videoProfile = deps.resolveProfile ? deps.resolveProfile(deviceId, quality) : null
    const session = await createSession(
      {
        deviceId,
        serial: row.serial,
        stableId: row.stableId,
        transport: row.transport,
        display: row.display,
        input: row.input,
        inspection: row.inspection,
        apiLevel: row.apiLevel,
        preferredInputMode: row.preferredInputMode,
        ...(row.keepAwake !== undefined ? { keepAwake: row.keepAwake } : {}),
        ...(row.standbyScreenOff !== undefined ? { standbyScreenOff: row.standbyScreenOff } : {}),
        ...(row.rotation !== undefined ? { rotation: row.rotation } : {}),
        ...(row.textInput !== undefined ? { textInput: row.textInput } : {}),
        ...(row.tagTraffic !== undefined ? { tagTraffic: row.tagTraffic } : {}),
        screenW: row.screenW,
        screenH: row.screenH,
        quality,
        ...(videoProfile ? { videoProfile } : {}),
        ...(deps.deviceIsAwake?.(deviceId) ? { skipWake: true } : {}),
        ...(fastOpts.skipDevicePrep ? { skipDevicePrep: true } : {}),
        ...(fastOpts.requireScrcpy ? { requireScrcpy: true } : {}),
      },
      {
        client: deps.client,
        log: deps.log.child(`session:${row.label}`),
        onFrame: dispatchFrame(key),
        onDisplayError: (err) => {
          const reason = err instanceof Error ? err.message : String(err)
          const current = entries.get(key)?.session
          if (current !== undefined && current !== created) {
            deps.log.debug(`ignoring a display error from a session no longer in use on ${deviceId} (${quality}): ${reason}`)
            return
          }
          deps.log.warn(`display error on ${deviceId} (${quality}): ${reason} — closing the session`)
          if (quality === 'wall') {
            // The base entry owns device prep; without it the control entry
            // (if any) has nothing left backing it (plan 206 §4.3).
            deps.onSessionEnded?.(deviceId, reason)
            void closeEntry(key, reason)
            const controlKey = entryKey(deviceId, 'control')
            if (entries.has(controlKey)) void closeEntry(controlKey, 'base_gone')
            pendingSwitches.delete(deviceId)
          } else {
            // A control entry died: its live viewers keep their picture by
            // falling back to the base entry (never re-announced as a
            // switch — `hooks.onSwitched` is not called); any sink still
            // waiting on a switch is told the control build failed.
            const dying = entries.get(key)
            void closeEntry(key, reason)
            const baseEntry = entries.get(entryKey(deviceId, 'wall'))
            if (dying && baseEntry) {
              for (const sink of dying.viewers) {
                baseEntry.frameSubscribers.add(sink)
                baseEntry.viewers.add(sink)
                subscriberEntry.set(sink, entryKey(deviceId, 'wall'))
              }
            }
            const pendings = pendingSwitches.get(deviceId)
            if (pendings) {
              for (const hooks of pendings.values()) hooks.onControlFailed?.(reason)
              pendingSwitches.delete(deviceId)
            }
          }
        },
        ...(deps.makeInspector ? { makeInspector: deps.makeInspector } : {}),
        ...(deps.makeScrcpy ? { makeScrcpy: deps.makeScrcpy } : {}),
        ...(deps.withGuestAgentClient ? { withGuestAgentClient: deps.withGuestAgentClient(deviceId) } : {}),
        ...(deps.arbiterQueueWaitMs ? { arbiterQueueWaitMs: deps.arbiterQueueWaitMs } : {}),
        ...(deps.arbiterMaxQueueDepth ? { arbiterMaxQueueDepth: deps.arbiterMaxQueueDepth } : {}),
        ...(deps.fallbackRetryCount ? { fallbackRetryCount: deps.fallbackRetryCount } : {}),
        ...(onPhase ? { onPhase } : {}),
        onInputDegraded: (from, to, reason) => deps.onEvent?.(deviceId, 'session.degraded', { from, to, reason }),
      },
    )
    created = session
    const entry: Entry = {
      deviceId,
      quality,
      session,
      frameSubscribers: new Set(),
      viewers: new Set(),
      ownsDevicePrep: !fastOpts.skipDevicePrep,
      videoProfile,
      latency: createVideoLatencyTracker({ startedAt: Date.now() }),
      rate: createRateMeter(timers.now),
      live: false,
      lingerTimer: null,
      lingerEndsAt: null,
      // Plan 209 §3.2 D10, §4.9: only the base (wall) entry's scrcpy session is
      // subscribed, so a device with both encoders running pushes once.
      clipboardUnsubscribe: quality === 'wall' && deps.onClipboardChanged ? session.onClipboardChanged((text) => deps.onClipboardChanged!(deviceId, text)) : null,
      openedAt: Math.floor(timers.now() / 1000),
    }
    entries.set(key, entry)
    await session.display.start()
    onPhase?.('waiting-frame')
    deps.onEvent?.(deviceId, 'session.opened', {
      display: session.displayEngineId,
      input: session.inputEngineId,
      inspection: row.inspection ?? 'ui-server',
      quality: session.quality,
    })
    const rotationOutcome = session.rotation?.outcome
    if (rotationOutcome && !rotationOutcome.applied) {
      deps.onEvent?.(deviceId, 'device.rotation', {
        mode: rotationOutcome.mode,
        applied: false,
        reason: rotationOutcome.reason ?? 'the device did not accept the rotation lock',
        quality,
      })
    }
    deps.log.info(`session opened: ${row.label} (${deviceId}) at ${quality}`)
    return entry
  }

  function state(deviceId: string): SessionState {
    const key = entryKey(deviceId, 'wall')
    if (entries.has(key)) return 'ready'
    if (inFlight.has(key)) return 'building'
    return 'none'
  }

  /** Coalesced through `inFlight`. A build on a device that already has a base entry resolves immediately. */
  async function build(deviceId: string, opts: { requireScrcpy: boolean; onStep?: (step: PrepStep) => void }): Promise<void> {
    const key = entryKey(deviceId, 'wall')
    if (entries.has(key)) return
    let pending = inFlight.get(key)
    if (!pending) {
      pending = createEntry(deviceId, 'wall', { requireScrcpy: opts.requireScrcpy }, opts.onStep)
      inFlight.set(key, pending)
      void pending.catch(() => undefined).finally(() => inFlight.delete(key))
    }
    await pending
  }

  async function whenReady(deviceId: string, timeoutMs?: number): Promise<DeviceSession> {
    const key = entryKey(deviceId, 'wall')
    const existing = entries.get(key)
    if (existing) return existing.session
    const pending = inFlight.get(key)
    if (!pending) throw new SessionError('device_not_ready', `no base session for ${deviceId}`, { state: state(deviceId) })
    if (!timeoutMs) return (await pending).session
    let timer: unknown
    try {
      return await Promise.race([
        pending.then((entry) => entry.session),
        new Promise<never>((_, reject) => {
          timer = timers.set(
            () => reject(new SessionError('device_not_ready', `timed out waiting for the base session for ${deviceId}`, { state: state(deviceId) })),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timer) timers.clear(timer)
    }
  }

  /** Ensures a control build is running for this device, coalesced through `inFlight`. Notifies any pending switch on failure. */
  function ensureControlBuilding(deviceId: string): void {
    const key = entryKey(deviceId, 'control')
    if (entries.has(key) || inFlight.has(key)) return
    const pending = createEntry(deviceId, 'control', { skipDevicePrep: true, requireScrcpy: true })
    inFlight.set(key, pending)
    pending
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err)
        const pendings = pendingSwitches.get(deviceId)
        if (pendings) {
          for (const hooks of pendings.values()) hooks.onControlFailed?.(reason)
          pendingSwitches.delete(deviceId)
        }
      })
      .finally(() => inFlight.delete(key))
  }

  async function restartAt(deviceId: string, quality: Quality, detail?: string): Promise<void> {
    const key = entryKey(deviceId, quality)
    if (!entries.has(key)) return
    let pending = upgrading.get(key)
    if (!pending) {
      pending = (async () => {
        const old = entries.get(key)
        if (!old) return
        entries.delete(key)
        if (old.lingerTimer) timers.clear(old.lingerTimer)
        await old.session.close().catch((err) => deps.log.warn(`failed to close session ${deviceId}: ${String(err)}`))
        deps.onEvent?.(deviceId, 'session.closed', { reason: detail ? 'video_reprofile' : 'quality_upgrade' })
        const fresh = await createEntry(deviceId, quality, quality === 'control' ? { skipDevicePrep: true, requireScrcpy: true } : { requireScrcpy: true })
        for (const sub of old.frameSubscribers) {
          fresh.frameSubscribers.add(sub)
          subscriberEntry.set(sub, key)
        }
        for (const sub of old.viewers) fresh.viewers.add(sub)
        entries.set(key, fresh)
      })()
      upgrading.set(key, pending)
      void pending.finally(() => upgrading.delete(key))
    }
    await pending
  }

  function encoderStateOf(entry: Entry | undefined): EncoderState | null {
    if (!entry) return null
    const profile = entry.videoProfile
    return {
      engine: entry.session.displayEngineId === 'scrcpy' ? 'scrcpy' : 'screencap-loop',
      maxSize: profile?.maxSize ?? 0,
      maxFps: profile?.maxFps ?? 0,
      bitRate: profile?.bitRate ?? 0,
      viewers: entry.viewers.size,
      bytesPerSec: entry.rate.bytesPerSec(),
      framesPerSec: entry.rate.framesPerSec(),
      sinceSec: entry.rate.sinceSec(),
      lingerEndsAt: entry.lingerEndsAt,
    }
  }

  return {
    async acquire(deviceId, onFrame) {
      const key = entryKey(deviceId, 'wall')
      let entry = entries.get(key)
      if (!entry) {
        // Never builds — but a build already in flight (the always-on
        // builder, or a concurrent caller) is worth awaiting rather than
        // refusing a caller that arrived a moment too early (plan 206 §4.3).
        const pending = inFlight.get(key)
        if (!pending) throw new SessionError('device_not_ready', `no base session for ${deviceId}`, { state: state(deviceId) })
        entry = await pending
      }
      attachSubscriber(key, entry, onFrame)
      return entry.session
    },

    release(deviceId, onFrame) {
      const key = subscriberEntry.get(onFrame)
      const entry = key ? entries.get(key) : undefined
      if (!key || !entry) return
      subscriberEntry.delete(onFrame)
      entry.frameSubscribers.delete(onFrame)
      entry.viewers.delete(onFrame)
    },

    async attachViewer(deviceId, quality, onFrame, hooks) {
      const baseKey = entryKey(deviceId, 'wall')
      const base = entries.get(baseKey)
      if (!base) throw new SessionError('device_not_ready', `no base session for ${deviceId}`, { state: state(deviceId) })
      if (quality === 'wall') {
        attachViewerSink(baseKey, base, onFrame)
        return { session: base.session, quality: 'wall' }
      }
      const row = deps.devices.get(deviceId)
      if (base.session.displayEngineId !== 'scrcpy' || row?.display === 'screencap-loop') {
        attachViewerSink(baseKey, base, onFrame)
        return {
          session: base.session,
          quality: 'wall',
          degradedReason: 'control_encoder_unavailable',
          degradedDetail: 'this device cannot run a second, concurrent scrcpy encoder',
        }
      }
      const controlKey = entryKey(deviceId, 'control')
      const control = entries.get(controlKey)
      if (control && control.live) {
        attachViewerSink(controlKey, control, onFrame)
        return { session: control.session, quality: 'control' }
      }
      attachViewerSink(baseKey, base, onFrame)
      if (hooks) {
        let pendings = pendingSwitches.get(deviceId)
        if (!pendings) {
          pendings = new Map()
          pendingSwitches.set(deviceId, pendings)
        }
        pendings.set(onFrame, hooks)
      }
      ensureControlBuilding(deviceId)
      return { session: base.session, quality: 'wall', substitute: 'wall' }
    },

    detachViewer(onFrame) {
      const key = subscriberEntry.get(onFrame)
      if (!key) return
      const entry = entries.get(key)
      subscriberEntry.delete(onFrame)
      if (!entry) return
      entry.frameSubscribers.delete(onFrame)
      entry.viewers.delete(onFrame)
      const pendings = pendingSwitches.get(entry.deviceId)
      if (pendings) {
        pendings.delete(onFrame)
        if (pendings.size === 0) pendingSwitches.delete(entry.deviceId)
      }
      if (entry.quality === 'control' && entry.viewers.size === 0) {
        const stillPending = pendingSwitches.get(entry.deviceId)
        if (!stillPending || stillPending.size === 0) {
          entry.lingerEndsAt = Math.floor(timers.now() / 1000) + Math.floor(CONTROL_LINGER_MS / 1000)
          entry.lingerTimer = timers.set(() => void closeEntry(key, 'control_linger'), CONTROL_LINGER_MS)
        }
      }
    },

    build,
    whenReady,
    state,

    get(deviceId) {
      return entries.get(entryKey(deviceId, 'control'))?.session ?? entries.get(entryKey(deviceId, 'wall'))?.session ?? null
    },

    getByQuality(deviceId, quality) {
      return entries.get(entryKey(deviceId, quality))?.session ?? null
    },

    restartAt,

    async setRotation(deviceId, mode) {
      const open = [...entries.values()].filter((e) => e.deviceId === deviceId)
      const entry = open.find((e) => e.ownsDevicePrep) ?? open[0]
      const lock = entry?.session.rotation
      if (!entry || !lock) return null
      const outcome = await lock.set(mode)
      if (!outcome.applied) {
        deps.onEvent?.(deviceId, 'device.rotation', {
          mode,
          applied: false,
          reason: outcome.reason ?? 'the device did not accept the rotation lock',
          quality: entry.quality,
        })
      }
      return outcome
    },

    async reprofile(reason) {
      const restartedIds = new Set<string>()
      const skippedBusyIds = new Set<string>()
      let unchanged = 0
      if (!deps.resolveProfile) return { restarted: [], skippedBusy: [], unchanged }
      const resolveProfile = deps.resolveProfile
      deps.log.info(`reprofile: ${reason}`)
      const restarts: Promise<void>[] = []
      for (const key of [...entries.keys()]) {
        const entry = entries.get(key)
        if (!entry) continue
        const deviceId = entry.deviceId
        if (deps.hasRunningJob?.(deviceId)) {
          skippedBusyIds.add(deviceId)
          continue
        }
        const quality = entry.quality
        if (!entry.videoProfile) continue
        const fresh = resolveProfile(deviceId, quality)
        if (sameVideoNumbers(entry.videoProfile, fresh)) {
          unchanged++
          continue
        }
        restartedIds.add(deviceId)
        restarts.push(restartAt(deviceId, quality, 'applying new video settings'))
      }
      await Promise.all(restarts)
      return { restarted: [...restartedIds], skippedBusy: [...skippedBusyIds], unchanged }
    },

    async closeDevice(deviceId) {
      const keys = [...entries.entries()].filter(([, e]) => e.deviceId === deviceId).map(([key]) => key)
      pendingSwitches.delete(deviceId)
      await Promise.all(keys.map((key) => closeEntry(key, 'device_gone')))
    },

    async closeAll(reason = 'shutdown') {
      const keys = [...entries.keys()]
      pendingSwitches.clear()
      await Promise.all(keys.map((key) => closeEntry(key, reason)))
      return keys.length
    },

    activeDeviceIds() {
      return [...new Set([...entries.values()].map((e) => e.deviceId))]
    },

    encoders() {
      const deviceIds = new Set<string>()
      for (const entry of entries.values()) deviceIds.add(entry.deviceId)
      return [...deviceIds].map((deviceId) => ({
        deviceId,
        wall: encoderStateOf(entries.get(entryKey(deviceId, 'wall'))),
        control: encoderStateOf(entries.get(entryKey(deviceId, 'control'))),
      }))
    },

    videoLatency(deviceId) {
      const rows: Array<{ quality: Quality; viewers: number } & VideoLatencySnapshot> = []
      for (const entry of entries.values()) {
        if (entry.deviceId !== deviceId) continue
        rows.push({ quality: entry.quality, viewers: entry.viewers.size, ...entry.latency.snapshot() })
      }
      return rows
    },

    forwards() {
      const rows: ForwardRecord[] = []
      for (const entry of entries.values()) {
        if (entry.session.forwardPort === null) continue
        rows.push({
          deviceId: entry.deviceId,
          quality: entry.quality,
          port: entry.session.forwardPort,
          scid: entry.session.scrcpyScid ?? '',
          openedAt: entry.openedAt,
        })
      }
      return rows
    },
  }
}
