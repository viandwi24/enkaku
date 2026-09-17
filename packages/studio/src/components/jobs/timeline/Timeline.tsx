'use client'

import { useMemo, useState } from 'react'
import type { JobStatus, JobTraceEvent } from '@enkaku/protocol'
import { EmptyState, ErrorState, LoadingRows } from '@enkaku/ui'
import {
  capturePolicyAt,
  describeCapturePolicy,
  explainEmptyActionLane,
  failingEventIndex,
  frameAfterStep,
  frameEventAt,
  isTimelineStep,
  nearestEventIndex,
  stepLabel,
  uiTreeEventAt,
  useJobTrace,
} from '@/lib/useJobTrace'
import { touchOf, type TimelineTouch } from '@/lib/trace-touch'
import { FrameAndEvent, type FrameView } from './FrameAndEvent'
import { FrameStrip } from './FrameStrip'
import { Lanes } from './Lanes'
import { Transport } from './Transport'
import { useTracePlayback } from './useTracePlayback'
import type { DrawnTouch } from './TouchOverlay'
import { UiTreePanel, type SelectedUiNode } from './UiTreePanel'

/**
 * The most touches drawn on one "before" frame. On an on-failure engine a
 * frame can be many steps old, and every tap since then was made on that
 * screen; past a handful the marks bury the picture they are meant to explain.
 */
const MAX_TRAIL_TOUCHES = 5

/**
 * The replay debugger (design handoff, "Screen: Jobs", **Timeline**): "four
 * stacked cards (`border: 1px solid var(--line-2)`, `border-radius: 12px`)"
 * — Transport, Lanes, Frames, Frame + Event.
 *
 * The playback axis is the run's STEPS (`isTimelineStep`), not every
 * recorded event: the device actions, the failure, and every event that
 * carries a picture. Log and progress rows, and phase boundaries without a
 * frame, are several times as many and stay off it. The full list is still
 * what the Lanes card draws (its Logs lane is log density) and what the
 * capture policy is read from; only the thing the playhead STEPS through is
 * narrowed.
 *
 * Two sentences the handoff does not draw are kept, because dropping them
 * turns a gap into a lie (plan 218 §3.6): a truncated fetch says so above the
 * cards, and the capture policy is folded into the Frames card's own heading,
 * which is where the handoff already puts a sentence of exactly that shape.
 */
export function Timeline({ jobId, runId, runStatus }: { jobId: string; runId: string; runStatus: JobStatus }) {
  const { events, loading, error, truncated, reload } = useJobTrace(jobId, runId)
  const actions = useMemo(() => events.filter(isTimelineStep), [events])
  // Parsed once per trace, not once per playback tick: the lane and the frame trail both read it.
  const touches = useMemo(() => actions.map(touchOf), [actions])

  const defaultIndex = useMemo(() => {
    if (actions.length === 0) return 0
    if (runStatus !== 'failed') return 0
    return failingEventIndex(actions) ?? actions.length - 1
  }, [actions, runStatus])

  const { selected, playheadMs, playing, speed, select, toggle, setSpeed } = useTracePlayback(actions, defaultIndex)
  const originMs = events[0]?.atMs ?? 0
  const endMs = events[events.length - 1]?.atMs ?? originMs
  const policy = useMemo(() => capturePolicyAt(events, nearestEventIndex(events, playheadMs)), [events, playheadMs])
  const emptyLane = useMemo(() => explainEmptyActionLane(events, policy), [events, policy])
  const [highlight, setHighlight] = useState<SelectedUiNode | null>(null)
  const [frameView, setFrameView] = useState<FrameView>('before')
  const frame = useMemo(() => resolveFrame(actions, touches, selected, frameView), [actions, touches, selected, frameView])

  if (loading) {
    return (
      <div className="p-[14px]">
        <LoadingRows rows={4} />
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-[14px]">
        <ErrorState message={error} onRetry={reload} />
      </div>
    )
  }
  if (events.length === 0) {
    return (
      <div className="p-[14px]">
        <EmptyState
          title="Nothing recorded for this run"
          description="A trace is written while a run executes: every device action, log line, phase boundary and artifact on one time axis. A run from before job tracing existed, or one whose trace has been swept by the retention window, has none."
        />
      </div>
    )
  }

  return (
    /*
       `min-w-[720px]` inside an `overflow-x-auto` wrapper: the lanes place
       their bars by percentage of the container, so a narrow panel squeezed
       a twenty-second run into a few hundred pixels and the transport row
       simply ran off the right edge with no way to reach it (owner,
       2026-09-04). Below the floor the whole timeline scrolls sideways, the
       way a video editor's does; above it, nothing changes.
    */
    <div className="overflow-x-auto">
      <div className="flex min-w-[720px] flex-col gap-[10px] px-[14px] pt-3 pb-4">
      {truncated && (
        <p className="rounded-inner border border-line-2 bg-warn-soft px-3 py-2 text-meta text-warn">
          This timeline is incomplete. Only the first {events.length.toLocaleString()} events were loaded; the run recorded more
          than one page can fetch. What you see below ends early, and it is not where the run stopped.
        </p>
      )}
      <Transport
        actions={actions}
        selected={selected}
        onSelect={select}
        playheadMs={playheadMs}
        originMs={originMs}
        endMs={endMs}
        playing={playing}
        speed={speed}
        onToggle={toggle}
        onSpeedChange={setSpeed}
      />
      <Lanes
        events={events}
        actions={actions}
        touches={touches}
        selected={selected}
        onSelect={select}
        originMs={originMs}
        endMs={endMs}
        emptyLane={emptyLane}
      />
      <FrameStrip
        jobId={jobId}
        runId={runId}
        actions={actions}
        touches={touches}
        selected={selected}
        onSelect={select}
        originMs={originMs}
        note={describeCapturePolicy(policy)}
      />
      <FrameAndEvent
        jobId={jobId}
        runId={runId}
        originMs={originMs}
        event={actions[selected] ?? null}
        frameEvent={frame.event}
        frameCaption={frame.caption}
        touches={frame.touches}
        touch={frame.touch}
        view={frame.view}
        onView={setFrameView}
        canView={frame.canView}
        highlight={highlight}
      />
      <UiTreePanel
        jobId={jobId}
        runId={runId}
        originMs={originMs}
        step={actions[selected] ?? null}
        treeEvent={uiTreeEventAt(actions, selected)}
        onSelectNode={setHighlight}
      />
      </div>
    </div>
  )
}

