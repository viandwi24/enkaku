import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import type { UiNode } from '@enkaku/protocol'
import { foreignAppOnTop, googleAccountPageOnTop, pictureInPictureOnly } from './youtube'

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

function node(partial: Partial<UiNode>): UiNode {
  return { resourceId: '', text: '', desc: '', className: 'android.widget.FrameLayout', packageName: '', bounds: { left: 0, top: 0, right: 0, bottom: 0 }, clickable: false, enabled: true, focused: false, index: 0, children: [], ...partial }
}

/**
 * The shape of the production dump (2026-09-15, run c4a3bd07, SM-A075F 720x1600): gms containers
 * covering the screen with no text at all, the status bar and navigation bar from System UI, and
 * not one YouTube node. Rebuilt by hand — the real dump names the account.
 */
function accountPage(): UiNode {
  const gms = (children: UiNode[] = []): UiNode => node({ packageName: 'com.google.android.gms', bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, children })
  return node({
    className: 'hierarchy',
    children: [
      gms([gms([gms([gms([gms()])])])]),
      node({ packageName: 'com.android.systemui', text: '12.43', bounds: { left: 14, top: 20, right: 96, bottom: 50 } }),
      node({ packageName: 'com.android.systemui', desc: 'Kembali', clickable: true, bounds: { left: 83, top: 1520, right: 221, bottom: 1600 } }),
    ],
  })
}

describe('googleAccountPageOnTop', () => {
  test('a screen-covering Play services page with no YouTube node is recognised', () => {
    expect(googleAccountPageOnTop(accountPage())).toBe(true)
  })

  test('a Play services window that does not cover the screen is not (an account chooser sheet over YouTube)', () => {
    const tree = accountPage()
    const sheet = node({ packageName: 'com.google.android.gms', bounds: { left: 0, top: 900, right: 720, bottom: 1600 } })
    const youtube = node({ packageName: 'com.google.android.youtube', desc: 'Beranda', bounds: { left: 0, top: 1450, right: 144, bottom: 1520 } })
    expect(googleAccountPageOnTop({ ...tree, children: [youtube, sheet] })).toBe(false)
  })

  test('no screen this pack walks is mistaken for it', async () => {
    const names = readdirSync(new URL('./__fixtures__/', import.meta.url)).filter((f) => f.endsWith('.json'))
    expect(names.length).toBeGreaterThan(10)
    for (const name of names) {
      expect({ name, page: googleAccountPageOnTop(await fixture(name)) }).toEqual({ name, page: false })
    }
  })
})

describe('pictureInPictureOnly', () => {
  // The shape of production phone #8's dump (2026-09-15, run a1bff0a5): the launcher across the screen and
  // every YouTube node inside the PiP box. Rebuilt by hand with only packages and bounds.
  function pip(): UiNode {
    const box = { left: 467, top: 1084, right: 690, bottom: 1480 }
    const yt = (children: UiNode[] = []): UiNode => node({ packageName: 'com.google.android.youtube', bounds: box, children })
    return node({
      className: 'hierarchy',
      children: [
        node({ packageName: 'com.sec.android.app.launcher', bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, children: [node({ packageName: 'com.sec.android.app.launcher', desc: 'YouTube', bounds: { left: 380, top: 590, right: 520, bottom: 740 } })] }),
        yt([yt([yt()])]),
        node({ packageName: 'com.android.systemui', text: '14.44', bounds: { left: 14, top: 20, right: 96, bottom: 50 } }),
      ],
    })
  }

  test('YouTube drawn only inside a small box over the launcher is picture-in-picture', () => {
    expect(pictureInPictureOnly(pip())).toBe(true)
  })

  test('YouTube full screen is not, and neither is a tree with no YouTube at all', () => {
    const full = node({ className: 'hierarchy', children: [node({ packageName: 'com.google.android.youtube', bounds: { left: 0, top: 0, right: 720, bottom: 1600 } })] })
    expect(pictureInPictureOnly(full)).toBe(false)
    expect(pictureInPictureOnly(accountPage())).toBe(false)
  })

  test('no screen this pack walks is mistaken for it', async () => {
    const names = readdirSync(new URL('./__fixtures__/', import.meta.url)).filter((f) => f.endsWith('.json'))
    for (const name of names) {
      expect({ name, pip: pictureInPictureOnly(await fixture(name)) }).toEqual({ name, pip: false })
    }
  })
})

