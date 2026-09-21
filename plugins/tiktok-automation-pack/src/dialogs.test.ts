import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UiNodeSchema } from '@enkaku/protocol'
import type { ScriptContext } from '@enkaku/sdk'
import type { Selector, UiNode } from '@enkaku/protocol'
import { clearBlockingDialog } from './dialogs'

/**
 * A minimal `ScriptContext` stand-in for `clearBlockingDialog`.
 *
 * The screen is ONE reading: `dump()` returns a tree holding a clickable button for each label in
 * `matches`, at a known place, and counts how often it was asked. `find()` is still here, and
 * counted, because the thing these tests guard is that the sweep never goes back to asking the
 * inspector once per selector. `deadInspector` makes every reading throw, the way the uiautomator
 * fallback does on a playing video.
 */
function mkCtx(matches: string[] = [], opts?: { deadInspector?: boolean }): {
  ctx: ScriptContext<unknown>
  calls: { dump: number; find: number; tap: { x: number; y: number }[]; key: string[] }
} {
  const calls = { dump: 0, find: 0, tap: [] as { x: number; y: number }[], key: [] as string[] }
  const node = (text: string, i: number): UiNode =>
    ({
      resourceId: '',
      text,
      desc: '',
      className: 'android.widget.Button',
      packageName: 'com.ss.android.ugc.trill',
      bounds: { left: 100, top: 1000 + i * 100, right: 300, bottom: 1080 + i * 100 },
      clickable: true,
      enabled: true,
      focused: false,
      index: i,
      children: [],
    }) as UiNode
  const screen = {
    resourceId: '',
    text: '',
    desc: '',
    className: 'hierarchy',
    packageName: '',
    bounds: { left: 0, top: 0, right: 720, bottom: 1600 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: matches.map(node),
  } as UiNode
  const ctx = {
    device: {
      dump: async (): Promise<UiNode> => {
        calls.dump += 1
        if (opts?.deadInspector) throw new Error('INSPECTOR_DUMP_FAILED: uiautomator dump produced no hierarchy')
        return screen
      },
      find: async (): Promise<UiNode | null> => {
        calls.find += 1
        return null
      },
      tap: async (sel: Selector): Promise<void> => {
        if ('point' in sel) calls.tap.push(sel.point)
      },
      key: async (code: string): Promise<void> => {
        calls.key.push(code)
      },
    },
    artifact: { screenshot: async () => {}, file: async () => {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as ScriptContext<unknown>
  return { ctx, calls }
}

/**
 * `allowBack` — the plan 86 root-cause fix. `auto-scroll` (a single-screen loop) keeps the original,
 * unconditional-BACK behaviour by omitting the option entirely; `switch-account`/`search-follow`
 * (five-screen linear walks) pass `allowBack: false` so a false "nothing found" — measured on
 * hardware to be the ui-server inspector going briefly deaf, not a real dialog — can never turn into
 * an unwanted navigation. See `clearBlockingDialog`'s own doc comment for the hardware evidence.
 */
describe('clearBlockingDialog — allowBack gating (plan 86 root-cause fix)', () => {
  test('default (no opts, matching every existing auto-scroll call site) still falls back to BACK when nothing matches', async () => {
    const { ctx, calls } = mkCtx()
    await clearBlockingDialog(ctx)
    expect(calls.key).toEqual(['BACK'])
  })

  test('allowBack: false never presses BACK, even when no ack/deny selector matches', async () => {
    const { ctx, calls } = mkCtx()
    await clearBlockingDialog(ctx, { allowBack: false })
    expect(calls.key).toEqual([])
  })

  test('allowBack: true is equivalent to the default', async () => {
    const { ctx, calls } = mkCtx()
    await clearBlockingDialog(ctx, { allowBack: true })
    expect(calls.key).toEqual(['BACK'])
  })

  test('an ACK match short-circuits before BACK is even considered, with allowBack: false', async () => {
    const { ctx, calls } = mkCtx(['Mengerti'])
    await clearBlockingDialog(ctx, { allowBack: false })
    // The centre of the one button on screen.
    expect(calls.tap).toEqual([{ x: 200, y: 1040 }])
    expect(calls.key).toEqual([])
  })

  test('a DENY match short-circuits before BACK is even considered, with allowBack: false', async () => {
    const { ctx, calls } = mkCtx(['Tolak'])
    await clearBlockingDialog(ctx, { allowBack: false })
    expect(calls.tap).toEqual([{ x: 200, y: 1040 }])
    expect(calls.key).toEqual([])
  })

  test('an acknowledgement is preferred to a refusal when both are on screen', async () => {
    // "Tolak" is drawn FIRST on this screen and "Mengerti" second — the list's ranking wins, not the
    // tree's order, which is what the old one-find-per-selector loop honoured.
    const { ctx, calls } = mkCtx(['Tolak', 'Mengerti'])
    await clearBlockingDialog(ctx, { allowBack: false })
    expect(calls.tap).toEqual([{ x: 200, y: 1140 }])
  })
})

describe('clearBlockingDialog — reads the screen once, not once per label', () => {
  /*
    This file used to assert that a sweep with nothing on screen called `find()` exactly twenty
    times — thirteen acknowledgements and seven refusals, one inspector round trip each. That was
    the design, and on a working inspector it was merely slow. On the owner's production phone #27
    (SM-A075F, 2026-09-21) the inspector was the uiautomator fallback on a playing video, every
    reading failed after about ninety-five seconds, and one sweep of twenty took over half an hour.
  */
  test('a whole sweep, nothing on screen, is one reading', async () => {
    const { ctx, calls } = mkCtx()
    await clearBlockingDialog(ctx, { allowBack: false })
    expect(calls.dump).toBe(1)
    expect(calls.find).toBe(0)
  })

  test('a dead inspector costs one failed reading, not twenty', async () => {
    const { ctx, calls } = mkCtx([], { deadInspector: true })
    await clearBlockingDialog(ctx, { allowBack: false })
    expect(calls.dump).toBe(1)
    expect(calls.find).toBe(0)
    expect(calls.tap).toEqual([])
  })

  test('with a dead inspector, the single-screen caller still gets its BACK', async () => {
    // BACK needs no inspector, and on `auto-scroll` it is the recovery that was always on the ladder.
    const { ctx, calls } = mkCtx([], { deadInspector: true })
    await clearBlockingDialog(ctx)
    expect(calls.key).toEqual(['BACK'])
  })
})

describe('firstMatch — the ranking is the list\'s, not the screen\'s', () => {
  test('returns the first selector in LIST order that matches anything', async () => {
    const { firstMatch, ACK_SELECTORS } = await import('./dialogs')
    const { ctx } = mkCtx(['Tutup', 'Mengerti'])
    const screen = await (ctx.device as unknown as { dump: () => Promise<UiNode> }).dump()
    expect(firstMatch(screen, ACK_SELECTORS)?.selector).toEqual({ text: 'Mengerti' })
  })

  test('nothing matching is null, not a guess', async () => {
    const { firstMatch, DENY_SELECTORS } = await import('./dialogs')
    const { ctx } = mkCtx(['Mengerti'])
    const screen = await (ctx.device as unknown as { dump: () => Promise<UiNode> }).dump()
    expect(firstMatch(screen, DENY_SELECTORS)).toBe(null)
  })
})

describe('clearBlockingDialog — a signed-out account is not a dialog to clear (1.56.0)', () => {
  const fixture = (name: string): UiNode =>
    UiNodeSchema.parse((JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__', name), 'utf8')) as { node: unknown }).node)

  for (const [name, handle] of [
    ['screen-signed-out-status.json', null],
    ['screen-signed-out-welcome.json', 'shorts.bitorex'],
  ] as const) {
    test(`${name}: stops with E_ACCOUNT_SIGNED_OUT, naming the account, and taps nothing`, async () => {
      const calls = { tap: 0, key: 0 }
      const ctx = {
        device: {
          dump: async (): Promise<UiNode> => fixture(name),
          tap: async (): Promise<void> => {
            calls.tap += 1
          },
          key: async (): Promise<void> => {
            calls.key += 1
          },
        },
        artifact: { screenshot: async () => {}, file: async () => {} },
        log: { debug() {}, info() {}, warn() {}, error() {} },
      } as unknown as ScriptContext<unknown>
      const err = (await clearBlockingDialog(ctx).catch((e: unknown) => e)) as Error & { code?: string }
      expect(err.code).toBe('E_ACCOUNT_SIGNED_OUT')
      if (handle !== null) expect(err.message).toContain(handle)
      // The "Status akun" OK is exactly what the ack ladder would have tapped before 1.56.0.
      expect(calls).toEqual({ tap: 0, key: 0 })
    })
  }
})
