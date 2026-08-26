import { describe, expect, test } from 'bun:test'
import {
  applyAnywayOffer,
  describeSkipReason,
  duplicateDeviceNumbersInRange,
  isEverythingFilteredSelected,
  pathDownRows,
  rowsStillUnwritten,
  selectAllFiltered,
  selectedCountInScope,
  selectedRowsAssignable,
  selectedRowsClearable,
  toggleSelected,
  writablePairingRows,
} from './assignments'
import type { FleetDeviceRow, PlanRow } from './api'
import type { PairingRow } from './bulk-builder'

/**
 * Plan 131 §5, steps 131.2/131.4/131.6 — pure logic only, exactly like
 * `bulk-builder.test.ts` and `bits.test.ts` already do for this pack: no DOM
 * harness exists here, so the guards are proved as functions, and the
 * components (`BulkBuilderDialog`, the selection UI, `ApplyDialog`) only
 * ever render what these return.
 */

function makeDevice(deviceId: string, opts: { number?: number | null; lanState?: 'resolved' | 'needs-address'; pathId?: string; lanIp?: string } = {}): FleetDeviceRow {
  const number = opts.number ?? null
  const lanState = opts.lanState ?? 'resolved'
  return {
    deviceId,
    stableId: `stable-${deviceId}`,
    label: `Device ${deviceId}`,
    number,
    lan:
      lanState === 'resolved'
        ? { deviceId, stableId: `stable-${deviceId}`, label: `Device ${deviceId}`, state: 'resolved', lanIp: '192.168.10.1', lanIpSource: 'lease', leaseKind: 'static' }
        : { deviceId, stableId: `stable-${deviceId}`, label: `Device ${deviceId}`, state: 'needs-address' },
    assignment: { pathId: opts.pathId ?? '', groupId: '', lanIp: opts.lanIp ?? '', lanIpSource: '', leaseKind: '', since: 0 },
  }
}

function skipRow(endpointKey: string, pathId: string, reason: string): PlanRow {
  return { kind: 'skip', endpointKey, pathId, groupId: 'default', groupName: 'Default', reason }
}

// ---------------------------------------------------------------------------
// 131.2 — the builder's own logic beyond `buildPairings` (131.1)
// ---------------------------------------------------------------------------

describe('writablePairingRows', () => {
  const rows: PairingRow[] = [
    { deviceNumber: 1, deviceId: 'dev-1', pathId: 'via-a', pathLabel: 'via-a', note: 'ok' },
    { deviceNumber: 2, deviceId: 'dev-2', pathId: 'via-b', pathLabel: 'via-b', note: 'already-assigned' },
    { deviceNumber: 3, deviceId: null, pathId: 'via-c', pathLabel: 'via-c', note: 'no-such-device' },
    { deviceNumber: 4, deviceId: 'dev-4', pathId: null, pathLabel: null, note: 'no-path' },
  ]

  test('writes exactly the rows with both a real device and a real path — ok and already-assigned', () => {
    expect(writablePairingRows(rows).map((r) => r.deviceNumber)).toEqual([1, 2])
  })

  test('never writes a no-such-device row — there is no stableId to write through', () => {
    expect(writablePairingRows(rows).some((r) => r.note === 'no-such-device')).toBe(false)
  })

  test('never writes a no-path row — there is nothing to point the device at', () => {
    expect(writablePairingRows(rows).some((r) => r.note === 'no-path')).toBe(false)
  })

  test('an already-assigned row IS written — the whole point is repointing it, not skipping it', () => {
    const already = writablePairingRows(rows).find((r) => r.deviceNumber === 2)
    expect(already?.pathId).toBe('via-b')
  })
})

