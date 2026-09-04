import type { RecordingDoc, RecordingSettings, RecordingStepKind, UiNode } from '@enkaku/protocol'
import type { BlobStore } from '../agent/blob/store'
import type { Logger } from '../util/logger'
import { EnkakuError } from '../util/errors'
import { createRecordingSession, type RecordingSession } from './session'

/**
 * The recorder's per-farm registry (plan 94 §4.6, step 94.3) — one
 * `RecordingSession` at a time per device, owned by whoever controls that
 * device (enforced by `ws-handlers.ts`'s `admit()` gate, plan 205 §4.8, never
 * by this module). `ws-handlers.ts` is the ONLY caller; this file knows
 * nothing about WS messages, activities, or sessions — it is handed
 * everything a recording needs to run through `RecordingStartContext`.
 */

/** Per-device facts and capabilities `start()` needs — resolved by the caller (a real `DeviceSession`'s inspector, in production) so this module stays independent of `@enkaku/session`. */
export interface RecordingStartContext {
  recordedOn: { stableId: string; model: string; width: number; height: number }
  /** One `inspector.dump()` — `null` when no inspector is attached or the dump failed (logged once by the session, never a failed recording). */
  captureAnchor: () => Promise<{ root: UiNode; packageName: string } | null>
  /** One `inspector.screenshot()` (or an equivalent screencap) — `null` when unavailable. */
  captureScreenshot: () => Promise<Uint8Array | null>
}

export interface RecordingService {
  /**
   * `E_RECORDING_ACTIVE` when one is already open on this device (plan 94
   * §4.6) — never silently joined or restarted. `actor` (a user id, matching
   * every other `deps.recorder.record({actor, ...})` call this router
   * already makes) is accepted per §4.6's own interface sketch but not yet
   * threaded into the session itself — nothing inside `RecordingSession`
   * needs to know who is recording; it exists on this signature for the
   * caller (`ws-handlers.ts`) to fold into its own `recording.started`
   * event-log entry.
   */
  start(deviceId: string, actor: string | null, ctx: RecordingStartContext): RecordingSession
  get(deviceId: string): RecordingSession | null
  /** `E_NO_RECORDING` when nothing is open on this device. */
  stop(deviceId: string): Promise<RecordingDoc>
  cancel(deviceId: string): void
  /**
   * The document a BOUND (§4.6's `maxSteps`/`maxDurationSec`) most recently
   * finished on its own, keyed by device — extension beyond §4.6's own
   * interface sketch, flagged here rather than silently added: an explicit
   * `stop()` hands its caller the document directly, but a bound fires from
   * INSIDE the session with nobody awaiting a return value, so this is the
   * only way anything downstream (94.4's step strip, 94.5's review panel)
   * can retrieve what a bound-ended recording actually produced. Cleared the
   * next time `start()` opens a new recording on that device.
   */
  lastFinished(deviceId: string): RecordingDoc | null
  /**
   * The connection controlling this device just disconnected (plan 94 §4.6:
   * "In memory, keyed by deviceId, one at a time, owned by whoever controls
   * the device"). Ends any open recording exactly like a bound does
   * (`finishAndBuild`, then `onBoundStopped` with `reason: 'disconnected'`)
   * — a no-op when nothing is open on this device.
   */
  stopForDisconnect(deviceId: string): void
  /**
   * Registers the ONE listener for every finished step, across every device
   * (plan 94 §4.9) — `ws-handlers.ts` calls this once, at router
   * construction, and turns each call into a `recording.step` broadcast; the
   * same single-callback registration shape `CrashWatcher.onJobCrash`
   * (`../device/crash-watcher.ts`) already established for exactly this
   * "one router, one subscriber" relationship. A second call REPLACES the
   * first, never adds a second listener — there is only ever one router.
   */
  onStep(cb: (deviceId: string, index: number, kind: RecordingStepKind, hasCandidate: boolean) => void): void
  /**
   * Registers the ONE listener for a BOUND ending a recording on its own
   * (never an operator `stop`/`cancel`, which the caller already knows about
   * from its own reply) — `ws-handlers.ts` turns this into a `recording.state`
   * push naming the reason. `doc` is the document the bound just finished
   * building, so the listener needs no second lookup.
   */
  onBoundStopped(cb: (deviceId: string, reason: 'max-steps' | 'max-duration' | 'disconnected', doc: RecordingDoc) => void): void
}

