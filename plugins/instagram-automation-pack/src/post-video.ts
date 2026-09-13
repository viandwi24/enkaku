import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { all, rowsById, treeFrame, within } from './tree'
import { INSTAGRAM_PACKAGE, backToNav, capture, centre, isReady, openTab, readableInstagramNodes, relaunch, sleep, waitForTree } from './instagram'

/**
 * `post-video` — upload one video as an Instagram Reel, for the Social Media
 * Manager's router (it sends `{ source: 'direct', videoArtifactId, caption }`
 * to every platform's post member, exactly as it does to `tiktok/post-video`
 * and `youtube/post-video`).
 *
 * ## Where every anchor came from
 *
 * One hand walk on the owner's moto g06 power (Android 15, id-ID, Instagram
 * 446.0.0.49.77, signed in), 2026-09-14, each screen dumped with `uiautomator`
 * and checked into `__fixtures__/` (the account's handle replaced). Nothing
 * here was written from memory.
 *
 * | screen             | anchor                                                      | fixture                            |
 * | ------------------ | ----------------------------------------------------------- | ---------------------------------- |
 * | home               | the clickable inside `action_bar_buttons_container_left`    | screen-home.json                   |
 * | profile            | `profile_header_familiar_post_count_value`                  | screen-profile-empty.json          |
 * | new post gallery   | `new_post_title`, destination tab `cam_dest_clips` ("REEL") | screen-new-post.json               |
 * | reel gallery       | `gallery_title_text` "Reel baru", `gallery_grid_item_thumbnail` + its `gallery_grid_item_label` duration | screen-reel-gallery.json |
 * | reel editor        | `clips_right_action_button` ("Berikutnya")                  | screen-reel-editor.json            |
 * | share              | `share_button` ("Selanjutnya"), `save_draft_button`         | screen-share.json                  |
 * | caption editing    | `action_bar_button_text` ("Oke") — proof the caption has focus | screen-share-caption-editing.json |
 * | first-reel sheet   | `clips_nux_sheet_share_button` ("Bagikan")                  | screen-share-nux.json              |
 * | leaving the editor | `action_sheet_header_text_view` "Simpan draf?", row "Mulai dari awal" | screen-editor-leave-sheet.json |
 *
 * ## The caption is proven by reading it back
 *
 * `uiautomator` on the walk did not show the caption field, but the farm's own
 * reader does: `caption_input_text_view` (fixture
 * `screen-share-download-nux.json`, from the first routed dry run). The member
 * taps it, types at once — a focused field keeps focus only briefly while the
 * farm's session is attached — closes caption editing ("Oke") when it opened,
 * and then requires the field's text to start with the caption. A field still
 * showing its hint stops the run before anything is shared. The walk's
 * measured point is kept only as a fallback for a build that hides the field.
 *
 * ## What `posted` means
 *
 * The profile's post count is read before the walk and again after Share. Only
 * a higher count is `posted`. A count that cannot be read, or has not moved
 * after the confirmation window, is `unverified` — and once Share has been
 * pressed and the share screen has closed, nothing ends the run as `failed`:
 * a failed attempt is re-sent by Retry, and re-sending a Reel that did upload
 * is a duplicate on a real account.
 */

/** The caption field on the share screen, as fractions of the frame (720x1640 walk: centre of the hint at (300, 728)). */
const SHARE_CAPTION = { x: 300 / 720, y: 728 / 1640 }

/** How long the caption tap gets before typing — short, for the reason `youtube/post-video` measured (the focus window). */
const FOCUS_SETTLE_MS = 400

/** Instagram's caption limit. */
const CAPTION_MAX = 2_200

const params = z.object({
  source: z
    .enum(['direct'])
    .default('direct')
    .describe('Where the video comes from. Only "direct" — the one artifact named below — exists for Instagram.')
    .meta(ui({ title: 'Source' })),
  videoArtifactId: z.string().min(1).describe('The uploaded video to post as a Reel.').meta(ui({ title: 'Video', kind: 'artifact' })),
  caption: z.string().min(1).describe('The Reel\'s caption (Instagram keeps the first 2,200 characters).').meta(ui({ title: 'Caption' })),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Walk the whole flow, type the caption, then back out and discard the edit without sharing.')
    .meta(ui({ title: 'Dry run' })),
})

