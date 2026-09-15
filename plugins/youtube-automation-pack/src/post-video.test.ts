import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import {
  bottomHomeTab,
  CONFIRM_PLAN,
  asciiTitle,
  youtubeTitle,
  cellShowsTitle,
  cellTitleKey,
  channelHeaderShown,
  createButton,
  detailsGeometry,
  discardButton,
  FARM_KEYBOARD_PACKAGE,
  galleryCellFor,
  galleryOpen,
  hiddenDialogWatch,
  hiddenWindow,
  isSelectedCell,
  isSignedOut,
  judgeChannel,
  keyboardDismissPoint,
  keyboardShowing,
  onThumbnailEditor,
  onDetailsScreen,
  readableDetails,
  thumbnailEditorExit,
  premiumPage,
  processingOverlay,
  readChannelCells,
  resumeDraftPrompt,
  trimDoneButton,
  uploadInProgress,
  viewChannelTarget,
} from './post-video'
import { findPopup } from './popups'
import { flatten, rowsById } from './tree'
import { CHANNEL_PULL_BAND, MAX_REFRESHES_IN_A_ROW, makeRng, planConfirmStep, pullToRefreshPath } from './behavior'
import type { ConfirmMove, ConfirmStep } from './behavior'

/**
 * `post-video`'s readings, against the screens of the 2026-09-11 hand walk on
 * the owner's moto g06 (720x1640, id-ID). The fixtures are those dumps with
 * the status bar dropped and the channel's name and handle replaced.
 */

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

describe('post-video — the looks after Upload (0.35.0)', () => {
  const plan = (seed: number, rounds = 300): ConfirmStep[] => {
    const rng = makeRng(seed)
    const moves: ConfirmMove[] = []
    return Array.from({ length: rounds }, () => {
      const step = planConfirmStep(rng, moves, CONFIRM_PLAN)
      moves.push(step.move)
      return step
    })
  }

  test('the same seed replays the same rounds', () => {
    expect(plan(42, 30)).toEqual(plan(42, 30))
  })

  test('pulls and trips Home are mixed: never Home twice in a row, never more than three pulls in a row', () => {
    for (const seed of [1, 7, 99, 2026]) {
      const moves = plan(seed).map((s) => (s.move === 'home' ? 'H' : 'R')).join('')
      expect(moves).toContain('H')
      expect(moves).toContain('R')
      expect(moves).not.toContain('HH')
      expect(moves).not.toContain('R'.repeat(MAX_REFRESHES_IN_A_ROW + 1))
    }
  })

  test('waits are jittered inside the plan, with the odd longer one', () => {
    const [lo, hi] = CONFIRM_PLAN.waitMs
    const waits = plan(11).map((s) => s.waitMs)
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(lo)
    expect(Math.max(...waits)).toBeLessThanOrEqual(Math.ceil(hi * 1.7))
    expect(waits.some((w) => w > hi)).toBe(true)
    expect(new Set(waits).size).toBeGreaterThan(250)
  })

  test('every look pulls to refresh — also after a trip Home, since re-opening the channel does not refresh it', () => {
    for (const s of plan(3)) {
      expect(s.pull).toBe(true)
      if (s.move === 'refresh') expect(s.lingerMs).toBe(0)
      else {
        expect(s.lingerMs).toBeGreaterThanOrEqual(1_500)
        expect(s.lingerMs).toBeLessThanOrEqual(5_000)
      }
    }
  })

  test('the pull starts and ends inside the channel\'s video list, on both measured channel screens, off both side edges', async () => {
    for (const name of ['screen-channel.json', 'screen-channel-uploading.json']) {
      const tree = await fixture(name)
      const root = rowsById(tree, 'action_bar_root')[0] as UiNode
      const list = rowsById(tree, 'results').find((n) => n.bounds.right > n.bounds.left) as UiNode
      const frame = { width: root.bounds.right, height: root.bounds.bottom }
      const rng = makeRng(5)
      for (let i = 0; i < 300; i++) {
        const p = pullToRefreshPath(frame, rng, CHANNEL_PULL_BAND)
        for (const pt of [p.from, p.to]) {
          expect(pt.y).toBeGreaterThan(list.bounds.top)
          expect(pt.y).toBeLessThan(list.bounds.bottom)
          expect(pt.x).toBeGreaterThan(frame.width * 0.2)
          expect(pt.x).toBeLessThan(frame.width * 0.8)
        }
        expect(p.to.y - p.from.y).toBeGreaterThanOrEqual(128)
      }
    }
  })

  test('the Home a round visits is the bottom bar\'s, never the channel\'s own "Beranda" tab', async () => {
    expect(bottomHomeTab(await fixture('screen-channel.json'))?.bounds).toEqual({ left: 0, top: 1472, right: 180, bottom: 1556 })
    expect(bottomHomeTab(await fixture('screen-channel-uploading.json'))?.bounds).toEqual({ left: 0, top: 1420, right: 144, bottom: 1510 })
  })
})

