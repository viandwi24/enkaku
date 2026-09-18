import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { clearTouchBlocker, recoverToApp } from './recover'
import type { ScriptContext } from './types'

const APP = 'com.instagram.android'
const PLAY = 'com.android.vending'
const SYSUI = 'com.android.systemui'
const FRAME = { left: 0, top: 0, right: 720, bottom: 1600 }

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

const screen = (...children: UiNode[]): UiNode => node({ className: 'hierarchy', packageName: '', children })

/** Instagram's Reel editor, as the flow expects to find it. */
const ownApp = (): UiNode => screen(node({ packageName: APP, bounds: FRAME }))

/** The Play Store's install sheet for "Edits" — what twenty-six share-screen failures were really looking at. */
const playStore = (): UiNode => screen(node({ packageName: PLAY, bounds: FRAME }))

/** Samsung's accidental-touch protection. */
const pocketMode = (): UiNode =>
  screen(
    node({
      packageName: SYSUI,
      bounds: FRAME,
      children: [node({ packageName: SYSUI, resourceId: `${SYSUI}:id/unintentional_title`, text: 'Perlindungan dari sentuhan tidak sengaja', bounds: { left: 45, top: 204, right: 675, bottom: 312 } })],
    }),
  )

interface Recorded {
  keys: string[]
  launches: string[]
  swipes: { from: { x: number; y: number }; to: { x: number; y: number } }[]
  dumps: number
}

/**
 * A context that answers `dump()` from a script of trees, one per call, repeating the last.
 * `null` in the script means the dump throws — the farm's reader does fail, and this function
 * claims to survive it.
 */
function fakeCtx(trees: (UiNode | null)[]): { ctx: ScriptContext<unknown>; rec: Recorded } {
  const rec: Recorded = { keys: [], launches: [], swipes: [], dumps: 0 }
  const device = {
    dump: async () => {
      const tree = trees[Math.min(rec.dumps, trees.length - 1)]
      rec.dumps++
      if (tree === null) throw new Error('uiautomator dump produced no hierarchy')
      return tree
    },
    key: async (code: string) => {
      rec.keys.push(code)
    },
    swipe: async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      rec.swipes.push({ from, to })
    },
    app: {
      launch: async (pkg: string) => {
        rec.launches.push(pkg)
      },
    },
  }
  return { ctx: { device, log: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as ScriptContext<unknown>, rec } as { ctx: ScriptContext<unknown>; rec: Recorded }
}

