import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import type { UiNode } from '@enkaku/protocol'
import { CLOSE_LABELS, NEVER_TERMS, closeTargetOf, findPopup } from './popups'

/**
 * `screen-premium-upsell.json` is rebuilt from the Inspector tree the owner pasted from a production phone (2026-09-14):
 * the same classes, ids, labels and nesting, with bounds estimated for a 720x1640 screen, because the Inspector's text
 * listing does not carry them. Every other fixture is a real dump of a screen this pack walks — none of them is a popup.
 */

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

describe('YouTube popups', () => {
  test('the Premium family offer is recognised, and its close target is "Tutup" — never "Coba 1 bulan"', async () => {
    const tree = await fixture('screen-premium-upsell.json')
    expect(findPopup(tree)?.id).toBe('yt.premium-upsell')
    const target = closeTargetOf(tree)
    expect(target?.desc || target?.text).toBe('Tutup')
    expect(target?.clickable).toBe(true)
  })

  test('no screen this pack walks is mistaken for a popup', async () => {
    const names = readdirSync(new URL('./__fixtures__/', import.meta.url)).filter((f) => f.endsWith('.json') && f !== 'screen-premium-upsell.json')
    expect(names.length).toBeGreaterThan(10)
    for (const name of names) {
      expect({ name, popup: findPopup(await fixture(name))?.id ?? null }).toEqual({ name, popup: null })
    }
  })

  test('no close label contains a word that subscribes, buys, starts a trial or agrees', () => {
    for (const closeLabel of CLOSE_LABELS) {
      expect({ closeLabel, hit: NEVER_TERMS.find((t) => closeLabel.toLowerCase().includes(t)) ?? null }).toEqual({ closeLabel, hit: null })
    }
  })
})