const W = 720

describe('youtubeTitle — a long caption fitted to 100 characters (0.34.0)', () => {
  // The production caption of 2026-09-15 row #2, emoji already dropped by `asciiTitle`.
  const caption =
    'Sambil nunggu, kita cek zona buy dulu ya. Market hari ini tuh agak-agak aneh sih, sampe males mau liat lagi Ada yang ngerasain hal yang sama hari ini? #trading #market #zonabuy #tradinglife #marketupdate #AkademiBitorex #fyp'

  test('keeps hashtags at the end, cuts the text at a word, and never passes 100', () => {
    const { title, droppedTags, cut } = youtubeTitle(caption)
    expect(title.length).toBeLessThanOrEqual(100)
    expect(cut).toBe(true)
    // Cut at a word, and the punctuation left dangling at the cut is dropped.
    expect(title).toStartWith('Sambil nunggu, kita cek zona buy dulu ya #')
    expect(title).toContain('#trading')
    // The text is cut on a word boundary: the caption goes on with a non-letter right where the title's text stops.
    const body = title.slice(0, title.indexOf(' #'))
    expect(caption.startsWith(body)).toBe(true)
    expect(caption.charAt(body.length)).toMatch(/[^\p{L}\p{N}]/u)
    // What did not fit is reported, and every kept tag is one of the caption's.
    const kept = title.split(' ').filter((w) => w.startsWith('#'))
    expect([...kept, ...droppedTags].sort()).toEqual(['#AkademiBitorex', '#fyp', '#market', '#marketupdate', '#trading', '#tradinglife', '#zonabuy'].sort())
    expect(body.length).toBeGreaterThanOrEqual(40)
  })

  test('a caption that fits is left whole', () => {
    expect(youtubeTitle('Short and sweet #trading #fyp')).toEqual({ title: 'Short and sweet #trading #fyp', droppedTags: [], cut: false })
  })

  test('hashtags only, and text only, both stay within the limit', () => {
    const tagsOnly = youtubeTitle(Array.from({ length: 30 }, (_, i) => `#tag${i}`).join(' '))
    expect(tagsOnly.title.length).toBeLessThanOrEqual(100)
    expect(tagsOnly.title).toStartWith('#tag0 #tag1')
    const textOnly = youtubeTitle('kata '.repeat(40).trim())
    expect(textOnly.title.length).toBeLessThanOrEqual(100)
    expect(textOnly.title.endsWith('kata')).toBe(true)
  })
})

describe('the screens the farm can read', () => {
  test('home has the Create button; the signed-out You page is recognised', async () => {
    expect(createButton(await fixture('screen-home.json'))?.desc).toBe('Buat')
    expect(isSignedOut(await fixture('screen-signed-out.json'))).toBe(true)
    expect(isSignedOut(await fixture('screen-you.json'))).toBe(false)
  })

  test('Create with the camera refused offers "Tambahkan dari Galeri" by id', async () => {
    const tree = await fixture('screen-create-no-camera.json')
    expect(rowsById(tree, 'unified_permissions_primary_button')[0]?.text).toBe('Tambahkan dari Galeri')
    expect(hiddenWindow(tree)).toBe('none')
  })

  test('the gallery names each cell by file name, so the pushed video is found exactly', async () => {
    const tree = await fixture('screen-gallery.json')
    const cell = galleryCellFor(tree, 'post-39c02d8e-4705-4e1e-a24b-f4bf69a0d213-1.mp4')
    expect(cell?.bounds).toEqual({ left: 242, top: 244, right: 478, bottom: 663 })
    expect(galleryCellFor(tree, 'yt-not-pushed.mp4')).toBeNull()
    expect(isSelectedCell(tree, cell as UiNode)).toBe(false)
  })

  test('after the tap, the selection badge sits inside that cell and nowhere else', async () => {
    const tree = await fixture('screen-gallery-selected.json')
    const picked = galleryCellFor(tree, 'post-39c02d8e-4705-4e1e-a24b-f4bf69a0d213-1.mp4') as UiNode
    const neighbour = galleryCellFor(tree, 'post-a036793b-2c6f-4b0b-9447-1c424c8cce2d-1.mp4') as UiNode
    expect(isSelectedCell(tree, picked)).toBe(true)
    expect(isSelectedCell(tree, neighbour)).toBe(false)
    expect(rowsById(tree, 'multi_select_next_button')[0]?.text).toBe('Berikutnya')
  })

  test('the unfinished-edit prompt is recognised, and its start-over button found', async () => {
    const prompt = resumeDraftPrompt(await fixture('screen-resume-draft.json'))
    expect(prompt?.startOver?.text).toBe('Mulai dari awal')
    expect(resumeDraftPrompt(await fixture('screen-create-no-camera.json'))).toBeNull()
  })

  test('trim and editor carry their own next buttons', async () => {
    expect(rowsById(await fixture('screen-trim.json'), 'creation_next_button')[0]?.text).toBe('Selesai')
    expect(rowsById(await fixture('screen-shorts-editor.json'), 'shorts_post_bottom_button')[0]?.text).toBe('Berikutnya')
  })
})

