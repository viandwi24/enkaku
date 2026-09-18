import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { notificationFilters, notificationItems, notificationsBellOf, notificationsEmpty, onNotifications } from './check-notifications'

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
  Every fixture below is a real capture from the owner's moto g06 power
  (720x1640, en-US, 2026-09-18) unless it says otherwise. The one screen that
  could not be captured — a populated notifications list — is built by hand from
  the captured EMPTY screen's own structure, and is marked as such.
*/

describe('notificationsBellOf — the bell, not its neighbour', () => {
  const home = load('screen-home')

  /**
   * The failure this guards is 84 pixels wide: Search sits immediately right of
   * the bell in the same toolbar row. Matching by description rather than by
   * position is the whole reason this helper exists.
   */
  /**
   * Two real captures, two locales — not one capture and one guess.
   *
   * `screen-home.json` was taken on an INDONESIAN device (`Notifikasi`); the
   * same handset in English on 2026-09-18, the screen this member was written
   * against, says `Notifications`. That is why the assertion is the pattern
   * rather than either spelling: hardcoding one made this test fail against the
   * pack's own existing fixture, which is exactly the bug it would have shipped
   * on half the farm.
   */
  test('finds the bell on the real home screen, whichever locale it shipped in', () => {
    const bell = notificationsBellOf(home)
    expect(bell).not.toBeNull()
    expect(/^(notifications|notifikasi)$/i.test(bell?.desc ?? '')).toBe(true)
  })

  /**
   * The 84-pixel failure, made observable.
   *
   * Asserting against `screen-home.json` alone proves nothing: its toolbar sits
   * early in the walk, so "the first clickable node" IS the bell there and a
   * version of this helper that ignored the description entirely would pass. So
   * the tree below puts Search — and a back button — ahead of the bell, which is
   * the only arrangement where taking the description seriously is what saves
   * the run from opening the search box.
   */
  test('picks the bell even when other clickable controls come first in the walk', () => {
    const tree = node({
      className: 'hierarchy',
      children: [
        node({ desc: 'Navigate up', clickable: true, bounds: { left: 0, top: 70, right: 98, bottom: 154 } }),
        node({ desc: 'Search', clickable: true, bounds: { left: 636, top: 70, right: 720, bottom: 154 } }),
        node({ desc: 'Notifications', clickable: true, bounds: { left: 552, top: 70, right: 636, bottom: 154 } }),
      ],
    })
    expect(notificationsBellOf(tree)?.desc).toBe('Notifications')
  })

  /**
   * `Pemberitahuan` is the one spelling covered by NO capture — it is a
   * defensive alternative, not a measured one, and this test exists to say so
   * out loud. `Notifications` and `Notifikasi` are both real (above).
   */
  test('also accepts the unmeasured third spelling rather than failing closed on it', () => {
    const tree = node({ className: 'hierarchy', children: [node({ desc: 'Pemberitahuan', clickable: true, bounds: { left: 552, top: 70, right: 636, bottom: 154 } })] })
    expect(notificationsBellOf(tree)?.desc).toBe('Pemberitahuan')
  })

  test('a screen with no bell answers null rather than something close', () => {
    expect(notificationsBellOf(node({ className: 'hierarchy' }))).toBeNull()
  })
})

describe('onNotifications — the screen was actually reached', () => {
  test('the captured notifications screen is recognised', () => {
    expect(onNotifications(load('screen-notifications-empty'))).toBe(true)
  })

  /** The home screen has no `filter_bar`; mistaking it for this screen would report an empty inbox that was never opened. */
  test('the home screen is not', () => {
    expect(onNotifications(load('screen-home'))).toBe(false)
  })

  /**
   * `filter_bar` alone is not enough — it is a generic YouTube id other browse
   * surfaces also carry, so a title match is required alongside it.
   */
  test('a filter bar under some other title is not the notifications screen', () => {
    const tree = node({
      className: 'hierarchy',
      children: [node({ resourceId: 'com.google.android.youtube:id/filter_bar' }), node({ text: 'Subscriptions' })],
    })
    expect(onNotifications(tree)).toBe(false)
  })
})

