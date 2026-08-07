import { describe, expect, test } from 'bun:test'
import { toUiSelector } from './selector'

describe('the selector mask (regression: every selector resolved to the root)', () => {
  // Without `mask` the on-device server matches on nothing and answers with the ROOT node rather
  // than a miss — a 720×1640 FrameLayout that the oversized guard then rejected, so `find()`
  // returned null for every selector on every screen. Verified on hardware: `{resourceId}` alone
  // came back 720×1640; the same selector with mask 0x200000 came back 192×39 `:id/title`.
  test('a full resource id carries the resourceId bit', () => {
    expect(toUiSelector({ id: 'com.example:id/title' })).toEqual({
      resourceId: 'com.example:id/title',
      mask: 0x200000,
    })
  })

  test('a bare id becomes a regex match, and carries the MATCHES bit rather than the plain one', () => {
    expect(toUiSelector({ id: 'title' })).toEqual({ resourceIdMatches: '.*:id/title', mask: 0x400000 })
  })

  test('desc and text carry their own bits', () => {
    expect(toUiSelector({ desc: 'Beranda' })).toEqual({ description: 'Beranda', mask: 0x40 })
    expect(toUiSelector({ text: 'Beranda' })).toEqual({ text: 'Beranda', mask: 0x01 })
  })

  test('every mapping sets a mask — a selector without one silently matches the root', () => {
    for (const sel of [{ id: 'a:id/b' }, { id: 'b' }, { desc: 'd' }, { text: 't' }] as const) {
      expect(toUiSelector(sel).mask).toBeGreaterThan(0)
    }
  })
})
