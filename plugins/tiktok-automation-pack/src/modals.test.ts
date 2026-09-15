import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { UiNodeSchema, type UiNode } from '@enkaku/protocol'
import type { ArtifactApi, DeviceApi, FarmApi, JobsApi, KvApi, PluginStorage, ScriptContext, ScriptLogger } from '@enkaku/sdk'
import { RESUME_EDIT_DRAFT_ANSWER, RESUME_EDIT_DRAFT_ANSWER_EN, TIKTOK_MODALS, UPLOAD_MODAL_POLICIES, assertNeverList, keepsDraft, matchModals, sweepModals, type ModalEntry } from './modals'

/**
 * `modals.ts` — the register, the never-list guard, and `sweepModals` (plan 113 §5 step 113.1,
 * §6 criteria 3–6). Fixture-driven against the eight real device dumps checked into
 * `__fixtures__/`, in the manner `sheet.test.ts`/`tree.test.ts` already established for this pack.
 */

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__')

/** Loads and Zod-validates one checked-in dump — the boundary rule applies to a fixture file exactly as it does to anything else crossing into this code from outside it. */
function loadFixture(name: string): UiNode {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as { node: unknown }
  return UiNodeSchema.parse(raw.node)
}

/** Fills in every field `UiNode` requires so a synthetic test only has to spell out what it cares about — same helper shape as `sheet.test.ts`/`tree.test.ts`. Used ONLY for the two register entries (`sys.microphone`, `tt.notice`) that have no checked-in device dump; every other test in this file reads a real fixture. */
function mkNode(partial: Partial<UiNode>): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: '',
    packageName: '',
    bounds: { left: 0, top: 0, right: 1, bottom: 1 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...partial,
  }
}

