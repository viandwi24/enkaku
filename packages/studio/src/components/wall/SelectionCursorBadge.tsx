'use client'

import { useEffect, useState } from 'react'

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
 *  - **`prefers-reduced-motion` is honoured.** The only motion here is a
 *    plain CSS `transition` on `left`/`top`, which `globals.css`'s existing
 *    global rule (`@media (prefers-reduced-motion: reduce) { * { transition-
 *    duration: 0.01ms !important } }`) already cuts to near-zero — no
 *    separate media query needed in this file.
 */
export function SelectionCursorBadge({ active, count }: { active: boolean; count: number }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!active) {
      setPos(null)
      return
    }
    const onMove = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY })
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [active])

  if (!active || count === 0 || !pos) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed z-50 rounded-full border border-accent/50 bg-surface-2/95 px-2 py-0.5 text-[11px] font-medium text-accent-strong shadow-lg transition-all duration-100 ease-out"
      style={{ left: pos.x + 16, top: pos.y + 16 }}
    >
      {count} selected
    </div>
  )
}
