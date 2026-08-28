import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { all, flatten, rowsById, visibleStrings } from './tree'

function node(partial: Partial<UiNode>): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.TextView',
    packageName: 'com.android.settings',
    bounds: { left: 0, top: 0, right: 100, bottom: 40 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...partial,
  }
}

const tree = node({
  className: 'android.widget.FrameLayout',
  children: [
    node({ resourceId: 'com.android.settings:id/row', text: 'a@x.com' }),
    node({
      resourceId: 'com.android.settings:id/container',
      children: [node({ resourceId: 'com.android.settings:id/row', text: 'b@x.com', desc: 'Google' })],
    }),
  ],
})

describe('tree helpers', () => {
  test('flatten is depth-first and includes the root itself', () => {
    expect(flatten(tree).map((n) => n.text)).toEqual(['', 'a@x.com', '', 'b@x.com'])
  })

  test('all filters the flattened walk', () => {
    expect(all(tree, (n) => n.text.endsWith('@x.com')).length).toBe(2)
  })

  /**
   * The reason this file exists rather than a `find()` call. Android's accounts
   * screen is a RecyclerView of identical rows; `find({ id: 'row' })` returns
   * the first and never reports `ambiguous`, because the `ui-server` inspector
   * cannot. `rowsById` is how a script sees all of them.
   */
  test('rowsById finds every repeated row, not just the first the walk reaches', () => {
    expect(rowsById(tree, 'row').map((n) => n.text)).toEqual(['a@x.com', 'b@x.com'])
  })

  test('rowsById accepts a fully-qualified id as well as the short form, matching selector-match.ts', () => {
    expect(rowsById(tree, 'com.android.settings:id/row').length).toBe(2)
  })

  test('visibleStrings takes text and desc, skips blanks, and de-duplicates in first-seen order', () => {
    expect(visibleStrings(tree)).toEqual(['a@x.com', 'b@x.com', 'Google'])
  })
})
