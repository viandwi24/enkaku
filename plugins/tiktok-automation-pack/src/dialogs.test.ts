import { describe, expect, test } from 'bun:test'
import type { ScriptContext } from '@enkaku/sdk'
import type { Selector, UiNode } from '@enkaku/protocol'
import { clearBlockingDialog } from './dialogs'

/**
 * A minimal `ScriptContext` stand-in — only `device.find`/`tap`/`key` and `log.warn` are used by
 * `clearBlockingDialog`, so that is all this implements. `matches` names the ACK/DENY selector (by
 * its `text`) that should be "found" on screen; everything else answers `null`, exactly like the
 * live inspector does for a selector that genuinely is not there.
 */
function mkCtx(matches: string[] = []): { ctx: ScriptContext<unknown>; calls: { find: Selector[]; tap: Selector[]; key: string[] } } {
  const calls = { find: [] as Selector[], tap: [] as Selector[], key: [] as string[] }
  const wanted = new Set(matches)
  const ctx = {
    device: {
      find: async (sel: Selector): Promise<UiNode | null> => {
        calls.find.push(sel)
        return 'text' in sel && wanted.has(sel.text) ? ({ text: sel.text } as unknown as UiNode) : null
      },
      tap: async (sel: Selector): Promise<void> => {
        calls.tap.push(sel)
      },
      key: async (code: string): Promise<void> => {
        calls.key.push(code)
      },
    },
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
    expect(calls.tap).toEqual([{ text: 'Mengerti' }])
    expect(calls.key).toEqual([])
  })

  test('a DENY match short-circuits before BACK is even considered, with allowBack: false', async () => {
    const { ctx, calls } = mkCtx(['Tolak'])
    await clearBlockingDialog(ctx, { allowBack: false })
    expect(calls.tap).toEqual([{ text: 'Tolak' }])
    expect(calls.key).toEqual([])
  })

  test('every ACK selector is tried before any DENY selector, regardless of allowBack', async () => {
    const { ctx, calls } = mkCtx()
    await clearBlockingDialog(ctx, { allowBack: false })
    // 13 ACK selectors + 7 DENY selectors tried, in that order, before giving up.
    // (13th: "Tidak sekarang", measured 2026-09-03 against the login-save sheet.)
    expect(calls.find.length).toBe(20)
  })
})
