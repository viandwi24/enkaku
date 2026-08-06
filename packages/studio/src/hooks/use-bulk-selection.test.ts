import { describe, expect, test } from 'bun:test'
import { useBulkSelection } from './use-bulk-selection'

/** Pure logic — no DOM/React needed, so this runs the same under a plain `bun test` as under the
 * Studio suite; called directly (not through `renderHook`) since the function takes no hooks of
 * its own (no `useState`/`useEffect`) despite the `use*` name — plan 83 §4.4's own description. */

describe('useBulkSelection (plan 83 §3.7, §4.4)', () => {
  test('allChecked/someChecked reflect the WHOLE set, not a group', () => {
    const none = useBulkSelection(['a', 'b', 'c'], [], () => {})
    expect(none.allChecked).toBe(false)
    expect(none.someChecked).toBe(false)

    const some = useBulkSelection(['a', 'b', 'c'], ['a'], () => {})
    expect(some.allChecked).toBe(false)
    expect(some.someChecked).toBe(true)

    const all = useBulkSelection(['a', 'b', 'c'], ['a', 'b', 'c'], () => {})
    expect(all.allChecked).toBe(true)
    expect(all.someChecked).toBe(false)
  })

  test('an empty allIds list is never indeterminate or checked', () => {
    const empty = useBulkSelection([], [], () => {})
    expect(empty.allChecked).toBe(false)
    expect(empty.someChecked).toBe(false)
  })

  test('groupState — the indeterminate rule (criterion 19): none/some/all per group, independent of other groups', () => {
    const sel = useBulkSelection(['a1', 'a2', 'b1', 'b2'], ['a1'], () => {})
    expect(sel.groupState(['a1', 'a2'])).toBe('some')
    expect(sel.groupState(['b1', 'b2'])).toBe('none')
    expect(sel.groupState(['a1'])).toBe('all')
  })

  test('toggleGroup selects the whole group in ONE setSelected call when any member is unselected (criterion 18)', () => {
    const calls: string[][] = []
    const sel = useBulkSelection(['a1', 'a2', 'b1'], ['a1'], (ids) => calls.push(ids))
    sel.toggleGroup(['a1', 'a2'])
    expect(calls.length).toBe(1)
    expect(new Set(calls[0])).toEqual(new Set(['a1', 'a2']))
  })

  test('toggleGroup CLEARS the whole group in one call when every member is already selected', () => {
    const calls: string[][] = []
    const sel = useBulkSelection(['a1', 'a2', 'b1'], ['a1', 'a2', 'b1'], (ids) => calls.push(ids))
    sel.toggleGroup(['a1', 'a2'])
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual(['b1'])
  })

  test('toggleAll selects everything in one call, then clears everything in one call (criterion 20 — one draft update, not N)', () => {
    const calls: string[][] = []
    const sel1 = useBulkSelection(['a', 'b', 'c'], [], (ids) => calls.push(ids))
    sel1.toggleAll()
    expect(calls.length).toBe(1)
    expect(new Set(calls[0])).toEqual(new Set(['a', 'b', 'c']))

    const sel2 = useBulkSelection(['a', 'b', 'c'], ['a', 'b', 'c'], (ids) => calls.push(ids))
    sel2.toggleAll()
    expect(calls.length).toBe(2)
    expect(calls[1]).toEqual([])
  })

  test('toggleAll from a partial (indeterminate) selection selects the rest, not clears', () => {
    const calls: string[][] = []
    const sel = useBulkSelection(['a', 'b', 'c'], ['a'], (ids) => calls.push(ids))
    sel.toggleAll()
    expect(new Set(calls[0])).toEqual(new Set(['a', 'b', 'c']))
  })
})