const result = z.object({
  outcome: z.enum(['posted', 'unverified', 'failed']).meta(ui({ title: 'Outcome', summary: true })),
  videoArtifactId: z.string(),
  caption: z.string(),
  remotePath: z.string().nullable().describe('Where the video was left on the device — nothing removes it.'),
  postsBefore: z.number().int().nullable().describe('The profile\'s post count before the walk, when it could be read.'),
  postsAfter: z.number().int().nullable().describe('The profile\'s post count after Share, when it could be read.'),
  screens: z.array(z.string()).describe('The screens the run reached, in order.'),
  reason: z.string().nullable().meta(ui({ title: 'Reason', summary: true })),
})

type Screen = 'home' | 'profile' | 'gallery' | 'reel-gallery' | 'editor' | 'share' | 'caption' | 'shared'

// ---------------------------------------------------------------------------
// Pure readings — each tested against the walk's fixtures.
// ---------------------------------------------------------------------------

const fromInstagram = (n: UiNode): boolean => n.packageName === INSTAGRAM_PACKAGE

/**
 * Instagram is in front but gave the reader nothing it can read or press: the
 * signature of a runtime-permission dialog Android hides from accessibility
 * services (the lesson `youtube-automation-pack` 0.20.0 records).
 */
export function hiddenDialog(tree: UiNode): boolean {
  return readableInstagramNodes(tree).length === 0
}

/** Parse Instagram's abbreviated counts: `0`, `1.234`, `12,5rb`, `1JT`, `1.2K`, `3M`. Null when it is not a count. */
export function parseCount(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '')
  const m = s.match(/^(\d+(?:[.,]\d+)*)(rb|k|jt|m)?$/)
  if (!m) return null
  const [, digits = '', unit] = m
  if (!unit) return Number(digits.replace(/[.,]/g, ''))
  const n = Number(digits.replace(',', '.'))
  if (!Number.isFinite(n)) return null
  return Math.round(n * (unit === 'rb' || unit === 'k' ? 1_000 : 1_000_000))
}

/** The logged-in profile's post count, or null when this is not the profile header. */
export function profilePostCount(tree: UiNode): number | null {
  const node = rowsById(tree, 'profile_header_familiar_post_count_value')[0] ?? rowsById(tree, 'row_profile_header_textview_post_count')[0]
  return node ? parseCount(node.text) : null
}

/** The home feed's "+" (create) button: the clickable inside the left action-bar container. */
export function homeCreateButton(tree: UiNode): UiNode | null {
  const container = rowsById(tree, 'action_bar_buttons_container_left')[0]
  if (!container) return null
  return all(tree, (n) => n.clickable && fromInstagram(n) && within(n, container) && n !== container)[0] ?? null
}

/** Which create gallery is on screen: the Reel gallery, the "new post" gallery, or neither. */
export function gallerySurface(tree: UiNode): 'reel' | 'post' | null {
  const title = rowsById(tree, 'gallery_title_text')[0]
  if (title && /^(reel baru|new reel)$/i.test(title.text.trim())) return 'reel'
  if (rowsById(tree, 'new_post_title').length > 0 || rowsById(tree, 'cam_dest_clips').length > 0) return 'post'
  return null
}

/** The "REEL" destination tab at the bottom of the create gallery. */
export function reelDestinationTab(tree: UiNode): UiNode | null {
  return rowsById(tree, 'cam_dest_clips').find((n) => n.clickable) ?? null
}

/** `0:10` → 10, `1:02:03` → 3723. Null when it is not a duration. */
export function parseDuration(raw: string): number | null {
  const parts = raw.trim().split(':')
  if (parts.length < 2 || parts.some((p) => !/^\d+$/.test(p))) return null
  return parts.reduce((total, p) => total * 60 + Number(p), 0)
}

export interface GalleryCell {
  node: UiNode
  /** What Instagram wrote on it, e.g. "Batal dipilih Gambar Mini Video dibuat pada 14 September 2026 7:08". */
  desc: string
  durationSec: number | null
}

/**
 * The gallery's video cells, newest first (top-left first).
 *
 * Instagram names a cell by its creation time, never by file name — so unlike
 * YouTube's gallery the cell cannot prove which file it is. The member narrows
 * that gap itself: MediaStore must list the pushed file as the newest video,
 * and the first cell's duration label must match that file's duration.
 */
