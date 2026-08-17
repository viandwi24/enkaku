import { describe, expect, test } from 'bun:test'
import type { Bounds, UiNode } from '@enkaku/protocol'
import { DEFAULT_TARGET, detectCurrentIndex, ownProfileShowsHandle, parseTarget, readSheetSnapshot, resolveTargetRow, storedPositionIsStale } from './switch-account'
import { AccountsSchema, storedPositionOf, type StoredAccounts } from './accounts'

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
 * The switch-account sheet, reproduced from the live dump in plan 86 §4.2 — two real accounts plus
 * "Tambah akun", exactly as it was reconstructed on hardware. `withCheckmark` builds the variant with
 * no "Tanda centang" node at all, for the fallback path (§8: the marker is locale-dependent and
 * absence must warn, never fail).
 */
function buildSheet(opts: { withCheckmark: boolean }): UiNode {
  const row1Children: UiNode[] = [mkNode({ resourceId: 'app:id/mvp', text: 'user2578127329501', bounds: box(147, 1210, 416, 1245) })]
  if (opts.withCheckmark) {
    row1Children.push(mkNode({ resourceId: 'app:id/fef', desc: 'Tanda centang', bounds: box(650, 1206, 692, 1248) }))
  }
  const row1 = mkNode({ resourceId: 'app:id/l_z', desc: 'user2578127329501', clickable: true, bounds: box(0, 1164, 720, 1290), children: row1Children })
  const row2 = mkNode({
    resourceId: 'app:id/l_z',
    desc: 'dewi_purnama280',
    clickable: true,
    bounds: box(0, 1290, 720, 1416),
    children: [
      mkNode({ resourceId: 'app:id/mvp', text: 'dewi_purnama280', bounds: box(147, 1336, 390, 1371) }),
      mkNode({ resourceId: 'app:id/ofu', desc: '9+', bounds: box(642, 1336, 692, 1369) }),
    ],
  })
  const row3 = mkNode({
    resourceId: 'app:id/l_z',
    desc: 'Tambah akun',
    clickable: true,
    bounds: box(0, 1416, 720, 1542),
    children: [mkNode({ resourceId: 'app:id/mvp', text: 'Tambah akun', bounds: box(147, 1462, 325, 1497) })],
  })
  const title = mkNode({ resourceId: 'app:id/p9w', text: 'Beralih akun', desc: 'Beralih akun', bounds: box(271, 1085, 450, 1124) })
  const closeButton = mkNode({ desc: 'Tutup', clickable: true, bounds: box(636, 1066, 706, 1143) })
  return mkNode({
    resourceId: 'app:id/fsz',
    desc: 'Lembar bawah',
    bounds: box(0, 1059, 720, 1556),
    children: [title, closeButton, row1, row2, row3],
  })
}

/** Real dumps nest the sheet under several ancestors — wrapping it here proves `readSheetSnapshot` does not depend on the sheet being the tree root. */
function wrapInScreen(sheet: UiNode): UiNode {
  return mkNode({ bounds: box(0, 0, 720, 1640), children: [mkNode({ bounds: box(0, 70, 720, 1556), children: [sheet] })] })
}

describe('readSheetSnapshot', () => {
  test('drops "Tambah akun" and keeps the real accounts in visual order', () => {
    const snap = readSheetSnapshot(wrapInScreen(buildSheet({ withCheckmark: true })))
    expect(snap).not.toBeNull()
    expect(snap?.rows.map((r) => r.desc)).toEqual(['user2578127329501', 'dewi_purnama280'])
  })

  test('returns null when the sheet anchor is not anywhere in the tree', () => {
    const unrelatedScreen = mkNode({ bounds: box(0, 0, 720, 1640) })
    expect(readSheetSnapshot(unrelatedScreen)).toBeNull()
  })
})

describe('detectCurrentIndex — a cross-check, never the safety mechanism (plan 86 §3.3)', () => {
  test('finds the checkmark on row 0 when it is present', () => {
    const snap = readSheetSnapshot(wrapInScreen(buildSheet({ withCheckmark: true })))
    expect(snap).not.toBeNull()
    expect(detectCurrentIndex(snap?.rows ?? [])).toBe(0)
  })

  test('reports null — not a throw — when the checkmark is absent (locale-dependent marker, §8)', () => {
    const snap = readSheetSnapshot(wrapInScreen(buildSheet({ withCheckmark: false })))
    expect(snap).not.toBeNull()
    expect(detectCurrentIndex(snap?.rows ?? [])).toBeNull()
  })
})

