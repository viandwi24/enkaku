import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import shorts from './__fixtures__/screen-channel-shorts-grid.json'
import videos from './__fixtures__/screen-channel-videos-list.json'
import own from './__fixtures__/screen-channel-own-empty.json'
import { channelTab, channelTabs, readChannelPage } from './my-videos'

/*
  Three captures off the owner's moto g06 power, `en-US`, 2026-09-21: a
  channel's Shorts grid, the same channel's Videos list, and the owner's OWN
  channel — which has a Shorts tab holding nothing but Drafts.
*/
const shortsTab = shorts as unknown as UiNode
const videosTab = videos as unknown as UiNode
const ownChannel = own as unknown as UiNode

describe('readChannelPage — the Shorts grid', () => {
  test('title and view count come out of the one description', () => {
    const read = readChannelPage(shortsTab, 'shorts')
    expect(read.map((v) => v.title)).toEqual([
      '2026 Solar Eclipse @ 50,000 Feet',
      '2026 Total Solar Eclipse Over Spain',
      'NASA Moon Base Update (Aug. 4, 2026)',
      'The Ultimate Away Game: World Cup Fever on the ISS \u{1F30C}\u{1F3C6}',
      "Get Unready With NASA's Artemis II Astronauts",
      "Six Years of NASA's Mars Curiosity Rover",
    ])
    expect(read.map((v) => v.views)).toEqual([246_000, 178_000, 179_000, 223_000, 318_000, 233_000])
  })

  test('a title carrying its own numbers is not mistaken for the count', () => {
    // "2026 Solar Eclipse @ 50,000 Feet" holds a year AND an altitude; the
    // count belongs to the word "views" and nowhere else.
    const first = readChannelPage(shortsTab, 'shorts')[0]
    expect(first?.views).toBe(246_000)
    expect(first?.approx).toBe(true)
  })

  test('a title with a comma in it keeps the comma', () => {
    expect(readChannelPage(shortsTab, 'shorts')[2]?.title).toBe('NASA Moon Base Update (Aug. 4, 2026)')
  })

  test('the Shorts layout has no age to report', () => {
    expect(readChannelPage(shortsTab, 'shorts').every((v) => v.age === '')).toBe(true)
  })

  test('ranks follow the grid: left to right, then down', () => {
    expect(readChannelPage(shortsTab, 'shorts').map((v) => v.rank)).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('readChannelPage — the Videos list', () => {
  test('the title is the first field, not the whole sentence', () => {
    const read = readChannelPage(videosTab, 'videos')
    expect(read.map((v) => v.title)).toEqual([
      'NASA Moon Base: The First Six Months',
      'What It Takes',
      'Artemis III: Our Next Step Back to the Moon',
      'For Earth, With Love: Artemis II',
    ])
  })

  test('views and age both come off the row', () => {
    const read = readChannelPage(videosTab, 'videos')
    expect(read.map((v) => v.views)).toEqual([482_000, 308_000, 144_000, 429_000])
    expect(read.map((v) => v.age)).toEqual(['12 days ago', '2 weeks ago', '2 weeks ago', '2 weeks ago'])
  })

  test('the duration field is not read as a view count', () => {
    // `... - 1 minute, 7 seconds - ...` sits before the count in every row.
    expect(readChannelPage(videosTab, 'videos')[0]?.views).toBe(482_000)
  })
})

describe('channelTabs', () => {
  test('a public channel lists every tab it has', () => {
    expect(channelTabs(videosTab).map((n) => n.desc)).toEqual(['Home', 'Videos', 'Shorts', 'Live', 'Podcasts', 'Playlists'])
  })

  test("the owner's own channel has only Shorts and Posts — no Videos tab at all", () => {
    // Which is why `auto` prefers Shorts and falls back, rather than assuming Videos exists.
    expect(channelTabs(ownChannel).map((n) => n.desc)).toEqual(['Shorts', 'Posts'])
    expect(channelTab(ownChannel, 'videos')).toBe(null)
    expect(channelTab(ownChannel, 'shorts')?.desc).toBe('Shorts')
  })
})

describe('readChannelPage — a channel that has posted nothing', () => {
  test('an empty Shorts tab reads as no videos, not as an error', () => {
    expect(readChannelPage(ownChannel, 'shorts')).toEqual([])
  })
})