describe('tt.widget-pin — One UI\'s "Tambah ke Layar depan?" sheet (1.38.0)', () => {
  // Synthetic: built from a production screenshot, no dump of this sheet is checked in yet.
  const sheet = () =>
    mkNode({
      bounds: { left: 0, top: 0, right: 720, bottom: 1600 },
      children: [
        mkNode({ text: 'Tambah ke Layar depan?', bounds: { left: 40, top: 940, right: 680, bottom: 990 } }),
        mkNode({ text: 'Sentuh dan tahan ikon atau ketuk Tambah untuk menambahkannya ke Layar depan.', bounds: { left: 40, top: 1000, right: 680, bottom: 1080 } }),
        mkNode({ text: 'Kamera TikTok', clickable: true, bounds: { left: 40, top: 1100, right: 680, bottom: 1320 } }),
        mkNode({ text: 'Batal', clickable: true, bounds: { left: 40, top: 1360, right: 340, bottom: 1440 } }),
        mkNode({ text: 'Tambah', clickable: true, bounds: { left: 380, top: 1360, right: 680, bottom: 1440 } }),
      ],
    })

  test('matches only tt.widget-pin, not tt.widget-prompt, so the widget preview is never the fallback tap', () => {
    expect(matchModals(sheet()).map((e) => e.id)).toEqual(['tt.widget-pin'])
  })

  test('the upload sweep answers it with "Batal" and never "Tambah"', async () => {
    let dumps = 0
    const taps: unknown[] = []
    const ctx = {
      device: {
        dump: async () => (dumps++ === 0 ? sheet() : mkNode({})),
        tap: async (t: unknown) => void taps.push(t),
      },
      artifact: { screenshot: async () => ({ artifactId: 'a' }) },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as ScriptContext<unknown>
    const { cleared } = await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    expect(cleared).toEqual(['tt.widget-pin'])
    expect(taps).toEqual([{ point: { x: 190, y: 1400 } }])
  })
})

describe('TIKTOK_MODALS — matched against the real device dumps they were written from (plan 113 §6 criterion 3)', () => {
  test('sys.camera matches the camera permission dump, and NOT the media permission dump', () => {
    const camera = loadFixture('screen-sys-camera-permission.json')
    const media = loadFixture('screen-sys-media-permission.json')
    expect(matchModals(camera).map((e) => e.id)).toContain('sys.camera')
    expect(matchModals(media).map((e) => e.id)).not.toContain('sys.camera')
  })

  test('sys.media matches the media permission dump, and NOT the camera permission dump — the two share permission_message and the same button layout; only the text tells them apart', () => {
    const camera = loadFixture('screen-sys-camera-permission.json')
    const media = loadFixture('screen-sys-media-permission.json')
    expect(matchModals(media).map((e) => e.id)).toContain('sys.media')
    expect(matchModals(camera).map((e) => e.id)).not.toContain('sys.media')
  })

  test('the camera dump matches sys.camera ONLY, and the media dump matches sys.media ONLY — no cross-talk between the two permission dialogs', () => {
    const camera = loadFixture('screen-sys-camera-permission.json')
    const media = loadFixture('screen-sys-media-permission.json')
    expect(matchModals(camera).map((e) => e.id)).toEqual(['sys.camera'])
    expect(matchModals(media).map((e) => e.id)).toEqual(['sys.media'])
  })

  test('tt.camera-wall matches the camera-wall screen dump', () => {
    const wall = loadFixture('screen-camera-wall.json')
    expect(matchModals(wall).map((e) => e.id)).toEqual(['tt.camera-wall'])
  })

  /**
   * NOT `screen-picker.json`, even though it has no modal of its own — the camera/record screen's
   * whole subtree (including its own "mengakses kamera dan mikrofon Anda" text node) stays MOUNTED
   * underneath the picker and the preview, exactly as `screens.ts`'s own `detectScreen` comment
   * documents for `video_record_new_scene_root`/`upload_hot_area`. So `matchModals` legitimately
   * reports `tt.camera-wall` present on both — that is real, structural, and correct (E8: it is not
   * blocking, which is why `UPLOAD_MODAL_POLICIES` maps it to `ignore` rather than `abort`).
   * `screen-editor.json` is the fixture that is genuinely free of every modal identity in the
   * register, and is used here instead.
   */
  test('matchModals finds nothing on a screen with no modal identity present at all (screen-editor.json)', () => {
    expect(matchModals(loadFixture('screen-editor.json'))).toEqual([])
  })

  test('the camera-wall subtree is also present, and matched, underneath the picker and the preview screens — documented above, not a bug', () => {
    expect(matchModals(loadFixture('screen-picker.json')).map((e) => e.id)).toEqual(['tt.camera-wall'])
    expect(matchModals(loadFixture('screen-preview.json')).map((e) => e.id)).toEqual(['tt.camera-wall'])
  })

  test('tt.resume-edit matches the banner over the feed (2026-09-14), and tt.discard-draft does not, though both show "Simpan draf"', () => {
    const banner = loadFixture('screen-feed-resume-edit-banner.json')
    expect(matchModals(banner).map((e) => e.id)).toEqual(['tt.resume-edit'])
  })

  /*
    1.36.0: 1.35.0 answered "Edit" and expected the editor's "Buang" dialog, which the owner's moto (2026-09-15)
    measured never comes — BACK returns to the feed and TikTok keeps the edit as a draft. The owner decided the
    farm deletes all drafts before posting, so the banner is answered "Simpan draf" and no longer handed off.
  */
  test('tt.resume-edit is answered "Simpan draf" with no fallback, and is no longer a hand-off (1.36.0)', () => {
    const entry = TIKTOK_MODALS.find((e) => e.id === 'tt.resume-edit')
    expect(entry?.actions).toEqual({ ack: { text: 'Simpan draf' } })
    expect(entry?.exactActionOnly).toBe(true)
    expect(entry?.abortCode).toBeUndefined()
    expect(UPLOAD_MODAL_POLICIES['tt.resume-edit']).toBe('ack')
    expect(RESUME_EDIT_DRAFT_ANSWER).toEqual({ entryId: 'tt.resume-edit', policy: 'ack', label: 'Simpan draf' })
  })

  /*
    1.45.2: production, 2026-09-15, English TikTok on Samsung SM-A075F — the English banner text matched the shared
    entry, whose only answer "Simpan draf" is not on an English banner: `"tt.resume-edit" matched with policy "ack" but
    no on-screen node satisfied its "ack" action`. The English banner is its own entry now; its "Save draft" is unverified.
  */
  test('the English banner is tt.resume-edit-en, answered "Save draft" with no fallback, under the same policies (1.45.2)', () => {
    const id = TIKTOK_MODALS.find((e) => e.id === 'tt.resume-edit')
    const en = TIKTOK_MODALS.find((e) => e.id === 'tt.resume-edit-en')
    expect(id?.match.textIncludes).toEqual(['Lanjut mengedit postingan ini'])
    expect(en?.match).toEqual({ textIncludes: ['Continue editing this post'], onScreen: true })
    expect(en?.actions).toEqual({ ack: { text: 'Save draft' } })
    expect(en?.exactActionOnly).toBe(true)
    expect(en?.abortCode).toBeUndefined()
    expect(UPLOAD_MODAL_POLICIES['tt.resume-edit-en']).toBe('ack')
    expect(RESUME_EDIT_DRAFT_ANSWER_EN).toEqual({ entryId: 'tt.resume-edit-en', policy: 'ack', label: 'Save draft' })
    // tt.discard-draft still stands aside for both banners.
    expect(TIKTOK_MODALS.find((e) => e.id === 'tt.discard-draft')?.match.notWith).toEqual(['Lanjut mengedit postingan ini', 'Continue editing this post'])
  })

  test('tt.discard-draft offers only "Buang" (1.35.0)', () => {
    expect(TIKTOK_MODALS.find((e) => e.id === 'tt.discard-draft')?.actions).toEqual({ deny: { text: 'Buang' } })
  })

  test('tt.discard-draft matches the exit-modal screen dump, and nothing else in the register does', () => {
    expect(matchModals(loadFixture('screen-exit-modal.json')).map((e) => e.id)).toEqual(['tt.discard-draft'])
  })

  /**
   * `sys.microphone` and `tt.notice` have no checked-in device dump — the eight fixtures cover the
   * six screens plus the camera and media permission dialogs only (plan 113 §0.2's own table lists
   * a microphone dialog as E5's second queued prompt, but no dump of it was captured). Synthetic
   * nodes prove the matching LOGIC is correct for these two entries; they are not a substitute for a
   * hardware dump and are labelled as such rather than passed off as fixture-backed.
   */
  test('sys.microphone matches a permission_message node reading "merekam audio" — no device dump exists for this dialog, so this is a synthetic node, not a fixture', () => {
    const node = mkNode({ resourceId: 'com.android.permissioncontroller:id/permission_message', text: 'Izinkan TikTok merekam audio?' })
    expect(matchModals(node).map((e) => e.id)).toEqual(['sys.microphone'])
  })

  test('tt.notice matches an ACK_SELECTORS label with no id at all — no device dump exists for this notice, so this is a synthetic node, not a fixture', () => {
    const node = mkNode({ text: 'Mengerti' })
    expect(matchModals(node).map((e) => e.id)).toContain('tt.notice')
  })
})

describe('tt.security-check — recognised, and never answered by a run', () => {
  test('matches TikTok\'s security-check sheet by its own words', () => {
    const node = mkNode({ text: 'Mari kita lakukan pemeriksaan keamanan dengan cepat' })
    expect(matchModals(node).map((e) => e.id)).toContain('tt.security-check')
  })

  test('has no action to tap, and the upload flow aborts on it', () => {
    const entry = TIKTOK_MODALS.find((e) => e.id === 'tt.security-check')
    expect(entry?.actions).toEqual({})
    expect(UPLOAD_MODAL_POLICIES['tt.security-check']).toBe('abort')
  })
})

describe('sys.media — the one entry allowed to grant (plan 113 §4.2, E6)', () => {
  test('its allow action targets permission_allow_all_button', () => {
    const entry = TIKTOK_MODALS.find((e) => e.id === 'sys.media')
    expect(entry?.actions.allow).toEqual({ id: 'com.android.permissioncontroller:id/permission_allow_all_button' })
  })

  test('no entry anywhere in the register references permission_allow_selected_button — limited access is never a target', () => {
    for (const entry of TIKTOK_MODALS) {
      for (const sel of Object.values(entry.actions)) {
        if (sel && 'id' in sel) expect(sel.id).not.toBe('com.android.permissioncontroller:id/permission_allow_selected_button')
      }
    }
  })
})

describe('assertNeverList — the safety guard, promoted from a comment to something a test can call (plan 113 §6 criterion 5)', () => {
  test('passes on the real register', () => {
    expect(() => assertNeverList(TIKTOK_MODALS)).not.toThrow()
  })

  test('refuses a poisoned entry whose "allow" taps "Ikuti" — proving the guard actually catches the thing, not merely that it has never fired', () => {
    const poisoned: ModalEntry[] = [
      ...TIKTOK_MODALS,
      {
        id: 'poisoned.follow',
        match: { textIncludes: ['Ikuti akun ini?'] },
        actions: { allow: { text: 'Ikuti' } },
        seen: (TIKTOK_MODALS[0] as ModalEntry).seen,
      },
    ]
    let caught: unknown
    try {
      assertNeverList(poisoned)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('E_MODAL_NEVER_LIST')
  })

  test('refuses a poisoned entry whose "ack" taps "Setuju" (accepts terms) — the never-list is checked on every policy, not only allow', () => {
    const poisoned: ModalEntry[] = [
      { id: 'poisoned.agree', match: { textIncludes: ['Kebijakan baru'] }, actions: { ack: { text: 'Setuju' } }, seen: (TIKTOK_MODALS[0] as ModalEntry).seen },
    ]
    expect(() => assertNeverList(poisoned)).toThrow()
  })

  test('refuses an answer that keeps a draft, for every policy — "Simpan draf" and "Draf" are never declared (1.35.0)', () => {
    for (const label of ['Simpan draf', 'Draf', 'Save draft']) {
      for (const policy of ['allow', 'deny', 'ack'] as const) {
        const poisoned: ModalEntry[] = [{ id: 'poisoned.draft', match: { textIncludes: ['Buang'] }, actions: { [policy]: { text: label } }, seen: (TIKTOK_MODALS[0] as ModalEntry).seen }]
        expect(() => assertNeverList(poisoned)).toThrow()
      }
    }
    expect(keepsDraft({ text: 'Buang', desc: '' })).toBe(false)
    expect(keepsDraft({ text: '', desc: 'Simpan draf' })).toBe(true)
  })

  test('allows exactly one draft-keeping answer per resume-edit banner — tt.resume-edit → ack → "Simpan draf" (1.36.0), tt.resume-edit-en → ack → "Save draft" (1.45.2) — and nothing beside them', () => {
    const seen = (TIKTOK_MODALS[0] as ModalEntry).seen
    const banner = { id: 'tt.resume-edit', match: { textIncludes: ['Lanjut mengedit postingan ini'] }, seen }
    expect(() => assertNeverList([{ ...banner, actions: { ack: { text: 'Simpan draf' } } }])).not.toThrow()
    const en = { id: 'tt.resume-edit-en', match: { textIncludes: ['Continue editing this post'] }, seen }
    expect(() => assertNeverList([{ ...en, actions: { ack: { text: 'Save draft' } } }])).not.toThrow()
    // Neither banner may borrow the other's label, or the carve-out under another policy or selector.
    for (const actions of [{ ack: { text: 'Simpan draf' } }, { deny: { text: 'Save draft' } }, { ack: { desc: 'Save draft' } }, { ack: { text: 'Save drafts' } }] as ModalEntry['actions'][]) {
      expect(() => assertNeverList([{ ...en, actions }])).toThrow()
    }
    const near: ModalEntry['actions'][] = [
      { deny: { text: 'Simpan draf' } },
      { allow: { text: 'Simpan draf' } },
      { ack: { text: 'Draf' } },
      { ack: { text: 'Save draft' } },
      { ack: { desc: 'Simpan draf' } },
      { ack: { text: 'Simpan draf dan lanjut' } },
    ]
    for (const actions of near) expect(() => assertNeverList([{ ...banner, actions }])).toThrow()
    expect(() => assertNeverList([{ ...banner, id: 'tt.discard-draft', actions: { ack: { text: 'Simpan draf' } } }])).toThrow()
  })

  test('does NOT refuse sys.media\'s own allow → "Izinkan semua" — the one deliberate, narrowly-carved exception', () => {
    const mediaOnly = TIKTOK_MODALS.filter((e) => e.id === 'sys.media')
    expect(() => assertNeverList(mediaOnly)).not.toThrow()
  })

  test('a deny action containing "izinkan" (as in "Jangan izinkan") is NOT flagged — a refusal is supposed to carry that word as a negation', () => {
    const denyOnly = TIKTOK_MODALS.filter((e) => e.id === 'sys.camera')
    expect(() => assertNeverList(denyOnly)).not.toThrow()
  })
})

describe('sweepModals — the looping sweep over a fake ctx (plan 113 §4.2)', () => {
  const unused = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`sweepModals should not touch ctx.${String(prop)} in this test`)
      },
    },
  )

  function fakeCtx(dumps: UiNode[]): { ctx: ScriptContext<unknown>; taps: unknown[]; keys: string[]; screenshots: string[] } {
    const taps: unknown[] = []
    const keys: string[] = []
    const screenshots: string[] = []
    let call = 0
    const device = {
      dump: async () => {
        const tree = dumps[Math.min(call, dumps.length - 1)] as UiNode
        call += 1
        return tree
      },
      tap: async (target: unknown) => {
        taps.push(target)
      },
      key: async (key: string) => {
        keys.push(key)
      },
    } as unknown as DeviceApi
    const ctx: ScriptContext<unknown> = {
      device,
      params: undefined,
      artifact: {
        screenshot: async (label: string) => void screenshots.push(label),
        file: async () => ({ artifactId: 'artifact-x' }),
      } as ArtifactApi,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as ScriptLogger,
      job: { id: 'job-1', attempt: 1, deviceId: 'device-1' },
      kv: { device: unused as KvApi, global: unused as KvApi },
      storage: unused as PluginStorage,
      farm: unused as FarmApi,
      jobs: unused as JobsApi,
      progress: () => {},
    }
    return { ctx, taps, keys, screenshots }
  }

  test('a screen with no matching modal returns immediately with an empty cleared list, and taps nothing', async () => {
    const { ctx, taps } = fakeCtx([loadFixture('screen-editor.json')])
    const result = await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    expect(result).toEqual({ cleared: [] })
    expect(taps).toEqual([])
  })

  test('an actionable match is tapped once, recorded in cleared, and the sweep settles once the next dump shows nothing left', async () => {
    const { ctx, taps } = fakeCtx([loadFixture('screen-sys-media-permission.json'), loadFixture('screen-editor.json')])
    const result = await sweepModals(ctx, { 'sys.media': 'allow' })
    expect(result.cleared).toEqual(['sys.media'])
    // permission_allow_all_button's own bounds in screen-sys-media-permission.json: {88,870,631,968};
    // centerOf (@enkaku/protocol) rounds, so 359.5 -> 360.
    expect(taps).toEqual([{ point: { x: 360, y: 919 } }])
  })

  test('a matched entry with no declared policy throws E_MODAL_UNHANDLED and archives a screenshot — never guessed at (criterion 4)', async () => {
    const { ctx, screenshots } = fakeCtx([loadFixture('screen-sys-camera-permission.json')])
    let caught: unknown
    try {
      await sweepModals(ctx, {})
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('E_MODAL_UNHANDLED')
    expect(screenshots).toEqual(['modal-unhandled-sys.camera'])
  })

  /*
    1.34.0: "Oke banget #fyp" in the caption field CONTAINED "Oke", so `tt.notice` matched the field,
    tapped its EditText as the notice's button, and the post screen failed with E_MODAL_STUCK before Post.
  */
  test('the real post screen with the caption "Oke banget #fyp" is not a notice — nothing is tapped', async () => {
    const post = withCaption(loadFixture('screen-post.json'), 'Oke banget #fyp')
    expect(matchModals(post).map((e) => e.id)).not.toContain('tt.notice')
    const { ctx, taps } = fakeCtx([post])
    const result = await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    expect(result.cleared).not.toContain('tt.notice')
    expect(taps).toEqual([])
  })

  test('a security check raises E_SECURITY_CHECK whatever the policy map says, and taps nothing', async () => {
    const sheet = mkNode({ children: [mkNode({ text: 'Mari kita lakukan pemeriksaan keamanan dengan cepat' }), mkNode({ text: 'Lanjut', clickable: true })] })
    for (const policies of [UPLOAD_MODAL_POLICIES, {}, { 'tt.security-check': 'ignore' as const }]) {
      const { ctx, taps, screenshots } = fakeCtx([sheet])
      let caught: unknown
      try {
        await sweepModals(ctx, policies)
      } catch (err) {
        caught = err
      }
      expect((caught as { code?: string } | undefined)?.code).toBe('E_SECURITY_CHECK')
      expect(taps).toEqual([])
      expect(screenshots).toEqual(['modal-tt.security-check'])
    }
  })

  test('the resume-edit banner is answered "Simpan draf" (1.36.0); with that label gone nothing else on it is tapped, "Edit" least of all', async () => {
    const banner = loadFixture('screen-feed-resume-edit-banner.json')
    const done = fakeCtx([banner, loadFixture('screen-editor.json')])
    expect((await sweepModals(done.ctx, UPLOAD_MODAL_POLICIES)).cleared).toEqual(['tt.resume-edit'])
    // "Simpan draf"'s own bounds in screen-feed-resume-edit-banner.json: [140,163][405,219]; centerOf rounds 272.5 -> 273.
    expect(done.taps).toEqual([{ point: { x: 273, y: 191 } }])

    const noSave = structuredClone(banner)
    const strip = (n: UiNode): void => {
      n.children = n.children.filter((c) => c.text !== 'Simpan draf')
      for (const c of n.children) strip(c)
    }
    strip(noSave)
    const refused = fakeCtx([noSave])
    await expect(sweepModals(refused.ctx, UPLOAD_MODAL_POLICIES)).rejects.toMatchObject({ code: 'E_MODAL_UNHANDLED' })
    expect(refused.taps).toEqual([])

    // The abandon walk's answer: noted, never tapped.
    const abandon = fakeCtx([banner])
    expect((await sweepModals(abandon.ctx, { 'tt.resume-edit': 'ignore' })).cleared).toEqual(['tt.resume-edit'])
    expect(abandon.taps).toEqual([])
  })

  // Synthetic (1.45.2): the id-ID fixture with the English banner text. Only the banner text was read in production
  // (2026-09-15); "Save draft" is the unverified label, placed where "Simpan draf" sits.
  test('the English banner is answered "Save draft" (1.45.2); with that label gone nothing is tapped and the error names tt.resume-edit-en', async () => {
    const english = structuredClone(loadFixture('screen-feed-resume-edit-banner.json'))
    const translate = (n: UiNode): void => {
      if (n.text === 'Lanjut mengedit postingan ini?') n.text = 'Continue editing this post?'
      if (n.text === 'Simpan draf') n.text = 'Save draft'
      for (const c of n.children) translate(c)
    }
    translate(english)
    expect(matchModals(english).map((e) => e.id)).toEqual(['tt.resume-edit-en'])

    const done = fakeCtx([english, loadFixture('screen-editor.json')])
    expect((await sweepModals(done.ctx, UPLOAD_MODAL_POLICIES)).cleared).toEqual(['tt.resume-edit-en'])
    // "Save draft" carries "Simpan draf"'s bounds, [140,163][405,219].
    expect(done.taps).toEqual([{ point: { x: 273, y: 191 } }])

    // The production failure's shape: the English banner with no "Save draft" on it.
    const noSave = structuredClone(english)
    const strip = (n: UiNode): void => {
      n.children = n.children.filter((c) => c.text !== 'Save draft')
      for (const c of n.children) strip(c)
    }
    strip(noSave)
    const refused = fakeCtx([noSave])
    let caught: unknown
    try {
      await sweepModals(refused.ctx, UPLOAD_MODAL_POLICIES)
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('E_MODAL_UNHANDLED')
    expect(String((caught as Error | undefined)?.message)).toContain('"tt.resume-edit-en"')
    expect(refused.taps).toEqual([])

    const abandon = fakeCtx([english])
    expect((await sweepModals(abandon.ctx, { 'tt.resume-edit-en': 'ignore' })).cleared).toEqual(['tt.resume-edit-en'])
    expect(abandon.taps).toEqual([])
  })

  test('a deny on the exit dialog taps "Buang", and with "Buang" unreadable it never falls back to "Simpan draf" (1.35.0)', async () => {
    const exit = loadFixture('screen-exit-modal.json')
    const done = fakeCtx([exit, loadFixture('screen-editor.json')])
    expect((await sweepModals(done.ctx, { 'tt.discard-draft': 'deny' })).cleared).toEqual(['tt.discard-draft'])
    // "Buang"'s own bounds in screen-exit-modal.json: [80,257][317,292].
    expect(done.taps).toEqual([{ point: { x: 199, y: 275 } }])

    // The identity fallback used to take any clickable node carrying the dialog's identity — "Simpan draf" included.
    const noBuang = structuredClone(exit)
    const strip = (n: UiNode): void => {
      n.children = n.children.filter((c) => c.text !== 'Buang')
      for (const c of n.children) {
        if (c.text === 'Simpan draf') c.clickable = true
        strip(c)
      }
    }
    strip(noBuang)
    const refused = fakeCtx([noBuang])
    await expect(sweepModals(refused.ctx, { 'tt.discard-draft': 'deny' })).rejects.toMatchObject({ code: 'E_MODAL_UNHANDLED' })
    expect(refused.taps).toEqual([])
  })

  /*
    1.34.1: `tt.phone-prompt` taps whichever close sits NEAR its title, so it is identified only from a
    title drawn on screen — a copy kept in the tree off to the side must never aim at some other close.
  */
  test('the add-phone sheet is closed with its own close when on screen, and left alone when only in the tree off to the side', async () => {
    const sheet = (dx: number): UiNode =>
      mkNode({
        bounds: { left: dx, top: 800, right: dx + 720, bottom: 1640 },
        children: [
          mkNode({ desc: 'Tutup', clickable: true, bounds: { left: dx + 620, top: 830, right: dx + 690, bottom: 900 } }),
          mkNode({ text: 'Tambah nomor telepon', bounds: { left: dx + 120, top: 920, right: dx + 600, bottom: 990 } }),
        ],
      })
    // An on-screen close of something else, near enough to the sheet's title to be chosen for it.
    const decoy = mkNode({ desc: 'Tutup', clickable: true, bounds: { left: 20, top: 700, right: 90, bottom: 770 } })
    const screen = (dx: number): UiNode => mkNode({ bounds: { left: 0, top: 0, right: 720, bottom: 1640 }, children: [decoy, sheet(dx)] })
    const empty = mkNode({ bounds: { left: 0, top: 0, right: 720, bottom: 1640 } })

    const onScreen = fakeCtx([screen(0), empty])
    expect((await sweepModals(onScreen.ctx, UPLOAD_MODAL_POLICIES)).cleared).toEqual(['tt.phone-prompt'])
    expect(onScreen.taps).toEqual([{ point: { x: 655, y: 865 } }])

    expect(matchModals(screen(-1440)).map((e) => e.id)).not.toContain('tt.phone-prompt')
    const offScreen = fakeCtx([screen(-1440)])
    expect((await sweepModals(offScreen.ctx, UPLOAD_MODAL_POLICIES)).cleared).toEqual([])
    expect(offScreen.taps).toEqual([])
  })

  /*
    1.45.0, production job bf283f3d (English build, 2026-09-15): the "Add phone" sheet stayed up through four close taps,
    its phone field focused and the farm keyboard (`dev.enkaku.guestagent`) up. The sheet below is shaped like the
    Samsung dump of it; the English texts are the screenshot's.
  */
  describe('the add-phone sheet still up after its close was tapped (1.45.0)', () => {
    const close = { left: 630, top: 802, right: 706, bottom: 886 }
    const sheet = (keyboard: boolean): UiNode =>
      mkNode({
        bounds: { left: 0, top: 0, right: 720, bottom: 1600 },
        children: [
          mkNode({
            packageName: 'com.ss.android.ugc.trill',
            desc: 'Bottom sheet',
            bounds: { left: 0, top: 795, right: 720, bottom: 1485 },
            children: [
              mkNode({ packageName: 'com.ss.android.ugc.trill', className: 'android.widget.Button', desc: 'Close', clickable: true, bounds: close }),
              mkNode({ packageName: 'com.ss.android.ugc.trill', text: 'Add phone', bounds: { left: 60, top: 893, right: 660, bottom: 953 } }),
              mkNode({ packageName: 'com.ss.android.ugc.trill', text: 'Add your phone number for extra security', bounds: { left: 60, top: 983, right: 660, bottom: 1091 } }),
              mkNode({ packageName: 'com.ss.android.ugc.trill', className: 'android.widget.EditText', text: 'Phone number', clickable: true, focused: keyboard, bounds: { left: 276, top: 1165, right: 618, bottom: 1205 } }),
              mkNode({ packageName: 'com.ss.android.ugc.trill', className: 'android.widget.Button', text: 'Continue', clickable: true, bounds: { left: 60, top: 1365, right: 660, bottom: 1455 } }),
            ],
          }),
          ...(keyboard
            ? [
                mkNode({
                  packageName: 'dev.enkaku.guestagent',
                  resourceId: 'android:id/inputArea',
                  bounds: { left: 0, top: 1485, right: 720, bottom: 1600 },
                  children: [
                    mkNode({ packageName: 'dev.enkaku.guestagent', resourceId: 'dev.enkaku.guestagent:id/ime_switch_keyboard_button', text: 'Switch keyboard', clickable: true, bounds: { left: 419, top: 1508, right: 697, bottom: 1577 } }),
                  ],
                }),
              ]
            : []),
        ],
      })
    const empty = mkNode({ bounds: { left: 0, top: 0, right: 720, bottom: 1600 } })
    const closeTap = { point: { x: 668, y: 844 } }

    test('with the keyboard up, BACK puts the keyboard away first, then the sheet is closed by its own close — never Continue', async () => {
      const run = fakeCtx([sheet(true), sheet(true), sheet(false), empty])
      expect((await sweepModals(run.ctx, UPLOAD_MODAL_POLICIES)).cleared).toEqual(['tt.phone-prompt'])
      expect(run.taps).toEqual([closeTap, closeTap])
      expect(run.keys).toEqual(['BACK'])
    })

    test('with no keyboard, a close that did not take is not tapped again — BACK instead', async () => {
      const run = fakeCtx([sheet(false), sheet(false), empty])
      expect((await sweepModals(run.ctx, UPLOAD_MODAL_POLICIES)).cleared).toEqual(['tt.phone-prompt'])
      expect(run.taps).toEqual([closeTap])
      expect(run.keys).toEqual(['BACK'])
    })

    test('a sheet that never closes still ends in E_MODAL_STUCK, with no tap on anything but its close', async () => {
      // Two rounds, so the sweep's real pauses stay inside the test timeout.
      const run = fakeCtx([sheet(true)])
      await expect(sweepModals(run.ctx, UPLOAD_MODAL_POLICIES, { maxRounds: 2 })).rejects.toMatchObject({ code: 'E_MODAL_STUCK' })
      for (const tap of run.taps) expect(tap).toEqual(closeTap)
      expect(run.keys.every((k) => k === 'BACK')).toBe(true)
    })
  })
})

