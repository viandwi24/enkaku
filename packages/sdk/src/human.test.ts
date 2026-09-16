import { describe, expect, test } from 'bun:test'
import { aimInside, between, DWELL_BUCKETS, makeRng, MAX_REFRESHES_IN_A_ROW, pauseBetweenWordsMs, pick, pickDwellMs, planRevisitStep, type RevisitMove } from './human'

describe('aimInside — the aim three packs had each written for themselves', () => {
  const box = { left: 100, top: 200, right: 400, bottom: 320 }

  test('the point is always inside the box', () => {
    const rng = makeRng(5)
    for (let i = 0; i < 500; i++) {
      const p = aimInside(box, rng)
      expect(p.x).toBeGreaterThanOrEqual(box.left)
      expect(p.x).toBeLessThanOrEqual(box.right)
      expect(p.y).toBeGreaterThanOrEqual(box.top)
      expect(p.y).toBeLessThanOrEqual(box.bottom)
    }
  })

  test('it moves — 50 taps are not one pixel', () => {
    const rng = makeRng(6)
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const p = aimInside(box, rng)
      seen.add(`${p.x},${p.y}`)
    }
    expect(seen.size).toBeGreaterThan(40)
  })

  test('seeded: the same run replays the same taps — the whole reason the rng is an argument', () => {
    const a = makeRng(77)
    const b = makeRng(77)
    expect([aimInside(box, a), aimInside(box, a)]).toEqual([aimInside(box, b), aimInside(box, b)])
  })

  test('an axis under 24px keeps its centre there', () => {
    const rail = { left: 100, top: 200, right: 118, bottom: 320 }
    const rng = makeRng(8)
    for (let i = 0; i < 40; i++) {
      const p = aimInside(rail, rng)
      expect(p.x).toBeGreaterThanOrEqual(rail.left)
      expect(p.x).toBeLessThanOrEqual(rail.right)
    }
  })

  test('a degenerate box answers its centre rather than NaN', () => {
    expect(aimInside({ left: 50, top: 60, right: 50, bottom: 60 }, makeRng(1))).toEqual({ x: 50, y: 60 })
  })

  test('the inset is clamped, so a silly value cannot invert the box', () => {
    const rng = makeRng(2)
    for (let i = 0; i < 50; i++) {
      const p = aimInside(box, rng, { inset: 5 })
      expect(p.x).toBeGreaterThanOrEqual(box.left)
      expect(p.x).toBeLessThanOrEqual(box.right)
    }
  })
})

