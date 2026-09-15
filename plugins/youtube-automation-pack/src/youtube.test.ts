import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import type { UiNode } from '@enkaku/protocol'
import { googleAccountPageOnTop } from './youtube'

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

function node(partial: Partial<UiNode>): UiNode {
  return { resourceId: '', text: '', desc: '', className: 'android.widget.FrameLayout', packageName: '', bounds: { left: 0, top: 0, right: 0, bottom: 0 }, clickable: false, enabled: true, focused: false, index: 0, children: [], ...partial }
}

/**
 * The shape of the production dump (2026-09-15, run c4a3bd07, SM-A075F 720x1600): gms containers
 * covering the screen with no text at all, the status bar and navigation bar from System UI, and
 * not one YouTube node. Rebuilt by hand — the real dump names the account.
 */
function accountPage(): UiNode {
  const gms = (children: UiNode[] = []): UiNode => node({ packageName: 'com.google.android.gms', bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, children })
  return node({
    className: 'hierarchy',
    children: [
      gms([gms([gms([gms([gms()])])])]),
      node({ packageName: 'com.android.systemui', text: '12.43', bounds: { left: 14, top: 20, right: 96, bottom: 50 } }),
      node({ packageName: 'com.android.systemui', desc: 'Kembali', clickable: true, bounds: { left: 83, top: 1520, right: 221, bottom: 1600 } }),
    ],
  })
}

describe('googleAccountPageOnTop', () => {
  test('a screen-covering Play services page with no YouTube node is recognised', () => {
    expect(googleAccountPageOnTop(accountPage())).toBe(true)
  })

  test('a Play services window that does not cover the screen is not (an account chooser sheet over YouTube)', () => {
    const tree = accountPage()
    const sheet = node({ packageName: 'com.google.android.gms', bounds: { left: 0, top: 900, right: 720, bottom: 1600 } })
    const youtube = node({ packageName: 'com.google.android.youtube', desc: 'Beranda', bounds: { left: 0, top: 1450, right: 144, bottom: 1520 } })
    expect(googleAccountPageOnTop({ ...tree, children: [youtube, sheet] })).toBe(false)
  })

  test('no screen this pack walks is mistaken for it', async () => {
    const names = readdirSync(new URL('./__fixtures__/', import.meta.url)).filter((f) => f.endsWith('.json'))
    expect(names.length).toBeGreaterThan(10)
    for (const name of names) {
      expect({ name, page: googleAccountPageOnTop(await fixture(name)) }).toEqual({ name, page: false })
    }
  })
})
