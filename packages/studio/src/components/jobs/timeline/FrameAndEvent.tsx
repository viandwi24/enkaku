'use client'

import { useState } from 'react'

import type { JobTraceEvent } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { describeTouch, type TimelineTouch } from '@/lib/trace-touch'
import { STRIPE } from '../job-view'
import { stepLabel } from '@/lib/useJobTrace'
import { formatOffset } from './lane-math'
import { TouchOverlay, type DrawnTouch } from './TouchOverlay'
import type { SelectedUiNode } from './UiTreePanel'

/** Which screen a touch step shows: the one it was made on, or the one it left. */
export type FrameView = 'before' | 'after'

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
 *
 * A step that touched the screen gets a Before / After switch above its
 * frame, and its touch drawn on it (`TouchOverlay`). "Before" is the default
 * because a frame captured for an action is taken AFTER the action: a tap
 * drawn on that picture sits on a screen it may already have changed. The
 * parent decides which event each half resolves to and says in `frameCaption`
 * how far away it is.
 */
export function FrameAndEvent({
  jobId,
  runId,
  originMs,
  event,
  frameEvent,
  frameCaption,
  touches,
  touch,
  view,
  onView,
  canView,
  highlight,
}: {
  jobId: string
  runId: string
  originMs: number
  event: JobTraceEvent | null
  /** The event whose frame is shown. */
  frameEvent: JobTraceEvent | null
  /** A short note on which screen this is, when it is not simply the step's own. */
  frameCaption: string | null
  /** The touches to draw on the shown frame. */
  touches: DrawnTouch[]
  /** The selected step's own touch, for the detail row. */
  touch: TimelineTouch | null
  /** Set only for a touch step. */
  view: FrameView | null
  onView: (view: FrameView) => void
  canView: Record<FrameView, boolean>
  /** The node selected in the UI nodes card, outlined on this frame. */
  highlight: SelectedUiNode | null
}) {
  const retry = (event?.attempt ?? 1) > 1
  const failedStep = event?.ok === false || event?.kind === 'error'
  const badge = failedStep ? 'failed' : event?.kind === 'artifact' ? 'screenshot' : event?.kind === 'phase' ? 'snapshot' : retry ? 'retry' : 'ok'
  const message = typeof event?.meta?.message === 'string' ? event.meta.message : null
  const hash = frameEvent?.frameHash ?? null
  return (
    <div className="flex items-stretch gap-[10px]">
      <div className="w-[168px] flex-none rounded-inner border border-line-2 p-[10px]">
        <div className="flex items-center justify-between gap-2 pb-2">
          <span className="text-label text-faint">Frame</span>
          {view && (
            <div className="flex gap-[2px] rounded-small bg-muted p-[2px]">
              {(['before', 'after'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={!canView[v]}
                  onClick={() => onView(v)}
                  className={cn(
                    'rounded-[6px] px-[6px] py-[2px] text-tip capitalize transition-colors disabled:opacity-40',
                    v === view ? 'bg-panel font-semibold text-text' : 'font-medium text-faint hover:text-text',
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
        </div>
        <div
          className="flex aspect-[9/19.5] w-full items-end justify-center overflow-hidden rounded-button border border-line-2 pb-2"
          style={hash ? undefined : STRIPE}
        >
          {hash && frameEvent ? (
            <FrameImage
              // Keyed by hash: the natural size and a failed load belong to one picture, never the next.
              key={hash}
              src={`${coreBase()}/api/jobs/${jobId}/runs/${runId}/trace/frames/${hash}`}
              alt={`Screen at ${formatOffset(frameEvent.atMs, originMs)}`}
              touches={touches}
              highlight={highlight}
            />
          ) : (
            <span className="px-1 text-center font-mono text-tip text-faint">
              {view === 'after' ? 'no frame stored after this step' : 'no frame stored at or before this point'}
            </span>
          )}
        </div>
        {frameCaption && <p className="pt-[6px] text-tip leading-snug text-faint">{frameCaption}</p>}
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
            {touch && <Row label="touch" value={describeTouch(touch)} />}
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

function FrameImage({
  src,
  alt,
  touches,
  highlight,
}: {
  src: string
  alt: string
  touches: DrawnTouch[]
  highlight: SelectedUiNode | null
}) {
  /** The picture's own pixel size — the space every touch mark is placed in. Unknown until it loads. */
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)

  if (failed) {
    return <span className="font-mono text-tip text-faint">this frame is no longer stored — retention swept it</span>
  }
  return (
    <div className="relative size-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="size-full object-contain"
        onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        /* Same reason as `FrameStrip`: a swept frame must not render as
           the browser's broken-image glyph. */
        onError={() => setFailed(true)}
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
      {natural && <TouchOverlay touches={touches} frame={natural} />}
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