describe('makeRng / between / pick', () => {
  test('the same seed replays exactly, a different one does not', () => {
    const a = makeRng(7)
    const b = makeRng(7)
    const c = makeRng(8)
    const first = [a(), a(), a()]
    expect(first).toEqual([b(), b(), b()])
    expect(first).not.toEqual([c(), c(), c()])
  })

  test('the sequence stays in [0, 1)', () => {
    const rng = makeRng(99)
    for (let i = 0; i < 500; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  test('between stays inside its bounds', () => {
    const rng = makeRng(3)
    for (let i = 0; i < 200; i++) {
      const v = between(rng, 10, 20)
      expect(v).toBeGreaterThanOrEqual(10)
      expect(v).toBeLessThan(20)
    }
  })

  test('pick refuses an empty list rather than answering undefined', () => {
    expect(() => pick(makeRng(1), [])).toThrow()
  })
})

describe('pickDwellMs — a heavy tail, tilted but never switched', () => {
  test('every draw falls inside the bucket it names', () => {
    const rng = makeRng(21)
    for (let i = 0; i < 500; i++) {
      const { label, ms } = pickDwellMs(rng)
      const bucket = DWELL_BUCKETS.find((b) => b.label === label)
      expect(bucket).toBeDefined()
      expect(ms).toBeGreaterThanOrEqual((bucket as { ms: [number, number] }).ms[0])
      expect(ms).toBeLessThanOrEqual((bucket as { ms: [number, number] }).ms[1])
    }
  })

  test('interest makes long looks more likely, and boredom less', () => {
    const count = (tilt: number): number => {
      const rng = makeRng(5)
      let long = 0
      for (let i = 0; i < 2_000; i++) {
        const { label } = pickDwellMs(rng, tilt)
        if (label === 'engaged' || label === 'hooked') long += 1
      }
      return long
    }
    expect(count(1)).toBeGreaterThan(count(0))
    expect(count(0)).toBeGreaterThan(count(-1))
  })

  test('every bucket is still reachable at full tilt — a tilt re-weights, it does not switch model', () => {
    const rng = makeRng(13)
    const labels = new Set<string>()
    for (let i = 0; i < 3_000; i++) labels.add(pickDwellMs(rng, 1).label)
    expect(labels.has('watch')).toBe(true)
    expect(labels.has('hooked')).toBe(true)
  })

  test('a tilt outside [-1, 1] is clamped rather than producing negative weights', () => {
    const rng = makeRng(17)
    for (let i = 0; i < 200; i++) {
      const { ms } = pickDwellMs(rng, -50)
      expect(ms).toBeGreaterThan(0)
    }
  })

  test('caller buckets are honoured', () => {
    const rng = makeRng(2)
    const only = [{ label: 'watch' as const, weight: 1, ms: [1_000, 1_100] as [number, number] }]
    for (let i = 0; i < 50; i++) {
      const { label, ms } = pickDwellMs(rng, 0, only)
      expect(label).toBe('watch')
      expect(ms).toBeGreaterThanOrEqual(1_000)
      expect(ms).toBeLessThanOrEqual(1_100)
    }
  })
})

describe('planRevisitStep — the two rules every pack had written separately', () => {
  const plan = { waitMs: [8_000, 16_000] as [number, number], homeChance: 0.35, pullAfterHome: 0.6 }

  const walk = (seed: number, rounds: number): { moves: RevisitMove[]; waits: number[] } => {
    const rng = makeRng(seed)
    const moves: RevisitMove[] = []
    const waits: number[] = []
    for (let i = 0; i < rounds; i++) {
      const step = planRevisitStep(rng, moves, plan)
      moves.push(step.move)
      waits.push(step.waitMs)
    }
    return { moves, waits }
  }

  test('never two Home trips in a row', () => {
    for (const seed of [1, 4, 19, 2026]) {
      const { moves } = walk(seed, 300)
      for (let i = 1; i < moves.length; i++) {
        expect(moves[i] === 'home' && moves[i - 1] === 'home').toBe(false)
      }
    }
  })

  test(`never more than ${MAX_REFRESHES_IN_A_ROW} refreshes in a row`, () => {
    for (const seed of [2, 8, 77]) {
      const { moves } = walk(seed, 300)
      const run = moves.join(' ').replace(/home/g, '|')
      const longest = run
        .split('|')
        .map((chunk) => chunk.trim().split(/\s+/).filter(Boolean).length)
        .reduce((a, b) => Math.max(a, b), 0)
      expect(longest).toBeLessThanOrEqual(MAX_REFRESHES_IN_A_ROW)
    }
  })

  test('both moves actually occur — a plan that only ever refreshes is not a plan', () => {
    const { moves } = walk(3, 200)
    expect(moves).toContain('home')
    expect(moves).toContain('refresh')
  })

  test('waits are varied, with the odd long one', () => {
    const { waits } = walk(11, 300)
    expect(new Set(waits).size).toBeGreaterThan(200)
    expect(waits.some((w) => w > plan.waitMs[1])).toBe(true)
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(plan.waitMs[0])
  })

  test('a Home round lingers, a refresh round does not', () => {
    const rng = makeRng(6)
    const moves: RevisitMove[] = []
    for (let i = 0; i < 80; i++) {
      const step = planRevisitStep(rng, moves, plan)
      moves.push(step.move)
      if (step.move === 'home') expect(step.lingerMs).toBeGreaterThan(0)
      else expect(step.lingerMs).toBe(0)
    }
  })

  test('a refresh round pulls by default — that is what a check IS', () => {
    const rng = makeRng(6)
    const moves: RevisitMove[] = []
    for (let i = 0; i < 80; i++) {
      const step = planRevisitStep(rng, moves, plan)
      moves.push(step.move)
      if (step.move === 'refresh') expect(step.pull).toBe(true)
    }
  })

  test('pullOnRefresh false turns it off, for a screen that must not be pulled', () => {
    const rng = makeRng(6)
    const moves: RevisitMove[] = []
    for (let i = 0; i < 40; i++) {
      const step = planRevisitStep(rng, moves, { ...plan, pullOnRefresh: false })
      moves.push(step.move)
      if (step.move === 'refresh') expect(step.pull).toBe(false)
    }
  })

  test('it is a DROP-IN: same seed, same numbers as the implementation the packs carry', () => {
    // The three packs' own `planConfirmStep`, transcribed. If this ever diverges, the helper below
    // is a look-alike rather than a replacement, and migrating a pack to it changes its behaviour.
    const MAX = 3
    const packStep = (rng: () => number, recent: readonly RevisitMove[], p: typeof plan) => {
      let refreshRun = 0
      for (let i = recent.length - 1; i >= 0 && recent[i] === 'refresh'; i--) refreshRun++
      const last = recent[recent.length - 1]
      const move: RevisitMove = last === 'home' ? 'refresh' : refreshRun >= MAX ? 'home' : rng() < p.homeChance ? 'home' : 'refresh'
      const [lo, hi] = p.waitMs
      const waitMs = Math.round(between(rng, lo, hi) * (rng() < 0.15 ? between(rng, 1.3, 1.7) : 1))
      if (move === 'refresh') return { move, waitMs, lingerMs: 0, pull: true }
      return { move, waitMs, lingerMs: Math.round(between(rng, 1_500, 5_000)), pull: rng() < p.pullAfterHome }
    }
    for (const seed of [1, 9, 44, 2026]) {
      const mine = makeRng(seed)
      const theirs = makeRng(seed)
      const a: RevisitMove[] = []
      const b: RevisitMove[] = []
      for (let i = 0; i < 120; i++) {
        const x = planRevisitStep(mine, a, plan)
        const y = packStep(theirs, b, plan)
        expect(x).toEqual(y)
        a.push(x.move)
        b.push(y.move)
      }
    }
  })
})

describe('pauseBetweenWordsMs', () => {
  test('mostly short, occasionally a real stop', () => {
    const rng = makeRng(31)
    const values = Array.from({ length: 2_000 }, () => pauseBetweenWordsMs(rng))
    expect(Math.min(...values)).toBeGreaterThanOrEqual(180)
    expect(Math.max(...values)).toBeLessThanOrEqual(2_400)
    const long = values.filter((v) => v >= 900).length
    expect(long).toBeGreaterThan(values.length * 0.08)
    expect(long).toBeLessThan(values.length * 0.3)
  })
})
