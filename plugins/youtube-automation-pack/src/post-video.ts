import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { removeStalePushedVideos } from './pushed-videos'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { compareShots, pngSize } from './screen-pixels'
import type { Region } from './screen-pixels'
import { all, flatten, rowsById } from './tree'
import { YOUTUBE_PACKAGE, capture, centre, hasId, labelled, relaunch, sleep, waitForTree } from './youtube'
import { between, makeRng, planConfirmStep, pullToRefresh } from './behavior'
import type { ConfirmMove, ConfirmPlan } from './behavior'

/**
 * `post-video` — upload one video as a YouTube Short, for the Social Media
 * Manager's router (it sends `{ source: 'direct', videoArtifactId, caption }`
 * to every platform's post member, exactly as it does to `tiktok/post-video`).
 *
 * ## Where every anchor came from
 *
 * One hand walk on the owner's moto g06 power (Android 15, id-ID, YouTube
 * signed in to a channel created that morning), 2026-09-11, each screen dumped
 * and checked into `__fixtures__/`. Nothing here was written from memory.
 *
 * | screen            | anchor                                          | fixture                          |
 * | ----------------- | ----------------------------------------------- | -------------------------------- |
 * | home              | bottom-bar `Buat` (desc)                         | screen-home.json                 |
 * | signed out        | "Login untuk mengakses…" + `Login` on Anda      | screen-signed-out.json           |
 * | create, no camera | `unified_permissions_primary_button`             | screen-create-no-camera.json     |
 * | unfinished edit   | `alertTitle` "…draf…", "Mulai dari awal"         | screen-resume-draft.json         |
 * | gallery           | `thumb_image_view` desc = the FILE NAME          | screen-gallery.json              |
 * | gallery, picked   | `selected_state` inside the cell, `multi_select_next_button` | screen-gallery-selected.json |
 * | trim (optional)   | `shorts_trim_finish_trim_button` or `creation_next_button` ("Selesai") | screen-trim-finish.json, screen-trim.json |
 * | Shorts editor     | `shorts_post_bottom_button` ("Berikutnya")       | screen-shorts-editor.json        |
 * | details           | NONE — see below                                 | screen-details-hidden.json, screen-details-hidden-1600.json |
 * | You tab           | `Lihat channel`, or the clickable row holding it | screen-you.json, screen-you-label-row.json |
 * | Premium page      | "Dapatkan YouTube Premium" (toolbar title)       | screen-premium-page.json         |
 * | channel           | `Edit channel` (desc), cells below it            | screen-channel-draft.json        |
 * | channel, uploading | the new cell "… Mengirim file • 1%"             | screen-channel-uploading.json    |
 *
 * The rows added in 0.31.0 come from the production SM-A075F exports of
 * 2026-09-14 (runs f32d8f38, ea9736fe, 72395efa) — ui trees only, status bar
 * dropped, channel names replaced.
 *
 * The gallery naming its cells by file name is the best anchor this farm has
 * on any platform: the video is pushed under a name unique to this job, so the
 * cell tapped is provably the video meant — where TikTok's picker can only be
 * trusted to be sorted newest-first.
 *
 * ## Two screens the farm's reader cannot see
 *
 * Android 14+ lets an app mark a window "accessibility data sensitive", which
 * hides it from every accessibility service that is not a declared assistive
 * tool. Measured on the walk: both runtime-permission dialogs YouTube raises
 * (camera, then photos) and YouTube's own "Tambahkan detail" screen come back
 * from the guest agent's tree as NOTHING — the permission dialogs as no
 * YouTube node at all, the details screen as YouTube's `content` frame with no
 * children. `uiautomator` (a test instrumentation, which Android exempts) sees
 * both, which is how the details layout below was measured.
 *
 * The guest agent is NOT made to claim it is an assistive tool to get past
 * that. The flag exists so that a background service cannot quietly grant
 * itself permissions or act inside an app's sensitive screens; lying about
 * what the service is to defeat it is not a trade this pack makes. So:
 *
 * - **Permission dialogs** are answered ONCE per phone, by the operator: the
 *   camera "Jangan izinkan" (twice makes it permanent — uploads never need
 *   it), photos "Izinkan semua". A run that meets one stops with
 *   `E_PERMISSION_DIALOG_HIDDEN` and says which answer to give.
 * - **The phone keeps its OWN keyboard.** With the farm's guest-agent IME set
 *   as the device default (`prep.textInput: 'auto'`, the farm's default), a
 *   tap on the title field never focuses it at all — measured on the owner's
 *   moto, 2026-09-13, and fixed by nothing but switching the phone back to its
 *   own keyboard. Set the phone's **Text input** to `device` before routing
 *   YouTube posts to it. `E_DETAILS_LAYOUT` says so when focus never arrives.
 * - **The details screen** is driven blind, the way `tiktok-automation-pack`
 *   already drives its two unreadable video screens: taps aimed from a layout
 *   measured on hardware, its state read from SCREENSHOTS (`screen-pixels.ts`),
 *   then the outcome proven on a screen that CAN be read — the channel's own
 *   video list.
 *
 * ## What each outcome means (0.31.0)
 *
 * - **a thrown error** — only while nothing can have been uploaded: before the
 *   Upload tap, or after it when the details screen is provably pixel-for-pixel
 *   unchanged. A failed attempt is re-sent by the session's Retry, so a throw
 *   after an Upload that took would duplicate the Short on a real channel.
 * - **`posted`** — the channel page, read before the walk and again after
 *   Upload, has one more cell carrying THIS title (the whole title, or a prefix
 *   the channel visibly cut with an ellipsis) that is no longer processing. With
 *   no reading from before, only a titled cell this run itself SAW uploading
 *   after Upload, and then saw finished, counts.
 * - **`unverified`** — Upload was pressed and anything short of that: a new
 *   cell still uploading or processing ("uploaded, still processing on
 *   YouTube"), a new cell whose title does not match (a title that lost keys
 *   uploads under YouTube's default), an upload YouTube shows as failed, a
 *   channel that could not be read before or after, or a screen that changed
 *   without visibly leaving details. Never `failed`.
 */

/**
 * Where the details screen's taps go and which pixels are compared, measured
 * from YouTube's own `content` frame (0.31.0).
 *
 * Two phones, both 720 wide:
 *
 * - the owner's moto g06 (720x1640, `uiautomator` on the walk): `content`
 *   `[0,70][720,1556]` (`screen-details-hidden.json`); the title field
 *   `[192,190][699,258]`; `upload_bottom_button` `[370,1465][699,1535]`.
 * - the production SM-A075F (720x1600, run 72395efa): `content`
 *   `[0,64][720,1510]` (`ui/00058`, `screen-details-hidden-1600.json`);
 *   "Upload video Shorts" drawn at about `[371,1413][697,1487]`
 *   (`frames/00048`), the title hint at y≈217.
 *
 * Both put the title field 154px below the content top and the button 21-23px
 * above the content bottom. Until 0.30.1 every point was a fraction of the
 * whole 1640 frame; scaled to 1600 the Upload band reached down to y=1507,
 * into the farm keyboard's strip ("Enkaku input — driven by the farm",
 * y≈1484-1600 in `frames/00057`), which YouTube does not resize for. The band
 * read "different" with the title typed and the button in plain view, and the
 * run pressed BACK — which on this screen can leave it and keep a draft.
 *
 * So each is an offset from the content frame, in px at 720 wide:
 *
 * - title: (445, content top + 154).
 * - Upload: (534, content bottom − 76) — inside the button on both phones
 *   (moto 1480, the value walked; Samsung 1434), and above the farm strip.
 * - the Upload band: content bottom − 101 to content bottom − 36 — the
 *   button's upper part, where its label is, ending above the farm strip on
 *   the Samsung (1474 < 1484). A phone keyboard (about the bottom 40% of the
 *   screen) still covers all of it.
 * - blank page, to put a keyboard away when the reader offers none: (200,
 *   content top + 42). NOT "just below the title block" — the rows there open
 *   something when tapped. It is inside the header's own title text: the back
 *   arrow ends at x=98, the text runs from x=105 on the 88..135 line (moto),
 *   action icons start at x=468 at the earliest (`screen-channel-draft.json`,
 *   `screen-you.json`).
 * - content: the whole content frame, the status bar left out so a clock that
 *   ticks over does not read as "the tap did something".
 *
 * A tree with no `content` node falls back to the moto's fractions.
 */
export interface DetailsGeometry {
  frame: { width: number; height: number }
  title: { x: number; y: number }
  upload: { x: number; y: number }
  blank: { x: number; y: number }
  uploadBand: Region
  content: Region
}

export function detailsGeometry(tree: UiNode): DetailsGeometry {
  const frame = frameOf(tree)
  const px = (v: number): number => Math.round((v * frame.width) / 720)
  const box = all(tree, (n) => fromYouTube(n) && hasId(n, 'content') && n.bounds.bottom > n.bounds.top)[0]
  const top = box ? box.bounds.top : Math.round((70 / 1640) * frame.height)
  const bottom = box ? box.bounds.bottom : Math.round((1556 / 1640) * frame.height)
  return {
    frame,
    title: { x: px(445), y: top + px(154) },
    upload: { x: px(534), y: bottom - px(76) },
    blank: { x: px(200), y: top + px(42) },
    uploadBand: { top: (bottom - px(101)) / frame.height, bottom: (bottom - px(36)) / frame.height, left: 0, right: 1 },
    content: { top: top / frame.height, bottom: bottom / frame.height, left: 0, right: 1 },
  }
}

/** How many times the channel is read after Upload, ten seconds apart. */
const CONFIRM_ROUNDS = 6
/** How long a run that saw its upload in flight keeps looking at the channel, counted from the first look (0.33.0). */
const CONFIRM_BUDGET_MS = 5 * 60_000
/** How long every run keeps looking at the channel after Upload, even one that never saw its upload in flight (0.34.0). */
const CONFIRM_MIN_MS = 3 * 60_000
/**
 * How the looks after the first one vary (0.35.0): jittered 8–16 s gaps, a trip to Home about a third of the time,
 * and a pull to refresh on every look — also after a trip Home, because re-opening the channel through Anda does
 * not refresh its list (the owner's production phones, 2026-09-15).
 */
export const CONFIRM_PLAN: ConfirmPlan = { waitMs: [8_000, 16_000], homeChance: 0.35, pullAfterHome: 1 }
/** How long YouTube's "Memproses" overlay after the trim screen's "Selesai" is waited out for the editor (0.35.0). */
const TRIM_PROCESSING_MS = 3 * 60_000
/**
 * How long the details screen gets to open and to finish loading (0.38.2). It was 30 s to open and 45 s to load; the owner
 * (2026-09-15) asked for up to 2 min 30 s, because a slow phone still processing a Short is not a failed post.
 */
const DETAILS_LOAD_MS = 150_000

/**
 * How long the title tap gets before the text is typed.
 *
 * Short on purpose: the field keeps focus for only about two seconds while the
 * farm's scrcpy session is attached (measured 2026-09-14 — with the session
 * killed it holds forever), so the text has to go in inside that window. Long
 * enough for the tap to register, far short of the two seconds.
 */
const FOCUS_SETTLE_MS = 400

/** How long the keyboard gets to go on its own (measured ~2s with a session attached; this is that with room). */
const KEYBOARD_GONE_MS = 3_500

/**
 * ADB_ONLY — the details screen takes input only through Android's own injection.
 *
 * Measured on the owner's moto, 2026-09-11, five routed runs and a bench
 * session: a farm tap (scrcpy UHID) on the title field never focused it, and
 * even once focused the guest agent's keyboard committed nothing — the typed
 * keys then reached the focused thumbnail and a space opened the thumbnail
 * editor. `input tap` focused the field at once and `input text` typed into
 * it. So the details-screen taps (title, keyboard dismissal, Upload) and the
 * title text go `via: 'adb'`, and nowhere else in this member does.
 */

/** The title as `input text` can carry it: printable ASCII, whitespace collapsed. */
export function asciiTitle(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim()
}

/** YouTube's title limit. A longer caption is fitted by `youtubeTitle`, and the cut is logged. */
const TITLE_MAX = 100
/** The least caption text a fitted title keeps before a hashtag is given room (0.34.0). */
const TITLE_MIN_TEXT = 40

/**
 * A caption fitted to YouTube's 100-character title (0.34.0): the caption's words cut at a word boundary, then as
 * many of its hashtags as fit, in their own order. The owner's production farm (2026-09-15): captions of 200+
 * characters were cut at character 100, so every hashtag — which the post composes at the END — was lost, and
 * the cut could fall mid-word. At least `TITLE_MIN_TEXT` characters of text are kept before a hashtag is added.
 */