/** A checked-in dump with its caption field (the only EditText) holding `caption` — a copy, the fixture is untouched. */
function withCaption(tree: UiNode, caption: string): UiNode {
  const copy = structuredClone(tree)
  const visit = (n: UiNode): void => {
    if (n.className === 'android.widget.EditText') n.text = caption
    for (const c of n.children) visit(c)
  }
  visit(copy)
  return copy
}

describe('notice labels match exactly, and an editable field is never a modal (1.34.0)', () => {
  test('a button reading exactly "Oke" is a notice; a label that only contains it is not', () => {
    expect(matchModals(mkNode({ text: 'Oke', clickable: true })).map((e) => e.id)).toContain('tt.notice')
    expect(matchModals(mkNode({ text: ' got it ' })).map((e) => e.id)).toContain('tt.notice')
    expect(matchModals(mkNode({ text: 'Oke banget #fyp' })).map((e) => e.id)).not.toContain('tt.notice')
    expect(matchModals(mkNode({ text: 'Skip leg day #gym' })).map((e) => e.id)).not.toContain('tt.notice')
  })

  test('a caption field holding a notice label or a register phrase matches nothing', () => {
    for (const text of ['Oke', 'Lewati', 'Not now', 'pemeriksaan keamanan', 'Kamera TikTok hari ini']) {
      expect(matchModals(mkNode({ className: 'android.widget.EditText', text, clickable: true }))).toEqual([])
    }
  })
})

