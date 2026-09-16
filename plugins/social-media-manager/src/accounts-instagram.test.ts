import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { instagramCurrentHandle, instagramSwitcherButton, instagramSwitcherHandles } from './accounts-instagram'

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

describe('Instagram accounts — the profile toolbar and the switcher sheet (0.37.0, moto g06 2026-09-16)', () => {
  test('the toolbar names the signed-in handle, and is the tap that opens the switcher', async () => {
    const profile = await fixture('screen-ig-profile.json')
    expect(instagramCurrentHandle(profile)).toBe('bitorex.bkk')
    expect(instagramSwitcherButton(profile)?.bounds).toEqual({ left: 244, top: 70, right: 458, bottom: 168 })
  })

  test('the sheet lists handles and drops its "Tambahkan …" and Meta-settings rows', async () => {
    const sheet = await fixture('screen-ig-account-switcher.json')
    expect(instagramSwitcherHandles(sheet)).toEqual(['bitorex.bkk'])
  })

  test('a screen that is neither reads as nothing, never a guess', async () => {
    const yt = await fixture('screen-yt-accounts.json')
    expect(instagramCurrentHandle(yt)).toBeNull()
    expect(instagramSwitcherHandles(yt)).toEqual([])
  })
})
