import {
  RecordingDocSchema,
  type NormGestureSample,
  type NormPoint,
  type RecordingCandidate,
  type RecordingDoc,
  type RecordingStep,
  type RecordingStepKind,
  type UiNode,
} from '@enkaku/protocol'
import type { RecordingSettings } from '@enkaku/protocol'
import type { Logger } from '../util/logger'
import { anchorDue, mapNormToPixels, proposeCandidateSelector } from './anchors'
import { blobIdFor, sniffImageMediaType, type BlobStore } from '../agent/blob/store'

/**
 * The recorder's session (plan 94 §4.6, step 94.3) — one instance per
 * device, holding a recording open between `recording.start` and
 * `recording.stop`/`.cancel`. `RecordingService` (`./service.ts`) is the
 * per-farm registry keyed by deviceId; this file is the state machine for
 * ONE recording.
 *
 * **Never a second permission check** (plan 94's own brief): this module
 * never asks whether input is allowed. `observe()` is called from
 * `ws-handlers.ts`'s `input.*` branch AFTER `checkInputAllowed` has already
 * passed and the real device call is about to happen — the same placement
 * `deps.recorder.record(...)` (the event log) already uses, so a rejected
 * input is never recorded here either (§4.6).
 *
 * **The tee must observe, never alter** (plan 94's property 1): `observe()`
 * is synchronous and returns `void`. Every genuinely async piece of work it
 * starts — an anchor dump, a step screenshot — runs in the background,
 * tracked in `pending` so `finishAndBuild()` can wait for it, and is never on
 * the critical path the real device call sits on.
 */

/** What the tee hands `observe()` — the SAME normalised shape the manual WS input messages already carry (F2), never device pixels, so a recording built from it needs no rescaling. */
export type ObservedInput =
  | { kind: 'tap'; pos: NormPoint; holdMs?: number }
  | { kind: 'swipe'; from: NormPoint; to: NormPoint; durationMs: number }
  | { kind: 'gesture'; samples: NormGestureSample[] }
  | { kind: 'key'; keycode: number }
  | { kind: 'text'; text: string }

/** One anchor dump, kept until superseded by a fresher one or the recording ends. */
interface AnchorSnapshot {
  root: UiNode
  packageName: string
  capturedAtMs: number
  stepCountAtCapture: number
}

/** The mutable, in-progress form of a `RecordingStep` — frozen into the real schema shape by `finishAndBuild()`. */
type WorkingStep =
  | { kind: 'tap'; gapMs: number; pos: NormPoint; holdMs?: number; candidate?: RecordingCandidate; screenshotBlobId?: string }
  | { kind: 'longPress'; gapMs: number; pos: NormPoint; holdMs: number; candidate?: RecordingCandidate; screenshotBlobId?: string }
  | { kind: 'gesture'; gapMs: number; samples: NormGestureSample[]; screenshotBlobId?: string }
  | { kind: 'swipe'; gapMs: number; from: NormPoint; to: NormPoint; durationMs: number; screenshotBlobId?: string }
  | { kind: 'key'; gapMs: number; keycode: number }
  | { kind: 'text'; gapMs: number; value: string }

export interface RecordingSessionDeps {
  deviceId: string
  /** ms epoch at construction — `RecordingDoc.recordedAt` is derived from this, converted to seconds (plan 94 §4.1: "Unix epoch seconds"). */
  startedAtMs: number
  recordedOn: { stableId: string; model: string; width: number; height: number }
  /** Read fresh, never captured (the same freshness discipline every other farm setting in this codebase gets). */
  settings: () => RecordingSettings
  /** Injectable clock — real `Date.now` in production, a fake counter in tests. */
  now: () => number
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (h: ReturnType<typeof setTimeout>) => void
  /** One `inspector.dump()`, resolved to the tree plus the package it was taken on — `null` when the session has no inspector (or dump failed; the caller logs, this contract stays "no anchor" either way). */
  captureAnchor: () => Promise<{ root: UiNode; packageName: string } | null>
  /** One `inspector.screenshot()` (or the display's own screencap) — PNG/JPEG/WebP/GIF bytes, `null` when unavailable. Called once per step when `settings().captureScreenshots` is true. */
  captureScreenshot: () => Promise<Uint8Array | null>
  /** The shared content-addressed blob store (F16) — screenshots and anchor images go through this, never a second store. */
  blobs: BlobStore
  /** Pushed once per finished step (§4.9's `recording.step`). */
  onStep?: (index: number, kind: RecordingStepKind, hasCandidate: boolean) => void
  /** Fired exactly once, the moment a bound stops the recording on its own (§4.6's bounds) — never for an operator-requested stop/cancel. */
  onBound?: (reason: 'max-steps' | 'max-duration') => void
  log: Logger
}

