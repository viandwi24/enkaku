'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowsClockwiseIcon, Button, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, XIcon } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { frameSrc, frameStyle, ZOOM_STEPS } from './panel-frame'
import { clampGeometry, defaultGeometry, readGeometry, writeGeometry, MIN_SIDE_W, usePip, usePipRequest, type PipGeometry } from './pip-store'

/**
 * The docked right panel (plan 501 §4.3): the third sibling of the root flex
 * row, spanning the status bar's height too (§3.4) — a container matching
 * `PagePanel`'s own `rounded-panel border border-border bg-panel`.
 *
 * Reads the ONE panel store itself, exactly like `PipHost` (plan 501 §4.6):
 * renders nothing unless the current request is in `side` mode. There is
 * still exactly one panel; this is simply the other place that knows how to
 * draw it.
 *
 * What it does NOT have, unlike `PipPanel`: drag, the magnet, and stored x/y.
 * It is docked; those belong to the floating mode alone (§3.6). Both modes
 * still frame identically through `panel-frame.ts` — same `coreBase()`, same
 * `?pip=1`, same zoom-with-inverse-sizing.
 */
export function SidePanel(): React.JSX.Element | null {
  const request = usePipRequest()
  const { close } = usePip()

  const [geometry, setGeometry] = useState<PipGeometry>(defaultGeometry)
  const resizeRef = useRef<{ startX: number; sideWidth: number } | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Read the persisted geometry once, clamped to THIS viewport (mirrors
  // `PipPanel`'s own read — one `localStorage` key, one Zod parse, shared).
  useEffect(() => {
    setGeometry(clampGeometry(readGeometry(), window.innerWidth, window.innerHeight))
  }, [])

  useEffect(() => {
    function onResize() {
      setGeometry((g) => clampGeometry(g, window.innerWidth, window.innerHeight))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  function handleResizePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeRef.current = { startX: e.clientX, sideWidth: geometry.sideWidth }
  }
  function handleResizePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeRef.current) return
    const { startX, sideWidth } = resizeRef.current
    // The handle is the panel's LEFT edge (§3.5): dragging it left (a
    // decreasing clientX) widens the panel, so the delta is inverted from a
    // right-edge handle's.
    setGeometry((g) => clampGeometry({ ...g, sideWidth: sideWidth + (startX - e.clientX) }, window.innerWidth, window.innerHeight))
  }
  function handleResizePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeRef.current) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    resizeRef.current = null
    setGeometry((g) => {
      writeGeometry(g)
      return g
    })
  }

  function zoomBy(direction: 1 | -1) {
    setGeometry((g) => {
      const idx = ZOOM_STEPS.findIndex((step) => step === g.zoom)
      const nextIdx = Math.min(ZOOM_STEPS.length - 1, Math.max(0, (idx === -1 ? 2 : idx) + direction))
      const next = { ...g, zoom: ZOOM_STEPS[nextIdx] }
      writeGeometry(next)
      return next
    })
  }

  function refresh() {
    try {
      iframeRef.current?.contentWindow?.location.reload()
    } catch {
      // Cross-origin under `bun run dev:studio` — see `PipPanel`'s own note.
    }
  }

  if (!request || request.mode !== 'side') return null

  return (
    <div
      className="relative flex shrink-0 flex-col overflow-hidden rounded-panel border border-border bg-panel"
      style={{ width: geometry.sideWidth, minWidth: MIN_SIDE_W }}
    >
      {/* The left-edge resize handle (§3.5), pointer capture as `PipPanel`'s own corner grip uses (plan 500 §3.5, R2). */}
      <div
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        aria-hidden
        className="absolute top-0 left-0 z-10 h-full w-1 cursor-ew-resize"
      />

      <div className="flex h-[34px] shrink-0 items-center gap-1 border-b border-line bg-panel-2 px-2">
        <span className="min-w-0 flex-1 truncate text-meta font-medium text-text">{request.label}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={geometry.zoom <= ZOOM_STEPS[0]}
          onClick={() => zoomBy(-1)}
        >
          <MagnifyingGlassMinusIcon className="size-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={geometry.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
          onClick={() => zoomBy(1)}
        >
          <MagnifyingGlassPlusIcon className="size-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={refresh}>
          <ArrowsClockwiseIcon className="size-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={close}>
          <XIcon className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <iframe
          key={request.href}
          ref={iframeRef}
          src={frameSrc(coreBase(), request.href)}
          title={request.label}
          className="absolute top-0 left-0 border-0"
          style={frameStyle(geometry.zoom)}
        />
      </div>
    </div>
  )
}