/**
 * Criterion 6 — `find`-ambiguity (E9) is not reachable: no code path in the pack selects a node by
 * bare text across the whole tree for the label the hardware walk proved ambiguous ("Berikutnya",
 * §0.2 E9). `screens.ts`'s `nextButtonIn` is the one place that resolves it, scoped to a subtree; the
 * label must never be embedded a second time anywhere else in the pack's implementation, because a
 * second embedding is exactly how a fresh `ctx.device.find({ text: 'Berikutnya' })` (or `tap`/
 * `waitFor`) creeps back in. Same shape as `packages/core/src/tools/adb-server-control.test.ts`'s
 * "kill-server has exactly one call site" guard: one literal, one permitted file, read straight off
 * disk rather than trusted from a convention.
 */
describe('guard — the ambiguous "Berikutnya" label is resolved in exactly one file (plan 113 §6 criterion 6)', () => {
  /** Strips `//` and `/* *\/` comments so a doc comment quoting the label for explanation does not itself trip the guard — string/template literals are tracked and copied through untouched, so a real selector literal still counts. Same approach as the adb-server-control guard. */
  function stripComments(source: string): string {
    let out = ''
    let i = 0
    const n = source.length
    while (i < n) {
      const ch = source[i]
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch
        out += ch
        i++
        while (i < n && source[i] !== quote) {
          if (source[i] === '\\') {
            out += source[i] + (source[i + 1] ?? '')
            i += 2
            continue
          }
          out += source[i]
          i++
        }
        if (i < n) {
          out += source[i]
          i++
        }
        continue
      }
      if (ch === '/' && source[i + 1] === '/') {
        while (i < n && source[i] !== '\n') i++
        continue
      }
      if (ch === '/' && source[i + 1] === '*') {
        i += 2
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
        i += 2
        continue
      }
      out += ch
      i++
    }
    return out
  }

  /**
   * Matches a `Selector`-shaped object literal keyed on the ambiguous label — `{ text: 'Berikutnya' }`
   * or `text: 'Berikutnya'` inside one — the exact shape a `ctx.device.find`/`tap`/`waitFor` call
   * would need to reintroduce E9's whole-tree ambiguity. Deliberately NOT a bare substring match on
   * "Berikutnya": that also flags harmless prose (a doc comment explaining the trap, or an error
   * message like `` the preview screen's "Berikutnya" button was not found `` in `post-video.ts`,
   * which only ever NAMES the button after `nextButtonIn` already failed to resolve it) — the same
   * false positive `stripComments` alone cannot remove, because a string literal is real code, not a
   * comment.
   */
  const SELECTOR_TEXT_PATTERN = /[{,]\s*text:\s*['"]Berikutnya['"]/

  test('no `{ text: \'Berikutnya\' }`-shaped selector exists anywhere in the pack\'s non-test source — the ambiguous label is never turned into a Selector, in screens.ts or anywhere else', () => {
    const srcDir = import.meta.dir
    const offenders: string[] = []
    for (const entry of readdirSync(srcDir)) {
      if (!entry.endsWith('.ts')) continue // skips __fixtures__ (a directory, no .ts suffix) and every .json dump
      if (entry.endsWith('.test.ts')) continue
      const code = stripComments(readFileSync(join(srcDir, entry), 'utf8'))
      if (SELECTOR_TEXT_PATTERN.test(code)) offenders.push(entry)
    }
    expect(
      offenders,
      `expected no file to build a Selector keyed on the ambiguous "Berikutnya" label (screens.ts resolves it structurally via nextButtonIn(), never via a Selector); found one in: ${offenders.join(', ') || '(none)'}`,
    ).toEqual([])
  })

  test('proves the pattern actually catches the thing: a deliberately reintroduced selector trips it', () => {
    expect(SELECTOR_TEXT_PATTERN.test("await ctx.device.find({ text: 'Berikutnya' })")).toBe(true)
    expect(SELECTOR_TEXT_PATTERN.test('const NEXT_BUTTON_TEXT = \'Berikutnya\'')).toBe(false)
    expect(SELECTOR_TEXT_PATTERN.test('throw new Error(`the preview screen\'s "Berikutnya" button was not found`)')).toBe(false)
  })
})
