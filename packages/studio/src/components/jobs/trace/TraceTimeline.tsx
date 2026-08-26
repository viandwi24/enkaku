'use client'

import { useMemo, type ReactNode } from 'react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'

/**
 * The ruler and the lanes (plan 128 §4.6, step 128.8): a phase lane, an
 * action lane (one tick per device call, red when it failed), a log-density
 * lane, and a film-strip of the frames at their true time positions.
 *
 * **Everything positions on `atMs`, never on `seq` or on array index** —
 * `lib/useJobTrace.ts`'s own doc has the reasoning: `seq` is arrival order at
 * the recorder, not event order, so a lane laid out by index would draw a
 * captured action slightly after its own log lines.
 *
 * The whole lane stack scrolls inside ONE `overflow-x-auto` container whose
 * inner width grows with the event count, so a dense trace spreads out
 * instead of smearing, and the PAGE body never scrolls horizontally
 * (`CLAUDE.md`'s Studio rule).
 */

/** A phase band, resolved from the `phase` `start`/`end` event pairs. */
export interface PhaseBand {
  phase: string
  startMs: number
  endMs: number
}

/**
 * The bands, built by walking the events in display order. A `start` closes
 * whatever band is open (a rebound job's second attempt opens `prepare`
 * again without the first attempt's `finish` ever closing), and the last
 * open band runs to the end of the trace — a still-running job's current
 * phase is drawn to the playhead rather than not drawn at all.
 */
export function phaseBands(events: readonly JobTraceEvent[], endMs: number): PhaseBand[] {
  const bands: PhaseBand[] = []
  let open: PhaseBand | null = null
  for (const e of events) {
    if (e.kind !== 'phase') continue
    if (e.name === 'start') {
      if (open) open.endMs = e.atMs
      open = { phase: e.phase ?? 'unknown', startMs: e.atMs, endMs: e.atMs }
      bands.push(open)
    } else if (e.name === 'end' && open) {
      open.endMs = e.atMs
      open = null
    }
  }
  if (open) open.endMs = Math.max(open.endMs, endMs)
  return bands
}

const PHASE_TONE: Record<string, string> = {
  reset: 'bg-led-warn/25 text-led-warn',
  prepare: 'bg-accent/25 text-accent',
  run: 'bg-led-active/25 text-led-active',
  finish: 'bg-led-ok/25 text-led-ok',
  unknown: 'bg-surface-3 text-fg-subtle',
}

/** `+1.234s` from the start of the trace — the axis an operator actually reads, not a wall clock. */
export function formatOffset(atMs: number, originMs: number): string {
  const delta = atMs - originMs
  if (Math.abs(delta) < 1000) return `+${delta}ms`
  return `+${(delta / 1000).toFixed(3)}s`
}

/** How a frame that is NOT on disk is worded — goal 6: a skipped or failed capture is visible as such, never as a gap. */
export const FRAME_STATUS_WORD: Record<NonNullable<JobTraceEvent['frameStatus']>, string> = {
  ok: 'frame captured',
  'skipped-policy': 'no frame — the capture policy took none',
  'skipped-busy': 'frame skipped — another capture was still in flight',
  failed: 'frame capture failed',
}

const FRAME_STATUS_TONE: Record<NonNullable<JobTraceEvent['frameStatus']>, string> = {
  ok: 'border-line text-fg-subtle',
  'skipped-policy': 'border-line text-fg-subtle',
  'skipped-busy': 'border-led-warn/50 text-led-warn',
  failed: 'border-led-danger/50 text-led-danger',
}

const LOG_BUCKETS = 60

