import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import {
  asciiTitle,
  cellShowsTitle,
  cellTitleKey,
  createButton,
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
  readChannelCells,
  resumeDraftPrompt,
} from './post-video'
import { rowsById } from './tree'

/**
 * `post-video`'s readings, against the screens of the 2026-09-11 hand walk on
 * the owner's moto g06 (720x1640, id-ID). The fixtures are those dumps with
 * the status bar dropped and the channel's name and handle replaced.
 */

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

const W = 720

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