/*
  0.39.14 — the Play Store sheet that cost five members in one matrix.

  Rebuilt from the dumps two of those failures saved on the owner's moto g06 (2026-09-17,
  `yt-drafts-no-you-tab` and `yt-01-home`, 150 and 151 nodes): NOT ONE YouTube node, packages
  `['com.android.systemui', 'com.android.vending']`, and the MIFX listing's own words.

  A search results page carries sponsored install cards; a tap reached one, Google Play opened over
  YouTube, and nothing closed it. Every member afterwards failed at its first step blaming something
  else — "no search button", "the Shorts tab was not on the bottom navigation", no "Anda" tab, no
  Create ("Buat") button "usually a signed-out YouTube". Five accusations, one cause, and the suite
  was 134 green before this fix and 134 after: nothing here could see it.
*/
function playStoreSheet(): UiNode {
  const play = (children: UiNode[] = []): UiNode =>
    node({ packageName: 'com.android.vending', bounds: { left: 0, top: 0, right: 720, bottom: 1640 }, children })
  return node({
    className: 'hierarchy',
    children: [
      play([play([node({ packageName: 'com.android.vending', text: 'Platform trading forex dan komoditas', bounds: { left: 40, top: 900, right: 680, bottom: 960 } })])]),
      node({ packageName: 'com.android.vending', desc: 'Tutup sheet', clickable: true, bounds: { left: 24, top: 120, right: 96, bottom: 192 } }),
      node({ packageName: 'com.android.systemui', text: '07.23', bounds: { left: 14, top: 20, right: 98, bottom: 50 } }),
      node({ packageName: 'com.android.systemui', desc: 'Kembali', clickable: true, bounds: { left: 83, top: 1556, right: 221, bottom: 1640 } }),
    ],
  })
}

/** An ordinary YouTube home screen: its own package, full screen, with the bottom bar drawn. */
function youtubeHome(): UiNode {
  const yt = (partial: Partial<UiNode>): UiNode => node({ packageName: 'com.google.android.youtube', ...partial })
  return node({
    className: 'hierarchy',
    children: [
      yt({ bounds: { left: 0, top: 0, right: 720, bottom: 1640 }, children: [yt({ desc: 'Search', clickable: true, bounds: { left: 622, top: 72, right: 720, bottom: 170 } })] }),
      yt({ desc: 'Home', clickable: true, bounds: { left: 0, top: 1470, right: 144, bottom: 1556 } }),
      yt({ desc: 'Shorts', clickable: true, bounds: { left: 144, top: 1470, right: 288, bottom: 1556 } }),
      node({ packageName: 'com.android.systemui', desc: 'Kembali', clickable: true, bounds: { left: 83, top: 1556, right: 221, bottom: 1640 } }),
    ],
  })
}

describe('foreignAppOnTop — one cause behind five different accusations (0.39.14)', () => {
  test('a screen-covering Play Store sheet with no YouTube node is recognised', () => {
    expect(foreignAppOnTop(playStoreSheet())).toBe('com.android.vending')
  })

  test('an ordinary YouTube home screen is NOT — a guard that fires here would relaunch a healthy run', () => {
    expect(foreignAppOnTop(youtubeHome())).toBeNull()
  })

  test('the System UI alone never counts as a foreign app', () => {
    const barsOnly = node({
      className: 'hierarchy',
      children: [
        node({ packageName: 'com.android.systemui', bounds: { left: 0, top: 0, right: 720, bottom: 1640 } }),
        node({ packageName: 'com.android.systemui', desc: 'Kembali', clickable: true, bounds: { left: 83, top: 1556, right: 221, bottom: 1640 } }),
      ],
    })
    expect(foreignAppOnTop(barsOnly)).toBeNull()
  })

  test('the launcher standing alone IS caught — that is YouTube never having started', () => {
    const launcher = node({
      className: 'hierarchy',
      children: [
        node({ packageName: 'com.motorola.launcher3', bounds: { left: 0, top: 0, right: 720, bottom: 1640 } }),
        node({ packageName: 'com.android.systemui', text: '05.29', bounds: { left: 14, top: 20, right: 98, bottom: 50 } }),
      ],
    })
    expect(foreignAppOnTop(launcher)).not.toBeNull()
  })

  test('the Play sheet is not mistaken for the two guards that could not see it', () => {
    // `pictureInPictureOnly` returns false at its first line with no YouTube nodes, and
    // `googleAccountPageOnTop` looks for `com.google.android.gms`, not `com.android.vending`.
    // Asserted so a future widening of either cannot quietly absorb this case and hide why it exists.
    expect(pictureInPictureOnly(playStoreSheet())).toBe(false)
    expect(googleAccountPageOnTop(playStoreSheet())).toBe(false)
  })
})
