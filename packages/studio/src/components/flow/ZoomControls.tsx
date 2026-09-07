'use client'

import { useReactFlow, useViewport } from '@xyflow/react'
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, SquareIcon } from '@enkaku/ui'

/**
 * The zoom control, as one horizontal pill with the level on it.
 *
 * Built from icons already in the set rather than two new ones: the icon
 * roster is closed at 85 and guarded (`check-design-tokens.ts`), and widening
 * it for a zoom button is a design decision, not a side effect of this
 * screen. The magnifiers say zoom more plainly than a bare +/− anyway.
 *
 * `@xyflow/react`'s own `<Controls>` is a vertical stack of icon buttons and
 * shows no number, so an author who had zoomed out had no way to read how far
 * — and "back to 100%" meant clicking until it looked right. The percentage
 * is the control: clicking it resets to 1.
 */
export function ZoomControls() {
  const { zoomIn, zoomOut, fitView, zoomTo } = useReactFlow()
  const { zoom } = useViewport()

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-card border border-border bg-panel/95 p-1 shadow-panel-2 backdrop-blur">
      <button type="button" aria-label="Zoom out" onClick={() => zoomOut()} className="flex size-7 items-center justify-center rounded-button text-dim transition-colors hover:bg-muted hover:text-text">
        <MagnifyingGlassMinusIcon className="size-3.5" aria-hidden />
      </button>
      <button type="button" aria-label="Zoom in" onClick={() => zoomIn()} className="flex size-7 items-center justify-center rounded-button text-dim transition-colors hover:bg-muted hover:text-text">
        <MagnifyingGlassPlusIcon className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Fit to content"
        onClick={() => fitView({ maxZoom: 1, padding: 0.25 })}
        className="flex size-7 items-center justify-center rounded-button text-dim transition-colors hover:bg-muted hover:text-text"
      >
        <SquareIcon className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Reset zoom to 100%"
        onClick={() => zoomTo(1)}
        className="readout min-w-[46px] rounded-button px-1.5 py-1 text-center text-[11.5px] text-dim transition-colors hover:bg-muted hover:text-text"
      >
        {Math.round(zoom * 100)}%
      </button>
    </div>
  )
}
