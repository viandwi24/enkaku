import { describe, expect, test } from 'bun:test'
import type { Bounds, UiNode } from '@enkaku/protocol'
import {
  ALREADY_FOLLOWING_LABEL,
  NOT_FOLLOWING_LABEL,
  findProfileFollowButton,
  isAlreadyFollowing,
  matchRows,
  parseFollowerCount,
  readResultRows,
  type SearchResultRow,
} from './search-follow'

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
 * One Pengguna results row, reproduced from the live dump in plan 86 §4.5 — `tv_username` holds the
 * DISPLAY name (misleadingly), `zjo` the actual handle, `tcj` the inline follow button, `zro` the
 * combined follower/like stats string.
 */
function mkRow(opts: { handle: string; displayName?: string; buttonText?: string; stats?: string; top: number }): UiNode {
  const bottom = opts.top + 129
  const children: UiNode[] = [
    mkNode({ resourceId: 'app:id/tv_username', text: opts.displayName ?? opts.handle, bounds: box(150, opts.top + 20, 346, opts.top + 53) }),
    mkNode({ resourceId: 'app:id/zjo', text: opts.handle, bounds: box(150, opts.top + 53, 517, opts.top + 81) }),
    mkNode({ resourceId: 'app:id/zro', text: opts.stats ?? '147,3 rb pengikut · 1,4 jt suka', bounds: box(150, opts.top + 81, 452, opts.top + 109) }),
    mkNode({ resourceId: 'app:id/tcj', text: opts.buttonText ?? NOT_FOLLOWING_LABEL, bounds: box(538, opts.top + 35, 692, opts.top + 91) }),
  ]
  return mkNode({ resourceId: 'app:id/ugl', bounds: box(0, opts.top, 720, bottom), children })
}

function mkResultsScreen(rows: UiNode[]): UiNode {
  return mkNode({
    bounds: box(0, 0, 720, 1640),
    children: [mkNode({ resourceId: 'app:id/mzw', bounds: box(0, 231, 720, 1556), children: rows })],
  })
}

describe('readResultRows — the repeated-id case of §0.1, applied to Pengguna results', () => {
  test('enumerates every row via dump-and-walk, in visual order, never re-`find()`-ing the shared id', () => {
    const rows = readResultRows(
      mkResultsScreen([mkRow({ handle: 'rajafxgold', top: 245 }), mkRow({ handle: 'scalpingxauu', top: 374, displayName: 'Scalping XAUUSD' })]),
    )
    expect(rows.map((r) => r.handle)).toEqual(['rajafxgold', 'scalpingxauu'])
  })

  test('the display-name id ("tv_username") is read separately from the handle id ("zjo") — it is NOT the handle, despite the name', () => {
    const rows = readResultRows(mkResultsScreen([mkRow({ handle: 'rajafxgold', displayName: '𝓡𝓪𝓳𝓪 𝔉𝔵', top: 245 })]))
    expect(rows[0]?.handle).toBe('rajafxgold')
    expect(rows[0]?.displayName).toBe('𝓡𝓪𝓳𝓪 𝔉𝔵')
  })

  test('reads the row inline button text and the stats string', () => {
    const rows = readResultRows(mkResultsScreen([mkRow({ handle: 'rajafxgold', top: 245, buttonText: 'Ikuti', stats: '9 pengikut · 1 suka' })]))
    expect(rows[0]?.buttonText).toBe('Ikuti')
    expect(rows[0]?.stats).toBe('9 pengikut · 1 suka')
  })
})

describe('matchRows — exact, case-insensitive handle match, and refusal on ambiguity (plan §3.4)', () => {
  const rows: SearchResultRow[] = [
    { handle: 'rajafxgold', displayName: 'Raja FX', buttonText: 'Ikuti', stats: '', bounds: box(0, 0, 1, 1) },
    { handle: 'scalpingxauu', displayName: 'rajafxgold', buttonText: 'Ikuti', stats: '', bounds: box(0, 0, 1, 1) },
  ]

  test('matches the handle case-insensitively', () => {
    const result = matchRows(rows, 'RAJAFXgold', false)
    expect(result.kind).toBe('single')
    expect(result.kind === 'single' && result.row.handle).toBe('rajafxgold')
  })

  test('does not match on display name when matchDisplayName is false (the default)', () => {
    // Row 2's DISPLAY NAME happens to equal row 1's handle — without the opt-in this must resolve
    // to row 1 only, never treat row 2 as a candidate.
    const result = matchRows(rows, 'rajafxgold', false)
    expect(result.kind).toBe('single')
    expect(result.kind === 'single' && result.row.handle).toBe('rajafxgold')
  })

  test('matchDisplayName widens the SAME pass rather than acting as a fallback — a handle hit plus a display-name coincidence is ambiguous, not a silent handle win', () => {
    const result = matchRows(rows, 'rajafxgold', true)
    expect(result.kind).toBe('ambiguous')
    expect(result.kind === 'ambiguous' && result.rows.map((r) => r.handle)).toEqual(['rajafxgold', 'scalpingxauu'])
  })

  test('no match at all returns "none", not a throw — the caller decides whether to scroll and retry', () => {
    expect(matchRows(rows, 'nobody_here', false).kind).toBe('none')
  })

  test('two rows sharing the exact same handle are refused as ambiguous', () => {
    const dup: SearchResultRow[] = [
      { handle: 'sameuser', displayName: 'a', buttonText: 'Ikuti', stats: '', bounds: box(0, 0, 1, 1) },
      { handle: 'sameuser', displayName: 'b', buttonText: 'Ikuti', stats: '', bounds: box(0, 0, 1, 1) },
    ]
    expect(matchRows(dup, 'sameuser', false).kind).toBe('ambiguous')
  })
})

