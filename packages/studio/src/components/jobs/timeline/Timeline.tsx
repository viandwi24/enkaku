'use client'

import { useMemo } from 'react'
import type { JobStatus } from '@enkaku/protocol'
import { EmptyState, ErrorState, LoadingRows } from '@enkaku/ui'
import {
  capturePolicyAt,
  describeCapturePolicy,
  explainEmptyActionLane,
  failingEventIndex,
  frameEventAt,
  nearestEventIndex,
  previousFrameEventAt,
  useJobTrace,
} from '@/lib/useJobTrace'
import { FrameAndEvent } from './FrameAndEvent'
import { FrameStrip } from './FrameStrip'
import { Lanes } from './Lanes'
import { Transport } from './Transport'
import { useTracePlayback } from './useTracePlayback'

/**
 * The replay debugger (design handoff, "Screen: Jobs", **Timeline**): "four
 * stacked cards (`border: 1px solid var(--line-2)`, `border-radius: 12px`)"
 * — Transport, Lanes, Frames, Frame + Event.
 *
 * The playback axis is the ACTION events, not every recorded event: the
 * handoff's own readout is "event 10 of 18" beside a Frames card that says
 * "18 events · frames captured per action", and a trace of the same run holds
 * several times that many phase, log and artifact rows. The full list is
 * still what the Lanes card draws (its Logs lane is log density) and what the
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
  const actions = useMemo(() => events.filter((e) => e.kind === 'action'), [events])

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
        frameEvent={frameEventAt(actions, selected)}
        previousFrameEvent={previousFrameEventAt(actions, selected)}
      />
      </div>
    </div>
  )
}
