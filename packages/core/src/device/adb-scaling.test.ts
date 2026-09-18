import { describe, expect, test } from 'bun:test'
import { computeAsyncFanout, computeAutoBuildCeiling, computeAutoConcurrency, computeAutoStreams, computeSyncFanout } from './adb-scaling'

describe('computeAutoConcurrency (plan 23 §3.2, §7)', () => {
  test.each([
    [0, 6],
    [1, 6],
    [4, 6],
    [10, 8],
    [20, 15],
    [32, 24],
    [100, 24],
  ])('%i non-offline devices → %i', (deviceCount, expected) => {
    expect(computeAutoConcurrency(deviceCount)).toBe(expected)
  })

  test('never drops below the floor of 6, even at 0 devices', () => {
    expect(computeAutoConcurrency(0)).toBe(6)
  })

  test('never exceeds the ceiling of 24, no matter how large the fleet', () => {
    expect(computeAutoConcurrency(1000)).toBe(24)
  })

  test('is monotonically non-decreasing as device count grows', () => {
    let prev = 0
    for (let n = 0; n <= 100; n++) {
      const v = computeAutoConcurrency(n)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('computeAutoStreams (plan 85 §3.1, §4.2)', () => {
  test.each([
    [0, 8],
    [1, 8],
    [4, 10],
    [5, 13],
    [10, 25],
    [20, 50],
    [26, 64],
    [100, 64],
  ])('%i non-offline devices → %i', (deviceCount, expected) => {
    expect(computeAutoStreams(deviceCount)).toBe(expected)
  })

  test('never drops below the floor of 8, even at 0 devices', () => {
    expect(computeAutoStreams(0)).toBe(8)
  })

  test('never exceeds the ceiling of 64, no matter how large the fleet', () => {
    expect(computeAutoStreams(1000)).toBe(64)
  })

  test('is monotonically non-decreasing as device count grows', () => {
    let prev = 0
    for (let n = 0; n <= 100; n++) {
      const v = computeAutoStreams(n)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

/*
  The session-build ceiling was a flat 16 at every fleet size until 2026-09-18,
  and 16 is the number that took the owner's 73-phone farm down twice in five
  minutes: a wave of fourteen builds, `scrcpy server exited unexpectedly (code
  255)` one second later, `track-devices dropped` three seconds after that, and
  every session on the farm gone with it.

  A build is not one round trip — it pushes and starts a scrcpy server, brings
  up an inspector, and asserts the rotation lock. So what this bounds is the
  BURST, and the property worth pinning is that the burst stops growing with
  the fleet, which is the opposite of what the other two formulas here do.
*/
describe('computeAutoBuildCeiling (2026-09-18)', () => {
  const BASE = 16

  test.each([
    [0, 16],
    [10, 16],
    [26, 16],
    [40, 10],
    [73, 6],
    [200, 6],
  ])('%i non-offline devices → %i concurrent builds', (deviceCount, expected) => {
    expect(computeAutoBuildCeiling(deviceCount, BASE)).toBe(expected)
  })

  test('no farm at or below the inflection changes behaviour at all', () => {
    for (let n = 0; n <= 26; n++) expect(computeAutoBuildCeiling(n, BASE)).toBe(BASE)
  })

  /** The whole point: unlike concurrency and streams, this must NOT climb with the fleet. */
  test('is monotonically non-increasing as device count grows', () => {
    let prev = Number.POSITIVE_INFINITY
    for (let n = 0; n <= 200; n++) {
      const v = computeAutoBuildCeiling(n, BASE)
      expect(v).toBeLessThanOrEqual(prev)
      prev = v
    }
  })

  /**
   * A farm must still come up. At the floor, 73 phones is roughly half a minute
   * of ramp — against a farm that otherwise does not come up at all.
   */
  test('never narrows past the floor of 6, however large the fleet', () => {
    expect(computeAutoBuildCeiling(10_000, BASE)).toBe(6)
  })

  test('holds the burst roughly constant past the inflection', () => {
    // 26 × 16 = 416 device-builds of pressure; every larger farm stays near it.
    for (const n of [30, 40, 50, 73, 100]) {
      expect(computeAutoBuildCeiling(n, BASE) * n).toBeLessThan(26 * BASE * 1.6)
    }
  })

  test('an operator who pins a lower base is never widened by the formula', () => {
    expect(computeAutoBuildCeiling(10, 4)).toBe(4)
    expect(computeAutoBuildCeiling(73, 4)).toBe(6)
  })
})

describe('computeSyncFanout / computeAsyncFanout (plan 227 §3.2)', () => {
  test('the sync width follows adb’s live semaphore once that is wider than the old constant', () => {
    // `computeAutoConcurrency(73)` is 24 — the farm this plan was written for.
    expect(computeSyncFanout(24, 32)).toBe(24)
  })

  test('no farm gets narrower than the 16 this repo shipped before', () => {
    // A small farm's semaphore is 6, and an operator may pin `adb.maxConcurrent`
    // as low as 2. Neither may make a bulk Sleep narrower than it already was.
    expect(computeSyncFanout(6, 32)).toBe(16)
    expect(computeSyncFanout(2, 32)).toBe(16)
  })

  test('the ceiling wins over the semaphore, so an override can bound a wide lane', () => {
    expect(computeSyncFanout(64, 32)).toBe(32)
  })

  test('the async width is half the adb lane, because those verbs move megabytes', () => {
    expect(computeAsyncFanout(24, 12)).toBe(12)
    expect(computeAsyncFanout(16, 12)).toBe(8)
  })

  test('the async floor is the 4 this repo shipped before', () => {
    expect(computeAsyncFanout(6, 12)).toBe(4)
    expect(computeAsyncFanout(2, 12)).toBe(4)
  })

  test('a semaphore of 0 — the fallback when nothing wired the accessor — still yields the old widths', () => {
    // `ActionsDeps.adbConcurrency` is optional; absent, `run.ts` passes 0.
    // That must land on the pre-plan-227 behaviour, never on zero width.
    expect(computeSyncFanout(0, 32)).toBe(16)
    expect(computeAsyncFanout(0, 12)).toBe(4)
  })

  test('both are monotonically non-decreasing as the lane widens', () => {
    let sync = 0
    let async_ = 0
    for (let n = 0; n <= 64; n++) {
      expect(computeSyncFanout(n, 32)).toBeGreaterThanOrEqual(sync)
      expect(computeAsyncFanout(n, 12)).toBeGreaterThanOrEqual(async_)
      sync = computeSyncFanout(n, 32)
      async_ = computeAsyncFanout(n, 12)
    }
  })
})