describe('parseFollowerCount — Indonesian locale formatting (rb = ribu, jt = juta)', () => {
  test('parses a thousands ("rb") value with a comma decimal separator', () => {
    expect(parseFollowerCount('147,3 rb pengikut · 1,4 jt suka')).toBe(147_300)
  })

  test('parses a plain integer with no unit', () => {
    expect(parseFollowerCount('9 pengikut · 1 suka')).toBe(9)
  })

  test('parses a millions ("jt") value', () => {
    expect(parseFollowerCount('2,1 jt pengikut · 500 rb suka')).toBe(2_100_000)
  })

  test('returns null for a string that does not match the observed shape, rather than guessing', () => {
    expect(parseFollowerCount('')).toBeNull()
    expect(parseFollowerCount('no numbers here')).toBeNull()
  })
})

describe('isAlreadyFollowing / follow-state labels', () => {
  test('"Ikuti" is not-following; "Mengikuti" is already-following', () => {
    expect(isAlreadyFollowing(NOT_FOLLOWING_LABEL)).toBe(false)
    expect(isAlreadyFollowing(ALREADY_FOLLOWING_LABEL)).toBe(true)
  })

  test('trims surrounding whitespace before comparing', () => {
    expect(isAlreadyFollowing(`  ${ALREADY_FOLLOWING_LABEL}  `)).toBe(true)
  })

  test('an unrecognised label is treated as not-already-following, never as a crash', () => {
    expect(isAlreadyFollowing('')).toBe(false)
    expect(isAlreadyFollowing('???')).toBe(false)
  })
})

/**
 * `findProfileFollowButton` — the profile-screen "Mengikuti" stat-label trap (plan §4.5). On a
 * profile screen, "Mengikuti" is ALSO the stats-row label meaning "accounts this profile follows".
 * A bare `find({text:'Mengikuti'})`/depth-first walk would answer with whichever node it reaches
 * first — and the stats row sits ABOVE the follow button in document order, so it would win.
 */
