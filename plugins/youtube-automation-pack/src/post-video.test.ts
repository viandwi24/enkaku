import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { createButton, endsInTagToken, onThumbnailEditor, resumeDraftPrompt, galleryCellFor, hiddenWindow, isSelectedCell, isSignedOut, judgeChannel, readChannelCells } from './post-video'
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

describe('readChannelCells', () => {
  test('the draft the walk left behind is not a video', async () => {
    expect(readChannelCells(await fixture('screen-channel-draft.json'), W)).toEqual([])
  })
})

describe('judgeChannel — posted means THIS Short appeared', () => {
  const title = 'test upload enkaku 2 #test'

  test('a new cell carrying the title is new', () => {
    expect(judgeChannel([], ['test upload enkaku 2 test · 0 x ditonton'], title)).toEqual({ kind: 'new', via: 'title' })
  })

  test('a new cell still processing is not posted yet', () => {
    expect(judgeChannel([], ['Memproses video'], title).kind).toBe('processing')
  })

  test('one more video than before counts, even without a readable title', () => {
    expect(judgeChannel(['old short'], ['something', 'old short'], title)).toEqual({ kind: 'new', via: 'count' })
  })

  test('the same channel as before is the same, and an unread one is unreadable', () => {
    expect(judgeChannel(['old short'], ['old short'], title)).toEqual({ kind: 'same' })
    expect(judgeChannel(['old short'], null, title)).toEqual({ kind: 'unreadable' })
  })

  test('an old cell that happens to share the title is not this post', () => {
    expect(judgeChannel(['test upload enkaku 2 test'], ['test upload enkaku 2 test'], title)).toEqual({ kind: 'same' })
  })
})

describe('endsInTagToken', () => {
  test('matches a trailing hashtag or mention only', () => {
    expect(endsInTagToken('test upload enkaku 2 #test')).toBe(true)
    expect(endsInTagToken('#test upload')).toBe(false)
  })
})