describe('resolveTargetRow', () => {
  const rowsWithCheckmark = readSheetSnapshot(wrapInScreen(buildSheet({ withCheckmark: true })))?.rows ?? []
  const rowsWithoutCheckmark = readSheetSnapshot(wrapInScreen(buildSheet({ withCheckmark: false })))?.rows ?? []

  test('position 2 resolves to the second row', () => {
    expect(resolveTargetRow({ kind: 'position', position: 2 }, rowsWithCheckmark).desc).toBe('dewi_purnama280')
  })

  test('username resolves case-insensitively', () => {
    expect(resolveTargetRow({ kind: 'username', username: 'DEWI_purnama280' }, rowsWithCheckmark).desc).toBe('dewi_purnama280')
  })

  test('targeting the current account by username is refused with E_TARGET_IS_CURRENT, checkmark present or absent', () => {
    for (const rows of [rowsWithCheckmark, rowsWithoutCheckmark]) {
      expect(() => resolveTargetRow({ kind: 'username', username: 'user2578127329501' }, rows)).toThrow()
      try {
        resolveTargetRow({ kind: 'username', username: 'user2578127329501' }, rows)
      } catch (err) {
        expect((err as { code: string }).code).toBe('E_TARGET_IS_CURRENT')
      }
    }
  })

  test('an unknown username is refused with E_NO_SUCH_ACCOUNT, listing the accounts that were seen', () => {
    try {
      resolveTargetRow({ kind: 'username', username: 'nobody_here' }, rowsWithCheckmark)
      throw new Error('expected resolveTargetRow to throw')
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_NO_SUCH_ACCOUNT')
      expect((err as Error).message).toContain('dewi_purnama280')
    }
  })

  test('an out-of-range position is refused with E_NO_SUCH_ACCOUNT', () => {
    try {
      resolveTargetRow({ kind: 'position', position: 5 }, rowsWithCheckmark)
      throw new Error('expected resolveTargetRow to throw')
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_NO_SUCH_ACCOUNT')
    }
  })

  test('"Tambah akun" is unreachable — absent from the row list at all, and unreachable by name', () => {
    expect(rowsWithCheckmark.some((r) => r.desc === 'Tambah akun')).toBe(false)
    try {
      resolveTargetRow({ kind: 'username', username: 'Tambah akun' }, rowsWithCheckmark)
      throw new Error('expected resolveTargetRow to throw')
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_NO_SUCH_ACCOUNT')
    }
  })
})

/**
 * Plan 108 step 108.11 — a username is resolved through the list `list-accounts` stored in this
 * plugin's own device-scoped KV namespace, and falls back to scanning the live sheet whenever that
 * list cannot answer. Four fallback cases, all of which must leave the pre-108 behaviour intact:
 * no list at all, a list in a shape this code no longer understands, a list that does not name the
 * username, and a bare position, which never consults one.
 *
 * All pure: the KV read itself is one `ctx.kv.device.get` call in `readStoredPosition`, and every
 * way it can fail is expressed here as the `null` it hands to `resolveTargetRow`.
 */
