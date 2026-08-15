import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { anchorDue, mapNormToPixels, proposeCandidateSelector } from './anchors'

/** Mirrors `packages/protocol/src/selector-match.test.ts`'s own `leaf()` fixture. */
function leaf(overrides: Partial<UiNode> = {}): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.TextView',
    packageName: 'com.example',
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...overrides,
  }
}

describe('mapNormToPixels', () => {
  test('scales 0..1 to the given size, rounding', () => {
    expect(mapNormToPixels({ x: 0.5, y: 0.25 }, { width: 1080, height: 2400 })).toEqual({ x: 540, y: 600 })
  })

  test('clamps to the frame — a 1.0 coordinate never lands one pixel past the edge', () => {
    expect(mapNormToPixels({ x: 1, y: 1 }, { width: 1080, height: 2400 })).toEqual({ x: 1079, y: 2399 })
  })

  test('clamps a negative coordinate to 0', () => {
    expect(mapNormToPixels({ x: -0.1, y: -0.1 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 0 })
  })
})

describe('anchorDue', () => {
  test('always due when nothing has been captured yet', () => {
    expect(anchorDue(1_000, null, 1_500)).toBe(true)
  })

  test('not due before minIntervalMs has elapsed', () => {
    expect(anchorDue(1_000, 0, 1_500)).toBe(false)
    expect(anchorDue(1_499, 0, 1_500)).toBe(false)
  })

  test('due exactly at the boundary and beyond', () => {
    expect(anchorDue(1_500, 0, 1_500)).toBe(true)
    expect(anchorDue(2_000, 0, 1_500)).toBe(true)
  })
})

describe('proposeCandidateSelector (plan 94 §3.3, §4.6)', () => {
  test('a unique resourceId on the hit node becomes the candidate', () => {
    const tree = leaf({
      resourceId: 'root',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      children: [leaf({ resourceId: 'com.app:id/follow_button', clickable: true, bounds: { left: 0, top: 0, right: 40, bottom: 40 } })],
    })
    const found = proposeCandidateSelector(tree, { x: 20, y: 20 })
    expect(found).toEqual({ selector: { id: 'follow_button' }, count: 1 })
  })

  test('a point that misses the tree entirely yields no candidate', () => {
    const tree = leaf({ bounds: { left: 0, top: 0, right: 10, bottom: 10 } })
    expect(proposeCandidateSelector(tree, { x: 500, y: 500 })).toBeNull()
  })

  test('a hit node whose only identifying field matches more than once yields no candidate — count must be exactly 1', () => {
    const tree = leaf({
      resourceId: 'root',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      children: [
        leaf({ text: 'row', bounds: { left: 0, top: 0, right: 40, bottom: 20 } }),
        leaf({ text: 'row', bounds: { left: 0, top: 20, right: 40, bottom: 40 } }),
      ],
    })
    expect(proposeCandidateSelector(tree, { x: 5, y: 5 })).toBeNull()
  })

  test('a hit node with no id/desc/text at all yields no candidate — point is never proposed as a candidate', () => {
    const tree = leaf({
      resourceId: 'root',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      children: [leaf({ bounds: { left: 0, top: 0, right: 40, bottom: 40 } })],
    })
    expect(proposeCandidateSelector(tree, { x: 5, y: 5 })).toBeNull()
  })
})