export function galleryVideoCells(tree: UiNode): GalleryCell[] {
  const labels = rowsById(tree, 'gallery_grid_item_label')
  return rowsById(tree, 'gallery_grid_item_thumbnail')
    .filter((n) => /video/i.test(n.desc))
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)
    .map((node) => {
      const label = labels.find((l) => within(l, node))
      return { node, desc: node.desc, durationSec: label ? parseDuration(label.text) : null }
    })
}

/** The Reel editor's "Berikutnya"/"Next". */
export function editorNextButton(tree: UiNode): UiNode | null {
  return rowsById(tree, 'clips_right_action_button').find((n) => n.clickable) ?? null
}

/** The share screen: its Share/Next button, with no sheet over it. */
export function shareButton(tree: UiNode): UiNode | null {
  return rowsById(tree, 'share_button').find((n) => n.clickable) ?? null
}

/**
 * The share screen's caption field. Readable to the farm's reader
 * (`caption_input_text_view`, an AutoCompleteTextView carrying the hint
 * "Tulis keterangan dan tambahkan tagar..."), though `uiautomator` on the walk
 * did not show it — `__fixtures__/screen-share-download-nux.json`.
 */
export function captionField(tree: UiNode): UiNode | null {
  return rowsById(tree, 'caption_input_text_view').find((n) => n.clickable) ?? null
}

/**
 * Did the caption land? The field's own text now starts with what was typed
 * (compared on letters and digits only, since Instagram may re-render hashtags).
 */
export function captionLanded(tree: UiNode, caption: string): boolean {
  const field = rowsById(tree, 'caption_input_text_view')[0]
  if (!field) return false
  const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const want = squash(caption).slice(0, 24)
  return want !== '' && squash(field.text).startsWith(want)
}

/**
 * An information sheet over the share screen, and its acknowledge button.
 * Met on the first routed dry run (2026-09-14): "Orang lain sekarang dapat
 * mengunduh dan membagikan reel Anda" with `clips_download_privacy_nux_button`
 * "Lanjutkan" (and a "Kelola pengaturan" link that is never taken). It covers
 * the caption, so the first caption tap only closed it.
 */
export function shareInterstitialButton(tree: UiNode): UiNode | null {
  return rowsById(tree, 'clips_download_privacy_nux_button').find((n) => n.clickable) ?? null
}

/** Caption-editing mode: the action bar's "Oke"/"OK"/"Done" — readable proof the caption field has focus. */
export function captionDoneButton(tree: UiNode): UiNode | null {
  return rowsById(tree, 'action_bar_button_text').find((n) => /^(oke|ok|done|selesai)$/i.test(n.text.trim() || n.desc.trim())) ?? null
}

/** The first-reel "Tentang Reels" sheet's Share button. */
export function shareNuxButton(tree: UiNode): UiNode | null {
  return rowsById(tree, 'clips_nux_sheet_share_button').find((n) => n.clickable) ?? null
}

/**
 * A "save your draft?" action sheet, and the row that discards the edit.
 * Met leaving the editor on the walk ("Simpan draf?" → "Mulai dari awal").
 */
export function draftSheet(tree: UiNode): { discard: UiNode | null } | null {
  const header = rowsById(tree, 'action_sheet_header_text_view').find((n) => /draf|draft/i.test(n.text))
  if (!header) return null
  const rows = rowsById(tree, 'action_sheet_row_text_view')
  const discard = rows.find((n) => /^(mulai dari awal|start over|buang|discard)$/i.test(n.text.trim())) ?? null
  return { discard }
}

/**
 * "Terus edit draf Anda?" — the dialog Instagram raises on "+" when a Reel edit
 * was left unfinished (met on the first routed dry run, 2026-09-14,
 * `__fixtures__/screen-resume-draft-dialog.json`). Its `auxiliary_button`
 * "Mulai video baru" starts a new video and KEEPS the old edit as a draft, so
 * taking it loses nothing; `primary_button` would resume the old edit, which on
 * a farm phone is some other run's video.
 */
export function resumeDraftDialog(tree: UiNode): { startNew: UiNode | null } | null {
  const headline = rowsById(tree, 'igds_headline_headline').find((n) => /draf|draft/i.test(n.text))
  if (!headline) return null
  const startNew = rowsById(tree, 'auxiliary_button').find((n) => n.clickable && /^(mulai video baru|start new video)$/i.test(n.text.trim())) ?? null
  return { startNew }
}