describe('resolving a username through the stored account list (plan 108 step 108.11)', () => {
  const rows = readSheetSnapshot(wrapInScreen(buildSheet({ withCheckmark: true })))?.rows ?? []
  const stored: StoredAccounts = AccountsSchema.parse({
    version: 1,
    accounts: [
      { username: 'user2578127329501', position: 1, current: true },
      { username: 'dewi_purnama280', position: 2, current: false },
    ],
    readAt: 1_776_000_000,
  })

  test('the stored list maps a username to its slot, case-insensitively', () => {
    expect(storedPositionOf(stored, 'dewi_purnama280')).toBe(2)
    expect(storedPositionOf(stored, 'DEWI_purnama280')).toBe(2)
    expect(storedPositionOf(stored, '  dewi_purnama280 ')).toBe(2)
  })

  test('a username resolves through the stored slot', () => {
    const position = storedPositionOf(stored, 'dewi_purnama280')
    expect(resolveTargetRow({ kind: 'username', username: 'dewi_purnama280' }, rows, position).desc).toBe('dewi_purnama280')
  })

  test('falls back to the live sheet when there is NO stored list — the pre-108 behaviour, unchanged', () => {
    expect(storedPositionOf(null, 'dewi_purnama280')).toBeNull()
    expect(resolveTargetRow({ kind: 'username', username: 'dewi_purnama280' }, rows, null).desc).toBe('dewi_purnama280')
  })

  /**
   * `ctx.kv.device.get(key, schema)` THROWS on a shape mismatch rather than returning null, and
   * `readStoredPosition` catches that and answers `null`. What is asserted here is the half a unit
   * test can own: the schema really does refuse a stale shape, so that throw genuinely happens.
   */
  test('falls back when the stored shape is stale — the schema refuses it, which is what makes the read throw', () => {
    for (const stale of [
      { version: 2, accounts: [], readAt: 0 },
      { version: 1, accounts: [{ username: 'alice', slot: 1, current: true }], readAt: 0 },
      { version: 1, accounts: [{ username: 'alice', position: 1, current: true }] },
      { accounts: [], readAt: 0 },
      'not an object',
    ]) {
      expect(AccountsSchema.safeParse(stale).success).toBe(false)
    }
    // Whatever the stored value was, the resolution that follows is the one with no list at all.
    expect(resolveTargetRow({ kind: 'username', username: 'dewi_purnama280' }, rows, null).desc).toBe('dewi_purnama280')
  })

  test('falls back when the username is simply absent from the stored list', () => {
    expect(storedPositionOf(stored, 'someone_new')).toBeNull()
    // And the live sheet is then the only authority, so an account the list has never heard of is
    // still switchable the moment it appears on the sheet.
    const withNewcomer = [...rows, { desc: 'someone_new', bounds: rows[0]?.bounds ?? { left: 0, top: 0, right: 0, bottom: 0 }, hasCheckmark: false }]
    expect(resolveTargetRow({ kind: 'username', username: 'someone_new' }, withNewcomer, null).desc).toBe('someone_new')
  })

  /**
   * The load-bearing safety property. A stored slot is a claim about a moment that has already
   * passed: accounts get added, removed, and switched between syncs. If a stale slot could win, the
   * tap would land on whoever occupies it now and the run would then "verify" the wrong account
   * perfectly happily. The username read off the live row is the only ground truth.
   */
  test('a STALE stored slot never wins — the live username decides', () => {
    // Slot 1 is `user2578127329501` on the live sheet, not `dewi_purnama280`.
    expect(resolveTargetRow({ kind: 'username', username: 'dewi_purnama280' }, rows, 1).desc).toBe('dewi_purnama280')
    // A slot past the end of the live sheet is simply ignored.
    expect(resolveTargetRow({ kind: 'username', username: 'dewi_purnama280' }, rows, 9).desc).toBe('dewi_purnama280')
  })

  test('a stale stored slot cannot smuggle the CURRENT account past the position-1 refusal either', () => {
    try {
      resolveTargetRow({ kind: 'username', username: 'user2578127329501' }, rows, 2)
      throw new Error('expected resolveTargetRow to throw')
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_TARGET_IS_CURRENT')
    }
  })

  test('storedPositionIsStale names exactly the cases where the live sheet takes over', () => {
    expect(storedPositionIsStale(rows, 'dewi_purnama280', 2)).toBe(false)
    expect(storedPositionIsStale(rows, 'dewi_purnama280', 1)).toBe(true)
    expect(storedPositionIsStale(rows, 'dewi_purnama280', 9)).toBe(true)
    // No stored slot is not staleness — there was never a claim to be wrong about.
    expect(storedPositionIsStale(rows, 'dewi_purnama280', null)).toBe(false)
  })

  test('a bare position still resolves with no stored list at all — the member\'s original contract', () => {
    expect(parseTarget('2')).toEqual({ kind: 'position', position: 2 })
    expect(resolveTargetRow({ kind: 'position', position: 2 }, rows, null).desc).toBe('dewi_purnama280')
    // And the default target — pressing Run with the field untouched — is unchanged by all of this.
    expect(resolveTargetRow(parseTarget(''), rows, null).desc).toBe('dewi_purnama280')
  })

  test('a position target ignores the stored list entirely, even when one exists', () => {
    // `storedPosition` is only ever read for a username target; passing one alongside a position
    // must not shift which row is indexed.
    expect(resolveTargetRow({ kind: 'position', position: 2 }, rows, 1).desc).toBe('dewi_purnama280')
  })
})

