import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UiNodeSchema, type UiNode } from '@enkaku/protocol'
import { closeButton, commentSheetShowing, replyComposerShowing } from './index'
import { flatten } from './tree'

/*
  The comment sheet, from a real phone (1.50.0).

  The owner's wall showed a dozen phones parked in TikTok's comments mid warm-up, several of them on
  "Membalas <name>" with the farm's keyboard up — a reply this pack must never start, on every
  platform. `screen-comment-sheet.json` is that screen, dumped from the owner's moto g06 with the
  sheet plainly open (720×1640, id-ID, 2026-09-17).

  Until this file there was NO test for any of it — not for `commentSheetShowing`, not for
  `leaveCommentSheet`, not for `browseComments` — and no fixture of an open sheet anywhere in the
  repo. That is how 1.49.0 shipped a predicate looking for a node whose whole text is "Komentar"
  when no such node exists, and a swipe band measured against a field 600px from where it sits.
*/

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__')

function loadFixture(name: string): UiNode {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as { node: unknown }
  return UiNodeSchema.parse(raw.node)
}

function mkNode(partial: Partial<UiNode>): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: '',
    packageName: 'com.ss.android.ugc.trill',
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...partial,
  }
}

describe('commentSheetShowing — the screen 1.49.0 could not see', () => {
  test('the real open sheet is recognised', () => {
    expect(commentSheetShowing(loadFixture('screen-comment-sheet.json'))).toBe(true)
  })

  test('not vacuous: 1.49.0 looked for an exact "Komentar", and the sheet has no such node', () => {
    const tree = loadFixture('screen-comment-sheet.json')
    const titles = ['Komentar', 'Comments', 'Comment']
    const exact = flatten(tree).filter((n) => titles.includes(n.text.trim()) || titles.includes(n.desc.trim()))
    expect(exact).toHaveLength(0)
  })

  test('the title carries a LEFT-TO-RIGHT MARK that trim() does not remove — the reason the exact match failed', () => {
    const tree = loadFixture('screen-comment-sheet.json')
    const title = flatten(tree).find((n) => n.text.includes('16 komentar'))
    expect(title).toBeDefined()
    expect(title!.text.codePointAt(0)).toBe(0x200e)
    // The trap, spelled out: trim() leaves it in place, so `=== 'Komentar'` could never hold.
    expect(title!.text.trim().codePointAt(0)).toBe(0x200e)
  })

  test('a closed feed is NOT an open sheet, though its rail button says "komentar" in desc', () => {
    const feed = loadFixture('screen-feed-samsung-player-edittext.json')
    // Not vacuous: the feed really does carry the word, on the comment rail button's description.
    expect(flatten(feed).some((n) => /komentar/i.test(n.desc))).toBe(true)
    expect(commentSheetShowing(feed)).toBe(false)
  })

  test('a close button alone is not evidence — every modal in this app has one', () => {
    // `interruptions.ts`'s CLOSE_LABELS. A false positive here costs a BACK on the bare feed, which
    // leaves TikTok entirely.
    const modal = mkNode({ children: [mkNode({ desc: 'Tutup', clickable: true, className: 'android.widget.ImageView' })] })
    expect(commentSheetShowing(modal)).toBe(false)
  })
})

describe('closeButton — what the sheet is closed WITH', () => {
  test('the sheet carries a clickable "Tutup"', () => {
    const found = flatten(loadFixture('screen-comment-sheet.json')).filter(closeButton)
    expect(found).toHaveLength(1)
    expect(found[0]!.bounds).toEqual({ left: 664, top: 654, right: 699, bottom: 689 })
  })

  test('an unclickable label is not a close button', () => {
    expect(closeButton(mkNode({ desc: 'Tutup', clickable: false }))).toBe(false)
  })
})

describe('replyComposerShowing — a reply this pack never means to start', () => {
  test('the plain open sheet is not composing a reply', () => {
    expect(replyComposerShowing(loadFixture('screen-comment-sheet.json'))).toBe(false)
  })

  test('TikTok\'s reply placeholder is recognised, in both spellings', () => {
    expect(replyComposerShowing(mkNode({ children: [mkNode({ text: 'Membalas @someone' })] }))).toBe(true)
    expect(replyComposerShowing(mkNode({ children: [mkNode({ text: 'Replying to @someone' })] }))).toBe(true)
  })

  test('a focused input is a reply in progress whatever it says', () => {
    expect(replyComposerShowing(mkNode({ children: [mkNode({ className: 'android.widget.EditText', focused: true })] }))).toBe(true)
  })
})

describe('the swipe band — measured against the buttons it used to cross', () => {
  const H = 1640
  const W = 720
  /** `browseComments`' x is drawn from 0.25–0.7w; both bands below share it. */
  const X_LO = Math.round(0.25 * W)
  const X_HI = Math.round(0.7 * W)

  function replyButtons(): UiNode[] {
    return flatten(loadFixture('screen-comment-sheet.json')).filter((n) => n.text.trim() === 'Balas' && n.clickable)
  }

  /** Does a vertical drag between `from` and `to`, anywhere in the x range, pass over this node? */
  function crosses(n: UiNode, from: number, to: number): boolean {
    const [lo, hi] = from < to ? [from, to] : [to, from]
    const yOverlap = n.bounds.top <= hi && n.bounds.bottom >= lo
    const xOverlap = n.bounds.left <= X_HI && n.bounds.right >= X_LO
    return yOverlap && xOverlap
  }

  test('the sheet really does carry five reply buttons, in the x range the swipe draws from', () => {
    const buttons = replyButtons()
    expect(buttons).toHaveLength(5)
    expect(buttons.map((b) => b.bounds.top)).toEqual([802, 944, 1086, 1228, 1370])
    expect(buttons.every((b) => b.bounds.left <= X_HI && b.bounds.right >= X_LO)).toBe(true)
  })

  test('1.49.0 (0.72h → 0.30–0.42h) dragged across three of them — the bug', () => {
    const from = Math.round(0.72 * H) // 1181
    const to = Math.round(0.42 * H) // 689
    expect(replyButtons().filter((b) => crosses(b, from, to))).toHaveLength(3)
  })

  test('1.50.0 (0.46h → 0.26–0.36h) crosses none, at either end of its range', () => {
    const from = Math.round(0.46 * H) // 754
    for (const end of [0.26, 0.36]) {
      const to = Math.round(end * H)
      expect(replyButtons().filter((b) => crosses(b, from, to))).toHaveLength(0)
    }
  })

  test('and never reaches the input field, which sits far below where 1.49.0 believed', () => {
    const input = flatten(loadFixture('screen-comment-sheet.json')).find((n) => n.className === 'android.widget.EditText' && /komentar/i.test(n.text))
    expect(input).toBeDefined()
    // 1.49.0's comment claimed 0.50–0.57h (y820–935). It is at y1465–1519 (0.89–0.93h).
    expect(input!.bounds.top).toBe(1465)
    expect(crosses(input!, Math.round(0.46 * H), Math.round(0.26 * H))).toBe(false)
  })
})
