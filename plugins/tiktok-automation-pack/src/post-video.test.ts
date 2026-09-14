import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { UiNodeSchema, type UiNode } from '@enkaku/protocol'
import {
  captionLanded,
  captionTextToClear,
  createButtonOnScreen,
  descNodeOnScreen,
  endsInTagToken,
  feedNavOnScreen,
  gridEmptyState,
  insideFrame,
  judgeGrid,
  labelMatches,
  keyboardDismissPoint,
  keyboardShowing,
  normaliseCaption,
  onScreenCaptionField,
  parseViews,
  postButtonOnScreen,
  postCoveredByKeyboard,
  postScreenStillShowing,
  readGrid,
  readNewestCell,
} from './post-video'

/**
 * `readNewestCell` — what the own-profile grid says about THIS post.
 *
 * Measured 2026-09-11 on the owner's moto g06: an account with six existing
 * videos, the upload stuck at "Mengunggah... 4%", and a run that reported
 * `outcome: "posted"` because the old confirmation accepted any grid-shaped
 * cell. The trees below are synthetic but shaped exactly like that dump —
 * cells carrying only a view-count label, the bottom nav beneath them — and
 * deliberately carry no account name, because the real dump did.
 */

const W = 720
const MENU_BOTTOM = 540

function node(over: Partial<UiNode> & { bounds: UiNode['bounds'] }): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.FrameLayout',
    packageName: 'com.ss.android.ugc.trill',
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...over,
  } as UiNode
}

/** One grid cell, 240x321 like the real ones, carrying a single label the way TikTok draws it. */
function cell(col: number, row: number, label: string): UiNode {
  const left = col * 240
  const top = 546 + row * 321
  return node({
    clickable: true,
    bounds: { left, top, right: left + 239, bottom: top + 320 },
    children: [node({ text: label, bounds: { left: left + 10, top: top + 280, right: left + 90, bottom: top + 310 } })],
  })
}

/** A bottom-nav tab: clickable and roughly cell-shaped, which is how the old check was fooled by it. */
function navTab(col: number, label: string): UiNode {
  const left = col * 144
  return node({
    clickable: true,
    bounds: { left, top: 1470, right: left + 144, bottom: 1556 },
    children: [node({ text: label, bounds: { left, top: 1500, right: left + 144, bottom: 1540 } })],
  })
}

function profile(cells: UiNode[]): UiNode {
  return node({ bounds: { left: 0, top: 0, right: W, bottom: 1640 }, children: [...cells, navTab(0, 'Beranda'), navTab(1, 'Toko')] })
}

describe('readNewestCell', () => {
  /*
    The measured failure. Six videos from before the run, nothing new: the old
    check called this "posted". It is not.
  */
  test('an account whose newest video is an old one is NOT a confirmed post', () => {
    const tree = profile([
      cell(0, 0, '1.559'),
      cell(1, 0, '118,6 rb'),
      cell(2, 0, '1.130'),
      cell(0, 1, '8.198'),
      cell(1, 1, '1.075'),
      cell(2, 1, '106,1 rb'),
    ])
    expect(readNewestCell(tree, MENU_BOTTOM, W)).toEqual({ kind: 'old', views: '1.559' })
  })

  test('0 views on the newest cell is the one reading that means posted', () => {
    const tree = profile([cell(0, 0, '0'), cell(1, 0, '1.559'), cell(2, 0, '118,6 rb')])
    expect(readNewestCell(tree, MENU_BOTTOM, W)).toEqual({ kind: 'new' })
  })

  test('an upload still drawing its progress is submitted, not live', () => {
    const tree = profile([cell(0, 0, '4%'), cell(1, 0, '1.559')])
    expect(readNewestCell(tree, MENU_BOTTOM, W)).toEqual({ kind: 'uploading', percent: '4%' })
  })

  test('the newest is the top-left cell, whatever order the tree lists them in', () => {
    // The tree lists an old video first; the newest (top-left) is the 0.
    const tree = profile([cell(2, 1, '8.198'), cell(1, 0, '1.075'), cell(0, 0, '0')])
    expect(readNewestCell(tree, MENU_BOTTOM, W)).toEqual({ kind: 'new' })
  })

  /*
    The second way the old check was vacuous: the bottom nav's tabs are
    clickable and roughly cell-shaped. A profile with no videos at all must not
    be read as one with a video in it.
  */
  test('a profile with no videos is none — the bottom nav is not a grid cell', () => {
    expect(readNewestCell(profile([]), MENU_BOTTOM, W)).toEqual({ kind: 'none' })
  })
})