describe('thumbnailEditorExit — leaving the editor a missed title tap opened (0.36.0)', () => {
  test('the editor\'s own back button, read by its id or its words', () => {
    const node = (resourceId: string, desc: string, children: UiNode[] = []): UiNode => ({ resourceId, text: '', desc, className: 'android.widget.ImageButton', packageName: 'com.google.android.youtube', bounds: { left: 20, top: 40, right: 110, bottom: 130 }, clickable: true, enabled: true, focused: false, index: 0, children })
    // Production #13's thumbnail editor: `edit_thumbnail_back`, "Keluar dari editor thumbnail", beside "Teks" and "Filter".
    const editor = node('', '', [node('com.google.android.youtube:id/edit_thumbnail_back', 'Keluar dari editor thumbnail'), node('com.google.android.youtube:id/shorts_edit_text_button', 'Teks')])
    expect(onThumbnailEditor(editor)).toBe(true)
    expect(thumbnailEditorExit(editor)?.desc).toBe('Keluar dari editor thumbnail')
    expect(thumbnailEditorExit(node('', '', [node('com.google.android.youtube:id/shorts_edit_text_button', 'Teks')]))).toBeNull()
  })
})

describe('hiddenWindow — the two screens Android hides from the reader', () => {
  test('a permission dialog over YouTube leaves no YouTube node at all', async () => {
    expect(hiddenWindow(await fixture('screen-permission-hidden.json'))).toBe('dialog')
  })

  test('the details screen leaves YouTube\'s frame with nothing in it', async () => {
    expect(hiddenWindow(await fixture('screen-details-hidden.json'))).toBe('details')
  })

  test('an ordinary readable screen is neither', async () => {
    expect(hiddenWindow(await fixture('screen-shorts-editor.json'))).toBe('none')
    expect(hiddenWindow(await fixture('screen-channel-draft.json'))).toBe('none')
  })
})

describe('onThumbnailEditor — where a mis-aimed details tap lands', () => {
  test('the thumbnail editor under its processing overlay is recognised', async () => {
    expect(onThumbnailEditor(await fixture('screen-thumbnail-editor.json'))).toBe(true)
    expect(onThumbnailEditor(await fixture('screen-shorts-editor.json'))).toBe(false)
  })
})

/*
  The "Memproses" overlay after the trim screen's "Selesai" (0.35.0). No fixture is checked in: the nodes below are
  only the ids and labels production runs #6 and #7 dumped (Samsung farm, 2026-09-15); their bounds are placeholders
  in the centre of a 720x1600 screen.
*/
describe('the details screen drawn readable (0.37.0)', () => {
  const rid = (short: string): string => `com.google.android.youtube:id/${short}`
  const screen = (children: UiNode[]): UiNode => node({ bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, children })
  // Production SM-A075F #71 (2026-09-15): the whole screen readable, as its screenshot showed it.
  const header = node({ text: 'Tambahkan detail', bounds: { left: 140, top: 110, right: 460, bottom: 170 } })
  const titleArea = node({ desc: 'Tambahkan teks pada video Shorts', clickable: true, bounds: { left: 190, top: 190, right: 699, bottom: 258 } })
  const upload = node({ resourceId: rid('upload_bottom_button'), text: 'Upload video Shorts', clickable: true, bounds: { left: 370, top: 1465, right: 699, bottom: 1535 } })

  test('reads as the details screen, with its own title area and Upload button to aim at', () => {
    const tree = screen([header, titleArea, upload])
    expect(onDetailsScreen(tree)).toBe(true)
    expect(readableDetails(tree)).toEqual({ upload, title: titleArea })
    // The toolbar variant (#66): the header and `upload_menu_button`, no bottom button.
    const toolbar = node({ resourceId: rid('upload_menu_button'), bounds: { left: 600, top: 100, right: 700, bottom: 180 } })
    expect(readableDetails(screen([header, toolbar]))?.upload).toEqual(toolbar)
  })

  test('the hidden details screen still counts; the Shorts editor and another app\'s header do not', () => {
    expect(onDetailsScreen(screen([node({ resourceId: rid('content'), bounds: { left: 0, top: 70, right: 720, bottom: 1556 } })]))).toBe(true)
    expect(onDetailsScreen(screen([node({ resourceId: rid('shorts_post_bottom_button'), text: 'Berikutnya', clickable: true, bounds: { left: 500, top: 1450, right: 700, bottom: 1530 } })]))).toBe(false)
    expect(readableDetails(screen([{ ...header, packageName: 'com.android.systemui' }]))).toBeNull()
  })
})

