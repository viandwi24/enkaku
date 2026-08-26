import { describe, expect, test } from 'bun:test'
import { buildPairings, type PairingRow } from './bulk-builder'
import type { FleetDeviceRow, Path } from './api'

/**
 * Plan 131 §5 step 131.1 — `buildPairings`, pure and tested first, before
 * either call site (Assignments, group editor) exists. No DOM harness in
 * this pack (`bits.test.ts` records the same limitation for `pathOptions`),
 * so the pairing logic is proved here exactly as it is; the components only
 * ever render what this function returns.
 */

function makeDevice(number: number | null, opts: { deviceId?: string; assignedPathId?: string } = {}): FleetDeviceRow {
  const deviceId = opts.deviceId ?? `dev-${number}`
  return {
    deviceId,
    stableId: `stable-${deviceId}`,
    label: `Device ${number ?? '?'}`,
    number,
    lan: { deviceId, stableId: `stable-${deviceId}`, label: `Device ${number ?? '?'}`, state: 'resolved', lanIp: '192.168.10.1', lanIpSource: 'lease', leaseKind: 'static' },
    assignment: { pathId: opts.assignedPathId ?? '', groupId: '', lanIp: '', lanIpSource: '', leaseKind: '', since: 0 },
  }
}

function makePath(id: string): Path {
  return { id, table: id, gateway: null, hasDefaultRoute: true }
}

const rowFor = (rows: PairingRow[], deviceNumber: number): PairingRow => {
  const row = rows.find((r) => r.deviceNumber === deviceNumber)
  if (!row) throw new Error(`no row for device number ${deviceNumber}`)
  return row
}

describe('buildPairings', () => {
  test('an exact-length range pairs 1:1, in order', () => {
    const devices = [1, 2, 3].map((n) => makeDevice(n))
    const paths = ['via-a', 'via-b', 'via-c'].map(makePath)
    const rows = buildPairings({ fromNumber: 1, toNumber: 3, pathStartIndex: 0, overflow: 'stop' }, devices, paths)
    expect(rows).toEqual([
      { deviceNumber: 1, deviceId: 'dev-1', pathId: 'via-a', pathLabel: 'via-a', note: 'ok' },
      { deviceNumber: 2, deviceId: 'dev-2', pathId: 'via-b', pathLabel: 'via-b', note: 'ok' },
      { deviceNumber: 3, deviceId: 'dev-3', pathId: 'via-c', pathLabel: 'via-c', note: 'ok' },
    ])
  })

  test('a starting index offsets which path the first device gets', () => {
    const devices = [1, 2].map((n) => makeDevice(n))
    const paths = ['via-a', 'via-b', 'via-c'].map(makePath)
    const rows = buildPairings({ fromNumber: 1, toNumber: 2, pathStartIndex: 1, overflow: 'stop' }, devices, paths)
    expect(rows.map((r) => r.pathId)).toEqual(['via-b', 'via-c'])
  })

  test('overflow: stop leaves the trailing devices with no-path, rather than reusing a path', () => {
    const devices = [1, 2, 3, 4].map((n) => makeDevice(n))
    const paths = ['via-a', 'via-b'].map(makePath)
    const rows = buildPairings({ fromNumber: 1, toNumber: 4, pathStartIndex: 0, overflow: 'stop' }, devices, paths)
    expect(rows.map((r) => r.pathId)).toEqual(['via-a', 'via-b', null, null])
    expect(rows.map((r) => r.note)).toEqual(['ok', 'ok', 'no-path', 'no-path'])
  })

  test('overflow: wrap round-robins back through the path list instead of stopping', () => {
    const devices = [1, 2, 3, 4].map((n) => makeDevice(n))
    const paths = ['via-a', 'via-b'].map(makePath)
    const rows = buildPairings({ fromNumber: 1, toNumber: 4, pathStartIndex: 0, overflow: 'wrap' }, devices, paths)
    expect(rows.map((r) => r.pathId)).toEqual(['via-a', 'via-b', 'via-a', 'via-b'])
    expect(rows.map((r) => r.note)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  test('a missing device number is no-such-device, and is never dropped from the result', () => {
    // Number 2 has no enrolled device.
    const devices = [makeDevice(1), makeDevice(3)]
    const paths = ['via-a', 'via-b', 'via-c'].map(makePath)
    const rows = buildPairings({ fromNumber: 1, toNumber: 3, pathStartIndex: 0, overflow: 'stop' }, devices, paths)
    expect(rows).toHaveLength(3)
    const missing = rowFor(rows, 2)
    expect(missing.deviceId).toBeNull()
    expect(missing.note).toBe('no-such-device')
    // The path it WOULD have gotten is still shown — the anomaly is
    // represented, not hidden by blanking every field.
    expect(missing.pathId).toBe('via-b')
  })

  test('an already-assigned device is marked, not skipped — the row still names its new target path', () => {
    const devices = [makeDevice(1, { assignedPathId: 'via-old' }), makeDevice(2)]
    const paths = ['via-a', 'via-b'].map(makePath)
    const rows = buildPairings({ fromNumber: 1, toNumber: 2, pathStartIndex: 0, overflow: 'stop' }, devices, paths)
    const assigned = rowFor(rows, 1)
    expect(assigned.note).toBe('already-assigned')
    expect(assigned.deviceId).toBe('dev-1')
    expect(assigned.pathId).toBe('via-a')
    expect(rowFor(rows, 2).note).toBe('ok')
  })

  test('an inverted range is rejected, not silently swapped', () => {
    expect(() => buildPairings({ fromNumber: 5, toNumber: 1, pathStartIndex: 0, overflow: 'stop' }, [], [])).toThrow()
  })

  test('a single-device range (fromNumber === toNumber) produces exactly one row', () => {
    const rows = buildPairings({ fromNumber: 7, toNumber: 7, pathStartIndex: 0, overflow: 'stop' }, [makeDevice(7)], [makePath('via-a')])
    expect(rows).toEqual([{ deviceNumber: 7, deviceId: 'dev-7', pathId: 'via-a', pathLabel: 'via-a', note: 'ok' }])
  })

  test('no paths at all: every row is no-path regardless of overflow mode', () => {
    const devices = [1, 2].map((n) => makeDevice(n))
    expect(buildPairings({ fromNumber: 1, toNumber: 2, pathStartIndex: 0, overflow: 'stop' }, devices, []).map((r) => r.note)).toEqual(['no-path', 'no-path'])
    expect(buildPairings({ fromNumber: 1, toNumber: 2, pathStartIndex: 0, overflow: 'wrap' }, devices, []).map((r) => r.note)).toEqual(['no-path', 'no-path'])
  })
})
