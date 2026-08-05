import { describe, expect, test } from 'bun:test'
import { countMatches, proposeSelectors } from './selector-analysis'
import type { UiNode } from './ui-node'

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

describe('countMatches (plan 56 §5.6)', () => {
  test('eight identical text nodes count as 8', () => {
    const tree = leaf({ children: Array.from({ length: 8 }, () => leaf({ text: 'row' })) })
    expect(countMatches(tree, { text: 'row' })).toBe(8)
  })

  test('a unique resourceId counts as 1', () => {
    const tree = leaf({
      children: [leaf({ resourceId: 'com.app:id/only' }), leaf({ resourceId: 'com.app:id/other' })],
    })
    expect(countMatches(tree, { id: 'only' })).toBe(1)
  })

  test('a selector matching nothing counts as 0', () => {
    const tree = leaf({ children: [leaf({ text: 'a' })] })
    expect(countMatches(tree, { text: 'does not exist' })).toBe(0)
  })

  test('{ point } is not counted against the tree — it always reports 1 by convention, never used by proposeSelectors', () => {
    expect(countMatches(leaf(), { point: { x: 1, y: 1 } })).toBe(1)
  })
})

describe('proposeSelectors (plan 56 §3.5, §5.6)', () => {
  test('a node with a unique resourceId ranks id first with count 1', () => {
    const node = leaf({ resourceId: 'com.app:id/feed_action', text: 'Follow' })
    const tree = leaf({ children: [node] })
    const candidates = proposeSelectors(tree, node)
    expect(candidates[0]?.kind).toBe('id')
    expect(candidates[0]?.count).toBe(1)
    expect(candidates[0]?.selector).toEqual({ id: 'feed_action' })
    expect(candidates[0]?.note).toContain('1 match')
  })

  test('the short-id form is reported alongside its resourceIdMatches expansion', () => {
    const node = leaf({ resourceId: 'com.app:id/feed_action' })
    const tree = leaf({ children: [node] })
    const [idCandidate] = proposeSelectors(tree, node)
    expect(idCandidate?.expandsTo).toBe('resourceIdMatches: .*:id/feed_action')
  })

  test('a full resourceId with no ":id/" marker is passed through unchanged with no expansion note', () => {
    const node = leaf({ resourceId: 'already-short' })
    const tree = leaf({ children: [node] })
    const [idCandidate] = proposeSelectors(tree, node)
    expect(idCandidate?.selector).toEqual({ id: 'already-short' })
    expect(idCandidate?.expandsTo).toBeUndefined()
  })

  test('a selector matching more than one node says so, ranked by count', () => {
    const target = leaf({ text: 'row' })
    const tree = leaf({ children: [target, leaf({ text: 'row' })] })
    const candidates = proposeSelectors(tree, target)
    const textCandidate = candidates.find((c) => c.kind === 'text')
    expect(textCandidate?.count).toBe(2)
    expect(textCandidate?.note).toContain('2 matches')
  })

  test('a node with nothing but bounds falls through to { point }, with its note', () => {
    const node = leaf({ bounds: { left: 10, top: 20, right: 30, bottom: 40 } })
    const tree = leaf({ children: [node] })
    const candidates = proposeSelectors(tree, node)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.kind).toBe('point')
    expect(candidates[0]?.selector).toEqual({ point: { x: 20, y: 30 } })
    expect(candidates[0]?.count).toBeNull()
    expect(candidates[0]?.note).toContain('never be used as an existence check')
  })

  test('candidates are ordered id → desc → text → point', () => {
    const node = leaf({ resourceId: 'com.app:id/x', desc: 'a desc', text: 'a text' })
    const tree = leaf({ children: [node] })
    const kinds = proposeSelectors(tree, node).map((c) => c.kind)
    expect(kinds).toEqual(['id', 'desc', 'text', 'point'])
  })

  test('whitespace-only text/desc are treated as absent, same as empty', () => {
    const node = leaf({ text: '   ', desc: '  ' })
    const tree = leaf({ children: [node] })
    const kinds = proposeSelectors(tree, node).map((c) => c.kind)
    expect(kinds).toEqual(['point'])
  })
})
