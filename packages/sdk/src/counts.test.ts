import { describe, expect, test } from 'bun:test'
import { countBefore, countOf, parseCount } from './counts'

/*
  Every form below was read off the owner's moto g06 power on 2026-09-21 and is
  named with the screen it came from. Nothing here is invented: a count format
  this repo has not seen is a count format this repo does not claim to read.
*/

describe('parseCount — exact numbers carry no magnitude word', () => {
  test('a bare count is itself', () => {
    expect(parseCount('420')).toEqual({ value: 420, approx: false })
    expect(parseCount('8')).toEqual({ value: 8, approx: false })
  })

  test('TikTok id-ID groups thousands with a dot', () => {
    // `tv_play_count` on the profile grid: 1.655 plays, not one point six.
    expect(parseCount('1.655')).toEqual({ value: 1655, approx: false })
    expect(parseCount('1.188')).toEqual({ value: 1188, approx: false })
  })

  test('an English grouping comma means the same thing', () => {
    expect(parseCount('1,234')).toEqual({ value: 1234, approx: false })
    expect(parseCount('12,345,678')).toEqual({ value: 12345678, approx: false })
  })
})

describe('parseCount — a magnitude word means the number was rounded', () => {
  test('id-ID "rb" with a decimal comma', () => {
    // TikTok profile grid, `140,1 rb` — a non-breaking space before the word.
    expect(parseCount('140,1 rb')).toEqual({ value: 140_100, approx: true })
    expect(parseCount('1,2 rb')).toEqual({ value: 1_200, approx: true })
    expect(parseCount('999 rb')).toEqual({ value: 999_000, approx: true })
  })

  test('id-ID millions and billions', () => {
    expect(parseCount('2,4 jt')).toEqual({ value: 2_400_000, approx: true })
    expect(parseCount('1,5 miliar')).toEqual({ value: 1_500_000_000, approx: true })
  })

  test('YouTube en-US spells the word out', () => {
    // Channel Videos tab: `... - 482 thousand views - 12 days ago - play video`.
    expect(parseCount('482 thousand')).toEqual({ value: 482_000, approx: true })
    expect(parseCount('1.2 million')).toEqual({ value: 1_200_000, approx: true })
  })

  test('the compact English suffixes', () => {
    expect(parseCount('1.2K')).toEqual({ value: 1_200, approx: true })
    expect(parseCount('3.4M')).toEqual({ value: 3_400_000, approx: true })
    expect(parseCount('1.1B')).toEqual({ value: 1_100_000_000, approx: true })
  })

  test('a grouped number with a magnitude word keeps the grouping', () => {
    // `1.234,5 jt` — three separators, only the last one is a decimal point.
    expect(parseCount('1.234,5 jt')).toEqual({ value: 1_234_500_000, approx: true })
  })
})

describe('parseCount — the number is found inside the sentence around it', () => {
  test('TikTok video page, id-ID', () => {
    expect(countOf('8 penayangan')).toBe(8)
  })

  test('Instagram profile Reels tab', () => {
    // `preview_clip_thumbnail`: "Reel by bitorex.bkk. View Count 140. Double tap to play or pause."
    expect(countOf('View Count 140.')).toBe(140)
  })

  test('a title with its own numbers is exactly why `parseCount` must not be handed a sentence', () => {
    // A real YouTube Shorts cell. `parseCount` reads the FIRST number it finds,
    // which here is the year in the title — the caller's job is to hand it the
    // right fragment, and `countBefore` below is how.
    expect(countOf('2026 Solar Eclipse @ 50,000 Feet, 246 thousand views - play Short')).toBe(2026)
  })
})

describe('parseCount — nothing to read', () => {
  test('no digits at all', () => {
    expect(parseCount('Drafts')).toEqual({ value: null, approx: false })
    expect(parseCount('')).toEqual({ value: null, approx: false })
  })
})

describe('countBefore — the count that belongs to a word', () => {
  const VIEWS = /views?|penayangan|kali ditonton/i

  test('reads past a title that carries its own numbers', () => {
    expect(countBefore('2026 Solar Eclipse @ 50,000 Feet, 246 thousand views - play Short', VIEWS)).toEqual({ value: 246_000, approx: true })
  })

  test('a YouTube Videos row', () => {
    const row = 'NASA Moon Base: The First Six Months - 1 minute, 7 seconds - Go to channel - NASA - 482 thousand views - 12 days ago - play video'
    expect(countBefore(row, VIEWS)).toEqual({ value: 482_000, approx: true })
  })

  test('an exact count keeps its grouping', () => {
    expect(countBefore('Some title - 1,234 views - 2 days ago', VIEWS)).toEqual({ value: 1_234, approx: false })
  })

  test('the label appearing in the title does not win — the last one does', () => {
    expect(countBefore('How many views is a lot? - 12 thousand views - play video', VIEWS)).toEqual({ value: 12_000, approx: true })
  })

  test('no label, no reading', () => {
    expect(countBefore('Drafts', VIEWS)).toEqual({ value: null, approx: false })
  })
})
