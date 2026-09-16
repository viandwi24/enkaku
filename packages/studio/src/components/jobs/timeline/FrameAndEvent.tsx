'use client'

import { useState } from 'react'

import type { JobTraceEvent } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { STRIPE } from '../job-view'
import { stepLabel } from '@/lib/useJobTrace'
import { formatOffset } from './lane-math'
import type { SelectedUiNode } from './UiTreePanel'

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
  highlight,
}: {
  jobId: string
  runId: string
  originMs: number
  event: JobTraceEvent | null
  frameEvent: JobTraceEvent | null
  previousFrameEvent: JobTraceEvent | null
  /** The node selected in the UI nodes card, outlined on this frame. */
  highlight: SelectedUiNode | null
}) {
  const shown = frameEvent ?? previousFrameEvent
  /** Reset per frame: a hash that 404s says nothing about the next one. */
  const [failedHash, setFailedHash] = useState<string | null>(null)
  const failed = shown?.frameHash != null && failedHash === shown.frameHash
  const setFailed = () => setFailedHash(shown?.frameHash ?? null)
  const retry = (event?.attempt ?? 1) > 1
  const failedStep = event?.ok === false || event?.kind === 'error'
  const badge = failedStep ? 'failed' : event?.kind === 'artifact' ? 'screenshot' : event?.kind === 'phase' ? 'snapshot' : retry ? 'retry' : 'ok'
  const message = typeof event?.meta?.message === 'string' ? event.meta.message : null
  return (
    <div className="flex items-stretch gap-[10px]">
      <div className="w-[168px] flex-none rounded-inner border border-line-2 p-[10px]">
        <div className="pb-2 text-label text-faint">Frame</div>
        <div
          className="flex aspect-[9/19.5] w-full items-end justify-center overflow-hidden rounded-button border border-line-2 pb-2"
          style={shown?.frameHash ? undefined : STRIPE}
        >
          {shown?.frameHash && !failed ? (
            <div className="relative size-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${coreBase()}/api/jobs/${jobId}/runs/${runId}/trace/frames/${shown.frameHash}`}
                alt={`Screen at ${formatOffset(shown.atMs, originMs)}`}
                className="size-full object-contain"
                /* Same reason as `FrameStrip`: a swept frame must not render as
                   the browser's broken-image glyph. */
                onError={setFailed}
              />
              {highlight && highlight.extent.width > 0 && highlight.extent.height > 0 && (
                /*
                  Laid over the image in the tree's own coordinates.
                  `xMidYMid meet` is the SVG twin of the image's
                  `object-contain`, so the outline lands on the node however
                  the picture is letterboxed — and a screenshot taken at a
                  lower resolution than the screen still lines up, because
                  both are scaled into the same box.
                */
                <svg
                  className="pointer-events-none absolute inset-0 size-full"
                  viewBox={`0 0 ${highlight.extent.width} ${highlight.extent.height}`}
                  preserveAspectRatio="xMidYMid meet"
                  aria-hidden
                >
                  <rect
                    x={highlight.node.bounds.left}
                    y={highlight.node.bounds.top}
                    width={Math.max(0, highlight.node.bounds.right - highlight.node.bounds.left)}
                    height={Math.max(0, highlight.node.bounds.bottom - highlight.node.bounds.top)}
                    className="fill-accent/20 stroke-accent"
                    strokeWidth={Math.max(2, highlight.extent.width / 180)}
                  />
                </svg>
              )}
            </div>
          ) : (
            <span className="font-mono text-tip text-faint">
              {shown?.frameHash ? 'this frame is no longer stored — retention swept it' : 'no frame stored at or before this point'}
            </span>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
        {event === null ? (
          <p className="text-meta text-faint">Nothing selected.</p>
        ) : (
          <>
            <div className="flex items-center gap-[9px] pb-2">
              <span className="truncate font-mono text-[13px] font-medium">{stepLabel(event)}</span>
              <span
                className={cn(
                  'flex-none rounded-pill px-2 py-[3px] text-tip font-semibold',
                  failedStep ? 'bg-danger-soft text-danger' : retry ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent',
                )}
              >
                {badge}
              </span>
              <span className="flex-none font-mono text-meta text-faint">{formatOffset(event.atMs, originMs)}</span>
            </div>
            <Row label="phase" value={event.phase ?? '—'} />
            <Row label="attempt" value={String(event.attempt)} />
            <Row label="duration" value={event.durationMs === null ? '—' : `${event.durationMs} ms`} />
            <Row label="seq" value={String(event.seq)} />
            <Row
              label="ui nodes"
              value={event.uiHash ? 'captured · raw JSON' : 'not captured'}
              href={event.uiHash ? `${coreBase()}/api/jobs/${jobId}/runs/${runId}/trace/ui/${event.uiHash}` : undefined}
            />
            {event.errorCode && <Row label="error code" value={event.errorCode} />}
            {message && <p className="pt-[10px] font-mono text-meta leading-[1.6] break-words text-danger">{message}</p>}
            {event.kind === 'action' && (
              <>
                <div className="pt-[10px] pb-[6px] text-label text-faint">Arguments</div>
                <p className="font-mono text-meta leading-[1.7] text-text-3">
                  Recorded already redacted &mdash; typed text and clipboard writes store only a length.
                </p>
              </>
            )}
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
