import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { UiNodeSchema, type UiNode } from '@enkaku/protocol'
import { CLOSE_LABELS, closeNear, findInterruption, keyboardWindowShowing, refusalButton, withheldBySystemDialog } from './interruptions'

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

describe('the "Riwayat penonton diaktifkan" sheet over the profile', () => {
  // The nodes of production #9's dump (2026-09-15, SM-A075F 720x1600), texts trimmed to what identifies them.
  function viewerSheet(): UiNode {
    return node({
      className: 'hierarchy',
      children: [
        node({ className: 'android.widget.TextView', text: 'Bitorex Buzz', bounds: { left: 20, top: 90, right: 300, bottom: 130 } }),
        node({
          className: 'android.widget.FrameLayout',
          resourceId: 'com.ss.android.ugc.trill:id/fxf',
          desc: 'Lembar bawah',
          bounds: { left: 0, top: 342, right: 720, bottom: 1510 },
          children: [
            node({ className: 'android.widget.Button', clickable: true, bounds: { left: 630, top: 349, right: 705, bottom: 432 } }),
            node({ className: 'android.widget.TextView', resourceId: 'com.ss.android.ugc.trill:id/le1', text: 'Riwayat penonton diaktifkan', bounds: { left: 96, top: 740, right: 624, bottom: 886 } }),
            node({ className: 'android.widget.TextView', resourceId: 'com.ss.android.ugc.trill:id/sqz', text: 'Riwayat penonton', bounds: { left: 60, top: 1233, right: 547, bottom: 1269 } }),
            node({ className: 'android.widget.Switch', resourceId: 'com.ss.android.ugc.trill:id/viewer_auth_switch', clickable: true, bounds: { left: 570, top: 1233, right: 660, bottom: 1284 } }),
            node({ className: 'android.widget.Button', text: 'Simpan', clickable: true, bounds: { left: 60, top: 1359, right: 660, bottom: 1457 } }),
          ],
        }),
      ],
    })
  }

  test('is recognised by its title, and its unlabelled close leaves no close to tap — the caller uses BACK, never "Simpan"', () => {
    const found = findInterruption(viewerSheet())
    expect(found?.interruption.id).toBe('tt.viewer-history')
    expect(closeNear(viewerSheet(), found!.anchor)).toBeNull()
  })
})

