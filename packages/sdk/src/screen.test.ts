import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { foreignAppOnTop } from './screen'

const APP = 'com.ss.android.ugc.trill'
const FRAME = { left: 0, top: 0, right: 720, bottom: 1640 }

function node(partial: Partial<UiNode>): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.view.ViewGroup',
    packageName: APP,
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...partial,
  }
}

function screen(...children: UiNode[]): UiNode {
  return node({ className: 'hierarchy', packageName: '', children })
}

const statusBar = node({ packageName: 'com.android.systemui', text: '3:31', bounds: { left: 14, top: 20, right: 96, bottom: 50 } })

describe('foreignAppOnTop — which app is actually in front', () => {
  /*
    The tree that cost 1082 failed jobs: TikTok's "Open by default" page in Android Settings, saved
    by `shop-browse` as it reported a missing TikTok tab. No node of the app under test anywhere.
  */
  test('names the settings app that took the screen', () => {
    const tree = screen(
      node({ packageName: 'com.android.settings', bounds: FRAME, children: [node({ packageName: 'com.android.settings', text: 'Open by default', bounds: { left: 40, top: 60, right: 400, bottom: 110 } })] }),
      statusBar,
    )
    expect(foreignAppOnTop(tree, APP)).toBe('com.android.settings')
  })

  test('the app under test being in front is never foreign', () => {
    const tree = screen(node({ bounds: FRAME }), node({ desc: 'Shop', clickable: true, bounds: { left: 144, top: 1470, right: 288, bottom: 1556 } }), statusBar)
    expect(foreignAppOnTop(tree, APP)).toBeNull()
  })

  /** The launcher counts: standing alone it means the app failed to come up at all. */
  test('the launcher standing alone is named too', () => {
    expect(foreignAppOnTop(screen(node({ packageName: 'com.motorola.launcher3', bounds: FRAME })), APP)).toBe('com.motorola.launcher3')
  })

  test('the system UI alone is not a foreign app', () => {
    expect(foreignAppOnTop(screen(node({ packageName: 'com.android.systemui', bounds: FRAME })), APP)).toBeNull()
  })

  /** The app is still behind a sheet, so a missing control means something else. Shape, not identity. */
  test('a small overlay from another package is not a takeover', () => {
    const tree = screen(node({ packageName: 'com.android.vending', bounds: { left: 0, top: 1200, right: 720, bottom: 1400 } }))
    expect(foreignAppOnTop(tree, APP)).toBeNull()
  })

  test('an empty tree answers null rather than guessing', () => {
    expect(foreignAppOnTop(screen(), APP)).toBeNull()
  })

  /**
   * `ownPackage` is a parameter, not a constant, and that is the whole reason this lives in the SDK.
   * The same tree reads opposite ways depending on which app is meant to be running.
   */
  test('the same tree answers differently for a different app under test', () => {
    const tree = screen(node({ packageName: 'com.google.android.youtube', bounds: FRAME }), statusBar)
    expect(foreignAppOnTop(tree, APP)).toBe('com.google.android.youtube')
    expect(foreignAppOnTop(tree, 'com.google.android.youtube')).toBeNull()
  })

  /**
   * YouTube's copy re-derived the name afterwards as "the first package that is not YouTube and not
   * system UI", which can name a sliver rather than the app doing the covering. This one names the
   * node that actually covers the screen.
   */
  test('names the covering app, not merely the first foreign node in the tree', () => {
    const tree = screen(
      node({ packageName: 'com.android.inputmethod', bounds: { left: 0, top: 1500, right: 720, bottom: 1540 } }),
      node({ packageName: 'com.android.settings', bounds: FRAME }),
    )
    expect(foreignAppOnTop(tree, APP)).toBe('com.android.settings')
  })
})
