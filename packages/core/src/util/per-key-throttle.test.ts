import { describe, expect, test } from 'bun:test'
import { createPerKeyThrottle } from './per-key-throttle'

describe('createPerKeyThrottle', () => {
  test('lets the first call through and refuses a second inside the interval', () => {
    let now = 0
    const gate = createPerKeyThrottle(600_000, () => now)
    expect(gate.take('dev-1')).toBe(true)
    now = 599_999
    expect(gate.take('dev-1')).toBe(false)
    now = 600_000
    expect(gate.take('dev-1')).toBe(true)
  })

  test('a refused call does not push the window back', () => {
    let now = 0
    const gate = createPerKeyThrottle(1_000, () => now)
    expect(gate.take('dev-1')).toBe(true)
    now = 900
    expect(gate.take('dev-1')).toBe(false)
    now = 1_000
    expect(gate.take('dev-1')).toBe(true)
  })

  test('keys are independent', () => {
    const gate = createPerKeyThrottle(1_000, () => 0)
    expect(gate.take('dev-1')).toBe(true)
    expect(gate.take('dev-2')).toBe(true)
    expect(gate.take('dev-1')).toBe(false)
  })

  test('an interval of 0 throttles nothing', () => {
    const gate = createPerKeyThrottle(0, () => 0)
    expect(gate.take('dev-1')).toBe(true)
    expect(gate.take('dev-1')).toBe(true)
  })
})
