'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The owner's own words (plan 91 §0.3, §5 step 91.8, F11/F12): *"mouse akan
 * ada indikator device yang terseleksi berapa"* — a small badge that follows
 * the pointer while select mode is on, naming how many devices are currently
 * selected. Mounted once by the dashboard (`app/page.tsx`), not scoped to
 * the Wall specifically — selection is now one shared `useBulkSelection`
 * instance behind both List and Wall, so the indicator follows the same
 * rule in either view.
 *
 * Two rules keep the badge from becoming its own defect, both required by
 * this step's own brief:
 *  - **it never covers the pointer target.** It is offset from the raw
 *    cursor position AND `pointer-events-none`, so even if the offset ever
 *    put it visually over something, a click still reaches whatever is
 *    underneath rather than the badge.
 *  - **`prefers-reduced-motion`**: there is no motion to honour. A follower
 *    that eases toward the pointer is not "smooth", it is late — see below.
 *
 * ## Why the position is written to the DOM, not held in state
 *
 * The first version did `setPos({x, y})` on every `mousemove`, rendered
 * `left`/`top` from it, and carried `transition-all duration-100`. The owner
 * reported it as *"patah patah"* / *"lompat lompat"* — stuttering rather
 * than following. Three separate causes compounded, and the least obvious
 * one did the most damage:
 *
 *  1. **The CSS transition was the main fault.** A transition on a property
 *     that is being reassigned continuously never completes: every pointer
 *     event restarts a fresh 100ms ease toward a target that has already
 *     moved, so the badge permanently chases and never arrives. With
 *     discrete update timing on top, that reads as stepping. A cursor
 *     follower must track exactly and instantly — it is already at the one
 *     position it is supposed to be at, so there is nothing to animate.
 *  2. **A React state update per pointer event** meant a full render and
 *     reconciliation 60–120 times a second, on a page that may be decoding
 *     24–40 H.264 streams at the same time (plan 100 §3.1: browser decode
 *     capacity is this page's binding constraint). The badge was competing
 *     with the video for the same budget.
 *  3. **`left`/`top` forces layout**, then paint, on every change.
 *     `transform: translate3d()` is handled by the compositor and touches
 *     neither.
 *
 * So: coordinates are kept in closure variables, coalesced to one write per
 * animation frame, and written straight to the node's `transform`. React
 * re-renders only when `count` changes — which is the only thing on this
 * badge that ever actually needs re-rendering.
 */
export function SelectionCursorBadge({ active, count }: { active: boolean; count: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Not the position — only "has the pointer moved yet", so the badge does
  // not flash at the top-left corner for one frame before the first event.
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!active) {
      setReady(false)
      return
    }
    let frame = 0
    let queued = false
    let x = 0
    let y = 0
    const paint = () => {
      queued = false
      // The +16 offset is the "never covers the pointer target" rule above,
      // kept identical to the pre-rewrite behaviour.
      if (ref.current) ref.current.style.transform = `translate3d(${x + 16}px, ${y + 16}px, 0)`
    }
    const onMove = (e: MouseEvent) => {
      x = e.clientX
      y = e.clientY
      // React bails out on an identical value, so this re-renders once, on
      // the first move, and never again for the life of the drag.
      setReady(true)
      if (queued) return
      queued = true
      frame = requestAnimationFrame(paint)
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(frame)
    }
  }, [active])

  // Two, not one (owner's call, 2026-08-16). A single selected device is
  // already legible on the grid — its own tile carries the accent tint and
  // border — so a badge following the cursor to announce "1 selected" is
  // restating what the operator can see, in the one place they are looking
  // while they work. The badge earns its place only once the selection is
  // larger than a glance can count.
  if (!active || count < 2) return null

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      data-ready={ready ? '' : undefined}
      className="pointer-events-none fixed left-0 top-0 z-50 rounded-full border border-accent/50 bg-surface-2/95 px-2 py-0.5 text-[11px] font-medium text-accent-strong opacity-0 shadow-lg data-[ready]:opacity-100"
    >
      {count} selected
    </div>
  )
}
