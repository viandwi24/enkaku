import { describe, expect, mock, test } from 'bun:test'
import type { FleetDeviceRow, Path } from './api'
import type { PairingRow } from './bulk-builder'

/**
 * Plan 131 §5 step 131.3 — the group editor's own half of the bulk builder.
 * `buildPairings` (131.1, `bulk-builder.tsx`) is already proved pure and
 * tested on its own; what is new here is `groups.tsx`'s
 * `planBulkGroupEntries`, which maps a `PairingRow[]` onto the GROUP ENTRY
 * shape (`{ deviceId, lanIp, pathId }`) this screen actually writes, exactly
 * the way `EditGroupDialog`'s existing `addEntry` builds one today (§3.1's
 * own instruction — no second way to construct an entry).
 *
 * No DOM harness in this pack (`bits.test.ts` records the same limitation),
 * and `groups.tsx` additionally imports `@enkaku/host`
 * (`DevicePickerDialog`, plan 216 §4.10) — a module that is never published
 * and only ever resolves inside Studio's own bundle via an import map (see
 * `src/enkaku-host.d.ts`'s header). `mock.module` stands in for it here so
 * `groups.tsx` can be imported at all; the module is otherwise untouched —
 * this proves the pure mapping function, nothing about the device picker.
 *
 * A STATIC `import './groups'` at the top of this file would resolve (and
 * fail on) `@enkaku/host` before `mock.module` below ever runs — ES module
 * graphs are resolved before any module's top-level code executes. Verified
 * directly (a throwaway repro against a nonexistent package): a static
 * import fails with "Cannot find module" regardless of where `mock.module`
 * is called, while a DYNAMIC `await import(...)` issued AFTER `mock.module`
 * succeeds. So every test below imports `./groups` dynamically.
 */

mock.module('@enkaku/host', () => ({
  DevicePickerDialog: () => null,
}))

const loadGroups = () => import('./groups')

function makeDevice(deviceId: string, opts: { number?: number | null; resolvedLanIp?: string | null } = {}): FleetDeviceRow {
  const number = opts.number ?? null
  const lan =
    opts.resolvedLanIp === null
      ? ({ deviceId, stableId: `stable-${deviceId}`, label: deviceId, state: 'needs-address' as const })
      : ({ deviceId, stableId: `stable-${deviceId}`, label: deviceId, state: 'resolved' as const, lanIp: opts.resolvedLanIp ?? '192.168.10.5', lanIpSource: 'lease', leaseKind: 'static' })
  return {
    deviceId,
    stableId: `stable-${deviceId}`,
    label: deviceId,
    number,
    lan,
    assignment: { pathId: '', groupId: '', lanIp: '', lanIpSource: '', leaseKind: '', since: 0 },
  }
}

function makePath(id: string): Path {
  return { id, table: id, gateway: null, hasDefaultRoute: true }
}

function okRow(deviceNumber: number, deviceId: string, pathId: string, pathLabel: string): PairingRow {
  return { deviceNumber, deviceId, pathId, pathLabel, note: 'ok' }
}