describe('dialogs that hid the Profil tab on production (1.44.0)', () => {
  // The nodes of production SM-A075F dumps (2026-09-15), bounds as measured.
  const dialog = (title: string, body: string, buttons: Array<[string, number, number, number, number]>): UiNode =>
    node({
      className: 'hierarchy',
      children: [
        node({ className: 'android.widget.TextView', desc: 'Profil', bounds: { left: 576, top: 1470, right: 720, bottom: 1556 } }),
        node({
          className: 'android.widget.FrameLayout',
          desc: 'Dialog',
          bounds: { left: 97, top: 465, right: 622, bottom: 1109 },
          children: [
            node({ className: 'android.widget.TextView', text: title, bounds: { left: 135, top: 630, right: 584, bottom: 724 } }),
            node({ className: 'android.widget.TextView', text: body, bounds: { left: 135, top: 747, right: 576, bottom: 891 } }),
            ...buttons.map(([label, left, top, right, bottom]) => node({ className: 'android.widget.Button', text: label, clickable: true, bounds: { left, top, right, bottom } })),
          ],
        }),
      ],
    })

  test('"Simpan info login" is refused with "Tidak sekarang", never saved', () => {
    const tree = dialog('Simpan info login untuk lain waktu?', 'Masuk ke akun di perangkat ini tanpa perlu memasukkan info Anda.', [
      ['Simpan info login', 97, 930, 622, 1019],
      ['Tidak sekarang', 97, 1020, 622, 1109],
    ])
    const found = findInterruption(tree)
    expect(found?.interruption.id).toBe('tt.save-login')
    expect(refusalButton(tree, found!.interruption)?.text).toBe('Tidak sekarang')
  })

  test('the friends-list access dialog is refused with "Jangan izinkan", never "OK"', () => {
    const tree = dialog('Izinkan TikTok mengakses daftar teman Facebook dan email Anda', 'Informasi', [
      ['Jangan izinkan', 97, 946, 359, 1035],
      ['OK', 360, 946, 622, 1035],
    ])
    const found = findInterruption(tree)
    expect(found?.interruption.id).toBe('tt.friends-access')
    expect(refusalButton(tree, found!.interruption)?.text).toBe('Jangan izinkan')
  })

  test('"Izinkan lokasi presisi" has no refusal to tap — it is closed with BACK, never "Izinkan"', () => {
    const tree = dialog('Izinkan lokasi presisi', 'Kamu sebelumnya telah menonaktifkan lokasi presisi untuk akunmu.', [
      ['Izinkan', 97, 946, 622, 1020],
      ['Buka pengaturan', 97, 1021, 622, 1100],
    ])
    const found = findInterruption(tree)
    expect(found?.interruption.id).toBe('tt.precise-location')
    expect(refusalButton(tree, found!.interruption)).toBeNull()
    expect(closeNear(tree, found!.anchor)).toBeNull()
  })

  test('the English builds\' wording, as measured on production (1.45.1)', () => {
    const saveLogin = dialog('Save login for next time', 'Log in to the account on this device without entering your info.', [
      ['Save login', 97, 930, 622, 1019],
      ['Not now', 97, 1020, 622, 1109],
    ])
    const login = findInterruption(saveLogin)
    expect(login?.interruption.id).toBe('tt.save-login')
    expect(refusalButton(saveLogin, login!.interruption)?.text).toBe('Not now')

    const viewer = dialog('Viewer history turned on', 'Others will see you viewed their profile.', [['Save', 64, 1360, 656, 1464]])
    const sheet = findInterruption(viewer)
    expect(sheet?.interruption.id).toBe('tt.viewer-history')
    // No refusal and no labelled close: BACK, never "Save".
    expect(refusalButton(viewer, sheet!.interruption)).toBeNull()
    expect(closeNear(viewer, sheet!.anchor)).toBeNull()
  })

  test('a reading with only System UI is a hidden system dialog; one with TikTok or nothing is not', () => {
    expect(withheldBySystemDialog(node({ packageName: '', children: [node({ packageName: 'com.android.systemui' })] }))).toBe(true)
    expect(withheldBySystemDialog(node({ packageName: '', children: [node({ packageName: 'com.android.systemui' }), node({})] }))).toBe(false)
    expect(withheldBySystemDialog(node({ packageName: '', children: [] }))).toBe(false)
  })
})

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

  test('a sheet kept in the tree off to the side is not on screen (1.34.1)', () => {
    const tree = phoneSheet('id', 'desc')
    const shift = (n: UiNode): void => {
      n.bounds = { ...n.bounds, left: n.bounds.left - 1440, right: n.bounds.right - 1440 }
      for (const c of n.children) shift(c)
    }
    shift(tree.children[0]!.children[2]!)
    expect(findInterruption(tree)).toBeNull()
  })

  test('no screen this pack walks is mistaken for it, and the one fixture that IS the sheet reads as it', () => {
    // The Samsung fleet's own dump of the sheet over the feed (production bundle afa20e58 ui/00020, 1.35.0).
    const expected: Record<string, string> = { 'screen-feed-samsung-phone-sheet.json': 'tt.phone-prompt' }
    const dir = join(import.meta.dir, '__fixtures__')
    const names = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(names.length).toBeGreaterThan(5)
    for (const name of names) {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { node?: unknown }
      const tree = UiNodeSchema.parse(raw.node ?? raw)
      expect({ name, found: findInterruption(tree)?.interruption.id ?? null }).toEqual({ name, found: expected[name] ?? null })
    }
  })

  test('a keyboard window is seen: the farm IME in the Samsung dump, a phone keyboard by its package — and nothing else (1.45.0)', () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__', 'screen-feed-samsung-phone-sheet.json'), 'utf8')) as { node: unknown }
    expect(keyboardWindowShowing(UiNodeSchema.parse(raw.node))).toBe(true)
    expect(keyboardWindowShowing(phoneSheet('en', 'desc'))).toBe(false)

    const withNode = (extra: Partial<UiNode>): UiNode => {
      const tree = phoneSheet('en', 'desc')
      tree.children.push(node({ bounds: { left: 0, top: 1100, right: 720, bottom: 1600 }, ...extra }))
      return tree
    }
    expect(keyboardWindowShowing(withNode({ packageName: 'com.samsung.android.honeyboard' }))).toBe(true)
    expect(keyboardWindowShowing(withNode({ packageName: 'com.google.android.inputmethod.latin' }))).toBe(true)
    expect(keyboardWindowShowing(withNode({ packageName: 'dev.enkaku.guestagent', resourceId: 'android:id/inputArea' }))).toBe(true)
    expect(keyboardWindowShowing(withNode({ packageName: 'dev.enkaku.guestagent', resourceId: 'dev.enkaku.guestagent:id/ime_notice' }))).toBe(true)
    // Anything else the guest agent draws is not a keyboard, and neither is a keyboard window with no size.
    expect(keyboardWindowShowing(withNode({ packageName: 'dev.enkaku.guestagent', resourceId: 'dev.enkaku.guestagent:id/status' }))).toBe(false)
    expect(keyboardWindowShowing(withNode({ packageName: 'com.samsung.android.honeyboard', bounds: { left: 0, top: 0, right: 0, bottom: 0 } }))).toBe(false)
  })

  test('a close label never continues, agrees or submits', () => {
    for (const label of CLOSE_LABELS) expect(/lanjut|continue|setuju|agree|kirim|submit|izinkan|allow/i.test(label)).toBe(false)
  })
})
