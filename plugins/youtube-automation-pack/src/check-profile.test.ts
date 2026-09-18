import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { accountNameOf, hasSettingsGear, onYouPage, profileRows, youTabOf } from './check-profile'

const load = (name: string): UiNode => require(`./__fixtures__/${name}.json`) as UiNode

function node(partial: Partial<UiNode>): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.FrameLayout',
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
  TWO real captures of the same screen, in two languages — which is the whole
  reason this member's anchors are patterns rather than strings:

  - `screen-you.json`    the pack's existing INDONESIAN capture (`Anda`, `Akun`,
                         `Lihat channel`, `Setelan`, `Koleksi`, `Download`);
  - `screen-you-en.json` the owner's moto g06 power in ENGLISH, 720x1640,
                         2026-09-18, 151 nodes (`You`, `Accounts`,
                         `View channel`, `Settings`, `History`, `Downloads`).

  Asserting only against the English one would have shipped a member that works
  on half this farm. Both are asserted below, deliberately.

  `screen-you.json` is also a file this session nearly destroyed: the English
  capture was first written OVER it, because an `ls` truncated at twenty entries
  hid it and the new name looked free. `post-video.test.ts` caught it — its
  `viewChannelTarget` test pins `Lihat channel` at an exact point in that very
  fixture. Hence the separate `-en` name rather than a replacement.
*/

describe('youTabOf — the last nav item, not a word elsewhere on the page', () => {
  test('finds the tab on the English capture', () => {
    expect(youTabOf(load('screen-you-en'))?.desc).toBe('You')
  })

  /** The same screen in Indonesian names the tab `Anda`. Both are real captures. */
  test('finds the tab on the Indonesian capture', () => {
    expect(youTabOf(load('screen-you'))?.desc).toBe('Anda')
  })

  /**
   * The band matters: "You" is a short, common word. A page that happens to
   * carry it in a row heading must not be mistaken for the navigation item, so
   * the match is bounded to the bottom band rather than taken from anywhere.
   */
  test('a clickable "You" above the nav band is not the tab', () => {
    const tree = node({
      className: 'hierarchy',
      children: [
        node({ desc: 'You', clickable: true, bounds: { left: 0, top: 400, right: 300, bottom: 460 } }),
        node({ desc: 'Home', clickable: true, bounds: { left: 0, top: 1472, right: 144, bottom: 1556 } }),
      ],
    })
    expect(youTabOf(tree)).toBeNull()
  })

  /**
   * The notifications screen carries the SAME bottom navigation, so the tab is
   * found there too — that is correct, not a miss. Asserting `null` here would
   * have been a test written from an assumption about which screens have a nav,
   * rather than from the capture, which plainly shows one.
   */
  test('the tab is found on any screen carrying the bottom navigation', () => {
    expect(youTabOf(load('screen-notifications-empty'))?.desc).toBe('You')
  })

  test('a tree with no navigation at all answers null', () => {
    expect(youTabOf(node({ className: 'hierarchy' }))).toBeNull()
  })
})

describe('onYouPage — both halves required', () => {
  test('both real captures are recognised, in either language', () => {
    expect(onYouPage(load('screen-you-en'))).toBe(true)
    expect(onYouPage(load('screen-you'))).toBe(true)
  })

  test('the notifications screen is not', () => {
    expect(onYouPage(load('screen-notifications-empty'))).toBe(false)
  })

  test('the home screen is not', () => {
    expect(onYouPage(load('screen-home'))).toBe(false)
  })

  /**
   * `Accounts` alone is the account-switcher sheet, which is NOT this page.
   * Accepting it would let a run report a profile it never reached.
   */
  test('Accounts without View channel is the switcher sheet, not the page', () => {
    const tree = node({ className: 'hierarchy', children: [node({ desc: 'Accounts', clickable: true })] })
    expect(onYouPage(tree)).toBe(false)
  })
})