interface ResolvedFrame {
  event: JobTraceEvent | null
  caption: string | null
  touches: DrawnTouch[]
  touch: TimelineTouch | null
  view: FrameView | null
  canView: Record<FrameView, boolean>
}

/**
 * Which frame the Frame panel shows for a step, and what is drawn on it.
 *
 * A step that did not touch the screen shows its own frame, or the last one
 * before it — unchanged. A touch step offers two screens. BEFORE is the last
 * frame captured before the step, with every touch made since that frame
 * drawn on it in order, the selected one solid: that is the screen those
 * touches were actually made on. AFTER is the first frame at or after the
 * step — the step's own when it captured one — with the selected touch drawn
 * where it landed. Whichever half has no frame falls back to the other, and
 * the caption says how far from the step the picture really is, because on an
 * on-failure engine "the frame before" can be a minute old.
 */
function resolveFrame(
  steps: readonly JobTraceEvent[],
  touches: readonly (TimelineTouch | null)[],
  selected: number,
  wanted: FrameView,
): ResolvedFrame {
  const step = steps[selected] ?? null
  const touch = touches[selected] ?? null
  const before = selected > 0 ? frameEventAt(steps, selected - 1) : null
  const after = frameAfterStep(steps, selected)
  const canView = { before: before !== null, after: after !== null }

  if (!step || !touch) {
    const own = frameEventAt(steps, selected)
    const caption = own && step && own.id !== step.id ? `Last frame before this step: ${stepLabel(own)}, ${gap(step.atMs - own.atMs)} earlier.` : null
    return { event: own, caption, touches: [], touch: null, view: null, canView }
  }

  const view: FrameView = canView[wanted] ? wanted : canView.before ? 'before' : canView.after ? 'after' : wanted
  if (view === 'after') {
    const caption =
      after === null ? null : after.id === step.id ? 'The screen this step left.' : `First frame after this step: ${stepLabel(after)}, ${gap(after.atMs - step.atMs)} later.`
    return { event: after, caption, touches: [{ touch, current: true, order: 1 }], touch, view, canView }
  }

  const from = before ? steps.indexOf(before) + 1 : 0
  const trail: DrawnTouch[] = []
  for (let i = from; i <= selected; i++) {
    const t = touches[i] ?? null
    if (t) trail.push({ touch: t, current: i === selected, order: 0 })
  }
  const drawn = trail.slice(-MAX_TRAIL_TOUCHES).map((d, i) => ({ ...d, order: i + 1 }))
  const parts: string[] = []
  if (before) parts.push(`The screen this ${touch.kind === 'tap' ? 'tap' : 'gesture'} was made on, captured ${gap(step.atMs - before.atMs)} earlier.`)
  if (drawn.length > 1) parts.push(`${drawn.length} touches since, numbered in order.`)
  if (touch.estimated) parts.push('Placed from the script’s arguments; this run predates recorded touches.')
  return { event: before, caption: parts.join(' ') || null, touches: drawn, touch, view, canView }
}

function gap(ms: number): string {
  const abs = Math.max(0, ms)
  return abs < 1000 ? `${Math.round(abs)} ms` : `${(abs / 1000).toFixed(1)} s`
}
