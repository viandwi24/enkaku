import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { tiktokSwitchSheetAccounts, tiktokSwitchSheetShowing } from './accounts-tiktok'

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

describe('TikTok accounts — the switch-account sheet (0.37.0, moto g06 2026-09-16, English build)', () => {
  test('both signed-in accounts are read in sheet order, the ticked one marked, "Add account" dropped', async () => {
    const sheet = await fixture('screen-tt-switch-account.json')
    expect(tiktokSwitchSheetShowing(sheet)).toBe(true)
    expect(tiktokSwitchSheetAccounts(sheet)).toEqual([
      { username: 'dewi_purnama280', checked: true },
      { username: 'user2578127329501', checked: false },
    ])
  })

  test('another app\'s sheet is not this one', async () => {
    const ig = await fixture('screen-ig-account-switcher.json')
    expect(tiktokSwitchSheetShowing(ig)).toBe(false)
    expect(tiktokSwitchSheetAccounts(ig)).toEqual([])
  })
})
