import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { isImplausibleMatch } from './find-guard'
import { UiServerInspector } from './index'

/**
 * The plan 60 §3.1 find guard.
 *
 * A script opened Chrome, typed a URL, waited for the page, screenshotted it,
 * and reported success — while the screenshot showed a different site. The
 * first of the four defects behind that was this one: `objInfo` answered
 * `{ id: 'com.android.chrome:id/url_bar' }` with a FrameLayout covering the
 * whole 720×1640 screen, `tap` aimed at its centre, and the tap landed on an
 * advertisement in the middle of the page. Every assertion afterwards was
 * measuring a different page, honestly and uselessly.
 *
 * So the numbers below are not invented: they are what a moto g06 power
 * returned, through the product's own script runner, for a selector the
 * Inspect panel resolved to an EditText at the top of the screen.
 */

const node = (bounds: { left: number; top: number; right: number; bottom: number }, over: Partial<UiNode> = {}): UiNode => ({
  resourceId: '',
  text: '',
  desc: '',
  className: '',
  packageName: '',
  bounds,
  clickable: false,
  enabled: true,
  focused: false,
  index: 0,
  children: [],
  ...over,
})

/** The measurement in §3.1, exactly as recorded. */
const MEASURED = node(
  { left: 0, top: 0, right: 720, bottom: 1640 },
  { resourceId: 'com.android.chrome:id/url_bar', className: 'android.widget.FrameLayout', clickable: false },
)
const SCREEN = { width: 720, height: 1640 }

describe('isImplausibleMatch', () => {
  test('the measured node — a 720×1640 FrameLayout on a 720×1640 screen', () => {
    expect(isImplausibleMatch(MEASURED, SCREEN)).toBe(true)
  })

  test('a toolbar: full width, but only a strip of the height', () => {
    const toolbar = node({ left: 0, top: 84, right: 720, bottom: 204 }, { className: 'android.widget.LinearLayout' })
    expect(isImplausibleMatch(toolbar, SCREEN)).toBe(false)
  })

  test('a small node is never implausible', () => {
    const button = node({ left: 40, top: 1200, right: 320, bottom: 1320 }, { clickable: true })
    expect(isImplausibleMatch(button, SCREEN)).toBe(false)
  })

  test('one pixel short of the full screen is the same container (§4.1: area, not an exact match)', () => {
    expect(isImplausibleMatch(node({ left: 0, top: 0, right: 719, bottom: 1639 }), SCREEN)).toBe(true)
  })

  test('a rotated device needs no special case — the comparison is by area', () => {
    // The same phone in landscape: the screen the guard was told about is
    // still 720×1640, and a full-screen node is 1640×720.
    expect(isImplausibleMatch(node({ left: 0, top: 0, right: 1640, bottom: 720 }), SCREEN)).toBe(true)
  })

  test('a large-but-usable node stays a match: 90% of the viewport is a page, not the root', () => {
    // 720 × 1476 = 90% of 720 × 1640.
    expect(isImplausibleMatch(node({ left: 0, top: 0, right: 720, bottom: 1476 }), SCREEN)).toBe(false)
  })

  test('an unknown screen size disables the guard rather than guessing', () => {
    expect(isImplausibleMatch(MEASURED, { width: 0, height: 0 })).toBe(false)
  })

  test('a zero-area node is not what this guard is about', () => {
    expect(isImplausibleMatch(node({ left: 300, top: 300, right: 300, bottom: 300 }), SCREEN)).toBe(false)
  })

  test('clickable is not part of the judgement — a page has to stay readable', () => {
    // whoer.net's `lite-your-ip-value` (plan 60 §3.2) carries a resource id
    // and no text, and nothing about it is clickable. Rejecting non-clickable
    // nodes to fix tapping would break reading.
    const value = node(
      { left: 48, top: 620, right: 672, bottom: 700 },
      { resourceId: 'lite-your-ip-value', clickable: false },
    )
    expect(isImplausibleMatch(value, SCREEN)).toBe(false)
  })
})