export interface RecordingSession {
  readonly deviceId: string
  /** Unix epoch SECONDS — matches `RecordingDoc.recordedAt` and every other "at" timestamp this codebase puts on a wire message. */
  readonly startedAt: number
  readonly stepCount: number
  /** `null` while open; the reason a BOUND ended it, once one has (never set by an operator `stop`/`cancel`). */
  readonly stoppedReason: 'max-steps' | 'max-duration' | null
  /** Called from the input tee, after the lease check, before the device call (plan 94 §4.6). Synchronous, non-throwing, never alters what it observes. */
  observe(step: ObservedInput): void
  /** Stops, resolves every step's candidate against the anchor that was current when that step was observed, waits for any in-flight screenshot/anchor capture, and returns the document. Idempotent: a second call returns the same already-built document. */
  finishAndBuild(): Promise<RecordingDoc>
  /** Discards the recording — no document is built, no pending capture is awaited. */
  cancel(): void
}

const DEFAULT_NAME_PREFIX = 'recording'

/** `{name}-{unix seconds}` — a placeholder the operator renames during review (94.5); never itself validated against `RECORDING_NAME_RE` here (RecordingDocSchema does that at build time). */
function draftName(startedAtSec: number): string {
  return `${DEFAULT_NAME_PREFIX}-${startedAtSec}`
}

