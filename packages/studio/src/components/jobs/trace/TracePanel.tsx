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
  frameStatusCounts,
  previousFrameEventAt,
  useJobTrace,
} from '@/lib/useJobTrace'
import { TraceEventDetail } from './TraceEventDetail'
import { TraceFrame } from './TraceFrame'
import { TraceScrubber } from './TraceScrubber'
import { TraceTimeline } from './TraceTimeline'
import { useTracePlayback } from './useTracePlayback'

/**
 * The Timeline tab (plan 128 §4.6, step 128.8) — the one composition of the
 * hook and the four components below it, so `app/jobs/detail/page.tsx` gains
 * exactly one render branch and the device popup's own in-place job detail
 * (`components/device-popup/JobDetailPanel.tsx`) can mount the identical
 * thing later without copying the wiring.
 *
 * A FAILED job opens with the playhead already on the failing event — the
 * question that brought the operator here is "what was on the screen when it
 * went wrong", and making them find that event first is making them do the
 * work twice. Any other job opens at the start of the trace.
 */
export function TracePanel({ jobId, jobStatus }: { jobId: string; jobStatus: JobStatus }) {
  const { events, loading, error, truncated, reload } = useJobTrace(jobId)

  const defaultIndex = useMemo(() => {
    if (events.length === 0) return 0
    if (jobStatus !== 'failed') return 0
    return failingEventIndex(events) ?? events.length - 1
  }, [events, jobStatus])

  // Play/pause (plan 130 step 130.6) — `useTracePlayback`'s own doc has the
  // design: `playheadMs` is a continuous axis position, `selected` is
  // `nearestEventIndex` applied to it every tick, and any manual selection
  // (below, via `select`) pauses first.
  const { selected, playheadMs, playing, speed, select, toggle, setSpeed } = useTracePlayback(events, defaultIndex)
  const selectedEvent = events[selected] ?? null
  const originMs = events[0]?.atMs ?? 0

  const policy = useMemo(() => capturePolicyAt(events, selected), [events, selected])
  const emptyLane = useMemo(() => explainEmptyActionLane(events, policy), [events, policy])
  const counts = useMemo(() => frameStatusCounts(events), [events])

  if (loading) return <LoadingRows rows={4} />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (events.length === 0) {
    return (
      <EmptyState
        title="Nothing recorded for this job"
        description="A trace is written while a job runs — every device action, log line, phase boundary and artifact on one time axis. A job that ran before job tracing existed, or whose trace has since been swept by the retention window, has none."
      />
    )
  }

  return (
    <div className="space-y-3">
      {/* Goal 6 — the timeline never omits silently. A fetch that hit the page
          ceiling has rendered a PREFIX, and a prefix that looks complete is
          the worst thing this tab could show a debugger: the run appears to
          simply stop. Plan §3.4 records one event per device call with no cap
          by design, so this is reachable on any long run, not a corner case. */}
      {truncated && (
        <div className="rounded-lg border border-led-warn/35 bg-led-warn/5 px-3.5 py-2.5 text-[12.5px]">
          <span className="text-fg">This timeline is incomplete.</span>{' '}
          <span className="text-fg-muted">
            Only the first {events.length.toLocaleString()} events were loaded — the run recorded more than this page can fetch. What you see below ends early; it is
            not where the job stopped.
          </span>
        </div>
      )}

      {/* The capture-policy line, read from the `phase` `start` event at or
          before the playhead — NOT derived from the events' own
          `frameStatus`, which a job that failed in `prepare` does not have
          (plan §3.4). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-surface px-3.5 py-2.5">
        <span className="readout text-[12.5px] text-fg">{describeCapturePolicy(policy)}</span>
        <span className="readout text-[11.5px] text-fg-subtle">
          {events.length} event{events.length === 1 ? '' : 's'} · {counts.ok} frame{counts.ok === 1 ? '' : 's'}
          {counts['skipped-policy'] > 0 && ` · ${counts['skipped-policy']} skipped by policy`}
          {counts['skipped-busy'] > 0 && ` · ${counts['skipped-busy']} skipped while busy`}
          {counts.failed > 0 && ` · ${counts.failed} capture${counts.failed === 1 ? '' : 's'} failed`}
        </span>
      </div>

      {/* Goal 4 — an empty action lane is stated in words, never left as a
          blank box the reader has to interpret. */}
      {emptyLane && (
        <p className="rounded-lg border border-line bg-bg px-3.5 py-2.5 text-[12.5px] text-fg-muted">{emptyLane}</p>
      )}

      <TraceScrubber
        events={events}
        selected={selected}
        onSelect={select}
        playheadMs={playheadMs}
        playing={playing}
        speed={speed}
        onToggle={toggle}
        onSpeedChange={setSpeed}
      />
      <TraceTimeline jobId={jobId} events={events} selected={selected} onSelect={select} />

      {/* `min-w-0` on both this row and its two children (plan 130 §3.4,
          step 130.2): a CSS Grid item's default `min-width: auto` sizes it
          to fit its own content, and `TraceFrame`'s screenshot has no
          explicit width — without this the column blows out to the image's
          native ~1080px, taking `TraceEventDetail`'s values off screen with
          it (§0.3). See both components' own doc comments for the full
          mechanism. */}
      <div className="grid min-w-0 gap-3 xl:grid-cols-[22rem_1fr]">
        <TraceFrame
          jobId={jobId}
          originMs={originMs}
          selectedEvent={selectedEvent}
          frameEvent={frameEventAt(events, selected)}
          previousFrameEvent={previousFrameEventAt(events, selected)}
        />
        <TraceEventDetail jobId={jobId} event={selectedEvent} originMs={originMs} />
      </div>
    </div>
  )
}
