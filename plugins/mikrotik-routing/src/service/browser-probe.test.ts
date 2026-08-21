import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { browseAndExtract, CHROME_PACKAGE, findDenyButton, type BrowserProbeCtx } from './browser-probe'

/**
 * The async navigation glue `verify-egress`/`discover-lan-ip` share (plan 122
 * §4.8, step 122.10) — a fake device stands in for a real one, the same
 * discipline `router-driver.test.ts`/`apply.test.ts` already use for a fake
 * `RouterDriver` rather than a live router. See `network-probe.test.ts` for
 * the pure extraction/decision logic this module's `extract` callback wraps.
 */

function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: '',
    packageName: '',
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...overrides,
  }
}

describe('findDenyButton', () => {
  test('matched by resource id first — a visible label is localised', () => {
    const byId = node({ resourceId: 'com.android.permissioncontroller:id/permission_dialog_deny' })
    const nodes = [byId, node({ text: 'Blokir' })]
    expect(findDenyButton(nodes)).toBe(byId)
  })

  test('the negative_button id shape also matches', () => {
    const byId = node({ resourceId: 'android:id/negative_button', text: 'Block' })
    expect(findDenyButton([byId])).toBe(byId)
  })

  test('falls back to text/label matching (English + the Indonesian spelling a real farm device showed)', () => {
    expect(findDenyButton([node({ text: 'Blokir' })])).not.toBeNull()
    expect(findDenyButton([node({ text: 'Block' })])).not.toBeNull()
    expect(findDenyButton([node({ text: 'Deny' })])).not.toBeNull()
  })

  test('null when nothing on screen looks like a deny button', () => {
    expect(findDenyButton([node({ text: 'Allow' }), node({ text: 'OK' })])).toBeNull()
  })
})

/** A scripted fake device: `dumps` is walked one at a time per `dump()` call (the last entry repeats once exhausted), `launch`/`tap` calls are recorded. */
function fakeCtx(dumps: UiNode[]): { ctx: BrowserProbeCtx; launches: { pkg: string; url?: string }[]; taps: { x: number; y: number }[] } {
  const launches: { pkg: string; url?: string }[] = []
  const taps: { x: number; y: number }[] = []
  let i = 0
  const ctx: BrowserProbeCtx = {
    device: {
      app: {
        launch: async (pkg: string, opts?: { url?: string }) => {
          launches.push({ pkg, url: opts?.url })
        },
      },
      dump: async () => {
        const d = dumps[Math.min(i, dumps.length - 1)] as UiNode
        i += 1
        return d
      },
      tap: async (target: { point: { x: number; y: number } }) => {
        taps.push(target.point)
      },
    },
    log: { info: () => {}, warn: () => {} },
  }
  return { ctx, launches, taps }
}

describe('browseAndExtract', () => {
  test('launches Chrome via the intent form (a URL, never typed) before the first poll', async () => {
    const { ctx, launches } = fakeCtx([node({ text: '1.2.3.4' })])
    await browseAndExtract(ctx, 'https://api.ipify.org', (texts) => texts.find((t) => t === '1.2.3.4') ?? null, { budgetMs: 5_000, pollMs: 1 })
    expect(launches).toEqual([{ pkg: CHROME_PACKAGE, url: 'https://api.ipify.org' }])
  })

  test('returns the extracted value as soon as extract stops returning null', async () => {
    const { ctx } = fakeCtx([node({ text: 'Loading…' }), node({ text: 'Loading…' }), node({ text: '103.186.169.250' })])
    const result = await browseAndExtract(ctx, 'https://api.ipify.org', (texts) => texts.find((t) => /^\d/.test(t)) ?? null, { budgetMs: 5_000, pollMs: 1 })
    expect(result).toBe('103.186.169.250')
  })

  test('dismisses a permission prompt (taps its deny button) and keeps polling rather than giving up', async () => {
    const dialog = node({ resourceId: 'android:id/negative_button', text: 'Blokir', bounds: { left: 100, top: 200, right: 200, bottom: 240 } })
    const { ctx, taps } = fakeCtx([node({ children: [dialog] }), node({ text: 'ready' })])
    const result = await browseAndExtract(ctx, 'https://x', (texts) => (texts.includes('ready') ? 'ok' : null), { budgetMs: 5_000, pollMs: 1 })
    expect(result).toBe('ok')
    expect(taps).toEqual([{ x: 150, y: 220 }])
  })

  test('returns null when the budget runs out with nothing found — never a guess', async () => {
    const { ctx } = fakeCtx([node({ text: 'nope' })])
    const result = await browseAndExtract(ctx, 'https://x', () => null, { budgetMs: 5, pollMs: 1 })
    expect(result).toBeNull()
  })

  test('extract sees both text and desc, flattened across the whole tree', async () => {
    const child = node({ text: '', desc: 'hidden-in-desc' })
    const { ctx } = fakeCtx([node({ text: 'root', children: [child] })])
    let seen: readonly string[] = []
    await browseAndExtract(
      ctx,
      'https://x',
      (texts) => {
        seen = texts
        return 'done'
      },
      { budgetMs: 5_000, pollMs: 1 },
    )
    expect(seen).toContain('root')
    expect(seen).toContain('hidden-in-desc')
  })
})