export function createRecordingSession(deps: RecordingSessionDeps): RecordingSession {
  const steps: WorkingStep[] = []
  const pending: Promise<void>[] = []
  let lastEventAtMs = deps.startedAtMs
  let currentAnchor: AnchorSnapshot | null = null
  let lastAnchorAtMs: number | null = null
  let anchorTimer: ReturnType<typeof setTimeout> | null = null
  let anchorInFlight = false
  let warnedAnchorFailure = false
  let stopped: 'max-steps' | 'max-duration' | null = null
  let cancelled = false
  let finished: RecordingDoc | null = null
  let durationTimer: ReturnType<typeof setTimeout> | null = null

  const clearAnchorTimer = (): void => {
    if (anchorTimer !== null) {
      deps.clearTimer(anchorTimer)
      anchorTimer = null
    }
  }

  const takeAnchor = (): void => {
    if (stopped || finished || cancelled || anchorInFlight) return
    const s = deps.settings()
    const nowMs = deps.now()
    if (!anchorDue(nowMs, lastAnchorAtMs, s.anchorMinIntervalMs)) return
    anchorInFlight = true
    const stepCountAtCapture = steps.length
    const work = deps
      .captureAnchor()
      .then((captured) => {
        if (!captured) return
        currentAnchor = { root: captured.root, packageName: captured.packageName, capturedAtMs: deps.now(), stepCountAtCapture }
        lastAnchorAtMs = currentAnchor.capturedAtMs
      })
      .catch((err) => {
        // "A dump failure is logged once and skips that anchor — a missing
        // anchor means 'no candidate', never a failed recording" (§4.6).
        if (!warnedAnchorFailure) {
          warnedAnchorFailure = true
          deps.log.warn(`recording anchor dump failed for ${deps.deviceId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      .finally(() => {
        anchorInFlight = false
      })
    pending.push(work)
  }

  const armAnchorTimer = (): void => {
    clearAnchorTimer()
    if (stopped || finished || cancelled) return
    const quietMs = deps.settings().anchorQuietMs
    anchorTimer = deps.setTimer(() => {
      anchorTimer = null
      takeAnchor()
    }, quietMs)
  }

  const stopForBound = (reason: 'max-steps' | 'max-duration'): void => {
    if (stopped || finished || cancelled) return
    stopped = reason
    clearAnchorTimer()
    if (durationTimer !== null) {
      deps.clearTimer(durationTimer)
      durationTimer = null
    }
    deps.onBound?.(reason)
  }

  // The duration bound fires on its own, even with no further input at all —
  // a recording left open and silent for `maxDurationSec` must still end
  // (plan 94's property 3: "bounded, always").
  durationTimer = deps.setTimer(() => {
    durationTimer = null
    stopForBound('max-duration')
  }, deps.settings().maxDurationSec * 1000)

  const captureStepScreenshot = (step: WorkingStep): void => {
    // `key`/`text` carry no `screenshotBlobId` in `RecordingStepSchema` at
    // all (plan 94 §4.1) — a keypress or a typed string has no meaningful
    // "the screen after this step" the way a tap or a drag does.
    if (step.kind === 'key' || step.kind === 'text') return
    if (!deps.settings().captureScreenshots) return
    const target = step
    const work = deps
      .captureScreenshot()
      .then((bytes) => {
        if (!bytes) return
        const mediaType = sniffImageMediaType(bytes)
        if (!mediaType) return
        target.screenshotBlobId = deps.blobs.put(bytes, mediaType).id
      })
      .catch((err) => {
        deps.log.warn(`recording screenshot capture failed for ${deps.deviceId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    pending.push(work)
  }

  const candidateFor = (pos: NormPoint, nowMs: number): RecordingCandidate | undefined => {
    if (!currentAnchor) return undefined
    const anchor = currentAnchor
    const px = mapNormToPixels(pos, deps.recordedOn)
    const found = proposeCandidateSelector(anchor.root, px)
    if (!found) return undefined
    return {
      selector: found.selector,
      count: found.count,
      anchorAgeMs: Math.max(0, nowMs - anchor.capturedAtMs),
      anchorStepsSince: Math.max(0, steps.length - anchor.stepCountAtCapture),
      anchorPackage: anchor.packageName,
    }
  }

  const pushStep = (step: WorkingStep): void => {
    steps.push(step)
    captureStepScreenshot(step)
    const hasCandidate = (step.kind === 'tap' || step.kind === 'longPress') && step.candidate !== undefined
    deps.onStep?.(steps.length - 1, step.kind, hasCandidate)
    // §4.6's bound: "exceeding either stops the recording and keeps it" — a
    // recording ends with AT MOST `maxSteps` steps, cleanly, once it reaches
    // the cap; the step that reached it is kept, nothing after it is.
    if (steps.length >= deps.settings().maxSteps) stopForBound('max-steps')
  }

  return {
    deviceId: deps.deviceId,
    get startedAt() {
      return Math.floor(deps.startedAtMs / 1000)
    },
    get stepCount() {
      return steps.length
    },
    get stoppedReason() {
      return stopped
    },

    observe(input) {
      if (stopped || finished || cancelled) return
      const nowMs = deps.now()
      const gapMs = Math.max(0, nowMs - lastEventAtMs)
      lastEventAtMs = nowMs

      if (input.kind === 'tap') {
        const longPressMs = deps.settings().longPressMs
        const candidate = candidateFor(input.pos, nowMs)
        if (input.holdMs !== undefined && input.holdMs >= longPressMs) {
          pushStep({ kind: 'longPress', gapMs, pos: input.pos, holdMs: input.holdMs, candidate })
        } else {
          pushStep({ kind: 'tap', gapMs, pos: input.pos, holdMs: input.holdMs, candidate })
        }
      } else if (input.kind === 'swipe') {
        pushStep({ kind: 'swipe', gapMs, from: input.from, to: input.to, durationMs: input.durationMs })
      } else if (input.kind === 'gesture') {
        pushStep({ kind: 'gesture', gapMs, samples: input.samples })
      } else if (input.kind === 'key') {
        pushStep({ kind: 'key', gapMs, keycode: input.keycode })
      } else {
        pushStep({ kind: 'text', gapMs, value: input.text })
      }

      if (!stopped) armAnchorTimer()
    },

    async finishAndBuild() {
      if (finished) return finished
      clearAnchorTimer()
      if (durationTimer !== null) {
        deps.clearTimer(durationTimer)
        durationTimer = null
      }
      // Every in-flight anchor dump / step screenshot must resolve (or fail
      // honestly) before the document is serialised — an async capture still
      // running when `stop` is called must never be silently dropped.
      await Promise.allSettled(pending)

      const startedAtSec = Math.floor(deps.startedAtMs / 1000)
      const packages = currentAnchor ? [currentAnchor.packageName] : []
      const builtSteps: RecordingStep[] = steps.map((s): RecordingStep => {
        if (s.kind === 'tap') return { kind: 'tap', gapMs: s.gapMs, target: { kind: 'point', pos: s.pos }, ...(s.holdMs !== undefined ? { holdMs: s.holdMs } : {}), ...(s.candidate ? { candidate: s.candidate } : {}), ...(s.screenshotBlobId ? { screenshotBlobId: s.screenshotBlobId } : {}) }
        if (s.kind === 'longPress') return { kind: 'longPress', gapMs: s.gapMs, target: { kind: 'point', pos: s.pos }, holdMs: s.holdMs, ...(s.candidate ? { candidate: s.candidate } : {}), ...(s.screenshotBlobId ? { screenshotBlobId: s.screenshotBlobId } : {}) }
        if (s.kind === 'gesture') return { kind: 'gesture', gapMs: s.gapMs, samples: s.samples, ...(s.screenshotBlobId ? { screenshotBlobId: s.screenshotBlobId } : {}) }
        if (s.kind === 'swipe') return { kind: 'swipe', gapMs: s.gapMs, from: s.from, to: s.to, durationMs: s.durationMs, ...(s.screenshotBlobId ? { screenshotBlobId: s.screenshotBlobId } : {}) }
        if (s.kind === 'key') return { kind: 'key', gapMs: s.gapMs, keycode: s.keycode }
        return { kind: 'text', gapMs: s.gapMs, value: s.value }
      })

      const doc = RecordingDocSchema.parse({
        schema: 1,
        name: draftName(startedAtSec),
        version: '0.1.0',
        description: '',
        recordedAt: startedAtSec,
        recordedOn: deps.recordedOn,
        packages,
        steps: builtSteps,
      })
      finished = doc
      return doc
    },

    cancel() {
      if (cancelled || finished) return
      cancelled = true
      clearAnchorTimer()
      if (durationTimer !== null) {
        deps.clearTimer(durationTimer)
        durationTimer = null
      }
      // No document is built (`stoppedReason` stays `null` — cancel is
      // deliberately never reported as a "bound" reason, §4.9). Discarding
      // the accumulated steps is not load-bearing (nobody reads them again —
      // `RecordingService` drops this session from its map the instant
      // `cancel()` returns) but makes "cancel discards" true of the object
      // itself, not just of its caller's behaviour.
      steps.length = 0
    },
  }
}