describe('duplicateDeviceNumbersInRange', () => {
  test('flags a number carried by two enrolled devices, when it falls inside the range', () => {
    const devices = [makeDevice('a', { number: 5 }), makeDevice('b', { number: 5 }), makeDevice('c', { number: 6 })]
    expect(duplicateDeviceNumbersInRange(devices, 1, 10)).toEqual([5])
  })

  test('a duplicate number OUTSIDE the requested range is not reported — it cannot surprise this builder', () => {
    const devices = [makeDevice('a', { number: 50 }), makeDevice('b', { number: 50 })]
    expect(duplicateDeviceNumbersInRange(devices, 1, 10)).toEqual([])
  })

  test('no duplicates: an empty array, not an error or a guess about which device wins', () => {
    const devices = [makeDevice('a', { number: 1 }), makeDevice('b', { number: 2 })]
    expect(duplicateDeviceNumbersInRange(devices, 1, 2)).toEqual([])
  })

  test('devices with no number at all are never counted as duplicates of each other', () => {
    const devices = [makeDevice('a', { number: null }), makeDevice('b', { number: null })]
    expect(duplicateDeviceNumbersInRange(devices, 1, 10)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 131.4 — selection scope maths
// ---------------------------------------------------------------------------

describe('toggleSelected', () => {
  test('adds an id not yet selected', () => {
    expect(toggleSelected(new Set(), 'a')).toEqual(new Set(['a']))
  })

  test('removes an id already selected', () => {
    expect(toggleSelected(new Set(['a', 'b']), 'a')).toEqual(new Set(['b']))
  })

  test('does not mutate the set it was given', () => {
    const original = new Set(['a'])
    toggleSelected(original, 'b')
    expect(original).toEqual(new Set(['a']))
  })
})

describe('selectAllFiltered / isEverythingFilteredSelected', () => {
  const filtered = [makeDevice('a'), makeDevice('b'), makeDevice('c')]

  test('select-all selects exactly the FILTERED rows, never a wider set — docs/design.md, "a filter must not lie about its scope"', () => {
    expect(selectAllFiltered(filtered)).toEqual(new Set(['a', 'b', 'c']))
  })

  test('header checkbox reads true only once every filtered row is selected', () => {
    expect(isEverythingFilteredSelected(new Set(['a', 'b']), filtered)).toBe(false)
    expect(isEverythingFilteredSelected(new Set(['a', 'b', 'c']), filtered)).toBe(true)
  })

  test('a selection that also contains ids OUTSIDE the filtered set still does not read as "all selected" if a filtered row is missing', () => {
    expect(isEverythingFilteredSelected(new Set(['a', 'z']), filtered)).toBe(false)
  })

  test('an empty filtered list is never "all selected" — nothing to select is not a selection', () => {
    expect(isEverythingFilteredSelected(new Set(), [])).toBe(false)
  })
})

describe('selectedCountInScope', () => {
  test('counts only selected ids that are actually in the filtered (visible) set', () => {
    const filtered = [makeDevice('a'), makeDevice('b')]
    // 'z' is selected but not part of what the filter currently shows — the
    // guard this function IS: break it by counting `selected.size` directly
    // (2) instead, and the bulk bar would claim a device the operator cannot
    // see. This asserts the correct, scoped answer (1).
    expect(selectedCountInScope(new Set(['a', 'z']), filtered)).toBe(1)
  })

  test('matches selected.size exactly when the selection is entirely in scope', () => {
    const filtered = [makeDevice('a'), makeDevice('b')]
    expect(selectedCountInScope(new Set(['a', 'b']), filtered)).toBe(2)
  })

  test('zero when nothing is selected, even with a large filtered list', () => {
    expect(selectedCountInScope(new Set(), [makeDevice('a'), makeDevice('b')])).toBe(0)
  })
})

describe('selectedRowsClearable', () => {
  test('a row with a path noted is clearable', () => {
    const rows = [makeDevice('a', { pathId: 'via-a' })]
    expect(selectedRowsClearable(new Set(['a']), rows)).toHaveLength(1)
  })

  test('a row with only a LAN IP noted (no path) is still clearable', () => {
    const rows = [makeDevice('a', { lanIp: '192.168.10.5' })]
    expect(selectedRowsClearable(new Set(['a']), rows)).toHaveLength(1)
  })

  test('a row with neither a path nor a LAN note has nothing to clear', () => {
    const rows = [makeDevice('a')]
    expect(selectedRowsClearable(new Set(['a']), rows)).toHaveLength(0)
  })

  test('a clearable row that is NOT selected is excluded', () => {
    const rows = [makeDevice('a', { pathId: 'via-a' })]
    expect(selectedRowsClearable(new Set(), rows)).toHaveLength(0)
  })
})

describe('selectedRowsAssignable', () => {
  test('a device with a resolved LAN address can be bulk-assigned a path', () => {
    const rows = [makeDevice('a', { lanState: 'resolved' })]
    expect(selectedRowsAssignable(new Set(['a']), rows)).toHaveLength(1)
  })

  test('a device with no resolved LAN address cannot — mirrors the per-row Combobox\'s own disabled rule', () => {
    const rows = [makeDevice('a', { lanState: 'needs-address' })]
    expect(selectedRowsAssignable(new Set(['a']), rows)).toHaveLength(0)
  })

  test('an unselected row is excluded even if it is otherwise assignable', () => {
    const rows = [makeDevice('a', { lanState: 'resolved' })]
    expect(selectedRowsAssignable(new Set(), rows)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 131.6 — apply anyway, deliberately
// ---------------------------------------------------------------------------

describe('pathDownRows / applyAnywayOffer', () => {
  test('absent when the plan has no skip row at all', () => {
    const rows: PlanRow[] = [{ kind: 'create', endpointKey: '192.168.10.1', pathId: 'via-a', groupId: 'default', groupName: 'Default' }]
    expect(applyAnywayOffer(rows)).toBeNull()
  })

  test('absent when the plan has skip rows for OTHER reasons — path-missing and duplicate stay a hard stop, never offered a bypass', () => {
    const rows: PlanRow[] = [skipRow('192.168.10.1', 'via-a', 'path-missing'), skipRow('192.168.10.2', 'via-b', 'duplicate')]
    expect(applyAnywayOffer(rows)).toBeNull()
    expect(pathDownRows(rows)).toHaveLength(0)
  })

  test('present, and names the count, when some rows are skip/path-down', () => {
    const rows: PlanRow[] = [skipRow('192.168.10.1', 'via-a', 'path-down'), skipRow('192.168.10.2', 'via-b', 'path-down'), skipRow('192.168.10.3', 'via-a', 'path-missing')]
    const offer = applyAnywayOffer(rows)
    expect(offer?.count).toBe(2)
  })

  test('names the DISTINCT down paths, not one entry per row', () => {
    const rows: PlanRow[] = [skipRow('192.168.10.1', 'via-a', 'path-down'), skipRow('192.168.10.2', 'via-a', 'path-down'), skipRow('192.168.10.3', 'via-b', 'path-down')]
    expect(applyAnywayOffer(rows)?.pathIds.sort()).toEqual(['via-a', 'via-b'])
  })

  test('a mix of create/update/delete/foreign rows alongside a path-down skip still surfaces only the skip rows', () => {
    const rows: PlanRow[] = [
      { kind: 'create', endpointKey: '192.168.10.9', pathId: 'via-z', groupId: 'default', groupName: 'Default' },
      skipRow('192.168.10.1', 'via-a', 'path-down'),
    ]
    expect(pathDownRows(rows)).toHaveLength(1)
  })
})

describe('describeSkipReason', () => {
  test('path-down names what it is waiting for AND what the operator can do — never just the bare reason word', () => {
    const copy = describeSkipReason('path-down')
    expect(copy).not.toBe('path-down')
    expect(copy.toLowerCase()).toContain('down')
    expect(copy.toLowerCase()).toContain('apply anyway')
  })

  test('path-missing and duplicate each get their own actionable copy, not the same sentence reused', () => {
    const missing = describeSkipReason('path-missing')
    const duplicate = describeSkipReason('duplicate')
    expect(missing).not.toBe(duplicate)
    expect(missing.toLowerCase()).toContain('recreate')
    expect(duplicate.toLowerCase()).toContain('router')
  })

  test('an unrecognised reason falls back to the raw string rather than throwing or going blank', () => {
    expect(describeSkipReason('some-future-reason')).toBe('some-future-reason')
  })

  test('no reason at all reads as an empty string, not "undefined"', () => {
    expect(describeSkipReason(undefined)).toBe('')
  })
})

describe('rowsStillUnwritten', () => {
  test('every path-down row is reported unwritten when outcomes contain none of them — the current backend, honestly: executePlan (service/apply.ts) never touches a skip row', () => {
    const rows: PlanRow[] = [skipRow('192.168.10.1', 'via-a', 'path-down')]
    expect(rowsStillUnwritten(rows, [])).toHaveLength(1)
  })

  test('a path-down row IS excluded once an outcome for its endpoint exists — forward-compatible with a future backend that can force it through', () => {
    const rows: PlanRow[] = [skipRow('192.168.10.1', 'via-a', 'path-down')]
    const outcomes = [{ row: { kind: 'update', endpointKey: '192.168.10.1', fromPathId: 'via-old', toPathId: 'via-a', groupId: 'default', groupName: 'Default', rule: { '.id': '*1', comment: '' } } as PlanRow }]
    expect(rowsStillUnwritten(rows, outcomes)).toHaveLength(0)
  })

  test('an outcome for a DIFFERENT endpoint does not clear an unrelated down row', () => {
    const rows: PlanRow[] = [skipRow('192.168.10.1', 'via-a', 'path-down')]
    const outcomes = [{ row: { kind: 'create', endpointKey: '192.168.10.99', pathId: 'via-z', groupId: 'default', groupName: 'Default' } as PlanRow }]
    expect(rowsStillUnwritten(rows, outcomes)).toHaveLength(1)
  })
})