/** `/sdcard/…` and `/storage/emulated/0/…` are the same file; MediaStore reports the latter. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/^\/(sdcard|storage\/self\/primary)\//, '/storage/emulated/0/')
  return norm(a) === norm(b)
}

/** Printable ASCII with whitespace collapsed — what `input text` can carry. */
export function asciiCaption(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Device steps.
// ---------------------------------------------------------------------------

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

async function tapCentre(ctx: ScriptContext<unknown>, node: UiNode): Promise<void> {
  await ctx.device.tap({ point: centre(node) })
}

/** Open the profile tab and read the post count. Never throws: an unreadable count is not evidence about the post. */
async function readPostCount(ctx: ScriptContext<unknown>, label: string): Promise<number | null> {
  try {
    await backToNav(ctx)
    const profile = await openTab(ctx, 'profile_tab', (t) => profilePostCount(t) !== null, 15_000)
    await capture(ctx, label, profile.tree)
    return profile.ok ? profilePostCount(profile.tree) : null
  } catch (err) {
    ctx.log.warn('could not read the profile post count', { error: String(err) })
    return null
  }
}

/** Check that the pushed file is what the gallery will show first. Returns its duration in seconds when known. */
async function newestVideoSeconds(ctx: ScriptContext<unknown>, remotePath: string): Promise<number | null> {
  try {
    const listed = await ctx.device.media.list({ kind: 'video', limit: 5 })
    const newest = listed.items[0]
    if (!newest) {
      ctx.log.warn('MediaStore lists no video at all after the push — continuing on the gallery alone')
      return null
    }
    if (newest.path !== null && !samePath(newest.path, remotePath)) {
      fail('E_GALLERY_ITEM_NOT_FOUND', `MediaStore's newest video is ${newest.path}, not the pushed ${remotePath}, so the gallery's first cell would be the wrong video. Nothing was posted.`)
    }
    return newest.durationMs === null ? null : Math.round(newest.durationMs / 1000)
  } catch (err) {
    if ((err as { code?: string }).code === 'E_GALLERY_ITEM_NOT_FOUND') throw err
    ctx.log.warn('could not read MediaStore — trusting the gallery to be newest-first', { error: String(err) })
    return null
  }
}

/** Back out of the share screen and the editor, discarding the edit. Best effort; used by a dry run. */
async function discardEdit(ctx: ScriptContext<unknown>): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    const tree = await ctx.device.dump()
    const sheet = draftSheet(tree)
    if (sheet?.discard) {
      await tapCentre(ctx, sheet.discard)
      await sleep(1_500)
      continue
    }
    if (isReady(tree)) return true
    const cancel = rowsById(tree, 'gallery_cancel_button')[0] ?? rowsById(tree, 'cancel_button')[0] ?? rowsById(tree, 'action_bar_button_back')[0] ?? rowsById(tree, 'action_bar_cancel')[0]
    if (cancel) await tapCentre(ctx, cancel)
    else await ctx.device.key('BACK')
    await sleep(1_500)
  }
  return isReady(await ctx.device.dump())
}