describe('parseViews', () => {
  test('reads the id-ID and English labels TikTok draws', () => {
    expect(parseViews('0')).toBe(0)
    expect(parseViews('1.559')).toBe(1559)
    expect(parseViews('118,6\u00a0rb')).toBe(118_600)
    expect(parseViews('2,1 jt')).toBe(2_100_000)
    expect(parseViews('3.5K')).toBe(3_500)
    expect(parseViews('Beranda')).toBeNull()
  })
})

describe('readGrid', () => {
  test('lists every cell newest first, and leaves a pinned cell out', () => {
    const pinned = cell(0, 0, '9.999')
    pinned.children.push(node({ text: 'Disematkan', bounds: { left: 10, top: 556, right: 120, bottom: 590 } }))
    const tree = profile([cell(1, 0, '0'), pinned, cell(2, 0, '1.559'), cell(0, 1, '118,6 rb')])
    expect(readGrid(tree, MENU_BOTTOM, W)).toEqual(['0', '1.559', '118,6 rb'])
  })

  /* 1.34.0: a profile page kept in the tree off to the side still carries its old grid. */
  test('cells outside the frame are not read', () => {
    const offLeft = cell(0, 0, '0')
    offLeft.bounds = { left: -720, top: 546, right: -481, bottom: 866 }
    const offRight = cell(0, 0, '9')
    offRight.bounds = { left: 720, top: 546, right: 959, bottom: 866 }
    const tree = profile([offLeft, offRight, cell(0, 0, '1.559'), cell(1, 0, '118,6 rb')])
    expect(readGrid(tree, MENU_BOTTOM, W)).toEqual(['1.559', '118,6 rb'])
  })
})

describe('gridEmptyState', () => {
  test('a "no videos" line below the profile header, on screen and not typed into', () => {
    const says = (over: Partial<UiNode>) => profile([node({ text: 'Belum ada video', bounds: { left: 200, top: 700, right: 520, bottom: 740 }, ...over })])
    expect(gridEmptyState(says({}), MENU_BOTTOM, W)).toBe(true)
    expect(gridEmptyState(says({ bounds: { left: 200, top: 300, right: 520, bottom: 340 } }), MENU_BOTTOM, W)).toBe(false)
    expect(gridEmptyState(says({ bounds: { left: -900, top: 700, right: -600, bottom: 740 } }), MENU_BOTTOM, W)).toBe(false)
    expect(gridEmptyState(says({ className: 'android.widget.EditText' }), MENU_BOTTOM, W)).toBe(false)
    expect(gridEmptyState(profile([cell(0, 0, '1.559')]), MENU_BOTTOM, W)).toBe(false)
  })
})

describe('descNodeOnScreen — the Profil tab that is actually drawn', () => {
  test('a hidden copy first in tree order is skipped, and the lowest on-screen one wins', () => {
    const hidden = node({ desc: 'Profil', clickable: true, bounds: { left: -1440, top: 1470, right: -1296, bottom: 1556 } })
    const avatar = node({ desc: 'Profil', clickable: true, bounds: { left: 600, top: 300, right: 700, bottom: 400 } })
    const tab = node({ desc: 'Profil', clickable: true, bounds: { left: 576, top: 1470, right: 720, bottom: 1556 } })
    const tree = node({ bounds: { left: 0, top: 0, right: W, bottom: 1640 }, children: [hidden, avatar, tab] })
    expect(descNodeOnScreen(tree, ['Profil'], W)).toBe(tab)
    expect(descNodeOnScreen(node({ bounds: { left: 0, top: 0, right: W, bottom: 1640 }, children: [hidden] }), ['Profil'], W)).toBeNull()
  })
})

