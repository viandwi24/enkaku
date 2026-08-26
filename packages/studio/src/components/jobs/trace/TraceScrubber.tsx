'use client'

import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { Pause, Play } from 'lucide-react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { Button } from '@enkaku/ui'
import { nearestEventIndex } from '@/lib/useJobTrace'
import { formatOffset } from './TraceTimeline'
import type { PlaybackSpeed } from './useTracePlayback'

const SPEEDS: readonly PlaybackSpeed[] = [1, 2, 4]

/**
 * The playhead (plan 128 §4.6, step 128.8) — draggable, and keyboard-driven:
 * `←`/`→` step one event, `Home`/`End` jump to the ends, `Space` toggles
 * play/pause (plan 130 step 130.6).
 *
 * A drag resolves to the nearest event **by time**, not by index: the events
 * are not evenly spaced, and a scrubber that stepped by index would move
 * fast through a quiet stretch and slow through a burst — the opposite of
 * what a time axis means. `nearestEventIndex` (`lib/useJobTrace.ts`) is that
 * resolution, kept out of this component so it is testable without a DOM —
 * which matters here, because `getBoundingClientRect()` returns zeroes under
 * `happy-dom` and a pointer drag cannot be meaningfully simulated at all.
 *
 * **The marker and the readout position from `playheadMs`, never from the
 * selected event's own `atMs`** (plan 130 step 130.6, `useTracePlayback.ts`'s
 * own doc). While paused the two are the same value — `useTracePlayback`
 * keeps them synced — but during playback `playheadMs` advances every tick
 * even across a long idle gap where the nearest event does not change, which
 * is what keeps the marker visibly sliding instead of looking frozen.
 */
export function TraceScrubber({
  events,
  selected,
  onSelect,
  playheadMs,
  playing,
  speed,
  onToggle,
  onSpeedChange,
}: {
  events: JobTraceEvent[]
  selected: number
  onSelect: (index: number) => void
  playheadMs: number
  playing: boolean
  speed: PlaybackSpeed
  onToggle: () => void
  onSpeedChange: (speed: PlaybackSpeed) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const originMs = events[0]?.atMs ?? 0
  const endMs = events[events.length - 1]?.atMs ?? originMs
  const span = Math.max(1, endMs - originMs)
  const current = events[selected] ?? null
  const positionPct = Math.min(100, Math.max(0, ((playheadMs - originMs) / span) * 100))

  function resolve(clientX: number): void {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const at = nearestEventIndex(events, originMs + fraction * span)
    if (at >= 0) onSelect(at)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (events.length === 0) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onSelect(Math.max(0, selected - 1))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      onSelect(Math.min(events.length - 1, selected + 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      onSelect(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      onSelect(events.length - 1)
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      // Space toggles play/pause (plan 130 step 130.6) — scoped to this
      // element, exactly like the other bindings above, and prevented so
      // the page never scrolls on the space press.
      e.preventDefault()
      onToggle()
    }
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>): void {
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    resolve(e.clientX)
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>): void {
    if (dragging.current) resolve(e.clientX)
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>): void {
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  return (
    <div className="rounded-lg border bg-surface px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          disabled={events.length === 0}
          aria-label={playing ? 'Pause trace playback' : 'Play trace playback'}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
        </Button>
        <div role="group" aria-label="Playback speed" className="flex items-center gap-1">
          {SPEEDS.map((s) => (
            <Button
              key={s}
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[12px] leading-none"
              aria-pressed={speed === s}
              onClick={() => onSpeedChange(s)}
              aria-label={`${s}× playback speed`}
            >
              {s}×
            </Button>
          ))}
        </div>
      </div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="rack-label text-fg-subtle">playhead</span>
        <span className="readout text-[11.5px] text-fg-muted">
          {current ? `${formatOffset(playheadMs, originMs)} · ${current.kind} ${current.name}` : 'nothing selected'}
        </span>
        <span className="readout text-[11px] text-fg-subtle">
          {events.length === 0 ? '0 events' : `event ${selected + 1} of ${events.length}`}
        </span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Trace playhead"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, events.length - 1)}
        aria-valuenow={Math.max(0, selected)}
        aria-valuetext={current ? `${formatOffset(current.atMs, originMs)} — ${current.kind} ${current.name}` : 'no events'}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative h-6 cursor-ew-resize touch-none rounded-sm bg-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" aria-hidden />
        {current && (
          <div
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-accent"
            style={{ left: `${positionPct}%` }}
            aria-hidden
          />
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-fg-subtle">
        Drag, or use ← → to step one event, Home / End to jump to the ends, and Space to play or pause.
      </p>
    </div>
  )
}
