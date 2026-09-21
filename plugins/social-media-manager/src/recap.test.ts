import { describe, expect, test } from 'bun:test'
import { MAX_HISTORY, mergeRecap, recapRowKey, withinTolerance, type RecapReading, type RecapVideo } from './recap'

const NOW = 1_790_000_000
const DAY = 86_400

/** A stored video, spelled the short way. */
function stored(key: string, views: number, rank: number | null, opts?: { title?: string; history?: number[]; firstSeenAt?: number; lastRank?: number | null }): RecapVideo {
  return {
    key,
    title: opts?.title ?? '',
    views,
    viewsText: String(views),
    approx: false,
    rank,
    lastRank: opts?.lastRank ?? rank,
    firstSeenAt: opts?.firstSeenAt ?? NOW - DAY,
    lastSeenAt: NOW - DAY,
    history: (opts?.history ?? [views]).map((value, i) => ({ at: NOW - DAY * (opts?.history?.length ?? 1) + i * DAY, views: value })),
  }
}

/** A reading, newest first. `asked` defaults to 6 — the window the owner named. */
function reading(views: readonly number[], opts?: { titles?: readonly string[]; asked?: number; previousComplete?: boolean }): RecapReading {
  return {
    account: '@someone',
    truncated: false,
    asked: opts?.asked ?? 6,
    previousComplete: opts?.previousComplete ?? true,
    videos: views.map((value, rank) => ({ rank, views: value, viewsText: String(value), approx: false, title: opts?.titles?.[rank] ?? '' })),
  }
}

describe('mergeRecap — the first reading', () => {
  test('every video is new, keyed, and starts its history', () => {
    const merged = mergeRecap([], reading([5, 40, 120]), NOW)
    expect(merged.added).toBe(3)
    expect(merged.note).toBe('')
    expect(merged.videos.map((v) => v.rank)).toEqual([0, 1, 2])
    expect(merged.videos.map((v) => v.views)).toEqual([5, 40, 120])
    expect(merged.videos.every((v) => v.firstSeenAt === NOW && v.history.length === 1)).toBe(true)
    expect(new Set(merged.videos.map((v) => v.key)).size).toBe(3)
  })
})

describe('mergeRecap — nothing new, the counts simply grew', () => {
  test('the same videos keep their keys and gain a history point', () => {
    const before = [stored('a', 5, 0), stored('b', 40, 1), stored('c', 120, 2)]
    const merged = mergeRecap(before, reading([8, 55, 140]), NOW)
    expect(merged.added).toBe(0)
    expect(merged.videos.map((v) => v.key)).toEqual(['a', 'b', 'c'])
    expect(merged.videos.map((v) => v.views)).toEqual([8, 55, 140])
    expect(merged.videos.map((v) => v.history.length)).toEqual([2, 2, 2])
  })

  test('a count that did not move adds no history point', () => {
    const before = [stored('a', 5, 0)]
    const merged = mergeRecap(before, reading([5]), NOW)
    expect(merged.videos[0]?.history.length).toBe(1)
    expect(merged.videos[0]?.lastSeenAt).toBe(NOW)
  })
})

