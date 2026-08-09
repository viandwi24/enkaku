import { describe, expect, test } from 'bun:test'
import type { Bounds, UiNode } from '@enkaku/protocol'
import { findQueryInput, findSearchIcon, findSubmitButton } from './search'

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
 * `findSearchIcon` — the answer to plan 86 §0.2. Reproduces the exact repro in the plan: the real
 * top-bar icon and a per-video "search this content" chip both carry `desc:"Cari"`, and only the
 * bounds filter tells them apart.
 */
describe('findSearchIcon — never the per-video chip (plan 86 §0.2)', () => {
  function feedWithChip(): UiNode {
    const icon = mkNode({ resourceId: 'app:id/jvu', desc: 'Cari', bounds: box(622, 72, 720, 170) })
    const chip = mkNode({ resourceId: 'app:id/enm', desc: 'Cari', bounds: box(21, 1424, 49, 1452) })
    return mkNode({ bounds: box(0, 0, 720, 1640), children: [chip, icon] })
  }

  test('picks the top-bar icon even when the per-video chip is encountered first in document order', () => {
    const found = findSearchIcon(feedWithChip())
    expect(found?.bounds).toEqual(box(622, 72, 720, 170))
  })

  test('returns null when only the chip is present, rather than silently returning it', () => {
    const chip = mkNode({ resourceId: 'app:id/enm', desc: 'Cari', bounds: box(21, 1424, 49, 1452) })
    const tree = mkNode({ bounds: box(0, 0, 720, 1640), children: [chip] })
    expect(findSearchIcon(tree)).toBeNull()
  })

  test('a bare depth-first "first match" would have picked the chip — the filter is load-bearing', () => {
    // Sanity check on the fixture itself: the chip really is first in `children`, so a selector
    // walk with no bounds filter (plan §0.1's failure mode) would return it, not the icon.
    const tree = feedWithChip()
    expect(tree.children[0]?.desc).toBe('Cari')
    expect(tree.children[0]?.bounds.top).toBeGreaterThan(200)
  })
})

describe('findQueryInput — located by id, bounds only (plan §4.4 B2)', () => {
  test('finds the input by its short id, qualified or bare', () => {
    const bare = mkNode({ resourceId: 'hhu', text: 'rotating placeholder', bounds: box(87, 84, 635, 147) })
    const tree = mkNode({ bounds: box(0, 0, 720, 200), children: [bare] })
    expect(findQueryInput(tree)?.bounds).toEqual(box(87, 84, 635, 147))
  })

  test('returns null when no input node is present', () => {
    const tree = mkNode({ bounds: box(0, 0, 720, 200), children: [] })
    expect(findQueryInput(tree)).toBeNull()
  })
})

describe('findSubmitButton — id first, bounds-filtered text fallback (plan §4.4 B3)', () => {
  test('prefers the descriptive, non-obfuscated id', () => {
    const submit = mkNode({ resourceId: 'com.ss.android.ugc.trill:id/tv_search_textview', text: 'Cari', bounds: box(613, 77, 720, 154) })
    const tree = mkNode({ bounds: box(0, 0, 720, 200), children: [submit] })
    expect(findSubmitButton(tree)?.bounds).toEqual(box(613, 77, 720, 154))
  })

  test('falls back to a bounds-filtered text:"Cari" when the id is absent', () => {
    const submit = mkNode({ resourceId: '', text: 'Cari', bounds: box(613, 77, 720, 154) })
    const tree = mkNode({ bounds: box(0, 0, 720, 200), children: [submit] })
    expect(findSubmitButton(tree)?.bounds).toEqual(box(613, 77, 720, 154))
  })

  test('the text fallback ignores a "Cari" row below the bar (the danger zone, y >= 161)', () => {
    // Search-history rows and suggestion text can read "Cari" too, well below the bar — the fallback
    // must never pick one of those and turn a submit into a tap in the history-delete danger zone.
    const historyRow = mkNode({ resourceId: '', text: 'Cari', bounds: box(56, 1424, 522, 1452) })
    const tree = mkNode({ bounds: box(0, 0, 720, 1640), children: [historyRow] })
    expect(findSubmitButton(tree)).toBeNull()
  })
})