/*
  1.34.1 — the production SM-A065F run read "the Profil tab is not on screen" over a feed whose screenshot
  showed it. No tree was saved, so these readings are made tolerant where a wrong match cannot follow.
*/
describe('labelMatches and descNodeOnScreen — a tab whose label carries more (1.34.1)', () => {
  const screen = (children: UiNode[]): UiNode => node({ bounds: { left: 0, top: 0, right: W, bottom: 1640 }, children })

  test('the label alone, or followed by something that is not a letter; never a longer word', () => {
    expect(labelMatches('Profil', 'Profil')).toBe(true)
    expect(labelMatches(' profil ', 'Profil')).toBe(true)
    expect(labelMatches('Profil, 2 notifikasi', 'Profil')).toBe(true)
    expect(labelMatches('Profile', 'Profil')).toBe(false)
    expect(labelMatches('Menu profil', 'Profil')).toBe(false)
    expect(labelMatches('', 'Profil')).toBe(false)
    expect(labelMatches('Profil', '')).toBe(false)
  })

  test('a badged desc, or a text that is exactly the label, reads as the tab; a caption that starts with it does not', () => {
    const badged = node({ desc: 'Profil, 2 notifikasi', clickable: true, bounds: { left: 576, top: 1470, right: 720, bottom: 1556 } })
    expect(descNodeOnScreen(screen([badged]), ['Profil'], W)).toBe(badged)
    const label = node({ text: 'Profil', bounds: { left: 600, top: 1520, right: 700, bottom: 1550 } })
    expect(descNodeOnScreen(screen([label]), ['Profil'], W)).toBe(label)
    const caption = node({ text: 'Profil saya', bounds: { left: 20, top: 1300, right: 400, bottom: 1340 } })
    expect(descNodeOnScreen(screen([caption]), ['Profil'], W)).toBeNull()
  })
})

describe('insideFrame — rounding at the edge is not a page off to the side (1.34.1)', () => {
  test('a pixel past the edge still counts; a page a screen away does not', () => {
    expect(insideFrame({ bounds: { left: 576, top: 1470, right: 721, bottom: 1556 } }, W)).toBe(true)
    expect(insideFrame({ bounds: { left: -1440, top: 1470, right: -1296, bottom: 1556 } }, W)).toBe(false)
    expect(insideFrame({ bounds: { left: 700, top: 1470, right: 1440, bottom: 1556 } }, W)).toBe(false)
    expect(insideFrame({ bounds: { left: 10, top: 10, right: 10, bottom: 50 } }, W)).toBe(false)
  })
})

describe('createButtonOnScreen and feedNavOnScreen (1.34.1)', () => {
  const FRAME_1600 = { width: 720, height: 1600 }
  const screen = (children: UiNode[]): UiNode => node({ bounds: { left: 0, top: 0, right: W, bottom: 1600 }, children })
  const tab = (left: number, desc: string): UiNode => node({ desc, clickable: true, bounds: { left, top: 1420, right: left + 144, bottom: 1506 } })

  test('"+" is the create node in the middle of the bottom nav, and only there', () => {
    const plus = tab(288, 'Buat')
    expect(createButtonOnScreen(screen([plus]), FRAME_1600)).toBe(plus)
    expect(createButtonOnScreen(screen([tab(288, 'Create')]), FRAME_1600)).not.toBeNull()
    expect(createButtonOnScreen(screen([node({ desc: 'Create', clickable: true, bounds: { left: 20, top: 200, right: 200, bottom: 260 } })]), FRAME_1600)).toBeNull()
    expect(createButtonOnScreen(screen([tab(576, 'Buat')]), FRAME_1600)).toBeNull()
    expect(createButtonOnScreen(screen([]), FRAME_1600)).toBeNull()
  })

  test('the nav is on screen only with both its Home and Profil tabs', () => {
    expect(feedNavOnScreen(screen([tab(0, 'Beranda'), tab(576, 'Profil')]), W)).toBe(true)
    expect(feedNavOnScreen(screen([tab(0, 'Home'), tab(576, 'Profile')]), W)).toBe(true)
    expect(feedNavOnScreen(screen([tab(0, 'Beranda')]), W)).toBe(false)
    expect(feedNavOnScreen(screen([tab(-1440, 'Beranda'), tab(576, 'Profil')]), W)).toBe(false)
  })
})

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__')

