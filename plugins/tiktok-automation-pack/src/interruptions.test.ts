import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { UiNodeSchema, type UiNode } from '@enkaku/protocol'
import { CLOSE_LABELS, closeNear, findInterruption } from './interruptions'

/**
 * The "add phone number" sheet, as the owner's Inspector showed it on a production SM-A075F (2026-09-14), in both the
 * Indonesian and the English build. Bounds are estimated for a 720x1640 screen (the Inspector's listing carries none);
 * the structure — a close button above the title, a phone field, a Continue button, and the feed's own "Dapatkan
 * Reward" badge with a close of its own at the top left — is as shown.
 */

function node(partial: Partial<UiNode>): UiNode {
  return { resourceId: '', text: '', desc: '', className: '', packageName: 'com.ss.android.ugc.trill', bounds: { left: 0, top: 0, right: 720, bottom: 1640 }, clickable: false, enabled: true, focused: false, index: 0, children: [], ...partial }
}

function phoneSheet(lang: 'id' | 'en', closeIn: 'text' | 'desc'): UiNode {
  const t = lang === 'id'
    ? { title: 'Tambah nomor telepon', body: 'Tambahkan nomor telepon Anda untuk keamanan ekstra, pemulihan akun yang lebih mudah, dan login yang lebih cepat.', field: 'Nomor telepon', go: 'Lanjutkan', close: 'Tutup' }
    : { title: 'Add phone', body: 'Add your phone number for extra security, easier account recovery, and quicker logins.', field: 'Phone number', go: 'Continue', close: 'Close' }
  return node({
    className: 'hierarchy',
    children: [
      node({
        className: 'android.widget.FrameLayout',
        children: [
          // The feed behind the sheet, still readable — including the reward badge's own close.
          node({ className: 'android.widget.TextView', text: 'Saran', bounds: { left: 560, top: 90, right: 640, bottom: 130 } }),
          node({ className: 'android.widget.ImageView', clickable: true, [closeIn]: t.close, bounds: { left: 100, top: 160, right: 130, bottom: 190 } }),
          node({
            className: 'android.widget.FrameLayout',
            resourceId: 'com.ss.android.ugc.trill:id/w46',
            bounds: { left: 0, top: 800, right: 720, bottom: 1640 },
            children: [
              node({ className: 'android.widget.Button', clickable: true, [closeIn]: t.close, bounds: { left: 620, top: 830, right: 690, bottom: 900 } }),
              node({ className: 'android.widget.TextView', resourceId: 'com.ss.android.ugc.trill:id/r0v', text: t.title, bounds: { left: 120, top: 920, right: 600, bottom: 990 } }),
              node({ className: 'android.widget.TextView', resourceId: 'com.ss.android.ugc.trill:id/r0t', text: t.body, bounds: { left: 60, top: 1010, right: 660, bottom: 1110 } }),
              node({ className: 'android.widget.EditText', text: t.field, clickable: true, bounds: { left: 260, top: 1150, right: 640, bottom: 1230 } }),
              node({ className: 'android.widget.Button', resourceId: 'com.ss.android.ugc.trill:id/lb4', text: t.go, clickable: true, bounds: { left: 60, top: 1400, right: 660, bottom: 1480 } }),
            ],
          }),
        ],
      }),
    ],
  })
}

describe('the add-phone-number sheet', () => {
  for (const lang of ['id', 'en'] as const) {
    for (const closeIn of ['text', 'desc'] as const) {
      test(`${lang}, close label in ${closeIn}: recognised, and the target is the sheet's own close — not the reward badge's, never Continue`, () => {
        const tree = phoneSheet(lang, closeIn)
        const found = findInterruption(tree)
        expect(found?.interruption.id).toBe('tt.phone-prompt')
        const close = closeNear(tree, found!.anchor)
        expect(close?.bounds).toEqual({ left: 620, top: 830, right: 690, bottom: 900 })
        expect([close?.text, close?.desc]).not.toContain(lang === 'id' ? 'Lanjutkan' : 'Continue')
      })
    }
  }

  test('with the sheet close unreadable, no other close is chosen — the caller falls back to BACK', () => {
    const tree = phoneSheet('id', 'desc')
    const sheet = tree.children[0]!.children[2]!
    sheet.children.splice(0, 1)
    const found = findInterruption(tree)
    expect(found).not.toBeNull()
    expect(closeNear(tree, found!.anchor)).toBeNull()
  })

  test('no screen this pack walks is mistaken for it', () => {
    const dir = join(import.meta.dir, '__fixtures__')
    const names = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(names.length).toBeGreaterThan(5)
    for (const name of names) {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { node?: unknown }
      const tree = UiNodeSchema.parse(raw.node ?? raw)
      expect({ name, found: findInterruption(tree)?.interruption.id ?? null }).toEqual({ name, found: null })
    }
  })

  test('a close label never continues, agrees or submits', () => {
    for (const label of CLOSE_LABELS) expect(/lanjut|continue|setuju|agree|kirim|submit|izinkan|allow/i.test(label)).toBe(false)
  })
})
