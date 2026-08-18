import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { UiNodeSchema, type UiNode } from '@enkaku/protocol'
import type { ArtifactApi, DeviceApi, FarmApi, JobsApi, KvApi, PluginStorage, ScriptContext, ScriptLogger } from '@enkaku/sdk'
import { TIKTOK_MODALS, UPLOAD_MODAL_POLICIES, assertNeverList, matchModals, sweepModals, type ModalEntry } from './modals'

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

  function fakeCtx(dumps: UiNode[]): { ctx: ScriptContext<unknown>; taps: unknown[]; screenshots: string[] } {
    const taps: unknown[] = []
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
    return { ctx, taps, screenshots }
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
