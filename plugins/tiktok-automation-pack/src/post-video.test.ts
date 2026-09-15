import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { UiNodeSchema, type UiNode } from '@enkaku/protocol'
import { closeUnansweredSheets, galleryButtonBesideModes } from './post-video'
import { UPLOAD_MODAL_POLICIES } from './modals'
import {
  captionLanded,
  captionPieces,
  captionTextToClear,
  confirmDeleteButton,
  createButtonOnScreen,
  descNodeOnScreen,
  draftCount,
  draftsEntry,
  draftsFolderControls,
  draftsFolderCount,
  draftsFolderShowing,
  selectModeShowing,
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
  profileTabToRetap,
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

  /* 1.35.0: the Samsung fleet's empty profiles (production bundles 04fe3367 ui/00024, 4063f322 ui/00024 and ui/00065). */
  test('the Samsung empty profile: its two lines and its "Unggah" (upload_work) button — but never an upload in progress', () => {
    const says = (over: Partial<UiNode>) => profile([node({ bounds: { left: 182, top: 791, right: 538, bottom: 832 }, ...over })])
    expect(gridEmptyState(says({ text: 'Bagikan video kenangan' }), MENU_BOTTOM, W)).toBe(true)
    expect(gridEmptyState(says({ text: 'Bagikan rutinitas harian Anda' }), MENU_BOTTOM, W)).toBe(true)
    expect(gridEmptyState(says({ text: 'Unggah', className: 'android.widget.Button', clickable: true }), MENU_BOTTOM, W)).toBe(true)
    expect(gridEmptyState(says({ resourceId: 'com.ss.android.ugc.trill:id/upload_work', className: 'android.widget.Button' }), MENU_BOTTOM, W)).toBe(true)
    expect(gridEmptyState(says({ text: 'Mengunggah... 4%' }), MENU_BOTTOM, W)).toBe(false)
  })
})

/**
 * The caption is typed in pieces (1.35.0). The guest agent types one code point at a time and the
 * drivers gave a call 15 s, about 160 characters: 200- and 306-character captions failed
 * "guest agent did not respond within 15000ms" on the Samsung fleet (bundles 04fe3367, 4063f322).
 */
