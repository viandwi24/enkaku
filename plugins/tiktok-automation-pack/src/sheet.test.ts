import { describe, expect, test } from 'bun:test'
import type { Bounds, UiNode } from '@enkaku/protocol'
import { CHECKMARK_DESC, MAX_SHEET_SCROLL_ATTEMPTS, SHEET_DESC, detectCurrentIndex, readSheetSnapshot } from './sheet'

/**
 * The sheet reader, extracted out of `switch-account.ts` in plan 108 step 108.11 so that
 * `list-accounts` could share it. These tests cover the properties BOTH members now depend on —
 * the ones `switch-account.test.ts` only exercised incidentally, because it was testing a switch.
 *
 * Pure throughout: `readSheetSnapshot` and `detectCurrentIndex` take a `UiNode` and an array, so
 * nothing here needs a device, a `ScriptContext`, or `ENKAKU_TEST_DEVICE=1`.
 */

/** Fills in every field `UiNode` requires so a test only has to spell out what it cares about. */
function mkNode(partial: Partial<UiNode> & { bounds: Bounds }): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: '',
    packageName: '',
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...partial,
  }
}

const box = (left: number, top: number, right: number, bottom: number): Bounds => ({ left, top, right, bottom })

/**
 * One sheet row, shaped exactly like the live dump in plan 86 §4.2: the container carries the
 * username as its `desc` and the shared `id=l_z`, with the username repeated as a child's `text`
 * and — for the signed-in account — a `Tanda centang` marker child.
 */
function mkRow(opts: { username: string; top: number; checkmark?: boolean; badge?: string }): UiNode {
  const children: UiNode[] = [mkNode({ resourceId: 'app:id/mvp', text: opts.username, bounds: box(147, opts.top + 46, 416, opts.top + 81) })]
  if (opts.checkmark) {
    children.push(mkNode({ resourceId: 'app:id/fef', desc: CHECKMARK_DESC, bounds: box(650, opts.top + 42, 692, opts.top + 84) }))
  }
  if (opts.badge) {
    children.push(mkNode({ resourceId: 'app:id/ofu', desc: opts.badge, bounds: box(642, opts.top + 46, 692, opts.top + 79) }))
  }
  // Rows are exactly 126 px tall on the reference device (plan 86 §4.2).
  return mkNode({ resourceId: 'app:id/l_z', desc: opts.username, clickable: true, bounds: box(0, opts.top, 720, opts.top + 126), children })
}

/** The sheet container, with whatever rows a test hands it, plus the title and close button the real one always carries. */
function mkSheet(rows: UiNode[], bounds: Bounds = box(0, 1059, 720, 1556)): UiNode {
  return mkNode({
    resourceId: 'app:id/fsz',
    desc: SHEET_DESC,
    bounds,
    children: [
      mkNode({ resourceId: 'app:id/p9w', text: 'Beralih akun', desc: 'Beralih akun', bounds: box(271, 1085, 450, 1124) }),
      mkNode({ desc: 'Tutup', clickable: true, bounds: box(636, 1066, 706, 1143) }),
      ...rows,
    ],
  })
}

/** Real dumps nest the sheet under several ancestors — wrapping it proves the reader does not depend on the sheet being the tree root. */
function wrapInScreen(...children: UiNode[]): UiNode {
  return mkNode({ bounds: box(0, 0, 720, 1640), children: [mkNode({ bounds: box(0, 70, 720, 1556), children })] })
}

