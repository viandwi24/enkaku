import { describe, expect, test } from 'bun:test'
import { isFirstLoad, pathOptions, STALE_PATH_SUFFIX, UNASSIGNED_PATH } from './bits'
import { describeDownReason } from './paths'

/**
 * Plan 124 step 124.7 — the egress-path picker's option list.
 *
 * Both path pickers became `Combobox`es in this step (the Assignments table's,
 * once per device row, and the group editor's, once per group entry), and
 * both build their options here so the two cannot disagree. What is proved
 * below is exactly the pair of behaviours the conversion was required not to
 * regress: `Unassigned` stays a real, selectable option where it was one, and
 * a device noted against a path the router no longer lists keeps a visible,
 * named row instead of silently reading as unassigned.
 *
 * This is a plain function test with no DOM — this pack has no browser
 * harness (`plugins/proxy-manager/src/ui/parts/catalogue.test.ts` records the
 * same limitation for the same reason), and the option list is where the
 * rules actually live; the components only render what it returns.
 */

const PATHS = [
  { id: 'via-modem1', table: 'via-modem1' },
  { id: 'via-modem2', table: 'via-modem2' },
]

describe('pathOptions', () => {
  test('lists the router\'s paths in order, labelled by their routing table', () => {
    expect(pathOptions({ paths: PATHS, selectedPathId: 'via-modem1' })).toEqual([
      { value: 'via-modem1', label: 'via-modem1' },
      { value: 'via-modem2', label: 'via-modem2' },
    ])
  })

  test('`Unassigned` is offered only where the caller asks for it', () => {
    // The Assignments table: a device may legitimately have no path, and
    // clearing one is an ordinary thing to do.
    const withUnassigned = pathOptions({ paths: PATHS, selectedPathId: '', unassigned: true })
    expect(withUnassigned[0]).toEqual({ value: UNASSIGNED_PATH, label: 'Unassigned' })
    // The group editor: `save()` refuses an entry with no path, so an option
    // that cannot survive saving is never shown.
    expect(pathOptions({ paths: PATHS, selectedPathId: '' }).some((o) => o.value === UNASSIGNED_PATH)).toBe(false)
  })

  test('a noted path the router no longer lists stays visible, named as gone', () => {
    const options = pathOptions({ paths: PATHS, selectedPathId: 'via-modem9', unassigned: true })
    const stale = options.find((o) => o.value === 'via-modem9')
    expect(stale?.label).toBe(`via-modem9${STALE_PATH_SUFFIX}`)
    // The whole point: it must not be absent, because an absent option leaves
    // the picker reading "Unassigned" — a different and untrue statement about
    // a note that is still there and will still be planned against.
    expect(options.map((o) => o.value)).toEqual([UNASSIGNED_PATH, 'via-modem1', 'via-modem2', 'via-modem9'])
  })

  test('no stale row for a path that exists, for an empty selection, or for the unassigned sentinel', () => {
    expect(pathOptions({ paths: PATHS, selectedPathId: 'via-modem2' })).toHaveLength(2)
    expect(pathOptions({ paths: PATHS, selectedPathId: '' })).toHaveLength(2)
    // `UNASSIGNED_PATH` is this screen's own sentinel, never a router path —
    // annotating it as "no longer on the router" would be nonsense.
    expect(pathOptions({ paths: PATHS, selectedPathId: UNASSIGNED_PATH, unassigned: true }).map((o) => o.value)).toEqual([UNASSIGNED_PATH, 'via-modem1', 'via-modem2'])
  })

  test('a router with no paths at all still offers Unassigned, and still keeps a stale note visible', () => {
    expect(pathOptions({ paths: [], selectedPathId: 'via-modem1', unassigned: true }).map((o) => o.label)).toEqual(['Unassigned', `via-modem1${STALE_PATH_SUFFIX}`])
  })
})

/**
 * Plan 131 §3.3, §4.3, step 131.5 — the guard that used to unmount the whole
 * Assignments table on every write (`assignments.tsx:365`, "the owner's own
 * diagnosis was right"). No DOM harness in this pack, so what is proved here
 * is the predicate `assignments.tsx` renders its early return from, not a
 * rendered tree — the same trade `pathOptions` above already makes.
 */
describe('isFirstLoad', () => {
  test('true on the first load, before any data has ever arrived', () => {
    expect(isFirstLoad(true, null)).toBe(true)
  })

  test('false once data exists, even while a revalidation is in flight — this is the fix', () => {
    // This is exactly `reload()`'s state after a write: `loading` flips back
    // to `true`, but the previous fleet is still sitting in `data`. The old
    // code (`if (loading) return <LoadingRows />`) could not see the
    // difference and unmounted the table anyway.
    expect(isFirstLoad(true, { devices: [] })).toBe(false)
  })

  test('false once loading has finished, regardless of data', () => {
    expect(isFirstLoad(false, null)).toBe(false)
    expect(isFirstLoad(false, { devices: [] })).toBe(false)
  })
})

/**
 * Plan 133 §3.3 — the sentence a down path shows beside its red chip.
 *
 * The farm session that opened plan 133: two Orbits were left on the
 * factory-default `192.168.8.0/24`, so the router held no address in the
 * subnet its route pointed at. Both paths read "Down", identically to a modem
 * that was simply switched off, and telling them apart took a router CLI
 * session. The first case below is the sentence that would have ended it.
 */
describe('describeDownReason (plan 133 §3.3)', () => {
  test('no-route-to-gateway names the subnet the router is missing, and points at the router not the modem', () => {
    const s = describeDownReason('no-route-to-gateway', '192.168.125.1')
    expect(s).toContain('192.168.125.0/24')
    expect(s).toMatch(/VLAN and DHCP client on the router/i)
    expect(s).toMatch(/modem itself may be fine/i)
  })

  test('gateway-unreachable names the gateway and blames the modem, which is the opposite diagnosis', () => {
    const s = describeDownReason('gateway-unreachable', '192.168.126.1')
    expect(s).toContain('192.168.126.1')
    expect(s).toMatch(/off, unplugged, or not responding/i)
  })

  test('no-default-route says the table itself is empty', () => {
    expect(describeDownReason('no-default-route', null)).toMatch(/no default route/i)
  })

  test('an unrecognised reason from a newer core yields null — the cell falls back, never blanks or throws', () => {
    expect(describeDownReason('something-invented-later', '192.168.1.1')).toBeNull()
    expect(describeDownReason(undefined, '192.168.1.1')).toBeNull()
  })

  test('a gateway that is not a dotted quad is passed through rather than mangled into a fake subnet', () => {
    expect(describeDownReason('no-route-to-gateway', 'fe80::1')).toContain('fe80::1')
  })
})
