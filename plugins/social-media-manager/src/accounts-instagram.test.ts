import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { instagramCurrentHandle, instagramSwitcherButton, instagramSwitcherHandles } from './accounts-instagram'

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

describe('Instagram accounts — the profile toolbar and the switcher sheet (0.37.0, moto g06 2026-09-16)', () => {
  test('the toolbar names the signed-in handle, and is the tap that opens the switcher', async () => {
    const profile = await fixture('screen-ig-profile.json')
    expect(instagramCurrentHandle(profile)).toBe('owner.account')
    expect(instagramSwitcherButton(profile)?.bounds).toEqual({ left: 244, top: 70, right: 458, bottom: 168 })
  })

  test('the sheet lists handles and drops its "Tambahkan …" and Meta-settings rows', async () => {
    const sheet = await fixture('screen-ig-account-switcher.json')
    expect(instagramSwitcherHandles(sheet)).toEqual(['owner.account'])
  })

  test('"Buka Pusat Akun" is an action row, not a second account (0.41.0)', () => {
    /*
      Production, 2026-09-16: five phones synced, and every one reported TWO Instagram accounts — the
      second being this row, the Accounts Centre entry. `sync-accounts` saves no dump of the sheet it
      reads (that gap is its own work item), so there is no fixture of that build to check in. The row
      label is the measured part; the shape around it is the one this reader requires — a clickable
      whose desc is repeated as the text of a node inside it — so the test exercises exactly the path
      the real sheet took through it.
    */
    const row = (label: string, index: number): UiNode => ({
      resourceId: '',
      text: '',
      desc: label,
      className: 'android.view.ViewGroup',
      packageName: 'com.instagram.android',
      bounds: { left: 0, top: 200 + index * 120, right: 720, bottom: 300 + index * 120 },
      clickable: true,
      enabled: true,
      focused: false,
      index,
      children: [
        {
          resourceId: '',
          text: label,
          desc: '',
          className: 'android.widget.TextView',
          packageName: 'com.instagram.android',
          bounds: { left: 40, top: 220 + index * 120, right: 600, bottom: 280 + index * 120 },
          clickable: false,
          enabled: true,
          focused: false,
          index: 0,
          children: [],
        },
      ],
    })
    const sheet: UiNode = {
      resourceId: '',
      text: '',
      desc: '',
      className: 'android.widget.FrameLayout',
      packageName: 'com.instagram.android',
      bounds: { left: 0, top: 0, right: 720, bottom: 1600 },
      clickable: false,
      enabled: true,
      focused: false,
      index: 0,
      children: [row('bitorexvault', 0), row('Buka Pusat Akun', 1), row('Tambahkan akun Instagram', 2), row('Open Accounts Centre', 3)],
    }
    expect(instagramSwitcherHandles(sheet)).toEqual(['bitorexvault'])
  })

  test('a screen that is neither reads as nothing, never a guess', async () => {
    const yt = await fixture('screen-yt-accounts.json')
    expect(instagramCurrentHandle(yt)).toBeNull()
    expect(instagramSwitcherHandles(yt)).toEqual([])
  })
})
