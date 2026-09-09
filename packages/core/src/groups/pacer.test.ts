import { describe, expect, test } from 'bun:test'
import { drawIntervalMs, ladderRung } from './pacer'

/**
 * The per-device start delay (2026-09-06).
 *
 * `drawIntervalMs` is the one piece of arithmetic behind both the interval
 * between repetitions and the new per-device delay, so it is worth pinning on
 * its own: the rest of `planFirst` is a database walk that a unit test would
 * only restate.
 */
describe('drawIntervalMs — the draw behind a per-device start delay', () => {
  test('a range gives a value inside it, inclusive at both ends', () => {
    const seen = new Set<number>()
    for (let r = 0; r < 200; r++) {
      const v = drawIntervalMs(10_000, 30_000, () => r * 7919)
      expect(v).toBeGreaterThanOrEqual(10_000)
      expect(v).toBeLessThanOrEqual(30_000)
      seen.add(v)
    }
    // Different draws, not one value repeated — the whole point is that two
    // devices do not start at the same instant.
    expect(seen.size).toBeGreaterThan(1)
  })

  test('min === max is a fixed delay, not a coin flip', () => {
    expect(drawIntervalMs(5_000, 5_000, () => 12345)).toBe(5_000)
  })

  test('a zero range is no delay at all — today’s behaviour, unchanged', () => {
    expect(drawIntervalMs(0, 0, () => 999)).toBe(0)
  })

  test('an inverted range collapses to the lower bound rather than throwing', () => {
    // The schema refuses this at the boundary; the arithmetic still has to be
    // total, because a batch row written before that check existed can hold one.
    expect(drawIntervalMs(30_000, 10_000, () => 42)).toBe(30_000)
  })
})

/**
 * Sub-groups (the client's "subgrup"): the same ladder, stepping once per
 * WAVE instead of once per phone.
 *
 * Pinned here for the same reason `drawIntervalMs` is: it is the arithmetic
 * that decides when a phone is allowed to start, and the rest of `planFirst`
 * is a database walk a unit test would only restate.
 */
describe('ladderRung — how many devices share one rung', () => {
  test('waveSize 1 is a rung per phone — every batch written before sub-groups existed', () => {
    expect([0, 1, 2, 3].map((i) => ladderRung(i, 1))).toEqual([0, 1, 2, 3])
  })

  test('waveSize 10 sends 70 phones out in seven waves, not a 70-rung staircase', () => {
    expect(ladderRung(0, 10)).toBe(0)
    expect(ladderRung(9, 10)).toBe(0)
    expect(ladderRung(10, 10)).toBe(1)
    expect(ladderRung(69, 10)).toBe(6)
    // The point of the whole feature: at a 30 s rung the last phone waits
    // three minutes, not thirty-five.
    expect(ladderRung(69, 10) * 30_000).toBe(180_000)
  })

  test('a wave larger than the fleet is one wave, not an error', () => {
    expect([0, 5, 40].map((i) => ladderRung(i, 1000))).toEqual([0, 0, 0])
  })

  test('a zero or negative wave size reads as 1 rather than dividing by zero', () => {
    // A row written before the column existed, or one that reached here from
    // some other path, must still produce a number.
    expect(ladderRung(7, 0)).toBe(7)
    expect(ladderRung(7, -3)).toBe(7)
  })
})