describe('captionPieces', () => {
  const codePoints = (s: string): number => [...s].length

  test('a short caption is one piece', () => {
    expect(captionPieces('Oke banget #fyp')).toEqual(['Oke banget #fyp'])
  })

  test('a long caption joins back exactly, no piece is over 60 code points, and every piece but the last ends after a space', () => {
    const caption = 'Sambil nunggu, kita cek zona buy dulu ya. Pernah kena SL dulu, baru harga jalan sesuai analisa. '.repeat(3) + '#trading #saham #fyp'
    const pieces = captionPieces(caption)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.join('')).toBe(caption)
    for (const piece of pieces) expect(codePoints(piece)).toBeLessThanOrEqual(60)
    for (const piece of pieces.slice(0, -1)) expect(/\s$/u.test(piece)).toBe(true)
  })

  test('never cuts inside a grapheme: surrogate pairs, skin tones and ZWJ families stay whole', () => {
    const family = '👨‍👩‍👧' // five code points, one grapheme
    const caption = `${family}👋🏽`.repeat(20) // no spaces at all
    const pieces = captionPieces(caption)
    expect(pieces.join('')).toBe(caption)
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    for (const piece of pieces) {
      expect(codePoints(piece)).toBeLessThanOrEqual(60)
      for (const { segment } of segmenter.segment(piece)) expect([family, '👋🏽']).toContain(segment)
    }
  })

  test('a word longer than a piece is cut between its letters, and nothing is lost', () => {
    const word = 'a'.repeat(130)
    const pieces = captionPieces(`hi ${word} bye`)
    expect(pieces.join('')).toBe(`hi ${word} bye`)
    for (const piece of pieces) expect(codePoints(piece)).toBeLessThanOrEqual(60)
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

/*
  A Profil tap that was not taken (1.45.0). Production job 64d97391 (English build, 720x1600, 2026-09-15): the nav row
  "Home" [0,1422][144,1520] … "Profile" [576,1422][720,1520], the top bar "Friends"/"Following"/"For You", and the
  For You feed behind — as the capture after the tap showed. The feed's own nodes are placeholders in their region.
*/
describe('profileTabToRetap — the For You feed still up after "Profile" was tapped (1.45.0)', () => {
  const box = (left: number, top: number, right: number, bottom: number): UiNode['bounds'] => ({ left, top, right, bottom })
  const tab = (left: number, desc: string): UiNode => node({ desc, clickable: true, bounds: box(left, 1422, left + 144, 1520) })
  const feed = (extra: UiNode[] = []): UiNode =>
    node({
      bounds: box(0, 0, W, 1600),
      children: [
        node({ desc: 'Friends', clickable: true, bounds: box(40, 70, 200, 130) }),
        node({ desc: 'Following', clickable: true, bounds: box(220, 70, 400, 130) }),
        node({ desc: 'For You', clickable: true, bounds: box(420, 70, 580, 130) }),
        node({ text: 'Lucky Putra', bounds: box(28, 1250, 300, 1290) }),
        tab(0, 'Home'),
        tab(144, 'Shop'),
        tab(288, 'Create'),
        tab(432, 'Inbox'),
        tab(576, 'Profile'),
        ...extra,
      ],
    })

  test('the feed with the Profile tab and nothing over it: the tab is tapped again', () => {
    expect(profileTabToRetap(feed(), W)?.bounds).toEqual(box(576, 1422, 720, 1520))
    expect(profileTabToRetap(node({ bounds: box(0, 0, W, 1600), children: [tab(0, 'Beranda'), tab(576, 'Profil')] }), W)?.desc).toBe('Profil')
  })

  test('the profile menu on screen means the tap was taken — no retap', () => {
    expect(profileTabToRetap(feed([node({ desc: 'Menu profil', clickable: true, bounds: box(640, 70, 706, 140) })]), W)).toBeNull()
    expect(profileTabToRetap(feed([node({ desc: 'Profile menu', clickable: true, bounds: box(640, 70, 706, 140) })]), W)).toBeNull()
  })

  test('a known dialog over the feed is not a retap — it is closed instead', () => {
    const sheet = node({ text: 'Add your phone number for extra security, easier account recovery, and quicker logins.', bounds: box(60, 983, 660, 1091) })
    expect(profileTabToRetap(feed([sheet]), W)).toBeNull()
  })

  test('no Profil tab on screen, or only one kept off to the side: nothing to tap', () => {
    const noTab = feed()
    noTab.children = noTab.children.filter((n) => n.desc !== 'Profile')
    expect(profileTabToRetap(noTab, W)).toBeNull()
    noTab.children.push(tab(-1440, 'Profile'))
    expect(profileTabToRetap(noTab, W)).toBeNull()
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
  /*
    1.40.0: `readOwnGrid` returns `[]` only for TikTok's own "no videos" state (an unloaded grid is `null`), so a
    proven-empty profile is a baseline: the first cell after it is this post. An unreadable one is still no baseline.
  */
  test('a profile proven empty before posting makes its first finished cell new; an unreadable one does not', () => {
    expect(judgeGrid([], ['0'])).toEqual({ kind: 'new' })
    expect(judgeGrid([], ['4%'])).toEqual({ kind: 'uploading', percent: '4%' })
    expect(judgeGrid([], [])).toEqual({ kind: 'none' })
    expect(judgeGrid(null, ['0'])).toEqual({ kind: 'no-baseline', views: '0' })
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

/*
  Clearing drafts (1.36.0). No dump of these screens is checked in: the nodes below are transcribed from a
  uiautomator dump of the owner's moto g06 (Android 15, TikTok id-ID, 720x1640) taken on 2026-09-15 — its ids,
  labels, and the bounds that dump gave. Where the transcription carried no bounds (the folder's header texts,
  the cells' own texts, "Menu profil") the bounds here are placeholders in the same region. The confirmation
  dialog was NOT measured: its nodes are invented to the one shape `confirmDeleteButton` accepts, and say so.
*/
describe('clearing drafts — the profile entry, the Drafts folder, select mode, the confirmation (1.36.0)', () => {
  const FRAME_DRAFTS = { width: 720, height: 1640 }
  const rid = (short: string): string => `com.ss.android.ugc.trill:id/${short}`
  const box = (left: number, top: number, right: number, bottom: number): UiNode['bounds'] => ({ left, top, right, bottom })
  const screen = (children: UiNode[]): UiNode => node({ bounds: box(0, 0, 720, 1640), children })

  const entry = (text = 'Draf: 2', dx = 0): UiNode =>
    node({ resourceId: rid('tv_draft'), text, className: 'android.widget.TextView', bounds: box(11 + dx, 557, 227 + dx, 585) })
  const profileWith = (extra: UiNode[]): UiNode =>
    screen([
      node({ desc: 'Menu profil', clickable: true, bounds: box(640, 70, 706, 140) }),
      node({ resourceId: rid('k_r'), text: 'Postingan', bounds: box(0, 480, 180, 540) }),
      ...extra,
    ])

  const header = (count = '2 draf'): UiNode[] => [
    node({ resourceId: rid('gf0'), text: count, bounds: box(28, 180, 120, 215) }),
    node({ resourceId: rid('gey'), text: ' · ', bounds: box(120, 180, 140, 215) }),
    node({ resourceId: rid('gex'), text: '4,1MB', bounds: box(140, 180, 230, 215) }),
    node({ resourceId: rid('gez'), text: 'Hanya Anda yang dapat melihat draf Anda. Terbitka…', bounds: box(28, 220, 692, 290) }),
    node({ resourceId: rid('ge0'), text: 'Urutkan berdasarkan: Ukuran file', clickable: true, bounds: box(28, 300, 400, 340) }),
  ]
  const cells = (selecting: boolean): UiNode[] =>
    [28, 271].map((left, i) =>
      node({
        clickable: true,
        bounds: box(left, 346, left + 232, 740),
        children: [
          ...(selecting
            ? [
                node({ resourceId: rid('gec'), desc: '@2131827210', clickable: true, bounds: [box(178, 354, 220, 396), box(421, 354, 463, 396)][i] as UiNode['bounds'] }),
                node({ resourceId: rid('geb'), text: '2,2MB', bounds: box(left + 10, 360, left + 90, 390) }),
              ]
            : []),
          node({ resourceId: rid('get'), text: 'Sep', bounds: box(left + 10, 460, left + 60, 490) }),
          node({ resourceId: rid('ges'), text: '15', bounds: box(left + 10, 490, left + 60, 530) }),
          node({ resourceId: rid('ge8'), desc: 'Musik', bounds: box(left + 10, 690, left + 40, 720) }),
          node({ resourceId: rid('ge9'), text: 'suara asli', bounds: box(left + 45, 690, left + 220, 720) }),
        ],
      }),
    )

  const pilih = node({ text: 'Pilih', desc: 'Pilih', clickable: true, bounds: box(623, 70, 706, 161) })
  const folder = screen([pilih, ...header(), ...cells(false)])
  const selectAll = node({ text: 'Pilih semua', desc: 'Pilih semua', clickable: true, bounds: box(14, 70, 190, 161) })
  const batalkan = node({ text: 'Batalkan', desc: 'Batalkan', clickable: true, bounds: box(566, 70, 706, 161) })
  const hapusBar = node({ resourceId: rid('cu1'), text: 'Hapus', clickable: true, bounds: box(28, 1465, 692, 1556) })
  const selecting = screen([selectAll, batalkan, ...header(), ...cells(true), hapusBar])

  /** UNMEASURED — no dump of what "Hapus" raises exists. A plain two-button dialog, the shape the reading accepts. */
  const dialog = (confirmLabel = 'Hapus', withRefusal = true): UiNode =>
    node({
      bounds: box(60, 600, 660, 1000),
      children: [
        node({ text: 'Hapus 2 draf?', bounds: box(90, 640, 630, 700) }),
        ...(withRefusal ? [node({ text: 'Batal', clickable: true, className: 'android.widget.Button', bounds: box(80, 880, 350, 960) })] : []),
        node({ text: confirmLabel, clickable: true, className: 'android.widget.Button', bounds: box(370, 880, 640, 960) }),
      ],
    })

  test('draftCount reads the profile\'s "Draf: 2"; no entry, one off to the side, or a caption is no count', () => {
    expect(draftCount(profileWith([entry()]), 720)).toBe(2)
    expect(draftsEntry(profileWith([entry()]), 720)?.node.bounds).toEqual(box(11, 557, 227, 585))
    // English — a guess, not measured.
    expect(draftCount(profileWith([entry('Drafts: 3')]), 720)).toBe(3)
    expect(draftCount(profileWith([]), 720)).toBeNull()
    expect(draftsEntry(profileWith([]), 720)).toBeNull()
    expect(draftsEntry(profileWith([entry('Draf: 2', -1440)]), 720)).toBeNull()
    expect(draftCount(profileWith([node({ text: 'Draf: 2 hari lagi', bounds: box(20, 900, 400, 940) })]), 720)).toBeNull()
    expect(draftCount(profileWith([node({ text: 'Draf: 2', className: 'android.widget.EditText', bounds: box(20, 900, 400, 940) })]), 720)).toBeNull()
  })

  test('a tv_draft whose words cannot be read is still an entry, with no count', () => {
    const unreadable = draftsEntry(profileWith([entry('Draf')]), 720)
    expect(unreadable).not.toBeNull()
    expect(unreadable?.count).toBeNull()
  })

  test('the Drafts folder: "2 draf" or "Pilih" in the title bar; the profile is not it', () => {
    expect(draftsFolderShowing(folder, FRAME_DRAFTS)).toBe(true)
    expect(draftsFolderCount(folder, 720)).toBe(2)
    expect(draftsFolderShowing(screen([pilih, ...cells(false)]), FRAME_DRAFTS)).toBe(true)
    expect(draftsFolderCount(screen([pilih]), 720)).toBeNull()
    expect(draftsFolderShowing(profileWith([entry()]), FRAME_DRAFTS)).toBe(false)
    // A "Pilih" lower on some other page is not the folder's own button.
    expect(draftsFolderShowing(screen([node({ text: 'Pilih', clickable: true, bounds: box(300, 800, 420, 880) })]), FRAME_DRAFTS)).toBe(false)
  })

  test('select mode is "Pilih semua" with "Batalkan"; its controls are the measured ones, and "Pilih semua" is never "Pilih"', () => {
    expect(selectModeShowing(folder, FRAME_DRAFTS)).toBe(false)
    expect(selectModeShowing(selecting, FRAME_DRAFTS)).toBe(true)
    expect(draftsFolderShowing(selecting, FRAME_DRAFTS)).toBe(true)

    const inFolder = draftsFolderControls(folder, FRAME_DRAFTS)
    expect(inFolder.select?.bounds).toEqual(box(623, 70, 706, 161))
    expect(inFolder.selectAll).toBeNull()
    expect(inFolder.delete).toBeNull()

    const inSelect = draftsFolderControls(selecting, FRAME_DRAFTS)
    expect(inSelect.select).toBeNull()
    expect(inSelect.selectAll?.bounds).toEqual(box(14, 70, 190, 161))
    expect(inSelect.cancel?.bounds).toEqual(box(566, 70, 706, 161))
    expect(inSelect.delete?.bounds).toEqual(box(28, 1465, 692, 1556))
    expect(inSelect.circles.map((c) => c.bounds)).toEqual([box(178, 354, 220, 396), box(421, 354, 463, 396)])
  })

  test('select mode alone has no confirmation: its own "Hapus" bar and "Batalkan" are never read as one', () => {
    expect(confirmDeleteButton(selecting, FRAME_DRAFTS)).toBeNull()
    // The same bar without its id is kept out by its bounds, and by sharing only the whole screen with "Batalkan".
    const noId = screen([selectAll, batalkan, ...cells(true), node({ text: 'Hapus', clickable: true, bounds: box(28, 1465, 692, 1556) })])
    expect(confirmDeleteButton(noId, FRAME_DRAFTS, [box(28, 1465, 692, 1556), box(566, 70, 706, 161)])).toBeNull()
    expect(confirmDeleteButton(noId, FRAME_DRAFTS)).toBeNull()
  })

  test('a dialog\'s exact "Hapus" beside a refusal is the confirmation — never the refusal, never a longer label, never a lone "Hapus" (dialog UNMEASURED)', () => {
    const exclude = [box(28, 1465, 692, 1556), box(566, 70, 706, 161), box(14, 70, 190, 161)]
    const asked = screen([selectAll, batalkan, ...cells(true), hapusBar, dialog()])
    expect(confirmDeleteButton(asked, FRAME_DRAFTS, exclude)?.bounds).toEqual(box(370, 880, 640, 960))
    expect(confirmDeleteButton(asked, FRAME_DRAFTS, exclude)?.text).toBe('Hapus')
    expect(confirmDeleteButton(screen([hapusBar, dialog('Delete')]), FRAME_DRAFTS)?.text).toBe('Delete')
    expect(confirmDeleteButton(screen([hapusBar, dialog('Hapus semua')]), FRAME_DRAFTS, exclude)).toBeNull()
    expect(confirmDeleteButton(screen([hapusBar, dialog('Hapus', false)]), FRAME_DRAFTS, exclude)).toBeNull()
  })

  /*
    MEASURED (1.42.0): the confirmation TikTok raised on the owner's Samsung SM-A075F (720x1600, id-ID), production
    run #17 on 2026-09-15, transcribed from its `drafts-no-confirmation` dump — the ids, texts, desc, clickable and
    bounds that dump gave. The dump's intermediate containers (depths 9–11 and the buttons' parent) are collapsed
    into one placeholder with the dialog's bounds, and the folder's own "Hapus" bar is placed lower on the screen.
  */
  const FRAME_SAMSUNG = { width: 720, height: 1600 }
  const measuredTitle = node({ resourceId: rid('yxo'), text: 'Hapus 1 draf?', className: 'android.widget.TextView', bounds: box(238, 656, 480, 703) })
  const measuredBody = node({
    resourceId: rid('f43'),
    text: 'Ini akan menghapus draf yang dipilih secara permanen dan menghemat 105,0 MB.',
    className: 'android.widget.TextView',
    bounds: box(135, 726, 576, 834),
  })
  const measuredHapus = node({ text: 'Hapus', clickable: true, className: 'android.widget.Button', bounds: box(360, 873, 622, 962) })
  const measuredKeep = node({ text: 'Pertahankan', clickable: true, className: 'android.widget.Button', bounds: box(97, 873, 359, 962) })
  const samsungBar = node({ resourceId: rid('cu1'), text: 'Hapus', clickable: true, bounds: box(28, 1425, 692, 1516) })
  const samsungAsked = (buttons: UiNode[]): UiNode =>
    node({
      bounds: box(0, 0, 720, 1600),
      children: [
        samsungBar,
        node({
          className: 'android.widget.FrameLayout',
          clickable: true,
          bounds: box(0, 0, 720, 1600),
          children: [
            node({
              resourceId: rid('visual_area'),
              className: 'android.widget.FrameLayout',
              desc: 'Dialog',
              clickable: true,
              bounds: box(97, 611, 622, 962),
              children: [measuredTitle, node({ bounds: box(97, 611, 622, 962), children: [measuredBody, ...buttons] })],
            }),
          ],
        }),
      ],
    })

  test('the measured "Hapus 1 draf?" dialog (#17): its "Hapus" is the confirmation, beside "Pertahankan"', () => {
    const hit = confirmDeleteButton(samsungAsked([measuredHapus, measuredKeep]), FRAME_SAMSUNG, [samsungBar.bounds])
    expect(hit?.bounds).toEqual(box(360, 873, 622, 962))
    expect(hit?.text).toBe('Hapus')
    // Without the exclusion the folder's own bar is still kept out, by its `cu1` id.
    expect(confirmDeleteButton(samsungAsked([measuredHapus, measuredKeep]), FRAME_SAMSUNG)?.bounds).toEqual(box(360, 873, 622, 962))
  })

  test('"Pertahankan" is never the confirmation: not alone, not beside an inexact "Hapus", and a lone "Hapus" is no dialog', () => {
    const exclude = [samsungBar.bounds]
    expect(confirmDeleteButton(samsungAsked([measuredKeep]), FRAME_SAMSUNG, exclude)).toBeNull()
    expect(confirmDeleteButton(samsungAsked([{ ...measuredHapus, text: 'Hapus semua' }, measuredKeep]), FRAME_SAMSUNG, exclude)).toBeNull()
    expect(confirmDeleteButton(samsungAsked([measuredHapus]), FRAME_SAMSUNG, exclude)).toBeNull()
    for (const buttons of [[measuredHapus, measuredKeep], [measuredKeep, measuredHapus]]) {
      expect(confirmDeleteButton(samsungAsked(buttons), FRAME_SAMSUNG, exclude)?.text).not.toBe('Pertahankan')
    }
  })
})

describe('the camera\'s gallery button beside the capture-mode strip (1.45.3)', () => {
  const node = (over: Partial<UiNode>): UiNode => ({ resourceId: '', text: '', desc: '', className: 'android.view.View', packageName: 'com.ss.android.ugc.trill', bounds: { left: 0, top: 0, right: 0, bottom: 0 }, clickable: false, enabled: true, focused: false, index: 0, children: [], ...over })

  test('the English moto camera (TikTok 46.6.3) reads it as upload_hot_area, the button left of "POST"', () => {
    const found = galleryButtonBesideModes(loadFixture('screen-camera-en-moto.json'), 720)
    expect(found?.resourceId.endsWith('upload_hot_area')).toBe(true)
    expect(found?.bounds).toEqual({ left: 0, top: 1407, right: 140, bottom: 1512 })
  })

  test('a camera whose ids are obfuscated still yields the button left of the strip, and nothing else in that row', () => {
    const tree = node({
      className: 'hierarchy',
      bounds: { left: 0, top: 0, right: 720, bottom: 1600 },
      children: [
        node({ resourceId: 'com.ss.android.ugc.trill:id/u_', clickable: true, bounds: { left: 0, top: 1407, right: 140, bottom: 1512 } }),
        node({ className: 'android.widget.TextView', text: 'POST', bounds: { left: 302, top: 1429, right: 419, bottom: 1508 } }),
        node({ className: 'android.widget.TextView', text: 'CREATE', bounds: { left: 419, top: 1429, right: 565, bottom: 1508 } }),
        // The record button sits above the strip; the side toolbar is right of it.
        node({ desc: 'Record video', clickable: true, bounds: { left: 263, top: 1186, right: 456, bottom: 1379 } }),
        node({ desc: 'Flip', clickable: true, bounds: { left: 622, top: 148, right: 720, bottom: 239 } }),
      ],
    })
    expect(galleryButtonBesideModes(tree, 720)?.resourceId).toBe('com.ss.android.ugc.trill:id/u_')
  })

  test('no strip, or nothing clickable left of it, is null — never a guess', () => {
    const noStrip = node({ className: 'hierarchy', bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, children: [node({ clickable: true, bounds: { left: 0, top: 1407, right: 140, bottom: 1512 } })] })
    expect(galleryButtonBesideModes(noStrip, 720)).toBeNull()
    const nothingLeft = node({ className: 'hierarchy', bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, children: [node({ text: 'POST', bounds: { left: 302, top: 1429, right: 419, bottom: 1508 } })] })
    expect(galleryButtonBesideModes(nothingLeft, 720)).toBeNull()
  })

  test('on the Indonesian camera fixtures it agrees with upload_hot_area wherever it finds anything', () => {
    for (const name of ['screen-camera-2026-09.json', 'screen-camera-wall.json']) {
      const found = galleryButtonBesideModes(loadFixture(name), 720)
      if (found) expect(found.resourceId.endsWith('upload_hot_area')).toBe(true)
    }
  })
})

describe('closeUnansweredSheets — BACK after Post, only while an answerable sheet is up (1.45.3)', () => {
  const blank = (children: UiNode[] = []): UiNode => ({ resourceId: '', text: '', desc: '', className: '', packageName: '', bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, clickable: false, enabled: true, focused: false, index: 0, children })
  const text = (t: string): UiNode => ({ ...blank(), text: t, bounds: { left: 40, top: 1000, right: 680, bottom: 1080 } })
  const run = async (trees: UiNode[]) => {
    const keys: string[] = []
    let i = 0
    const ctx = {
      device: { dump: async () => trees[Math.min(i++, trees.length - 1)], key: async (k: string) => void keys.push(k) },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as Parameters<typeof closeUnansweredSheets>[0]
    return { closed: await closeUnansweredSheets(ctx, UPLOAD_MODAL_POLICIES), keys }
  }

  test('an English widget offer whose answer was not found is closed with one BACK', async () => {
    const { closed, keys } = await run([blank([text('Touch and hold the widget to add it'), text('Maybe later')]), blank()])
    expect(closed).toEqual(['tt.widget-prompt-en'])
    expect(keys).toEqual(['BACK'])
  })

  test('nothing on screen: no BACK, so the feed is never left', async () => {
    expect(await run([blank()])).toEqual({ closed: [], keys: [] })
  })

  test('the security check (abort) is never backed out of', async () => {
    const { keys } = await run([blank([text('Mari kita lakukan pemeriksaan keamanan dengan cepat')])])
    expect(keys).toEqual([])
  })
})
