import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import grid from './__fixtures__/screen-profile-grid.json'
import { onOwnProfile, readDraftCount, readHandle, readProfileGrid } from './my-videos'

/*
  One capture, taken off the owner's moto g06 power on 2026-09-21: TikTok
  `id-ID`, account `dewi_purnama280`, the Profil tab at the top of its grid.
  Every expectation below is what that screen actually drew.
*/
const tree = grid as unknown as UiNode

describe('readProfileGrid', () => {
  test('reads every play count on screen, in grid order', () => {
    const cells = readProfileGrid(tree)
    expect(cells.map((c) => c.viewsText)).toEqual(['420', '73', '8', '11', '71', '1.655', '140,1 rb', '1.188'])
  })

  test('id-ID separators are read as the app means them', () => {
    const cells = readProfileGrid(tree)
    // `1.655` is one thousand six hundred and fifty-five; `140,1 rb` is a rounded 140,100.
    expect(cells.map((c) => c.views)).toEqual([420, 73, 8, 11, 71, 1655, 140_100, 1188])
    expect(cells.find((c) => c.viewsText.includes('rb'))?.approx).toBe(true)
    expect(cells.find((c) => c.viewsText === '420')?.approx).toBe(false)
  })

  test('ranks are 0-based and follow the grid, not the tree', () => {
    expect(readProfileGrid(tree).map((c) => c.rank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test('the drafts tile is not a post and never takes a rank', () => {
    // The first cell of this grid is "Draf: 11" and has no play count at all.
    // Counting it would shift every video's position by one for ever.
    expect(readProfileGrid(tree).length).toBe(8)
    expect(readDraftCount(tree)).toBe(11)
  })
})

describe('readHandle', () => {
  test('the @ handle, not the display name', () => {
    // The header carries both `dewi_purnama280` and `@dewi_purnama280`.
    expect(readHandle(tree)).toBe('@dewi_purnama280')
  })
})

describe('onOwnProfile', () => {
  test('the measured profile is recognised', () => {
    expect(onOwnProfile(tree)).toBe(true)
  })

  test('a screen with no handle is not the profile, whatever else is on it', () => {
    expect(onOwnProfile({ ...tree, children: [] } as UiNode)).toBe(false)
  })
})
