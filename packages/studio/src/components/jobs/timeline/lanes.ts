import type { JobTraceEvent } from '@enkaku/protocol'

/**
 * Pure timeline math, moved out of the deleted prototype trace components
 * (plan 218 §3.6, §4.10): `phaseBands` and `formatOffset` are unchanged in
 * body from `components/jobs/trace/TraceTimeline.tsx`'s own `:58` and `:85`.
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

/** `+1.234s` from the start of the trace — the axis an operator actually reads, not a wall clock. */
export function formatOffset(atMs: number, originMs: number): string {
  const delta = atMs - originMs
  if (Math.abs(delta) < 1000) return `+${delta}ms`
  return `+${(delta / 1000).toFixed(3)}s`
}

/** The handoff's Phase lane colours ("reset `var(--warn-2)`, prepare
 *  `var(--faint)`, run `var(--accent)`"). `finish` and `unknown` are this
 *  plan's extension: the handoff's sample trace has three phases and the
 *  runner has four (`reset`, `prepare`, `run`, `finish`). */
export const PHASE_FILL: Record<string, string> = {
  reset: 'bg-warn-2',
  prepare: 'bg-faint',
  run: 'bg-accent',
  finish: 'bg-ok',
  unknown: 'bg-border-3',
}
