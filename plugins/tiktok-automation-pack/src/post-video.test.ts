import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { judgeGrid, parseViews, readGrid, readNewestCell } from './post-video'

/**
 * `readNewestCell` — what the own-profile grid says about THIS post.
 *
 * Measured 2026-09-11 on the owner's moto g06: an account with six existing
 * videos, the upload stuck at "Mengunggah... 4%", and a run that reported
 * `outcome: "posted"` because the old confirmation accepted any grid-shaped
 * cell. The trees below are synthetic but shaped exactly like that dump —
 * cells carrying only a view-count label, the bottom nav beneath them — and
 * deliberately carry no account name, because the real dump did.
 */

const W = 720
const MENU_BOTTOM = 540

function node(over: Partial<UiNode> & { bounds: UiNode['bounds'] }): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.FrameLayout',
    packageName: 'com.ss.android.ugc.trill',
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...over,
  } as UiNode
}

/** One grid cell, 240x321 like the real ones, carrying a single label the way TikTok draws it. */
function cell(col: number, row: number, label: string): UiNode {
  const left = col * 240
  const top = 546 + row * 321
  return node({
    clickable: true,
    bounds: { left, top, right: left + 239, bottom: top + 320 },
    children: [node({ text: label, bounds: { left: left + 10, top: top + 280, right: left + 90, bottom: top + 310 } })],
  })
}

/** A bottom-nav tab: clickable and roughly cell-shaped, which is how the old check was fooled by it. */
function navTab(col: number, label: string): UiNode {
  const left = col * 144
  return node({
    clickable: true,
    bounds: { left, top: 1470, right: left + 144, bottom: 1556 },
    children: [node({ text: label, bounds: { left, top: 1500, right: left + 144, bottom: 1540 } })],
  })
}

function profile(cells: UiNode[]): UiNode {
  return node({ bounds: { left: 0, top: 0, right: W, bottom: 1640 }, children: [...cells, navTab(0, 'Beranda'), navTab(1, 'Toko')] })
}

describe('readNewestCell', () => {
  /*
    The measured failure. Six videos from before the run, nothing new: the old
    check called this "posted". It is not.
  */
  test('an account whose newest video is an old one is NOT a confirmed post', () => {
    const tree = profile([
      cell(0, 0, '1.559'),
      cell(1, 0, '118,6 rb'),
      cell(2, 0, '1.130'),
      cell(0, 1, '8.198'),
      cell(1, 1, '1.075'),
      cell(2, 1, '106,1 rb'),
    ])
    expect(readNewestCell(tree, MENU_BOTTOM, W)).toEqual({ kind: 'old', views: '1.559' })
  })

  test('0 views on the newest cell is the one reading that means posted', () => {
    const tree = profile([cell(0, 0, '0'), cell(1, 0, '1.559'), cell(2, 0, '118,6 rb')])
    expect(readNewestCell(tree, MENU_BOTTOM, W)).toEqual({ kind: 'new' })
  })

  test('an upload still drawing its progress is submitted, not live', () => {
    const tree = profile([cell(0, 0, '4%'), cell(1, 0, '1.559')])
    expect(readNewestCell(tree, MENU_BOTTOM, W)).toEqual({ kind: 'uploading', percent: '4%' })
  })

  test('the newest is the top-left cell, whatever order the tree lists them in', () => {
    // The tree lists an old video first; the newest (top-left) is the 0.
    const tree = profile([cell(2, 1, '8.198'), cell(1, 0, '1.075'), cell(0, 0, '0')])
    expect(readNewestCell(tree, MENU_BOTTOM, W)).toEqual({ kind: 'new' })
  })

  /*
    The second way the old check was vacuous: the bottom nav's tabs are
    clickable and roughly cell-shaped. A profile with no videos at all must not
    be read as one with a video in it.
  */
  test('a profile with no videos is none — the bottom nav is not a grid cell', () => {
    expect(readNewestCell(profile([]), MENU_BOTTOM, W)).toEqual({ kind: 'none' })
  })
})

describe('parseViews', () => {
  test('reads the id-ID and English labels TikTok draws', () => {
    expect(parseViews('0')).toBe(0)
    expect(parseViews('1.559')).toBe(1559)
    expect(parseViews('118,6\u00a0rb')).toBe(118_600)
    expect(parseViews('2,1 jt')).toBe(2_100_000)
    expect(parseViews('3.5K')).toBe(3_500)
    expect(parseViews('Beranda')).toBeNull()
  })
})

describe('readGrid', () => {
  test('lists every cell newest first, and leaves a pinned cell out', () => {
    const pinned = cell(0, 0, '9.999')
    pinned.children.push(node({ text: 'Disematkan', bounds: { left: 10, top: 556, right: 120, bottom: 590 } }))
    const tree = profile([cell(1, 0, '0'), pinned, cell(2, 0, '1.559'), cell(0, 1, '118,6 rb')])
    expect(readGrid(tree, MENU_BOTTOM, W)).toEqual(['0', '1.559', '118,6 rb'])
  })
})

/*
  The second 2026-09-11 hole: the account's newest video was an earlier test
  post still at 0 views, so "the newest cell shows 0" was already true before
  the run posted anything. Only a grid shifted by one proves a new cell.
*/
describe('judgeGrid — a new post pushes every earlier cell one place along', () => {
  const before = ['0', '1.559', '118,6 rb', '1.130', '8.198', '1.075']

  test('the measured case: an old 0-view post on top, nothing new, is not posted', () => {
    expect(judgeGrid(before, [...before])).toEqual({ kind: 'same' })
  })

  test('the same account after a real post: shifted by one, the old 0 now second', () => {
    expect(judgeGrid(before, ['0', '0', '1.559', '118,6 rb', '1.130', '8.198'])).toEqual({ kind: 'new' })
  })

  test('views that grew a little while the run was busy still line up', () => {
    expect(judgeGrid(['12', '1.559'], ['0', '14', '1.561'])).toEqual({ kind: 'new' })
    expect(judgeGrid(['12', '1.559'], ['14', '1.561'])).toEqual({ kind: 'same' })
  })

  test('the newest going from a real count to 0 is new — views never fall to 0', () => {
    expect(judgeGrid(['12', '1.559'], ['0', '12'])).toEqual({ kind: 'new' })
  })

  test('an empty profile that now has one video is new', () => {
    expect(judgeGrid([], ['0'])).toEqual({ kind: 'new' })
  })

  test('an upload in flight is uploading, whatever the baseline', () => {
    expect(judgeGrid(before, ['4%', ...before])).toEqual({ kind: 'uploading', percent: '4%' })
  })

  test('with no baseline it falls back to the newest-cell reading', () => {
    expect(judgeGrid(null, ['0', '1.559'])).toEqual({ kind: 'new' })
    expect(judgeGrid(null, ['1.559'])).toEqual({ kind: 'old', views: '1.559' })
  })

  test('every cell at 0 before and after is not enough to call it posted', () => {
    expect(judgeGrid(['0', '0'], ['0', '0'])).toEqual({ kind: 'same' })
  })
})