/** An inspector whose client is replaced by a scripted `objInfo`. */
function inspectorWith(
  info: unknown,
  opts: { screen?: { width: number; height: number } | null } = {},
): { inspector: UiServerInspector; warnings: string[]; screenReads: () => number } {
  const launcher = { stop: async () => {}, start: async () => {} } as never
  const warnings: string[] = []
  let screenReads = 0
  const inspector = new UiServerInspector({
    serial: 'test-serial',
    localPort: 0,
    launcher,
    screenSize: async () => {
      screenReads += 1
      return opts.screen === undefined ? SCREEN : opts.screen
    },
    onLog: (level, msg) => {
      if (level === 'warn') warnings.push(msg)
    },
  })
  ;(inspector as unknown as { client: { objInfo: () => Promise<unknown> } }).client = {
    objInfo: async () => info,
  }
  return { inspector, warnings, screenReads: () => screenReads }
}

/** The shape `objInfo` really returns (see `infoToUiNode`). */
const objInfo = (bounds: { left: number; top: number; right: number; bottom: number }, className: string) => ({
  resourceName: 'com.android.chrome:id/url_bar',
  className,
  bounds,
  clickable: false,
})

describe('UiServerInspector.find — the guard in place', () => {
  test('the measured node answers null, not a node the caller cannot use', async () => {
    const { inspector } = inspectorWith(objInfo({ left: 0, top: 0, right: 720, bottom: 1640 }, 'android.widget.FrameLayout'))
    expect(await inspector.find({ id: 'com.android.chrome:id/url_bar' })).toBeNull()
  })

  test('it says so at warn, with the selector and what came back', async () => {
    const { inspector, warnings } = inspectorWith(
      objInfo({ left: 0, top: 0, right: 720, bottom: 1640 }, 'android.widget.FrameLayout'),
    )
    await inspector.find({ id: 'com.android.chrome:id/url_bar' })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('com.android.chrome:id/url_bar')
    expect(warnings[0]).toContain('android.widget.FrameLayout')
    expect(warnings[0]).toContain('720')
  })

  test('once — a polling waitFor must not write twelve lines a second', async () => {
    const { inspector, warnings } = inspectorWith(
      objInfo({ left: 0, top: 0, right: 720, bottom: 1640 }, 'android.widget.FrameLayout'),
    )
    for (let i = 0; i < 20; i += 1) await inspector.find({ id: 'com.android.chrome:id/url_bar' })
    expect(warnings).toHaveLength(1)
  })

  test('the real EditText the Inspect panel shows is returned untouched', async () => {
    const { inspector, warnings } = inspectorWith(objInfo({ left: 56, top: 96, right: 664, bottom: 208 }, 'android.widget.EditText'))
    const found = await inspector.find({ id: 'com.android.chrome:id/url_bar' })

    expect(found?.className).toBe('android.widget.EditText')
    expect(found?.bounds).toEqual({ left: 56, top: 96, right: 664, bottom: 208 })
    expect(warnings).toHaveLength(0)
  })

  test('the screen is read once per inspector, not once per find', async () => {
    const { inspector, screenReads } = inspectorWith(objInfo({ left: 56, top: 96, right: 664, bottom: 208 }, 'android.widget.EditText'))
    for (let i = 0; i < 5; i += 1) await inspector.find({ id: 'com.android.chrome:id/url_bar' })
    expect(screenReads()).toBe(1)
  })

  test('a device whose screen size is unknown keeps the pre-guard behaviour', async () => {
    const { inspector } = inspectorWith(objInfo({ left: 0, top: 0, right: 720, bottom: 1640 }, 'android.widget.FrameLayout'), {
      screen: null,
    })
    expect(await inspector.find({ id: 'com.android.chrome:id/url_bar' })).not.toBeNull()
  })

  test('{ point } is exempt — a point is a coordinate, not a claim about a node', async () => {
    const { inspector, screenReads } = inspectorWith(null)
    const found = await inspector.find({ point: { x: 360, y: 820 } })

    expect(found).not.toBeNull()
    expect(screenReads()).toBe(0)
  })
})
