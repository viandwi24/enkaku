'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowsClockwiseIcon, Button, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, XIcon } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { registerOverlay } from '@/lib/overlays'
import {
  ZOOM_STEPS,
  applyMagnet,
  clampGeometry,
  defaultGeometry,
  readGeometry,
  repinToEdge,
  writeGeometry,
  type PipGeometry,
  type PipRequest,
} from './pip-store'

const MIN_W = 280
const MIN_H = 200

/**
 * The picture-in-picture panel (plan 500 §4.3): a floating window over a
 * framed copy of another Studio page. `fixed`, `z-40` — below Device
 * Control's `z-50`, because the cast is the more important picture (§3.7).
 *
 * The frame's `src` is `coreBase()`, not the page's own origin (§3.4, G10):
 * under `bun run dev:studio` the shell runs on :3001 but the frame loads
 * from the core on :7700, which serves the LAST `bun run build:studio`
 * output. Refresh reloads that document; only rebuilding the export changes
 * what it shows. This is accepted, not a defect (owner, 2026-09-05).
 *
 * The iframe's `key` is `request.href`, so switching pages replaces the
 * document instead of navigating inside it — instant and stateless, and
 * what makes G6's refresh a real reload rather than a React remount that
 * leaves module state behind (§3.3).
 */
export function PipPanel({ request, onClose }: { request: PipRequest; onClose: () => void }) {
  const [geometry, setGeometry] = useState<PipGeometry>(defaultGeometry)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; w: number; h: number } | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Read the persisted geometry once, clamped to THIS viewport (G9): a
  // panel dragged to a corner on a 27-inch display must not open off-screen
  // on a laptop.
  useEffect(() => {
    setGeometry(clampGeometry(readGeometry(), window.innerWidth, window.innerHeight))
  }, [])

  // A `window.resize` re-pins a snapped panel to its edge rather than
  // leaving it stranded off-screen (§3.5) — the one thing that makes
  // edge-snapping worth having over free-form dragging.
  useEffect(() => {
    function onResize() {
      setGeometry((g) => clampGeometry(repinToEdge(g, window.innerWidth, window.innerHeight), window.innerWidth, window.innerHeight))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Registered at the `selection` tier — BELOW the `menu`/`window` tiers
  // `ActionDialog` and Device Control register at (§4.6). Escape closes an
  // open dialog first; the panel only closes when nothing else is open. A
  // floating panel that vanishes on the Escape meant for a dropdown would be
  // worse than one that ignores Escape entirely.
  useEffect(() => registerOverlay('selection', onClose), [onClose])

  function handleGripPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { dx: e.clientX - geometry.x, dy: e.clientY - geometry.y }
  }
  function handleGripPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    const { dx, dy } = dragRef.current
    setGeometry((g) => clampGeometry({ ...g, x: e.clientX - dx, y: e.clientY - dy, edge: null }, window.innerWidth, window.innerHeight))
  }
  function handleGripPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setGeometry((g) => {
      const snapped = applyMagnet(g, window.innerWidth, window.innerHeight)
      writeGeometry(snapped)
      return snapped
    })
  }

  function handleResizePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeRef.current = { startX: e.clientX, startY: e.clientY, w: geometry.w, h: geometry.h }
  }
  function handleResizePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeRef.current) return
    const { startX, startY, w, h } = resizeRef.current
    setGeometry((g) =>
      clampGeometry(
        { ...g, w: Math.max(MIN_W, w + (e.clientX - startX)), h: Math.max(MIN_H, h + (e.clientY - startY)) },
        window.innerWidth,
        window.innerHeight,
      ),
    )
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
      // Cross-origin under `bun run dev:studio` (shell on :3001, frame on
      // the core's :7700, §3.4) — a browser refuses a cross-origin
      // `reload()`. Same-origin in every real deployment, where Studio is
      // served by the core itself.
    }
  }

  return (
    <div
      className="fixed z-40 flex flex-col overflow-hidden rounded-window border border-border-2 bg-panel shadow-window"
      style={{ left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h }}
    >
      <div
        className="flex h-[34px] shrink-0 cursor-grab items-center gap-1 border-b border-line bg-panel-2 px-2 active:cursor-grabbing"
        onPointerDown={handleGripPointerDown}
        onPointerMove={handleGripPointerMove}
        onPointerUp={handleGripPointerUp}
      >
        <span className="min-w-0 flex-1 truncate text-meta font-medium text-text">{request.label}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={geometry.zoom <= ZOOM_STEPS[0]}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => zoomBy(-1)}
        >
          <MagnifyingGlassMinusIcon className="size-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={geometry.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => zoomBy(1)}
        >
          <MagnifyingGlassPlusIcon className="size-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" onPointerDown={(e) => e.stopPropagation()} onClick={refresh}>
          <ArrowsClockwiseIcon className="size-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
          <XIcon className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <iframe
          key={request.href}
          ref={iframeRef}
          src={`${coreBase()}${request.href}?pip=1`}
          title={request.label}
          className="absolute top-0 left-0 border-0"
          style={{
            width: `${100 / geometry.zoom}%`,
            height: `${100 / geometry.zoom}%`,
            transform: `scale(${geometry.zoom})`,
            transformOrigin: 'top left',
          }}
        />
      </div>

      {/*
        The resize grip. Bottom-right only (§9 Q2) — `nwse-resize` even
        though only this one corner drags, matching Device Control's own
        handle (`device-control/DeviceControl.tsx:280-288`). `aria-hidden`:
        there is nothing here a keyboard user can do that the default size
        does not already give them.
      */}
      <div
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        aria-hidden
        className="absolute right-0 bottom-0 z-10 h-4 w-4 cursor-nwse-resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 45%, var(--line) 45% 55%, transparent 55% 70%, var(--line) 70% 80%, transparent 80%)',
        }}
      />
    </div>
  )
}
