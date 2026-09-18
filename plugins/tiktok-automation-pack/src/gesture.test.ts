import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ScriptContext } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { TIKTOK_PACKAGE, foreignAppOnTop, navMissingReason, relaunch } from './gesture'

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

/*
  `relaunch` — what happens when the feed never arrives.

  1.51.0 made the resulting message honest ("com.android.settings was covering the screen"). It did
  not stop the phone from spending a whole warm-up rotation there: `relaunch` warned and returned
  `false`, and eight of its nine callers discard that value. These tests are about the half that
  tries to FIX the phone, and about the half that must not change.

  The two faults look identical from inside the poll and must not share an outcome:
    - the inspector will not answer about an app that is up  → carry on, one launch only
    - another app is genuinely holding the screen            → launch once more
*/
const realNow = Date.now
const realSetTimeout = globalThis.setTimeout
let clock = 0

beforeEach(() => {
  clock = 1_700_000_000_000
  Date.now = () => clock
  // On a phone the blind settle and the poll are real seconds. This file is about WHICH branch
  // `relaunch` takes, so the clock is driven by the fake `waitFor` below instead of waited out.
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout
})

afterEach(() => {
  Date.now = realNow
  globalThis.setTimeout = realSetTimeout
})

type LaunchLog = { launches: number; dumps: number; warns: string[] }

/**
 * `feedOn` is the launch number the feed finally answers on — `2` means the first launch fails and
 * the second works, `undefined` means it never comes up at all. Each `waitFor` advances the fake
 * clock by the 2 s its live per-selector timeout actually costs, so the 25 s budget expires in a
 * handful of calls rather than in 25 s of test.
 */
function mkLaunchCtx(opts: { feedOn?: number; tree?: UiNode; dumpThrows?: boolean }): { ctx: ScriptContext<unknown>; log: LaunchLog } {
  const log: LaunchLog = { launches: 0, dumps: 0, warns: [] }
  const ctx = {
    device: {
      app: {
        grantPermissions: async () => [],
        denyPermissions: async () => [],
        forceStop: async () => {},
        launch: async () => {
          log.launches += 1
        },
      },
      waitFor: async (): Promise<UiNode> => {
        clock += 2_000
        if (opts.feedOn !== undefined && log.launches >= opts.feedOn) return {} as UiNode
        throw new Error('no such selector')
      },
      dump: async (): Promise<UiNode> => {
        log.dumps += 1
        if (opts.dumpThrows) throw new Error('the inspector never answered')
        return opts.tree ?? tiktokHome()
      },
    },
    log: {
      debug() {},
      info() {},
      warn: (message: string) => {
        log.warns.push(message)
      },
      error() {},
    },
  } as unknown as ScriptContext<unknown>
  return { ctx, log }
}

describe('relaunch — a second launch, only when another app is proven to hold the screen', () => {
  test('the feed on the first launch costs exactly one launch and no dump', async () => {
    const { ctx, log } = mkLaunchCtx({ feedOn: 1 })
    expect(await relaunch(ctx)).toBe(true)
    expect(log.launches).toBe(1)
    // Nothing failed, so nothing is diagnosed: the healthy path must not pay for the sick one.
    expect(log.dumps).toBe(0)
  })

  /** The production fault: Android Settings in front, TikTok nowhere. The phone gets another launch. */
  test('a foreign app holding the screen is launched through, and the run recovers', async () => {
    const { ctx, log } = mkLaunchCtx({ tree: androidSettings(), feedOn: 2 })
    expect(await relaunch(ctx)).toBe(true)
    expect(log.launches).toBe(2)
  })

  /**
   * The restraint that was already there, and is deliberately kept: a deaf inspector is not evidence
   * that TikTok is gone. One launch, `false`, and the caller's own anchor gets to report.
   */
  test('TikTok in front with an unhelpful poll is NOT relaunched a second time', async () => {
    const { ctx, log } = mkLaunchCtx({ tree: tiktokHome() })
    expect(await relaunch(ctx)).toBe(false)
    expect(log.launches).toBe(1)
    expect(log.warns.join(' ')).toContain('the next anchor will say where the device is')
    expect(log.warns.join(' ')).not.toContain('holding the screen')
  })

  test('an inspector that cannot even be asked is treated as the deaf case, not as an intruder', async () => {
    const { ctx, log } = mkLaunchCtx({ dumpThrows: true })
    expect(await relaunch(ctx)).toBe(false)
    expect(log.launches).toBe(1)
  })

  /** Bounded: an intruder that survives both launches gets named, and is not launched at a third time. */
  test('an intruder through both launches stops at two and is named', async () => {
    const { ctx, log } = mkLaunchCtx({ tree: androidSettings() })
    expect(await relaunch(ctx)).toBe(false)
    expect(log.launches).toBe(2)
    expect(log.warns.at(-1)).toContain('com.android.settings')
    expect(log.warns.at(-1)).toContain('never came to the front')
  })
})
