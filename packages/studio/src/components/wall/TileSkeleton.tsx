import { TileGrid } from './TileGrid'
import { Skeleton } from '@enkaku/ui'

/**
 * The Wall's loading state, for BOTH rows §4.7 names "loading" (Plan 92
 * §4.7, fixes F16's neighbour finding — an unexplained blank tile is a
 * defect, `docs/design.md:49`):
 *
 *  - devices unknown (`Wall`'s own `devices === null`), and
 *  - settings unknown (`wall.maxTiles` not answered yet — same skeleton,
 *    so starting the right number of live streams once, not the wrong
 *    number twice, never has to repaint the grid — F14).
 *
 * A tile-shaped skeleton, not `LoadingRows`' full-width bars: the layout
 * must not jump when real tiles replace it, so this renders the SAME
 * `TileGrid` at the SAME tile size the real grid will use — chrome, chip
 * placeholders, a dark screen area, in the same one-chrome-block-then-
 * picture shape `WallTile` itself draws (plan 48 §3.1).
 */
export function TileSkeleton({
  /** Skeleton tiles to draw. Pass the real device count once it is known
   * (settings still loading, devices already are) so the grid does not
   * reflow to a different row count when the real tiles land; the default
   * covers the "devices unknown" row, where there is nothing to count yet. */
  count = 8,
  minTileWidthPx = 180,
}: {
  count?: number
  minTileWidthPx?: number
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading devices…</span>
      <TileGrid minTileWidthPx={minTileWidthPx}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5 overflow-hidden rounded-lg border bg-surface px-2 py-1.5" aria-hidden="true">
            <div className="flex items-center gap-1.5">
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="flex items-center gap-1.5">
              <Skeleton className="h-2.5 w-8" />
              <Skeleton className="h-2.5 w-8" />
              <Skeleton className="h-2.5 w-10" />
            </div>
            <Skeleton className="aspect-[9/16] w-full rounded-md" />
          </div>
        ))}
      </TileGrid>
    </div>
  )
}
