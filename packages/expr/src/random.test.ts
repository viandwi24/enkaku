import { describe, expect, test } from 'bun:test'
import { deriveRandom } from './random'

describe('deriveRandom (plan 304 §3.4)', () => {
  test('is pure: the same (seed, seq) pair always returns the same value', () => {
    expect(deriveRandom(42, 3)).toBe(deriveRandom(42, 3))
    expect(deriveRandom(0, 0)).toBe(deriveRandom(0, 0))
  })

  test('every value is in [0, 1)', () => {
    for (let seed = 0; seed < 20; seed++) {
      for (let seq = 0; seq < 20; seq++) {
        const v = deriveRandom(seed, seq)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
      }
    }
  })

  test('different seq values (same seed) produce different values', () => {
    const values = new Set(Array.from({ length: 10 }, (_, seq) => deriveRandom(7, seq)))
    expect(values.size).toBe(10)
  })

  test('different seed values (same seq) produce different values', () => {
    const values = new Set(Array.from({ length: 10 }, (_, seed) => deriveRandom(seed, 5)))
    expect(values.size).toBe(10)
  })
})
