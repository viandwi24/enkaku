import { describe, expect, test } from 'bun:test'
import {
  describeSkipReason,
  duplicateDeviceNumbersInRange,
  isEverythingFilteredSelected,
  overDownPathRows,
  selectAllFiltered,
  selectedCountInScope,
  selectedRowsAssignable,
  selectedRowsClearable,
  summariseOverDownPath,
  toggleSelected,
  writablePairingRows, findSharedPublicIps } from './assignments'
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

function createRow(endpointKey: string, pathId: string, opts: { overDownPath?: true } = {}): PlanRow {
  return { kind: 'create', endpointKey, pathId, groupId: 'default', groupName: 'Default', ...opts }
}

function updateRow(endpointKey: string, fromPathId: string, toPathId: string, opts: { overDownPath?: true } = {}): PlanRow {
  return { kind: 'update', endpointKey, fromPathId, toPathId, groupId: 'default', groupName: 'Default', rule: { '.id': '*1', comment: '' }, ...opts }
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
// 132.3 — the down-path warning (plan 132 / M97: applied, not skipped)
// ---------------------------------------------------------------------------

describe('overDownPathRows / summariseOverDownPath', () => {
  test('absent when nothing in the plan is flagged', () => {
    const rows: PlanRow[] = [createRow('192.168.10.1', 'via-a')]
    expect(summariseOverDownPath(rows)).toBeNull()
    expect(overDownPathRows(rows)).toHaveLength(0)
  })

  test('absent when the plan has skip rows — path-missing and duplicate are not down-path writes at all', () => {
    const rows: PlanRow[] = [skipRow('192.168.10.1', 'via-a', 'path-missing'), skipRow('192.168.10.2', 'via-b', 'duplicate')]
    expect(summariseOverDownPath(rows)).toBeNull()
  })

  test('present, and names the count, when some rows are flagged overDownPath', () => {
    const rows: PlanRow[] = [createRow('192.168.10.1', 'via-a', { overDownPath: true }), createRow('192.168.10.2', 'via-b', { overDownPath: true }), createRow('192.168.10.3', 'via-a')]
    const summary = summariseOverDownPath(rows)
    expect(summary?.count).toBe(2)
  })

  test('names the DISTINCT down paths, not one entry per row — an update row is named by its TARGET (toPathId), not its origin', () => {
    const rows: PlanRow[] = [
      createRow('192.168.10.1', 'via-a', { overDownPath: true }),
      updateRow('192.168.10.2', 'via-old', 'via-a', { overDownPath: true }),
      createRow('192.168.10.3', 'via-b', { overDownPath: true }),
    ]
    expect(summariseOverDownPath(rows)?.pathIds.sort()).toEqual(['via-a', 'via-b'])
  })

  test('a mix of create/update/delete/foreign/skip rows alongside a flagged one surfaces only the flagged rows', () => {
    const rows: PlanRow[] = [createRow('192.168.10.9', 'via-z'), createRow('192.168.10.1', 'via-a', { overDownPath: true }), skipRow('192.168.10.5', 'via-c', 'duplicate')]
    expect(overDownPathRows(rows)).toHaveLength(1)
  })

  test('an unflagged update row (overDownPath absent) is never counted, even though update rows carry no bare `pathId`', () => {
    const rows: PlanRow[] = [updateRow('192.168.10.2', 'via-old', 'via-a')]
    expect(overDownPathRows(rows)).toHaveLength(0)
    expect(summariseOverDownPath(rows)).toBeNull()
  })
})

describe('describeSkipReason', () => {
  test('path-missing and duplicate each get their own actionable copy, not the same sentence reused', () => {
    const missing = describeSkipReason('path-missing')
    const duplicate = describeSkipReason('duplicate')
    expect(missing).not.toBe(duplicate)
    expect(missing.toLowerCase()).toContain('recreate')
    expect(duplicate.toLowerCase()).toContain('router')
  })

  test('path-down is an unrecognised reason now — it falls back to the raw string like any other value this build does not know', () => {
    // Plan 132 (M97) removed `'path-down'` from `SkipReason` entirely: no
    // planner code path can produce it any more, so this only proves the
    // fallback is honest if a stale value ever did arrive (e.g. a cached
    // preview from before the reversal).
    expect(describeSkipReason('path-down')).toBe('path-down')
  })

  test('an unrecognised reason falls back to the raw string rather than throwing or going blank', () => {
    expect(describeSkipReason('some-future-reason')).toBe('some-future-reason')
  })

  test('no reason at all reads as an empty string, not "undefined"', () => {
    expect(describeSkipReason(undefined)).toBe('')
  })
})

/** Plan 133 (M98) §3.3 — the summary above the plan list groups reasons per path. */
describe('summariseOverDownPath — per-path reasons', () => {
  test('each distinct path carries the reason its rows reported', () => {
    const rows: PlanRow[] = [
      { kind: 'create', endpointKey: 'a', pathId: 'via-a', overDownPath: true, overDownPathReason: 'no-route-to-gateway' },
      { kind: 'update', endpointKey: 'b', fromPathId: 'via-x', toPathId: 'via-b', overDownPath: true, overDownPathReason: 'gateway-unreachable' },
      { kind: 'create', endpointKey: 'c', pathId: 'via-a', overDownPath: true, overDownPathReason: 'no-route-to-gateway' },
    ]
    expect(summariseOverDownPath(rows)?.paths).toEqual([
      { pathId: 'via-a', reason: 'no-route-to-gateway' },
      { pathId: 'via-b', reason: 'gateway-unreachable' },
    ])
  })

  test('a row with no reason yields a path entry without one — `pathIds` is unchanged either way', () => {
    const rows: PlanRow[] = [{ kind: 'create', endpointKey: 'a', pathId: 'via-a', overDownPath: true }]
    const summary = summariseOverDownPath(rows)
    expect(summary?.paths).toEqual([{ pathId: 'via-a' }])
    expect(summary?.pathIds).toEqual(['via-a'])
  })
})

/**
 * Plan 134 (M99) §0.4 — two paths behind one public IP.
 *
 * This is the fault plan 132's whole hard-constraint model exists to prevent,
 * stated by the owner as a ban risk. Until this, nothing in the plugin could
 * see it: no per-path public IP existed in the data model at all.
 */
describe('findSharedPublicIps', () => {
  const device = (pathId: string, lastPublicIp?: string): FleetDeviceRow =>
    ({ device: { deviceId: 'd', stableId: 's', label: 'l', state: 'resolved', lanIp: '10.0.0.1' }, assignment: { pathId, groupId: 'g', lanIp: '', lanIpSource: '', leaseKind: '', since: 0, ...(lastPublicIp ? { lastPublicIp } : {}) } }) as unknown as FleetDeviceRow

  test('two paths seen from one IP are reported, naming both', () => {
    const shared = findSharedPublicIps([device('via-a', '203.0.113.9'), device('via-b', '203.0.113.9'), device('via-c', '203.0.113.10')])
    expect(shared).toEqual([{ publicIp: '203.0.113.9', pathIds: ['via-a', 'via-b'] }])
  })

  test('many devices on ONE path sharing an IP is not a fault — that is what a path is', () => {
    expect(findSharedPublicIps([device('via-a', '203.0.113.9'), device('via-a', '203.0.113.9'), device('via-a', '203.0.113.9')])).toEqual([])
  })

  test('devices with no reading are absent from the comparison, never grouped with each other', () => {
    // Forty unverified devices share "no observation". Calling that a shared
    // identity would bury the one real case under forty invented ones.
    expect(findSharedPublicIps([device('via-a'), device('via-b'), device('via-c', '  ')])).toEqual([])
  })

  test('a device with a reading but no assigned path is ignored', () => {
    expect(findSharedPublicIps([device('', '203.0.113.9'), device('via-b', '203.0.113.9')])).toEqual([])
  })

  test('more than one shared IP is reported in a stable order', () => {
    const shared = findSharedPublicIps([
      device('via-c', '203.0.113.20'),
      device('via-d', '203.0.113.20'),
      device('via-a', '203.0.113.10'),
      device('via-b', '203.0.113.10'),
    ])
    expect(shared.map((s) => s.publicIp)).toEqual(['203.0.113.10', '203.0.113.20'])
  })
})