export function youtubeTitle(caption: string, max = TITLE_MAX): { title: string; droppedTags: string[]; cut: boolean } {
  const words = caption.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const isTag = (w: string): boolean => /^#[A-Za-z0-9_]+$/.test(w)
  const tags: string[] = []
  for (const w of words) if (isTag(w) && !tags.includes(w)) tags.push(w)
  const text = words.filter((w) => !isTag(w)).join(' ')

  const kept: string[] = []
  for (const tag of tags) {
    const tagsLength = [...kept, tag].join(' ').length
    const room = max - tagsLength - (text === '' ? 0 : 1)
    if (room < Math.min(TITLE_MIN_TEXT, text.length)) break
    kept.push(tag)
  }
  const tagText = kept.join(' ')
  const budget = max - (tagText === '' ? 0 : tagText.length + (text === '' ? 0 : 1))
  let body = text
  let cut = false
  if (body.length > budget) {
    cut = true
    const slice = body.slice(0, budget + 1)
    const space = slice.lastIndexOf(' ')
    body = (space > 0 ? slice.slice(0, space) : body.slice(0, budget)).replace(/[\s,.;:!?-]+$/, '')
  }
  return { title: [body, tagText].filter((s) => s !== '').join(' '), droppedTags: tags.filter((t) => !kept.includes(t)), cut }
}

const params = z.object({
  source: z
    .enum(['direct'])
    .default('direct')
    .describe('Where the video comes from. Only "direct" — the one artifact named below — exists for YouTube.')
    .meta(ui({ title: 'Source' })),
  videoArtifactId: z.string().min(1).describe('The uploaded video to post as a Short.').meta(ui({ title: 'Video', kind: 'artifact' })),
  caption: z.string().min(1).describe('Used as the Short\'s title (YouTube keeps the first 100 characters).').meta(ui({ title: 'Title' })),
  unfinishedDraft: z
    .enum(['start-over', 'stop'])
    .default('start-over')
    .describe('When YouTube asks "Continue your draft video?" on Create: start over (YouTube deletes that unfinished edit) or stop the run and leave it. On a farm phone the unfinished edit is almost always one an aborted run left behind, and continuing it would post the wrong video.')
    .meta(ui({ title: 'Unfinished draft', labels: { 'start-over': 'Start over (delete it)', stop: 'Stop and leave it' } })),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Walk the whole flow and stop at the Upload button without pressing it. YouTube keeps what was entered as a draft.')
    .meta(ui({ title: 'Dry run' })),
})

const result = z.object({
  outcome: z.enum(['posted', 'unverified', 'failed']).meta(ui({ title: 'Outcome', summary: true })),
  videoArtifactId: z.string(),
  title: z.string(),
  remotePath: z.string().nullable().describe('Where the video was left on the device — nothing removes it.'),
  screens: z.array(z.string()).describe('The screens the run reached, in order.'),
  reason: z.string().nullable().meta(ui({ title: 'Reason', summary: true })),
})

type Screen = 'home' | 'create' | 'gallery' | 'trim' | 'editor' | 'details' | 'uploaded'

// ---------------------------------------------------------------------------
// Pure readings — each tested against the walk's fixtures.
// ---------------------------------------------------------------------------

const fromYouTube = (n: UiNode): boolean => n.packageName === YOUTUBE_PACKAGE

/**
 * The frame the tree describes. The windows (the root's children) say it; a
 * root arrives as 0,0,0,0. Only when no window has a size is it the widest and
 * tallest bounds in the tree — which a page kept off to the side would inflate.
 */
function frameOf(tree: UiNode): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const w of tree.children) {
    width = Math.max(width, w.bounds.right)
    height = Math.max(height, w.bounds.bottom)
  }
  if (width === 0 || height === 0) {
    for (const n of flatten(tree)) {
      width = Math.max(width, n.bounds.right)
      height = Math.max(height, n.bounds.bottom)
    }
  }
  return { width: width || 720, height: height || 1640 }
}

/**
 * A node YouTube actually drew on screen — not a page kept in the tree off to
 * the side, whose bounds go negative or past the frame. The same filter
 * `instagram-automation-pack` needed after a hidden feed's "+" was tapped at
 * x=-1398 (2026-09-14).
 */
function onScreenIn(tree: UiNode): (n: UiNode) => boolean {
  const frame = frameOf(tree)
  return (n) => n.bounds.left >= 0 && n.bounds.top >= 0 && n.bounds.right <= frame.width && n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top
}

/** `labelled`, on screen only. Every label this member acts on goes through this. */
export function shown(tree: UiNode, value: string): UiNode[] {
  return labelled(tree, value).filter(onScreenIn(tree))
}

/** YouTube nodes that carry anything a person could read or press. */
function readableYouTubeNodes(tree: UiNode): UiNode[] {
  return all(tree, (n) => fromYouTube(n) && (n.text.trim() !== '' || n.desc.trim() !== '' || n.clickable))
}

/**
 * YouTube is in front but its window gave the reader nothing: the signature
 * of a window Android hides from accessibility services (see the header).
 * With no YouTube node at all it is a permission dialog over the app; with
 * YouTube's frame present and empty it is the details screen.
 *
 * Neither is proof on ONE reading. A transition frame between two screens
 * also has no YouTube node (`hiddenDialogWatch`), and a screen still loading
 * after Upload also has an empty YouTube frame — so after Upload, "still
 * 'details'" says nothing on its own; the screenshot does (`watchUploadTap`).
 */
export function hiddenWindow(tree: UiNode): 'none' | 'dialog' | 'details' {
  if (readableYouTubeNodes(tree).length > 0) return 'none'
  const anyYouTube = all(tree, fromYouTube).length > 0
  return anyYouTube ? 'details' : 'dialog'
}

/**
 * YouTube's details screen drawn READABLE (0.37.0). The walk on the moto met it hidden from the reader, and every check
 * here assumed that. Production SM-A075F phones (2026-09-15, 13 of 16 "the details screen did not open") showed it in
 * plain view: the header "Tambahkan detail", the title area "Tambahkan teks pada video Shorts" beside the thumbnail, and
 * `upload_bottom_button` "Upload video Shorts" (one build puts `upload_menu_button` in the toolbar instead). The run
 * waited 30 s for a hidden screen that was never going to come.
 */
export function readableDetails(tree: UiNode): { upload: UiNode | null; title: UiNode | null } | null {
  const visible = onScreenIn(tree)
  const nodes = all(tree, (n) => fromYouTube(n) && visible(n))
  const upload = nodes.find((n) => hasId(n, 'upload_bottom_button') || hasId(n, 'upload_menu_button')) ?? null
  const header = nodes.some((n) => /^(tambahkan detail|add details)$/i.test(n.text.trim()) || /^(tambahkan detail|add details)$/i.test(n.desc.trim()))
  if (!upload && !header) return null
  const title = nodes.find((n) => n.clickable && /tambahkan teks pada video shorts|caption your short|tambahkan judul|add a title|create a title/i.test(`${n.text} ${n.desc}`)) ?? null
  return { upload, title }
}

/**
 * The title field's text on a READABLE details screen (0.38.3): `''` when it shows only its placeholder ("Caption your
 * Short" / "Tambahkan teks pada video Shorts"), `null` when no field can be read (a hidden details screen). The field is
 * the on-screen YouTube EditText.
 */
export function titleFieldText(tree: UiNode): string | null {
  const visible = onScreenIn(tree)
  const field = all(tree, (n) => fromYouTube(n) && visible(n) && /EditText$/.test(n.className))[0]
  if (!field) return null
  const text = field.text.replace(/\s+/g, ' ').trim()
  return /^(caption your short|tambahkan teks pada video shorts|create a title|add a title|tambahkan judul)$/i.test(text) ? '' : text
}

/** The same title, whitespace aside. */
export function sameTitle(held: string, title: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
  return norm(held) === norm(title)
}

/** YouTube's red refusal under the title, "Tulis teks yang lebih singkat" (0.38.3, measured); the English wording is unverified. */
export function titleRefused(tree: UiNode): boolean {
  const visible = onScreenIn(tree)
  return all(tree, (n) => fromYouTube(n) && visible(n) && /tulis teks yang lebih singkat|write shorter text|title is too long/i.test(`${n.text} ${n.desc}`)).length > 0
}

/** The details screen, hidden from the reader (the moto) or readable (production Samsung) — see `readableDetails`. */
export function onDetailsScreen(tree: UiNode): boolean {
  return hiddenWindow(tree) === 'details' || readableDetails(tree) !== null
}

const middleOf = (n: UiNode): { x: number; y: number } => ({ x: Math.round((n.bounds.left + n.bounds.right) / 2), y: Math.round((n.bounds.top + n.bounds.bottom) / 2) })

/**
 * A hidden permission dialog, believed only after `readings` consecutive trees
 * show it (0.30.0). One empty tree is also what a transition frame looks like:
 * a run that took one for a dialog threw `E_PERMISSION_DIALOG_HIDDEN` with the
 * wrong advice, and `finish` then left the app open for an operator to answer
 * a dialog that did not exist. `observe` must see every polled tree, once.
 */
export function hiddenDialogWatch(readings = 2): { observe: (tree: UiNode) => boolean; readonly confirmed: boolean } {
  let streak = 0
  return {
    observe(tree) {
      streak = hiddenWindow(tree) === 'dialog' ? streak + 1 : 0
      return streak >= readings
    },
    get confirmed() {
      return streak >= readings
    },
  }
}

/** The signed-out "You" page: a login pitch and a Login button, no channel. */
export function isSignedOut(tree: UiNode): boolean {
  const visible = onScreenIn(tree)
  const strings = all(tree, (n) => fromYouTube(n) && visible(n)).map((n) => `${n.text} ${n.desc}`.toLowerCase())
  const pitch = strings.some((s) => s.includes('login untuk') || s.includes('sign in to'))
  const button = shown(tree, 'Login').length > 0 || shown(tree, 'Sign in').length > 0
  return pitch && button
}

/** The bottom-bar Create button — `Buat` in id-ID, `Create` in English. */
export function createButton(tree: UiNode): UiNode | null {
  const visible = onScreenIn(tree)
  return all(tree, (n) => fromYouTube(n) && n.clickable && visible(n) && (n.desc === 'Buat' || n.desc === 'Create'))[0] ?? null
}

/**
 * YouTube's "Lanjutkan video draf Anda?" prompt on Create, and its start-over
 * button. Met on the second routed run (2026-09-11): the run before it had
 * failed inside the editor, and YouTube kept that unfinished edit. The button
 * is found by its label first and by the dialog's negative-button id second.
 */
export function resumeDraftPrompt(tree: UiNode): { startOver: UiNode | null } | null {
  const title = rowsById(tree, 'alertTitle').find((n) => /draf|draft/i.test(n.text))
  if (!title) return null
  const byLabel = all(tree, (n) => fromYouTube(n) && n.clickable && (n.text === 'Mulai dari awal' || n.text === 'Start over'))[0]
  return { startOver: byLabel ?? rowsById(tree, 'button2')[0] ?? null }
}

/** The gallery cell for exactly this file, found by the name YouTube writes on its thumbnail, on screen. */
export function galleryCellFor(tree: UiNode, fileName: string): UiNode | null {
  const visible = onScreenIn(tree)
  return rowsById(tree, 'thumb_image_view').find((n) => n.desc === fileName && visible(n)) ?? null
}

/** True when the gallery shows a selection badge inside `cell`'s bounds. */
export function isSelectedCell(tree: UiNode, cell: UiNode): boolean {
  const b = cell.bounds
  return rowsById(tree, 'selected_state').some((s) => s.bounds.left >= b.left && s.bounds.right <= b.right && s.bounds.top >= b.top && s.bounds.bottom <= b.bottom)
}

/**
 * The trim screen's "Selesai" (0.31.0).
 *
 * YouTube changed its id between two runs of the same fleet 12 hours apart: `creation_next_button` on
 * 2026-09-13 (72395efa `ui/00041`, and the moto walk's `screen-trim.json`), `shorts_trim_finish_trim_button`
 * on 2026-09-14 (f32d8f38 `ui/00046`, `screen-trim-finish.json`) — where 0.30.0 waited 20 s for the old id
 * with the button on screen, four runs out of four. So: either id first, then a clickable node labelled
 * "Selesai"/"Done" or described "Tambahkan segmen ke project". The same node serves the wait and the tap.
 */
const TRIM_DONE_IDS = ['shorts_trim_finish_trim_button', 'creation_next_button'] as const
/** How many times the Shorts editor's "Berikutnya" is pressed again when YouTube does not act on it (0.39.4). */
const EDITOR_RETAPS = 4