describe('processingOverlay — YouTube still working on the trimmed video', () => {
  const rid = (short: string): string => `com.google.android.youtube:id/${short}`
  const overlay = [
    node({ resourceId: rid('processing_indicator_spinner'), className: 'android.widget.ProgressBar', bounds: { left: 320, top: 700, right: 400, bottom: 780 } }),
    node({ resourceId: rid('processing_indicator_label'), className: 'android.widget.TextView', text: 'Memproses', bounds: { left: 280, top: 800, right: 440, bottom: 840 } }),
    node({ resourceId: rid('processing_indicator_sub_label'), className: 'android.widget.TextView', text: 'Mungkin perlu waktu beberapa saat', bounds: { left: 160, top: 850, right: 560, bottom: 890 } }),
  ]
  const trimDone = node({ resourceId: rid('shorts_trim_finish_trim_button'), text: 'Selesai', clickable: true, bounds: { left: 560, top: 80, right: 700, bottom: 150 } })
  const screen = (children: UiNode[]): UiNode => node({ bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, children })

  test('the spinner over the trim screen reads as processing, with its words', () => {
    expect(processingOverlay(screen([trimDone, ...overlay]))).toBe('Memproses — Mungkin perlu waktu beberapa saat')
    // The spinner alone still counts: the words are for the log, the ids are the evidence.
    expect(processingOverlay(screen([trimDone, overlay[0] as UiNode]))).toBe('')
  })

  test('the trim screen without it, an off-screen overlay, or another app\'s node is not processing', () => {
    expect(processingOverlay(screen([trimDone]))).toBeNull()
    expect(processingOverlay(screen(overlay.map((n) => ({ ...n, bounds: { left: 0, top: 0, right: 0, bottom: 0 } }))))).toBeNull()
    expect(processingOverlay(screen(overlay.map((n) => ({ ...n, packageName: 'com.android.systemui' }))))).toBeNull()
    expect(processingOverlay(screen([node({ text: 'Memproses', bounds: { left: 280, top: 800, right: 440, bottom: 840 } })]))).toBeNull()
  })
})

/** A YouTube node for the synthetic additions below; every field a dump carries. */
function node(over: Partial<UiNode>): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.view.View',
    packageName: 'com.google.android.youtube',
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...over,
  }
}

/** The fixture with `extra` added FIRST under its first window, so a depth-first walk meets them before the fixture's own nodes. */
async function withNodes(name: string, extra: UiNode[]): Promise<UiNode> {
  const tree = await fixture(name)
  ;(tree.children[0] as UiNode).children.unshift(...extra)
  return tree
}

describe('readChannelCells', () => {
  test('the draft the walk left behind is not a video', async () => {
    expect(readChannelCells(await fixture('screen-channel-draft.json'), W)).toEqual([])
  })

  test('only a cell drawn on screen is read — not one kept in the tree off to the side (0.30.0)', async () => {
    const tree = await withNodes('screen-channel-draft.json', [
      node({ clickable: true, desc: 'on screen short', bounds: { left: 239, top: 423, right: 478, bottom: 821 } }),
      node({ clickable: true, desc: 'off screen short', bounds: { left: -481, top: 423, right: -242, bottom: 821 } }),
      node({ clickable: true, desc: 'past the right edge', bounds: { left: 960, top: 423, right: 1199, bottom: 821 } }),
    ])
    expect(readChannelCells(tree, W)).toEqual(['on screen short'])
  })

  test('a channel\'s own "Beranda" tab is not taken for the bottom bar (0.30.0)', async () => {
    const tree = await withNodes('screen-channel-draft.json', [
      node({ clickable: true, desc: 'Beranda', bounds: { left: 28, top: 400, right: 141, bottom: 420 } }),
      node({ clickable: true, desc: 'below the tab', bounds: { left: 239, top: 423, right: 478, bottom: 821 } }),
    ])
    expect(readChannelCells(tree, W)).toEqual(['below the tab'])
  })
})

