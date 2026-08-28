import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { adEvidence, channelPageEvidence, hasResultRows, pickChannelRow, playerEvidence, readChannelTitle, resultRowsOf, screenHeightOf, skipControlOf, titleFromRow, videoRowsOf } from './search-channel'

/**
 * Every fixture in this file is a REAL tree, dumped off a real device during
 * the session that built this member (moto g06 power, 720×1640, Android 15,
 * YouTube in Indonesian, 2026-08-26). None of it is hand-written, because every
 * defect this member had came from a hand-written idea of what the screen looks
 * like:
 *
 * - `screen-results.json`         a loaded search-results page for "eno bening"
 * - `screen-results-loading.json` the SAME page mid-load: four thumbnails, no text
 * - `screen-channel.json`         the Eno Bening channel page that was reached
 * - `screen-suggestions.json`     the search-suggestions screen, keyboard open
 *
 * The loading fixture is the valuable one. It is the exact page three separate
 * readiness tests each declared "ready", and it is what turns "wait longer"
 * into a regression test.
 */
const load = (name: string): UiNode => require(`./__fixtures__/${name}.json`) as UiNode

const results = load('screen-results')
const loading = load('screen-results-loading')
const channel = load('screen-channel')
const suggestions = load('screen-suggestions')

describe('screenHeightOf', () => {
  test("does not trust the root's own bounds, which are all zeros", () => {
    // The bug this exists for: `tree.bounds.bottom` is 0 on a dump root, so a
    // content band derived from it computed to −200 and rejected every node on
    // the screen.
    expect(results.bounds.bottom).toBe(0)
    expect(screenHeightOf(results)).toBe(1640)
  })
})

describe('hasResultRows — the readiness test that three earlier versions got wrong', () => {
  test('a loaded results page is ready', () => {
    expect(hasResultRows(results)).toBe(true)
  })

  test('a page carrying four thumbnails and no readable text is NOT ready', () => {
    // Thumbnails render before their labels. Waiting on them declared this page
    // ready in 0 ms, and the channel search then ran against a blank screen.
    expect(resultRowsOf(loading).length).toBeGreaterThan(0)
    expect(hasResultRows(loading)).toBe(false)
  })

  test("the bottom navigation alone is not results — it is clickable and captioned, and that is what fooled 0.1.3", () => {
    const labels = flatten(loading)
      .map((n) => `${n.text} ${n.desc}`.trim())
      .filter(Boolean)
    expect(labels.some((l) => l.includes('Beranda'))).toBe(true)
    expect(hasResultRows(loading)).toBe(false)
  })

  test('the suggestions screen is not a results page', () => {
    expect(hasResultRows(suggestions)).toBe(false)
  })
})

describe('pickChannelRow', () => {
  test('finds the channel row by its own "Buka channel" control, not a video by the channel', () => {
    const picked = pickChannelRow(results, 'eno bening')
    expect(picked?.via.startsWith('open-channel:')).toBe(true)
    expect(picked?.node.clickable).toBe(true)
  })

  /**
   * The 0.1.1 defect, pinned. A search for "eno bening" leaves "eno bening" in
   * the search bar, so a title match hit `:id/search_query`, tapped it, and
   * reopened the suggestions screen — a wrong tap that looks like no tap.
   */
  test('never returns the search bar, even though it carries the query verbatim', () => {
    const picked = pickChannelRow(results, 'eno bening')
    expect(picked?.node.resourceId).not.toContain('search_query')
    expect(picked?.node.bounds.top).toBeGreaterThan(160)
  })

  test('returns null on a page with no channel on it rather than picking something', () => {
    expect(pickChannelRow(loading, 'eno bening')).toBeNull()
  })
})

describe('channelPageEvidence', () => {
  test('the real channel page is recognised, and says what proved it', () => {
    const evidence = channelPageEvidence(channel)
    expect(evidence.onChannel).toBe(true)
    expect(evidence.via).toBe('subscribe-control')
  })

  test('a results page is not a channel page', () => {
    expect(channelPageEvidence(results).onChannel).toBe(false)
  })

  test('the suggestions screen is not a channel page — this is what 0.1.0 reported reaching', () => {
    expect(channelPageEvidence(suggestions).onChannel).toBe(false)
  })
})

describe('readChannelTitle', () => {
  /**
   * The whole reason this function was rewritten. "Largest text node" is a
   * reasonable-sounding heuristic that returned **"Beranda"** — the channel's
   * own Home tab — on the first real channel page, because a tab strip draws
   * bigger text than the toolbar title. A confident, plausible, wrong answer.
   */
  test('reads the channel name from the subscribe control, with its real capitalisation', () => {
    expect(readChannelTitle(channel)).toBe('Eno Bening')
  })

  test('never returns a tab label', () => {
    expect(['Beranda', 'Video', 'Shorts', 'Live', 'Podcast', 'Playlist']).not.toContain(readChannelTitle(channel))
  })

  test('a page with no channel on it yields an empty string, never a guess', () => {
    expect(readChannelTitle(loading)).toBe('')
  })
})

function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = [root]
  for (const child of root.children) out.push(...flatten(child))
  return out
}

