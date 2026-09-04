'use client'

import type { WorkflowStepInfo } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'

/**
 * Plan 307 §4.3, step 307.4 — "step through a finished run", the cheapest
 * version that needs no new storage: a slider over `seq`, wired to whatever
 * the caller does with the selected step (the run view shows that step's
 * recorded input/output, plan 300 P6's read-only replay half).
 */
export function RunScrubber({
  steps,
  selectedSeq,
  onSelect,
}: {
  steps: readonly WorkflowStepInfo[]
  selectedSeq: number | null
  onSelect(seq: number | null): void
}) {
  if (steps.length === 0) return null
  const maxSeq = steps[steps.length - 1]!.seq
  const value = selectedSeq ?? maxSeq
  const current = steps.find((s) => s.seq === value)

  return (
    <div className="flex flex-none flex-wrap items-center gap-2 rounded border bg-surface px-2.5 py-1.5 text-[11.5px]">
      <button
        type="button"
        className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-muted disabled:opacity-40"
        disabled={value <= 0}
        onClick={() => onSelect(Math.max(0, value - 1))}
        aria-label="Previous step"
      >
        ‹
      </button>
      <input
        type="range"
        min={0}
        max={maxSeq}
        step={1}
        value={value}
        onChange={(e) => onSelect(Number(e.target.value))}
        className="h-1.5 min-w-32 flex-1 accent-accent"
        aria-label="Step through this run"
      />
      <button
        type="button"
        className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-muted disabled:opacity-40"
        disabled={value >= maxSeq}
        onClick={() => onSelect(Math.min(maxSeq, value + 1))}
        aria-label="Next step"
      >
        ›
      </button>
      <span className="readout text-fg-muted">
        step {value + 1} / {maxSeq + 1}
        {current && (
          <>
            {' · '}
            <span className={cn(current.status === 'failed' && 'text-led-danger')}>{current.stepId}</span>
            {' · '}
            {current.status}
          </>
        )}
      </span>
      {selectedSeq !== null && (
        <button type="button" className="ml-auto rounded px-1.5 py-0.5 text-fg-muted hover:bg-muted" onClick={() => onSelect(null)}>
          back to latest
        </button>
      )}
    </div>
  )
}
