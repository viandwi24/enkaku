import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import {
  asciiCaption,
  captionDoneButton,
  draftSheet,
  editorNextButton,
  gallerySurface,
  galleryVideoCells,
  hiddenDialog,
  homeCreateButton,
  parseCount,
  parseDuration,
  profilePostCount,
  reelDestinationTab,
  resumeDraftDialog,
  samePath,
  captionField,
  captionLanded,
  shareInterstitialButton,
  shareButton,
  shareNuxButton,
} from './post-video'
import { isReady, isSignedOut, promoDismissButton } from './instagram'
import { inboxItems, inboxStrings, onInbox } from './check-inbox'
import { feedLikeState, feedPosts, onHomeFeed } from './scroll-feed'
import { inStoryViewer, trayStories } from './watch-stories'
import { inReelsViewer, isSponsored, reelLikeState } from './reels'
import { exploreReelCells } from './explore-reels'
import { activityItems, activitySections, onActivity } from './check-activity'
import { readProfile } from './check-profile'

/**
 * Every pure reading in this pack, against the screens of the 2026-09-14 hand
 * walk on the owner's moto g06 power (720x1640, id-ID, Instagram 446.0). The
 * fixtures are `uiautomator` dumps in the farm's `UiNode` shape, with the
 * status bar dropped and the account's handle replaced by `owner.account`.
 */

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

describe('post-video — the walk, screen by screen', () => {
  test('home: the navigation is up and "+" is the clickable in the left action bar', async () => {
    const home = await fixture('screen-home.json')
    expect(isReady(home)).toBe(true)
    expect(isSignedOut(home)).toBe(false)
    expect(homeCreateButton(home)?.bounds).toEqual({ left: 0, top: 70, right: 84, bottom: 168 })
    expect(onHomeFeed(home)).toBe(true)
  })

  test('profile: the post count is read from its own node', async () => {
    const profile = await fixture('screen-profile-empty.json')
    expect(profilePostCount(profile)).toBe(0)
    expect(readProfile(profile)).toMatchObject({ username: 'owner.account', posts: '0', followers: '0', following: '0' })
    expect(profilePostCount(await fixture('screen-home.json'))).toBeNull()
  })

  test('"+" opens the new-post gallery, whose REEL tab leads to the Reel gallery', async () => {
    const post = await fixture('screen-new-post.json')
    expect(gallerySurface(post)).toBe('post')
    expect(reelDestinationTab(post)?.text).toBe('REEL')
    const reel = await fixture('screen-reel-gallery.json')
    expect(gallerySurface(reel)).toBe('reel')
  })

  test('the Reel gallery lists video cells newest first, each with its duration', async () => {
    const cells = galleryVideoCells(await fixture('screen-reel-gallery.json'))
    expect(cells.length).toBe(8)
    expect(cells[0]?.node.bounds).toEqual({ left: 242, top: 365, right: 478, bottom: 784 })
    expect(cells[0]?.desc).toContain('7:08')
    expect(cells[0]?.durationSec).toBe(10)
  })

  test('editor, share screen, caption editing and the first-reel sheet each carry their own anchor', async () => {
    expect(editorNextButton(await fixture('screen-reel-editor.json'))?.desc).toBe('Berikutnya')
    const share = await fixture('screen-share.json')
    expect(shareButton(share)?.desc).toBe('Selanjutnya')
    expect(captionDoneButton(share)).toBeNull()
    expect(shareNuxButton(share)).toBeNull()
    const editing = await fixture('screen-share-caption-editing.json')
    expect(captionDoneButton(editing)?.text).toBe('Oke')
    expect(shareNuxButton(await fixture('screen-share-nux.json'))?.desc).toBe('Bagikan')
  })

  test('leaving the editor asks "Simpan draf?", and "Mulai dari awal" discards', async () => {
    expect(draftSheet(await fixture('screen-editor-leave-sheet.json'))?.discard?.text).toBe('Mulai dari awal')
    expect(draftSheet(await fixture('screen-share.json'))).toBeNull()
  })

  test('"Terus edit draf Anda?" on "+" is answered with "Mulai video baru", never "Lanjutkan mengedit"', async () => {
    const dialog = await fixture('screen-resume-draft-dialog.json')
    expect(resumeDraftDialog(dialog)?.startNew?.text).toBe('Mulai video baru')
    // The dialog sits over the Reel gallery, and the farm's reader sees ONLY the dialog: no gallery
    // anchor is readable until it is answered, which is why `galleryReady` waits for it by name.
    expect(gallerySurface(dialog)).toBeNull()
    expect(promoDismissButton(dialog)).toBeNull()
    expect(resumeDraftDialog(await fixture('screen-reel-gallery.json'))).toBeNull()
  })

  test('the farm reader\'s share screen: the caption field is readable, and the download sheet is acknowledged first', async () => {
    const tree = await fixture('screen-share-download-nux.json')
    expect(captionField(tree)?.bounds).toEqual({ left: 28, top: 712, right: 692, bottom: 796 })
    expect(shareInterstitialButton(tree)?.desc).toBe('Lanjutkan')
    expect(shareInterstitialButton(await fixture('screen-share.json'))).toBeNull()
    // The hint is not the caption.
    expect(captionLanded(tree, 'enkaku dry run #test')).toBe(false)
  })

  test('captionLanded compares on letters and digits, so a re-rendered hashtag still matches', () => {
    const withText = (text: string): UiNode => ({ resourceId: 'com.instagram.android:id/caption_input_text_view', text, desc: '', className: 'android.widget.AutoCompleteTextView', packageName: 'com.instagram.android', bounds: { left: 28, top: 712, right: 692, bottom: 796 }, clickable: true, enabled: true, focused: false, index: 0, children: [] })
    expect(captionLanded(withText('enkaku dry run #test'), 'enkaku dry run #test')).toBe(true)
    expect(captionLanded(withText('Enkaku  dry run  # test'), 'enkaku dry run #test')).toBe(true)
    expect(captionLanded(withText('Tulis keterangan dan tambahkan tagar...'), 'enkaku dry run #test')).toBe(false)
  })

  test('MediaStore\'s path spelling is the same file as the pushed one', () => {
    expect(samePath('/storage/emulated/0/DCIM/Camera/ig-1.mp4', '/sdcard/DCIM/Camera/ig-1.mp4')).toBe(true)
    expect(samePath('/storage/emulated/0/DCIM/Camera/ig-2.mp4', '/sdcard/DCIM/Camera/ig-1.mp4')).toBe(false)
  })

  test('a window with no Instagram node is the hidden-dialog signature; a real screen is not', async () => {
    const empty: UiNode = { resourceId: '', text: '', desc: '', className: 'hierarchy', packageName: '', bounds: { left: 0, top: 0, right: 0, bottom: 0 }, clickable: false, enabled: true, focused: false, index: 0, children: [] }
    expect(hiddenDialog(empty)).toBe(true)
    expect(hiddenDialog(await fixture('screen-share.json'))).toBe(false)
  })
})