describe('recoverToApp — getting the app back in front', () => {
  test('a screen that was never lost costs one dump and no action', async () => {
    const { ctx, rec } = fakeCtx([ownApp()])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0 })
    expect(out.ok).toBe(true)
    expect(out.did).toEqual([])
    expect(rec.dumps).toBe(1)
    expect(rec.keys).toEqual([])
  })

  test('a tree already in hand skips the first dump', async () => {
    const { ctx, rec } = fakeCtx([ownApp()])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0, tree: ownApp() })
    expect(out.ok).toBe(true)
    expect(rec.dumps).toBe(0)
  })

  /*
    The measured case. Twenty-six Instagram runs on twenty-six phones reported "the share screen
    did not open after the editor"; every sampled tree was this sheet. One BACK is all it needed.
  */
  test('BACK closes the Play Store sheet and the flow can carry on', async () => {
    const { ctx, rec } = fakeCtx([playStore(), ownApp()])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0 })
    expect(out.ok).toBe(true)
    expect(rec.keys).toEqual(['BACK'])
    expect(rec.launches).toEqual([])
    expect(out.did).toEqual([`pressed BACK to leave ${PLAY}`])
  })

  test('a sheet BACK will not close is left by launching the app again — never by force-stopping it', async () => {
    const { ctx, rec } = fakeCtx([playStore(), playStore(), playStore(), ownApp()])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0 })
    expect(out.ok).toBe(true)
    expect(rec.keys).toEqual(['BACK', 'BACK'])
    expect(rec.launches).toEqual([APP])
  })

  test('a touch blocker is swiped up past, not pressed past', async () => {
    const { ctx, rec } = fakeCtx([pocketMode(), ownApp()])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0 })
    expect(out.ok).toBe(true)
    expect(rec.keys).toEqual([])
    expect(rec.swipes).toHaveLength(1)
    const [swipe] = rec.swipes
    expect(swipe?.from.x).toBe(360)
    expect(swipe?.from.y).toBeGreaterThan(swipe?.to.y as number)
    expect(out.did[0]).toContain('accidental-touch protection')
  })

  test('a blocker that survives every round is reported by name, not guessed past', async () => {
    const { ctx } = fakeCtx([pocketMode()])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0 })
    expect(out.ok).toBe(false)
    expect(out.blockedBy).toBe('Perlindungan dari sentuhan tidak sengaja')
  })

  test('a screen that cannot be read is not reported as an intruder', async () => {
    const { ctx } = fakeCtx([null])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0 })
    expect(out.ok).toBe(false)
    expect(out.blockedBy).toBeNull()
    expect(out.did).toEqual([])
  })

  test('a reader that recovers on its own is waited for rather than given up on', async () => {
    const { ctx } = fakeCtx([null, null, ownApp()])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0 })
    expect(out.ok).toBe(true)
  })

  test('relaunch can be refused, and then BACK is the whole repertoire', async () => {
    const { ctx, rec } = fakeCtx([playStore()])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0, relaunch: false })
    expect(out.ok).toBe(false)
    expect(out.blockedBy).toBe(PLAY)
    expect(rec.launches).toEqual([])
    expect(rec.keys).toEqual(['BACK', 'BACK'])
  })

  test('a blocker over a foreign app is cleared in the order the screen stacks them', async () => {
    const { ctx, rec } = fakeCtx([pocketMode(), playStore(), ownApp()])
    const out = await recoverToApp(ctx, { ownPackage: APP, settleMs: 0 })
    expect(out.ok).toBe(true)
    expect(rec.swipes).toHaveLength(1)
    expect(rec.keys).toEqual(['BACK'])
  })
})

describe('clearTouchBlocker — the narrow half, for a pack that already handles foreign apps', () => {
  test('an ordinary screen costs one dump and answers null', async () => {
    const { ctx, rec } = fakeCtx([ownApp()])
    expect(await clearTouchBlocker(ctx, { settleMs: 0 })).toBeNull()
    expect(rec.dumps).toBe(1)
    expect(rec.swipes).toEqual([])
  })

  test('a blocker is swiped past and named', async () => {
    const { ctx, rec } = fakeCtx([pocketMode(), ownApp()])
    expect(await clearTouchBlocker(ctx, { settleMs: 0 })).toBe('Perlindungan dari sentuhan tidak sengaja')
    expect(rec.swipes).toHaveLength(1)
  })

  /* A foreign APP is not this function's business — the caller that asked has its own answer for that. */
  test('a foreign app is left exactly where it is', async () => {
    const { ctx, rec } = fakeCtx([playStore()])
    expect(await clearTouchBlocker(ctx, { settleMs: 0 })).toBeNull()
    expect(rec.keys).toEqual([])
    expect(rec.launches).toEqual([])
    expect(rec.swipes).toEqual([])
  })

  test('it never launches or presses anything', async () => {
    const { ctx, rec } = fakeCtx([pocketMode()])
    await clearTouchBlocker(ctx, { settleMs: 0 })
    expect(rec.keys).toEqual([])
    expect(rec.launches).toEqual([])
  })

  test('a blocker that survives the swipe is still named, not silently passed', async () => {
    const { ctx } = fakeCtx([pocketMode()])
    expect(await clearTouchBlocker(ctx, { settleMs: 0 })).toBe('Perlindungan dari sentuhan tidak sengaja')
  })
})
