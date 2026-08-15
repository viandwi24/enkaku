import { describe, expect, test } from 'bun:test'
import { formatValue } from './format'

/**
 * `formatValue`'s own test file (plan 95 §5 step 95.3's checklist) — the
 * five worked examples the step names verbatim, plus the edge cases the
 * controls rely on (a non-number reads as `"—"`, never `"NaN"` or blank;
 * a pair needs no formatter of its own).
 */
describe('formatValue — the five worked examples (plan 95 §5 step 95.3)', () => {
  test('536870912 bytes → "512 MB"', () => {
    expect(formatValue('bytes', undefined, 536_870_912)).toBe('512 MB')
  })

  test('6000000 bitrate → "6 Mbps"', () => {
    expect(formatValue('bitrate', undefined, 6_000_000)).toBe('6 Mbps')
  })

  test('0.35 chance → "35%"', () => {
    expect(formatValue('chance', undefined, 0.35)).toBe('35%')
  })

  test('[5, 20] duration seconds → "5 s ~ 20 s"', () => {
    expect(formatValue('duration', 's', [5, 20])).toBe('5 s ~ 20 s')
  })

  test('90000 duration ms → "1 min 30 s"', () => {
    expect(formatValue('duration', 'ms', 90_000)).toBe('1 min 30 s')
  })
})

describe('formatValue — other kinds', () => {
  test('count and plain are the bare number, no thousands separator', () => {
    expect(formatValue('count', undefined, 30)).toBe('30')
    expect(formatValue('plain', undefined, 1500)).toBe('1500')
  })

  test('pixels and temperature carry their unit', () => {
    expect(formatValue('pixels', undefined, 1080)).toBe('1080 px')
    expect(formatValue('temperature', undefined, 45)).toBe('45 °C')
  })

  test('duration under a second stays in ms', () => {
    expect(formatValue('duration', 'ms', 250)).toBe('250 ms')
  })

  test('duration with an exact hour has no zero minutes/seconds tacked on', () => {
    expect(formatValue('duration', 'h', 2)).toBe('2 h')
  })

  test('bytes and bitrate below the first unit stay in the base unit', () => {
    expect(formatValue('bytes', undefined, 512)).toBe('512 B')
    expect(formatValue('bitrate', undefined, 500)).toBe('500 bps')
  })
})

describe('formatValue — totality (never NaN, never blank)', () => {
  test('undefined, null, and a non-numeric value all read as an em dash', () => {
    expect(formatValue('count', undefined, undefined)).toBe('—')
    expect(formatValue('count', undefined, null)).toBe('—')
    expect(formatValue('count', undefined, 'not a number')).toBe('—')
  })

  test('a malformed pair (wrong length, or neither half a number) reads as an em dash', () => {
    expect(formatValue('duration', 's', [1, 2, 3])).toBe('—')
    expect(formatValue('duration', 's', ['a', 'b'])).toBe('—')
  })

  test('a pair with only one real half formats the other as an em dash, not a crash', () => {
    expect(formatValue('duration', 's', [5, undefined])).toBe('5 s ~ —')
  })
})
