import { z } from 'zod'
import { JobTraceTouchSchema, MAX_TRACE_TOUCH_POINTS, type JobTraceEvent, type JobTraceTouch } from '@enkaku/protocol'

/**
 * The touch a Timeline step made, ready to draw on a frame.
 *
 * `meta.touch` is what the input engine was actually sent (see
 * `JobTraceTouchSchema`) and is always preferred. An event recorded before it
 * existed has only `meta.args` — what the script ASKED for — and only a few
 * verbs can be placed from that at all: a literal `{ point }` tap, a swipe's
 * two endpoints, and the normalised replay verbs. Those are returned with
 * `estimated: true` and drawn as such. A selector tap, a `scroll` or a
 * `fling` from that era cannot be placed, and returns null rather than a
 * guess drawn in the wrong spot.
 */
export interface TimelineTouch {
  kind: JobTraceTouch['kind']
  points: { x: number; y: number; atMs?: number }[]
  durationMs: number | null
  holdMs: [number, number] | null
  target: JobTraceTouch['target']
  via: JobTraceTouch['via']
  /** `norm` is 0..1 of the screen; `px` is device pixels, scaled against the frame's own size when drawn. */
  space: 'norm' | 'px'
  /** True when read back from the script's arguments rather than from what was sent. */
  estimated: boolean
}

const PointSchema = z.object({ x: z.number(), y: z.number() })
const PointTargetArgs = z.object({ target: z.object({ point: PointSchema }) })
const SwipeArgs = z.object({ from: PointSchema, to: PointSchema, ms: z.number().optional() })
const TapNormArgs = z.object({ pos: PointSchema, holdMs: z.number().optional() })
const SwipeNormArgs = z.object({ from: PointSchema, to: PointSchema, ms: z.number() })
const GestureArgs = z.object({ samples: z.array(z.object({ x: z.number(), y: z.number(), atMs: z.number() })).min(2) })

export function touchOf(e: JobTraceEvent): TimelineTouch | null {
  if (e.kind !== 'action') return null
  const recorded = JobTraceTouchSchema.safeParse(e.meta?.touch)
  if (recorded.success) return { ...recorded.data, space: 'norm', estimated: false }
  return estimateFromArgs(e.name, e.meta?.args)
}

function estimateFromArgs(method: string, args: unknown): TimelineTouch | null {
  const base = { durationMs: null, holdMs: null, target: null, via: 'input' as const, estimated: true }
  switch (method) {
    case 'tap':
    case 'longPress': {
      const a = PointTargetArgs.safeParse(args)
      return a.success ? { ...base, kind: 'tap', points: [a.data.target.point], space: 'px' } : null
    }
    case 'swipe': {
      const a = SwipeArgs.safeParse(args)
      if (!a.success) return null
      const ms = a.data.ms ?? 300
      return { ...base, kind: 'path', points: [{ ...a.data.from, atMs: 0 }, { ...a.data.to, atMs: ms }], durationMs: ms, space: 'px' }
    }
    case 'tapNorm': {
      const a = TapNormArgs.safeParse(args)
      if (!a.success) return null
      const hold = a.data.holdMs
      return { ...base, kind: 'tap', points: [a.data.pos], holdMs: hold !== undefined ? [hold, hold] : null, space: 'norm' }
    }
    case 'swipeNorm': {
      const a = SwipeNormArgs.safeParse(args)
      if (!a.success) return null
      return { ...base, kind: 'path', points: [{ ...a.data.from, atMs: 0 }, { ...a.data.to, atMs: a.data.ms }], durationMs: a.data.ms, space: 'norm' }
    }
    case 'gesture': {
      // A replay's samples are exactly what is sent, only mapped to pixels — the shape is not an estimate.
      const a = GestureArgs.safeParse(args)
      if (!a.success) return null
      const samples = a.data.samples
      const step = Math.max(1, Math.ceil(samples.length / MAX_TRACE_TOUCH_POINTS))
      const points = samples.filter((_, i) => i % step === 0 || i === samples.length - 1)
      return { ...base, kind: 'path', points, durationMs: samples[samples.length - 1]?.atMs ?? null, space: 'norm' }
    }
    default:
      return null
  }
}

/** One line for the event panel: what kind of touch, and how long. */
export function describeTouch(t: TimelineTouch): string {
  const parts: string[] = []
  if (t.kind === 'tap') {
    parts.push('tap')
    if (t.holdMs) parts.push(t.holdMs[0] === t.holdMs[1] ? `hold ${Math.round(t.holdMs[0])} ms` : `hold ${Math.round(t.holdMs[0])}–${Math.round(t.holdMs[1])} ms`)
    if (t.target) parts.push('aimed at a node')
  } else {
    parts.push(`path · ${t.points.length} point${t.points.length === 1 ? '' : 's'}`)
    if (t.durationMs !== null) parts.push(`${Math.round(t.durationMs)} ms`)
  }
  if (t.via === 'adb') parts.push('via adb')
  if (t.estimated) parts.push('estimated from args')
  return parts.join(' · ')
}
