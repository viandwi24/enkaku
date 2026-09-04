'use client'

import type { JobTraceEvent } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { STRIPE } from '../job-view'
import { formatOffset } from './lanes'

/**
 * Card 3 (design handoff): "*Frames*: "Frames · 18 events · frames captured
 * per action" and a horizontal strip of 76px 9:19.5 thumbnails, each with its
 * timestamp and action name; the current frame gets a `2px solid
 * var(--accent)` border. Clicking a frame moves the playhead."
 *
 * The heading's third clause is the live capture-policy sentence
 * (`describeCapturePolicy`, e.g. "Frames: per action (ui-server)") rather
 * than the handoff's fixed words: a run whose inspector fell back mid-flight,
 * or one that ran on a cloud node and captured nothing, must say so where the
 * reader is looking for frames (plan 218 §3.6).
 *
 * An action with no `frameHash` still gets a card, striped and captioned:
 * a gap in the strip would read as "nothing happened here", which is the one
 * thing a debugger must not be told.
 */
export function FrameStrip({
  jobId,
  runId,
  actions,
  selected,
  onSelect,
  originMs,
  note,
}: {
  jobId: string
  runId: string
  actions: JobTraceEvent[]
  selected: number
  onSelect: (index: number) => void
  originMs: number
  note: string
}) {
  return (
    <div className="rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
      <div className="pb-2 text-label text-faint">
        Frames · {actions.length} event{actions.length === 1 ? '' : 's'} · {note}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {actions.map((e, i) => (
          <button key={e.id} type="button" onClick={() => onSelect(i)} className="w-[76px] flex-none text-left">
            <div
              className={cn(
                'flex aspect-[9/19.5] w-[76px] items-end justify-center overflow-hidden rounded-small border-2 pb-[5px]',
                i === selected ? 'border-accent' : 'border-line-2',
              )}
              style={e.frameHash ? undefined : STRIPE}
            >
              {e.frameHash ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${coreBase()}/api/jobs/${jobId}/runs/${runId}/trace/frames/${e.frameHash}`}
                  alt={`Screen at ${formatOffset(e.atMs, originMs)}`}
                  className="size-full object-cover"
                />
              ) : (
                <span className="font-mono text-[9px] text-faint">{formatOffset(e.atMs, originMs)}</span>
              )}
            </div>
            <div className={cn('mt-[5px] truncate text-center text-tip', i === selected ? 'text-accent' : 'text-faint')}>
              {e.name}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