function loadFixture(name: string): UiNode {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as { node: unknown }
  return UiNodeSchema.parse(raw.node)
}

const FRAME = { width: 720, height: 1640 }

/** A copy of `tree` with `fn` applied to every node. */
function edited(tree: UiNode, fn: (n: UiNode) => void): UiNode {
  const copy = structuredClone(tree)
  const visit = (n: UiNode): void => {
    fn(n)
    for (const c of n.children) visit(c)
  }
  visit(copy)
  return copy
}

const withCaption = (tree: UiNode, caption: string): UiNode =>
  edited(tree, (n) => {
    if (n.className === 'android.widget.EditText') n.text = caption
  })

/** A Gboard window over the bottom of the screen from `top` down — synthetic: no TikTok dump with the keyboard up is checked in. */
function withKeyboard(tree: UiNode, top: number): UiNode {
  const copy = structuredClone(tree)
  const pkg = 'com.google.android.inputmethod.latin'
  const key = (left: number, row: number): UiNode =>
    node({ packageName: pkg, clickable: true, desc: 'q', bounds: { left, top: top + 20 + row * 120, right: left + 70, bottom: top + 130 + row * 120 } })
  const keys = [0, 1, 2].flatMap((row) => Array.from({ length: 10 }, (_, i) => key(i * 72, row)))
  copy.children.push(node({ packageName: pkg, bounds: { left: 0, top, right: 720, bottom: 1640 }, children: keys }))
  return copy
}

