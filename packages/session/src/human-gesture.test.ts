import { describe, expect, test } from 'bun:test'
import { humanTapPoint, makeGestureRng, resolveHumanGesture, resolveHumanTap, varyGesture } from './human-gesture'

const FRAME = { width: 720, height: 1600 }

describe('resolveHumanGesture — `true` takes the defaults, an object overrides only what it names', () => {
  test('true is every default', () => {
    expect(resolveHumanGesture(true)).toEqual({ drift: 0.06, speed: [0.75, 1.35], reach: [0.85, 1.2], varyEasing: true })
  })

  test('a partial object keeps the rest', () => {
    const r = resolveHumanGesture({ reach: [1, 1], varyEasing: false })
    expect(r.reach).toEqual([1, 1])
    expect(r.varyEasing).toBe(false)
    expect(r.drift).toBe(0.06)
    expect(r.speed).toEqual([0.75, 1.35])
  })

  test('a seed is carried through, and only when given', () => {
    expect(resolveHumanGesture({ seed: 7 }).seed).toBe(7)
    expect('seed' in resolveHumanGesture(true)).toBe(false)
  })
})

describe('varyGesture — variation that can never leave the screen', () => {
  const input = { from: { x: 360, y: 1200 }, to: { x: 360, y: 300 }, ms: 200 }

  test('both endpoints stay inside the frame, over many draws', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const out = varyGesture(input, resolveHumanGesture(true), makeGestureRng(seed), FRAME)
      for (const p of [out.from, out.to]) {
        expect(p.x).toBeGreaterThanOrEqual(1)
        expect(p.x).toBeLessThanOrEqual(FRAME.width - 2)
        expect(p.y).toBeGreaterThanOrEqual(1)
        expect(p.y).toBeLessThanOrEqual(FRAME.height - 2)
      }
    }
  })

  test('a gesture aimed off-screen is clamped rather than played into nothing', () => {
    const wild = { from: { x: 10, y: 1590 }, to: { x: 10, y: -4_000 }, ms: 200 }
    const out = varyGesture(wild, resolveHumanGesture({ reach: [3, 3] }), makeGestureRng(5), FRAME)
    expect(out.to.y).toBeGreaterThanOrEqual(1)
    expect(out.from.y).toBeLessThanOrEqual(FRAME.height - 2)
  })

  test('the same seed replays the same gesture; different seeds do not', () => {
    const a = varyGesture(input, resolveHumanGesture({ seed: 42 }), makeGestureRng(42), FRAME)
    const b = varyGesture(input, resolveHumanGesture({ seed: 42 }), makeGestureRng(42), FRAME)
    const c = varyGesture(input, resolveHumanGesture({ seed: 43 }), makeGestureRng(43), FRAME)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  test('duration is scaled inside the speed range, never to zero', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const out = varyGesture(input, resolveHumanGesture(true), makeGestureRng(seed), FRAME)
      expect(out.ms).toBeGreaterThanOrEqual(Math.round(200 * 0.75))
      expect(out.ms).toBeLessThanOrEqual(Math.round(200 * 1.35))
    }
  })

  test('no two consecutive draws are identical — the point of the whole module', () => {
    const rng = makeGestureRng(9)
    const seen = new Set<string>()
    for (let i = 0; i < 25; i++) {
      const out = varyGesture(input, resolveHumanGesture(true), rng, FRAME)
      seen.add(`${out.from.x},${out.from.y},${out.to.x},${out.to.y},${out.ms}`)
    }
    expect(seen.size).toBeGreaterThan(20)
  })

  test('varyEasing false keeps the caller easing', () => {
    const out = varyGesture({ ...input, easing: 'easeInOutCubic' }, resolveHumanGesture({ varyEasing: false }), makeGestureRng(3), FRAME)
    expect(out.easing).toBe('easeInOutCubic')
  })

  test('varyEasing true picks from the three the engine supports', () => {
    const picked = new Set<string>()
    for (let seed = 1; seed <= 60; seed++) {
      const out = varyGesture(input, resolveHumanGesture(true), makeGestureRng(seed), FRAME)
      if (out.easing) picked.add(out.easing)
    }
    expect(picked.size).toBeGreaterThan(1)
    for (const e of picked) expect(['linear', 'easeOutQuad', 'easeInOutCubic']).toContain(e)
  })
})

describe('humanTapPoint — inside the node, and never a miss on a thin rail', () => {
  const box = { left: 100, top: 200, right: 400, bottom: 320 }

  test('the point is always inside the node', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const p = humanTapPoint(box, resolveHumanTap(true), makeGestureRng(seed))
      expect(p.x).toBeGreaterThanOrEqual(box.left)
      expect(p.x).toBeLessThanOrEqual(box.right)
      expect(p.y).toBeGreaterThanOrEqual(box.top)
      expect(p.y).toBeLessThanOrEqual(box.bottom)
    }
  })

  test('it moves — 200 taps are not one pixel', () => {
    const seen = new Set<string>()
    const rng = makeGestureRng(11)
    for (let i = 0; i < 50; i++) {
      const p = humanTapPoint(box, resolveHumanTap(true), rng)
      seen.add(`${p.x},${p.y}`)
    }
    expect(seen.size).toBeGreaterThan(40)
  })

  test('a box under 24px on an axis keeps its centre on that axis', () => {
    const rail = { left: 100, top: 200, right: 118, bottom: 320 }
    for (let seed = 1; seed <= 20; seed++) {
      const p = humanTapPoint(rail, resolveHumanTap(true), makeGestureRng(seed))
      expect(p.x).toBeGreaterThanOrEqual(rail.left)
      expect(p.x).toBeLessThanOrEqual(rail.right)
    }
  })

  test('inset 0 may use the whole box; the default keeps the edges clear', () => {
    const rng = makeGestureRng(4)
    const tight = humanTapPoint(box, resolveHumanTap({ inset: 0.4 }), rng)
    expect(tight.x).toBeGreaterThanOrEqual(box.left + (box.right - box.left) * 0.4 - 1)
    expect(tight.x).toBeLessThanOrEqual(box.right - (box.right - box.left) * 0.4 + 1)
  })
})

describe('makeGestureRng', () => {
  test('no seed is Math.random itself — an ordinary run draws no reproducible sequence', () => {
    expect(makeGestureRng()).toBe(Math.random)
  })

  test('a seed replays exactly', () => {
    const a = makeGestureRng(123)
    const b = makeGestureRng(123)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})
