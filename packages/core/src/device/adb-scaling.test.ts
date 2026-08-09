import { describe, expect, test } from 'bun:test'
import { computeAutoConcurrency, computeAutoStreams } from './adb-scaling'

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
