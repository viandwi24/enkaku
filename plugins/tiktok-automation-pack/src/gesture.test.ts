import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { TIKTOK_PACKAGE, foreignAppOnTop, navMissingReason } from './gesture'

function node(partial: Partial<UiNode>): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.view.ViewGroup',
    packageName: TIKTOK_PACKAGE,
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...partial,
  }
}

const FRAME = { left: 0, top: 0, right: 720, bottom: 1640 }

/*
  Production, 2026-09-18. `shop-browse` failed with "the Shop tab was not on the bottom navigation"
  and the artifact it saved was Android Settings — TikTok's own "Open by default" page, with
  "Open supported links" and "16 verified links" on it. No TikTok node anywhere.

  The nav was missing because TikTok was not in front. The message accused TikTok's UI, which is
  where anyone reading it goes looking; that farm had 1082 failed jobs and a share of them say this.
*/
function androidSettings(): UiNode {
  return node({
    className: 'hierarchy',
    packageName: '',
    children: [
      node({ packageName: 'com.android.settings', bounds: FRAME, children: [node({ packageName: 'com.android.settings', text: 'Open by default', bounds: { left: 40, top: 60, right: 400, bottom: 110 } })] }),
      node({ packageName: 'com.android.systemui', text: '3:31', bounds: { left: 14, top: 20, right: 96, bottom: 50 } }),
    ],
  })
}

function tiktokHome(): UiNode {
  return node({
    className: 'hierarchy',
    packageName: '',
    children: [
      node({ bounds: FRAME }),
      node({ desc: 'Shop', clickable: true, bounds: { left: 144, top: 1470, right: 288, bottom: 1556 } }),
      node({ packageName: 'com.android.systemui', text: '3:31', bounds: { left: 14, top: 20, right: 96, bottom: 50 } }),
    ],
  })
}

describe('foreignAppOnTop — which app is actually in front', () => {
  test('names the settings app that took the screen', () => {
    expect(foreignAppOnTop(androidSettings())).toBe('com.android.settings')
  })

  test('TikTok in front is never foreign', () => {
    expect(foreignAppOnTop(tiktokHome())).toBeNull()
  })

  /** The launcher counts: that is TikTok having failed to come up at all. */
  test('the launcher standing alone is named too', () => {
    const launcher = node({
      className: 'hierarchy',
      packageName: '',
      children: [node({ packageName: 'com.motorola.launcher3', bounds: FRAME })],
    })
    expect(foreignAppOnTop(launcher)).toBe('com.motorola.launcher3')
  })

  /** The status and navigation bars are on every screen and are never the reason a tab is missing. */
  test('the system UI alone is not a foreign app', () => {
    const bars = node({
      className: 'hierarchy',
      packageName: '',
      children: [node({ packageName: 'com.android.systemui', bounds: FRAME })],
    })
    expect(foreignAppOnTop(bars)).toBeNull()
  })

  /**
   * A sheet from another package that does NOT cover the screen is not "in front" — TikTok is still
   * there behind it, and the nav lookup failing means something else. Shape, not package identity.
   */
  test('a small overlay from another package is not a takeover', () => {
    const overlay = node({
      className: 'hierarchy',
      packageName: '',
      children: [node({ packageName: 'com.android.vending', bounds: { left: 0, top: 1200, right: 720, bottom: 1400 } })],
    })
    expect(foreignAppOnTop(overlay)).toBeNull()
  })

  test('an empty tree answers null rather than guessing', () => {
    expect(foreignAppOnTop(node({ className: 'hierarchy', packageName: '' }))).toBeNull()
  })
})

describe('navMissingReason — the message that stopped lying', () => {
  /**
   * The whole point: on the screen that actually failed in production, the run must say TikTok was
   * not in front and NAME what was, rather than blaming a navigation that could not have been there.
   */
  test('a foreign app is named, and the tab is not blamed', () => {
    const msg = navMissingReason(androidSettings(), 'Toko/Shop')
    expect(msg).toContain('com.android.settings')
    expect(msg).toContain('TikTok was not in front')
    expect(msg).not.toMatch(/^the Toko\/Shop tab was not on the bottom navigation/)
  })

  /** With TikTok genuinely in front, a missing tab IS about the tab — the old wording is right there. */
  test('with TikTok in front the message still points at the tab', () => {
    expect(navMissingReason(tiktokHome(), 'Toko/Shop')).toBe('the Toko/Shop tab was not on the bottom navigation — see the first artifact')
  })
})