// ---------------------------------------------------------------------------
// Watching a video (0.3.0–0.4.2). Same discipline: every fixture is a real tree
// from the device, and every test below pins a defect that a real run produced.
// ---------------------------------------------------------------------------

const videos = load('screen-videos')
const playerAd = load('screen-player-ad')
const playerVideo = load('screen-player-video')
const fabOnly = load('screen-results-fab-only')
const subscriptionTab = load('screen-subscription-tab')

describe('hasResultRows — a lone floating control is not a results page', () => {
  /**
   * The intermittent one, and the nastiest. YouTube's microphone FAB floats
   * OVER the content at roughly two-thirds down the screen, so it sits inside
   * the content band by geometry. On a results page that had loaded nothing
   * else it was the single readable node in the band — and "results are ready"
   * fired on a blank page, for two runs out of three.
   */
  test('a page whose only in-band label is the floating mic is not ready', () => {
    expect(hasResultRows(fabOnly)).toBe(false)
  })

  test('a real results page still is', () => {
    expect(hasResultRows(results)).toBe(true)
  })
})

describe('videoRowsOf', () => {
  test("finds the channel's video rows by their duration, which nothing else on the page carries", () => {
    expect(videoRowsOf(videos).length).toBeGreaterThanOrEqual(3)
  })

  /**
   * The defect only `watch: 'random'` could ever reach. A row at the bottom of
   * the list had its TOP inside the content band and its CENTRE underneath the
   * navigation bar, so tapping its centre landed on "Subscription". `latest` is
   * always row 0 and never touched it.
   */
  test('every row it returns can actually be tapped — centre above the navigation bar', () => {
    const height = screenHeightOf(videos)
    for (const row of videoRowsOf(videos)) {
      const centreY = (row.bounds.top + row.bounds.bottom) / 2
      expect(centreY).toBeLessThan(height - 200)
      expect(centreY).toBeGreaterThan(160)
    }
  })

  test('the channel page itself has no video rows — the Video tab has to be opened first', () => {
    expect(videoRowsOf(channel).length).toBe(0)
  })
})

describe('titleFromRow', () => {
  test("takes the title from the row's own one-line description", () => {
    const row = videoRowsOf(videos).find((n) => n.desc.includes('GTA VI'))
    expect(row).toBeDefined()
    expect(titleFromRow(row as UiNode)).toBe('Situasi GTA VI Yang Semakin Bocor')
  })

  test('strips a leading badge symbol, which a live row renders as part of the label', () => {
    expect(titleFromRow({ ...(videos as UiNode), desc: '\u{1F534}Ngobrol Sebelum Mabar - 1 jam - Buka channel', text: '' } as UiNode)).toBe('Ngobrol Sebelum Mabar')
  })

  test('a row with nothing parseable yields an empty string, never a guess', () => {
    expect(titleFromRow({ ...(videos as UiNode), desc: '', text: '' } as UiNode)).toBe('')
  })
})

describe('adEvidence', () => {
  test('a pre-roll advert is detected by the player overlay ids', () => {
    expect(adEvidence(playerAd)).toEqual({ ad: true, via: 'id:ad_progress_text' })
  })

  /**
   * The correction that mattered. A free-text rung for "bersponsor" matched a
   * **sponsored card in the recommendations feed below the video**, which never
   * goes away: the pre-roll had finished at six seconds and the wait ran its
   * full 90-second budget before reporting a timeout on an advert long over.
   */
  test('a sponsored card in the feed below a playing video is NOT an advert', () => {
    const sponsored = flatten(playerVideo).some((n) => `${n.text} ${n.desc}`.toLowerCase().includes('bersponsor'))
    expect(sponsored).toBe(true)
    expect(adEvidence(playerVideo).ad).toBe(false)
  })
})

describe('playerEvidence', () => {
  test('a player is recognised by its own id, advert or not', () => {
    expect(playerEvidence(playerAd).playing).toBe(true)
    expect(playerEvidence(playerVideo).playing).toBe(true)
  })

  /**
   * The `random` failure, pinned: a mis-aimed tap landed on the Subscription
   * tab, and the run correctly refused to call that "watched".
   */
  test("the Subscription tab is not a player — a mis-aimed tap must not read as success", () => {
    expect(playerEvidence(subscriptionTab).playing).toBe(false)
  })

  test('a channel page is not a player', () => {
    expect(playerEvidence(channel).playing).toBe(false)
  })
})

describe('skipControlOf', () => {
  test('finds nothing to press on a page with no advert', () => {
    expect(skipControlOf(playerVideo)).toBeNull()
  })

  test("never returns the advert's own call to action", () => {
    // The advert fixture carries "Kunjungi pengiklan" and "Pelajari
    // selengkapnya". This script presses YouTube's dismiss control and nothing
    // else about the advert.
    const found = skipControlOf(playerAd)
    const labelOf = (n: UiNode) => `${n.text} ${n.desc}`.toLowerCase()
    if (found) {
      expect(labelOf(found)).not.toContain('kunjungi pengiklan')
      expect(labelOf(found)).not.toContain('pelajari selengkapnya')
    }
  })
})
