import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { compareShots } from './screen-pixels'
import type { Region } from './screen-pixels'
import { all, flatten, rowsById } from './tree'
import { YOUTUBE_PACKAGE, capture, centre, labelled, relaunch, sleep, waitForTree } from './youtube'

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
 * | trim (optional)   | `creation_next_button` ("Selesai")               | screen-trim.json                 |
 * | Shorts editor     | `shorts_post_bottom_button` ("Berikutnya")       | screen-shorts-editor.json        |
 * | details           | NONE — see below                                 | screen-details-hidden.json       |
 * | You tab           | `Lihat channel` (desc)                           | screen-you.json                  |
 * | channel           | `Edit channel` (desc), cells below it            | screen-channel-draft.json        |
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
 * ## What each outcome means (0.30.0)
 *
 * - **a thrown error** — only while nothing can have been uploaded: before the
 *   Upload tap, or after it when the details screen is provably pixel-for-pixel
 *   unchanged. A failed attempt is re-sent by the session's Retry, so a throw
 *   after an Upload that took would duplicate the Short on a real channel.
 * - **`posted`** — the channel page, read before the walk and again after
 *   Upload, has one more cell carrying THIS title (the whole title, or a prefix
 *   the channel visibly cut with an ellipsis) that is no longer processing.
 * - **`unverified`** — Upload was pressed and anything short of that: a cell
 *   still processing, a new cell whose title does not match (a title that lost
 *   keys uploads under YouTube's default), a channel that could not be read
 *   before or after, or a screen that changed without visibly leaving details.
 */

/**
 * The details screen, measured with `uiautomator` on the walk (720x1640, id-ID).
 * Fractions of the full frame so another resolution scales; the layout is a
 * top-anchored title and a bottom-anchored button bar.
 *
 * - title field: EditText `[192,190][699,258]` — centre (445, 224).
 * - Upload: `upload_bottom_button` `[370,1465][699,1535]` — centre x 534.
 *
 * The Upload y is 1480, not the centre. It was chosen when the farm's own
 * input bar (~125px) could still be over the screen: inside the button whether
 * YouTube resized for it or not. Since 0.30.0 no keyboard can be up when
 * Upload is tapped (`putKeyboardAway`), so the choice no longer carries any
 * weight — and it is not moved, because nothing on hardware has measured a
 * better one.
 */
const DETAILS_TITLE = { x: 445 / 720, y: 224 / 1640 }
const DETAILS_UPLOAD = { x: 534 / 720, y: 1480 / 1640 }

/**
 * The band of the frame the Upload button sits in (`[1465..1535]` above, with
 * a margin, stopping above the navigation bar at 1556). A keyboard up in any
 * shape — over the bar, or with YouTube resized so the bar moved above it —
 * changes these pixels; with the keyboard gone they are what they were before
 * the title was ever tapped.
 */
const UPLOAD_BAND: Region = { top: 1455 / 1640, bottom: 1545 / 1640, left: 0, right: 1 }

/**
 * Everything YouTube draws on the details screen: `android:id/content` in
 * `screen-details-hidden.json` is `[0,70][720,1556]`. The status bar above it
 * is left out, so a clock that ticks over does not read as "the tap did
 * something".
 */
const DETAILS_CONTENT: Region = { top: 70 / 1640, bottom: 1556 / 1640, left: 0, right: 1 }

/**
 * Where a keyboard is put away when this screen gives the reader no plain page
 * to tap (it never does — the details window is hidden).
 *
 * NOT "just below the title block": nothing below the title field was measured,
 * and whatever is there on the walked screen (the rows under the title) opens
 * something when tapped. What IS measured is YouTube's toolbar, identical on
 * every screen of the walk: the back arrow `[0,70][98,154]`, the title text
 * from x=105 on the 88..135 line, action icons from x=468 at the earliest
 * (`screen-channel-draft.json`, `screen-you.json`). (200, 112) is inside the
 * header's own title text — plain page, clear of the arrow and of any icon,
 * and above the title field at any focus state.
 */
const DETAILS_BLANK = { x: 200 / 720, y: 112 / 1640 }

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

/** YouTube's title limit. A longer caption is cut, and the cut is logged. */
const TITLE_MAX = 100

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

const IN_FLIGHT = /mengupload|uploading|memproses|processing|\b\d{1,3}\s?%/i

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
  | { kind: 'processing'; words: string }
  | { kind: 'untitled-new' }
  | { kind: 'no-baseline'; titled: boolean }
  | { kind: 'same' }
  | { kind: 'unreadable' }

/**
 * Did THIS post appear on the channel? `before` is the reading taken before the
 * walk (`null` when it could not be read), `after` the reading now.
 *
 * - `new` — more cells carry this title than before, one of them not processing. The only `posted`.
 * - `processing` — a cell that was not there before is still uploading or processing.
 * - `untitled-new` — a cell that was not there before (or simply more cells), but none with this title.
 * - `no-baseline` — no reading from before, so nothing can be proven new; `titled` says whether a cell carries this title.
 * - `same`, `unreadable` — what they say.
 */
export function judgeChannel(before: string[] | null, after: string[] | null, title: string): ChannelJudgement {
  if (after === null) return { kind: 'unreadable' }
  const inFlight = (cell: string): boolean => IN_FLIGHT.test(norm(cell).replace(norm(title), ' '))
  const titled = (cell: string): boolean => cellShowsTitle(cell, title)

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

  if (before === null) {
    const busy = after.find(inFlight)
    if (busy) return { kind: 'processing', words: busy }
    return { kind: 'no-baseline', titled: after.some(titled) }
  }
  // More cells with this title than before, and the one that is new is not still processing.
  if (after.filter(titled).length > before.filter(titled).length && fresh.some((cell) => titled(cell) && !inFlight(cell))) {
    return { kind: 'new' }
  }
  const busy = fresh.find(inFlight)
  if (busy) return { kind: 'processing', words: busy }
  if (fresh.length > 0 || after.length > before.length) return { kind: 'untitled-new' }
  return { kind: 'same' }
}

const isKeyboardNode = (tree: UiNode): ((n: UiNode) => boolean) => {
  const visible = onScreenIn(tree)
  return (n) => /inputmethod|honeyboard|swiftkey|keyboard/i.test(n.packageName) && visible(n)
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
 * caller then taps `DETAILS_BLANK`. The same reading as
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

async function tapCentre(ctx: ScriptContext<unknown>, node: UiNode): Promise<void> {
  await ctx.device.tap({ point: centre(node) })
}

/** Poll for a node by short id; returns it with the tree it was found in. */
async function waitForId(ctx: ScriptContext<unknown>, shortId: string, budgetMs: number): Promise<{ node: UiNode | null; tree: UiNode }> {
  const got = await waitForTree(ctx, (t) => rowsById(t, shortId).length > 0, { budgetMs })
  return { node: rowsById(got.tree, shortId)[0] ?? null, tree: got.tree }
}

/**
 * Open the own channel page and read its cells. Never throws: a failed reading
 * is not evidence about the post, and the caller words it as such.
 */
async function readOwnChannel(ctx: ScriptContext<unknown>, label: string): Promise<string[] | null> {
  try {
    const you = await waitForTree(ctx, (t) => shown(t, 'Anda').length > 0 || shown(t, 'You').length > 0, { budgetMs: 15_000 })
    const tab = shown(you.tree, 'Anda').find((n) => n.clickable) ?? shown(you.tree, 'You').find((n) => n.clickable)
    if (!tab) return null
    await tapCentre(ctx, tab)
    const page = await waitForTree(ctx, (t) => shown(t, 'Lihat channel').length > 0 || shown(t, 'View channel').length > 0 || isSignedOut(t), { budgetMs: 15_000 })
    if (isSignedOut(page.tree)) fail('E_NOT_SIGNED_IN', 'YouTube on this phone is signed out. Sign in to the account that should post (and create its channel), then re-run.')
    const view = shown(page.tree, 'Lihat channel').find((n) => n.clickable) ?? shown(page.tree, 'View channel').find((n) => n.clickable)
    if (!view) return null
    await tapCentre(ctx, view)
    const channel = await waitForTree(ctx, (t) => shown(t, 'Edit channel').length > 0 || shown(t, 'Edit saluran').length > 0, { budgetMs: 15_000 })
    await sleep(1_500) // the cells arrive after the header
    const tree = await capture(ctx, label)
    return channel.ok ? readChannelCells(tree, frameOf(tree).width) : null
  } catch (err) {
    if ((err as { code?: string }).code === 'E_NOT_SIGNED_IN') throw err
    ctx.log.warn('could not read the own channel page', { error: String(err) })
    return null
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

/** Poll screenshots until the Upload band matches `reference`, or the budget runs out. Returns the last comparison. */
async function waitForUploadBandClear(ctx: ScriptContext<unknown>, reference: Uint8Array, budgetMs: number): Promise<'same' | 'different' | 'unreadable'> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const band = compareShots(reference, await ctx.device.screenshot(), UPLOAD_BAND)
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
 * readable spot above it, else `DETAILS_BLANK`); then BACK, and only while
 * there is evidence the keyboard is up — with the keyboard gone, BACK leaves
 * the details screen and throws the title away (0.26.1). Anything that leaves
 * the details screen, or a band that will not clear, throws: Upload has not
 * been pressed, so nothing can have been uploaded.
 */
async function putKeyboardAway(ctx: ScriptContext<unknown>, reference: Uint8Array, frame: { width: number; height: number }): Promise<void> {
  const check = async (budgetMs: number): Promise<{ band: 'same' | 'different' | 'unreadable'; tree: UiNode; keyboard: boolean; gone: boolean }> => {
    const band = await waitForUploadBandClear(ctx, reference, budgetMs)
    const tree = await ctx.device.dump()
    const keyboard = keyboardShowing(tree)
    return { band, tree, keyboard, gone: band === 'same' && !keyboard }
  }
  const stillOnDetails = async (state: { tree: UiNode }, after: string): Promise<void> => {
    if (hiddenWindow(state.tree) === 'details') return
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
  const spot = readable ?? { x: Math.round(frame.width * DETAILS_BLANK.x), y: Math.round(frame.height * DETAILS_BLANK.y), label: 'the details header' }
  ctx.log.info('the keyboard is still over Upload — tapping plain page above it', { label: spot.label, band: state.band, keyboardInTree: state.keyboard })
  await ctx.device.tap({ point: { x: spot.x, y: spot.y } }, { via: 'adb' })
  state = await check(4_000)
  await stillOnDetails(state, 'the tap meant to put the keyboard away')
  if (state.gone) return

  if (state.keyboard || state.band === 'different') {
    ctx.log.info('the keyboard stayed up after the tap — closing it with BACK', { band: state.band, keyboardInTree: state.keyboard })
    await ctx.device.key('BACK')
    state = await check(4_000)
    await stillOnDetails(state, 'BACK, pressed to close the keyboard,')
    if (state.gone) return
  }

  await ctx.artifact.screenshot('yt-09-keyboard')
  fail(
    'E_KEYBOARD_OVER_UPLOAD',
    state.band === 'unreadable'
      ? 'the screenshots of the details screen could not be compared, so it could not be proven that no keyboard covers Upload — Upload was not pressed and nothing was uploaded. See artifact yt-09-keyboard.'
      : 'something still covers where Upload is (most likely the keyboard) after a tap on the page and BACK — Upload was not pressed and nothing was uploaded. See artifact yt-09-keyboard.',
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
async function watchUploadTap(ctx: ScriptContext<unknown>, reference: Uint8Array, budgetMs: number): Promise<{ kind: 'left' | 'changed' | 'unchanged'; tree: UiNode }> {
  const deadline = Date.now() + budgetMs
  let changed = false
  for (;;) {
    const tree = await ctx.device.dump()
    if (hiddenWindow(tree) !== 'details') return { kind: 'left', tree }
    if (compareShots(reference, await ctx.device.screenshot(), DETAILS_CONTENT) !== 'same') changed = true
    if (Date.now() >= deadline) return { kind: changed ? 'changed' : 'unchanged', tree }
    await sleep(1_000)
  }
}

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'post-video',
  icon: 'upload',
  node: { category: 'device', icon: 'upload', summary: ['caption'], keywords: ['youtube', 'shorts', 'upload', 'post'] },
  title: 'Post a Short',
  description: 'Uploads one video from Files as a YouTube Short with the caption as its title, then confirms it on the channel page.',
  params,
  result,
  timeout: 10 * 60_000,

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
      ctx.log.warn(`caption is longer than YouTube's ${TITLE_MAX}-character title — the rest was cut`, { length: title.length })
      title = title.slice(0, TITLE_MAX).trim()
    }

    const home = await capture(ctx, 'yt-01-home')
    // The details screen is driven by taps measured in PORTRAIT. On landscape
    // those points land on other controls — "Simpan draf" among them — so a
    // landscape screen stops the run before anything is touched. Observed on
    // the owner's moto (2026-09-11): lying on its side, the system re-enabled
    // auto-rotate on every YouTube launch, over the farm's own portrait lock.
    const homeFrame = frameOf(home)
    if (homeFrame.width > homeFrame.height) {
      fail(
        'E_SCREEN_LANDSCAPE',
        `YouTube opened in landscape (${homeFrame.width}x${homeFrame.height}) even though the farm re-locks rotation when an app opens. Check the device's rotation setting is "lock-portrait" (Devices → the phone → Settings), then re-run — this flow taps positions measured in portrait.`,
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

    const remotePath = `/sdcard/DCIM/Camera/yt-${ctx.job.id}-${ctx.job.attempt}.mp4`
    const fileName = remotePath.slice(remotePath.lastIndexOf('/') + 1)
    await ctx.device.push({ artifactId: ctx.params.videoArtifactId, remotePath, mediaScan: 'auto' })

    // The baseline the confirmation compares against. A dry run posts nothing and skips it.
    const before = ctx.params.dryRun ? null : await readOwnChannel(ctx, 'yt-02-channel-before')
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
    const gallery = await waitPastDraft((t) => {
      const dialog = galleryDialog.observe(t)
      return galleryOpen(t) || dialog
    }, 12_000)
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
    const next = await waitForTree(ctx, (t) => rowsById(t, 'creation_next_button').length > 0 || rowsById(t, 'shorts_post_bottom_button').length > 0, { budgetMs: 20_000 })
    const trimButton = rowsById(next.tree, 'creation_next_button')[0]
    if (trimButton && rowsById(next.tree, 'shorts_post_bottom_button').length === 0) {
      await tapCentre(ctx, trimButton)
      screens.push('trim')
    } else if (!next.ok) {
      await capture(ctx, 'yt-06-trim', next.tree)
      fail('E_ANCHOR_NOT_FOUND', 'neither the trim screen ("Selesai") nor the Shorts editor appeared after the gallery — see artifact yt-06-trim.')
    }

    const editor = await waitForId(ctx, 'shorts_post_bottom_button', 20_000)
    if (!editor.node) {
      await capture(ctx, 'yt-07-editor', editor.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the Shorts editor\'s "Berikutnya" did not appear — see artifact yt-07-editor.')
    }
    await tapCentre(ctx, editor.node)
    screens.push('editor')

    const details = await waitForTree(ctx, (t) => hiddenWindow(t) === 'details', { budgetMs: 30_000 })
    if (!details.ok) {
      await ctx.artifact.screenshot('yt-08-details')
      fail('E_ANCHOR_NOT_FOUND', 'the details screen did not open after the editor — see artifact yt-08-details.')
    }
    // It opens as a header over a spinner; aim nothing until it has finished drawing.
    const still = await waitForStillScreen(ctx, 45_000)
    await ctx.artifact.screenshot('yt-08-details')
    if (!still.still) fail('E_DETAILS_NOT_READY', 'the details screen never stopped loading within 45s, so no tap was aimed at it — nothing was uploaded. See artifact yt-08-details.')
    const settled = await ctx.device.dump()
    if (hiddenWindow(settled) !== 'details') fail('E_ANCHOR_NOT_FOUND', 'the details screen closed while it loaded — nothing was uploaded. See artifact yt-08-details.')
    // The finished details screen with no keyboard and no title: what the Upload band must return to.
    const untouchedDetails = still.shot
    screens.push('details')

    // --- the blind part (see the header) ---------------------------------------
    const frame = frameOf(details.tree)
    const titlePoint = { x: Math.round(frame.width * DETAILS_TITLE.x), y: Math.round(frame.height * DETAILS_TITLE.y) }
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
    const typed = await ctx.device.type(title, { via: 'adb', instant: true })
    ctx.log.info('typed the title', { via: typed.via })
    await sleep(1_500)
    await ctx.artifact.screenshot('yt-09-titled')
    // A tap that missed the field left focus on the thumbnail; the space in the title then opened
    // the thumbnail editor. That is what this catches — and it means nothing was uploaded.
    const afterTyping = await ctx.device.dump()
    if (hiddenWindow(afterTyping) !== 'details') {
      await capture(ctx, 'yt-09-not-details', afterTyping)
      fail(
        'E_DETAILS_LAYOUT',
        onThumbnailEditor(afterTyping)
          ? 'the title never reached the field: the typed text opened YouTube\'s thumbnail editor instead, which means the tap before it did not focus the title. Nothing was uploaded. If this repeats, check that this phone keeps its own keyboard (Text input: "device"). See artifact yt-09-not-details.'
          : 'typing the title left the details screen — nothing was uploaded. See artifact yt-09-not-details.',
      )
    }

    await putKeyboardAway(ctx, untouchedDetails, frame)

    if (ctx.params.dryRun) {
      return {
        outcome: 'unverified' as const,
        videoArtifactId: ctx.params.videoArtifactId,
        title,
        remotePath,
        screens,
        reason: 'dry run: the title was entered and the run stopped before Upload. YouTube keeps it as a draft on the channel.',
      }
    }

    const uploadPoint = { x: Math.round(frame.width * DETAILS_UPLOAD.x), y: Math.round(frame.height * DETAILS_UPLOAD.y) }
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
    let watched = await watchUploadTap(ctx, beforeUpload, 12_000)
    if (watched.kind === 'unchanged') {
      ctx.log.warn('Upload did not take: the details screen is pixel-for-pixel as it was before the tap — tapping once more')
      await ctx.device.tap({ point: uploadPoint }, { via: 'adb' })
      watched = await watchUploadTap(ctx, beforeUpload, 15_000)
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
    let confirmError: string | null = null
    try {
      for (let round = 0; round < 6; round++) {
        if (round > 0) {
          await relaunch(ctx, { clearRecents: false })
        }
        const after = await readOwnChannel(ctx, `yt-11-channel-after-${round + 1}`)
        last = judgeChannel(before, after, title)
        if (last.kind === 'new') {
          return {
            outcome: 'posted' as const,
            videoArtifactId: ctx.params.videoArtifactId,
            title,
            remotePath,
            screens,
            reason: 'a new cell carrying this title appeared on the channel page',
          }
        }
        // With no reading from before, no later reading can prove a titled cell new.
        if (last.kind === 'no-baseline' && last.titled) break
        ctx.log.warn(`the channel does not show this Short yet (attempt ${round + 1}/6)`, { judged: JSON.stringify(last) })
        await sleep(10_000)
      }
    } catch (err) {
      confirmError = err instanceof Error ? err.message : String(err)
      ctx.log.warn('confirming on the channel failed after Upload was tapped — reporting unverified, never failed', { error: confirmError })
    }
    const saw =
      confirmError !== null
        ? `confirming it failed (${confirmError.slice(0, 160)}).`
        : last.kind === 'processing'
          ? `it was still processing ("${last.words.slice(0, 80)}") — uploaded, not yet live.`
          : last.kind === 'untitled-new'
            ? 'a video appeared but its title was not confirmed — it does not carry this title (the title may not have been typed in full).'
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
      reason: `${tapEvidence}, but ${saw} Reporting "unverified" rather than assuming it posted.`,
    }
  },

  async finish(ctx) {
    if (!ctx.error) return undefined
    await ctx.artifact.screenshot('yt-failed').catch(() => {})
    // A permission dialog is left on screen for the operator to answer; anything else is closed.
    if (ctx.error.code !== 'E_PERMISSION_DIALOG_HIDDEN') {
      await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true }).catch(() => {})
    }
    return undefined
  },
}

export default script