describe('the post screen (screen-post.json) — caption, Post button, keyboard (1.34.0)', () => {
  const post = loadFixture('screen-post.json')

  test('the on-screen Post button is the "Posting" button', () => {
    expect(postButtonOnScreen(post, FRAME.width)?.bounds).toEqual({ left: 367, top: 1451, right: 699, bottom: 1535 })
  })

  test('a stale "Posting" off to the side, first in tree order, is not the button', () => {
    const stale = structuredClone(post)
    stale.children.unshift(node({ text: 'Posting', clickable: true, className: 'android.widget.Button', bounds: { left: -1053, top: 1451, right: -721, bottom: 1535 } }))
    expect(postButtonOnScreen(stale, FRAME.width)?.bounds.left).toBe(367)
  })

  test('a caption reading "Post" is not the Post button', () => {
    const onlyField = node({ bounds: { left: 0, top: 0, right: 720, bottom: 1640 }, children: [node({ className: 'android.widget.EditText', text: 'Post', clickable: true, bounds: { left: 28, top: 162, right: 449, bottom: 433 } })] })
    expect(postButtonOnScreen(onlyField, FRAME.width)).toBeNull()
  })

  test('no keyboard on the checked-in screen: nothing to put away', () => {
    expect(keyboardShowing(post, FRAME)).toBe(false)
    expect(keyboardDismissPoint(post, FRAME)).toBeNull()
  })

  test('a keyboard over Post is seen, and the dismiss tap lands on plain page above it — clear of every control and the caption', () => {
    const typing = withKeyboard(post, 1000)
    expect(keyboardShowing(typing, FRAME)).toBe(true)
    const button = postButtonOnScreen(typing, FRAME.width)
    expect(button).not.toBeNull()
    expect(postCoveredByKeyboard(typing, button as UiNode, FRAME)).toBe(true)

    const spot = keyboardDismissPoint(typing, FRAME)
    expect(spot).not.toBeNull()
    const { x, y } = spot as { x: number; y: number }
    expect(y).toBeLessThanOrEqual(1000 - 24)
    const hit = (n: UiNode): boolean => n.bounds.left - 24 <= x && x <= n.bounds.right + 24 && n.bounds.top - 24 <= y && y <= n.bounds.bottom + 24
    const small = (n: UiNode): boolean => (n.bounds.right - n.bounds.left) * (n.bounds.bottom - n.bounds.top) < FRAME.width * FRAME.height * 0.4
    const flat: UiNode[] = []
    const visit = (n: UiNode): void => {
      flat.push(n)
      for (const c of n.children) visit(c)
    }
    visit(typing)
    expect(flat.filter((n) => (n.clickable && small(n)) || n.className === 'android.widget.EditText').filter(hit)).toEqual([])
  })

  test('Post moved above the keyboard (E13) is not covered by it', () => {
    const moved = edited(withKeyboard(post, 1000), (n) => {
      if (n.text === 'Posting') n.bounds = { left: 560, top: 70, right: 700, bottom: 147 }
    })
    expect(postCoveredByKeyboard(moved, postButtonOnScreen(moved, FRAME.width) as UiNode, FRAME)).toBe(false)
  })

  test('still showing THIS caption with Post on screen is a tap not taken; anything else is not', () => {
    const typed = withCaption(post, 'Oke banget #fyp')
    expect(postScreenStillShowing(typed, FRAME.width, 'Oke  banget #fyp ')).toBe(true)
    expect(postScreenStillShowing(typed, FRAME.width, 'Oke banget fyp')).toBe(false)
    expect(postScreenStillShowing(post, FRAME.width, 'Oke banget #fyp')).toBe(false)
    const shifted = edited(typed, (n) => {
      n.bounds = { ...n.bounds, left: n.bounds.left - 2000, right: n.bounds.right - 2000 }
    })
    expect(onScreenCaptionField(shifted, FRAME.width)).toBeNull()
    expect(postScreenStillShowing(shifted, FRAME.width, 'Oke banget #fyp')).toBe(false)
  })
})

describe('captionLanded — the whole caption, # and @ included (1.34.0)', () => {
  test('whitespace collapses, nothing else is forgiven', () => {
    expect(captionLanded({ text: 'Oke banget\n\n#fyp  @enkaku ' }, 'Oke banget #fyp @enkaku')).toBe(true)
    expect(captionLanded({ text: 'Oke banget fyp @enkaku' }, 'Oke banget #fyp @enkaku')).toBe(false)
    expect(captionLanded({ text: 'Oke banget #fyp enkaku' }, 'Oke banget #fyp @enkaku')).toBe(false)
    expect(captionLanded({ text: 'Oke banget #fy' }, 'Oke banget #fyp')).toBe(false)
    expect(captionLanded({ text: 'oke banget #fyp' }, 'Oke banget #fyp')).toBe(false)
  })

  test('a field showing only its placeholder holds nothing', () => {
    expect(captionLanded({ text: 'Tambah deskripsi...' }, 'Oke banget #fyp')).toBe(false)
    expect(captionLanded({ text: 'Tambah deskripsi...' }, '')).toBe(true)
  })

  test('normaliseCaption treats zero-width characters as the whitespace they sit in', () => {
    expect(normaliseCaption('a\u200b b\n\n#c ')).toBe('a b #c')
  })
})

