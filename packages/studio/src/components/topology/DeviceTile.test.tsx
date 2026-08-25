import { afterEach, describe, expect, test } from 'bun:test'
import type { DeviceInfo } from '@enkaku/protocol'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { DeviceTile } from './DeviceTile'

/**
 * The fleet map's tile (plan 32 §3.4).
 *
 * This file exists because of plan 124 §0.1: the fleet map named every device
 * by its bare `label`, while its own sibling `wall/WallTile.tsx` — the same
 * device, one screen away — has shown the number since plan 89. On the
 * owner's farm that meant the map read `SM-F721U1` three times in a row and
 * the Wall read `#7`, `#8`, `#9`, which is worse than either alone: the two
 * views stop looking like the same fleet.
 *
 * Scoped deliberately to identity only. Everything else this tile renders
 * (the status rail, the readiness/status badges, `TileChips`' colour rules)
 * is already proven where it is defined — `wall/tile-identity.test.ts`,
 * `StatusBadge`'s own tests — and duplicating it here would be a second copy
 * to keep in sync, not extra coverage.
 */
afterEach(cleanup)

const BASE_DEVICE: DeviceInfo = {
  id: 'd1',
  stableId: 'stable-1',
  serial: 'emulator-5554',
  label: 'moto g06 power',
  androidVersion: '14',
  apiLevel: 34,
  screenW: 1080,
  screenH: 2400,
  density: 420,
  status: 'idle',
  lastSeen: 1_700_000_000,
  battery: null,
  quarantineReason: null,
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 1_700_000_000 },
  connection: { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
}

function renderTile(device: DeviceInfo) {
  return renderWithApi(<DeviceTile device={device} clusterCount={1} tempThresholdC={45} now={1_700_000_000} />)
}

describe('DeviceTile — the device number (plan 124 §4.4 Group B, step 124.2)', () => {
  test('renders `#7` beside the label, in its own span — never concatenated into `label`', () => {
    const { getByText } = renderTile({ ...BASE_DEVICE, number: 7 })
    // Two separate text nodes are the assertion: `getByText('#7')` only
    // succeeds if the number is its own element, which is what allows it to
    // be dimmed (plan 124 §3.2) and what keeps `devices.label` untouched.
    expect(getByText('#7')).toBeTruthy()
    expect(getByText('moto g06 power')).toBeTruthy()
    expect(BASE_DEVICE.label).not.toContain('#')
  })

  test('a device with no number renders the bare label — no `#`, no `#null` (criterion 7)', () => {
    // `null` is the real, legitimate state for a device whose reservation
    // was explicitly released, and for every device on a cloud node (see
    // `wall/tile-identity.ts`'s own note on the two causes).
    const { getByText, queryByText } = renderTile({ ...BASE_DEVICE, number: null })
    expect(getByText('moto g06 power')).toBeTruthy()
    expect(queryByText(/#/)).toBeNull()
  })

  test('a fixture that predates the field (number undefined) is treated as no number, not as `#undefined`', () => {
    const { number: _omit, ...withoutNumber } = BASE_DEVICE
    const { getByText, queryByText } = renderTile(withoutNumber as DeviceInfo)
    expect(getByText('moto g06 power')).toBeTruthy()
    expect(queryByText(/#/)).toBeNull()
  })
})
