import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import reels from './__fixtures__/screen-profile-reels.json'
import gridView from './__fixtures__/screen-profile-grid-empty.json'
import { onReelsTab, readHandle, readReelsGrid, reelsTabOf } from './my-videos'

/*
  Two captures off the owner's moto g06 power, 2026-09-21, account
  `bitorex.bkk`: the profile's Reels tab, and the Grid-view tab it must not be
  confused with.
*/
const tab = reels as unknown as UiNode
const grid = gridView as unknown as UiNode

describe('readReelsGrid', () => {
  test('reads the play count off the Reels tab', () => {
    const cells = readReelsGrid(tab)
    expect(cells).toEqual([{ rank: 0, views: 140, viewsText: '140', approx: false }])
  })

  test('the Drafts tile is not a reel', () => {
    // The first tile of this grid is Drafts — no thumbnail button, no count.
    // It must never take rank 0, or every reel is off by one for ever.
    expect(readReelsGrid(tab).length).toBe(1)
  })

  test('the Grid-view tab carries no numbers at all, which is why this member does not use it', () => {
    // Its cells describe themselves `Reel by bitorex.bkk at row 1, column 1`.
    expect(readReelsGrid(grid)).toEqual([])
  })
})

describe('reelsTabOf', () => {
  test('finds the Reels tab among the profile\'s three', () => {
    // The row is Grid view / Reels / Photos of you.
    expect(reelsTabOf(grid)?.desc).toBe('Reels')
  })
})

describe('onReelsTab', () => {
  test('true only once the reels recycler is drawn', () => {
    expect(onReelsTab(tab)).toBe(true)
    expect(onReelsTab(grid)).toBe(false)
  })
})

describe('readHandle', () => {
  test('the action bar carries the handle', () => {
    expect(readHandle(tab)).toBe('bitorex.bkk')
  })
})