/**
 * Android's own input-method chooser, standing over whatever was on screen (0.39.5).
 *
 * Measured on production #9 (2026-09-16): a dump with not one YouTube node in it, carrying "Enkaku
 * input — driven by the farm host" and "Switch keyboard". That dialog withholds every app window from
 * the reader, so anything that reads the screen under it sees nothing and concludes the app is gone.
 * Matched by its own wording rather than a package, because the chooser is drawn by the system UI on
 * some builds and by the settings app on others.
 */
export function imePickerShowing(tree: UiNode): boolean {
  return flatten(tree).some((n) => /switch keyboard|ubah keyboard|ganti keyboard|pilih metode (masukan|input)|choose input method/i.test(`${n.text} ${n.desc}`))
}

const TRIM_DONE_TEXTS: readonly string[] = ['Selesai', 'Done']
const TRIM_DONE_DESCS: readonly string[] = ['Tambahkan segmen ke project', 'Add segment to project']

export function trimDoneButton(tree: UiNode): UiNode | null {
  const visible = onScreenIn(tree)
  const buttons = all(tree, (n) => fromYouTube(n) && n.clickable && visible(n))
  return (
    buttons.find((n) => TRIM_DONE_IDS.some((id) => hasId(n, id))) ??
    buttons.find((n) => TRIM_DONE_TEXTS.includes(n.text.trim()) || TRIM_DONE_DESCS.includes(n.desc.trim())) ??
    null
  )
}

/** Labels YouTube puts on a cell that is not a published video. */
const NOT_A_VIDEO = ['Draf', 'Drafts', 'Draft']

/**
 * The channel page's video cells, top-left first, each as the words it carries.
 *
 * A cell is a clickable node ON SCREEN below the header's `Edit channel`
 * button, above the bottom bar, between a fifth and a half of the frame wide.
 * Drafts are left out — the walk itself left one, and a draft is exactly the
 * thing that must never be mistaken for a post.
 *
 * The bottom bar is the LOWEST on-screen "Beranda"/"Home": a channel with
 * videos also has a "Beranda" TAB under its header (`screen-channel.json`,
 * y=705), and taking the first match cut every cell below that tab out.
 */
export function readChannelCells(tree: UiNode, frameWidth: number): string[] {
  const visible = onScreenIn(tree)
  const frame = frameOf(tree)
  const header = shown(tree, 'Edit channel')[0] ?? shown(tree, 'Edit saluran')[0]
  const bars = [...shown(tree, 'Beranda'), ...shown(tree, 'Home')].filter((n) => n.bounds.top >= frame.height * 0.8)
  const top = header ? header.bounds.bottom : 0
  const bottom = bars.length > 0 ? Math.min(...bars.map((n) => n.bounds.top)) : Number.POSITIVE_INFINITY
  const words = (n: UiNode): string =>
    flatten(n)
      .flatMap((m) => [m.desc.trim(), m.text.trim()])
      .filter((s) => s !== '')
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .join(' · ')
  return all(tree, (n) => {
    if (!fromYouTube(n) || !n.clickable || !visible(n)) return false
    if (n.bounds.top < top || n.bounds.bottom > bottom) return false
    const w = (n.bounds.right - n.bounds.left) / frameWidth
    return w >= 0.2 && w <= 0.5 && n.bounds.bottom - n.bounds.top > 100
  })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)
    .map(words)
    .filter((s) => s !== '' && !NOT_A_VIDEO.includes(s.split(' · ')[0] as string))
}

