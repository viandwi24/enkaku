'use client'

import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { nearestEventIndex } from '@/lib/useJobTrace'
import { formatOffset } from './TraceTimeline'

/**
 * The playhead (plan 128 §4.6, step 128.8) — draggable, and keyboard-driven:
 * `←`/`→` step one event, `Home`/`End` jump to the ends.
 *
 * A drag resolves to the nearest event **by time**, not by index: the events
 * are not evenly spaced, and a scrubber that stepped by index would move
 * fast through a quiet stretch and slow through a burst — the opposite of
 * what a time axis means. `nearestEventIndex` (`lib/useJobTrace.ts`) is that
 * resolution, kept out of this component so it is testable without a DOM —
 * which matters here, because `getBoundingClientRect()` returns zeroes under
 * `happy-dom` and a pointer drag cannot be meaningfully simulated at all.
 */
export function TraceScrubber({
  events,
  selected,
  onSelect,
}: {
  events: JobTraceEvent[]
  selected: number
  onSelect: (index: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const originMs = events[0]?.atMs ?? 0
  const endMs = events[events.length - 1]?.atMs ?? originMs
  const span = Math.max(1, endMs - originMs)
  const current = events[selected] ?? null
  const positionPct = current ? ((current.atMs - originMs) / span) * 100 : 0

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
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="rack-label text-fg-subtle">playhead</span>
        <span className="readout text-[11.5px] text-fg-muted">
          {current ? `${formatOffset(current.atMs, originMs)} · ${current.kind} ${current.name}` : 'nothing selected'}
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
        Drag, or use ← → to step one event and Home / End to jump to the ends.
      </p>
    </div>
  )
}
