'use client'

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
}

const STATUS_LABEL: Record<'live' | 'replay' | 'none', string> = {
  live: 'watching this run',
  replay: 'replaying a finished run',
  none: 'this workflow has never run',
}

export function RunOverlay({ jobId, runId, ...canvasProps }: RunOverlayProps) {
  const { runState, finalized, loading, steps } = useRunState(jobId, runId)
  const status: 'live' | 'replay' | 'none' = !jobId || !runId ? 'none' : finalized ? 'replay' : 'live'

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {jobId && runId && (
        <div className="flex flex-none flex-wrap items-center gap-2 text-[11.5px] text-fg-muted">
          <span className={cn('flex items-center gap-1', status === 'live' && 'text-accent')}>
            <CircleIcon weight="fill" className={cn('size-2', status === 'live' && 'animate-pulse')} aria-hidden />
            {loading ? 'loading run…' : STATUS_LABEL[status]}
          </span>
          {!loading && steps.length > 0 && <span>· {steps.length} step{steps.length === 1 ? '' : 's'}</span>}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <FlowCanvas {...canvasProps} runState={runState} />
      </div>
    </div>
  )
}