export function TraceTimeline({
  jobId,
  events,
  selected,
  onSelect,
}: {
  jobId: string
  events: JobTraceEvent[]
  selected: number
  onSelect: (index: number) => void
}) {
  const originMs = events[0]?.atMs ?? 0
  const endMs = events[events.length - 1]?.atMs ?? originMs
  // A zero-length trace (one event, or several in the same millisecond) must
  // not divide by zero — every tick then lands at 0%, which is honest.
  const span = Math.max(1, endMs - originMs)
  const pct = (atMs: number) => ((atMs - originMs) / span) * 100

  const bands = useMemo(() => phaseBands(events, endMs), [events, endMs])
  const actions = useMemo(() => events.filter((e) => e.kind === 'action'), [events])
  const frames = useMemo(() => events.filter((e) => e.frameHash), [events])
  const skipped = useMemo(
    () => events.filter((e) => e.frameStatus === 'skipped-busy' || e.frameStatus === 'failed'),
    [events],
  )

  // Log density, bucketed on the time axis rather than per event — a lane of
  // one bar per log line is unreadable the moment a script is chatty.
  const density = useMemo(() => {
    const buckets = new Array<number>(LOG_BUCKETS).fill(0)
    for (const e of events) {
      if (e.kind !== 'log') continue
      const b = Math.min(LOG_BUCKETS - 1, Math.floor(((e.atMs - originMs) / span) * LOG_BUCKETS))
      buckets[b] = (buckets[b] ?? 0) + 1
    }
    return buckets
  }, [events, originMs, span])
  const densityPeak = Math.max(1, ...density)

  // The inner width grows with the event count so a dense trace spreads out
  // rather than piling every tick on top of the next. Capped so a 5,000-event
  // trace does not build a 50,000 px node.
  const innerWidth = Math.min(6000, Math.max(720, events.length * 14))
  const selectedEvent = events[selected]

  return (
    <div className="overflow-x-auto rounded-lg border bg-surface">
      <div className="min-w-full p-3" style={{ width: `${innerWidth}px` }}>
        {/* The ruler: five evenly-spaced offsets from the start of the trace. */}
        <div className="relative h-4">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span
              key={f}
              className="readout absolute top-0 -translate-x-1/2 text-[10px] text-fg-subtle"
              style={{ left: `${f * 100}%` }}
            >
              {formatOffset(originMs + f * span, originMs)}
            </span>
          ))}
        </div>

        <Lane label="phase">
          {bands.map((b, i) => (
            <div
              key={`${b.phase}-${b.startMs}-${i}`}
              className={cn('absolute inset-y-0 flex items-center overflow-hidden rounded-sm px-1', PHASE_TONE[b.phase] ?? PHASE_TONE.unknown)}
              style={{ left: `${pct(b.startMs)}%`, width: `${Math.max(0.4, pct(b.endMs) - pct(b.startMs))}%` }}
              title={`${b.phase} — ${formatOffset(b.startMs, originMs)} → ${formatOffset(b.endMs, originMs)}`}
            >
              <span className="rack-label truncate">{b.phase}</span>
            </div>
          ))}
        </Lane>

        <Lane label="actions">
          {actions.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(events.indexOf(e))}
              data-frame-status={e.frameStatus ?? 'none'}
              aria-label={`${e.name} at ${formatOffset(e.atMs, originMs)}${e.ok === false ? ' — failed' : ''}`}
              title={`${e.name} — ${formatOffset(e.atMs, originMs)}${e.durationMs === null ? '' : ` · ${e.durationMs}ms`}${
                e.frameStatus ? ` · ${FRAME_STATUS_WORD[e.frameStatus]}` : ''
              }`}
              className={cn(
                'absolute inset-y-1 w-1.5 -translate-x-1/2 rounded-sm',
                e.ok === false ? 'bg-led-danger' : 'bg-accent',
                selectedEvent?.id === e.id && 'ring-2 ring-fg',
              )}
              style={{ left: `${pct(e.atMs)}%` }}
            />
          ))}
          {actions.length === 0 && (
            <span className="absolute inset-y-0 left-0 flex items-center text-[11.5px] text-fg-subtle">
              no device actions recorded
            </span>
          )}
        </Lane>

        <Lane label="logs">
          <div className="absolute inset-0 flex items-end gap-px">
            {density.map((n, i) => (
              <span
                key={i}
                className={cn('flex-1 rounded-t-sm', n > 0 ? 'bg-fg-subtle' : 'bg-transparent')}
                style={{ height: `${(n / densityPeak) * 100}%` }}
                title={n > 0 ? `${n} log line${n === 1 ? '' : 's'}` : undefined}
              />
            ))}
          </div>
        </Lane>

        {/* The film-strip — thumbnails at their true time positions. A capture
            that was SKIPPED or FAILED gets a marked cell in the same lane
            rather than leaving a gap (goal 6); `skipped-policy` is the one
            status left to the header count above, because on a
            `uiautomator-dump` job it is every single action and the policy
            line already explains it in one sentence. */}
        <Lane label="frames" height="h-16">
          {frames.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(events.indexOf(e))}
              className={cn(
                'absolute inset-y-0 w-6 -translate-x-1/2 overflow-hidden rounded-sm border',
                selectedEvent?.id === e.id ? 'z-10 border-accent' : 'border-line hover:z-10 hover:border-line-strong',
              )}
              style={{ left: `${pct(e.atMs)}%` }}
              title={`${e.name} — ${formatOffset(e.atMs, originMs)}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${coreBase()}/api/jobs/${jobId}/trace/frames/${e.frameHash}`}
                alt={`frame at ${formatOffset(e.atMs, originMs)}`}
                className="size-full object-cover"
              />
            </button>
          ))}
          {skipped.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(events.indexOf(e))}
              data-frame-status={e.frameStatus ?? 'none'}
              className={cn(
                'absolute inset-y-0 w-6 -translate-x-1/2 rounded-sm border border-dashed text-[9px] leading-none',
                FRAME_STATUS_TONE[e.frameStatus ?? 'ok'],
                selectedEvent?.id === e.id && 'z-10 ring-2 ring-fg',
              )}
              style={{ left: `${pct(e.atMs)}%` }}
              aria-label={`${e.name} — ${FRAME_STATUS_WORD[e.frameStatus ?? 'ok']}`}
              title={`${e.name} — ${FRAME_STATUS_WORD[e.frameStatus ?? 'ok']}`}
            >
              {e.frameStatus === 'failed' ? '!' : '⏱'}
            </button>
          ))}
          {frames.length === 0 && skipped.length === 0 && (
            <span className="absolute inset-y-0 left-0 flex items-center text-[11.5px] text-fg-subtle">
              no frames captured
            </span>
          )}
        </Lane>
      </div>
    </div>
  )
}

function Lane({ label, height = 'h-6', children }: { label: string; height?: string; children: ReactNode }) {
  return (
    <div className="mt-2 flex items-stretch gap-2">
      <span className="rack-label w-14 shrink-0 self-center text-fg-subtle">{label}</span>
      <div className={cn('relative min-w-0 flex-1 rounded-sm bg-bg', height)}>{children}</div>
    </div>
  )
}