export interface RecordingServiceDeps {
  /** Read fresh on every session start and on every anchor/bound check — never captured (the same freshness discipline every other farm setting in this codebase gets). */
  settings: () => RecordingSettings
  /** The shared content-addressed blob store (F16) — screenshots and anchor images go through this, never a second store. */
  blobs: BlobStore
  log: Logger
  /** Injectable for tests; defaults to the real clock/timers. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}

export function createRecordingService(deps: RecordingServiceDeps): RecordingService {
  const sessions = new Map<string, RecordingSession>()
  const lastFinishedByDevice = new Map<string, RecordingDoc>()
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h))
  let stepListener: ((deviceId: string, index: number, kind: RecordingStepKind, hasCandidate: boolean) => void) | null = null
  let boundListener: ((deviceId: string, reason: 'max-steps' | 'max-duration' | 'disconnected', doc: RecordingDoc) => void) | null = null

  /** Shared by a session's own bound stop and `stopForDisconnect` below — the only difference between them is which `reason` the listener is told. */
  const finishAndReport = (deviceId: string, session: RecordingSession, reason: 'max-steps' | 'max-duration' | 'disconnected'): void => {
    sessions.delete(deviceId)
    void session
      .finishAndBuild()
      .then((doc) => {
        lastFinishedByDevice.set(deviceId, doc)
        boundListener?.(deviceId, reason, doc)
      })
      .catch((err) => {
        deps.log.warn(`recording stop (${reason}) failed to build a document for ${deviceId}: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  return {
    start(deviceId, _actor, ctx) {
      if (sessions.has(deviceId)) {
        throw new EnkakuError('E_RECORDING_ACTIVE', `a recording is already open on ${deviceId}`)
      }
      lastFinishedByDevice.delete(deviceId)
      // Declared before construction so the `onBound` callback below can
      // close over it — a bound fires from a timer INSIDE the session
      // itself, with no caller waiting on a return value, so the service
      // has to reach back into the very session that just told it to stop.
      let session!: RecordingSession
      session = createRecordingSession({
        deviceId,
        startedAtMs: now(),
        recordedOn: ctx.recordedOn,
        settings: deps.settings,
        now,
        setTimer,
        clearTimer,
        captureAnchor: ctx.captureAnchor,
        captureScreenshot: ctx.captureScreenshot,
        blobs: deps.blobs,
        log: deps.log,
        onStep: (index, kind, hasCandidate) => stepListener?.(deviceId, index, kind, hasCandidate),
        // The session already stopped observing by the time this fires
        // (`stopForBound` sets its own `stopped` field first); `finishAndReport`
        // dropping it from `sessions` is what makes a fresh `recording.start`
        // possible right after a bound, with no explicit `stop()` needed.
        onBound: (reason) => finishAndReport(deviceId, session, reason),
      })
      sessions.set(deviceId, session)
      return session
    },

    get(deviceId) {
      return sessions.get(deviceId) ?? null
    },

    async stop(deviceId) {
      const session = sessions.get(deviceId)
      if (!session) throw new EnkakuError('E_NO_RECORDING', `no recording is open on ${deviceId}`)
      sessions.delete(deviceId)
      const doc = await session.finishAndBuild()
      lastFinishedByDevice.set(deviceId, doc)
      return doc
    },

    cancel(deviceId) {
      const session = sessions.get(deviceId)
      if (!session) return
      sessions.delete(deviceId)
      session.cancel()
    },

    lastFinished(deviceId) {
      return lastFinishedByDevice.get(deviceId) ?? null
    },

    stopForDisconnect(deviceId) {
      const session = sessions.get(deviceId)
      if (!session) return
      finishAndReport(deviceId, session, 'disconnected')
    },

    onStep(cb) {
      stepListener = cb
    },

    onBoundStopped(cb) {
      boundListener = cb
    },
  }
}