describe('readSheetSnapshot', () => {
  test('reads every row sharing id=l_z, in visual order — the whole point of not using find() here (plan 86 §0.1)', () => {
    const sheet = mkSheet([
      mkRow({ username: 'user2578127329501', top: 1164, checkmark: true }),
      mkRow({ username: 'dewi_purnama280', top: 1290, badge: '9+' }),
      mkRow({ username: 'Tambah akun', top: 1416 }),
    ])
    const snap = readSheetSnapshot(wrapInScreen(sheet))
    expect(snap).not.toBeNull()
    expect(snap?.rows.map((r) => r.desc)).toEqual(['user2578127329501', 'dewi_purnama280'])
    expect(snap?.sheetBounds).toEqual(box(0, 1059, 720, 1556))
  })

  test('"Tambah akun" is dropped here, not filtered by a caller — which is what makes it unreachable by position as well as by name', () => {
    const snap = readSheetSnapshot(wrapInScreen(mkSheet([mkRow({ username: 'alice', top: 1164 }), mkRow({ username: 'Tambah akun', top: 1290 })])))
    expect(snap?.rows.map((r) => r.desc)).toEqual(['alice'])
  })

  test('a row the RecyclerView is still clipping outside the sheet box is not returned — it is not safely tappable even though the tree reports it', () => {
    // `bottom` 1620 sits past the sheet's own 1556: the row is half off the sheet, mid-scroll.
    const clipped = mkRow({ username: 'carol', top: 1494 })
    const snap = readSheetSnapshot(wrapInScreen(mkSheet([mkRow({ username: 'alice', top: 1164 }), mkRow({ username: 'bob', top: 1290 }), clipped])))
    expect(clipped.bounds.bottom).toBeGreaterThan(1556)
    expect(snap?.rows.map((r) => r.desc)).toEqual(['alice', 'bob'])
  })

  test('the checkmark is attributed to the row that contains it, never to whichever row the tree walk reaches first', () => {
    // If the marker were looked up from the tree root — the `find()` trap — every row would read as
    // checked, and the cross-check below would agree with a wrong answer.
    const snap = readSheetSnapshot(
      wrapInScreen(mkSheet([mkRow({ username: 'alice', top: 1164 }), mkRow({ username: 'bob', top: 1290, checkmark: true })])),
    )
    expect(snap?.rows.map((r) => r.hasCheckmark)).toEqual([false, true])
  })

  test('an l_z row that belongs to some other list on the screen is not picked up — the walk starts at the sheet, not at the root', () => {
    const decoy = mkNode({ resourceId: 'app:id/l_z', desc: 'not_an_account', bounds: box(0, 300, 720, 426) })
    const snap = readSheetSnapshot(wrapInScreen(decoy, mkSheet([mkRow({ username: 'alice', top: 1164 })])))
    expect(snap?.rows.map((r) => r.desc)).toEqual(['alice'])
  })

  test('a sheet with no account rows at all reads as an empty list, not as a missing sheet', () => {
    const snap = readSheetSnapshot(wrapInScreen(mkSheet([])))
    expect(snap).not.toBeNull()
    expect(snap?.rows).toEqual([])
  })

  test('returns null when the sheet anchor is not anywhere in the tree', () => {
    expect(readSheetSnapshot(mkNode({ bounds: box(0, 0, 720, 1640) }))).toBeNull()
  })

  test('bounds come from the dumped node, so a caller taps a measured box rather than a screen fraction (plan 86 §0.6)', () => {
    const snap = readSheetSnapshot(wrapInScreen(mkSheet([mkRow({ username: 'alice', top: 1164 })])))
    expect(snap?.rows[0]?.bounds).toEqual(box(0, 1164, 720, 1290))
  })
})

describe('detectCurrentIndex — a cross-check, never the safety mechanism (plan 86 §3.3)', () => {
  const rowsOf = (sheet: UiNode) => readSheetSnapshot(wrapInScreen(sheet))?.rows ?? []

  test('finds the checkmark on row 0, where plan 86 §3.3 says the signed-in account sits', () => {
    expect(detectCurrentIndex(rowsOf(mkSheet([mkRow({ username: 'alice', top: 1164, checkmark: true }), mkRow({ username: 'bob', top: 1290 })])))).toBe(0)
  })

  test('reports the index it actually found when the marker is somewhere else — the disagreement is data, not an exception', () => {
    expect(detectCurrentIndex(rowsOf(mkSheet([mkRow({ username: 'alice', top: 1164 }), mkRow({ username: 'bob', top: 1290, checkmark: true })])))).toBe(1)
  })

  test('reports null — not a throw — when the marker is absent, because it is locale-dependent by construction', () => {
    expect(detectCurrentIndex(rowsOf(mkSheet([mkRow({ username: 'alice', top: 1164 }), mkRow({ username: 'bob', top: 1290 })])))).toBeNull()
  })

  test('an empty row list has no current index', () => {
    expect(detectCurrentIndex([])).toBeNull()
  })
})

describe('the shared scroll bound', () => {
  test('is a small positive number — an unbounded in-sheet scroll would be an untested loop on hardware (plan 86 §4.3, §7.4)', () => {
    expect(MAX_SHEET_SCROLL_ATTEMPTS).toBeGreaterThan(0)
    expect(MAX_SHEET_SCROLL_ATTEMPTS).toBeLessThanOrEqual(10)
  })
})
