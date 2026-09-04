'use client'

import { useEffect, useRef, useState } from 'react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { nearestEventIndex } from '@/lib/useJobTrace'

/**
 * Play/pause for the Timeline tab (plan 130 §3.6, step 130.6) — the owner's
 * own words: *"kasih fitur play/pause dong jadi kaya mensimulasikan waktu
 * kaya asli gitu"*, play the run back rather than step through it.
 *
 * The playhead already resolved an INSTANT — a point on the `atMs` axis
 * (plan 128 §4.3) — to a frame, an event and a log window. This hook is
 * exactly that instant made to advance on its own: `playheadMs` is a
 * continuous position on the same axis `TraceScrubber`/`TraceTimeline`
 * already draw against, and `selected` is `nearestEventIndex` applied to it
 * every tick — the identical resolution a manual drag already used.
 *
 * **Real elapsed time, honouring the real gaps (the whole point).**
 * `advancePlayheadMs` moves the axis position by wall-clock delta scaled by
 * `speed` — a 4-second wait between two taps takes 4 seconds at 1×. Nothing
 * here advances event-by-event on a fixed tick; a tick is only ever a
 * sampling rate for the animation, never the unit of playback.
 *
 * **A long idle gap must not look like a freeze — chosen answer: the
 * playhead keeps visibly sliding, never a silent compression.** Because
 * `playheadMs` is continuous and independent of `selected`, it keeps moving
 * every tick even while `nearestEventIndex` returns the same index for
 * seconds at a time (the 75-second `waitFor` in the plan's own evidence).
 * `TraceScrubber` positions its marker and its offset readout from
 * `playheadMs`, not from the selected event's own `atMs` — so a reader
 * watching the strip during a long gap sees continuous motion, never a
 * still frame that reads as broken. Speed multipliers (1×/2×/4×) are the
 * OTHER half of that answer — the mechanism this hook offers for "a 2m42s
 * job at 1× is not a debugging tool" is making the real wait shorter, never
 * making the wait fake.
 *
 * **Scrubbing pauses.** `select()` is the one function every manual
 * navigation path calls (a drag, a keyboard step, a click on a lane
 * element) — it always stops playback first, the convention the plan asks
 * for rather than a bespoke one.
 *
 * **Stops at the end, never wraps.** The tick loop clamps to `endMs` and
 * calls `pause()` in the same tick that reaches it, so the final state
 * stays on screen — reaching the end is how an operator learns the run
 * ended. Pressing play again after the end restarts from the beginning,
 * the ordinary media-player convention for "play" once there is nothing
 * ahead of the playhead.
 */

export type PlaybackSpeed = 1 | 2 | 4

/**
 * One tick's worth of axis motion — pure, and the thing every timing claim
 * in this module reduces to. `deltaMs` is REAL elapsed milliseconds; `speed`
 * scales it; the result never exceeds `endMs`. A non-positive delta (a
 * clock that did not advance, or went backwards) is a no-op rather than
 * moving the playhead backwards.
 */
export function advancePlayheadMs(current: number, deltaMs: number, speed: PlaybackSpeed, endMs: number): number {
  if (deltaMs <= 0) return current
  return Math.min(endMs, current + deltaMs * speed)
}

export interface TracePlayback {
  /** `nearestEventIndex` applied to `playheadMs` — what the frame/detail panels show. */
  selected: number
  /** The continuous axis position in milliseconds. See this module's own doc for why it is not simply the selected event's `atMs`. */
  playheadMs: number
  playing: boolean
  speed: PlaybackSpeed
  /** Manual selection. Always pauses first — see this module's own doc. */
  select: (index: number) => void
  play: () => void
  pause: () => void
  toggle: () => void
  setSpeed: (speed: PlaybackSpeed) => void
}

/**
 * `now`/`tickMs` are the injected clock (default `Date.now`/100ms) — the
 * seam `useTracePlayback.test.ts` uses to prove every timing claim above
 * without a single real multi-second wait: a test advances the fake `now`
 * by however much simulated time a case needs, then waits only for the
 * next real tick (a few milliseconds) to observe it.
 */
export function useTracePlayback(
  events: readonly JobTraceEvent[],
  defaultIndex: number,
  options?: { now?: () => number; tickMs?: number },
): TracePlayback {
  const now = options?.now ?? Date.now
  const tickMs = options?.tickMs ?? 100

  const [picked, setPicked] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1)

  const selected = Math.min(events.length - 1, Math.max(0, picked ?? defaultIndex))
  const selectedEvent = events[selected] ?? null
  const originMs = events[0]?.atMs ?? 0
  const endMs = events[events.length - 1]?.atMs ?? originMs

  const [playheadMs, setPlayheadMs] = useState<number>(() => selectedEvent?.atMs ?? originMs)
  const playheadRef = useRef(playheadMs)
  // The id of the event `playheadMs` was last synced to by a MANUAL
  // selection (as opposed to the tick loop moving past it) — `null` until
  // the first real event resolves, so the effect below still fires once
  // `events` loads even though `picked` never changed.
  const lastSyncedIdRef = useRef<string | null>(null)

  // A manual selection (a click, a drag, a keyboard step, or the default
  // index resolving once the trace loads) moves the continuous playhead to
  // match it — but only while NOT playing, so the tick loop below is the
  // sole owner of `playheadMs` during playback.
  useEffect(() => {
    if (playing) return
    if (selectedEvent && selectedEvent.id !== lastSyncedIdRef.current) {
      lastSyncedIdRef.current = selectedEvent.id
      playheadRef.current = selectedEvent.atMs
      setPlayheadMs(selectedEvent.atMs)
    }
  }, [selectedEvent, playing])

  function select(index: number): void {
    setPlaying(false)
    setPicked(index)
  }

  function play(): void {
    if (events.length === 0) return
    if (playheadRef.current >= endMs) {
      playheadRef.current = originMs
      setPlayheadMs(originMs)
      setPicked(0)
      lastSyncedIdRef.current = events[0]?.id ?? null
    }
    setPlaying(true)
  }

  function pause(): void {
    setPlaying(false)
  }

  function toggle(): void {
    if (playing) pause()
    else play()
  }

  useEffect(() => {
    if (!playing || events.length === 0) return
    let last = now()
    const id = setInterval(() => {
      const t = now()
      const delta = t - last
      last = t
      const next = advancePlayheadMs(playheadRef.current, delta, speed, endMs)
      playheadRef.current = next
      setPlayheadMs(next)
      const idx = nearestEventIndex(events, next)
      lastSyncedIdRef.current = events[idx]?.id ?? null
      setPicked((cur) => (cur === idx ? cur : idx))
      if (next >= endMs) setPlaying(false)
    }, tickMs)
    return () => clearInterval(id)
    // `now`/`tickMs` are the injected clock, stable for the hook's lifetime
    // in every real caller; omitting them from the deps keeps a fake clock
    // swapped in by a test from tearing the interval down mid-tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, events, endMs])

  return { selected, playheadMs, playing, speed, select, play, pause, toggle, setSpeed: setSpeedState }
}
