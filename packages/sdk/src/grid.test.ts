import { describe, expect, test } from 'bun:test'
import { mergePages } from './grid'

const key = (n: number): string => String(n)

describe('mergePages', () => {
  test('one page is itself', () => {
    expect(mergePages([[420, 73, 8]], key)).toEqual({ items: [420, 73, 8], truncated: false })
  })

  test('two overlapping pages are stitched at the overlap', () => {
    // A TikTok grid scrolled by one row: the last two cells of page 1 are the first two of page 2.
    const merged = mergePages(
      [
        [420, 73, 8, 11, 71],
        [11, 71, 1655, 140100, 1188],
      ],
      key,
    )
    expect(merged).toEqual({ items: [420, 73, 8, 11, 71, 1655, 140100, 1188], truncated: false })
  })

  test('a page that repeats the one before it adds nothing', () => {
    // The list did not move — the end of the grid, or a scroll that did not take.
    expect(mergePages([[5, 4, 3], [5, 4, 3]], key)).toEqual({ items: [5, 4, 3], truncated: false })
  })

  test('the LARGEST overlap wins, so a run of equal counts is not mistaken for a whole page passing', () => {
    // Six brand-new videos, all at zero. The smallest overlap would claim the
    // list advanced by five and invent five videos that do not exist.
    expect(mergePages([[0, 0, 0], [0, 0, 0, 7]], key)).toEqual({ items: [0, 0, 0, 7], truncated: false })
  })

  test('pages that do not meet stop the list and say so', () => {
    expect(mergePages([[9, 8, 7], [3, 2, 1]], key)).toEqual({ items: [9, 8, 7], truncated: true })
  })

  test('an empty page is skipped, not treated as a break', () => {
    expect(mergePages([[9, 8], [], [8, 7]], key)).toEqual({ items: [9, 8, 7], truncated: false })
  })

  test('nothing read at all', () => {
    expect(mergePages([], key)).toEqual({ items: [], truncated: false })
    expect(mergePages([[]], key)).toEqual({ items: [], truncated: false })
  })

  test('the key is what is compared, not the item', () => {
    type Cell = { views: number; rank: number }
    const a: Cell[] = [{ views: 5, rank: 0 }, { views: 4, rank: 1 }]
    const b: Cell[] = [{ views: 4, rank: 0 }, { views: 3, rank: 1 }]
    // `rank` is a property of the SCREEN and differs between the pages; only `views` identifies a cell.
    expect(mergePages([a, b], (c) => String(c.views)).items.map((c) => c.views)).toEqual([5, 4, 3])
  })
})
