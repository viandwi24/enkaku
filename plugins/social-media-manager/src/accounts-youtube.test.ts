import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { youtubeAccountRows, youtubeAccountSheetShowing } from './accounts-youtube'

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

describe('YouTube accounts — the Anda tab account sheet (0.37.0, moto g06 2026-09-16)', () => {
  test('the sheet is recognised, and its one account is read with its handle, name and e-mail', async () => {
    const sheet = await fixture('screen-yt-accounts.json')
    expect(youtubeAccountSheetShowing(sheet)).toBe(true)
    expect(youtubeAccountRows(sheet)).toEqual([{ username: 'Hendisunadi', displayName: 'Hendi sunadi', accountId: 'hendisunadi859@gmail.com', selected: true }])
  })

  test('another app\'s screen is not the sheet, and reads as no accounts', async () => {
    const ig = await fixture('screen-ig-account-switcher.json')
    expect(youtubeAccountSheetShowing(ig)).toBe(false)
    expect(youtubeAccountRows(ig)).toEqual([])
  })
})