describe('cellShowsTitle — the whole title, or a visibly cut one', () => {
  const title = 'test upload enkaku 2 #test'

  test('the whole normalized title counts, # or not', () => {
    expect(cellShowsTitle('test upload enkaku 2 test · 0 x ditonton', title)).toBe(true)
    expect(cellShowsTitle('Test Upload Enkaku 2 #test, 0 x ditonton - putar Short', title)).toBe(true)
  })

  test('a title that lost keys does not', () => {
    expect(cellShowsTitle('test upload enkau 2 test · 0 x ditonton', title)).toBe(false)
  })

  test('a start of the title counts only where the channel shows an ellipsis', () => {
    const long = 'a much longer title that the channel grid cannot fit on two lines #shorts'
    expect(cellShowsTitle('a much longer title that the…', long)).toBe(true)
    expect(cellShowsTitle('a much longer title that the', long)).toBe(false)
    expect(cellShowsTitle('a much…', long)).toBe(false)
  })
})

describe('cellTitleKey — a cell is the same video when its view count moves', () => {
  test('view counts, ages and durations are left out', () => {
    expect(cellTitleKey('my short · 5 x ditonton')).toBe(cellTitleKey('my short · 1,2 rb x ditonton'))
    expect(cellTitleKey('my short · 12K views · 3 days ago')).toBe(cellTitleKey('my short · 13K views · 4 days ago'))
    expect(cellTitleKey('my short · 0:45')).toBe('my short')
    expect(cellTitleKey('my short')).not.toBe(cellTitleKey('other short'))
  })
})

describe('judgeChannel — posted means THIS Short appeared', () => {
  const title = 'test upload enkaku 2 #test'

  test('a new cell carrying the title is new', () => {
    expect(judgeChannel([], ['test upload enkaku 2 test · 0 x ditonton'], title)).toEqual({ kind: 'new' })
  })

  test('a new cell still processing is not posted yet', () => {
    expect(judgeChannel([], ['Memproses video'], title).kind).toBe('processing')
    expect(judgeChannel([], ['test upload enkaku 2 test · Memproses'], title).kind).toBe('processing')
  })

  test('one more video without this title is not posted — its title was not confirmed (0.30.0)', () => {
    expect(judgeChannel(['old short'], ['something', 'old short'], title)).toEqual({ kind: 'untitled-new' })
    // YouTube's default title after the typed one lost focus.
    expect(judgeChannel(['old short'], ['test upload · 0 x ditonton', 'old short'], title)).toEqual({ kind: 'untitled-new' })
  })

  test('the same channel as before is the same, and an unread one is unreadable', () => {
    expect(judgeChannel(['old short'], ['old short'], title)).toEqual({ kind: 'same' })
    expect(judgeChannel(['old short'], null, title)).toEqual({ kind: 'unreadable' })
  })

  test('an old cell that happens to share the title is not this post', () => {
    expect(judgeChannel(['test upload enkaku 2 test'], ['test upload enkaku 2 test'], title)).toEqual({ kind: 'same' })
  })

  test('an old same-title cell whose view count moved is still old (0.30.0)', () => {
    expect(judgeChannel(['test upload enkaku 2 test · 3 x ditonton'], ['test upload enkaku 2 test · 9 x ditonton'], title)).toEqual({ kind: 'same' })
  })

  test('the same title posted again is new: one more cell carries it', () => {
    expect(
      judgeChannel(['test upload enkaku 2 test · 3 x ditonton'], ['test upload enkaku 2 test · 0 x ditonton', 'test upload enkaku 2 test · 9 x ditonton'], title),
    ).toEqual({ kind: 'new' })
  })

  test('with no reading from before, a titled cell is not proof', () => {
    expect(judgeChannel(null, ['test upload enkaku 2 test · 0 x ditonton'], title)).toEqual({ kind: 'no-baseline', titled: true })
    expect(judgeChannel(null, ['old short'], title)).toEqual({ kind: 'no-baseline', titled: false })
  })
})

describe('hiddenDialogWatch — one empty tree is a transition frame, not a dialog (0.30.0)', () => {
  test('two readings in a row are a dialog', async () => {
    const empty = await fixture('screen-permission-hidden.json')
    const watch = hiddenDialogWatch()
    expect(watch.observe(empty)).toBe(false)
    expect(watch.confirmed).toBe(false)
    expect(watch.observe(empty)).toBe(true)
    expect(watch.confirmed).toBe(true)
  })

  test('a readable screen in between starts the count again', async () => {
    const empty = await fixture('screen-permission-hidden.json')
    const create = await fixture('screen-create-no-camera.json')
    const watch = hiddenDialogWatch()
    watch.observe(empty)
    watch.observe(create)
    expect(watch.observe(empty)).toBe(false)
    expect(watch.confirmed).toBe(false)
  })
})