describe('notificationsEmpty — YouTube said so, or it did not', () => {
  test('the captured empty screen reports empty', () => {
    expect(notificationsEmpty(load('screen-notifications-empty'))).toBe(true)
  })

  /**
   * The distinction that matters: a screen with rows is not empty, and — more
   * importantly — "we found no rows" must never be what produces `empty`. Only
   * YouTube's own marker does.
   */
  test('a screen with rows but no marker is NOT empty', () => {
    const tree = node({
      className: 'hierarchy',
      children: [
        node({ resourceId: 'com.google.android.youtube:id/filter_bar' }),
        node({ text: 'Notifications' }),
        node({ desc: 'Sahabat Selamanya uploaded Upin & Ipin - 3 days ago', clickable: true, bounds: { left: 0, top: 300, right: 720, bottom: 460 } }),
      ],
    })
    expect(notificationsEmpty(tree)).toBe(false)
  })
})

describe('notificationFilters', () => {
  test('reads the chips in left-to-right order off the real screen', () => {
    expect(notificationFilters(load('screen-notifications-empty'))).toEqual(['All', 'Mentions'])
  })
})

describe('notificationItems', () => {
  /** Built by hand on the captured screen's structure — the owner's account has no notifications to capture. */
  function populated(): UiNode {
    const row = (desc: string, top: number): UiNode => node({ desc, clickable: true, bounds: { left: 0, top, right: 720, bottom: top + 160 } })
    return node({
      className: 'hierarchy',
      children: [
        node({ resourceId: 'com.google.android.youtube:id/filter_bar', bounds: { left: 0, top: 154, right: 720, bottom: 238 } }),
        node({ text: 'Notifications', bounds: { left: 105, top: 88, right: 311, bottom: 135 } }),
        node({ resourceId: 'com.google.android.youtube:id/chip_cloud_chip_modern_text', text: 'All', bounds: { left: 21, top: 168, right: 95, bottom: 224 } }),
        row('Sahabat Selamanya uploaded: Upin & Ipin - Dewan Terbakar', 300),
        row('Trading Academy replied to your comment', 470),
        node({ desc: 'Home', clickable: true, bounds: { left: 0, top: 1472, right: 144, bottom: 1556 } }),
        node({ desc: 'Subscriptions', clickable: true, bounds: { left: 432, top: 1472, right: 576, bottom: 1556 } }),
        // Turkish, and deliberately NOT in `CHROME`: the word list cannot cover
        // every locale, which is the entire reason the exclusion is by band.
        node({ desc: 'Abonelikler', clickable: true, bounds: { left: 576, top: 1472, right: 720, bottom: 1556 } }),
      ],
    })
  }

  test('reads the rows, top first', () => {
    expect(notificationItems(populated(), 30)).toEqual([
      'Sahabat Selamanya uploaded: Upin & Ipin - Dewan Terbakar',
      'Trading Academy replied to your comment',
    ])
  })

  /**
   * The bottom navigation is excluded by BAND, not by name: a locale this pack
   * has not seen would still be cut, where a word list would leak it in as a
   * notification.
   */
  /**
   * The load-bearing case: a nav label in a locale `CHROME` has never seen.
   * "Home"/"Subscriptions" prove nothing here — the word list already catches
   * those, so a version of this member with NO band exclusion passes on them.
   * `Abonelikler` is caught only by the band.
   */
  test('a nav label in an unseen locale is still never a notification', () => {
    expect(notificationItems(populated(), 30)).not.toContain('Abonelikler')
  })

  test('honours maxItems', () => {
    expect(notificationItems(populated(), 1)).toHaveLength(1)
  })

  /** The captured empty screen must yield nothing — not the empty-state sentence as an "item". */
  test('the empty screen yields no items', () => {
    expect(notificationItems(load('screen-notifications-empty'), 30)).toEqual([])
  })
})