/** Lowercased, hashtags' `#` dropped, whitespace collapsed — how a title is compared to a cell's words. */
function norm(s: string): string {
  return s.toLowerCase().replace(/#/g, '').replace(/\s+/g, ' ').trim()
}

/** A cell still on its way: "Mengirim file • 1%" is what the new cell read right after Upload (72395efa `ui/00064`). */
const IN_FLIGHT = /mengupload|uploading|mengirim file|sending file|memproses|processing|\b\d{1,3}\s?%/i

/** A cell whose upload YouTube gave up on. Such a cell is never `posted`, whatever title it carries. */
const UPLOAD_FAILED = /\bgagal\b|\bfailed\b|dibatalkan|\bcancell?ed\b/i

/** View counts, "… ago" and durations: the words on a cell that change while its video stays the same. */
const CHANGING_WORDS = [
  /\b\d[\d.,]*\s*(?:rb|jt|ribu|juta|miliar|k|m|b)?\s*(?:x\s*|kali\s*)?(?:ditonton|tayangan|penayangan|views?)\b/gi,
  /\b(?:belum ada|tidak ada|no)\s+(?:tayangan|penayangan|views?)\b/gi,
  /\b\d+\s*(?:detik|menit|jam|hari|minggu|bulan|tahun|seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*(?:yang\s+)?(?:lalu|ago)\b/gi,
  /\b\d{1,2}(?::\d{2}){1,2}\b/g,
]

/**
 * A cell's identity for before/after comparison: its words without the view
 * count, age and duration (0.30.0). Comparing full words made an OLD cell whose
 * view count had moved look new — and an old cell carrying the same title
 * then passed for this post.
 */
export function cellTitleKey(words: string): string {
  let s = norm(words)
  for (const re of CHANGING_WORDS) s = s.replace(re, ' ')
  return s.replace(/[·,\-–|]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Shortest cut-off title (normalized) accepted when the channel visibly ellipsizes it. */
const TRUNCATED_MIN = 16

/**
 * Does this cell carry THIS title? The whole normalized title must be in its
 * words — or, where the channel visibly cut it (a part ending in an ellipsis),
 * the part before the ellipsis must be a long enough start of it.
 *
 * A start WITHOUT an ellipsis never counts: that is exactly what a title that
 * lost focus halfway through typing uploads as.
 */
export function cellShowsTitle(words: string, title: string): boolean {
  const want = norm(title)
  if (want === '') return false
  if (norm(words).includes(want)) return true
  return words.split(' · ').some((part) => {
    const cut = /^(.*\S)\s*(?:…|\.\.\.)$/.exec(part.trim())
    if (!cut) return false
    const head = norm(cut[1] as string)
    return head.length >= Math.min(want.length, TRUNCATED_MIN) && want.startsWith(head)
  })
}

export type ChannelJudgement =
  | { kind: 'new' }
  | { kind: 'processing'; words: string; titled: boolean }
  | { kind: 'upload-error'; words: string }
  | { kind: 'untitled-new' }
  | { kind: 'no-baseline'; titled: boolean }
  | { kind: 'same' }
  | { kind: 'unreadable' }

/**
 * Did THIS post appear on the channel? `before` is the reading taken before the
 * walk (`null` when it could not be read), `after` the reading now.
 *
 * - `new` — more cells carry this title than before, one of them not processing. The only `posted`.
 *   With no reading from before: `seenUploading` (how many cells carried this title when this run saw
 *   one of them still uploading) cells or more carry it now, and none is in flight (0.31.0) — the cell
 *   was seen new while it uploaded, not assumed new.
 * - `processing` — a cell that was not there before is still uploading or processing; `titled` says
 *   whether it carries this title (a cell still uploading is new by nature, baseline or not).
 * - `upload-error` — a new cell carrying this title that YouTube shows as failed.
 * - `untitled-new` — a cell that was not there before (or simply more cells), but none with this title.
 * - `no-baseline` — no reading from before, so nothing can be proven new; `titled` says whether a cell carries this title.
 * - `same`, `unreadable` — what they say.
 */
export function judgeChannel(before: string[] | null, after: string[] | null, title: string, opts?: { seenUploading?: number }): ChannelJudgement {
  if (after === null) return { kind: 'unreadable' }
  const rest = (cell: string): string => norm(cell).replace(norm(title), ' ')
  const inFlight = (cell: string): boolean => IN_FLIGHT.test(rest(cell))
  const failed = (cell: string): boolean => UPLOAD_FAILED.test(rest(cell))
  const titled = (cell: string): boolean => cellShowsTitle(cell, title)
  const busiest = (cells: string[]): string | undefined => cells.find((c) => titled(c) && inFlight(c)) ?? cells.find(inFlight)

  if (before === null) {
    const broken = after.find((c) => titled(c) && failed(c))
    if (broken) return { kind: 'upload-error', words: broken }
    const busy = busiest(after)
    if (busy) return { kind: 'processing', words: busy, titled: titled(busy) }
    if (opts?.seenUploading !== undefined && opts.seenUploading > 0 && after.filter(titled).length >= opts.seenUploading) return { kind: 'new' }
    return { kind: 'no-baseline', titled: after.some(titled) }
  }

  // Cells after, minus the cells before — matched by title words, as a multiset.
  const left = new Map<string, number>()
  for (const cell of before ?? []) left.set(cellTitleKey(cell), (left.get(cellTitleKey(cell)) ?? 0) + 1)
  const fresh = after.filter((cell) => {
    const key = cellTitleKey(cell)
    const n = left.get(key) ?? 0
    if (n > 0) {
      left.set(key, n - 1)
      return false
    }
    return true
  })

  const broken = fresh.find((c) => titled(c) && failed(c))
  if (broken) return { kind: 'upload-error', words: broken }
  // More cells with this title than before, and the one that is new is not still processing.
  if (after.filter(titled).length > before.filter(titled).length && fresh.some((cell) => titled(cell) && !inFlight(cell))) {
    return { kind: 'new' }
  }
  const busy = busiest(fresh)
  if (busy) return { kind: 'processing', words: busy, titled: titled(busy) }
  if (fresh.length > 0 || after.length > before.length) return { kind: 'untitled-new' }
  return { kind: 'same' }
}

/**
 * The farm's own keyboard (0.31.0). With a phone's Text input on `auto` the guest agent's IME is up, drawn as a strip
 * ("Enkaku input — driven by the farm", "Switch keyboard") that a package-name test for keyboards never matches — the
 * same rule `instagram-automation-pack` 0.4.5 added for its caption screen.
 */
export const FARM_KEYBOARD_PACKAGE = 'dev.enkaku.guestagent'

const isKeyboardNode = (tree: UiNode): ((n: UiNode) => boolean) => {
  const visible = onScreenIn(tree)
  return (n) => (/inputmethod|honeyboard|swiftkey|keyboard/i.test(n.packageName) || n.packageName === FARM_KEYBOARD_PACKAGE) && visible(n)
}

/** A soft keyboard's window is in the tree, on screen. On the details screen it usually is not even when up (Android withholds it with the rest), so its absence here proves nothing. */
export function keyboardShowing(tree: UiNode): boolean {
  return all(tree, isKeyboardNode(tree)).length > 0
}

/** YouTube's toolbar ends at y=154 on every screen of the walk (`screen-channel-draft.json`). */
const TOOLBAR_BOTTOM = 154

/**
 * Where a person taps to put the keyboard away: plain page just above it — a
 * YouTube label above the keys and NOT part of anything tappable smaller than
 * a page-sized container. The lowest wins. Null when the keyboard is not in the
 * tree or there is no such label (always, on the hidden details screen); the
 * caller then taps `detailsGeometry`'s `blank`. The same reading as
 * `instagram-automation-pack`'s `keyboardDismissPoint`.
 */
export function keyboardDismissPoint(tree: UiNode): { x: number; y: number; label: string } | null {
  const isKey = isKeyboardNode(tree)
  const keys = all(tree, (n) => isKey(n) && n.clickable)
  if (keys.length === 0) return null
  const keyboardTop = Math.min(...keys.map((k) => k.bounds.top))
  const frame = frameOf(tree)
  const frameArea = frame.width * frame.height
  const visible = onScreenIn(tree)
  const clickables = all(tree, (n) => n.clickable && fromYouTube(n) && visible(n))
  const pick = all(
    tree,
    (n) => fromYouTube(n) && visible(n) && !n.clickable && (n.text.trim() !== '' || n.desc.trim() !== '') && n.bounds.top > TOOLBAR_BOTTOM && n.bounds.bottom < keyboardTop - 8,
  )
    .map((n) => ({ n, x: Math.round((n.bounds.left + n.bounds.right) / 2), y: Math.round((n.bounds.top + n.bounds.bottom) / 2) }))
    .filter(({ x, y }) => {
      const around = clickables.filter((c) => c.bounds.left <= x && x <= c.bounds.right && c.bounds.top <= y && y <= c.bounds.bottom)
      return around.length === 0 || Math.min(...around.map((c) => (c.bounds.right - c.bounds.left) * (c.bounds.bottom - c.bounds.top))) >= frameArea * 0.4
    })
    .sort((a, b) => b.n.bounds.bottom - a.n.bounds.bottom)[0]
  return pick ? { x: pick.x, y: pick.y, label: (pick.n.text.trim() || pick.n.desc.trim()).slice(0, 60) } : null
}

// ---------------------------------------------------------------------------
// Device steps.
// ---------------------------------------------------------------------------

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

export async function tapCentre(ctx: ScriptContext<unknown>, node: UiNode): Promise<void> {
  await ctx.device.tap({ point: centre(node) })
}

/** Poll for a node by short id; returns it with the tree it was found in. */
async function waitForId(ctx: ScriptContext<unknown>, shortId: string, budgetMs: number): Promise<{ node: UiNode | null; tree: UiNode }> {
  const got = await waitForTree(ctx, (t) => rowsById(t, shortId).length > 0, { budgetMs })
  return { node: rowsById(got.tree, shortId)[0] ?? null, tree: got.tree }
}

const area = (n: UiNode): number => (n.bounds.right - n.bounds.left) * (n.bounds.bottom - n.bounds.top)

const contains = (n: UiNode, p: { x: number; y: number }): boolean => n.bounds.left <= p.x && p.x <= n.bounds.right && n.bounds.top <= p.y && p.y <= n.bounds.bottom

/** The nodes from `root` down to `target`, both included; null when it is not in the tree. */
function pathTo(root: UiNode, target: UiNode): UiNode[] | null {
  if (root === target) return [root]
  for (const child of root.children) {
    const below = pathTo(child, target)
    if (below) return [root, ...below]
  }
  return null
}

/** The channel page's header is on screen — the only screen `readChannelCells` reads. */
export function channelHeaderShown(tree: UiNode): boolean {
  return shown(tree, 'Edit channel').length > 0 || shown(tree, 'Edit saluran').length > 0
}

export function accountTab(tree: UiNode): UiNode | null {
  return shown(tree, 'Anda').find((n) => n.clickable) ?? shown(tree, 'You').find((n) => n.clickable) ?? null
}

/**
 * The bottom bar's Home tab (0.35.0): the lowest clickable on-screen "Beranda"/"Home" in the bottom fifth of the
 * frame. A channel with videos also has a "Beranda" TAB under its header (`screen-channel.json`, y=705) — tapping
 * that one would stay on the channel.
 */
export function bottomHomeTab(tree: UiNode): UiNode | null {
  const visible = onScreenIn(tree)
  const frame = frameOf(tree)
  return (
    [...shown(tree, 'Beranda'), ...shown(tree, 'Home')]
      .filter((n) => n.clickable && fromYouTube(n) && visible(n) && n.bounds.top >= frame.height * 0.8)
      .sort((a, b) => b.bounds.bottom - a.bounds.bottom)[0] ?? null
  )
}

/**
 * YouTube's forced-update screen (0.38.0). Production phone job 75895645 (2026-09-15): after launch YouTube showed a
 * full screen "Update aplikasi Anda" — "Tersedia update dengan berbagai fitur baru…" — and one "UPDATE" button, no
 * navigation at all; the run waited 25 s for a bottom bar and failed "no Create button", which read like a signed-out
 * app. Recognised by that title on a YouTube node (the English wording is unverified).
 */
export function updateRequired(tree: UiNode): boolean {
  const visible = onScreenIn(tree)
  return all(tree, (n) => fromYouTube(n) && visible(n) && /^(update aplikasi anda|update your app|update youtube)$/i.test((n.text || n.desc).trim())).length > 0
}

const VIEW_CHANNEL = ['Lihat channel', 'View channel'] as const

/**
 * Where to tap for "Lihat channel" on the You page (0.31.0), and the point to tap.
 *
 * The walked build made the label itself clickable (`screen-you.json`). The production Samsung build does not: the
 * "Lihat channel" text is `clickable=false` inside the unlabelled header row `[23,154][697,335]` that takes the tap
 * (f32d8f38 `ui/00027` → `screen-you-label-row.json`, and 72395efa `ui/00066`) — and 0.30.0, requiring a clickable
 * label, read every production channel as "unreadable". So: a clickable label; else its nearest clickable ancestor;
 * else the smallest clickable node whose bounds hold the label. Never a page-sized container. The point is the
 * label's own centre either way — inside the node that takes the tap, and on the words a person would press.
 */
export function viewChannelTarget(tree: UiNode): { node: UiNode; point: { x: number; y: number } } | null {
  const visible = onScreenIn(tree)
  const frame = frameOf(tree)
  const tappable = (n: UiNode): boolean => fromYouTube(n) && n.clickable && visible(n) && area(n) < frame.width * frame.height * 0.4
  const labels = VIEW_CHANNEL.flatMap((l) => shown(tree, l)).filter(fromYouTube)
  const own = labels.find((n) => n.clickable)
  if (own) return { node: own, point: centre(own) }
  for (const label of labels) {
    const point = centre(label)
    const ancestor = (pathTo(tree, label) ?? []).slice(0, -1).reverse().find((n) => tappable(n) && contains(n, point))
    const holder = ancestor ?? all(tree, (n) => tappable(n) && contains(n, point)).sort((a, b) => area(a) - area(b))[0]
    if (holder) return { node: holder, point }
  }
  return null
}

const PREMIUM_PAGE_TITLES: readonly string[] = ['Dapatkan YouTube Premium', 'Get YouTube Premium']
const PREMIUM_PAGE_LOGOS: readonly string[] = ['Logo YouTube Premium', 'YouTube Premium logo']

/**
 * YouTube's full-page "Dapatkan YouTube Premium" offer (0.31.0) — what "Lihat channel" opened on ea9736fe
 * (`ui/00032`, `screen-premium-page.json`). Not the popup `popups.ts` closes: this page has no close control, only
 * the toolbar's back arrow, so the member leaves it with BACK. Nothing on it is ever tapped.
 */
export function premiumPage(tree: UiNode): boolean {
  if (channelHeaderShown(tree)) return false
  const visible = onScreenIn(tree)
  return all(tree, (n) => fromYouTube(n) && visible(n) && (PREMIUM_PAGE_TITLES.includes(n.text.trim()) || PREMIUM_PAGE_LOGOS.includes(n.desc.trim()))).length > 0
}

const UPLOADING = /\b(?:mengupload|uploading)\s+\d+\s+video|mengirim file|sending file/i

/**
 * YouTube is still sending a video (0.31.0): a channel cell reading "Mengirim file • 1%" (72395efa `ui/00064`), or
 * the You page's "Video Anda — Mengupload 1 video" (`ui/00066`). A force-stop now would kill the upload.
 */
export function uploadInProgress(tree: UiNode): boolean {
  const visible = onScreenIn(tree)
  return all(tree, (n) => fromYouTube(n) && visible(n) && (UPLOADING.test(n.text) || UPLOADING.test(n.desc))).length > 0
}

const PROCESSING_INDICATOR_ID = /(?:^|\/)processing_indicator_/

/**
 * YouTube's "Memproses" overlay (0.35.0): the words it shows, `''` when it shows none, or null when it is not on
 * screen. Production #6 and #7 (Samsung farm, 2026-09-15): after the trim screen's "Selesai" YouTube drew a centred
 * spinner over the trim screen — `processing_indicator_spinner`, `processing_indicator_label` "Memproses",
 * `processing_indicator_sub_label` "Mungkin perlu waktu beberapa saat" — for longer than the editor wait, and the
 * run failed "Berikutnya did not appear" while YouTube was still working. Recognised by those ids alone.
 */
export function processingOverlay(tree: UiNode): string | null {
  const visible = onScreenIn(tree)
  const nodes = all(tree, (n) => fromYouTube(n) && visible(n) && PROCESSING_INDICATOR_ID.test(n.resourceId))
  if (nodes.length === 0) return null
  return nodes
    .map((n) => n.text.trim())
    .filter((s) => s !== '')
    .join(' — ')
}

/**
 * Read the channel page that is on screen now. With `pull` (0.35.0) the page is first pulled down to refresh it —
 * the only thing that makes YouTube re-list the channel: re-opening it through Anda shows the list it already had
 * (the owner's production phones, 2026-09-15). The pull is a drag inside the video list, never a tap.
 */
async function readChannelHere(ctx: ScriptContext<unknown>, label: string, pull?: () => number): Promise<string[] | null> {
  if (pull) {
    const onScreen = await ctx.device.dump()
    if (channelHeaderShown(onScreen)) {
      await pullToRefresh(ctx, frameOf(onScreen), pull)
      await sleep(between(pull, 2_000, 3_500))
    }
  }
  await sleep(1_500) // the cells arrive after the header
  const tree = await capture(ctx, label)
  return channelHeaderShown(tree) ? readChannelCells(tree, frameOf(tree).width) : null
}

/**
 * Open the own channel page and read its cells. Never throws: a failed reading
 * is not evidence about the post, and the caller words it as such.
 *
 * `readIfShown` reads a channel page already on screen instead of navigating —
 * after Upload, YouTube opens the channel by itself with the new cell at the
 * top (72395efa `ui/00064`), and that screen is the first evidence there is.
 * Nothing here force-stops or relaunches YouTube (0.31.0). `pull` pulls the
 * channel down to refresh it once it is on screen, before it is read (0.35.0).
 */
async function readOwnChannel(ctx: ScriptContext<unknown>, label: string, opts?: { readIfShown?: boolean; pull?: () => number }): Promise<string[] | null> {
  try {
    if (opts?.readIfShown) {
      const here = await waitForTree(ctx, channelHeaderShown, { budgetMs: 8_000 })
      if (here.ok) return await readChannelHere(ctx, label, opts?.pull)
    }
    const you = await waitForTree(ctx, (t) => accountTab(t) !== null, { budgetMs: 15_000 })
    const tab = accountTab(you.tree)
    if (!tab) return null
    await tapCentre(ctx, tab)
    for (let attempt = 1; attempt <= 2; attempt++) {
      const page = await waitForTree(ctx, (t) => channelHeaderShown(t) || viewChannelTarget(t) !== null || isSignedOut(t), { budgetMs: 15_000 })
      if (isSignedOut(page.tree)) fail('E_NOT_SIGNED_IN', 'YouTube on this phone is signed out. Sign in to the account that should post (and create its channel), then re-run.')
      if (channelHeaderShown(page.tree)) return await readChannelHere(ctx, label, opts?.pull)
      const view = viewChannelTarget(page.tree)
      if (!view) {
        await capture(ctx, `${label}-you`, page.tree)
        return null
      }
      await ctx.device.tap({ point: view.point })
      const opened = await waitForTree(ctx, (t) => channelHeaderShown(t) || premiumPage(t), { budgetMs: 15_000 })
      if (channelHeaderShown(opened.tree)) return await readChannelHere(ctx, label, opts?.pull)
      if (!premiumPage(opened.tree)) {
        await capture(ctx, `${label}-not-channel`, opened.tree)
        return null
      }
      await capture(ctx, `${label}-premium-page`, opened.tree)
      ctx.log.warn('"Lihat channel" opened YouTube\'s "Dapatkan YouTube Premium" page instead of the channel — pressing BACK and reading again', { attempt })
      await ctx.device.key('BACK')
      await sleep(1_500)
    }
    return null
  } catch (err) {
    if ((err as { code?: string }).code === 'E_NOT_SIGNED_IN') throw err
    ctx.log.warn('could not read the own channel page', { error: String(err) })
    return null
  }
}

/**
 * Go Home from the bottom bar and stay a moment (0.35.0) — one of the moves a confirmation round makes. A tap on
 * a tab, never a relaunch. Never throws: a Home tab that is not on screen only means the channel is re-opened from
 * wherever YouTube is.
 */
async function visitHome(ctx: ScriptContext<unknown>, lingerMs: number): Promise<void> {
  try {
    const got = await waitForTree(ctx, (t) => bottomHomeTab(t) !== null, { budgetMs: 8_000 })
    const home = bottomHomeTab(got.tree)
    if (!home) {
      ctx.log.warn('the bottom bar\'s Home tab is not on screen — re-opening the channel from wherever YouTube is')
      return
    }
    await tapCentre(ctx, home)
    await sleep(lingerMs)
  } catch (err) {
    ctx.log.warn('could not visit Home before re-opening the channel', { error: String(err) })
  }
}

/**
 * The upload gallery is on screen (0.28.0).
 *
 * YouTube ships two pickers. The one this flow was walked on carries `gallery_header_create_title`;
 * the one on the owner's production SM-A075F fleet (2026-09-14, exported runs 1c0b1d4c, d1b3def2,
 * d941eef7) is a bottom sheet titled "Galeri" with no such header — `select_album_button`,
 * `media_grid_recycler_view`, and the same `multi_select_next_button` the rest of this flow
 * already uses. All three runs had the gallery OPEN, with the pushed video as the first cell, and
 * failed "the gallery did not open" only because this check knew the older header. Nothing past
 * this point differs between the two: cells are named by file and selected the same way.
 */
export function galleryOpen(tree: UiNode): boolean {
  return (
    rowsById(tree, 'gallery_header_create_title').length > 0 ||
    rowsById(tree, 'media_grid_recycler_view').length > 0 ||
    rowsById(tree, 'select_album_button').length > 0
  )
}

const PERMISSION_HELP =
  'the farm sets these before YouTube opens (photos and videos allowed, camera refused), so this means that step did not take on this phone — check the run log for "could not set YouTube permissions", or answer it once on the phone (camera: "Jangan izinkan", photos and videos: "Izinkan semua") and re-run. Android hides these dialogs from the farm\'s reader, so a run cannot answer them itself.'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Wait until two screenshots a second apart are byte-identical — the screen
 * has stopped changing. Returns the last screenshot, which the caller keeps as
 * the picture of the finished details screen.
 *
 * The details screen needs this because the reader cannot see it at all: it
 * opens as a header over a spinner, and the third routed run (2026-09-11)
 * aimed its title tap during that spinner, hit the thumbnail instead and
 * opened YouTube's thumbnail editor. A spinner animates, so its frames
 * differ; the finished screen is still.
 */
async function waitForStillScreen(ctx: ScriptContext<unknown>, budgetMs: number): Promise<{ still: boolean; shot: Uint8Array }> {
  const deadline = Date.now() + budgetMs
  let previous = await ctx.device.screenshot()
  while (Date.now() < deadline) {
    await sleep(1_000)
    const next = await ctx.device.screenshot()
    if (bytesEqual(previous, next)) return { still: true, shot: next }
    previous = next
  }
  return { still: false, shot: previous }
}

/** YouTube's thumbnail editor — where a mis-aimed tap on the details screen lands. It is readable, unlike the details screen. */
export function onThumbnailEditor(tree: UiNode): boolean {
  return all(tree, (n) => fromYouTube(n) && /editor thumbnail|thumbnail editor/i.test(n.desc)).length > 0
}

/** The thumbnail editor's own way out, "Keluar dari editor thumbnail" (`edit_thumbnail_back`), as production phone #13 read it (0.36.0). */
export function thumbnailEditorExit(tree: UiNode): UiNode | null {
  return all(tree, (n) => fromYouTube(n) && (/(?:^|\/)edit_thumbnail_back$/.test(n.resourceId) || /keluar dari editor thumbnail|exit thumbnail editor/i.test(n.desc)))[0] ?? null
}

/** Poll screenshots until the Upload band matches `reference`, or the budget runs out. Returns the last comparison. */
async function waitForUploadBandClear(ctx: ScriptContext<unknown>, reference: Uint8Array, region: Region, budgetMs: number): Promise<'same' | 'different' | 'unreadable'> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const band = compareShots(reference, await ctx.device.screenshot(), region)
    if (band === 'same' || Date.now() >= deadline) return band
    await sleep(700)
  }
}

/**
 * Prove no keyboard is over Upload before it is tapped (0.30.0).
 *
 * The phone keeps its OWN keyboard (header), which covers roughly the bottom
 * 40% of the screen — the whole button bar. It closes by itself about two
 * seconds after the title tap, but ONLY while a scrcpy session is attached to
 * the phone; with none, it stays up and an Upload tap lands on a key. So the
 * run no longer assumes: `reference` is the still details screen before the
 * title was tapped, and the keyboard is gone when the Upload band is back to
 * those exact pixels (and no keyboard window is in the tree).
 *
 * If not: a tap on plain page, the way a person puts a keyboard away (a
 * readable spot above it, else the measured header); then BACK, and only while
 * a keyboard window is IN THE TREE (0.31.0) — never on pixels alone. With the
 * keyboard gone, BACK leaves the details screen and throws the title away
 * (0.26.1), and 0.30.0 pressed it on pixels: the farm keyboard's strip under a
 * band scaled from 1640 read as "a keyboard over Upload" (see
 * `detailsGeometry`). Anything that leaves the details screen, or a band that
 * will not clear, throws: Upload has not been pressed, so nothing can have been
 * uploaded.
 */
async function putKeyboardAway(ctx: ScriptContext<unknown>, reference: Uint8Array, geometry: DetailsGeometry): Promise<void> {
  const check = async (budgetMs: number): Promise<{ band: 'same' | 'different' | 'unreadable'; tree: UiNode; keyboard: boolean; gone: boolean }> => {
    const band = await waitForUploadBandClear(ctx, reference, geometry.uploadBand, budgetMs)
    const tree = await ctx.device.dump()
    const keyboard = keyboardShowing(tree)
    return { band, tree, keyboard, gone: band === 'same' && !keyboard }
  }
  const stillOnDetails = async (state: { tree: UiNode }, after: string): Promise<void> => {
    if (onDetailsScreen(state.tree)) return
    await capture(ctx, 'yt-09-keyboard-left-details', state.tree)
    fail('E_DETAILS_LAYOUT', `${after} left the details screen before Upload was pressed — nothing was uploaded. See artifact yt-09-keyboard-left-details.`)
  }

  let state = await check(KEYBOARD_GONE_MS)
  await stillOnDetails(state, 'waiting for the keyboard to close')
  if (state.gone) {
    ctx.log.info('the keyboard is gone — the Upload band is as it was before the title was tapped')
    return
  }

  const readable = keyboardDismissPoint(state.tree)
  const spot = readable ?? { ...geometry.blank, label: 'the details header' }
  ctx.log.info('the keyboard is still over Upload — tapping plain page above it', { label: spot.label, band: state.band, keyboardInTree: state.keyboard })
  await ctx.device.tap({ point: { x: spot.x, y: spot.y } }, { via: 'adb' })
  state = await check(4_000)
  await stillOnDetails(state, 'the tap meant to put the keyboard away')
  if (state.gone) return

  const backPressed = state.keyboard
  if (state.keyboard) {
    ctx.log.info('a keyboard window is still in the tree after the tap — closing it with BACK', { band: state.band })
    await ctx.device.key('BACK')
    state = await check(4_000)
    await stillOnDetails(state, 'BACK, pressed to close the keyboard,')
    if (state.gone) return
  } else {
    ctx.log.warn('the Upload band still differs from before the title was tapped, but no keyboard window is in the tree — not pressing BACK, which on this screen can leave it', { band: state.band })
  }

  await ctx.artifact.screenshot('yt-09-keyboard')
  fail(
    'E_KEYBOARD_OVER_UPLOAD',
    state.band === 'unreadable'
      ? 'the screenshots of the details screen could not be compared, so it could not be proven that no keyboard covers Upload — Upload was not pressed and nothing was uploaded. See artifact yt-09-keyboard.'
      : backPressed
        ? 'a keyboard still covers where Upload is after a tap on the page and BACK — Upload was not pressed and nothing was uploaded. See artifact yt-09-keyboard.'
        : 'something still covers where Upload is on the screenshot, and no keyboard window is in the tree to close — BACK was not pressed, because on this screen it can leave the details and keep a draft. Upload was not pressed and nothing was uploaded. See artifact yt-09-keyboard.',
  )
}

/**
 * What the Upload tap did, read without trusting `hiddenWindow` alone (0.30.0).
 *
 * - `left` — a readable screen (or no YouTube frame) replaced the details screen.
 * - `changed` — the details frame is still empty, but the screen is not what it
 *   was: a loading screen after an Upload that took looks exactly like this.
 * - `unchanged` — every screenshot's content region is pixel-for-pixel the one
 *   taken just before the tap. The ONLY state in which nothing was uploaded.
 */
async function watchUploadTap(ctx: ScriptContext<unknown>, reference: Uint8Array, content: Region, budgetMs: number): Promise<{ kind: 'left' | 'changed' | 'unchanged'; tree: UiNode }> {
  const deadline = Date.now() + budgetMs
  let changed = false
  for (;;) {
    const tree = await ctx.device.dump()
    if (!onDetailsScreen(tree)) return { kind: 'left', tree }
    if (compareShots(reference, await ctx.device.screenshot(), content) !== 'same') changed = true
    if (Date.now() >= deadline) return { kind: changed ? 'changed' : 'unchanged', tree }
    await sleep(1_000)
  }
}

/** Labels a discard control may carry — the only labels `finish` taps (0.31.0). Exact matches only. */
export const DISCARD_LABELS: readonly string[] = ['Hapus hasil edit', 'Discard edits', 'Buang', 'Hapus', 'Discard', 'Delete']

/**
 * The creation flow's exit sheet, MEASURED on the owner's moto g06 (2026-09-14, YouTube id-ID): BACK from the details
 * screen returns to the editor; BACK there raises a sheet with `close_bottom_sheet_reshoot` "Hapus hasil edit" (discard),
 * `close_bottom_sheet_exit` "Simpan sebagai draf" (keeps a draft) and `close_bottom_sheet_cancel` "Batal" (0.31.1).
 */
const DISCARD_ID = 'close_bottom_sheet_reshoot'

/** Words a tapped discard control must never contain: keeping the draft, or going on with the post. */
const NEVER_DISCARD = ['simpan', 'save', 'draf', 'draft', 'lanjut', 'continue', 'upload', 'posting', 'berikutnya', 'next'] as const

/**
 * A discard control on screen, found by exact label only (0.31.0). NOT MEASURED ON HARDWARE: no fixture of this pack
 * shows the dialog YouTube raises when the creation flow is left with BACK, so this matches nothing it has not been
 * told by name, and never "Simpan draf" — the details screen's own button — or anything else that keeps the Short.
 */
export function discardButton(tree: UiNode): UiNode | null {
  const visible = onScreenIn(tree)
  return (
    all(
      tree,
      (n) =>
        fromYouTube(n) &&
        n.clickable &&
        visible(n) &&
        (n.resourceId.endsWith(`:id/${DISCARD_ID}`) || DISCARD_LABELS.includes(n.text.trim()) || DISCARD_LABELS.includes(n.desc.trim())),
    ).filter(
      (n) => !NEVER_DISCARD.some((w) => `${n.text} ${n.desc}`.toLowerCase().includes(w)),
    )[0] ?? null
  )
}

/** Errors this member throws while the Short is open on the details screen (or a screen a mis-aimed tap there opened). */
const DETAILS_ERRORS: readonly string[] = ['E_DETAILS_NOT_READY', 'E_DETAILS_LAYOUT', 'E_KEYBOARD_OVER_UPLOAD', 'E_UPLOAD_TAP_NOT_TAKEN']

/**
 * Leave the Shorts creation flow without keeping a draft (0.31.0), before `finish` force-stops YouTube.
 *
 * A force-stop on the details screen leaves the Short on the channel as a "Draf" cell (`screen-channel-draft.json`).
 * So: BACK, one step at a time; a discard control matched by `discardButton` is tapped; stop once YouTube's bottom
 * bar or the channel is back. Bounded, and every step is safe to repeat — `finish` may run again in a fresh process.
 * If nothing here works the force-stop still follows, and the next run answers "Lanjutkan video draf Anda?" with its
 * `unfinishedDraft` setting.
 */
async function backOutWithoutDraft(ctx: ScriptContext<unknown>): Promise<void> {
  for (let step = 0; step < 5; step++) {
    const tree = await ctx.device.dump()
    const discard = discardButton(tree)
    if (discard) {
      await capture(ctx, `yt-finish-discard-${step + 1}`, tree)
      await tapCentre(ctx, discard)
      ctx.log.info(`discarded the unfinished Short with YouTube's "${(discard.text || discard.desc).trim()}" button`)
      await sleep(1_500)
      continue
    }
    if (step > 0 && (createButton(tree) !== null || channelHeaderShown(tree))) {
      ctx.log.info('left the Shorts creation flow before closing YouTube', { steps: step })
      return
    }
    await ctx.device.key('BACK')
    await sleep(1_500)
  }
  ctx.log.warn('still inside the Shorts creation flow after BACK — closing YouTube anyway; it may keep this Short as a draft')
}

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'post-video',
  icon: 'upload',
  node: { category: 'device', icon: 'upload', summary: ['caption'], keywords: ['youtube', 'shorts', 'upload', 'post'] },
  title: 'Post a Short',
  description: 'Uploads one video from Files as a YouTube Short with the caption as its title, then confirms it on the channel page.',
  params,
  result,
  // 15 minutes (0.38.2): processing (up to 3 min), the details screen (up to 2 min 30 s to open and again to load) and the
  // confirmation (up to 5 min) no longer fit the 10 minutes this was.
  timeout: 15 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const screens: Screen[] = []
    let title = ctx.params.caption.replace(/\s+/g, ' ').trim()
    // The title is typed through `input text` (ADB_ONLY), which carries printable ASCII only.
    const ascii = asciiTitle(title)
    if (ascii !== title) {
      ctx.log.warn('the caption has characters adb cannot type (emoji, accents) — they were left out of the YouTube title', { before: title.length, after: ascii.length })
      title = ascii
    }
    if (title.length === 0) fail('E_PARAMS_INVALID', 'the caption has no characters that can be typed as a YouTube title (printable ASCII) — give it some text.')
    if (title.length > TITLE_MAX) {
      const fitted = youtubeTitle(title)
      ctx.log.warn(`caption is longer than YouTube's ${TITLE_MAX}-character title — cut at a word, keeping the hashtags that fit`, {
        length: title.length,
        title: fitted.title,
        droppedHashtags: fitted.droppedTags.join(' '),
      })
      title = fitted.title
    }

    let home = await capture(ctx, 'yt-01-home')
    // The details screen is driven by taps measured in PORTRAIT. On landscape
    // those points land on other controls — "Simpan draf" among them — so a
    // landscape screen stops the run before anything is touched. Observed on
    // the owner's moto (2026-09-11): lying on its side, the system re-enabled
    // auto-rotate on every YouTube launch, over the farm's own portrait lock.
    let homeFrame = frameOf(home)
    if (homeFrame.width > homeFrame.height) {
      /*
        One relaunch before giving up (0.30.1). Most of the production SM-A075F/SM-A065F fleet stopped
        here on 2026-09-14. `app.launch` re-asserts the farm's rotation lock, and since this release it
        does so from the device's STORED setting rather than the mode the always-on session was built
        with — so a lock that was not in force when YouTube first opened (a setting saved while a job
        held the phone, or a lock a closing session handed back) is written again and YouTube reopens
        under it. Still landscape after that is the named failure below, with both screens saved.
      */
      ctx.log.warn('YouTube opened in landscape — relaunching once, which re-asserts the rotation lock', { width: homeFrame.width, height: homeFrame.height })
      await relaunch(ctx)
      home = await capture(ctx, 'yt-01-home-relaunched')
      homeFrame = frameOf(home)
    }
    if (homeFrame.width > homeFrame.height) {
      fail(
        'E_SCREEN_LANDSCAPE',
        `YouTube opened in landscape (${homeFrame.width}x${homeFrame.height}) even though the farm re-locks rotation when an app opens. Check the device's rotation setting is "lock-portrait" (Devices → the phone → Settings), then re-run — this flow taps positions measured in portrait.`,
      )
    }
    if (!createButton(home) && updateRequired(home)) {
      await capture(ctx, 'yt-01-update-required', home)
      fail(
        'E_APP_UPDATE_REQUIRED',
        'YouTube on this phone is showing "Update aplikasi Anda" and will not open until it is updated. Update YouTube on the phone (press UPDATE, or through the Play Store), then re-run. Nothing was uploaded. See artifact yt-01-update-required.',
      )
    }
    if (!createButton(home)) {
      // The signed-out app has no Create button at all; say which, rather than "anchor not found".
      // The account tab is "Anda"/"You" on current builds and "Library" on the older English one the
      // farm's emulator runs (its signed-out bar: Home, Shorts, Subscriptions, Library).
      const you = ['Anda', 'You', 'Library', 'Koleksi'].map((l) => shown(home, l).find((n) => n.clickable)).find(Boolean)
      if (you) {
        await tapCentre(ctx, you)
        const page = await waitForTree(ctx, isSignedOut, { budgetMs: 8_000 })
        await capture(ctx, 'yt-01-account-tab', page.tree)
        if (page.ok) fail('E_NOT_SIGNED_IN', 'YouTube on this phone is signed out. Sign in to the account that should post (and create its channel), then re-run.')
      }
      fail(
        'E_ANCHOR_NOT_FOUND',
        'YouTube\'s bottom bar has no Create ("Buat") button. That is usually a signed-out YouTube or a build too old to upload from — see artifacts yt-01-home and yt-01-account-tab.',
      )
    }
    screens.push('home')

    await removeStalePushedVideos(ctx)
    const remotePath = `/sdcard/DCIM/Camera/yt-${ctx.job.id}-${ctx.job.attempt}.mp4`
    const fileName = remotePath.slice(remotePath.lastIndexOf('/') + 1)
    await ctx.device.push({ artifactId: ctx.params.videoArtifactId, remotePath, mediaScan: 'auto' })

    // The baseline the confirmation compares against. A dry run posts nothing and skips it.
    let before = ctx.params.dryRun ? null : await readOwnChannel(ctx, 'yt-02-channel-before')
    if (!ctx.params.dryRun && before === null) {
      // Once more (0.31.0): with no baseline no later reading can prove the post new, and every production run of 0.30.0 had none.
      ctx.log.warn('the channel could not be read before posting — trying once more')
      before = await readOwnChannel(ctx, 'yt-02-channel-before-retry')
    }
    ctx.log.info('read the channel before posting', { cells: before === null ? 'unreadable' : String(before.length) })

    /*
      The unfinished-draft prompt can land in ANY wait until the gallery is drawn
      (0.30.0) — Instagram's did, a moment after its gallery appeared (routed run,
      2026-09-14). So every wait from Create to the gallery cell also stops on
      it, answers it by the `unfinishedDraft` setting, and waits again. `ready`
      is called once per polled tree, first, so a stateful reading
      (`hiddenDialogWatch`) sees every tree.
    */
    let draftsAnswered = 0
    const waitPastDraft = async (ready: (t: UiNode) => boolean, budgetMs: number): Promise<{ tree: UiNode; ok: boolean }> => {
      const until = (t: UiNode): boolean => {
        const r = ready(t)
        return resumeDraftPrompt(t) !== null || r
      }
      let got = await waitForTree(ctx, until, { budgetMs })
      for (let round = 0; round < 3; round++) {
        const prompt = resumeDraftPrompt(got.tree)
        if (!prompt) break
        draftsAnswered += 1
        const label = draftsAnswered === 1 ? 'yt-03-unfinished-draft' : `yt-03-unfinished-draft-${draftsAnswered}`
        await capture(ctx, label, got.tree)
        if (ctx.params.unfinishedDraft === 'stop' || !prompt.startOver) {
          fail('E_UNFINISHED_DRAFT', `YouTube has an unfinished Shorts edit on this phone and asked whether to continue it. The run was set to stop rather than discard it — see artifact ${label}.`)
        }
        ctx.log.warn('YouTube had an unfinished Shorts edit — starting over, which discards it', { setting: ctx.params.unfinishedDraft, prompt: draftsAnswered })
        await tapCentre(ctx, prompt.startOver as UiNode)
        got = await waitForTree(ctx, until, { budgetMs })
      }
      return { tree: got.tree, ok: got.ok && resumeDraftPrompt(got.tree) === null }
    }

    // --- Create -> gallery ----------------------------------------------------
    const bar = await waitForTree(ctx, (t) => createButton(t) !== null, { budgetMs: 10_000 })
    const create = createButton(bar.tree)
    if (!create) fail('E_ANCHOR_NOT_FOUND', 'the Create ("Buat") button was not found after reading the channel.')
    await tapCentre(ctx, create)
    screens.push('create')

    const createDialog = hiddenDialogWatch()
    const opened = await waitPastDraft((t) => {
      const dialog = createDialog.observe(t)
      return rowsById(t, 'unified_permissions_primary_button').length > 0 || rowsById(t, 'gallery_header_create_title').length > 0 || dialog
    }, 12_000)
    await capture(ctx, 'yt-03-create', opened.tree)
    if (createDialog.confirmed) fail('E_PERMISSION_DIALOG_HIDDEN', `YouTube is asking for a permission (the camera, on Create) — ${PERMISSION_HELP}`)
    const fromGallery = rowsById(opened.tree, 'unified_permissions_primary_button')[0]
    if (fromGallery) {
      await tapCentre(ctx, fromGallery)
    } else if (rowsById(opened.tree, 'gallery_header_create_title').length === 0) {
      fail(
        'E_ANCHOR_NOT_FOUND',
        'Create did not show "Tambahkan dari Galeri". This flow was walked with the camera refused; a phone that granted YouTube the camera shows a different screen — see artifact yt-03-create.',
      )
    }

    const galleryDialog = hiddenDialogWatch()
    const galleryReady = (t: UiNode): boolean => {
      const dialog = galleryDialog.observe(t)
      return galleryOpen(t) || dialog
    }
    let gallery = await waitPastDraft(galleryReady, fromGallery ? 6_000 : 12_000)
    for (let retap = 0; retap < 2 && fromGallery && !gallery.ok && !galleryDialog.confirmed; retap++) {
      /*
        A "Tambahkan dari Galeri" tap YouTube did not act on (0.36.0). Production phone #5 (2026-09-15): the camera screen
        with the button was still on screen twelve seconds after the tap, exactly as before it, and the run failed "the
        gallery did not open". While that screen is still up, its button is tapped again, as a person would.
      */
      const again = rowsById(gallery.tree, 'unified_permissions_primary_button')[0]
      if (!again) break
      ctx.log.warn('the camera screen is still up after "Tambahkan dari Galeri" — tapping it again', { retap: retap + 1 })
      await tapCentre(ctx, again)
      gallery = await waitPastDraft(galleryReady, 10_000)
    }
    if (galleryDialog.confirmed) {
      await capture(ctx, 'yt-04-gallery', gallery.tree)
      fail('E_PERMISSION_DIALOG_HIDDEN', `YouTube is asking for access to photos and videos — ${PERMISSION_HELP}`)
    }
    if (!gallery.ok) {
      await capture(ctx, 'yt-04-gallery', gallery.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the gallery did not open after "Tambahkan dari Galeri" — see artifact yt-04-gallery.')
    }

    // The pushed file is the newest, so its cell is on the first screen; the scan can lag a moment.
    const found = await waitPastDraft((t) => galleryCellFor(t, fileName) !== null, 10_000)
    const galleryTree = await capture(ctx, 'yt-04-gallery', found.tree)
    const cell = found.ok ? galleryCellFor(galleryTree, fileName) : null
    if (!cell) fail('E_GALLERY_ITEM_NOT_FOUND', `the gallery has no cell named "${fileName}" — the pushed video did not appear. See artifact yt-04-gallery.`)
    await tapCentre(ctx, cell)
    const picked = await waitForTree(ctx, (t) => {
      const c = galleryCellFor(t, fileName)
      return c !== null && isSelectedCell(t, c) && rowsById(t, 'multi_select_next_button').length > 0
    }, { budgetMs: 8_000 })
    if (!picked.ok) {
      await capture(ctx, 'yt-05-picked', picked.tree)
      fail('E_ANCHOR_NOT_FOUND', `tapped "${fileName}" but the gallery did not mark it selected — see artifact yt-05-picked.`)
    }
    await tapCentre(ctx, rowsById(picked.tree, 'multi_select_next_button')[0] as UiNode)
    screens.push('gallery')

    // --- (trim) -> editor -> details ------------------------------------------
    // The trim screen is OPTIONAL: the hand walk met it, and the first routed
    // run on the same phone, same video length, went straight to the editor
    // (2026-09-11). So wait for either, and trim only when it is there.
    // Its button changed id between two production runs 12 hours apart (`trimDoneButton`).
    const next = await waitForTree(ctx, (t) => trimDoneButton(t) !== null || rowsById(t, 'shorts_post_bottom_button').length > 0, { budgetMs: 20_000 })
    const trimButton = trimDoneButton(next.tree)
    if (trimButton && rowsById(next.tree, 'shorts_post_bottom_button').length === 0) {
      ctx.log.info('the trim screen is up — tapping its "Selesai"', { id: trimButton.resourceId, text: trimButton.text, desc: trimButton.desc })
      await tapCentre(ctx, trimButton)
      screens.push('trim')
    } else if (!next.ok) {
      await capture(ctx, 'yt-06-trim', next.tree)
      fail('E_ANCHOR_NOT_FOUND', 'neither the trim screen ("Selesai") nor the Shorts editor appeared after the gallery — see artifact yt-06-trim.')
    }

    let editor = await waitForId(ctx, 'shorts_post_bottom_button', 20_000)
    /*
      A trim "Done" YouTube did not act on (0.39.3). Production #42 (2026-09-16) tapped the trim screen's own
      button — `shorts_trim_finish_trim_button`, drawn "Done" on that phone's English build — and twenty seconds
      later the dump was still the same screen, that same button in it, nothing processing. That is exactly the
      swallowed tap the editor's "Berikutnya" gets, which 0.37.0 fixed by tapping again and which was never
      applied here: the run instead died reporting the editor never opened, which was true and not the reason.
      While the trim screen is still up and YouTube is not processing, tap it again, as a person would.
    */
    for (let retap = 0; retap < 2 && !editor.node; retap++) {
      const stillTrim = trimDoneButton(editor.tree)
      if (!stillTrim || processingOverlay(editor.tree) !== null) break
      ctx.log.warn('still on the trim screen after its "Selesai" — tapping it again', { retap: retap + 1, id: stillTrim.resourceId, text: stillTrim.text })
      await tapCentre(ctx, stillTrim)
      editor = await waitForId(ctx, 'shorts_post_bottom_button', 20_000)
    }
    const processing = editor.node ? null : processingOverlay(editor.tree)
    if (processing !== null) {
      /*
        Still processing (0.35.0, production #6 and #7): YouTube is working on the trimmed video under a "Memproses"
        spinner, and the editor opens when it is done. Wait it out — never tap "Selesai" again, which is under the
        spinner and would only start the trim over — and name the state if it never finishes.
      */
      const words = processing || 'Memproses'
      const waitStarted = Date.now()
      await capture(ctx, 'yt-07-processing', editor.tree)
      ctx.log.info(`YouTube is still processing the video ("${words}") — waiting up to ${TRIM_PROCESSING_MS / 60_000} min for the Shorts editor, without tapping "Selesai" again`)
      const settled = await waitForTree(ctx, (t) => rowsById(t, 'shorts_post_bottom_button').length > 0 || processingOverlay(t) === null, { budgetMs: TRIM_PROCESSING_MS, intervalMs: 2_000 })
      const opened = rowsById(settled.tree, 'shorts_post_bottom_button')[0]
      if (opened) {
        ctx.log.info('YouTube finished processing and opened the Shorts editor', { waitedMs: settled.waitedMs })
        editor = { node: opened, tree: settled.tree }
      } else if (processingOverlay(settled.tree) !== null) {
        await capture(ctx, 'yt-07-still-processing', settled.tree)
        fail(
          'E_VIDEO_PROCESSING',
          `YouTube was still processing the video ("${words}") ${Math.round((Date.now() - waitStarted) / 1000) + 20}s after the trim screen's "Selesai", and the Shorts editor never opened — nothing was uploaded. See artifact yt-07-still-processing.`,
        )
      } else {
        ctx.log.info('the processing overlay went away — waiting for the Shorts editor', { waitedMs: settled.waitedMs })
        editor = await waitForId(ctx, 'shorts_post_bottom_button', 20_000)
      }
    }
    if (!editor.node) {
      await capture(ctx, 'yt-07-editor', editor.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the Shorts editor\'s "Berikutnya" did not appear — see artifact yt-07-editor.')
    }
    await tapCentre(ctx, editor.node)
    screens.push('editor')

    let details = await waitForTree(ctx, (t) => onDetailsScreen(t), { budgetMs: 30_000 })
    for (let retap = 0; retap < EDITOR_RETAPS && !details.ok; retap++) {
      /*
        A "Berikutnya" YouTube did not act on (0.37.0). Production #25 and #57 (2026-09-15) were still on the Shorts editor,
        its button in view, 30 s after the tap. While the editor and its button are still there — and YouTube is not
        processing — the button is tapped again, as a person would.

        The ceiling was two and is four (0.39.4). Production #60 (2026-09-16) spent both of them — the log shows the two
        warnings, and the failing dump is still the editor with `shorts_post_bottom_button` drawn and nothing processing —
        so the run died having been two taps short rather than having learnt anything new. Each pass costs one 20 s wait
        and stops the moment the editor goes away, which is why the answer to a swallowed tap is another tap, not a
        longer wait: waiting does not press a button that was never pressed.
      */
      const again = rowsById(details.tree, 'shorts_post_bottom_button')[0]
      if (!again || processingOverlay(details.tree) !== null) break
      ctx.log.warn('still on the Shorts editor after "Berikutnya" — tapping it again', { retap: retap + 1 })
      await tapCentre(ctx, again)
      details = await waitForTree(ctx, (t) => onDetailsScreen(t), { budgetMs: 20_000 })
    }
    if (!details.ok && rowsById(details.tree, 'shorts_post_bottom_button').length === 0) {
      // "Berikutnya" was taken and YouTube is still getting the details screen ready (0.38.2): wait for it, up to DETAILS_LOAD_MS.
      ctx.log.info(`the Shorts editor is gone but the details screen is not up yet — waiting up to ${DETAILS_LOAD_MS / 1000}s for it`)
      details = await waitForTree(ctx, (t) => onDetailsScreen(t), { budgetMs: DETAILS_LOAD_MS })
    }
    if (!details.ok) {
      // The tree too, not only a screenshot (0.35.0): production phone #2 (2026-09-15) showed the details screen
      // plainly on its screenshot while this wait failed, and with no dump the cause could not be read.
      await capture(ctx, 'yt-08-details', details.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the details screen did not open after the editor — see artifact yt-08-details.')
    }
    // It opens as a header over a spinner; aim nothing until it has finished drawing.
    const still = await waitForStillScreen(ctx, DETAILS_LOAD_MS)
    await ctx.artifact.screenshot('yt-08-details')
    // A READABLE details screen with its Upload button drawn has finished loading (0.38.1): on production (2026-09-15, 3 runs)
    // its thumbnail preview kept playing, so the screen was never pixel-still and the run failed with the screen ready.
    if (!still.still && !readableDetails(await ctx.device.dump())?.upload) fail('E_DETAILS_NOT_READY', `the details screen never stopped loading within ${DETAILS_LOAD_MS / 1000}s, so no tap was aimed at it — nothing was uploaded. See artifact yt-08-details.`)
    const settled = await ctx.device.dump()
    if (!onDetailsScreen(settled)) fail('E_ANCHOR_NOT_FOUND', 'the details screen closed while it loaded — nothing was uploaded. See artifact yt-08-details.')
    /*
      The orientation again, on the screen the taps are aimed at (0.31.0). The home check passes a
      phone that turns on its side later in the walk, and every point below is measured in portrait.
      Nothing has been typed or uploaded yet, so this is a clean failure. Both the tree's frame and
      the screenshot's own size are asked: the hidden details window gives the reader little to go on.
    */
    const geometry = detailsGeometry(settled)
    const shotSize = pngSize(still.shot)
    const size = shotSize ?? geometry.frame
    if (geometry.frame.width > geometry.frame.height || size.width > size.height) {
      await capture(ctx, 'yt-08-details-landscape', settled)
      fail(
        'E_SCREEN_LANDSCAPE',
        `the details screen is in landscape (${size.width}x${size.height}) — its taps are measured in portrait, so nothing was typed on it and nothing was uploaded. Check the device's rotation setting is "lock-portrait" (Devices → the phone → Settings), then re-run. See artifact yt-08-details-landscape.`,
      )
    }
    // The finished details screen with no keyboard and no title: what the Upload band must return to.
    const untouchedDetails = still.shot
    screens.push('details')

    // --- the blind part (see the header) ---------------------------------------
    // On a readable details screen the title area and Upload are aimed at by their own bounds (0.37.0); hidden, by the measure.
    const readable = readableDetails(settled)
    /*
      The title keeps its MEASURED point even on a readable screen (0.38.1). 0.37.0 tapped the middle of the "Caption your
      Short" / "Tambahkan teks pada video Shorts" node, and on production (2026-09-15, 2 runs) the typed title then opened the
      thumbnail editor twice — that point was not the field. The measured offset is the one every earlier post on both the
      moto and the Samsung typed into; only Upload is aimed at by its own bounds.
    */
    const titlePoint = geometry.title
    if (readable) ctx.log.info('the details screen is readable — aiming at its Upload button by its own bounds', { title: readable.title !== null, upload: readable.upload !== null })
    /*
      Focus cannot be PROVEN on this screen, so it is not claimed.

      Three readings tried and discarded on the owner's moto (2026-09-13/14):
      "the screen changed after the tap" is satisfied by the thumbnail
      rendering; the keyboard's own window never reaches the reader here
      (Android withholds the whole window set for this screen, the keyboard
      with it — `mInputShown` said true while the dump showed nothing); and
      `mInputShown` itself is not something a script can read.

      What IS reliable is the consequence: a tap that missed the field leaves
      focus on the thumbnail, and the first space in the title then opens the
      thumbnail editor — a readable screen, checked right after typing. A
      title that landed only in part is caught later, on the channel: its
      cell does not carry the title, and the run says `unverified`.

      And the field does not KEEP focus. Measured 2026-09-14: the keyboard
      comes up about a second after the tap and is gone two seconds later,
      leaving the field unfocused — but only while the farm's own scrcpy
      session is attached to the phone. So the title is typed INSIDE that
      window: tap, a short settle, type, and only then look at where we are.
    */
    await ctx.device.tap({ point: titlePoint }, { via: 'adb' })
    await sleep(FOCUS_SETTLE_MS)
    /*
      A long title (0.31.0). A ~100-character spaced title is seconds of `input text` on a slow
      SM-A075F — it can outlast the focus window. The adb driver now sends it in pieces of at most
      20 characters cut at spaces (`packages/drivers/src/input/adb-input.ts`, `TEXT_CHUNK`), each a
      short command. Focus is deliberately NOT re-checked between pieces: the only reading that could
      say "still focused" is this hidden window, which says nothing, so a check would cost a dump per
      piece and prove nothing. A title that outlasts the window uploads cut, and the channel check
      then finds no cell carrying the whole title — `unverified`, never `posted`.
    */
    const typed = await ctx.device.type(title, { via: 'adb', instant: true })
    ctx.log.info('typed the title', { via: typed.via })
    await sleep(1_500)
    await ctx.artifact.screenshot('yt-09-titled')
    // A tap that missed the field left focus on the thumbnail; the space in the title then opened
    // the thumbnail editor. That is what this catches — and it means nothing was uploaded.
    let afterTyping = await ctx.device.dump()
    const exitEditor = !onDetailsScreen(afterTyping) && onThumbnailEditor(afterTyping) ? thumbnailEditorExit(afterTyping) : null
    if (exitEditor) {
      /*
        Once more, from the details screen (0.36.0). Production phone #13 (2026-09-15) met this after YouTube's
        "Memproses" wait: the title tap did not focus the field and the title opened the thumbnail editor. Nothing is
        uploaded at this point and the title field was never focused, so nothing is in it: leave the editor by its own
        "Keluar dari editor thumbnail", tap the title again and type it again. A second miss is the failure below.
      */
      await capture(ctx, 'yt-09-thumbnail-editor', afterTyping)
      ctx.log.warn('the title opened the thumbnail editor instead of reaching the field — leaving the editor and typing the title once more')
      await tapCentre(ctx, exitEditor)
      const back = await waitForTree(ctx, (t) => onDetailsScreen(t), { budgetMs: 8_000 })
      if (back.ok) {
        await sleep(1_000)
        /*
          What the field already holds decides (0.38.3). Part of the first typing CAN land before the thumbnail editor
          opens: production 4e4eac2b and 9073e560 (2026-09-15) typed the title again on top of it, the field then held the
          title twice, YouTube refused it in red — "Tulis teks yang lebih singkat" — and Upload stayed disabled. So the title
          is typed again only into a field read empty; a field already holding the whole title is left as it is; anything
          else (part of it, or a field the reader cannot see) stops the run here, with nothing uploaded.
        */
        /*
          An unreadable field is asked again before it decides (0.39.4). Production #13 (2026-09-16) left the thumbnail
          editor, reached the details screen, and read `null` — and its dump holds no YouTube text node at all, which is
          that screen still drawing rather than a field that cannot be read. The run stopped on the branch meant for "the
          field holds something unexpected". Two more reads, a second apart, cost two seconds on a screen that is about to
          settle, and change nothing about the twice-typed title this branch exists to prevent: a field that stays
          unreadable still fails, and a field read non-empty is still left alone.
        */
        let held = titleFieldText(back.tree)
        for (let read = 0; read < 2 && held === null; read++) {
          await sleep(1_000)
          const again = await ctx.device.dump()
          /*
            Some of those unreadable screens are not screens at all (0.39.5). Production #9 and #43
            (2026-09-16) reached this branch with dumps holding no YouTube node whatsoever, and #9's
            names what was really there: Android's input-method chooser ("Switch keyboard"), which
            withholds every app window from the reader while it is up. No amount of reading again gets
            past a dialog — only a press does. BACK closes that chooser and nothing else while it is
            showing, so it is pressed only on a tree that shows it, and the field is read once more.
          */
          if (imePickerShowing(again)) {
            ctx.log.warn('an input-method chooser is standing over the details screen — closing it with BACK before reading the title again')
            await ctx.device.key('BACK')
            await sleep(1_000)
            held = titleFieldText(await ctx.device.dump())
          } else {
            held = titleFieldText(again)
          }
        }
        if (held === '') {
          await ctx.device.tap({ point: titlePoint }, { via: 'adb' })
          await sleep(FOCUS_SETTLE_MS)
          await ctx.device.type(title, { via: 'adb', instant: true })
          ctx.log.info('typed the title again, into a field read empty')
          await sleep(1_500)
        } else if (held !== null && sameTitle(held, title)) {
          ctx.log.info('the whole title had already landed before the thumbnail editor opened — not typing it again')
        } else {
          await capture(ctx, 'yt-09-title-not-clean', back.tree)
          fail(
            'E_DETAILS_LAYOUT',
            held === null
              ? 'the title opened YouTube\'s thumbnail editor, and after leaving it the title field could not be read, so the title was not typed again (typing it twice makes YouTube refuse it) — nothing was uploaded. See artifact yt-09-title-not-clean.'
              : `the title opened YouTube's thumbnail editor after part of it landed — the field holds "${held.slice(0, 80)}", and typing the title again would put it in twice (YouTube refuses that: "Tulis teks yang lebih singkat"), so nothing was typed and nothing was uploaded. See artifact yt-09-title-not-clean.`,
          )
        }
        afterTyping = await ctx.device.dump()
      }
    }
    if (onDetailsScreen(afterTyping) && titleRefused(afterTyping)) {
      // YouTube's own red refusal under the title (0.38.3): Upload is disabled while it shows, so say why instead of "something covers Upload".
      await capture(ctx, 'yt-09-title-refused', afterTyping)
      fail(
        'E_TITLE_REFUSED',
        `YouTube refused the title ("Tulis teks yang lebih singkat" — write a shorter text) after ${title.length} characters were typed, so Upload stayed disabled and nothing was uploaded. See artifact yt-09-title-refused.`,
      )
    }
    if (!onDetailsScreen(afterTyping)) {
      await capture(ctx, 'yt-09-not-details', afterTyping)
      fail(
        'E_DETAILS_LAYOUT',
        onThumbnailEditor(afterTyping)
          ? 'the title never reached the field: the typed text opened YouTube\'s thumbnail editor instead, which means the tap before it did not focus the title. Nothing was uploaded. If this repeats, check that this phone keeps its own keyboard (Text input: "device"). See artifact yt-09-not-details.'
          : 'typing the title left the details screen — nothing was uploaded. See artifact yt-09-not-details.',
      )
    }

    await putKeyboardAway(ctx, untouchedDetails, geometry)

    if (ctx.params.dryRun) {
      // A dry run leaves nothing on the channel (0.31.1): it used to stop here and YouTube kept the Short as a draft.
      await backOutWithoutDraft(ctx)
      return {
        outcome: 'unverified' as const,
        videoArtifactId: ctx.params.videoArtifactId,
        title,
        remotePath,
        screens,
        reason: 'dry run: the title was entered, then the run left without Upload and discarded the edit ("Hapus hasil edit").',
      }
    }

    const uploadPoint = readable?.upload ? middleOf(readable.upload) : geometry.upload
    const beforeUpload = await ctx.device.screenshot()
    await ctx.device.tap({ point: uploadPoint }, { via: 'adb' })
    ctx.log.info('tapped Upload — confirming on the channel rather than trusting the tap')

    /*
      From the Upload tap on, a throw is allowed ONLY while the screen is
      provably unchanged (0.30.0). "The details frame is still empty" is not
      that: a screen loading after an Upload that took reads the same, and
      0.29.0 threw "nothing was uploaded" from it — a failure Retry re-sends,
      and a duplicate Short if it had uploaded. So the proof is the screenshot:
      every frame's content region identical to the one taken just before the
      tap. Only then is the tap tried once more, and only then may the run fail.
    */
    let watched = await watchUploadTap(ctx, beforeUpload, geometry.content, 12_000)
    if (watched.kind === 'unchanged') {
      ctx.log.warn('Upload did not take: the details screen is pixel-for-pixel as it was before the tap — tapping once more')
      await ctx.device.tap({ point: uploadPoint }, { via: 'adb' })
      watched = await watchUploadTap(ctx, beforeUpload, geometry.content, 15_000)
    }
    if (watched.kind === 'unchanged') {
      await ctx.artifact.screenshot('yt-10-still-details')
      fail('E_UPLOAD_TAP_NOT_TAKEN', 'Upload was tapped twice and the details screen stayed pixel-for-pixel the same both times, so nothing was uploaded. See artifact yt-10-still-details.')
    }
    if (watched.kind === 'left' && onThumbnailEditor(watched.tree)) {
      await capture(ctx, 'yt-10-thumbnail-editor', watched.tree)
      fail('E_DETAILS_LAYOUT', 'the Upload tap opened YouTube\'s thumbnail editor instead — nothing was uploaded. See artifact yt-10-thumbnail-editor.')
    }
    const tapEvidence =
      watched.kind === 'left'
        ? 'Upload was tapped and YouTube left the details screen'
        : 'Upload was tapped and the screen changed, though YouTube was not seen to leave the details screen'
    if (watched.kind === 'changed') ctx.log.warn('the screen changed after Upload but the details screen was not seen to close — confirming on the channel, and never reporting failed from here')
    screens.push('uploaded')
    await capture(ctx, 'yt-10-after-upload', watched.tree)

    // --- confirmation ------------------------------------------------------------
    /*
      Past this line Upload HAS been pressed, so nothing below may end the run as
      "failed" (0.28.0). Any error while confirming (a relaunch, an unreadable
      channel, a sign-in check) becomes "unverified", carrying the error, which
      is never retried on its own.
    */
    let last: ChannelJudgement = { kind: 'unreadable' }
    let seenUploading: number | undefined
    let confirmError: string | null = null
    /*
      No force-stop from here on (0.31.0). An upload in progress lives in YouTube's own process:
      on 72395efa the new cell read "Mengirim file • 1%" and 0.27.0 then relaunched YouTube with a
      force-stop five times while it was still sending. So the first reading is the screen YouTube
      opens by itself after Upload — its channel, the new cell at the top (`ui/00064`) — and every
      later one re-opens the channel through the Anda tab. An unreadable channel brings YouTube to
      the front with a plain launch, which does not stop the app.
    */
    /*
      Watched longer once the upload was seen in flight (0.33.0). On the owner's production farm (2026-09-15, #12)
      the first look after Upload read "Mengirim file • 10%", and the channel re-opened through the Anda tab does
      not list a Short until YouTube has sent and processed it: five more looks over ~90 s read the channel as
      before, the run said "unverified", and the Short went live afterwards. So after `CONFIRM_ROUNDS`, a run
      that saw its upload in flight keeps looking until `CONFIRM_BUDGET_MS`.
    */
    let inFlightWords: string | null = null
    const confirmStarted = Date.now()
    /*
      A real refresh, at a person's rhythm (0.35.0). The owner watched production phones (2026-09-15): re-opening the
      channel through the Anda tab does not refresh its list — the uploading cell seen right after Upload vanished
      from the re-opened channel and came back only once the upload had finished. So every look after the first
      pulls the channel's video list down to refresh it, and `planConfirmStep` varies how it gets there: usually a
      pull on the channel already open, sometimes a visit to Home first and back through Anda, at jittered gaps.
      Neither move force-stops or relaunches YouTube, and the pull is a drag inside the list, never a tap.
    */
    const rng = makeRng((Date.now() ^ Number(ctx.job.attempt)) >>> 0)
    const moves: ConfirmMove[] = []
    try {
      for (let round = 0; ; round++) {
        // At least `CONFIRM_MIN_MS` whatever was seen (0.34.0): the uploading cell vanishes from a re-opened
        // channel until YouTube finishes, so a run that never caught it in flight still waits a few minutes.
        if (round >= CONFIRM_ROUNDS && Date.now() - confirmStarted >= (inFlightWords === null ? CONFIRM_MIN_MS : CONFIRM_BUDGET_MS)) break
        let after: string[] | null
        if (round === 0) {
          // The screen YouTube opens by itself after Upload, read as it is: the uploading cell is on it.
          after = await readOwnChannel(ctx, 'yt-11-channel-after-1', { readIfShown: true })
        } else {
          const step = planConfirmStep(rng, moves, CONFIRM_PLAN)
          moves.push(step.move)
          await sleep(step.waitMs)
          if (step.move === 'home') await visitHome(ctx, step.lingerMs)
          ctx.log.info(`looking at the channel again (attempt ${round + 1}) — ${step.move === 'home' ? 'back from Home through Anda' : 'on the channel already open'}${step.pull ? ', pulled to refresh' : ''}`, { waitedMs: step.waitMs })
          after = await readOwnChannel(ctx, `yt-11-channel-after-${round + 1}`, { readIfShown: step.move === 'refresh', pull: step.pull ? rng : undefined })
        }
        last = judgeChannel(before, after, title, { seenUploading })
        if (last.kind === 'processing') inFlightWords = last.words
        if (last.kind === 'processing' && last.titled && after !== null) {
          seenUploading = Math.max(seenUploading ?? 0, after.filter((cell) => cellShowsTitle(cell, title)).length)
        }
        if (last.kind === 'new') {
          return {
            outcome: 'posted' as const,
            videoArtifactId: ctx.params.videoArtifactId,
            title,
            remotePath,
            screens,
            reason:
              before === null
                ? 'a cell carrying this title was seen uploading on the channel after Upload, and then finished'
                : 'a new cell carrying this title appeared on the channel page',
          }
        }
        // With no reading from before and no sight of it uploading, no later reading can prove a titled cell new.
        if (last.kind === 'no-baseline' && last.titled && seenUploading === undefined) break
        if (last.kind === 'upload-error') break
        if (after === null) {
          ctx.log.warn('the channel could not be read — bringing YouTube to the front without restarting it', { round: round + 1 })
          await ctx.device.app.launch(YOUTUBE_PACKAGE).catch((err: unknown) => ctx.log.warn('could not bring YouTube to the front', { error: String(err) }))
        }
        ctx.log.warn(`the channel does not show this Short as live yet (attempt ${round + 1}, looking for up to ${(inFlightWords === null ? CONFIRM_MIN_MS : CONFIRM_BUDGET_MS) / 60_000} min${inFlightWords === null ? '' : ' — the upload was seen in flight'})`, { judged: JSON.stringify(last) })
      }
    } catch (err) {
      confirmError = err instanceof Error ? err.message : String(err)
      ctx.log.warn('confirming on the channel failed after Upload was tapped — reporting unverified, never failed', { error: confirmError })
    }
    const saw =
      confirmError !== null
        ? `confirming it failed (${confirmError.slice(0, 160)}).`
        : last.kind === 'processing'
          ? `a new video is still uploading or processing on YouTube ("${last.words.slice(0, 80)}"), and this title could not be read on it yet.`
          : last.kind === 'upload-error'
            ? `YouTube shows the upload of a cell carrying this title as failed ("${last.words.slice(0, 80)}").`
          : last.kind === 'untitled-new'
            ? 'a video appeared but its title was not confirmed — it does not carry this title (the title may not have been typed in full).'
            : last.kind === 'same' && inFlightWords !== null
              ? `it was seen uploading ("${inFlightWords.slice(0, 80)}"), and the channel had not listed it after ${Math.round((Date.now() - confirmStarted) / 1000)}s — most likely still sending or processing on this phone's network.`
            : last.kind === 'no-baseline'
              ? last.titled
                ? 'a cell with this title is on the channel, but the channel could not be read before Upload, so it is not proven to be this Short.'
                : 'the channel shows no cell with this title, and it could not be read before Upload to compare.'
              : last.kind === 'same'
                ? 'the channel page was as it was before Upload was tapped.'
                : 'the channel page could not be read.'
    return {
      outcome: 'unverified' as const,
      videoArtifactId: ctx.params.videoArtifactId,
      title,
      remotePath,
      screens,
      reason:
        confirmError === null && last.kind === 'processing' && last.titled
          ? `uploaded, still processing on YouTube: the new cell carrying this title reads "${last.words.slice(0, 80)}". Reporting "unverified" until the channel shows it finished.`
          : `${tapEvidence}, but ${saw} Reporting "unverified" rather than assuming it posted.`,
    }
  },

  async finish(ctx) {
    if (!ctx.error) return undefined
    await ctx.artifact.screenshot('yt-failed').catch(() => {})
    // A permission dialog is left on screen for the operator to answer; anything else is closed.
    if (ctx.error.code === 'E_PERMISSION_DIALOG_HIDDEN') return undefined
    const tree = await ctx.device.dump().catch(() => null)
    if (tree !== null && uploadInProgress(tree)) {
      // A timeout while confirming: the Short is still sending, and a force-stop would kill it (0.31.0).
      ctx.log.warn('YouTube is still uploading a video — leaving it open rather than force-stopping it')
      return undefined
    }
    if (tree !== null && (onDetailsScreen(tree) || onThumbnailEditor(tree) || DETAILS_ERRORS.includes(ctx.error.code))) {
      // A force-stop on the details screen keeps the Short as a draft (0.31.0).
      await backOutWithoutDraft(ctx).catch((err: unknown) => ctx.log.warn('could not back out of the Shorts creation flow', { error: String(err) }))
    }
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true }).catch(() => {})
    return undefined
  },
}

export default script