describe('the keyboard over the details screen', () => {
  const keyboard = (): UiNode =>
    node({
      packageName: 'com.google.android.inputmethod.latin',
      bounds: { left: 0, top: 984, right: 720, bottom: 1556 },
      children: [node({ packageName: 'com.google.android.inputmethod.latin', clickable: true, desc: 'q', bounds: { left: 0, top: 1000, right: 72, bottom: 1100 } })],
    })

  test('a keyboard window in the tree is seen; the hidden details screen alone shows none', async () => {
    expect(keyboardShowing(await fixture('screen-details-hidden.json'))).toBe(false)
    expect(keyboardShowing(await withNodes('screen-details-hidden.json', [keyboard()]))).toBe(true)
  })

  test('the hidden details screen offers no readable spot to tap, so the member falls back to its measured header', async () => {
    expect(keyboardDismissPoint(await withNodes('screen-details-hidden.json', [keyboard()]))).toBeNull()
  })

  test('on a readable page, plain text above the keys is the spot — never a control', async () => {
    const tree = await withNodes('screen-details-hidden.json', [
      node({ text: 'Visibilitas', bounds: { left: 28, top: 600, right: 300, bottom: 640 } }),
      node({ clickable: true, text: 'Publik', bounds: { left: 28, top: 700, right: 692, bottom: 780 } }),
      keyboard(),
    ])
    expect(keyboardDismissPoint(tree)).toEqual({ x: 164, y: 620, label: 'Visibilitas' })
  })
})

describe('the Create button and the gallery cell are taken on screen only (0.30.0)', () => {
  test('an off-screen Create is not the button', async () => {
    const tree = await fixture('screen-home.json')
    for (const n of flattenAll(tree)) if (n.desc === 'Buat') n.bounds = { left: -1000, top: n.bounds.top, right: -856, bottom: n.bounds.bottom }
    expect(createButton(tree)).toBeNull()
  })
})

function flattenAll(n: UiNode): UiNode[] {
  return [n, ...n.children.flatMap(flattenAll)]
}

describe('asciiTitle — what adb can type', () => {
  test('keeps printable ASCII and drops the rest', () => {
    expect(asciiTitle('test upload enkaku 2 #test')).toBe('test upload enkaku 2 #test')
    expect(asciiTitle('kopi ☕ pagi  🌅 #ngopi')).toBe('kopi pagi #ngopi')
    expect(asciiTitle('🔥🔥')).toBe('')
  })
})


/**
 * YouTube's newer "Galeri" bottom sheet (0.28.0). Captured on the owner's production SM-A075F
 * (2026-09-14, run 1c0b1d4c), status bar dropped. Three runs failed "the gallery did not open" with
 * this sheet on screen, because the check only knew the older picker's header.
 */
describe('the gallery, in both of YouTube\'s pickers', () => {
  test('the bottom-sheet picker is recognised as the gallery, and so is the older one', async () => {
    expect(galleryOpen(await fixture('screen-gallery-sheet.json'))).toBe(true)
    expect(galleryOpen(await fixture('screen-gallery-selected.json'))).toBe(true)
  })

  test('a screen that is not a gallery is not mistaken for one', async () => {
    expect(galleryOpen(await fixture('screen-create-no-camera.json'))).toBe(false)
  })

  test('the pushed file is found by name in the bottom sheet, the same way as before', async () => {
    const sheet = await fixture('screen-gallery-sheet.json')
    expect(galleryCellFor(sheet, 'yt-1c0b1d4c-a3d8-440d-b410-249c6dc859c6-1.mp4')).not.toBeNull()
    expect(rowsById(sheet, 'multi_select_next_button')[0]?.text).toBe('Berikutnya')
  })
})

/**
 * 0.31.0 — the production SM-A075F exports of 2026-09-13/14 (720x1600, id-ID). Fixtures are ui trees only, with the
 * status bar dropped and channel names replaced: `screen-trim-finish.json` (f32d8f38 ui/00046),
 * `screen-you-label-row.json` (f32d8f38 ui/00027), `screen-premium-page.json` (ea9736fe ui/00032),
 * `screen-channel-uploading.json` (72395efa ui/00064, the title replaced by "#enkakutest") and
 * `screen-details-hidden-1600.json` (72395efa ui/00058).
 */
describe('trimDoneButton — the trim screen under either id (0.31.0)', () => {
  test('the renamed shorts_trim_finish_trim_button is the trim button, and so is the older creation_next_button', async () => {
    expect(trimDoneButton(await fixture('screen-trim-finish.json'))?.resourceId).toBe('com.google.android.youtube:id/shorts_trim_finish_trim_button')
    expect(trimDoneButton(await fixture('screen-trim.json'))?.resourceId).toBe('com.google.android.youtube:id/creation_next_button')
  })

  test('with neither id, the clickable "Selesai" is still found', async () => {
    const tree = await fixture('screen-trim-finish.json')
    for (const n of flatten(tree)) if (n.resourceId.endsWith('shorts_trim_finish_trim_button')) n.resourceId = 'com.google.android.youtube:id/some_future_id'
    expect(trimDoneButton(tree)?.text).toBe('Selesai')
  })

  test('the editor and the gallery have no trim button', async () => {
    expect(trimDoneButton(await fixture('screen-shorts-editor.json'))).toBeNull()
    expect(trimDoneButton(await fixture('screen-gallery-sheet.json'))).toBeNull()
    expect(trimDoneButton(await fixture('screen-gallery-selected.json'))).toBeNull()
  })
})