describe('accountNameOf', () => {
  test('reads the account name off the English capture', () => {
    expect(accountNameOf(load('screen-you-en'))).toBe('Hendi sunadi')
  })

  /** The Indonesian capture is anonymised in the repo; the header position is what is being pinned. */
  test('reads the account name off the Indonesian capture', () => {
    expect(accountNameOf(load('screen-you'))).toBe('Channel Name')
  })

  /** Signed out is REPORTED, not thrown — a signed-out farm phone is news, not an error. */
  test('a page with no account name reads empty rather than guessing', () => {
    const tree = node({
      className: 'hierarchy',
      children: [
        node({ desc: 'Accounts', clickable: true, bounds: { left: 21, top: 84, right: 190, bottom: 140 } }),
        node({ desc: 'View channel', clickable: true, bounds: { left: 28, top: 335, right: 353, bottom: 391 } }),
      ],
    })
    expect(accountNameOf(tree)).toBe('')
  })

  /** `View channel` sits in the same band and must never be mistaken for the name. */
  test('never returns a page control as the account name, in either language', () => {
    expect(accountNameOf(load('screen-you-en'))).not.toBe('View channel')
    expect(accountNameOf(load('screen-you-en'))).not.toBe('Get Premium')
    expect(accountNameOf(load('screen-you'))).not.toBe('Lihat channel')
    expect(accountNameOf(load('screen-you'))).not.toBe('Dapatkan Premium')
  })

  /**
   * The case the two captures cannot prove, and the reason the `View channel`
   * guard is not dead code.
   *
   * In both real captures the clickable `View channel` sits at top=335, which
   * the header bound already excludes — so removing the guard changes nothing
   * there, and a test asserting only against them passes either way. But the
   * production Samsung build makes the HEADER ROW itself clickable and the
   * label non-clickable; that is exactly what `screen-you-label-row.json`
   * records for `viewChannelTarget`. On a build shaped that way a clickable
   * `View channel` can precede the name in the walk, and without the guard the
   * member would report the button as the account.
   */
  test('a clickable View channel ahead of the name is still not the account', () => {
    const tree = node({
      className: 'hierarchy',
      children: [
        node({ desc: 'Accounts', clickable: true, bounds: { left: 21, top: 84, right: 190, bottom: 140 } }),
        node({ desc: 'View channel', clickable: true, bounds: { left: 23, top: 160, right: 697, bottom: 220 } }),
        node({ desc: 'Hendi sunadi', clickable: true, bounds: { left: 182, top: 230, right: 692, bottom: 282 } }),
      ],
    })
    expect(accountNameOf(tree)).toBe('Hendi sunadi')
  })
})

describe('hasSettingsGear — reported, never pressed', () => {
  test('both captures have the gear — `Settings` and `Setelan`', () => {
    expect(hasSettingsGear(load('screen-you-en'))).toBe(true)
    expect(hasSettingsGear(load('screen-you'))).toBe(true)
  })

  test('the notifications screen does not', () => {
    expect(hasSettingsGear(load('screen-notifications-empty'))).toBe(false)
  })
})

describe('profileRows', () => {
  test('reads the page rows off the English capture', () => {
    const rows = profileRows(load('screen-you-en'), 25)
    expect(rows).toContain('History')
    expect(rows).toContain('Downloads')
    expect(rows.some((r) => /Watch later/.test(r))).toBe(true)
  })

  /** Indonesian names the same rows `Koleksi` / `Download`, and the playlists keep their English titles. */
  test('reads the page rows off the Indonesian capture', () => {
    const rows = profileRows(load('screen-you'), 25)
    expect(rows).toContain('Download')
    expect(rows.some((r) => /Watch later/.test(r))).toBe(true)
    expect(rows.some((r) => /Video yang disukai/.test(r))).toBe(true)
  })

  /**
   * The bottom navigation is excluded by BAND, so a locale the chrome list has
   * never seen is still cut. `Abonelikler` (Turkish) is caught only by the band
   * — asserting with "Subscriptions" would pass even with no band exclusion at
   * all, which is the false-confidence this test exists to avoid.
   */
  test('a nav label in an unseen locale never becomes a row', () => {
    const tree = node({
      className: 'hierarchy',
      children: [
        node({ desc: 'Accounts', clickable: true, bounds: { left: 21, top: 84, right: 190, bottom: 140 } }),
        node({ desc: 'View channel', clickable: true, bounds: { left: 28, top: 335, right: 353, bottom: 391 } }),
        node({ desc: 'History', clickable: true, bounds: { left: 0, top: 423, right: 720, bottom: 507 } }),
        node({ desc: 'Abonelikler', clickable: true, bounds: { left: 432, top: 1472, right: 576, bottom: 1556 } }),
      ],
    })
    expect(profileRows(tree, 25)).not.toContain('Abonelikler')
    expect(profileRows(tree, 25)).toContain('History')
  })

  /** The toolbar sits above the content and is not a library row either. */
  test('the toolbar icons never become rows, in either language', () => {
    const en = profileRows(load('screen-you-en'), 40)
    expect(en).not.toContain('Search')
    expect(en).not.toContain('Settings')
    expect(en).not.toContain('Notifications')
    const id = profileRows(load('screen-you'), 40)
    expect(id).not.toContain('Telusuri')
    expect(id).not.toContain('Setelan')
    expect(id).not.toContain('Notifikasi')
  })

  test('the bottom navigation never becomes a row, in either language', () => {
    expect(profileRows(load('screen-you'), 40)).not.toContain('Beranda')
    expect(profileRows(load('screen-you-en'), 40)).not.toContain('Home')
  })

  test('honours maxRows', () => {
    expect(profileRows(load('screen-you-en'), 2)).toHaveLength(2)
  })
})
