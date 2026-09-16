import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import {
  asciiCaption,
  captionDoneButton,
  captionLines,
  coveredByAnotherWindow,
  createFlowShowing,
  createMenuSheet,
  createTapNotTaken,
  newPostCloseButton,
  profileCreateButton,
  reelGalleryReached,
  keyboardDismissPoint,
  keyboardShowing,
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
  captionFocused,
  captionLanded,
  settledCaptionField,
  shareInterstitialButton,
  shareButton,
  shareNuxButton,
  CONFIRM_PLAN,
} from './post-video'
import { MAX_REFRESHES_IN_A_ROW, PROFILE_PULL_BAND, makeRng, planConfirmStep, pullToRefreshPath } from './behavior'
import type { ConfirmMove, ConfirmStep } from './behavior'
import { rowsById, treeFrame } from './tree'
import { humanCheckAccount, isReady, isSignedOut, promoDismissButton, waitForTree, withheldByDialog } from './instagram'
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

describe('post-video — the looks after Share (0.7.0)', () => {
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

  test('a pull round always pulls and lingers nowhere; a trip Home lingers 1.5–5 s', () => {
    for (const s of plan(3)) {
      if (s.move === 'refresh') {
        expect(s.pull).toBe(true)
        expect(s.lingerMs).toBe(0)
      } else {
        expect(s.lingerMs).toBeGreaterThanOrEqual(1_500)
        expect(s.lingerMs).toBeLessThanOrEqual(5_000)
      }
    }
  })

  test('the pull starts below the profile\'s action bar and ends above its bottom nav, off both side edges (screen-profile-empty)', async () => {
    const tree = await fixture('screen-profile-empty.json')
    const frame = treeFrame(tree)
    const actionBar = rowsById(tree, 'profile_action_bar')[0] as UiNode
    const nav = rowsById(tree, 'tab_bar')[0] as UiNode
    expect(actionBar.bounds.bottom).toBe(168)
    expect(nav.bounds.top).toBe(1479)
    const rng = makeRng(5)
    for (let i = 0; i < 300; i++) {
      const p = pullToRefreshPath(frame, rng, PROFILE_PULL_BAND)
      expect(p.from.y).toBeGreaterThan(actionBar.bounds.bottom)
      expect(p.to.y).toBeLessThan(nav.bounds.top)
      expect(p.to.y - p.from.y).toBeGreaterThanOrEqual(128)
      for (const pt of [p.from, p.to]) {
        expect(pt.x).toBeGreaterThan(frame.width * 0.2)
        expect(pt.x).toBeLessThan(frame.width * 0.8)
      }
    }
  })
})

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

  test('"+" can open the "Buat" sheet instead, and its Reel row is the way to the Reel gallery', async () => {
    const sheet = await fixture('screen-create-menu-sheet.json')
    const menu = createMenuSheet(sheet)
    expect(menu).not.toBeNull()
    expect(menu?.reel?.desc).toBe('Buat reel baru')
    expect(menu?.reel?.bounds).toEqual({ left: 0, top: 891, right: 720, bottom: 986 })
    expect(gallerySurface(sheet)).toBeNull()
    expect(createMenuSheet(await fixture('screen-new-post.json'))).toBeNull()
    expect(createMenuSheet(await fixture('screen-home.json'))).toBeNull()
    // Behind this sheet is the PROFILE: the home feed is only kept in the tree off screen, so it has no "+" to tap.
    expect(homeCreateButton(sheet)).toBeNull()
  })

  test('a "+" that was not taken: the home feed with "+" in view is tapped again, anything "+" opens is not (0.9.0)', async () => {
    // Job 8a3321b4 (2026-09-15): `ig-03-gallery` was still the home feed.
    const home = await fixture('screen-home.json')
    expect(createFlowShowing(home)).toBe(false)
    expect(createTapNotTaken(home, homeCreateButton)?.bounds).toEqual({ left: 0, top: 70, right: 84, bottom: 168 })
    for (const name of ['screen-new-post.json', 'screen-reel-gallery.json', 'screen-create-menu-sheet.json', 'screen-resume-draft-dialog.json', 'screen-reel-gallery-resume-draft.json']) {
      const tree = await fixture(name)
      expect(createFlowShowing(tree)).toBe(true)
      expect(createTapNotTaken(tree, homeCreateButton)).toBeNull()
    }
    // Synthetic: the farm keyboard's window over "+" — the tap would land on it, so it is not repeated.
    const keyboard: UiNode = { resourceId: '', text: '', desc: 'Switch keyboard', className: 'android.widget.Button', packageName: 'dev.enkaku.guestagent', bounds: { left: 0, top: 60, right: 200, bottom: 180 }, clickable: true, enabled: true, focused: false, index: 0, children: [] }
    expect(createTapNotTaken({ ...home, children: [...home.children, keyboard] }, homeCreateButton)).toBeNull()
  })

  test('after "Batal" the home feed is back even with the destination bar left squashed off its edge (0.9.2)', async () => {
    // The moto's 0.9.1 dry run (2026-09-15), reproducing production #59: `cam_dest_clips` at right -25 on the home feed.
    const home = await fixture('screen-new-post-left-home.json')
    expect(rowsById(home, 'cam_dest_clips').length).toBeGreaterThan(0)
    expect(gallerySurface(home)).toBeNull()
    expect(reelDestinationTab(home)).toBeNull()
    expect(newPostCloseButton(home)).toBeNull()
    expect(isReady(home)).toBe(true)
    // The gallery it left: "Postingan baru" with "Batal", and no node at all for the REEL tab the screenshot shows.
    const post = await fixture('screen-new-post-no-dest-bar.json')
    expect(gallerySurface(post)).toBe('post')
    expect(reelDestinationTab(post)).toBeNull()
    expect(newPostCloseButton(post)?.bounds).toEqual({ left: 0, top: 70, right: 98, bottom: 168 })
  })

  test('no REEL tab: the new-post gallery closes with its own "Batal", and the profile\'s "Buat Baru" is the other way in (0.9.0)', async () => {
    const post = await fixture('screen-new-post.json')
    expect(newPostCloseButton(post)?.desc).toBe('Batal')
    expect(newPostCloseButton(post)?.bounds).toEqual({ left: 0, top: 70, right: 98, bottom: 168 })
    // Synthetic, from the walk's own dump: job 0d376657's gallery had no `cam_dest_*` node at all.
    const strip = (n: UiNode): UiNode => ({ ...n, children: n.children.filter((c) => !/:id\/cam_dest_/.test(c.resourceId)).map(strip) })
    const noReel = strip(post)
    expect(gallerySurface(noReel)).toBe('post')
    expect(reelDestinationTab(noReel)).toBeNull()
    expect(newPostCloseButton(noReel)?.desc).toBe('Batal')
    expect(reelGalleryReached(noReel)).toBe(false)
    // The close is never offered off the new-post gallery.
    expect(newPostCloseButton(await fixture('screen-reel-gallery.json'))).toBeNull()
    expect(newPostCloseButton(await fixture('screen-home.json'))).toBeNull()

    const profile = await fixture('screen-profile-empty.json')
    expect(profileCreateButton(profile)?.desc).toBe('Buat Baru')
    expect(profileCreateButton(profile)?.bounds).toEqual({ left: 0, top: 70, right: 84, bottom: 168 })
    expect(createTapNotTaken(profile, profileCreateButton)?.desc).toBe('Buat Baru')
    // Behind the "Buat" sheet it opens, the button is not tapped again — the sheet is answered.
    const sheet = await fixture('screen-create-menu-sheet.json')
    expect(rowsById(sheet, 'profile_header_create_button').length).toBeGreaterThan(0)
    expect(profileCreateButton(sheet)).toBeNull()
    expect(createMenuSheet(sheet)?.reel?.desc).toBe('Buat reel baru')
    // The Reels tab keeps the profile off to the side; its "Buat Baru" is not on screen.
    expect(profileCreateButton(await fixture('screen-reels-tab-stale-profile.json'))).toBeNull()
    expect(profileCreateButton(await fixture('screen-home.json'))).toBeNull()

    expect(reelGalleryReached(await fixture('screen-reel-gallery.json'))).toBe(true)
    expect(reelGalleryReached(await fixture('screen-reel-gallery-resume-draft.json'))).toBe(true)
    expect(reelGalleryReached(post)).toBe(false)
    expect(reelGalleryReached(profile)).toBe(false)
  })

  test('the share screen with the keyboard still up: the keyboard is seen, and a mangled caption is not "landed"', async () => {
    const share = await fixture('screen-share-keyboard-open.json')
    expect(keyboardShowing(share)).toBe(true)
    expect(keyboardShowing(await fixture('screen-share.json'))).toBe(false)
    // A person taps the page above the keys: a plain label, not the caption, a row, a toggle or a link.
    const spot = keyboardDismissPoint(share)
    expect(spot?.label).toBe('Tambahkan Label AI')
    expect(spot?.y).toBeLessThan(992)
    expect(keyboardDismissPoint(await fixture('screen-share.json'))).toBeNull()
    const intended =
      'Pernah kena SL dulu, baru habis itu harga jalan sesuai analisa lu? Bisa jadi bukan arah market yang salah lu baca, tapi di mana market ambil liquidity. Perhatiin gap kosong di chart, biasanya zona itu diusik lagi. Coba cek chart lu sekarang \n\n#fyp #trading #belajartrading'
    // The field holds "... sekarang\n\n#fyp #tra rtro" — the first words match, the hashtags do not.
    expect(captionLanded(share, intended)).toBe(false)
    expect(captionLanded(share, 'Pernah kena SL dulu, baru habis itu harga jalan sesuai analisa lu? Bisa jadi bukan arah market yang salah lu baca, tapi di mana market ambil liquidity. Perhatiin gap kosong di chart, biasanya zona itu diusik lagi. Coba cek chart lu sekarang\n\n#fyp #tra rtro')).toBe(true)
  })

  test('a hashtag that lost its "#" is not a landed caption', async () => {
    const sheet = await fixture('screen-share-reels-sheet.json')
    const words = 'Pernah kena SL dulu, baru habis itu harga jalan sesuai analisa lu? Bisa jadi bukan arah market yang salah lu baca, tapi di mana market ambil liquidity. Perhatiin gap kosong di chart, biasanya zona itu diusik lagi. Coba cek chart lu sekarang'
    // The field holds "... #liquidity tradingindonesia".
    expect(captionLanded(sheet, `${words}\n\n#fyp #trading #belajartrading #gapchart #liquidity #tradingindonesia`)).toBe(false)
    expect(captionLanded(sheet, `${words}\n\n#fyp #trading #belajartrading #gapchart #liquidity tradingindonesia`)).toBe(true)
    expect(shareNuxButton(sheet)).not.toBeNull()
  })

  test('after Share: the Reels tab keeps the OLD profile off screen, and its count is not read', async () => {
    const reels = await fixture('screen-reels-tab-stale-profile.json')
    expect(profilePostCount(reels)).toBeNull()
    expect(profilePostCount(await fixture('screen-profile-empty.json'))).toBe(0)
  })

  test('captionLines: one entry per line, blank lines kept, emoji dropped and counted', () => {
    expect(captionLines('Coba cek chart lu sekarang 👀\n\n#fyp  #trading')).toEqual({ lines: ['Coba cek chart lu sekarang', '', '#fyp #trading'], dropped: 1, hashtagsDropped: [] })
    expect(captionLines('plain words')).toEqual({ lines: ['plain words'], dropped: 0, hashtagsDropped: [] })
    expect(captionLines('🔥🔥').lines.join('')).toBe('')
  })

  test('Samsung production share screen: the farm keyboard is a keyboard, and it covers Share (a0873cec, 2026-09-14)', async () => {
    const tree = await fixture('screen-share-farm-keyboard.json')
    expect(keyboardShowing(tree)).toBe(true)
    const share = shareButton(tree)
    expect(share).not.toBeNull()
    expect(coveredByAnotherWindow(tree, share as UiNode)).toBe(true)
    const moto = await fixture('screen-share.json')
    expect(coveredByAnotherWindow(moto, shareButton(moto) as UiNode)).toBe(false)
  })

  test('a hashtag with punctuation around it still counts toward the five', () => {
    expect(captionLines('a #one, #two. (#three) #four! #five #six,').hashtagsDropped).toEqual(['#six,'])
  })

  test('captionLines keeps Instagram\'s five hashtags and leaves the rest out by name (the production run of 2026-09-14)', () => {
    const caption = 'Ngomongin CHoCH, simpen dulu!\n\n#AkademiBitorex #fyp #trading #changeofcharacter #choch #marketstructure #belajartrading #priceaction'
    const { lines, hashtagsDropped } = captionLines(caption)
    expect(lines).toEqual(['Ngomongin CHoCH, simpen dulu!', '', '#AkademiBitorex #fyp #trading #changeofcharacter #choch'])
    expect(hashtagsDropped).toEqual(['#marketstructure', '#belajartrading', '#priceaction'])
    // A `#` inside ordinary words is not a hashtag and is never counted or dropped.
    expect(captionLines('nomor #1 di sini #a #b #c #d #e #f').hashtagsDropped).toEqual(['#f'])
  })

  test('the resume-draft dialog can land late, over the Reel gallery, hiding its cells', async () => {
    const late = await fixture('screen-reel-gallery-resume-draft.json')
    expect(resumeDraftDialog(late)?.startNew?.text).toBe('Mulai video baru')
    expect(galleryVideoCells(late).length).toBe(0)
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
    // Production #3 (0.7.1): the reader left the two ENTERs as `&#10;` — the caption had landed.
    expect(captionLanded(withText('Simak sampai habis!&#10;&#10;#AkademiBitorex #fyp'), 'Simak sampai habis!\n\n#AkademiBitorex #fyp')).toBe(true)
    expect(captionLanded(withText('Tulis keterangan dan tambahkan tagar...'), 'enkaku dry run #test')).toBe(false)
  })

  test('the caption field is tapped only where two readings agree, and typed into only once it has focus (0.7.1)', () => {
    const field = (left: number, focused = false): UiNode => ({ resourceId: 'com.instagram.android:id/caption_input_text_view', text: 'Tulis keterangan dan tambahkan tagar...', desc: '', className: 'android.widget.AutoCompleteTextView', packageName: 'com.instagram.android', bounds: { left, top: 751, right: left + 660, bottom: 841 }, clickable: true, enabled: true, focused, index: 0, children: [] })
    // Production #20: read while the share screen slid in (field at x 372), tapped after it settled (x 30).
    expect(settledCaptionField(field(372), field(30))).toBeNull()
    expect(settledCaptionField(field(30), field(30))?.bounds.left).toBe(30)
    expect(captionFocused(field(30))).toBe(false)
    expect(captionFocused(field(30, true))).toBe(true)
  })

  test('a launch the reader sees only System UI of is a hidden system dialog — refused with BACK (0.7.1)', () => {
    const node = (packageName: string, children: UiNode[] = []): UiNode => ({ resourceId: '', text: '', desc: '', className: 'android.widget.FrameLayout', packageName, bounds: { left: 0, top: 0, right: 720, bottom: 1600 }, clickable: false, enabled: true, focused: false, index: 0, children })
    // Production #3: "Izinkan Instagram mengambil gambar dan merekam video?" over the launcher read as System UI alone.
    expect(withheldByDialog(node('', [node('com.android.systemui'), node('com.android.systemui')]))).toBe(true)
    expect(withheldByDialog(node('', [node('com.android.systemui'), node('com.sec.android.app.launcher')]))).toBe(false)
    expect(withheldByDialog(node('', [node('com.instagram.android')]))).toBe(false)
    // A reading with nothing at all is a failed dump, not a dialog: no BACK for it.
    expect(withheldByDialog(node('', []))).toBe(false)
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

  test('the camera-shortcut announcement over the editor is closed by "Lain kali", with or without its igds ids (0.5.0)', async () => {
    // Synthetic, from the inbox sheet's real dump: the same igds component with the camera-shortcut words.
    const promo = await fixture('screen-inbox-promo-sheet.json')
    const reword = (n: UiNode, stripIds: boolean): UiNode => {
      const id = n.resourceId
      const desc = id.endsWith('igds_headline_primary_action_button') ? 'Buka pengaturan perangkat' : n.desc
      const text = n.text === 'Coba' ? 'Buka pengaturan perangkat' : n.text === 'Memperkenalkan instan' ? 'Abadikan momen dengan pintasan kamera baru' : n.text
      return { ...n, resourceId: stripIds && id.includes('igds') ? '' : id, desc, text, children: n.children.map((c) => reword(c, stripIds)) }
    }
    for (const stripIds of [false, true]) {
      const button = promoDismissButton(reword(promo, stripIds))
      expect(button?.desc).toBe('Lain kali')
      expect(button?.clickable).toBe(true)
    }
    // A screen that merely says "Lain kali" somewhere, with no settings button, is not an announcement.
    expect(promoDismissButton(await fixture('screen-reel-editor.json'))).toBeNull()
  })

  test('every wait closes an announcement sheet before looking for its own anchor (0.5.0)', async () => {
    const promo = await fixture('screen-inbox-promo-sheet.json')
    const editor = await fixture('screen-reel-editor.json')
    const dumps = [promo, editor]
    const taps: unknown[] = []
    const ctx = {
      device: { dump: async () => dumps.shift() ?? editor, tap: async (t: unknown) => void taps.push(t) },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as Parameters<typeof waitForTree>[0]
    const result = await waitForTree(ctx, (t) => editorNextButton(t) !== null, { budgetMs: 5_000, intervalMs: 10 })
    expect(result.ok).toBe(true)
    // The tap is "Lain kali", the sheet's secondary button — the primary "Coba" sits above it.
    expect(taps).toEqual([{ point: { x: 360, y: 1483 } }])
  })

  test('a wait that is itself looking for the sheet is not closed from under it', async () => {
    const promo = await fixture('screen-inbox-promo-sheet.json')
    const taps: unknown[] = []
    const ctx = {
      device: { dump: async () => promo, tap: async (t: unknown) => void taps.push(t) },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as Parameters<typeof waitForTree>[0]
    const result = await waitForTree(ctx, (t) => promoDismissButton(t) !== null, { budgetMs: 1_000, intervalMs: 10 })
    expect(result.ok).toBe(true)
    expect(taps).toEqual([])
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

describe('the "confirm you are human" gate (0.10.4)', () => {
  test('the gate is recognised and names the account it holds', async () => {
    const tree = await fixture('screen-human-check.json')
    expect(isReady(tree)).toBe(false)
    expect(humanCheckAccount(tree)).toBe('owner.account')
  })

  test('a home screen is not the gate', async () => {
    expect(humanCheckAccount(await fixture('screen-home.json'))).toBeNull()
  })

  test('the gate without a handle still reports itself', async () => {
    const tree = await fixture('screen-human-check.json')
    const stripped = JSON.parse(JSON.stringify(tree)) as UiNode
    const line = stripped.children[1] as UiNode
    line.text = 'Konfirmasikan bahwa Anda adalah manusia'
    line.desc = 'Konfirmasikan bahwa Anda adalah manusia'
    expect(humanCheckAccount(stripped)).toBe('this account')
  })
})
