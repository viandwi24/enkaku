import { describe, expect, test } from 'bun:test'
import { centerOf, hitTest, matchSelector, matches } from './selector-match'
import type { UiNode } from './ui-node'

/**
 * Moved verbatim from `@enkaku/drivers`' `inspector/selector.ts` (plan 56
 * §5.2) — these assertions must stay byte-identical to what shipped there,
 * proof the move did not shift any matching behaviour.
 */

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

describe('centerOf', () => {
  test('centre of a rectangle, rounded', () => {
    expect(centerOf({ left: 0, top: 0, right: 99, bottom: 51 })).toEqual({ x: 50, y: 26 })
  })
})

describe('matches (via matchSelector)', () => {
  test('a full resourceId matches exactly', () => {
    const node = leaf({ resourceId: 'com.app:id/feed_action' })
    expect(matches(node, { id: 'com.app:id/feed_action' })).toBe(true)
  })

  test('a short id matches the suffix form', () => {
    const node = leaf({ resourceId: 'com.app:id/feed_action' })
    expect(matches(node, { id: 'feed_action' })).toBe(true)
  })

  test('a short id does not match a different suffix', () => {
    const node = leaf({ resourceId: 'com.app:id/feed_action' })
    expect(matches(node, { id: 'other_action' })).toBe(false)
  })

  test('desc and text compare exactly after trimming — "Follow" never matches "Following"', () => {
    const node = leaf({ text: 'Following' })
    expect(matches(node, { text: 'Follow' })).toBe(false)
    expect(matches(node, { text: 'Following' })).toBe(true)
    expect(matches(leaf({ text: '  Follow  ' }), { text: 'Follow' })).toBe(true)
  })
})

describe('matchSelector — depth-first, first match wins', () => {
  test('finds a match several levels deep', () => {
    const tree = leaf({
      children: [leaf({ children: [leaf({ text: 'target' })] })],
    })
    const found = matchSelector(tree, { text: 'target' })
    expect(found?.text).toBe('target')
  })

  test('the FIRST match in depth-first order binds — a selector matching eight rows always resolves to the topmost', () => {
    const tree = leaf({
      children: [leaf({ text: 'row', resourceId: 'first' }), leaf({ text: 'row', resourceId: 'second' })],
    })
    const found = matchSelector(tree, { text: 'row' })
    expect(found?.resourceId).toBe('first')
  })

  test('no match anywhere in the tree returns null', () => {
    const tree = leaf({ children: [leaf()] })
    expect(matchSelector(tree, { text: 'nope' })).toBeNull()
  })

  test('{ point } bypasses the inspector entirely — a synthetic 1×1 node, always truthy', () => {
    const tree = leaf()
    const found = matchSelector(tree, { point: { x: 12, y: 34 } })
    expect(found).not.toBeNull()
    expect(found?.className).toBe('synthetic-point')
    expect(found?.bounds).toEqual({ left: 12, top: 34, right: 13, bottom: 35 })
  })
})

/**
 * `hitTest` (plan 94 §4.6, step 94.1) — the primitive the recorder's anchor
 * dump is hit-tested against, deepest-containing-node-preferring-clickable.
 */
describe('hitTest', () => {
  test('a point outside every node returns null', () => {
    const tree = leaf({ bounds: { left: 0, top: 0, right: 100, bottom: 100 } })
    expect(hitTest(tree, { x: 500, y: 500 })).toBeNull()
  })

  test('the root itself, when it has no matching child', () => {
    const tree = leaf({
      resourceId: 'root',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      children: [leaf({ resourceId: 'elsewhere', bounds: { left: 50, top: 50, right: 60, bottom: 60 } })],
    })
    expect(hitTest(tree, { x: 5, y: 5 })?.resourceId).toBe('root')
  })

  test('the deepest node containing the point, several levels down', () => {
    const tree = leaf({
      resourceId: 'root',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      children: [
        leaf({
          resourceId: 'container',
          bounds: { left: 0, top: 0, right: 50, bottom: 50 },
          children: [leaf({ resourceId: 'leaf', bounds: { left: 10, top: 10, right: 20, bottom: 20 } })],
        }),
      ],
    })
    expect(hitTest(tree, { x: 15, y: 15 })?.resourceId).toBe('leaf')
  })

  test('prefers a clickable sibling over a non-clickable one that also contains the point', () => {
    const tree = leaf({
      resourceId: 'root',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      children: [
        leaf({ resourceId: 'decoration', clickable: false, bounds: { left: 0, top: 0, right: 40, bottom: 40 } }),
        leaf({ resourceId: 'button', clickable: true, bounds: { left: 0, top: 0, right: 40, bottom: 40 } }),
      ],
    })
    expect(hitTest(tree, { x: 20, y: 20 })?.resourceId).toBe('button')
  })

  test('bounds are inclusive on every edge', () => {
    const tree = leaf({ bounds: { left: 0, top: 0, right: 10, bottom: 10 } })
    expect(hitTest(tree, { x: 0, y: 0 })).not.toBeNull()
    expect(hitTest(tree, { x: 10, y: 10 })).not.toBeNull()
    expect(hitTest(tree, { x: 11, y: 5 })).toBeNull()
  })

  test('with no ambiguity, a single non-clickable deepest match still wins (no false override)', () => {
    const tree = leaf({
      resourceId: 'root',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      children: [leaf({ resourceId: 'label', clickable: false, bounds: { left: 0, top: 0, right: 40, bottom: 40 } })],
    })
    expect(hitTest(tree, { x: 5, y: 5 })?.resourceId).toBe('label')
  })
})
