import type { Bounds, HumanGestureOptions, HumanTapOptions, Point } from '@enkaku/protocol'

/**
 * The three easings the gesture engine knows. Spelled out here rather than imported: protocol
 * exports the SCHEMA (`GestureEasingSchema`) but not this union, and `device-executor.ts` keeps its
 * own identical alias for the same reason — one more import would not make either clearer.
 */
type GestureEasing = 'linear' | 'easeOutQuad' | 'easeInOutCubic'

/**
 * Device-side variation for a gesture (2026-09-17) — the movement twin of `planHumanTyping`.
 *
 * The farm's touch profile already gives every gesture a curved, eased, per-sample-jittered path and
 * every tap a sampled hold and a ±`coordJitterPx` nudge. What it cannot give is VARIETY: a member
 * that turns a feed 200 times sends 200 gestures down the same corridor, with the same reach and the
 * same duration, and that sameness is a pattern of its own. These functions vary those three around
 * whatever the caller asked for, so a plugin gets the variation by passing a flag rather than by
 * writing its own randomiser — which is what all three packs had ended up doing, each differently.
 *
 * Pure on purpose: randomness comes in as an argument, nothing here touches a device, and every
 * function is unit-testable without a phone.
 */

const DEFAULTS = {
  drift: 0.06,
  speed: [0.75, 1.35] as [number, number],
  reach: [0.85, 1.2] as [number, number],
  varyEasing: true,
}

/** The three the gesture engine knows. `linear` is included because a fast flick really does look like one. */
const EASINGS: readonly GestureEasing[] = ['linear', 'easeOutQuad', 'easeInOutCubic']

export interface ResolvedHumanGesture {
  drift: number
  speed: [number, number]
  reach: [number, number]
  varyEasing: boolean
  seed?: number
}

/** `true` takes every default; an object overrides only the fields it names. */
export function resolveHumanGesture(opts: true | HumanGestureOptions): ResolvedHumanGesture {
  if (opts === true) return { ...DEFAULTS }
  return {
    drift: opts.drift ?? DEFAULTS.drift,
    speed: opts.speed ?? DEFAULTS.speed,
    reach: opts.reach ?? DEFAULTS.reach,
    varyEasing: opts.varyEasing ?? DEFAULTS.varyEasing,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  }
}

const between = (rng: () => number, lo: number, hi: number): number => lo + rng() * (hi - lo)

/**
 * The randomness a varied gesture draws from: `Math.random` for an ordinary run, a seeded xorshift32
 * when the caller asked for a reproducible one. Kept here rather than imported so this module stays
 * pure and dependency-free — the SDK's `makeRng` is the same algorithm for the same reason.
 */
export function makeGestureRng(seed?: number): () => number {
  if (seed === undefined) return Math.random
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

export interface HumanGestureInput {
  from: Point
  to: Point
  ms: number
  easing?: GestureEasing
}

export interface HumanGestureResult {
  from: Point
  to: Point
  ms: number
  easing?: GestureEasing
}

/**
 * Vary one gesture.
 *
 * The caller's endpoints stay the ANCHOR — this moves them, it does not replace them. `reach` scales
 * the vector from `from` to `to`, `drift` wanders both ends perpendicular to it as well as along it,
 * and `speed` stretches the duration. The result is clamped into `frame` so a varied gesture can
 * never leave the screen, which would silently do nothing at all.
 */
export function varyGesture(input: HumanGestureInput, resolved: ResolvedHumanGesture, rng: () => number, frame: { width: number; height: number }): HumanGestureResult {
  const dx = input.to.x - input.from.x
  const dy = input.to.y - input.from.y
  const span = Math.hypot(dx, dy)
  const reach = between(rng, resolved.reach[0], resolved.reach[1])
  // Perpendicular unit vector, so the drift is across the stroke and not only along it.
  const nx = span > 0 ? -dy / span : 0
  const ny = span > 0 ? dx / span : 0
  const wander = (): number => between(rng, -resolved.drift, resolved.drift) * (span > 0 ? span : Math.max(frame.width, frame.height) * 0.1)

  const clampX = (v: number): number => Math.min(Math.max(1, Math.round(v)), Math.max(1, frame.width - 2))
  const clampY = (v: number): number => Math.min(Math.max(1, Math.round(v)), Math.max(1, frame.height - 2))

  const startDrift = { along: wander() * 0.4, across: wander() }
  const endDrift = { along: wander() * 0.4, across: wander() }
  const ux = span > 0 ? dx / span : 0
  const uy = span > 0 ? dy / span : 0

  const from: Point = {
    x: clampX(input.from.x + ux * startDrift.along + nx * startDrift.across),
    y: clampY(input.from.y + uy * startDrift.along + ny * startDrift.across),
  }
  const to: Point = {
    x: clampX(input.from.x + dx * reach + ux * endDrift.along + nx * endDrift.across),
    y: clampY(input.from.y + dy * reach + uy * endDrift.along + ny * endDrift.across),
  }
  const ms = Math.max(1, Math.round(input.ms * between(rng, resolved.speed[0], resolved.speed[1])))
  const easing = resolved.varyEasing ? EASINGS[Math.floor(rng() * EASINGS.length)] : input.easing
  return { from, to, ms, ...(easing !== undefined ? { easing } : {}) }
}

const TAP_DEFAULTS = { inset: 0.15 }

export interface ResolvedHumanTap {
  inset: number
  seed?: number
}

export function resolveHumanTap(opts: true | HumanTapOptions): ResolvedHumanTap {
  if (opts === true) return { ...TAP_DEFAULTS }
  return {
    inset: opts.inset ?? TAP_DEFAULTS.inset,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  }
}

/**
 * A point inside the node, rather than its exact centre.
 *
 * A box narrower than `MIN_SPAN_PX` on an axis keeps its centre on that axis: on a 20-pixel rail the
 * "middle 70%" is a 14-pixel target, and missing it is a real failure while the realism gained is
 * nothing. This is the same guard all three packs had arrived at independently.
 */
const MIN_SPAN_PX = 24

export function humanTapPoint(bounds: Bounds, resolved: ResolvedHumanTap, rng: () => number): Point {
  const w = bounds.right - bounds.left
  const h = bounds.bottom - bounds.top
  const fx = w < MIN_SPAN_PX ? 0 : resolved.inset
  const fy = h < MIN_SPAN_PX ? 0 : resolved.inset
  return {
    x: Math.round(bounds.left + w * (fx + rng() * Math.max(0, 1 - 2 * fx))),
    y: Math.round(bounds.top + h * (fy + rng() * Math.max(0, 1 - 2 * fy))),
  }
}
