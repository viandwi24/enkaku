'use client'

import type { Viewer } from '@enkaku/protocol'
import { Hand } from 'lucide-react'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/** A short, stable label for a viewer that has no resolved user name (plan 31 §3.3). */
export function shortSessionLabel(sessionId: string): string {
  return `session ${sessionId.slice(0, 4)}`
}

export function labelFor(viewer: Viewer): string {
  return viewer.userLabel ?? shortSessionLabel(viewer.sessionId)
}

/**
 * Who is watching this device, live (plan 31 §4.3). One row per WS session —
 * not per user — because the confusing case ("my other tab has it") only
 * shows up if two tabs from the same person get two rows.
 *
 * Since plan 57 §3.3 this is the body of the header's viewer popover rather
 * than a permanent panel: the count is what an operator watches, the list is
 * what they look up. So it renders bare — no card, no heading — because the
 * popover's own trigger already carries the count.
 *
 * `hoveredSessionId` / `onHoverSession` are still lifted to the device page so
 * the holder's row and the "held by" tooltip read the same hovered session
 * (plan 31 §4.3's "visual link the operator asked for").
 */
export function ViewerList({
  viewers,
  now,
  mySessionId,
  hoveredSessionId,
  onHoverSession,
}: {
  viewers: Viewer[]
  now: number
  mySessionId: string | null
  hoveredSessionId: string | null
  onHoverSession: (sessionId: string | null) => void
}) {
  return (
    <div>
      {viewers.length === 0 ? (
        <p className="text-[12px] text-fg-muted">Nobody is watching this device right now.</p>
      ) : (
        <ul className="space-y-1.5">
          {viewers.map((v) => {
            const isMe = v.sessionId === mySessionId
            return (
              <li
                key={v.sessionId}
                onMouseEnter={() => onHoverSession(v.sessionId)}
                onMouseLeave={() => onHoverSession(null)}
                className={cn(
                  'rounded-md px-1.5 py-1 text-[12.5px] leading-snug transition-colors',
                  v.holdsControl && 'bg-led-ok/5',
                  hoveredSessionId === v.sessionId && 'bg-accent/10',
                )}
              >
                {/* Two lines, not one squeezed row (18rem is narrow): the name
                    must never truncate away to make room for the control
                    badge — that is the one fact this panel exists to show. */}
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {labelFor(v)}
                    {isMe && <span className="text-fg-muted"> — this tab</span>}
                  </span>
                  <span className="readout shrink-0 text-[11px] text-fg-muted">{relativeTime(v.since, now)}</span>
                </div>
                {v.holdsControl && (
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] text-led-ok">
                    <Hand className="size-3" aria-hidden />
                    holding control
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