describe('findProfileFollowButton — scoped, never a screen-wide text match (plan §4.5)', () => {
  function statsLabel(text: string, top: number): UiNode {
    return mkNode({ resourceId: 'app:id/sdn', text, bounds: box(28, top, 232, top + 33) })
  }

  test('picks the button by id even when a stats label earlier in document order also reads "Mengikuti"', () => {
    const stats = statsLabel('Mengikuti', 286) // "3 accounts this profile follows" — NOT the follow button
    const button = mkNode({ resourceId: 'app:id/fds', text: 'Mengikuti', bounds: box(28, 371, 524, 441), clickable: false })
    const profile = mkNode({ bounds: box(0, 0, 720, 1640), children: [stats, button] }) // stats BEFORE button — the trap
    const found = findProfileFollowButton(profile)
    expect(found?.bounds).toEqual(box(28, 371, 524, 441))
  })

  test('not-following state: picks the button reading "Ikuti", ignoring the stats label nearby', () => {
    const stats = statsLabel('Mengikuti', 286)
    const button = mkNode({ resourceId: 'app:id/fds', text: 'Ikuti', bounds: box(28, 371, 524, 441) })
    const profile = mkNode({ bounds: box(0, 0, 720, 1640), children: [stats, button] })
    expect(findProfileFollowButton(profile)?.text).toBe('Ikuti')
  })

  test('structural bounds fallback: no "fds" id present, but the button is still found by its vertical band, never the stats label', () => {
    // Same text, same document order (stats first) — but this time the button carries no id at all,
    // exercising the fallback rather than the id lookup.
    const stats = statsLabel('Mengikuti', 286)
    const button = mkNode({ resourceId: '', text: 'Mengikuti', bounds: box(28, 371, 524, 441) })
    const profile = mkNode({ bounds: box(0, 0, 720, 1640), children: [stats, button] })
    const found = findProfileFollowButton(profile)
    expect(found?.bounds).toEqual(box(28, 371, 524, 441))
  })

  test('the fallback does not mistake the stats label for the button even when it is the ONLY "Mengikuti" node reachable by bounds', () => {
    // Regression guard: if the bounds window were wrong (e.g. wide enough to include the stats row),
    // this would wrongly return the stats label. It must return null instead — no button exists here.
    const stats = statsLabel('Mengikuti', 286)
    const profile = mkNode({ bounds: box(0, 0, 720, 1640), children: [stats] })
    expect(findProfileFollowButton(profile)).toBeNull()
  })

  test('returns null when nothing matches at all', () => {
    expect(findProfileFollowButton(mkNode({ bounds: box(0, 0, 720, 1640) }))).toBeNull()
  })

  /**
   * Hardware correction to plan §4.5 (probe job `bc6170ec-9caf-4a1c-8874-bb628bd35c3f`, 2026-08-09):
   * `search-follow`'s own human-shaping sequence scrolls the profile grid BEFORE tapping follow, and
   * that scroll collapses the header into a sticky top toolbar where the follow button reappears with
   * NO resourceId, at `top` ≈ 87 — a band the plan never documented. The first hardware run of
   * `search-follow` failed with `E_FOLLOW_BUTTON_NOT_FOUND` because of exactly this gap.
   */
  describe('the collapsed sticky header (hardware correction, not in plan §4.5)', () => {
    test('finds the button in the collapsed-header band when the expanded header is gone entirely', () => {
      // On hardware, scrolling recycles the WHOLE expanded-header section out of the tree — the stats
      // row is absent too, not just off-screen — so only the collapsed button is present at all.
      const collapsedButton = mkNode({ resourceId: '', text: 'Ikuti', bounds: box(464, 87, 618, 143) })
      const backButton = mkNode({ resourceId: 'app:id/p_i', bounds: box(14, 70, 270, 161) })
      const profile = mkNode({ bounds: box(0, 0, 720, 1640), children: [backButton, collapsedButton] })
      const found = findProfileFollowButton(profile)
      expect(found?.bounds).toEqual(box(464, 87, 618, 143))
    })

    test('the collapsed-header band and the expanded-header band never collide with the stats row between them', () => {
      // Regression guard for the exact failure mode being fixed: a stats label sitting between the two
      // legitimate bands (top 286) must never be picked, whichever band a real button happens to be in.
      const stats = mkNode({ resourceId: 'app:id/sdn', text: 'Mengikuti', bounds: box(28, 286, 232, 319) })
      const collapsedButton = mkNode({ resourceId: '', text: 'Mengikuti', bounds: box(464, 87, 618, 143) })
      const profile = mkNode({ bounds: box(0, 0, 720, 1640), children: [stats, collapsedButton] })
      expect(findProfileFollowButton(profile)?.bounds).toEqual(box(464, 87, 618, 143))
    })

    test('reads the already-following label in the collapsed header too', () => {
      const collapsedButton = mkNode({ resourceId: '', text: 'Mengikuti', bounds: box(464, 87, 618, 143) })
      const profile = mkNode({ bounds: box(0, 0, 720, 1640), children: [collapsedButton] })
      const found = findProfileFollowButton(profile)
      expect(found && isAlreadyFollowing(found.text)).toBe(true)
    })
  })

  /**
   * Second hardware correction to plan §4.5, found exploring the manual unfollow step of the probe
   * (2026-08-09) on the SAME account the probe had just followed: on an already-following profile,
   * `id:"fds"` is shared by a "Pesan" (Message) button AND the follow button, with "Pesan" first in
   * document order — `[170,371-246,441]` then `[431,371-580,441]`, reproduced verbatim below. A bare
   * "first id match" would silently return "Pesan", which is not a follow-state label.
   */
  describe('the "Pesan" (Message) button sharing id:"fds" once already following (second hardware correction)', () => {
    test('skips "Pesan" and returns the actual follow button, even though "Pesan" is first in document order', () => {
      const message = mkNode({ resourceId: 'app:id/fds', text: 'Pesan', bounds: box(170, 371, 246, 441) })
      const button = mkNode({ resourceId: 'app:id/fds', text: 'Mengikuti', bounds: box(431, 371, 580, 441) })
      const profile = mkNode({ bounds: box(0, 0, 720, 1640), children: [message, button] })
      const found = findProfileFollowButton(profile)
      expect(found?.text).toBe('Mengikuti')
      expect(found?.bounds).toEqual(box(431, 371, 580, 441))
    })

    test('"Pesan" alone (no follow button at all) resolves to null rather than a false positive', () => {
      const message = mkNode({ resourceId: 'app:id/fds', text: 'Pesan', bounds: box(170, 371, 246, 441) })
      const profile = mkNode({ bounds: box(0, 0, 720, 1640), children: [message] })
      expect(findProfileFollowButton(profile)).toBeNull()
    })
  })
})
