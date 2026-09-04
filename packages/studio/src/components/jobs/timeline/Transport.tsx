'use client'

import { useRef } from 'react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { PauseIcon, PlayIcon, cn } from '@enkaku/ui'
import { nearestEventIndex } from '@/lib/useJobTrace'
import { formatOffset } from './lanes'
import type { PlaybackSpeed } from './useTracePlayback'

/**
 * Card 1 (design handoff): "*Transport*: 30×30 accent play/pause button, a
 * 1×/2×/4× segmented control on `var(--muted)`, a centered readout
 * ("+3.181s · prepare · app.forceStop"), a right-aligned "event 10 of 18",
 * and a 6px scrub track (`border-radius: 99px`, `var(--muted-2)`) with an
 * accent fill and a 14px knob (`background: var(--panel)`, `border: 2px solid
 * var(--accent)`). Clicking the track snaps to the nearest event."
 *
 * The fill and the knob position from `playheadMs`, never from the selected
 * event's own `atMs`: while paused the two are the same value, but during
 * playback the playhead keeps sliding across a long idle gap where the
 * nearest event does not change, and a marker that freezes reads as broken
 * (`useTracePlayback.ts`'s own doc).
 */
const SPEEDS: readonly PlaybackSpeed[] = [1, 2, 4]

export function Transport({
  actions,
  selected,
  onSelect,
  playheadMs,
  originMs,
  endMs,
  playing,
  speed,
  onToggle,
  onSpeedChange,
}: {
  actions: JobTraceEvent[]
  selected: number
  onSelect: (index: number) => void
  playheadMs: number
  originMs: number
  endMs: number
  playing: boolean
  speed: PlaybackSpeed
  onToggle: () => void
  onSpeedChange: (speed: PlaybackSpeed) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const span = Math.max(1, endMs - originMs)
  const pct = Math.min(100, Math.max(0, ((playheadMs - originMs) / span) * 100))
  const current = actions[selected] ?? null

  function scrub(clientX: number): void {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const at = nearestEventIndex(actions, originMs + fraction * span)
    if (at >= 0) onSelect(at)
  }

  return (
    <div className="rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
      <div className="flex items-center gap-[10px]">
        <button
          type="button"
          onClick={onToggle}
          aria-label={playing ? 'Pause' : 'Play'}
          className="grid size-[30px] flex-none place-items-center rounded-input bg-accent text-on-accent"
        >
          {playing ? <PauseIcon className="size-[15px]" /> : <PlayIcon className="size-[15px]" />}
        </button>
        <div className="flex flex-none gap-[2px] rounded-small bg-muted p-[2px]">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSpeedChange(s)}
              className={cn(
                'rounded-[6px] px-[9px] py-1 text-meta transition-colors',
                s === speed ? 'bg-panel font-semibold text-text' : 'font-medium text-faint hover:text-text',
              )}
            >
              {s}&times;
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 truncate text-center text-meta text-dim">
          <span className="font-mono text-text">{formatOffset(playheadMs, originMs)}</span>
          {current ? ` · ${current.phase ?? 'unknown'} · ${current.name}` : ''}
        </div>
        <span className="flex-none text-meta text-faint">
          event {actions.length === 0 ? 0 : selected + 1} of {actions.length}
        </span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, actions.length)}
        aria-valuenow={selected + 1}
        onClick={(e) => scrub(e.clientX)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            onSelect(Math.max(0, selected - 1))
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            onSelect(Math.min(actions.length - 1, selected + 1))
          } else if (e.key === 'Home') {
            e.preventDefault()
            onSelect(0)
          } else if (e.key === 'End') {
            e.preventDefault()
            onSelect(Math.max(0, actions.length - 1))
          }
        }}
        className="relative mt-[10px] h-[6px] cursor-pointer rounded-pill bg-muted-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <div className="absolute inset-y-0 left-0 rounded-pill bg-accent" style={{ width: `${pct}%` }} />
        <div
          className="absolute -top-1 size-[14px] rounded-pill border-2 border-accent bg-panel"
          style={{ left: `calc(${pct}% - 7px)` }}
        />
      </div>
    </div>
  )
}
