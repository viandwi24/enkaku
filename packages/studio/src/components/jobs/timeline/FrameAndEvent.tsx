'use client'

import type { JobTraceEvent } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { STRIPE } from '../job-view'
import { formatOffset } from './lanes'

/**
 * Card 4 (design handoff): "*Frame + Event*: a 168px column showing the
 * current frame large, beside an event panel — action name (`Geist Mono`
 * 13px), an `ok`/`retry` badge, the timestamp, then phase / attempt /
 * duration / seq / ui nodes rows, and an **Arguments** note: *"Recorded
 * already redacted — typed text and clipboard writes store only a length."*"
 *
 * The Arguments note is quoted from the design of record and carries its own
 * em dash; it is copy, not prose written here.
 *
 * A sixth row, `error code`, renders only when the event carries one. The
 * handoff's sample trace has no failing action; a real one does, and the code
 * is the shortest true answer to "why did this action fail".
 */
export function FrameAndEvent({
  jobId,
  runId,
  originMs,
  event,
  frameEvent,
  previousFrameEvent,
}: {
  jobId: string
  runId: string
  originMs: number
  event: JobTraceEvent | null
  frameEvent: JobTraceEvent | null
  previousFrameEvent: JobTraceEvent | null
}) {
  const shown = frameEvent ?? previousFrameEvent
  const retry = (event?.attempt ?? 1) > 1
  return (
    <div className="flex items-stretch gap-[10px]">
      <div className="w-[168px] flex-none rounded-inner border border-line-2 p-[10px]">
        <div className="pb-2 text-label text-faint">Frame</div>
        <div
          className="flex aspect-[9/19.5] w-full items-end justify-center overflow-hidden rounded-button border border-line-2 pb-2"
          style={shown?.frameHash ? undefined : STRIPE}
        >
          {shown?.frameHash ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${coreBase()}/api/jobs/${jobId}/runs/${runId}/trace/frames/${shown.frameHash}`}
              alt={`Screen at ${formatOffset(shown.atMs, originMs)}`}
              className="size-full object-contain"
            />
          ) : (
            <span className="font-mono text-tip text-faint">no frame stored at or before this point</span>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
        {event === null ? (
          <p className="text-meta text-faint">Nothing selected.</p>
        ) : (
          <>
            <div className="flex items-center gap-[9px] pb-2">
              <span className="truncate font-mono text-[13px] font-medium">{event.name}</span>
              <span
                className={cn(
                  'flex-none rounded-pill px-2 py-[3px] text-tip font-semibold',
                  event.ok === false ? 'bg-danger-soft text-danger' : retry ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent',
                )}
              >
                {event.ok === false ? 'failed' : retry ? 'retry' : 'ok'}
              </span>
              <span className="flex-none font-mono text-meta text-faint">{formatOffset(event.atMs, originMs)}</span>
            </div>
            <Row label="phase" value={event.phase ?? '—'} />
            <Row label="attempt" value={String(event.attempt)} />
            <Row label="duration" value={event.durationMs === null ? '—' : `${event.durationMs} ms`} />
            <Row label="seq" value={String(event.seq)} />
            <Row
              label="ui nodes"
              value={event.uiHash ? 'captured' : 'not captured'}
              href={event.uiHash ? `${coreBase()}/api/jobs/${jobId}/runs/${runId}/trace/ui/${event.uiHash}` : undefined}
            />
            {event.errorCode && <Row label="error code" value={event.errorCode} />}
            <div className="pt-[10px] pb-[6px] text-label text-faint">Arguments</div>
            <p className="font-mono text-meta leading-[1.7] text-text-3">
              Recorded already redacted &mdash; typed text and clipboard writes store only a length.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-muted-2 py-[5px]">
      <span className="flex-none text-meta text-faint">{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="truncate font-mono text-meta text-accent hover:underline">
          {value}
        </a>
      ) : (
        <span className="truncate font-mono text-meta text-text">{value}</span>
      )}
    </div>
  )
}
