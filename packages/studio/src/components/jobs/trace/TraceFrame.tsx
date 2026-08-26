'use client'

import { useState } from 'react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { Button, cn } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { FRAME_STATUS_WORD, formatOffset } from './TraceTimeline'

/**
 * The frame at the playhead, with the previous frame available as a
 * before/after toggle (plan 128 §4.6, step 128.8).
 *
 * **A missing frame is always explained, never blank** (goal 6). Four things
 * are genuinely different and are worded differently: the policy took no
 * frame for this action, one was skipped because a capture was already in
 * flight, one was attempted and failed, and this event was never a candidate
 * for a frame at all (a log line). The last case still shows the most recent
 * frame BEFORE the playhead — scrubbing onto a log line should show the
 * screen as it was at that instant, which is the whole reason the timeline
 * exists.
 */
export function TraceFrame({
  jobId,
  originMs,
  selectedEvent,
  frameEvent,
  previousFrameEvent,
}: {
  jobId: string
  originMs: number
  selectedEvent: JobTraceEvent | null
  frameEvent: JobTraceEvent | null
  previousFrameEvent: JobTraceEvent | null
}) {
  const [showPrevious, setShowPrevious] = useState(false)
  const shown = showPrevious && previousFrameEvent ? previousFrameEvent : frameEvent
  const status = selectedEvent?.frameStatus ?? null
  const stale = Boolean(frameEvent && selectedEvent && frameEvent.id !== selectedEvent.id)

  return (
    <div className="rounded-lg border bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="rack-label">frame</h2>
        {previousFrameEvent && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11.5px]"
            onClick={() => setShowPrevious((v) => !v)}
            aria-pressed={showPrevious}
          >
            {showPrevious ? 'Show after' : 'Show before'}
          </Button>
        )}
      </div>

      {/* The capture outcome for the SELECTED event, always stated when there
          is one — a `skipped-busy` or `failed` capture must read as itself,
          not as a gap between two thumbnails. */}
      {status && status !== 'ok' && (
        <p
          data-frame-status={status}
          className={cn(
            'mb-2 rounded-md border px-2.5 py-1.5 text-[12px]',
            status === 'failed'
              ? 'border-led-danger/40 bg-led-danger/10 text-led-danger'
              : status === 'skipped-busy'
                ? 'border-led-warn/40 bg-led-warn/10 text-led-warn'
                : 'border-line bg-bg text-fg-muted',
          )}
        >
          {FRAME_STATUS_WORD[status]}
        </p>
      )}

      {shown ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${coreBase()}/api/jobs/${jobId}/trace/frames/${shown.frameHash}`}
            alt={`Screen at ${formatOffset(shown.atMs, originMs)}`}
            className="max-h-[28rem] w-full rounded-md border bg-bg object-contain"
          />
          <p className="readout mt-1.5 text-[11px] text-fg-subtle">
            {formatOffset(shown.atMs, originMs)} · {shown.name}
            {shown.id !== frameEvent?.id ? ' · the frame before this one' : stale ? ' · the most recent frame before the playhead' : ''}
          </p>
        </>
      ) : (
        <p className="rounded-md border border-dashed bg-bg px-3 py-6 text-center text-[12px] text-fg-subtle">
          No frame stored at or before this point in the trace.
        </p>
      )}
    </div>
  )
}
