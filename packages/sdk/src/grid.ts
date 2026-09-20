/**
 * Reading a list that is longer than the screen, without an id to hold on to.
 *
 * A profile grid on TikTok and on Instagram gives a cell's view count and
 * NOTHING else — no caption, no id, not even a stable description. So a
 * reader that scrolls has no way to ask "have I seen this one before?" and the
 * obvious approaches are both wrong: counting scrolls assumes the list moved
 * by exactly what was asked (it does not, it snaps), and trusting screen
 * position assumes nothing was inserted while reading.
 *
 * What IS true is that consecutive dumps OVERLAP. Scroll by less than a
 * screen and the top of the new page is the bottom of the old one, in order,
 * with the same values — within one reading, seconds apart, a view count does
 * not move. So the pages can be stitched by finding that overlap, and the
 * stitch is checkable: if no overlap is found, the reader does not know what
 * it skipped and says so instead of appending a guess.
 *
 * `truncated` is that admission. A recap built on a silent guess would show an
 * operator a video list with a hole in it and no way to tell.
 */

export interface MergedPages<T> {
  /** The stitched list, in screen order, first page first. */
  items: T[]
  /** True when a page could not be joined to the one before it, so the list stops there. */
  truncated: boolean
}

/**
 * Stitch consecutive pages of a scrolling list by their overlap.
 *
 * The LARGEST overlap wins. A short scroll step is the caller's job, and with
 * one the largest overlap is the true one; the alternative — taking the
 * smallest — would read a run of equal counts (a row of brand-new videos, all
 * at zero) as the whole page having moved past.
 */
export function mergePages<T>(pages: readonly (readonly T[])[], keyOf: (item: T) => string): MergedPages<T> {
  const items: T[] = []
  let truncated = false
  for (const page of pages) {
    if (page.length === 0) continue
    if (items.length === 0) {
      items.push(...page)
      continue
    }
    const keys = items.map(keyOf)
    const fresh = page.map(keyOf)
    const max = Math.min(keys.length, fresh.length)
    let overlap = 0
    for (let k = max; k >= 1; k--) {
      let same = true
      for (let i = 0; i < k; i++) {
        if (keys[keys.length - k + i] !== fresh[i]) {
          same = false
          break
        }
      }
      if (same) {
        overlap = k
        break
      }
    }
    if (overlap === 0) {
      // The pages do not meet. Everything after this point is unknown, and an
      // unknown gap is not something to paper over with an append.
      truncated = true
      break
    }
    items.push(...page.slice(overlap))
  }
  return { items, truncated }
}
