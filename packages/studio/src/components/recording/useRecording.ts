'use client'

import { useEffect, useRef, useState } from 'react'
import type { RecordingStoppedReason } from '@enkaku/protocol'
import { newId, ws, WsRequestError } from '@/lib/ws'

/**
 * The client-side half of plan 94's recorder (step 94.4, §3.10, §4.9,
 * §4.10) — one `RecordingSession` lives on the core, keyed by `deviceId`
 * (`packages/core/src/recording/service.ts`, step 94.3); this hook is this
 * TAB's own view of it, kept live over the three `recording.*` requests and
 * the two `recording.state`/`recording.step` pushes.
 *
 * Deliberately called ONCE, at `ScreenCard`'s own top level, not inside a
 * component that only renders while `mode === 'record'` — the same
 * "attachment follows the lease, not the mode" reasoning `InspectorPanel`
 * documents for itself (plan 59 §3.3). Switching to `Live` or `Inspect` and
 * back must not lose a single step already captured, and the only way to
 * guarantee that in React is to keep the hook mounted for the life of the
 * screen card, not the life of whichever mode happens to be on screen.
 */

export type RecordingPhase = 'idle' | 'starting' | 'active' | 'stopping' | 'reviewing'

export type RecordedStepKind = 'tap' | 'longPress' | 'gesture' | 'swipe' | 'key' | 'text'

export interface RecordedStepEntry {
  index: number
  kind: RecordedStepKind
  hasCandidate: boolean
}

export interface RecordingState {
  phase: RecordingPhase
  /** Filled in order as `recording.step` arrives — cleared on `start()`/`discard()`/`reset()`. */
  steps: RecordedStepEntry[]
  /** The server's own count — kept in sync with `steps.length` in the common case, but authoritative on its own (e.g. a `reviewing` state reached before every `recording.step` push for the last few indices has necessarily arrived). */
  stepCount: number
  /** This TAB's own clock, ms epoch — set when `recording.start` resolves, not trusted from the wire (`RecordingStateMessage.startedAt`'s unit is not consistent between `recording.start`'s reply, ms, and `recording.stop`'s, seconds — `session.ts`/`ws-handlers.ts`, both outside this step's file list). Good enough for an on-screen duration counter, which is all this is for. */
  startedAt: number | null
  /** Set the moment this tab learns the recording ended, whether by its own `stop()` or a push it did not ask for. */
  endedAt: number | null
  /** Set only when the recording ended WITHOUT this tab's own `stop()` — a bound (`max-steps`/`max-duration`) or the lease going away (§4.6, §4.9). */
  stoppedReason: RecordingStoppedReason | null
  /** The last `start()`/`stop()` refusal, human-readable (`E_RECORDING_ACTIVE`, `E_NO_RECORDING`, a lease refusal code) — cleared on the next attempt. */
  error: string | null
  start: () => void
  stop: () => void
  discard: () => void
  /** Clears a finished (`reviewing`) recording's local state so the panel goes back to `idle` — no server call: the recording already ended. */
  reset: () => void
}

export function useRecording(deviceId: string): RecordingState {
  const [phase, setPhase] = useState<RecordingPhase>('idle')
  const [steps, setSteps] = useState<RecordedStepEntry[]>([])
  const [stepCount, setStepCount] = useState(0)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  const [stoppedReason, setStoppedReason] = useState<RecordingStoppedReason | null>(null)
  const [error, setError] = useState<string | null>(null)
  // `ws.on`'s callback below is created once per `deviceId` (not per render)
  // and would otherwise close over a stale `phase` — the same
  // `iHoldControlRef` pattern `app/device/page.tsx` already uses for its own
  // WS handler.
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  // A recording belongs to one device; this hook is re-used across a
  // navigation to a different one (the device page keeps `ScreenCard`
  // mounted while `deviceId` changes underneath it in some hosts, and even
  // where it does not, resetting on the id is the honest default).
  useEffect(() => {
    setPhase('idle')
    setSteps([])
    setStepCount(0)
    setStartedAt(null)
    setEndedAt(null)
    setStoppedReason(null)
    setError(null)
  }, [deviceId])

  useEffect(() => {
    const off = ws.on((msg) => {
      if (msg.type === 'recording.step' && msg.payload.deviceId === deviceId) {
        // A step for a recording this tab is not tracking (someone else's
        // session on a device this tab is only watching) has nothing local
        // to append to — the same restraint `RecordingService` itself
        // applies to a device with no inspector attached (§4.6): silently
        // correct, never a thrown error.
        if (phaseRef.current !== 'active') return
        const { index, kind, hasCandidate } = msg.payload
        setSteps((prev) => [...prev, { index, kind, hasCandidate }])
        setStepCount(index + 1)
        return
      }
      if (msg.type === 'recording.state' && msg.payload.deviceId === deviceId) {
        // `WsClient.request()` matches a reply by `id` and resolves the
        // waiting promise WITHOUT ever forwarding it to an `on()` handler
        // (`lib/ws.ts`'s own `onmessage`) — so a `recording.state` reaching
        // this callback is always a PUSH: a bound firing, or the lease going
        // away, never the reply to this tab's own start/stop/cancel.
        if (phaseRef.current !== 'active' && phaseRef.current !== 'stopping') return
        setStepCount(msg.payload.stepCount)
        setStoppedReason(msg.payload.stoppedReason ?? null)
        setEndedAt(Date.now())
        setPhase('reviewing')
      }
    })
    return off
  }, [deviceId])

  const start = (): void => {
    if (phaseRef.current !== 'idle') return
    setError(null)
    setPhase('starting')
    ws.request({ type: 'recording.start', id: newId(), payload: { deviceId } })
      .then((res) => {
        if (res.type !== 'recording.state') return
        setSteps([])
        setStepCount(res.payload.stepCount)
        setStartedAt(Date.now())
        setEndedAt(null)
        setStoppedReason(null)
        setPhase('active')
      })
      .catch((err: unknown) => {
        setError(err instanceof WsRequestError ? err.message : err instanceof Error ? err.message : String(err))
        setPhase('idle')
      })
  }

  const stop = (): void => {
    if (phaseRef.current !== 'active') return
    setError(null)
    setPhase('stopping')
    ws.request({ type: 'recording.stop', id: newId(), payload: { deviceId } })
      .then((res) => {
        if (res.type !== 'recording.state') return
        setStepCount(res.payload.stepCount)
        setStoppedReason(res.payload.stoppedReason ?? null)
        setEndedAt(Date.now())
        setPhase('reviewing')
      })
      .catch((err: unknown) => {
        setError(err instanceof WsRequestError ? err.message : err instanceof Error ? err.message : String(err))
        // The recording may still be open on the core after a failed
        // `recording.stop` request (a dropped socket mid-flight, say) —
        // going back to `active` keeps `Stop`/`Discard` both live rather
        // than stranding the operator with neither.
        setPhase('active')
      })
  }

  const discard = (): void => {
    if (phaseRef.current !== 'active') return
    setError(null)
    ws.send({ type: 'recording.cancel', payload: { deviceId } })
    setPhase('idle')
    setSteps([])
    setStepCount(0)
    setStartedAt(null)
    setEndedAt(null)
    setStoppedReason(null)
  }

  const reset = (): void => {
    setPhase('idle')
    setSteps([])
    setStepCount(0)
    setStartedAt(null)
    setEndedAt(null)
    setStoppedReason(null)
    setError(null)
  }

  return { phase, steps, stepCount, startedAt, endedAt, stoppedReason, error, start, stop, discard, reset }
}