describe('post-video — parsing', () => {
  test('counts in the abbreviations Instagram writes', () => {
    expect(parseCount('0')).toBe(0)
    expect(parseCount('1.234')).toBe(1234)
    expect(parseCount('12,5rb')).toBe(12_500)
    expect(parseCount('1JT')).toBe(1_000_000)
    expect(parseCount('1.2K')).toBe(1_200)
    expect(parseCount('postingan')).toBeNull()
  })

  test('durations', () => {
    expect(parseDuration('0:10')).toBe(10)
    expect(parseDuration('1:02:03')).toBe(3723)
    expect(parseDuration('REEL')).toBeNull()
  })

  test('the ASCII caption adb can type', () => {
    expect(asciiCaption('hello   world #test')).toBe('hello world #test')
    expect(asciiCaption('mantap 🔥 #fyp')).toBe('mantap #fyp')
  })
})

describe('warm-up readings', () => {
  test('feed: each post pairs its author with its own like button', async () => {
    const posts = feedPosts(await fixture('screen-feed-post.json'))
    expect(posts[0]?.author).toBe('queenhnaa__')
    expect(posts[0]?.sponsored).toBe(false)
    expect(posts[0]?.like?.desc).toBe('Suka')
    expect(feedLikeState(posts[0]?.like as UiNode)).toBe('not-liked')
    // The second post's action row is still below the screen.
    expect(posts[1]?.like).toBeNull()
  })

  test('stories: the tray lists other accounts, never the own "Cerita Anda"', async () => {
    const stories = trayStories(await fixture('screen-home-stories.json'))
    expect(stories[0]).toMatchObject({ author: 'mister.aloy', unseen: true })
    expect(stories.some((s) => s.author === 'owner.account')).toBe(false)
    expect(inStoryViewer(await fixture('screen-story-viewer.json'))).toBe(true)
    expect(inStoryViewer(await fixture('screen-home.json'))).toBe(false)
  })

  test('reels viewer: rail anchors and like state', async () => {
    const viewer = await fixture('screen-reels-viewer.json')
    expect(inReelsViewer(viewer)).toBe(true)
    expect(reelLikeState(viewer)).toBe('not-liked')
    expect(isSponsored(viewer)).toBe(false)
    expect(inReelsViewer(await fixture('screen-home.json'))).toBe(false)
  })

  test('explore: reel cells only, top-left first', async () => {
    const cells = exploreReelCells(await fixture('screen-explore.json'))
    expect(cells.length).toBeGreaterThan(5)
    expect(cells[0]?.desc).toStartWith('Reel dari Lusiana')
    expect(cells.every((c) => !c.desc.startsWith('Foto oleh'))).toBe(true)
  })

  test('an announcement sheet is closed by "not now", never by its primary button, and only IG nodes are read', async () => {
    const promo = await fixture('screen-inbox-promo-sheet.json')
    const button = promoDismissButton(promo)
    expect(button?.desc).toBe('Lain kali')
    expect(button?.resourceId).toEndWith('igds_headline_secondary_action_text_button')
    expect(promoDismissButton(await fixture('screen-home.json'))).toBeNull()
    // The system navigation bar's buttons are in the same dump and are not inbox items.
    expect(inboxStrings(promo, 96)).not.toContain('Ringkasan')
    expect(inboxStrings(promo, 96)).not.toContain('Kembali')
  })

  test('inbox: recognised by its own anchor; off-screen feed nodes and suggested accounts are not threads', async () => {
    const inbox = await fixture('screen-inbox-empty.json')
    expect(onInbox(inbox)).toBe(true)
    expect(onInbox(await fixture('screen-home.json'))).toBe(false)
    const { sections, items } = inboxItems(inbox)
    expect(sections).toEqual(expect.arrayContaining(['Pesan', 'Permintaan']))
    // The feed's off-screen "ssanggarra" button and the "Akun untuk diikuti" cells are all excluded.
    expect(items).not.toContain('ssanggarra')
    expect(items).not.toContain('riaricis1795')
    expect(items).toEqual([])
  })

  test('activity: suggestions are a section, not notifications', async () => {
    const tree = await fixture('screen-activity-suggestions.json')
    expect(onActivity(tree)).toBe(true)
    expect(activitySections(tree).map((n) => n.text)).toContain('Disarankan untuk Anda')
    expect(activityItems(tree)).toEqual([])
  })
})