describe('planBulkGroupEntries', () => {
  test('an ok row with a resolved LAN address becomes an entry identical in shape to addEntry\'s own', async () => {
    const { planBulkGroupEntries } = await loadGroups()
    const device = makeDevice('dev-1', { number: 1, resolvedLanIp: '192.168.10.9' })
    const rows: PairingRow[] = [okRow(1, 'dev-1', 'via-a', 'via-a')]
    const plans = planBulkGroupEntries(rows, [device], new Set())
    expect(plans).toHaveLength(1)
    expect(plans[0]?.alreadyInGroup).toBe(false)
    // Exactly the three fields `EntryDraft`/`addEntry` produce — no more, no
    // fewer, and `lanIp` taken from the device's resolved address, matching
    // `addEntry`'s own `device.lan.state === 'resolved' ? device.lan.lanIp : EMPTY_LAN`.
    expect(plans[0]?.entry).toEqual({ deviceId: 'dev-1', lanIp: '192.168.10.9', pathId: 'via-a' })
  })

  test('a device with no resolved LAN address falls back to EMPTY_LAN, exactly like addEntry', async () => {
    const { planBulkGroupEntries } = await loadGroups()
    const device = makeDevice('dev-2', { number: 2, resolvedLanIp: null })
    const rows: PairingRow[] = [okRow(2, 'dev-2', 'via-a', 'via-a')]
    const plans = planBulkGroupEntries(rows, [device], new Set())
    expect(plans[0]?.entry).toEqual({ deviceId: 'dev-2', lanIp: '', pathId: 'via-a' })
  })

  test('no-such-device never becomes an entry', async () => {
    const { planBulkGroupEntries } = await loadGroups()
    const rows: PairingRow[] = [{ deviceNumber: 9, deviceId: null, pathId: 'via-a', pathLabel: 'via-a', note: 'no-such-device' }]
    const plans = planBulkGroupEntries(rows, [], new Set())
    expect(plans[0]?.entry).toBeNull()
    expect(plans[0]?.alreadyInGroup).toBe(false)
  })

  test('no-path never becomes an entry', async () => {
    const { planBulkGroupEntries } = await loadGroups()
    const device = makeDevice('dev-3', { number: 3, resolvedLanIp: '192.168.10.3' })
    const rows: PairingRow[] = [{ deviceNumber: 3, deviceId: 'dev-3', pathId: null, pathLabel: null, note: 'no-path' }]
    const plans = planBulkGroupEntries(rows, [device], new Set())
    expect(plans[0]?.entry).toBeNull()
  })

  test('already-assigned (the Assignments-tab note) is NOT a reason to skip here — the group and the assignment are unrelated records', async () => {
    const { planBulkGroupEntries } = await loadGroups()
    const device = makeDevice('dev-4', { number: 4, resolvedLanIp: '192.168.10.4' })
    const rows: PairingRow[] = [{ deviceNumber: 4, deviceId: 'dev-4', pathId: 'via-b', pathLabel: 'via-b', note: 'already-assigned' }]
    const plans = planBulkGroupEntries(rows, [device], new Set())
    expect(plans[0]?.entry).toEqual({ deviceId: 'dev-4', lanIp: '192.168.10.4', pathId: 'via-b' })
    expect(plans[0]?.alreadyInGroup).toBe(false)
  })

  test('a device already in THIS group is never turned into a second entry, even when buildPairings itself said "ok"', async () => {
    const { planBulkGroupEntries } = await loadGroups()
    const device = makeDevice('dev-5', { number: 5, resolvedLanIp: '192.168.10.5' })
    const rows: PairingRow[] = [okRow(5, 'dev-5', 'via-a', 'via-a')]
    // Break it: dev-5 is already in the group's own entries.
    const plansBlocked = planBulkGroupEntries(rows, [device], new Set(['dev-5']))
    expect(plansBlocked[0]?.alreadyInGroup).toBe(true)
    expect(plansBlocked[0]?.entry).toBeNull()
    // Restore: with an empty usedDeviceIds set, the same row becomes writable again.
    const plansAllowed = planBulkGroupEntries(rows, [device], new Set())
    expect(plansAllowed[0]?.alreadyInGroup).toBe(false)
    expect(plansAllowed[0]?.entry).toEqual({ deviceId: 'dev-5', lanIp: '192.168.10.5', pathId: 'via-a' })
  })

  test('every anomalous row is still present in the output — never dropped, only entry: null', async () => {
    const { planBulkGroupEntries } = await loadGroups()
    const rows: PairingRow[] = [
      okRow(1, 'dev-1', 'via-a', 'via-a'),
      { deviceNumber: 2, deviceId: null, pathId: 'via-b', pathLabel: 'via-b', note: 'no-such-device' },
      { deviceNumber: 3, deviceId: 'dev-3', pathId: null, pathLabel: null, note: 'no-path' },
    ]
    const devices = [makeDevice('dev-1', { number: 1, resolvedLanIp: '192.168.10.1' }), makeDevice('dev-3', { number: 3, resolvedLanIp: '192.168.10.3' })]
    const plans = planBulkGroupEntries(rows, devices, new Set())
    expect(plans).toHaveLength(3)
    expect(plans.filter((p) => p.entry !== null)).toHaveLength(1)
  })
})
