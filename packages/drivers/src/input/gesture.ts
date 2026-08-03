import type { GestureSample, Point } from '@enkaku/protocol'

/**
 * The gesture kinematics engine (plan 40 §3.3, §4.1) — a pure function that
 * turns two endpoints into a sampled path, so `InputSink.gesture()`
 * implementations can play something a real finger could have produced
 * instead of a straight line at constant speed.
 *
 * Two independent things make a gesture realistic, and conflating them is
 * the usual mistake:
 *   - PATH: a cubic Bézier whose control points are offset perpendicular to
 *     the straight line, by a small randomised fraction of its length.
 *   - TIME: an easing function applied to the sampling parameter, so the
 *     path is walked at a non-constant rate — this is what produces a real
 *     release velocity (§3.3), which is what `VelocityTracker` needs.
 *
 * `rng` is injectable so the whole thing is deterministic under test; it
 * defaults to `Math.random` for real use.
 */
export interface GesturePathOpts {
  from: Point
  to: Point
  durationMs: number
  /** Perpendicular bow as a fraction of the straight-line distance. 0 = straight. Default 0.08. */
  curvature?: number
  /** Default 'easeInOutCubic'. */
  easing?: 'linear' | 'easeOutQuad' | 'easeInOutCubic'
  /** Target interval between samples; the resulting count is clamped to [2, 60]. Default 8. */
  sampleIntervalMs?: number
  /** Per-sample positional noise in pixels, applied to every sample except the two endpoints. Default 1. */
  jitterPx?: number
  /** Injectable for deterministic tests. Defaults to `Math.random`. */
  rng?: () => number
}

const MIN_SAMPLES = 2
const MAX_SAMPLES = 60

/**
 * Standard (Penner) easing curves. Both `easeOutQuad` and `easeInOutCubic`
 * decelerate all the way to a zero INSTANTANEOUS derivative at t=1 — the
 * difference the plan cares about (§3.3, §7: "final-segment velocity higher
 * for easeOutQuad than easeInOutCubic") only shows up over a discrete window
 * of the final few samples, not at the exact endpoint: `easeInOutCubic`
 * spends its whole second half decelerating from the midpoint, while
 * `easeOutQuad` decelerates gently across its entire domain — so the average
 * speed over the last few samples is measurably higher for `easeOutQuad`.
 * That is the "flick vs deliberate drag" contrast the settings profile names.
 */
const EASINGS: Record<NonNullable<GesturePathOpts['easing']>, (t: number) => number> = {
  linear: (t) => t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

export function buildGesturePath(opts: GesturePathOpts): GestureSample[] {
  const { from, to } = opts
  const durationMs = Math.max(0, opts.durationMs)
  const curvature = opts.curvature ?? 0.08
  const easing = EASINGS[opts.easing ?? 'easeInOutCubic']
  const sampleIntervalMs = Math.max(1, opts.sampleIntervalMs ?? 8)
  const jitterPx = opts.jitterPx ?? 1
  const rng = opts.rng ?? Math.random

  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  // The perpendicular unit vector to bow control points away from the
  // straight line. When from === to there is no direction to bow into —
  // the control points collapse onto the endpoint itself, same as curvature 0.
  const nx = dist > 0 ? -dy / dist : 0
  const ny = dist > 0 ? dx / dist : 0
  const bow = curvature * dist
  // Two independent magnitudes (not a mirrored pair) so the arc is a single
  // natural curve rather than a perfect symmetric parabola.
  const offset1 = bow * (0.5 + rng() * 0.5)
  const offset2 = bow * (0.5 + rng() * 0.5)
  const p1: Point = { x: from.x + dx / 3 + nx * offset1, y: from.y + dy / 3 + ny * offset1 }
  const p2: Point = { x: from.x + (2 * dx) / 3 + nx * offset2, y: from.y + (2 * dy) / 3 + ny * offset2 }

  const rawCount = Math.round(durationMs / sampleIntervalMs)
  const count = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, rawCount))

  const samples: GestureSample[] = []
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1)
    const eased = easing(t)
    const pos = cubicBezier(from, p1, p2, to, eased)
    const isEndpoint = i === 0 || i === count - 1
    const jx = isEndpoint ? 0 : (rng() * 2 - 1) * jitterPx
    const jy = isEndpoint ? 0 : (rng() * 2 - 1) * jitterPx
    samples.push({ x: pos.x + jx, y: pos.y + jy, atMs: t * durationMs })
  }
  // Float rounding on the Bézier/easing maths must never leak into the
  // endpoints — acceptance #3 requires the path to start and end EXACTLY on
  // the requested points, curved or not.
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first) samples[0] = { x: from.x, y: from.y, atMs: 0 }
  if (last) samples[samples.length - 1] = { x: to.x, y: to.y, atMs: durationMs }
  return samples
}