describe('viewChannelTarget — "Lihat channel" whether or not the label takes the tap (0.31.0)', () => {
  test('a clickable label is tapped itself', async () => {
    const target = viewChannelTarget(await fixture('screen-you.json'))
    expect(target?.node.desc).toBe('Lihat channel')
    expect(target?.node.clickable).toBe(true)
    expect(target?.point).toEqual({ x: 191, y: 363 })
  })

  test('a label that is not clickable is tapped through the row holding it, on the label itself', async () => {
    const target = viewChannelTarget(await fixture('screen-you-label-row.json'))
    expect(target?.node.bounds).toEqual({ left: 23, top: 154, right: 697, bottom: 335 })
    expect(target?.node.clickable).toBe(true)
    expect(target?.point).toEqual({ x: 463, y: 273 })
  })

  test('a page-sized container is never the target', async () => {
    const tree = await withNodes('screen-details-hidden-1600.json', [
      node({ clickable: true, bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, children: [node({ text: 'Lihat channel', bounds: { left: 300, top: 300, right: 440, bottom: 330 } })] }),
    ])
    expect(viewChannelTarget(tree)).toBeNull()
  })

  test('screens without the label have no target', async () => {
    expect(viewChannelTarget(await fixture('screen-premium-page.json'))).toBeNull()
    expect(viewChannelTarget(await fixture('screen-home.json'))).toBeNull()
  })
})

describe('premiumPage — the full-page offer "Lihat channel" can open (0.31.0)', () => {
  test('the page is recognised, and nothing else is', async () => {
    expect(premiumPage(await fixture('screen-premium-page.json'))).toBe(true)
    expect(premiumPage(await fixture('screen-you.json'))).toBe(false)
    expect(premiumPage(await fixture('screen-you-label-row.json'))).toBe(false)
    expect(premiumPage(await fixture('screen-channel-uploading.json'))).toBe(false)
    expect(premiumPage(await fixture('screen-premium-upsell.json'))).toBe(false)
  })

  test('it is not the popup popups.ts closes — it has no close control, so it is left with BACK', async () => {
    expect(findPopup(await fixture('screen-premium-page.json'))).toBeNull()
  })
})

describe('the channel right after Upload (0.31.0)', () => {
  const title = '#enkakutest'

  test('YouTube opens the channel itself, with the new cell still sending', async () => {
    const tree = await fixture('screen-channel-uploading.json')
    expect(channelHeaderShown(tree)).toBe(true)
    expect(uploadInProgress(tree)).toBe(true)
    expect(readChannelCells(tree, 720)).toEqual(['#enkakutest, Mengirim file • 1% · Action menu · Mengirim file • 1%', 'Tindakan lainnya · Belum ditonton'])
  })

  test('the You page says "Mengupload 1 video" while one is sending; without it, nothing is in progress', async () => {
    expect(uploadInProgress(await fixture('screen-you-label-row.json'))).toBe(false)
    const tree = await withNodes('screen-you-label-row.json', [node({ text: 'Mengupload 1 video', bounds: { left: 135, top: 1187, right: 615, bottom: 1217 } })])
    expect(uploadInProgress(tree)).toBe(true)
  })

  test('a titled cell still sending is processing, with a baseline or without — never new', async () => {
    const cells = readChannelCells(await fixture('screen-channel-uploading.json'), 720)
    const old = cells[1] as string
    expect(judgeChannel(null, cells, title)).toEqual({ kind: 'processing', words: cells[0] as string, titled: true })
    expect(judgeChannel([old], cells, title)).toEqual({ kind: 'processing', words: cells[0] as string, titled: true })
  })

  test('with no baseline, a titled cell this run saw uploading and now finished is new; unseen, it is not proof', () => {
    const finished = ['#enkakutest · 0 x ditonton', 'Tindakan lainnya · Belum ditonton']
    expect(judgeChannel(null, finished, title, { seenUploading: 1 })).toEqual({ kind: 'new' })
    expect(judgeChannel(null, finished, title)).toEqual({ kind: 'no-baseline', titled: true })
    expect(judgeChannel(null, ['Tindakan lainnya · Belum ditonton'], title, { seenUploading: 1 })).toEqual({ kind: 'no-baseline', titled: false })
  })

  test('a new titled cell YouTube shows as failed is an upload error, not a post', () => {
    const old = 'Tindakan lainnya · Belum ditonton'
    expect(judgeChannel([old], ['#enkakutest · Upload gagal', old], title)).toEqual({ kind: 'upload-error', words: '#enkakutest · Upload gagal' })
  })
})

