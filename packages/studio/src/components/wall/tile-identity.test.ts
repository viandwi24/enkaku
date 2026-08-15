import { describe, expect, test } from 'bun:test'
import type { DeviceInfo } from '@enkaku/protocol'
import { tileIdentityOf, TILE_CONNECTION_ICON } from './tile-identity'

/**
 * `tileIdentityOf` (plan 92 §4.8): the one adapter `WallTile` and
 * `DeviceCard` both read the plans-88/89 fields through. Both have landed —
 * `connection` and `number` are real fields on `DeviceInfoSchema` — so these
 * tests prove the adapter reads `number` straight through, and still
 * tolerates a hand-built fixture that omits it entirely (`undefined`, never
 * produced by a real parse, but every existing component-test fixture in
 * this workspace predates this field and omits it).
 */

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 'd1',
    stableId: 'd1',
    serial: 'd1',
    label: 'moto g06',
    androidVersion: '15',
    apiLevel: 35,
    screenW: 720,
    screenH: 1600,
    density: 280,
    status: 'idle',
    lastSeen: 1,
    battery: null,
    quarantineReason: null,
    tags: [],
    cluster: null,
    lastCrashAt: null,
    readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
    ...overrides,
  }
}

describe('tileIdentityOf — the number (plan 89 §3.1-§3.3)', () => {
  test('a fixture with no `number` key at all (every pre-plan-89 component test) reads null, not a crash', () => {
    const identity = tileIdentityOf(device())
    expect(identity.number).toBeNull()
  })

  test('a device carrying a number reads it straight through', () => {
    expect(tileIdentityOf(device({ number: 42 })).number).toBe(42)
  })

  test('an explicitly released reservation (`number: null`) reads null, the same as an absent field', () => {
    expect(tileIdentityOf(device({ number: null })).number).toBeNull()
  })
})

describe('tileIdentityOf — the connection (plan 88 has landed)', () => {
  test('a fixture built by hand with no `connection` key (the convention every other component test in this workspace already uses) still gets a real glyph, not a crash', () => {
    // `connection` is optional in the TS type (Zod's `.default()`), so a
    // hand-built `DeviceInfo` — every fixture in `WallTile.test.tsx`, for
    // instance — omits it. Production rows always have one (parsed through
    // `DeviceInfoSchema`); this proves the adapter does not assume that and
    // mirrors the schema's own default instead of reading `c.kind` off
    // `undefined`.
    const identity = tileIdentityOf(device())
    expect(identity.connection).toEqual({ kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null })
  })

  test('a real connection is read straight through, unchanged', () => {
    const withConnection = device({
      connection: { kind: 'tcp', medium: 'wireless', mediumSource: 'declared', address: '10.0.0.5', port: 5555, networkLabel: null },
    })
    expect(tileIdentityOf(withConnection).connection).toEqual({
      kind: 'tcp',
      medium: 'wireless',
      mediumSource: 'declared',
      address: '10.0.0.5',
      port: 5555,
      networkLabel: null,
    })
  })
})

describe('TILE_CONNECTION_ICON — one icon per badge value', () => {
  test('covers all four values `connectionBadge()` can return', () => {
    expect(Object.keys(TILE_CONNECTION_ICON).sort()).toEqual(['OTG', 'TCP', 'USB', 'WI-FI'].sort())
  })
})
