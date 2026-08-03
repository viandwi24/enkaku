import { describe, expect, test } from 'bun:test'
import { buildGesturePath } from './gesture'

/** A tiny deterministic PRNG (mulberry32) so tests can assert exact
 * reproducibility without depending on `Math.random`. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('buildGesturePath — endpoints and sample bounds (plan 40 §4.1, acceptance #3, #4)', () => {
  test('starts and ends exactly on the requested points, curved or not', () => {
    const from = { x: 100, y: 200 }
    const to = { x: 900, y: 1400 }
    for (const curvature of [0, 0.08, 0.3]) {
      const samples = buildGesturePath({ from, to, durationMs: 300, curvature, rng: seededRng(1) })
      expect(samples[0]).toEqual({ x: from.x, y: from.y, atMs: 0 })
      expect(samples[samples.length - 1]).toEqual({ x: to.x, y: to.y, atMs: 300 })
    }
  })

  test('time is strictly monotonic across every sample', () => {
    const samples = buildGesturePath({ from: { x: 0, y: 0 }, to: { x: 500, y: 500 }, durationMs: 400, rng: seededRng(2) })
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.atMs).toBeGreaterThan(samples[i - 1]!.atMs)
    }
  })

  test('sample count is clamped to [2, 60]', () => {
    const veryShort = buildGesturePath({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, durationMs: 1, rng: seededRng(3) })
    expect(veryShort.length).toBeGreaterThanOrEqual(2)
    const veryLong = buildGesturePath({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, durationMs: 10_000, rng: seededRng(4) })
    expect(veryLong.length).toBeLessThanOrEqual(60)
  })

  test('a gesture emits at least 8 move events for any duration >= 100ms, at most 60 (acceptance #4)', () => {
    for (const durationMs of [100, 150, 300, 1000, 3000, 10_000]) {
      const samples = buildGesturePath({ from: { x: 0, y: 0 }, to: { x: 800, y: 0 }, durationMs, rng: seededRng(5) })
      const moveEvents = samples.length - 2 // excluding the synthetic down/up endpoints
      expect(moveEvents).toBeGreaterThanOrEqual(8)
      expect(samples.length).toBeLessThanOrEqual(60)
    }
  })
})

describe('buildGesturePath — path shape (plan 40 §3.3, acceptance #3)', () => {
  test('curvature 0 is exactly collinear with the straight line', () => {
    const from = { x: 100, y: 100 }
    const to = { x: 700, y: 500 }
    const samples = buildGesturePath({ from, to, durationMs: 240, curvature: 0, jitterPx: 0, rng: seededRng(6) })
    const dx = to.x - from.x
    const dy = to.y - from.y
    for (const s of samples) {
      // Cross product of (s - from) and (to - from) is ~0 for a collinear point.
      const cross = (s.x - from.x) * dy - (s.y - from.y) * dx
      expect(Math.abs(cross)).toBeLessThan(1e-6)
    }
  })

  test('the default curvature bows away from the straight line, while still starting and ending exactly on the requested points', () => {
    const from = { x: 100, y: 100 }
    const to = { x: 700, y: 100 } // horizontal, so any bow shows up purely as a y deviation
    const samples = buildGesturePath({ from, to, durationMs: 240, rng: seededRng(7) })
    const midpoints = samples.slice(1, -1)
    expect(midpoints.some((s) => Math.abs(s.y - 100) > 0.5)).toBe(true)
    expect(samples[0]).toEqual({ x: from.x, y: from.y, atMs: 0 })
    expect(samples[samples.length - 1]).toEqual({ x: to.x, y: to.y, atMs: 240 })
  })
})

describe('buildGesturePath — determinism under an injected rng', () => {
  test('the same seed produces byte-identical output', () => {
    const opts = { from: { x: 0, y: 0 }, to: { x: 600, y: 900 }, durationMs: 500 }
    const a = buildGesturePath({ ...opts, rng: seededRng(42) })
    const b = buildGesturePath({ ...opts, rng: seededRng(42) })
    expect(a).toEqual(b)
  })

  test('different seeds produce different curves (the jitter/offset actually uses rng)', () => {
    const opts = { from: { x: 0, y: 0 }, to: { x: 600, y: 900 }, durationMs: 500 }
    const a = buildGesturePath({ ...opts, rng: seededRng(1) })
    const b = buildGesturePath({ ...opts, rng: seededRng(2) })
    expect(a).not.toEqual(b)
  })
})

/** Average speed (px/ms) over the final two intervals of a path — the
 * discrete stand-in for "release velocity" a real VelocityTracker computes
 * from the last few move events. */
function finalSegmentSpeed(samples: { x: number; y: number; atMs: number }[]): number {
  const n = samples.length
  const a = samples[n - 3]!
  const b = samples[n - 1]!
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  return dist / (b.atMs - a.atMs)
}

describe('buildGesturePath — easing controls release velocity, independently of the path (plan 40 §3.3, §7)', () => {
  test('easeOutQuad ends with a higher final-segment velocity than easeInOutCubic — the core claim behind fling vs. a deliberate drag', () => {
    const opts = { from: { x: 0, y: 0 }, to: { x: 1000, y: 0 }, durationMs: 300, curvature: 0, jitterPx: 0 }
    const flick = buildGesturePath({ ...opts, easing: 'easeOutQuad', rng: seededRng(9) })
    const drag = buildGesturePath({ ...opts, easing: 'easeInOutCubic', rng: seededRng(9) })
    expect(finalSegmentSpeed(flick)).toBeGreaterThan(finalSegmentSpeed(drag))
  })

  test('linear easing produces constant speed across every interval', () => {
    const samples = buildGesturePath({
      from: { x: 0, y: 0 },
      to: { x: 800, y: 0 },
      durationMs: 320,
      curvature: 0,
      jitterPx: 0,
      easing: 'linear',
      rng: seededRng(10),
    })
    const speeds: number[] = []
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!
      const b = samples[i]!
      speeds.push(Math.hypot(b.x - a.x, b.y - a.y) / (b.atMs - a.atMs))
    }
    const first = speeds[0]!
    for (const s of speeds) expect(Math.abs(s - first)).toBeLessThan(1e-6)
  })
})