describe('mergeRecap — the case the whole feature exists for', () => {
  test('two new posts push the window down, and yesterday\'s videos keep their identity', () => {
    // Yesterday, newest first. An older post has had longer to collect views.
    const before = [stored('a', 5, 0), stored('b', 40, 1), stored('c', 120, 2), stored('d', 300, 3), stored('e', 900, 4), stored('f', 2_000, 5)]
    // Today: two new posts in front, and the window of six no longer reaches `e` or `f`.
    const merged = mergeRecap(before, reading([1, 3, 8, 55, 140, 330]), NOW)

    expect(merged.added).toBe(2)
    expect(merged.note).toBe('')
    // The two new ones are at the front with fresh keys.
    expect(merged.videos.slice(0, 2).map((v) => v.views)).toEqual([1, 3])
    expect(merged.videos.slice(0, 2).every((v) => v.firstSeenAt === NOW)).toBe(true)
    // `a` to `d` are recognised, moved down by exactly two, and updated.
    expect(merged.videos.slice(2, 6).map((v) => v.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged.videos.slice(2, 6).map((v) => v.rank)).toEqual([2, 3, 4, 5])
    expect(merged.videos.slice(2, 6).map((v) => v.views)).toEqual([8, 55, 140, 330])
  })

  test('the videos pushed out of the window are kept with their last known counts', () => {
    const before = [stored('a', 5, 0), stored('b', 40, 1), stored('c', 120, 2), stored('d', 300, 3), stored('e', 900, 4), stored('f', 2_000, 5)]
    const merged = mergeRecap(before, reading([1, 3, 8, 55, 140, 330]), NOW)
    const gone = merged.videos.filter((v) => v.rank === null)
    expect(gone.map((v) => v.key)).toEqual(['e', 'f'])
    // Their counts are yesterday's, and `lastSeenAt` still says so.
    expect(gone.map((v) => v.views)).toEqual([900, 2_000])
    expect(gone.every((v) => v.lastSeenAt === NOW - DAY)).toBe(true)
  })

  test('a shift that would need a video to lose views is not the shift that happened', () => {
    // This is what rules out "nothing is new": pairing today's first cell (1
    // view, brand new) against yesterday's first (5 views) needs a video to
    // have gone backwards.
    const before = [stored('a', 5, 0), stored('b', 40, 1), stored('c', 120, 2)]
    const merged = mergeRecap(before, reading([1, 8, 55]), NOW)
    expect(merged.added).toBe(1)
    expect(merged.videos.map((v) => v.key).slice(1, 3)).toEqual(['a', 'b'])
  })

  test('among the shifts that survive, the one with the least growth wins', () => {
    // Shift 2 explains today as "each video gained a little". Shift 3 would
    // explain it as one video going from 5 views to 55 overnight while the
    // next went 40 to 140 — arithmetically possible, wildly less likely.
    const before = [stored('a', 5, 0), stored('b', 40, 1), stored('c', 120, 2), stored('d', 300, 3)]
    const merged = mergeRecap(before, reading([1, 3, 8, 55, 140, 330]), NOW)
    expect(merged.added).toBe(2)
    expect(merged.videos[2]?.key).toBe('a')
  })
})

describe('mergeRecap — the two ways a naive scorer gets it wrong', () => {
  test('one video going viral does not invent a post that was never made', () => {
    // `a` goes 10 to 100 overnight while the rest gain a view each. Scoring
    // the shifts by their AVERAGE relative growth, that one 9.0 drowns out
    // three values near 0.03 and the "one new video" shift wins — minting a
    // post nobody made and dropping `d` off the end. A median sees it
    // correctly. On a warm-up farm this is the normal case, not an edge one.
    const before = [stored('a', 10, 0), stored('b', 20, 1), stored('c', 30, 2), stored('d', 40, 3)]
    const merged = mergeRecap(before, reading([100, 21, 31, 41]), NOW)
    expect(merged.added).toBe(0)
    expect(merged.videos.map((v) => v.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged.videos[0]?.views).toBe(100)
  })

  test('a count that has fallen too far is refused even when it scores best', () => {
    // A new video with 50 views in front of `a`, which has 100. By score alone
    // the "nothing is new" shift looks tidier — every video moved only a
    // little — but it needs `a` to have LOST half its views, and a view count
    // does not go down. Without that refusal this merge would rewrite `a` from
    // 100 to 50 and drop `c`.
    const before = [stored('a', 100, 0), stored('b', 200, 1), stored('c', 300, 2)]
    const merged = mergeRecap(before, reading([50, 210, 310]), NOW)
    expect(merged.added).toBe(1)
    expect(merged.videos.map((v) => v.key).slice(1)).toEqual(['a', 'b', 'c'])
    expect(merged.videos.map((v) => v.views)).toEqual([50, 210, 310, 300])
  })
})

describe('mergeRecap — where the counts cannot decide', () => {
  test('a window that is all zeros is settled by its LENGTH when neither read was capped', () => {
    // Three videos yesterday, four today, every one of them at zero views.
    // Nothing in the numbers separates the shifts; the count of videos does.
    const before = [stored('a', 0, 0), stored('b', 0, 1), stored('c', 0, 2)]
    const merged = mergeRecap(before, reading([0, 0, 0, 0], { asked: 6, previousComplete: true }), NOW)
    expect(merged.added).toBe(1)
    expect(merged.videos.slice(1).map((v) => v.key)).toEqual(['a', 'b', 'c'])
  })

  test('a FULL window that is all zeros is a guess, and says so', () => {
    // Six asked for, six returned: the length says nothing, and neither do the
    // counts. The merge picks the smallest shift and records that it guessed.
    const before = [stored('a', 0, 0), stored('b', 0, 1), stored('c', 0, 2), stored('d', 0, 3), stored('e', 0, 4), stored('f', 0, 5)]
    const merged = mergeRecap(before, reading([0, 0, 0, 0, 0, 0], { asked: 6 }), NOW)
    expect(merged.note).toContain('fit equally well')
    expect(merged.added).toBe(0)
  })

  test('when no shift works at all, nothing is lost and nothing is silently re-attached', () => {
    // Every count has fallen — a different account, or a grid misread. There
    // is no shift of the list that keeps the counts from going backwards.
    const before = [stored('a', 900, 0), stored('b', 2_000, 1), stored('c', 5_000, 2)]
    const merged = mergeRecap(before, reading([3, 7, 11]), NOW)
    expect(merged.note).toContain('could not be lined up')
    expect(merged.added).toBe(3)
    // The old videos are still there, with their last known counts, out of the window.
    expect(merged.videos.filter((v) => v.rank === null).map((v) => v.views)).toEqual([900, 2_000, 5_000])
  })
})

describe('mergeRecap — YouTube, where the title is the identity', () => {
  test('videos are matched by name, so a shift never has to be guessed', () => {
    const before = [stored('a', 100, 0, { title: 'Sunset' }), stored('b', 200, 1, { title: 'Sunrise' })]
    const merged = mergeRecap(before, reading([1, 110, 210], { titles: ['Moonrise', 'Sunset', 'Sunrise'] }), NOW)
    expect(merged.added).toBe(1)
    expect(merged.videos.map((v) => v.key)).toEqual([merged.videos[0]?.key ?? '', 'a', 'b'])
    expect(merged.videos.map((v) => v.title)).toEqual(['Moonrise', 'Sunset', 'Sunrise'])
  })

  test('a title match holds even when the counts would not allow the shift', () => {
    // A count revised down hard. By name there is no doubt which video it is.
    const before = [stored('a', 5_000, 0, { title: 'Sunset' })]
    const merged = mergeRecap(before, reading([12], { titles: ['Sunset'] }), NOW)
    expect(merged.added).toBe(0)
    expect(merged.videos[0]?.key).toBe('a')
    expect(merged.videos[0]?.views).toBe(12)
  })

  test('a platform that stopped giving a title does not erase the one it gave', () => {
    const before = [stored('a', 100, 0, { title: 'Sunset' })]
    const merged = mergeRecap(before, reading([120]), NOW)
    expect(merged.videos[0]?.title).toBe('Sunset')
  })
})

describe('mergeRecap — the small print', () => {
  test('a rounded count that dips slightly is still the same video', () => {
    // `140,1 rb` one day and `140 rb` the next is rounding, not a different video.
    const before = [stored('a', 140_100, 0)]
    const merged = mergeRecap(before, reading([140_000]), NOW)
    expect(merged.added).toBe(0)
    expect(merged.videos[0]?.key).toBe('a')
  })

  test('an empty reading never forgets what was there', () => {
    const before = [stored('a', 5, 0), stored('b', 40, 1)]
    const merged = mergeRecap(before, reading([]), NOW)
    expect(merged.videos.map((v) => v.key)).toEqual(['a', 'b'])
    expect(merged.videos.every((v) => v.rank === null)).toBe(true)
  })

  test('history is capped, oldest dropped first', () => {
    const long = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => i)
    const before = [stored('a', MAX_HISTORY + 9, 0, { history: long })]
    const merged = mergeRecap(before, reading([MAX_HISTORY + 50]), NOW)
    expect(merged.videos[0]?.history.length).toBe(MAX_HISTORY)
    expect(merged.videos[0]?.history[MAX_HISTORY - 1]?.views).toBe(MAX_HISTORY + 50)
  })
})

describe('withinTolerance', () => {
  test('two views of slack at the bottom, two percent higher up', () => {
    expect(withinTolerance(5, 3)).toBe(true)
    expect(withinTolerance(5, 2)).toBe(false)
    expect(withinTolerance(140_100, 138_000)).toBe(true)
    expect(withinTolerance(140_100, 130_000)).toBe(false)
  })
})

describe('recapRowKey', () => {
  test('names the platform and the phone', () => {
    expect(recapRowKey('tiktok', 'd1')).toBe('recap:tiktok:d1')
  })
})

describe('mergeRecap — the two ways a naive scorer gets it wrong', () => {
  test('one video going viral does not invent a post that was never made', () => {
    // `a` goes 10 to 100 overnight while the rest gain a view each. Scoring
    // the shifts by their AVERAGE relative growth, that one 9.0 drowns out
    // three values near 0.03 and the "one new video" shift wins — minting a
    // post nobody made and dropping `d` off the end. A median sees it
    // correctly. On a warm-up farm this is the normal case, not an edge one.
    const before = [stored('a', 10, 0), stored('b', 20, 1), stored('c', 30, 2), stored('d', 40, 3)]
    const merged = mergeRecap(before, reading([100, 21, 31, 41]), NOW)
    expect(merged.added).toBe(0)
    expect(merged.videos.map((v) => v.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged.videos[0]?.views).toBe(100)
  })

  test('a count that has fallen too far is refused even when it scores best', () => {
    // A new video with 50 views in front of `a`, which has 100. By score alone
    // the "nothing is new" shift looks tidier — every video moved only a
    // little — but it needs `a` to have LOST half its views, and a view count
    // does not go down. Without that refusal this merge would rewrite `a` from
    // 100 to 50 and drop `c`.
    const before = [stored('a', 100, 0), stored('b', 200, 1), stored('c', 300, 2)]
    const merged = mergeRecap(before, reading([50, 210, 310]), NOW)
    expect(merged.added).toBe(1)
    expect(merged.videos.map((v) => v.key).slice(1)).toEqual(['a', 'b', 'c'])
    expect(merged.videos.map((v) => v.views)).toEqual([50, 210, 310, 300])
  })
})

describe('mergeRecap — where the counts cannot decide', () => {
  test('a window that is all zeros is settled by its LENGTH when neither read was capped', () => {
    // Three videos yesterday, four today, every one of them at zero views.
    // Nothing in the numbers separates the shifts; the count of videos does.
    const before = [stored('a', 0, 0), stored('b', 0, 1), stored('c', 0, 2)]
    const merged = mergeRecap(before, reading([0, 0, 0, 0], { asked: 6, previousComplete: true }), NOW)
    expect(merged.added).toBe(1)
    expect(merged.videos.slice(1).map((v) => v.key)).toEqual(['a', 'b', 'c'])
  })

  test('a FULL window that is all zeros is a guess, and says so', () => {
    // Six asked for, six returned: the length says nothing, and neither do the
    // counts. The merge picks the smallest shift and records that it guessed.
    const before = [stored('a', 0, 0), stored('b', 0, 1), stored('c', 0, 2), stored('d', 0, 3), stored('e', 0, 4), stored('f', 0, 5)]
    const merged = mergeRecap(before, reading([0, 0, 0, 0, 0, 0], { asked: 6 }), NOW)
    expect(merged.note).toContain('fit equally well')
    expect(merged.added).toBe(0)
  })

  test('when no shift works at all, nothing is lost and nothing is silently re-attached', () => {
    // Every count has fallen — a different account, or a grid misread. There
    // is no shift of the list that keeps the counts from going backwards.
    const before = [stored('a', 900, 0), stored('b', 2_000, 1), stored('c', 5_000, 2)]
    const merged = mergeRecap(before, reading([3, 7, 11]), NOW)
    expect(merged.note).toContain('could not be lined up')
    expect(merged.added).toBe(3)
    // The old videos are still there, with their last known counts, out of the window.
    expect(merged.videos.filter((v) => v.rank === null).map((v) => v.views)).toEqual([900, 2_000, 5_000])
  })
})

describe('mergeRecap — YouTube, where the title is the identity', () => {
  test('videos are matched by name, so a shift never has to be guessed', () => {
    const before = [stored('a', 100, 0, { title: 'Sunset' }), stored('b', 200, 1, { title: 'Sunrise' })]
    const merged = mergeRecap(before, reading([1, 110, 210], { titles: ['Moonrise', 'Sunset', 'Sunrise'] }), NOW)
    expect(merged.added).toBe(1)
    expect(merged.videos.map((v) => v.key)).toEqual([merged.videos[0]?.key ?? '', 'a', 'b'])
    expect(merged.videos.map((v) => v.title)).toEqual(['Moonrise', 'Sunset', 'Sunrise'])
  })

  test('a title match holds even when the counts would not allow the shift', () => {
    // A count revised down hard. By name there is no doubt which video it is.
    const before = [stored('a', 5_000, 0, { title: 'Sunset' })]
    const merged = mergeRecap(before, reading([12], { titles: ['Sunset'] }), NOW)
    expect(merged.added).toBe(0)
    expect(merged.videos[0]?.key).toBe('a')
    expect(merged.videos[0]?.views).toBe(12)
  })

  test('a platform that stopped giving a title does not erase the one it gave', () => {
    const before = [stored('a', 100, 0, { title: 'Sunset' })]
    const merged = mergeRecap(before, reading([120]), NOW)
    expect(merged.videos[0]?.title).toBe('Sunset')
  })
})

describe('mergeRecap — the small print', () => {
  test('a rounded count that dips slightly is still the same video', () => {
    // `140,1 rb` one day and `140 rb` the next is rounding, not a different video.
    const before = [stored('a', 140_100, 0)]
    const merged = mergeRecap(before, reading([140_000]), NOW)
    expect(merged.added).toBe(0)
    expect(merged.videos[0]?.key).toBe('a')
  })

  test('an empty reading never forgets what was there', () => {
    const before = [stored('a', 5, 0), stored('b', 40, 1)]
    const merged = mergeRecap(before, reading([]), NOW)
    expect(merged.videos.map((v) => v.key)).toEqual(['a', 'b'])
    expect(merged.videos.every((v) => v.rank === null)).toBe(true)
  })

  test('history is capped, oldest dropped first', () => {
    const long = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => i)
    const before = [stored('a', MAX_HISTORY + 9, 0, { history: long })]
    const merged = mergeRecap(before, reading([MAX_HISTORY + 50]), NOW)
    expect(merged.videos[0]?.history.length).toBe(MAX_HISTORY)
    expect(merged.videos[0]?.history[MAX_HISTORY - 1]?.views).toBe(MAX_HISTORY + 50)
  })
})

describe('withinTolerance', () => {
  test('two views of slack at the bottom, two percent higher up', () => {
    expect(withinTolerance(5, 3)).toBe(true)
    expect(withinTolerance(5, 2)).toBe(false)
    expect(withinTolerance(140_100, 138_000)).toBe(true)
    expect(withinTolerance(140_100, 130_000)).toBe(false)
  })
})

describe('mergeRecap — widening the window brings videos back rather than duplicating them', () => {
  /*
    The owner's own question found this (2026-09-21). A six-video window on a
    twelve-video TikTok account, widened to twelve: the six videos that had
    never been reached arrive, AND the one that had fallen out of the window
    arrives again with them. Aligning against the window alone could not see it
    — it was minted as a new video and the account was reported with thirteen
    videos and its views counted twice.
  */
  const account = () => [
    stored('a', 0, 0),
    stored('b', 420, 1),
    stored('c', 73, 2),
    stored('d', 8, 3),
    stored('e', 11, 4),
    stored('f', 71, 5),
    // Pushed out by the newest post, still known, still counted.
    stored('g', 1_655, null, { lastRank: 5 }),
  ]

  test('the video that had fallen out is matched, not minted', () => {
    const merged = mergeRecap(account(), reading([0, 420, 73, 8, 11, 71, 1_655, 1_188, 12_300, 1_120, 118_500, 140_100], { asked: 12 }), NOW)
    expect(merged.videos.length).toBe(12)
    expect(merged.videos[6]?.key).toBe('g')
    expect(merged.videos[6]?.rank).toBe(6)
    expect(merged.added).toBe(5)
  })

  test('its views are counted once', () => {
    const merged = mergeRecap(account(), reading([0, 420, 73, 8, 11, 71, 1_655, 1_188, 12_300, 1_120, 118_500, 140_100], { asked: 12 }), NOW)
    expect(merged.videos.reduce((sum, v) => sum + v.views, 0)).toBe(275_446)
    expect(merged.videos.filter((v) => v.views === 1_655).length).toBe(1)
  })

  test('narrowing the window again pushes them back out, keeping their last counts', () => {
    const wide = mergeRecap(account(), reading([0, 420, 73, 8, 11, 71, 1_655, 1_188, 12_300, 1_120, 118_500, 140_100], { asked: 12 }), NOW)
    const narrow = mergeRecap(wide.videos, reading([0, 420, 73, 8, 11, 71], { asked: 6 }), NOW + DAY)
    expect(narrow.added).toBe(0)
    expect(narrow.videos.length).toBe(12)
    expect(narrow.videos.filter((v) => v.rank === null).length).toBe(6)
    expect(narrow.videos.reduce((sum, v) => sum + v.views, 0)).toBe(275_446)
  })
})

describe('mergeRecap — the length rule is only used when what is stored is everything', () => {
  test('a longer reading after a CAPPED one is not read as new posts at the front', () => {
    // Six stored from a window that filled up, then nine read. Those three extra
    // are videos finally reached at the BACK, not three new posts at the front —
    // and treating them as new would rename every video on the account.
    const before = [stored('a', 0, 0), stored('b', 0, 1), stored('c', 0, 2), stored('d', 0, 3), stored('e', 0, 4), stored('f', 0, 5)]
    const merged = mergeRecap(before, reading([0, 0, 0, 0, 0, 0, 0, 0, 0], { asked: 12, previousComplete: false }), NOW)
    expect(merged.videos.slice(0, 6).map((v) => v.key)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(merged.added).toBe(3)
  })

  test('a reading records whether it covered the whole account', () => {
    expect(mergeRecap([], reading([1, 2, 3], { asked: 6 }), NOW).complete).toBe(true)
    expect(mergeRecap([], reading([1, 2, 3, 4, 5, 6], { asked: 6 }), NOW).complete).toBe(false)
  })
})