const PERMISSION_HELP =
  'the farm grants media access before Instagram opens, so this is most likely the camera or microphone. Android hides these dialogs from the farm\'s reader, so a run cannot answer them: answer it once on the phone and re-run.'

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'post-video',
  icon: 'upload',
  node: { category: 'device', icon: 'upload', summary: ['caption'], keywords: ['instagram', 'reels', 'upload', 'post'] },
  title: 'Post a Reel',
  description: 'Uploads one video as an Instagram Reel with a caption, then confirms it by the profile\'s post count.',
  params,
  result,
  timeout: 12 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const screens: Screen[] = []
    let caption = ctx.params.caption.trim()
    if (caption.length > CAPTION_MAX) {
      ctx.log.warn(`caption is longer than Instagram's ${CAPTION_MAX} characters — the rest was cut`, { length: caption.length })
      caption = caption.slice(0, CAPTION_MAX)
    }

    const home = await capture(ctx, 'ig-01-home')
    const frame = treeFrame(home)
    if (frame.width > frame.height) {
      fail('E_SCREEN_LANDSCAPE', `Instagram opened in landscape (${frame.width}x${frame.height}). Set the device's rotation to lock-portrait and re-run — the caption tap is measured in portrait.`)
    }
    if (!isReady(home)) fail('E_ANCHOR_NOT_FOUND', 'Instagram\'s bottom navigation is not on screen after launch — see artifact ig-01-home.')
    screens.push('home')

    const before = ctx.params.dryRun ? null : await readPostCount(ctx, 'ig-02-profile-before')
    if (!ctx.params.dryRun) screens.push('profile')
    ctx.log.info('read the post count before posting', { posts: before === null ? 'unreadable' : String(before) })

    const remotePath = `/sdcard/DCIM/Camera/ig-${ctx.job.id}-${ctx.job.attempt}.mp4`
    await ctx.device.push({ artifactId: ctx.params.videoArtifactId, remotePath, mediaScan: 'auto' })
    const expectedSec = await newestVideoSeconds(ctx, remotePath)

    // --- home "+" -> gallery ----------------------------------------------------
    await backToNav(ctx)
    const feed = await openTab(ctx, 'feed_tab', (t) => homeCreateButton(t) !== null, 12_000)
    const plus = homeCreateButton(feed.tree)
    if (!plus) {
      await capture(ctx, 'ig-03-feed', feed.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the home feed has no create ("+") button in its top bar — see artifact ig-03-feed.')
    }
    await tapCentre(ctx, plus)

    const galleryReady = (t: UiNode): boolean => gallerySurface(t) !== null || draftSheet(t) !== null || resumeDraftDialog(t) !== null || hiddenDialog(t)
    let opened = await waitForTree(ctx, galleryReady, { budgetMs: 15_000 })
    const resume = resumeDraftDialog(opened.tree)
    if (resume) {
      await capture(ctx, 'ig-03-resume-draft', opened.tree)
      if (!resume.startNew) fail('E_UNFINISHED_DRAFT', 'Instagram asked to continue an unfinished Reel and offered no "Mulai video baru" — see artifact ig-03-resume-draft.')
      ctx.log.warn('Instagram offered to continue an unfinished Reel — starting a new video (the old edit stays in Drafts)')
      await tapCentre(ctx, resume.startNew)
      opened = await waitForTree(ctx, (t) => (gallerySurface(t) !== null && resumeDraftDialog(t) === null) || hiddenDialog(t), { budgetMs: 12_000 })
    }
    const leftover = draftSheet(opened.tree)
    if (leftover) {
      await capture(ctx, 'ig-03-draft-prompt', opened.tree)
      if (!leftover.discard) fail('E_UNFINISHED_DRAFT', 'Instagram asked about an unfinished draft and offered no way to start over — see artifact ig-03-draft-prompt.')
      ctx.log.warn('Instagram had an unfinished edit — starting over, which discards it')
      await tapCentre(ctx, leftover.discard)
      opened = await waitForTree(ctx, (t) => gallerySurface(t) !== null || hiddenDialog(t), { budgetMs: 12_000 })
    }
    if (hiddenDialog(opened.tree)) {
      await ctx.artifact.screenshot('ig-03-hidden-dialog')
      fail('E_PERMISSION_DIALOG_HIDDEN', `Instagram is showing a dialog the farm cannot read after "+" — ${PERMISSION_HELP}`)
    }
    if (!opened.ok) {
      await capture(ctx, 'ig-03-gallery', opened.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the create gallery did not open after "+" — see artifact ig-03-gallery.')
    }
    screens.push('gallery')

    if (gallerySurface(opened.tree) === 'post') {
      const reelTab = reelDestinationTab(opened.tree)
      if (!reelTab) {
        await capture(ctx, 'ig-04-new-post', opened.tree)
        fail('E_ANCHOR_NOT_FOUND', 'the new-post gallery has no REEL destination tab — see artifact ig-04-new-post.')
      }
      await tapCentre(ctx, reelTab)
    }
    const reelGallery = await waitForTree(ctx, (t) => gallerySurface(t) === 'reel' && galleryVideoCells(t).length > 0, { budgetMs: 15_000 })
    const galleryTree = await capture(ctx, 'ig-04-reel-gallery', reelGallery.tree)
    if (!reelGallery.ok) {
      fail('E_ANCHOR_NOT_FOUND', gallerySurface(galleryTree) === 'reel' ? 'the Reel gallery shows no video at all — the pushed video did not appear. See artifact ig-04-reel-gallery.' : 'the Reel gallery did not open — see artifact ig-04-reel-gallery.')
    }
    screens.push('reel-gallery')

    const cell = galleryVideoCells(galleryTree)[0] as GalleryCell
    if (expectedSec !== null && cell.durationSec !== null && Math.abs(cell.durationSec - expectedSec) > 1) {
      fail('E_GALLERY_ITEM_NOT_FOUND', `the newest gallery video is ${cell.durationSec}s long but the pushed video is ${expectedSec}s, so it is not the pushed file. Nothing was posted. See artifact ig-04-reel-gallery.`)
    }
    await tapCentre(ctx, cell.node)

    // --- editor -> share --------------------------------------------------------
    const editor = await waitForTree(ctx, (t) => editorNextButton(t) !== null, { budgetMs: 25_000 })
    if (!editor.ok) {
      await capture(ctx, 'ig-05-editor', editor.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the Reel editor\'s "Berikutnya" did not appear after picking the video — see artifact ig-05-editor.')
    }
    screens.push('editor')
    await tapCentre(ctx, editorNextButton(editor.tree) as UiNode)

    const share = await waitForTree(ctx, (t) => shareButton(t) !== null, { budgetMs: 30_000 })
    await capture(ctx, 'ig-06-share', share.tree)
    if (!share.ok) fail('E_ANCHOR_NOT_FOUND', 'the share screen did not open after the editor — see artifact ig-06-share.')
    screens.push('share')

    // --- information sheets over the share screen ------------------------------
    let shareTree = share.tree
    for (let i = 0; i < 3; i++) {
      const ack = shareInterstitialButton(shareTree)
      if (!ack) break
      ctx.log.info('acknowledged an information sheet on the share screen', { button: ack.desc || ack.text })
      await tapCentre(ctx, ack)
      const cleared = await waitForTree(ctx, (t) => shareButton(t) !== null && shareInterstitialButton(t) === null, { budgetMs: 8_000 })
      shareTree = cleared.tree
    }

    // --- the caption --------------------------------------------------------------
    /*
      Tap the field, type straight away, then read the field back. Typing goes in
      inside the short window a focused field keeps its focus while the farm's
      session is attached (CLAUDE.md, "A text field loses focus about two
      seconds after it is tapped"), and the proof is the field's own text — a
      tap that missed leaves the hint where it was, and the run stops before
      anything is shared.
    */
    const shareFrame = treeFrame(shareTree)
    const ascii = asciiCaption(caption)
    const viaAdb = ascii === caption.replace(/\s+/g, ' ').trim()
    let landed = false
    for (let attempt = 0; attempt < 2 && !landed; attempt++) {
      const now = attempt === 0 ? shareTree : await ctx.device.dump()
      const field = captionField(now)
      if (attempt > 0 && field && field.text.trim() !== '' && !/^tulis keterangan|^write a caption/i.test(field.text.trim())) {
        // Something was typed that is not this caption — never type a second copy on top of it.
        break
      }
      const point = field ? centre(field) : { x: Math.round(shareFrame.width * SHARE_CAPTION.x), y: Math.round(shareFrame.height * SHARE_CAPTION.y) }
      await ctx.device.tap({ point }, { via: 'adb' })
      await sleep(FOCUS_SETTLE_MS)
      const typed = viaAdb ? await ctx.device.type(ascii, { via: 'adb', instant: true }) : await ctx.device.type(caption, { instant: true })
      ctx.log.info('typed the caption', { via: typed.via, length: caption.length, attempt: attempt + 1 })
      await sleep(1_500)
      let after = await ctx.device.dump()
      const done = captionDoneButton(after)
      if (done) {
        // Caption-editing mode: close it, and read the field on the share screen it returns to.
        await tapCentre(ctx, done)
        after = (await waitForTree(ctx, (t) => shareButton(t) !== null && captionDoneButton(t) === null, { budgetMs: 8_000 })).tree
      }
      landed = captionLanded(after, viaAdb ? ascii : caption)
      if (!landed) await capture(ctx, `ig-07-caption-attempt-${attempt + 1}`, after)
    }
    if (!landed) {
      fail('E_CAPTION_NOT_FOCUSED', 'typed the caption but the caption field on the share screen does not hold it, so nothing was shared. See the ig-07-caption-attempt artifacts.')
    }
    screens.push('caption')
    const back = await waitForTree(ctx, (t) => shareButton(t) !== null && captionDoneButton(t) === null, { budgetMs: 8_000 })
    await capture(ctx, 'ig-08-captioned', back.tree)
    if (!back.ok) fail('E_ANCHOR_NOT_FOUND', 'the share screen is not showing after the caption — nothing was shared. See artifact ig-08-captioned.')

    if (ctx.params.dryRun) {
      const discarded = await discardEdit(ctx)
      return {
        outcome: 'unverified' as const,
        videoArtifactId: ctx.params.videoArtifactId,
        caption,
        remotePath,
        postsBefore: null,
        postsAfter: null,
        screens,
        reason: discarded ? 'dry run: walked to Share with the caption typed, then discarded the edit without sharing.' : 'dry run: walked to Share with the caption typed and stopped without sharing; the edit could not be fully discarded.',
      }
    }

    // --- Share ------------------------------------------------------------------
    await tapCentre(ctx, shareButton(back.tree) as UiNode)
    ctx.log.info('tapped Share — confirming by the profile rather than trusting the tap')
    const leftShare = (t: UiNode): boolean => shareButton(t) === null || shareNuxButton(t) !== null
    let after = await waitForTree(ctx, leftShare, { budgetMs: 20_000 })
    const nux = shareNuxButton(after.tree)
    if (nux) {
      await capture(ctx, 'ig-09-reels-sheet', after.tree)
      await tapCentre(ctx, nux)
      after = await waitForTree(ctx, (t) => shareButton(t) === null, { budgetMs: 20_000 })
    }
    if (!after.ok && shareButton(after.tree) !== null && shareNuxButton(after.tree) === null && rowsById(after.tree, 'layout_container_bottom_sheet').length === 0) {
      await capture(ctx, 'ig-09-still-share', after.tree)
      fail('E_SHARE_TAP_NOT_TAKEN', 'Share was tapped but Instagram stayed on the share screen with nothing over it, so nothing was shared. See artifact ig-09-still-share.')
    }
    screens.push('shared')
    await capture(ctx, 'ig-09-after-share', after.tree)

    /*
      Past this line Share HAS been pressed and the share screen is gone (or an
      unknown sheet sits over it), so nothing below may end the run as "failed"
      — see the header. Instagram uploads in the background, so the app is
      never force-stopped here: that would kill the upload it just started.
    */
    let postsAfter: number | null = null
    let confirmError: string | null = null
    try {
      if (!after.ok) {
        ctx.log.warn('something is still over the share screen after Share — see artifact ig-09-after-share')
      }
      for (let round = 0; round < 8; round++) {
        if (round > 0) await sleep(15_000)
        postsAfter = await readPostCount(ctx, `ig-10-profile-after-${round + 1}`)
        if (before !== null && postsAfter !== null && postsAfter > before) {
          return {
            outcome: 'posted' as const,
            videoArtifactId: ctx.params.videoArtifactId,
            caption,
            remotePath,
            postsBefore: before,
            postsAfter,
            screens,
            reason: `the profile's post count went from ${before} to ${postsAfter}`,
          }
        }
        ctx.log.warn(`the profile does not show the new Reel yet (attempt ${round + 1}/8)`, { before: String(before), after: String(postsAfter) })
        // Pull to refresh the profile before the next reading.
        await ctx.device.swipe({ x: Math.round(frame.width / 2), y: Math.round(frame.height * 0.3) }, { x: Math.round(frame.width / 2), y: Math.round(frame.height * 0.75) }, 350)
      }
    } catch (err) {
      confirmError = err instanceof Error ? err.message : String(err)
      ctx.log.warn('confirming on the profile failed after Share was tapped — reporting unverified, never failed', { error: confirmError })
    }
    const saw =
      confirmError !== null
        ? `confirming it failed (${confirmError.slice(0, 160)}).`
        : before === null
          ? 'the post count before the walk could not be read, so there is nothing to compare against.'
          : postsAfter === null
            ? 'the profile\'s post count could not be read.'
            : `the post count stayed at ${postsAfter}.`
    return {
      outcome: 'unverified' as const,
      videoArtifactId: ctx.params.videoArtifactId,
      caption,
      remotePath,
      postsBefore: before,
      postsAfter,
      screens,
      reason: `Share was tapped and Instagram left the share screen, but after ~2 minutes ${saw} Reporting "unverified" rather than assuming it posted.`,
    }
  },

  async finish(ctx) {
    if (!ctx.error) return undefined
    await ctx.artifact.screenshot('ig-failed').catch(() => {})
    if (ctx.error.code !== 'E_PERMISSION_DIALOG_HIDDEN') {
      await ctx.device.app.forceStop(INSTAGRAM_PACKAGE, { clearRecents: true }).catch(() => {})
    }
    return undefined
  },
}

export default script
