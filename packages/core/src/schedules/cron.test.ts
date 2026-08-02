import { describe, expect, test } from 'bun:test'
import { nextFires, occurrencesBetween } from './cron'

/**
 * Every timestamp here is a fixed, hardcoded input — never `Date.now()` — so
 * these tests are reproducible regardless of when they run (plan 21 §21.3).
 */

function nyDate(epochSec: number): string {
  // en-CA gives an unambiguous YYYY-MM-DD, which is all these tests need.
  return new Date(epochSec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

describe('nextFires — DST spring-forward gap', () => {
  test('a 2am America/New_York daily cron never fires twice, and never hangs, on the gap day', () => {
    // 2024-03-09 03:00 EST (UTC-5, DST has not started yet) = 08:00Z.
    // The 2024-03-10 2:00am fire falls inside the gap (clocks jump 2:00 -> 3:00):
    // that wall-clock moment does not exist. Empirically (croner 10.x), the
    // invalid instant resolves forward to the first valid moment (3:00am) —
    // it does not fire twice and does not disappear. What matters for the
    // runner (plan 21 §3.4) is that this is a SINGLE, deterministic fire with
    // a fixed input, and that the schedule is back on the dot the next day.
    const from = new Date('2024-03-09T08:00:00.000Z')
    const result = nextFires('0 2 * * *', 'America/New_York', 3, from)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const dates = result.value.map(nyDate)
    // Exactly one fire lands on the gap day — never zero, never two.
    expect(dates.filter((d) => d === '2024-03-10').length).toBe(1)
    // The following days are back to the regular 2am slot.
    expect(dates).toEqual(['2024-03-10', '2024-03-11', '2024-03-12'])
    const times = result.value.map((s) => new Date(s * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }))
    expect(times[1]).toBe('02:00:00')
    expect(times[2]).toBe('02:00:00')
  })
})

describe('nextFires — DST fall-back overlap fires once', () => {
  test('a 1am America/New_York daily cron fires exactly once on the day the hour repeats', () => {
    // 2024-11-02 12:00 EDT (UTC-4, still on daylight time) = 16:00Z.
    // 2024-11-03 is the fall-back day: clocks go 2:00 -> 1:00, so local 1am happens twice.
    const from = new Date('2024-11-02T16:00:00.000Z')
    const result = nextFires('0 1 * * *', 'America/New_York', 4, from)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const dates = result.value.map(nyDate)
    const onFallbackDay = dates.filter((d) => d === '2024-11-03')
    expect(onFallbackDay.length).toBe(1)
  })
})

describe('nextFires — a zone with no DST is perfectly stable', () => {
  test('Asia/Jakarta hourly fires are exactly 3600 seconds apart', () => {
    const from = new Date('2024-06-01T00:00:00.000Z')
    const result = nextFires('0 * * * *', 'Asia/Jakarta', 5, from)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (let i = 1; i < result.value.length; i++) {
      expect(result.value[i]! - result.value[i - 1]!).toBe(3600)
    }
  })
})

describe('nextFires — an invalid expression is a typed error, not a throw', () => {
  test('garbage input returns { ok: false } instead of throwing', () => {
    expect(() => nextFires('not a cron expression at all', 'UTC', 1, new Date('2024-01-01T00:00:00.000Z'))).not.toThrow()
    const result = nextFires('not a cron expression at all', 'UTC', 1, new Date('2024-01-01T00:00:00.000Z'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.length).toBeGreaterThan(0)
  })

  test('an invalid timezone is also a typed error', () => {
    const result = nextFires('0 * * * *', 'Not/A_Zone', 1, new Date('2024-01-01T00:00:00.000Z'))
    expect(result.ok).toBe(false)
  })
})

describe('occurrencesBetween — the basis of catch-up (plan 21 §3.4)', () => {
  test('counts fires strictly after `from`, up to and including `to`', () => {
    // Hourly cron, a fixed 3-hour window → exactly 3 occurrences.
    const from = new Date('2024-06-01T00:00:00.000Z')
    const to = new Date('2024-06-01T03:00:00.000Z')
    const result = occurrencesBetween('0 * * * *', 'UTC', from, to)
    expect(result).toEqual({ ok: true, value: 3 })
  })

  test('zero occurrences when nothing was due in the window', () => {
    const from = new Date('2024-06-01T00:00:10.000Z')
    const to = new Date('2024-06-01T00:00:20.000Z')
    const result = occurrencesBetween('0 * * * *', 'UTC', from, to)
    expect(result).toEqual({ ok: true, value: 0 })
  })
})
