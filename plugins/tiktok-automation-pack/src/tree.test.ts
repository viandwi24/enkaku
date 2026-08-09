import { describe, expect, test } from 'bun:test'
import type { Bounds, UiNode } from '@enkaku/protocol'
import { all, centerOf, flatten, rowsById, textIn, within } from './tree'

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

describe('flatten', () => {
  test('visits every node depth-first, root first', () => {
    const leaf = mkNode({ resourceId: 'leaf', bounds: box(0, 0, 1, 1) })
    const child = mkNode({ resourceId: 'child', bounds: box(0, 0, 10, 10), children: [leaf] })
    const root = mkNode({ resourceId: 'root', bounds: box(0, 0, 100, 100), children: [child] })
    expect(flatten(root).map((n) => n.resourceId)).toEqual(['root', 'child', 'leaf'])
  })
})

describe('all — the findAll the SDK does not have', () => {
  test('returns every match, depth-first, skipping non-matches', () => {
    const a = mkNode({ text: 'x', bounds: box(0, 0, 1, 1) })
    const b = mkNode({ text: 'y', bounds: box(0, 0, 1, 1) })
    const c = mkNode({ text: 'x', bounds: box(0, 0, 1, 1) })
    const root = mkNode({ bounds: box(0, 0, 10, 10), children: [a, b, c] })
    expect(all(root, (n) => n.text === 'x')).toEqual([a, c])
  })
})

describe('rowsById — the repeated-row case of plan 86 §0.1', () => {
  test('three same-id rows all come back, in visual order, with a non-matching sibling interleaved', () => {
    const row0 = mkNode({ resourceId: 'app:id/l_z', desc: 'user1', bounds: box(0, 0, 720, 100) })
    const other = mkNode({ resourceId: 'app:id/unrelated', bounds: box(0, 0, 1, 1) })
    const row1 = mkNode({ resourceId: 'app:id/l_z', desc: 'user2', bounds: box(0, 100, 720, 200) })
    const row2 = mkNode({ resourceId: 'app:id/l_z', desc: 'Tambah akun', bounds: box(0, 200, 720, 300) })
    const root = mkNode({ bounds: box(0, 0, 720, 300), children: [row0, other, row1, row2] })
    expect(rowsById(root, 'l_z').map((n) => n.desc)).toEqual(['user1', 'user2', 'Tambah akun'])
  })

  test('matches a short id the same way a `{ id }` selector does — exact, or a `:id/<short>` suffix', () => {
    const bare = mkNode({ resourceId: 'l_z', bounds: box(0, 0, 1, 1) })
    const qualified = mkNode({ resourceId: 'com.example:id/l_z', bounds: box(0, 0, 1, 1) })
    const lookalike = mkNode({ resourceId: 'com.example:id/other_z', bounds: box(0, 0, 1, 1) })
    const root = mkNode({ bounds: box(0, 0, 1, 1), children: [bare, qualified, lookalike] })
    expect(rowsById(root, 'l_z')).toEqual([bare, qualified])
  })
})

describe('within — attributing a child to its row', () => {
  test('true for a child inside its row, including bounds that touch the row edge exactly', () => {
    const row = box(0, 100, 720, 200)
    expect(within(row, box(10, 100, 700, 200))).toBe(true)
  })

  test('false for a node that belongs to a different row', () => {
    const row = box(0, 100, 720, 200)
    expect(within(row, box(10, 210, 700, 290))).toBe(false)
  })

  test('attributes each child to the correct row out of several, never the wrong one', () => {
    const rowA = box(0, 0, 720, 126)
    const rowB = box(0, 126, 720, 252)
    const checkmarkInA = box(650, 20, 692, 62)
    const badgeInB = box(642, 146, 692, 179)
    expect(within(rowA, checkmarkInA)).toBe(true)
    expect(within(rowB, checkmarkInA)).toBe(false)
    expect(within(rowB, badgeInB)).toBe(true)
    expect(within(rowA, badgeInB)).toBe(false)
  })
})

describe('textIn — scoped lookup, does not leak across sibling subtrees', () => {
  test('a match inside the given subtree is found', () => {
    const checkmark = mkNode({ desc: 'Tanda centang', bounds: box(0, 0, 1, 1) })
    const rowWithCheckmark = mkNode({ bounds: box(0, 0, 720, 126), children: [checkmark] })
    expect(textIn(rowWithCheckmark, (n) => n.desc === 'Tanda centang')).toBe('Tanda centang')
  })

  test('the same predicate finds nothing in a sibling subtree that does not contain it', () => {
    const rowWithoutCheckmark = mkNode({ bounds: box(0, 126, 720, 252), children: [] })
    expect(textIn(rowWithoutCheckmark, (n) => n.desc === 'Tanda centang')).toBeNull()
  })

  test('prefers text, falls back to desc when text is empty', () => {
    const withText = mkNode({ text: 'dewi_purnama280', bounds: box(0, 0, 1, 1) })
    expect(textIn(withText, () => true)).toBe('dewi_purnama280')
    const descOnly = mkNode({ desc: 'Tanda centang', bounds: box(0, 0, 1, 1) })
    expect(textIn(descOnly, () => true)).toBe('Tanda centang')
  })
})

describe('centerOf — re-exported from @enkaku/protocol', () => {
  test('is reachable from this module alone, and computes the box centre', () => {
    expect(centerOf(box(0, 0, 100, 50))).toEqual({ x: 50, y: 25 })
  })
})
