import { describe, expect, test } from 'bun:test'
import { backoffDelayMs } from './backoff'

const OPTS = { backoffBaseMs: 2_000, backoffMaxMs: 30_000 }

describe('backoffDelayMs — doubling and cap (plan 36 §3.5, acceptance #3)', () => {
  test('the ceiling (no jitter) doubles per attempt: 2000, 4000, 8000, 16000, 30000 (capped), 30000 (capped)', () => {
    // rand() = 1 exposes the un-jittered ceiling for each attempt.
    const ceilings = [1, 2, 3, 4, 5, 6].map((attempt) => backoffDelayMs(attempt, OPTS, () => 1))
    expect(ceilings).toEqual([2000, 4000, 8000, 16000, 30000, 30000])
  })

  test('attempt 0 or negative behaves like attempt 1 (never a negative exponent)', () => {
    expect(backoffDelayMs(0, OPTS, () => 1)).toBe(2000)
    expect(backoffDelayMs(-3, OPTS, () => 1)).toBe(2000)
  })

  test('full jitter: rand()=0 gives 0, rand()=0.5 gives half the ceiling', () => {
    expect(backoffDelayMs(1, OPTS, () => 0)).toBe(0)
    expect(backoffDelayMs(3, OPTS, () => 0.5)).toBe(4000) // ceiling 8000 * 0.5
  })

  test('the delay is always within [0, ceiling]', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const ceiling = Math.min(OPTS.backoffMaxMs, OPTS.backoffBaseMs * 2 ** (attempt - 1))
      for (const r of [0, 0.001, 0.25, 0.5, 0.75, 0.999]) {
        const delay = backoffDelayMs(attempt, OPTS, () => r)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThanOrEqual(ceiling)
      }
    }
  })
})

describe('backoffDelayMs — jitter distribution (acceptance #3: no lockstep retries)', () => {
  test('twenty simultaneous retries at the same attempt number do not all land on the same delay', () => {
    const delays = Array.from({ length: 20 }, () => backoffDelayMs(2, OPTS, Math.random))
    const distinct = new Set(delays)
    // With a continuous random source, 20 draws landing on fewer than, say, 15
    // distinct millisecond values would be practically impossible by chance —
    // this is the statistical check the plan's test plan calls for (§7).
    expect(distinct.size).toBeGreaterThan(15)
  })

  test('over many draws the mean sits near half the ceiling (uniform full jitter)', () => {
    const ceiling = 8000 // attempt 3
    const n = 5000
    let sum = 0
    for (let i = 0; i < n; i++) sum += backoffDelayMs(3, OPTS, Math.random)
    const mean = sum / n
    // Expected mean of Uniform(0, ceiling) is ceiling/2; allow generous slack
    // to keep this fast and non-flaky while still catching a broken formula
    // (e.g. one that forgot the jitter and always returns the ceiling).
    expect(mean).toBeGreaterThan(ceiling * 0.35)
    expect(mean).toBeLessThan(ceiling * 0.65)
  })
})
