'use client'

import { useId } from 'react'
import { cn } from '@enkaku/ui'
import type { TimelineTouch } from '@/lib/trace-touch'

/** A touch placed on a frame: the touch itself, and where it sits in the sequence being drawn. */
export interface DrawnTouch {
  touch: TimelineTouch
  /** The selected step's own touch — drawn solid. Earlier touches on the same screen are drawn faint. */
  current: boolean
  /** 1-based order among the touches drawn on this frame; shown only when more than one is drawn. */
  order: number
}

/**
 * Where a step touched the screen, drawn over its frame: a tap as a dot and a
 * ring (a thicker ring for a hold of half a second or more), a gesture as its
 * path with a start dot and an arrowhead, and the node a selector aimed at as
 * a dashed box. The owner's ask (2026-09-17): see HOW a swipe or a tap was
 * made, not only that it was.
 *
 * Laid out in the frame's own pixel space (`frame`, the image's natural
 * size) with `xMidYMid meet` — the SVG twin of the image's `object-contain` —
 * so a mark lands on the pixel it names however the picture is letterboxed.
 * Normalised touches scale by that size; `px` touches (estimated from a
 * script's device-pixel args) are taken as screenshot pixels, which is what a
 * full-resolution screencap is.
 *
 * Every mark is drawn twice, a wide `panel`-coloured halo under an `accent`
 * stroke, so it stays readable on a white screen and a black one.
 */
export function TouchOverlay({
  touches,
  frame,
  scale = 1,
  fit = 'contain',
}: {
  touches: DrawnTouch[]
  frame: { width: number; height: number }
  /** Multiplies every mark's size — a 76px strip thumbnail needs marks about twice as large, relative to the picture, as the 148px Frame panel. */
  scale?: number
  /** The `object-fit` of the image underneath: `contain` maps to `meet`, `cover` (which crops) to `slice`. */
  fit?: 'contain' | 'cover'
}) {
  const markerId = useId().replace(/:/g, '')
  if (touches.length === 0 || frame.width <= 0 || frame.height <= 0) return null
  const unit = (frame.width / 100) * scale
  const numbered = touches.length > 1

  return (
    <svg
      className="pointer-events-none absolute inset-0 size-full"
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      preserveAspectRatio={fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'}
      aria-hidden
    >
      <defs>
        <marker id={`${markerId}-arrow`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="fill-accent" />
        </marker>
      </defs>
      {touches.map((d, i) => {
        const pts = d.touch.points.map((p) => toPixels(p, d.touch.space, frame))
        const opacity = d.current ? 1 : 0.45
        const dash = d.touch.estimated ? `${unit * 1.6} ${unit * 1.2}` : undefined
        const first = pts[0]
        const last = pts[pts.length - 1]
        if (!first || !last) return null
        const target = d.touch.target
        return (
          <g key={i} opacity={opacity}>
            {target && d.current && (
              <rect
                x={target.left * frame.width}
                y={target.top * frame.height}
                width={Math.max(0, (target.right - target.left) * frame.width)}
                height={Math.max(0, (target.bottom - target.top) * frame.height)}
                className="fill-none stroke-accent"
                strokeWidth={unit * 0.5}
                strokeDasharray={`${unit * 1.5} ${unit}`}
              />
            )}
            {d.touch.kind === 'tap' ? (
              <TapMark at={first} unit={unit} long={(d.touch.holdMs?.[0] ?? 0) >= 500} dash={dash} />
            ) : (
              <>
                <polyline
                  points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                  className="fill-none stroke-panel"
                  strokeWidth={unit * 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <polyline
                  points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                  className="fill-none stroke-accent"
                  strokeWidth={unit * 1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={dash}
                  markerEnd={`url(#${markerId}-arrow)`}
                />
                <circle cx={first.x} cy={first.y} r={unit * 2.4} className="fill-accent stroke-panel" strokeWidth={unit * 0.6} />
              </>
            )}
            {numbered && (
              <text
                x={first.x + unit * 4}
                y={first.y - unit * 4}
                className={cn('fill-accent stroke-panel font-mono font-semibold')}
                fontSize={unit * 6}
                strokeWidth={unit * 0.8}
                paintOrder="stroke"
              >
                {d.order}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function TapMark({ at, unit, long, dash }: { at: { x: number; y: number }; unit: number; long: boolean; dash: string | undefined }) {
  const ring = unit * (long ? 7 : 5.5)
  return (
    <>
      <circle cx={at.x} cy={at.y} r={ring} className="fill-accent/15 stroke-panel" strokeWidth={unit * (long ? 2.4 : 1.6)} />
      <circle cx={at.x} cy={at.y} r={ring} className="fill-none stroke-accent" strokeWidth={unit * (long ? 1.4 : 0.8)} strokeDasharray={dash} />
      <circle cx={at.x} cy={at.y} r={unit * 1.8} className="fill-accent stroke-panel" strokeWidth={unit * 0.6} />
    </>
  )
}

function toPixels(p: { x: number; y: number }, space: TimelineTouch['space'], frame: { width: number; height: number }): { x: number; y: number } {
  return space === 'norm' ? { x: p.x * frame.width, y: p.y * frame.height } : { x: p.x, y: p.y }
}
