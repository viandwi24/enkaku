import { describe, expect, test } from 'bun:test'
import type { SweepReport } from '@enkaku/protocol'
import { hasScannableNetwork, scanDisabledReason, summariseSweepReport } from './network-scan'

function report(overrides: Partial<SweepReport> = {}): SweepReport {
  return {
    networks: [{ cidr: '10.20.0.0/24', label: 'Chassis A', addresses: 256, port: 5555 }],
    scanned: 0,
    skipped: 0,
    answered: 0,
    connected: 0,
    identified: 0,
    adopted: [],
    discovered: [],
    conflicts: [],
    durationMs: 12,
    ...overrides,
  }
}

/**
 * `packages/core/src/api/devices.ts`'s own doc comment above `POST /scan`
 * used to claim "the Studio 'Rescan / scan all networks' button" already
 * called it — false, confirmed by grep before this file existed. These
 * tests cover the pure helpers behind the button that actually closes that
 * gap (plan 88 §5 step 88.12).
 */
describe('scanDisabledReason', () => {
  test('null (loading) reads as "checking", not silently enabled', () => {
    expect(scanDisabledReason(null)).toMatch(/checking/i)
  })

  test('zero configured networks reuses the empty-state wording verbatim, not invented text', () => {
    expect(scanDisabledReason([])).toBe('No networks configured — the sweep cannot run')
  })

  test('networks exist but none are included in a sweep', () => {
    const reason = scanDisabledReason([{ scan: false }, { scan: false }])
    expect(reason).toMatch(/include in a sweep/i)
  })

  test('at least one scannable network enables the button (null reason)', () => {
    expect(scanDisabledReason([{ scan: false }, { scan: true }])).toBeNull()
  })
})

describe('hasScannableNetwork', () => {
  test('true only when at least one row has scan: true', () => {
    expect(hasScannableNetwork([])).toBe(false)
    expect(hasScannableNetwork([{ scan: false }])).toBe(false)
    expect(hasScannableNetwork([{ scan: false }, { scan: true }])).toBe(true)
  })
})

describe('summariseSweepReport', () => {
  test('a scan that found nothing says so plainly — never identical to a scan that silently did nothing', () => {
    const line = summariseSweepReport(report({ scanned: 254, answered: 0 }))
    expect(line).toBe('Swept 10.20.0.0/24 · 254 scanned · 0 answered · nothing new')
  })

  test('names every category that actually changed', () => {
    const line = summariseSweepReport(
      report({
        networks: [
          { cidr: '10.20.0.0/24', label: 'Chassis A', addresses: 256, port: 5555 },
          { cidr: '10.21.0.0/24', label: 'Chassis B', addresses: 256, port: 7000 },
        ],
        scanned: 500,
        answered: 4,
        adopted: ['SER1'],
        discovered: ['SER2', 'SER3'],
        conflicts: [{ address: '10.20.0.5', expected: 'SER9', found: 'SER8' }],
      }),
    )
    expect(line).toBe('Swept 10.20.0.0/24, 10.21.0.0/24 · 500 scanned · 4 answered · 1 reconnected · 2 newly discovered · 1 address conflict')
  })

  test('an empty networks list (should not happen, but never crashes) reads "no networks" rather than a blank string', () => {
    expect(summariseSweepReport(report({ networks: [] }))).toBe('Swept no networks · 0 scanned · 0 answered · nothing new')
  })
})
