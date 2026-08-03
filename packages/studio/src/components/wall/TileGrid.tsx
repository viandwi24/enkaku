import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The one responsive tile grid (Plan 42 §4.6): the fleet Wall and the
 * topology page's `ClusterSection` both lay tiles out with this component
 * instead of each carrying its own copy of the same Tailwind grid classes —
 * "one wall implementation rather than two," per the plan.
 */
export function TileGrid({
  minTileWidthPx = 200,
  className,
  children,
}: {
  /** The narrowest a tile may get before the grid wraps to a new row. */
  minTileWidthPx?: number
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn('grid gap-2', className)}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minTileWidthPx}px, 1fr))` }}
    >
      {children}
    </div>
  )
}