/*
  The second 2026-09-11 hole: the account's newest video was an earlier test
  post still at 0 views, so "the newest cell shows 0" was already true before
  the run posted anything. Only a grid shifted by one proves a new cell.
*/
describe('judgeGrid — a new post pushes every earlier cell one place along', () => {
  const before = ['0', '1.559', '118,6 rb', '1.130', '8.198', '1.075']

  test('the measured case: an old 0-view post on top, nothing new, is not posted', () => {
    expect(judgeGrid(before, [...before])).toEqual({ kind: 'same' })
  })

  test('the same account after a real post: shifted by one, the old 0 now second', () => {
    expect(judgeGrid(before, ['0', '0', '1.559', '118,6 rb', '1.130', '8.198'])).toEqual({ kind: 'new' })
  })

  test('views that grew a little while the run was busy still line up', () => {
    expect(judgeGrid(['12', '1.559'], ['0', '14', '1.561'])).toEqual({ kind: 'new' })
    expect(judgeGrid(['12', '1.559'], ['14', '1.561'])).toEqual({ kind: 'same' })
  })

  test('the newest going from a real count to 0 is new — views never fall to 0', () => {
    expect(judgeGrid(['12', '1.559'], ['0', '12'])).toEqual({ kind: 'new' })
  })

  /*
    1.34.0: an empty "before" is no baseline. A grid read before its labels arrived is also empty, and
    reading that as "the profile had no videos" turned any later cell into a false `posted`.
  */
  test('an empty baseline is no baseline — one video after it is never new', () => {
    expect(judgeGrid([], ['0'])).toEqual({ kind: 'no-baseline', views: '0' })
    expect(judgeGrid([], ['1.559', '118,6 rb'])).toEqual({ kind: 'no-baseline', views: '1.559' })
  })

  test('an upload in flight is uploading, whatever the baseline', () => {
    expect(judgeGrid(before, ['4%', ...before])).toEqual({ kind: 'uploading', percent: '4%' })
    expect(judgeGrid(null, ['4%'])).toEqual({ kind: 'uploading', percent: '4%' })
  })

  test('an unreadable baseline never confirms, not even a newest cell at 0 views', () => {
    expect(judgeGrid(null, ['0', '1.559'])).toEqual({ kind: 'no-baseline', views: '0' })
    expect(judgeGrid(null, ['1.559'])).toEqual({ kind: 'no-baseline', views: '1.559' })
    expect(judgeGrid(null, [])).toEqual({ kind: 'none' })
  })

  test('every cell at 0 before and after is not enough to call it posted', () => {
    expect(judgeGrid(['0', '0'], ['0', '0'])).toEqual({ kind: 'same' })
  })
})

describe('endsInTagToken — when the suggestion list would cover the Post button', () => {
  test('a caption ending in a hashtag or mention', () => {
    expect(endsInTagToken('test upload enkaku 2 #test')).toBe(true)
    expect(endsInTagToken('hi @someone')).toBe(true)
    expect(endsInTagToken('#solo')).toBe(true)
  })

  test('a caption that ends in plain text, or already ends the tag', () => {
    expect(endsInTagToken('#test upload enkaku')).toBe(false)
    expect(endsInTagToken('test upload #test ')).toBe(false)
    expect(endsInTagToken('price#1')).toBe(false)
    expect(endsInTagToken('')).toBe(false)
  })
})

/**
 * The caption field's placeholder is not content (1.31.0). The farm's tree has no hint field, so an
 * empty field reports "Tambah deskripsi..." as its text; on the production SM-A075F (run 3f250632)
 * clearing it sent ~60 DEL presses that backed TikTok out of the post screen.
 */
describe('captionTextToClear', () => {
  test('the Indonesian and English placeholders read as an empty field', () => {
    expect(captionTextToClear({ text: 'Tambah deskripsi...' })).toBe('')
    expect(captionTextToClear({ text: 'Tambah deskripsi…' })).toBe('')
    expect(captionTextToClear({ text: 'Add description' })).toBe('')
  })

  test('real text is still cleared — a restored draft must not be interleaved with the new caption', () => {
    expect(captionTextToClear({ text: '#test #video #fyp' })).toBe('#test #video #fyp')
    expect(captionTextToClear({ text: 'Tambah deskripsi video ini nanti' })).toBe('Tambah deskripsi video ini nanti')
  })

  test('an empty field is empty', () => {
    expect(captionTextToClear({ text: '   ' })).toBe('')
  })
})
