import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { foreignAppOnTop, touchBlockerOnTop } from './screen'

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

/*
  The real thing, node for node: the tree an Instagram post-video run saved as `ig-01-home` while
  reporting "Instagram's bottom navigation is not on screen after launch" (the owner's farm,
  SM-A075F, 720x1600, 2026-09-18). There is no Instagram node in it and never was — the phone was
  showing Samsung's accidental-touch protection, and fourteen runs across all three platforms died
  against it in three days, each blaming its own app's UI.
*/
const SYSUI = 'com.android.systemui'
const pocketNode = (partial: Partial<UiNode>): UiNode => node({ packageName: SYSUI, ...partial })

function pocketModeScreen(): UiNode {
  return screen(
    pocketNode({
      className: 'android.widget.LinearLayout',
      bounds: { left: 0, top: 0, right: 720, bottom: 1600 },
      children: [
        pocketNode({
          className: 'android.widget.LinearLayout',
          bounds: { left: 45, top: 0, right: 675, bottom: 427 },
          children: [
            pocketNode({
              resourceId: `${SYSUI}:id/unintentional_title`,
              className: 'android.widget.TextView',
              text: 'Perlindungan dari sentuhan tidak sengaja',
              bounds: { left: 45, top: 204, right: 675, bottom: 312 },
            }),
            pocketNode({
              resourceId: `${SYSUI}:id/unintentional_body`,
              className: 'android.widget.TextView',
              text: 'Ponsel Anda sedang dilindungi dari sentuhan tidak sengaja.',
              bounds: { left: 45, top: 346, right: 675, bottom: 427 },
            }),
          ],
        }),
        pocketNode({
          className: 'android.widget.FrameLayout',
          bounds: { left: 45, top: 427, right: 675, bottom: 1600 },
          children: [
            pocketNode({ resourceId: `${SYSUI}:id/unintentional_locker_img_cue_mtrl_L`, className: 'android.widget.ImageView', bounds: { left: 345, top: 761, right: 375, bottom: 778 } }),
            pocketNode({ resourceId: `${SYSUI}:id/locker_image_ring`, className: 'android.widget.ImageView', bounds: { left: 296, top: 949, right: 424, bottom: 1077 } }),
            pocketNode({
              resourceId: `${SYSUI}:id/unintentional_drag_to_unlock`,
              className: 'android.widget.TextView',
              text: 'Usap ke atas untuk mengabaikan perlindungan sentuhan yang tidak disengaja.',
              bounds: { left: 45, top: 1116, right: 675, bottom: 1185 },
            }),
          ],
        }),
      ],
    }),
  )
}

describe('touchBlockerOnTop — the overlay that swallows every touch', () => {
  test('names the production tree that cost fourteen runs', () => {
    expect(touchBlockerOnTop(pocketModeScreen())).toBe('Perlindungan dari sentuhan tidak sengaja')
  })

  test('foreignAppOnTop cannot see it, which is why this exists', () => {
    // The system UI is excluded there on purpose — the bars are on every screen.
    expect(foreignAppOnTop(pocketModeScreen(), APP)).toBeNull()
  })

  test('an ordinary screen is not a blocker', () => {
    expect(touchBlockerOnTop(screen(statusBar, node({ bounds: FRAME })))).toBeNull()
  })

  test('the id is the key, not the Indonesian wording', () => {
    const english = screen(
      pocketNode({
        resourceId: `${SYSUI}:id/unintentional_title`,
        text: 'Accidental touch protection',
        bounds: { left: 45, top: 204, right: 675, bottom: 312 },
      }),
    )
    expect(touchBlockerOnTop(english)).toBe('Accidental touch protection')
  })

  test('a blocker whose title carries no text still answers', () => {
    const untitled = screen(pocketNode({ resourceId: `${SYSUI}:id/unintentional_locker_img_cue_mtrl_L2`, bounds: { left: 345, top: 817, right: 375, bottom: 834 } }))
    expect(touchBlockerOnTop(untitled)).toBe('accidental-touch protection')
  })

  test('an empty tree is not evidence of one', () => {
    expect(touchBlockerOnTop(screen())).toBeNull()
  })
})
