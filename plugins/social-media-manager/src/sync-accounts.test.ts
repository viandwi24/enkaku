import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { YOUTUBE_ACCOUNT_LABELS, onYouTubeYouPage, youtubeAccountChip } from './sync-accounts'

function node(partial: Partial<UiNode>): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.view.ViewGroup',
    packageName: 'com.google.android.youtube',
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...partial,
  }
}

/*
  Rebuilt from the tree a FAILING production run actually saved (job ffa62df6, artifact
  `accounts-youtube-no-you-tab`, 246 nodes, 2026-09-18) — every desc, bounds and `clickable` below is
  copied from it. Rebuilt rather than committed whole because the real dump names the channel and the
  signed-in Google account.

  This is the screen that produced "the YouTube You tab did not open" on roughly thirty phones: the
  tab was open, the phone was signed in as a real channel, and the only thing wrong was that the chip
  is called `Ganti akun` on an Indonesian build.
*/
function indonesianYouPage(): UiNode {
  return node({
    className: 'hierarchy',
    children: [
      node({ desc: 'Lihat channel', text: 'Lihat channel', bounds: { left: 433, top: 258, right: 573, bottom: 288 } }),
      node({
        desc: 'Ganti akun',
        clickable: true,
        bounds: { left: 23, top: 350, right: 214, bottom: 410 },
        children: [node({ desc: 'Ganti akun', text: 'Ganti akun', bounds: { left: 78, top: 365, right: 189, bottom: 395 } })],
      }),
      node({
        desc: 'Akun Google',
        clickable: true,
        bounds: { left: 230, top: 350, right: 442, bottom: 410 },
        children: [node({ desc: 'Akun Google', text: 'Akun Google', bounds: { left: 285, top: 365, right: 417, bottom: 395 } })],
      }),
      node({ desc: 'Bagikan channel', clickable: true, bounds: { left: 801, top: 350, right: 980, bottom: 410 } }),
      node({ desc: 'Anda', clickable: true, bounds: { left: 576, top: 1472, right: 720, bottom: 1556 } }),
    ],
  })
}

/** The English build, which worked all along — `Accounts`, measured on the owner's moto g06 (0.45.0). */
function englishYouPage(): UiNode {
  return node({
    className: 'hierarchy',
    children: [
      node({ desc: 'View channel', text: 'View channel', bounds: { left: 28, top: 335, right: 353, bottom: 391 } }),
      node({ desc: 'Accounts', clickable: true, bounds: { left: 21, top: 84, right: 190, bottom: 140 } }),
      node({ desc: 'You', clickable: true, bounds: { left: 576, top: 1472, right: 720, bottom: 1556 } }),
    ],
  })
}

describe('the YouTube You page account chip (2026-09-18)', () => {
  test('the Indonesian build\'s chip is found — the thirty-phone failure, in one assertion', () => {
    const chip = youtubeAccountChip(indonesianYouPage())
    expect(chip?.desc).toBe('Ganti akun')
    expect(chip?.clickable).toBe(true)
  })

  test('the English build still works', () => {
    expect(youtubeAccountChip(englishYouPage())?.desc).toBe('Accounts')
  })

  /**
   * The reason the match is exact rather than a substring on "akun".
   *
   * `Akun Google` is clickable and sits 16 px from the real chip; it opens Google's account
   * settings, not YouTube's account sheet. A loose match would find it on this very screen — and on
   * the English page there is no such trap, so only the Indonesian capture can prove this.
   */
  test('never taps the Google Account chip beside it', () => {
    expect(youtubeAccountChip(indonesianYouPage())?.desc).not.toBe('Akun Google')
  })

  test('a screen with no account chip at all answers null', () => {
    expect(youtubeAccountChip(node({ className: 'hierarchy' }))).toBeNull()
  })
})

describe('telling "the tab never opened" apart from "the chip has an unknown name"', () => {
  test('both real You pages are recognised as the You page', () => {
    expect(onYouTubeYouPage(indonesianYouPage())).toBe(true)
    expect(onYouTubeYouPage(englishYouPage())).toBe(true)
  })

  /**
   * The case the new message exists for: the page IS open, but its chip carries a spelling this pack
   * has never measured. The run must say that, not "the You tab did not open" — that wrong name is
   * what sent this investigation to the reader, twice, across two separate versions.
   */
  test('a You page whose chip has an unknown name is still the You page', () => {
    const odd = node({
      className: 'hierarchy',
      children: [
        node({ desc: 'Lihat channel', text: 'Lihat channel', bounds: { left: 433, top: 258, right: 573, bottom: 288 } }),
        node({ desc: 'Pilih akun lain', clickable: true, bounds: { left: 23, top: 350, right: 214, bottom: 410 } }),
      ],
    })
    expect(onYouTubeYouPage(odd)).toBe(true)
    expect(youtubeAccountChip(odd)).toBeNull()
  })

  test('a screen that is not the You page is not mistaken for it', () => {
    const home = node({ className: 'hierarchy', children: [node({ desc: 'Beranda', clickable: true, bounds: { left: 0, top: 1472, right: 144, bottom: 1556 } })] })
    expect(onYouTubeYouPage(home)).toBe(false)
  })
})

describe('the label list itself', () => {
  test('carries every spelling measured on hardware', () => {
    expect([...YOUTUBE_ACCOUNT_LABELS]).toEqual(['Akun', 'Account', 'Accounts', 'Ganti akun', 'Switch account'])
  })
})
