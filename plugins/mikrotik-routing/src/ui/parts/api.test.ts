import { describe, expect, test } from 'bun:test'
import { deviceSearchTerms, matchesDeviceQuery } from '@enkaku/ui'
import { FleetResultSchema, type FleetDeviceRow } from './api'

/**
 * Plan 124 step 124.7 — the device NUMBER on this pack's own wire.
 *
 * `service/apply.ts`'s `loadFleetState` built every `FleetDeviceRow` from a
 * real `DeviceInfo` and dropped `number` on the floor, and this file's
 * `FleetDeviceRowSchema` had no field to receive it (§0.2). That is why the
 * group editor's "Add a device…" list and the Assignments table showed the
 * owner's 45 near-identical phones as bare, indistinguishable labels.
 *
 * Two things are proved here, and they are the two that make the screens
 * above possible at all: the field survives the parse in both of its states,
 * and a parsed row satisfies `@enkaku/ui`'s structural `SearchableDevice` —
 * which is what lets the tab call `matchesDeviceQuery`/`deviceSearchTerms` on
 * these rows without widening them into a `DeviceInfo` (§4.1).
 */

function rowPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: 'd1',
    stableId: 'R5CW1234',
    label: 'SM-F721U1',
    number: 7,
    lan: { deviceId: 'd1', stableId: 'R5CW1234', label: 'SM-F721U1', state: 'resolved', lanIp: '192.168.10.15', lanIpSource: 'transport', leaseKind: 'dynamic' },
    assignment: { pathId: 'via-modem1', groupId: 'default', lanIp: '192.168.10.15', lanIpSource: 'transport', leaseKind: 'dynamic', since: 1000 },
    ...overrides,
  }
}

function parseOneRow(overrides: Record<string, unknown> = {}): FleetDeviceRow {
  const result = FleetResultSchema.parse({ ok: true, fleet: { devices: [rowPayload(overrides)], paths: [], health: [] } })
  if (!result.ok) throw new Error('unreachable — the fixture is the ok branch')
  const row = result.fleet.devices[0]
  if (!row) throw new Error('unreachable — the fixture has one row')
  return row
}

describe('FleetDeviceRowSchema — the number on the wire', () => {
  test('carries the number through the parse', () => {
    expect(parseOneRow().number).toBe(7)
  })

  test('null is a legitimate value — a device whose number was released, or never allocated one', () => {
    // Criterion 7's precondition: the screens render a bare label for this
    // row, never `#null`, and they can only do that if `null` parses.
    expect(parseOneRow({ number: null }).number).toBeNull()
  })

  test('a row with NO number field at all is refused rather than silently unnumbered', () => {
    const { number: _dropped, ...withoutNumber } = rowPayload()
    // The half that builds this row ships inside the same pack as this file,
    // so a missing field means the pack's two halves disagree. Failing loudly
    // says that; defaulting to `null` would render an entire farm as
    // unnumbered and look like a farm that had allocated no numbers.
    expect(() => FleetResultSchema.parse({ ok: true, fleet: { devices: [withoutNumber], paths: [], health: [] } })).toThrow()
  })

  test('a fractional number is refused — a device number is an integer identity', () => {
    expect(() => FleetResultSchema.parse({ ok: true, fleet: { devices: [rowPayload({ number: 7.5 })], paths: [], health: [] } })).toThrow()
  })
})

describe('a parsed row is searchable by @enkaku/ui, with no widening', () => {
  test('typing the number finds it, with or without the hash, and does not drag in its neighbours', () => {
    const row = parseOneRow()
    expect(matchesDeviceQuery(row, '7')).toBe(true)
    expect(matchesDeviceQuery(row, '#7')).toBe(true)
    // The reason the number match is exact rather than a substring: on a
    // 45-device farm, `7` matching `#17`, `#27` and `#70` is the difference
    // between one hit and four (plan 124 §4.1).
    // The label here is deliberately free of the digit — `SM-F721U1` would
    // match `7` as a plain label substring and prove nothing about the number.
    expect(matchesDeviceQuery(parseOneRow({ number: 17, label: 'Galaxy A15', stableId: 'R5CW1234' }), '7')).toBe(false)
  })

  test('label and stableId still match as substrings, and an empty query keeps the whole list', () => {
    const row = parseOneRow()
    expect(matchesDeviceQuery(row, 'f721')).toBe(true)
    expect(matchesDeviceQuery(row, 'r5cw')).toBe(true)
    expect(matchesDeviceQuery(row, '   ')).toBe(true)
    expect(matchesDeviceQuery(row, 'pixel')).toBe(false)
  })

  test('deviceSearchTerms gives the combobox both forms of the number, plus label and stableId', () => {
    expect(deviceSearchTerms(parseOneRow())).toEqual(['7', '#7', 'SM-F721U1', 'R5CW1234'])
    // A device with no number contributes no `#` term at all — nothing in the
    // filter index may read `#null`.
    expect(deviceSearchTerms(parseOneRow({ number: null }))).toEqual(['SM-F721U1', 'R5CW1234'])
  })
})
