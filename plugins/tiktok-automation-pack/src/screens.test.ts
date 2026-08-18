import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { UiNodeSchema, type UiNode } from '@enkaku/protocol'
import { captionField, detectScreen, findAll, nextButtonIn, pickerCells, pickerSortLabel, type ScreenId } from './screens'

/**
 * `screens.ts` — the six-screen machine (plan 113 §5 step 113.2, §6 criteria 3, 6), tested against
 * the six real screen dumps checked into `__fixtures__/`, exactly as the plan's own status line
 * says this step was verified.
 */

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__')

function loadFixture(name: string): UiNode {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as { node: unknown }
  return UiNodeSchema.parse(raw.node)
}

describe('detectScreen — against the six real screen dumps', () => {
  test('screen-camera-wall.json -> camera', () => {
    expect(detectScreen(loadFixture('screen-camera-wall.json'))).toBe('camera')
  })

  test('screen-editor.json -> editor', () => {
    expect(detectScreen(loadFixture('screen-editor.json'))).toBe('editor')
  })

  test('screen-exit-modal.json -> editor — the discard-draft dialog is drawn on top of the still-mounted editor, and there is no seventh ScreenId for it', () => {
    expect(detectScreen(loadFixture('screen-exit-modal.json'))).toBe('editor')
  })

  test('screen-picker.json -> picker', () => {
    expect(detectScreen(loadFixture('screen-picker.json'))).toBe('picker')
  })

  test('screen-post.json -> post — none of the seven stable ids are present; identified by its single EditText instead', () => {
    expect(detectScreen(loadFixture('screen-post.json'))).toBe('post')
  })

  test('screen-preview.json -> preview — NOT picker, even though the picker is still mounted underneath it (E9)', () => {
    expect(detectScreen(loadFixture('screen-preview.json'))).toBe('preview')
  })

  test('never returns "feed" — there is no anchor to detect it by (§3.5); a tree matching none of the seven ids comes back "unknown"', () => {
    const blank: UiNode = { resourceId: '', text: '', desc: '', className: '', packageName: '', bounds: { left: 0, top: 0, right: 0, bottom: 0 }, clickable: false, enabled: true, focused: false, index: 0, children: [] }
    expect(detectScreen(blank)).toBe('unknown')
    const results: ScreenId[] = ['screen-camera-wall.json', 'screen-editor.json', 'screen-exit-modal.json', 'screen-picker.json', 'screen-post.json', 'screen-preview.json'].map(
      (f) => detectScreen(loadFixture(f)),
    )
    expect(results).not.toContain('feed')
  })
})

describe('the E9 regression — "Berikutnya" is ambiguous on the preview screen, and nextButtonIn resolves it (plan 113 §0.2 E9, §6 criterion 6)', () => {
  test('a naive whole-tree text match finds TWO nodes on screen-preview.json — the trap this file exists to avoid, documented rather than assumed', () => {
    const preview = loadFixture('screen-preview.json')
    const matches = findAll(preview, (n) => n.text.trim() === 'Berikutnya')
    expect(matches).toHaveLength(2)
  })

  test('nextButtonIn(root, "preview") returns exactly one node — the live one (pfc), not the stale one still nested under video_image_mixed_bottom_view_root (wz7)', () => {
    const preview = loadFixture('screen-preview.json')
    const node = nextButtonIn(preview, 'preview')
    expect(node).not.toBeNull()
    expect(node?.resourceId).toBe('com.ss.android.ugc.trill:id/pfc')
    expect(node?.resourceId).not.toBe('com.ss.android.ugc.trill:id/wz7')
  })

  test('on the picker screen there is only one "Berikutnya" match, and nextButtonIn(root, "picker") returns it, scoped to the bottom bar', () => {
    const picker = loadFixture('screen-picker.json')
    expect(findAll(picker, (n) => n.text.trim() === 'Berikutnya')).toHaveLength(1)
    const node = nextButtonIn(picker, 'picker')
    expect(node).not.toBeNull()
    expect(node?.resourceId).toBe('com.ss.android.ugc.trill:id/wz7')
  })
})

describe('nextButtonIn on the editor screen — the correction the build made (plan 113 status line item 1)', () => {
  test('returns a node on screen-editor.json — a naive className === "Button" match would return null here, because the label sits on a non-clickable TextView', () => {
    const editor = loadFixture('screen-editor.json')
    const node = nextButtonIn(editor, 'editor')
    expect(node).not.toBeNull()
    expect(node?.text.trim()).toBe('Berikutnya')
    expect(node?.className).toBe('android.widget.TextView')
    expect(node?.clickable).toBe(false)
    // Reproduces the earlier, wrong implementation's own filter, to prove the correction is real:
    const naive = findAll(editor, (n) => n.text.trim() === 'Berikutnya' && n.className === 'android.widget.Button')
    expect(naive).toEqual([])
  })
})

describe('pickerSortLabel, pickerCells, captionField — the remaining screen-specific reads', () => {
  test('pickerSortLabel reads "Terbaru" (newest-first) on screen-picker.json', () => {
    expect(pickerSortLabel(loadFixture('screen-picker.json'))).toBe('Terbaru')
  })

  test('pickerSortLabel is null when the tv_title anchor is not on the tree', () => {
    expect(pickerSortLabel(loadFixture('screen-post.json'))).toBeNull()
  })

  test('pickerCells finds the one cell on screen-picker.json and its own duration text', () => {
    const cells = pickerCells(loadFixture('screen-picker.json'))
    expect(cells).toHaveLength(1)
    expect(cells[0]?.durationText).toBe('00:06')
    expect(cells[0]?.centre).toEqual({ x: Math.round((4 + 239) / 2), y: Math.round((237 + 475) / 2) })
  })

  test('pickerCells is empty when the viewpager_choose_media anchor is absent', () => {
    expect(pickerCells(loadFixture('screen-post.json'))).toEqual([])
  })

  test('captionField finds the single EditText on screen-post.json', () => {
    const field = captionField(loadFixture('screen-post.json'))
    expect(field).not.toBeNull()
    expect(field?.className).toBe('android.widget.EditText')
    expect(field?.resourceId).toBe('com.ss.android.ugc.trill:id/gya')
  })

  test('captionField is null when no EditText is present (screen-picker.json)', () => {
    expect(captionField(loadFixture('screen-picker.json'))).toBeNull()
  })
})
