import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { readNewestCell } from './post-video'

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