describe('detailsGeometry — measured from YouTube\'s content frame (0.31.0)', () => {
  test('on the walked moto it gives exactly the points the walk measured', async () => {
    const g = detailsGeometry(await fixture('screen-details-hidden.json'))
    expect(g.title).toEqual({ x: 445, y: 224 })
    expect(g.upload).toEqual({ x: 534, y: 1480 })
    expect(g.blank).toEqual({ x: 200, y: 112 })
    expect(Math.round(g.uploadBand.top * 1640)).toBe(1455)
  })

  test('on the 1600-tall Samsung, Upload and its band stay inside the button and above the farm keyboard strip (y≈1484)', async () => {
    const g = detailsGeometry(await fixture('screen-details-hidden-1600.json'))
    expect(g.frame).toEqual({ width: 720, height: 1600 })
    expect(g.title).toEqual({ x: 445, y: 218 })
    expect(g.upload).toEqual({ x: 534, y: 1434 })
    // "Upload video Shorts" is drawn at about y 1413..1487 (72395efa frames/00048).
    expect(Math.round(g.uploadBand.top * 1600)).toBe(1409)
    expect(Math.round(g.uploadBand.bottom * 1600)).toBe(1474)
    expect(Math.round(g.content.bottom * 1600)).toBe(1510)
  })
})

describe('the farm keyboard counts as a keyboard (0.31.0)', () => {
  const strip = (): UiNode =>
    node({
      packageName: FARM_KEYBOARD_PACKAGE,
      bounds: { left: 0, top: 1484, right: 720, bottom: 1600 },
      children: [node({ packageName: FARM_KEYBOARD_PACKAGE, clickable: true, text: 'Switch keyboard', bounds: { left: 420, top: 1508, right: 697, bottom: 1577 } })],
    })

  test('its strip in the tree is a keyboard showing', async () => {
    expect(keyboardShowing(await fixture('screen-details-hidden-1600.json'))).toBe(false)
    expect(keyboardShowing(await withNodes('screen-details-hidden-1600.json', [strip()]))).toBe(true)
  })
})

describe('discardButton — only a discard control named exactly (0.31.0)', () => {
  test('"Buang" is a discard control', async () => {
    const tree = await withNodes('screen-details-hidden-1600.json', [node({ clickable: true, text: 'Buang', bounds: { left: 400, top: 900, right: 650, bottom: 980 } })])
    expect(discardButton(tree)?.text).toBe('Buang')
  })

  test('the measured exit sheet (moto g06, 2026-09-14): "Hapus hasil edit" is the discard, never "Simpan sebagai draf" or "Batal"', async () => {
    const tree = await withNodes('screen-details-hidden-1600.json', [
      node({ clickable: true, desc: 'Hapus hasil edit', resourceId: 'com.google.android.youtube:id/close_bottom_sheet_reshoot', bounds: { left: 0, top: 1260, right: 720, bottom: 1358 } }),
      node({ clickable: true, desc: 'Simpan sebagai draf', resourceId: 'com.google.android.youtube:id/close_bottom_sheet_exit', bounds: { left: 0, top: 1358, right: 720, bottom: 1456 } }),
      node({ clickable: true, desc: 'Batal', resourceId: 'com.google.android.youtube:id/close_bottom_sheet_cancel', bounds: { left: 0, top: 1458, right: 720, bottom: 1556 } }),
    ])
    expect(discardButton(tree)?.resourceId).toBe('com.google.android.youtube:id/close_bottom_sheet_reshoot')
  })

  test('"Simpan draf" and anything not named exactly are never tapped', async () => {
    const tree = await withNodes('screen-details-hidden-1600.json', [
      node({ clickable: true, text: 'Simpan draf', bounds: { left: 23, top: 1413, right: 347, bottom: 1487 } }),
      node({ clickable: true, text: 'Buang draf', bounds: { left: 400, top: 900, right: 650, bottom: 980 } }),
    ])
    expect(discardButton(tree)).toBeNull()
  })

  test('the walked screens carry none — not the channel\'s "Draf" cell, not the resume prompt', async () => {
    expect(discardButton(await fixture('screen-channel-draft.json'))).toBeNull()
    expect(discardButton(await fixture('screen-resume-draft.json'))).toBeNull()
    expect(discardButton(await fixture('screen-premium-page.json'))).toBeNull()
  })
})