describe('parseTarget — target parser (plan 86 §7.1)', () => {
  test('numeric strings, trimmed, parse as a position', () => {
    expect(parseTarget('2')).toEqual({ kind: 'position', position: 2 })
    expect(parseTarget('  3 ')).toEqual({ kind: 'position', position: 3 })
  })

  test('anything non-numeric parses as a username', () => {
    expect(parseTarget('dewi_purnama280')).toEqual({ kind: 'username', username: 'dewi_purnama280' })
  })

  test('position 1 is rejected with E_TARGET_IS_CURRENT — it is always the current account', () => {
    try {
      parseTarget('1')
      throw new Error('expected parseTarget to throw')
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_TARGET_IS_CURRENT')
    }
  })

  /**
   * The run form submits `""` for a field nobody touched, so this is the case a schema `.default()`
   * cannot reach on its own — and it is exactly the case the default exists for. Pressing Run
   * without typing anything must switch to position 2, not die on a validation error.
   */
  test('an empty or blank target falls back to the default position, it does not throw', () => {
    for (const raw of ['', '   ']) {
      expect(parseTarget(raw)).toEqual({ kind: 'position', position: 2 })
    }
    expect(parseTarget(DEFAULT_TARGET)).toEqual({ kind: 'position', position: 2 })
  })
})

/**
 * `ownProfileShowsHandle` — the plan 86 hardware finding written up in its own doc comment: a
 * bare-text match against the whole tree (the pre-fix behaviour) depends on a display name being
 * set, and reports success on a still-open sheet just because the sheet lists every username too.
 */
describe('ownProfileShowsHandle — own-profile verification (plan 86 item 3)', () => {
  /** A profile screen with BOTH a display name (`sd0`-shaped) and the "@"-prefixed handle (`s_y`-shaped) — mirrors the live `dewi_purnama280` dump. */
  function profileWithDisplayName(username: string): UiNode {
    return mkNode({
      bounds: box(0, 0, 720, 1640),
      children: [
        mkNode({ resourceId: 'app:id/sd0', text: username, bounds: box(28, 172, 503, 239) }),
        mkNode({ resourceId: 'app:id/s_y', text: `@${username}`, bounds: box(28, 243, 239, 269) }),
      ],
    })
  }

  /** A profile screen with NO display name set — only the "@"-prefixed handle exists anywhere in the tree, mirroring the live `user2578127329501` dump ("+ Tambah nama" shown instead of a display name). */
  function profileWithoutDisplayName(username: string): UiNode {
    return mkNode({
      bounds: box(0, 0, 720, 1640),
      children: [mkNode({ resourceId: 'app:id/s_y', text: `@${username}`, bounds: box(28, 243, 239, 269) })],
    })
  }

  test('finds the handle when a display name is also set', () => {
    expect(ownProfileShowsHandle(profileWithDisplayName('dewi_purnama280'), 'dewi_purnama280')).toBe(true)
  })

  test('finds the handle when NO display name is set — the bare username appears nowhere in the tree', () => {
    // This is the exact case that produced a false E_SWITCH_NOT_VERIFIED on hardware: matching the
    // bare (non-"@") username against the whole tree finds nothing here, because the bare string
    // genuinely is not present anywhere — only "@user2578127329501" is.
    expect(ownProfileShowsHandle(profileWithoutDisplayName('user2578127329501'), 'user2578127329501')).toBe(true)
  })

  test('matches case-insensitively', () => {
    expect(ownProfileShowsHandle(profileWithDisplayName('dewi_purnama280'), 'DEWI_purnama280')).toBe(true)
  })

  test('refuses when the handle is not on screen at all', () => {
    expect(ownProfileShowsHandle(profileWithDisplayName('dewi_purnama280'), 'someone_else')).toBe(false)
  })

  test('refuses when the switch-account sheet is still open, even if the handle text is present', () => {
    // The sheet's own rows carry the target's username verbatim (plan §4.2) — present via `desc`,
    // not `text`, so it would never satisfy the handle check on its own, but the sheet being open at
    // all must independently fail verification: a still-open sheet is not a landed switch.
    const stillOpen = mkNode({
      bounds: box(0, 0, 720, 1640),
      children: [
        profileWithDisplayName('dewi_purnama280'),
        mkNode({ resourceId: 'app:id/fsz', desc: 'Lembar bawah', bounds: box(0, 1059, 720, 1556) }),
      ],
    })
    expect(ownProfileShowsHandle(stillOpen, 'dewi_purnama280')).toBe(false)
  })
})
