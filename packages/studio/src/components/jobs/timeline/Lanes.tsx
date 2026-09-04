'use client'

import { useMemo, type ReactNode } from 'react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { PHASE_FILL, formatOffset, phaseBands } from './lanes'

/**
 * Card 2 (design handoff): "*Lanes*: "+0ms" / "+12.922s" bounds, then three
 * 18px lanes on `var(--muted-2)` with 58px uppercase labels — **Phase**
 * (proportional blocks: reset `var(--warn-2)`, prepare `var(--faint)`, run
 * `var(--accent)`, label inset in `var(--panel)` text), **Actions** (4px
 * ticks per event; current = `var(--text)`, retry = `var(--warn)`, else
 * accent; clickable, tooltip "name · +3.181s"), **Logs** (grey
 * `var(--border-3)` clusters)."
 *
 * Everything positions on `atMs`, never on `seq` or on array index: `seq` is
 * arrival order at the recorder, not event order, so a lane laid out by index
 * draws a captured action slightly after its own log lines
 * (`lib/useJobTrace.ts`'s own doc).
 *
 * "retry" is `attempt > 1` on the trace event, the runner's own retry counter
 * that the handoff draws by name. It is not a run (plan 200 §2.4's reserved
 * word) and §10.3 exempts it.
 */
const LOG_BUCKETS = 40

export function Lanes({
  events,
  actions,
  selected,
  onSelect,
  originMs,
  endMs,
  emptyLane,
}: {
  events: JobTraceEvent[]
  actions: JobTraceEvent[]
  selected: number
  onSelect: (index: number) => void
  originMs: number
  endMs: number
  emptyLane: string | null
}) {
  const span = Math.max(1, endMs - originMs)
  const pct = (at: number) => ((at - originMs) / span) * 100
  const bands = useMemo(() => phaseBands(events, endMs), [events, endMs])
  // One block per bucket that holds at least one log line: the handoff draws
  // "clusters", not a tick per line, and a run with 4 000 log lines would
  // otherwise put 4 000 absolutely positioned divs on the page.
  const logClusters = useMemo(() => {
    const hit = new Set<number>()
    for (const e of events) if (e.kind === 'log') hit.add(Math.floor(((e.atMs - originMs) / span) * LOG_BUCKETS))
    return [...hit].sort((a, b) => a - b)
  }, [events, originMs, span])

  return (
    <div className="rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
      <div className="flex items-center justify-between pb-2 font-mono text-[10.5px] text-faint">
        <span>{formatOffset(originMs, originMs)}</span>
        <span>{formatOffset(endMs, originMs)}</span>
      </div>

      <Lane label="Phase">
        {bands.map((b, i) => (
          <div
            key={`${b.phase}-${i}`}
            title={b.phase}
            className={cn(
              'absolute inset-y-0 flex items-center overflow-hidden rounded-[6px] pl-2 text-[9.5px] uppercase tracking-[.5px] text-panel',
              PHASE_FILL[b.phase] ?? PHASE_FILL.unknown,
            )}
            style={{ left: `${pct(b.startMs)}%`, width: `${Math.max(pct(b.endMs) - pct(b.startMs), 4)}%` }}
          >
            {b.phase}
          </div>
        ))}
      </Lane>

      <Lane label="Actions">
        {actions.map((e, i) => (
          <button
            key={e.id}
            type="button"
            title={`${e.name} · ${formatOffset(e.atMs, originMs)}`}
            aria-label={`${e.name} at ${formatOffset(e.atMs, originMs)}`}
            onClick={() => onSelect(i)}
            className={cn(
              'absolute inset-y-[3px] w-[4px] rounded-pill',
              i === selected ? 'bg-text' : e.attempt > 1 ? 'bg-warn' : 'bg-accent',
            )}
            style={{ left: `calc(${pct(e.atMs)}% - 2px)` }}
          />
        ))}
      </Lane>

      <Lane label="Logs">
        {logClusters.map((b) => (
          <div
            key={b}
            className="absolute inset-y-[6px] rounded-[4px] bg-border-3"
            style={{ left: `${(b / LOG_BUCKETS) * 100}%`, width: `${100 / LOG_BUCKETS}%` }}
          />
        ))}
      </Lane>

      {/* Goal: an empty action lane is stated in words, never left as a blank
          box the reader has to interpret (`lib/useJobTrace.ts`'s
          `explainEmptyActionLane`). */}
      {emptyLane && <p className="pt-2 text-meta text-faint">{emptyLane}</p>}
    </div>
  )
}

function Lane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-[10px] py-[3px]">
      <span className="w-[58px] flex-none text-tip uppercase tracking-[.4px] text-faint">{label}</span>
      <div className="relative h-[18px] flex-1 rounded-[6px] bg-muted-2">{children}</div>
    </div>
  )
}
