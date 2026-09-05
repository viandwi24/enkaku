'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'

/**
 * The picture-in-picture panel's store (plan 500 §4.2).
 *
 * Mirrors `DeviceControlHost`'s module-level pattern exactly — one value,
 * one subscriber `Set`, no React context above `AppShell` — for the same
 * reason recorded there: a context here would re-render every page under
 * the shell whenever the panel's target changed, which is precisely what
 * this store exists to avoid doing.
 *
 * There is exactly ONE panel (G2, plan §3.2, owner 2026-09-05: "cukup satu
 * panel aja"): `current` is a single nullable value, never a list. Opening a
 * second page retargets it in place; there is no stack to reason about.
 */

export interface PipRequest {
  href: string
  /** The panel's title-bar text — the label of the rail entry that opened it, so the panel never has to look it up. */
  label: string
}

type Listener = (req: PipRequest | null) => void

let current: PipRequest | null = null
const listeners = new Set<Listener>()

function setCurrent(next: PipRequest | null): void {
  current = next
  for (const l of listeners) l(next)
}

export interface PipApi {
  /** Opens the panel on this page, or retargets it if already open. */
  open: (href: string, label: string) => void
  close: () => void
}

export function usePip(): PipApi {
  return {
    open: (href, label) => setCurrent({ href, label }),
    close: () => setCurrent(null),
  }
}

/** The panel's current target, reactively — read by `PipHost` only. */
export function usePipRequest(): PipRequest | null {
  const [req, setReq] = useState<PipRequest | null>(current)
  useEffect(() => {
    const listener: Listener = (next) => setReq(next)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return req
}

// ---------------------------------------------------------------------------
// Geometry — a separate concern from `current` above (§4.2): position, size,
// zoom and the snapped edge, persisted through ONE `localStorage` key, read
// once through a Zod `safeParse` so a corrupt or hand-edited value falls
// back to the default geometry instead of throwing into a render (G9).

export const PIP_EDGES = ['left', 'right', 'top', 'bottom'] as const
export type PipEdge = (typeof PIP_EDGES)[number]

/** 50 % to 150 %, five steps (§3.6). */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5] as const

/** 20 px, evaluated on pointer-up only (§3.5) — not continuously, so the panel does not jump while the pointer is still down. */
export const MAGNET_THRESHOLD_PX = 20

/** The gap kept between a snapped edge and the viewport's true edge. */
const EDGE_MARGIN_PX = 8

export const MIN_PANEL_W = 280
export const MIN_PANEL_H = 200

const GeometrySchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().min(MIN_PANEL_W),
  h: z.number().min(MIN_PANEL_H),
  // The five `ZOOM_STEPS` values are the UI's only way to set this, but the
  // schema itself just bounds the range — a value from an older build with a
  // different step table still clamps sanely instead of failing to parse.
  zoom: z.number().min(ZOOM_STEPS[0]).max(ZOOM_STEPS[ZOOM_STEPS.length - 1]),
  edge: z.enum(PIP_EDGES).nullable(),
})
export type PipGeometry = z.infer<typeof GeometrySchema>

const GEOMETRY_KEY = 'enkaku:pip-geometry'
const DEFAULT_W = 480
const DEFAULT_H = 360

/** Opens bottom-right, a finger's width off both edges — the corner an operator's eye returns to least. */
export function defaultGeometry(): PipGeometry {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  return {
    x: Math.max(vw - DEFAULT_W - EDGE_MARGIN_PX * 2, 0),
    y: Math.max(vh - DEFAULT_H - EDGE_MARGIN_PX * 2, 0),
    w: DEFAULT_W,
    h: DEFAULT_H,
    zoom: 1,
    edge: 'right',
  }
}

/** A stored geometry that no longer fits the current viewport is CLAMPED, never discarded (§4.2). */
export function clampGeometry(g: PipGeometry, vw: number, vh: number): PipGeometry {
  const w = Math.min(g.w, Math.max(vw - EDGE_MARGIN_PX * 2, MIN_PANEL_W))
  const h = Math.min(g.h, Math.max(vh - EDGE_MARGIN_PX * 2, MIN_PANEL_H))
  const x = Math.min(Math.max(g.x, 0), Math.max(vw - w, 0))
  const y = Math.min(Math.max(g.y, 0), Math.max(vh - h, 0))
  return { ...g, w, h, x, y }
}

/** Re-pins a snapped panel flush to its captured edge under a NEW viewport size — the one thing that makes edge-snapping worth having (§3.5). A no-op when nothing is snapped. */
export function repinToEdge(g: PipGeometry, vw: number, vh: number): PipGeometry {
  if (!g.edge) return g
  switch (g.edge) {
    case 'left':
      return { ...g, x: EDGE_MARGIN_PX }
    case 'right':
      return { ...g, x: vw - g.w - EDGE_MARGIN_PX }
    case 'top':
      return { ...g, y: EDGE_MARGIN_PX }
    case 'bottom':
      return { ...g, y: vh - g.h - EDGE_MARGIN_PX }
  }
}

/** Evaluated once, on pointer-up: snaps to whichever of the four viewport edges is within `MAGNET_THRESHOLD_PX`, else clears the snap. */
export function applyMagnet(g: PipGeometry, vw: number, vh: number): PipGeometry {
  const distance: Record<PipEdge, number> = {
    left: g.x,
    right: vw - (g.x + g.w),
    top: g.y,
    bottom: vh - (g.y + g.h),
  }
  let best: PipEdge | null = null
  let bestDistance = MAGNET_THRESHOLD_PX
  for (const edge of PIP_EDGES) {
    if (distance[edge] <= bestDistance) {
      bestDistance = distance[edge]
      best = edge
    }
  }
  return best ? repinToEdge({ ...g, edge: best }, vw, vh) : { ...g, edge: null }
}

export function readGeometry(): PipGeometry {
  try {
    const raw = localStorage.getItem(GEOMETRY_KEY)
    if (!raw) return defaultGeometry()
    const parsed = GeometrySchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : defaultGeometry()
  } catch {
    return defaultGeometry()
  }
}

export function writeGeometry(g: PipGeometry): void {
  try {
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(g))
  } catch {
    // Private browsing, or storage disabled outright — the geometry simply
    // does not persist; it never throws into the drag/zoom handler that
    // triggered the write.
  }
}
