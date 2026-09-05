import { describe, expect, test } from 'bun:test'
import { drawIntervalMs } from './pacer'

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
