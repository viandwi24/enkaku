'use client'

import { useEffect } from 'react'
import { CircleIcon, cn } from '@enkaku/ui'
import { FlowCanvas, type FlowCanvasProps } from './FlowCanvas'
import { useRunState } from './useRunState'

/**
 * Plan 307 §3.1, §4.2 — the run view. `RunOverlay` renders exactly one
 * `FlowCanvas`, always: this is the "one renderer, two sources" G3 asks for,
 * provable by grep because there is no second place a run's state is drawn.
 *
 * The two sources: `FlowEditor.tsx` mounts this in place of `FlowCanvas`
 * directly, editable, over the workflow's own last real run (§3.1's WS-fed
 * half — `useRunState`'s poll/subscribe covers the "live" case without this
 * component knowing it is live); the job detail page mounts it read-only,
 * over one specific run's snapshot document (§3.2's replay half). Neither
 * caller tells `RunOverlay` which one it is — it always just asks
 * `useRunState(jobId, runId)` and draws what comes back.
 */
export interface RunOverlayProps extends Omit<FlowCanvasProps, 'runState'> {
  /** The workflow job whose run this draws, or `null` when there is nothing to show yet (a brand-new workflow that has never run). */
  jobId: string | null
  runId: string | null
  /**
   * Plan 309 §3.4, §4.5 — true when `jobId`/`runId` name a `trigger:
   * 'simulate'` run rather than a real one (G4: unmistakable everywhere it
   * appears). Drawn as a dashed halo and a "SIMULATED" chip on the SAME
   * canvas a real run uses (G6) — never a second renderer.
   */
  simulated?: boolean
  /**
   * The run sentence, handed to the panel header rather than drawn here.
   *
   * This component used to render its own strip above the canvas — which
   * cost the graph a row of height on every screen, and said the same thing
   * the panel now says at the top of itself (CEO's redesign, 2026-09-07).
   */
  onStatusChange?: (text: string | null) => void
}

const STATUS_LABEL: Record<'live' | 'replay' | 'none', string> = {
  live: 'watching this run',
  replay: 'replaying a finished run',
  none: 'this workflow has never run',
}

export function RunOverlay({ jobId, runId, simulated = false, onStatusChange, ...canvasProps }: RunOverlayProps) {
  const { runState, finalized, loading, steps } = useRunState(jobId, runId)
  const status: 'live' | 'replay' | 'none' = !jobId || !runId ? 'none' : finalized ? 'replay' : 'live'

  const sentence =
    !jobId || !runId
      ? null
      : simulated
        ? `simulated run${steps.length > 0 ? ` · ${steps.length} step${steps.length === 1 ? '' : 's'}` : ''}`
        : loading
          ? 'loading run…'
          : `${STATUS_LABEL[status]}${steps.length > 0 ? ` · ${steps.length} step${steps.length === 1 ? '' : 's'}` : ''}`
  useEffect(() => {
    onStatusChange?.(sentence)
  }, [sentence, onStatusChange])

  return (
    <div className={cn('flex h-full min-h-0 flex-col gap-2', simulated && 'rounded-lg outline outline-dashed outline-2 outline-accent/50')}>
      <div className="min-h-0 flex-1">
        <FlowCanvas {...canvasProps} runState={runState} />
      </div>
    </div>
  )
}
