import { ui, type PluginMemberScript, type ScriptContext } from '@enkaku/sdk'
import type { Bounds, Selector, UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { between, makeRng, planConfirmStep, sleep, type ConfirmMove, type ConfirmPlan, type ConfirmStep } from './human'
import { pullToRefresh, relaunch } from './gesture'
import { all, flatten } from './tree'
import { centreOf, detectScreen, findNode, captionField, nextButtonIn, pickerCells, pickerSortLabel, POST_BUTTON_LABELS, type ScreenId } from './screens'
import { isEditableNode, matchModals, sweepModals, UPLOAD_MODAL_POLICIES, type ModalPolicy } from './modals'
import { tiktokQueue, type TikTokQueueClaim } from './queue'
import { readCaptionsFile, pickCaption } from './captions'
import { resolveVideoFromFolder, recordVideoPosted } from './folder'
import { TIKTOK_PACKAGE, PROFIL_TAB, MENU_PROFIL } from './sheet'
import { dismissInterruptions } from './interruptions'

/**
 * Posts a video to TikTok — the member plan 113 exists to build (§1, §4.3). Pushes an uploaded
 * artifact to the device, walks the six-screen upload flow (feed → camera → picker → preview →
 * editor → post), sweeping every known modal along the way, and reports what it actually observed
 * rather than what it tapped (§3.6).
 *
 * `modals.ts` (113.1) and `screens.ts` (113.2) are pure — no `ctx`, no device calls, fixture-tested
 * against the six dumps captured on the 2026-08-17 hardware walk. This file is the glue: one
 * `dump()` per screen (§3.5), sweeping modals before each act, and the two things neither of those
 * modules can do on their own — deciding what "done" means (§3.6) and settling a claimed queue
 * entry (§3.3).
 *
 * Plan 115 (§3.7, §3.8, §4.5, step 115.6) adds a THIRD source, `folder` — the owner's own manual
 * workflow — beside plan 113's `direct` and `queue`. It is now the default source. `folder.ts` owns
 * every decision folder mode needs (the extension filter, both independent picks, the posted-memory
 * preference); this file only calls into it and, once Post is actually tapped, records what was
 * posted — the same shape `resolveFromQueue`/`settleClaim` already have below for the queue source.
 *
 * ## Two gaps in the evidence this file does NOT paper over
 *
 * 1. **The picker's duration check is a heuristic, not a match.** §8's "a wrong video is posted"
 *    row asks for the first cell's duration to be verified against the pushed file's — but nothing
 *    in this SDK reads a video's own duration (C6: no artifact capability at all; G7/§9 Q3 is the
 *    open question that would fix this by having `device.push` return what `scan_file` printed).
 *    What IS checked: the picker is sorted newest-first (`pickerSortLabel`, E11) and the first cell
 *    actually carries a duration reading. That is real evidence, not none — but it is not the exact
 *    match §8 describes, and `run()` says so in its result rather than pretending otherwise.
 * 2. **The post-confirmation grid read (§9 Q1, step 113.6) has no fixture.** The 2026-08-17 walk
 *    stopped at the Post button and discarded the draft (§0.2) — nobody has ever dumped this app's
 *    own-profile screen on this pack's reference device. `confirmPosted` below implements the
 *    plan's own recommendation (open the profile, look for the new video in the first grid cell,
 *    bounded wait) with a GEOMETRIC heuristic for "grid cell" rather than an id or className, since
 *    inventing either would be exactly the fabrication `CLAUDE.md` and this task forbid. It is
 *    honest about being unverified in its own log lines, and a run that cannot confirm reports
 *    `outcome: 'unverified'`, never `'posted'` (§3.6) — this is the one part of this file a real
 *    hardware run (113.4, the operator's) can prove or correct.
 */

const ARTIFACT_PREFIX = 'post-video'

/**
 * Saves a screenshot AND the tree under one label, `post-video-<label>` (1.34.1) — the Instagram and
 * YouTube packs' `capture`. A production run on the Samsung fleet (2026-09-14) failed "the dump reads
 * unknown" with only a screenshot saved, and that screenshot showed an ordinary feed: the one thing
 * that could say what the classifier actually read was never kept. Never throws — this runs on the way
 * to an error, and a failed dump (the feed may not dump at all, E3) must not replace that error.
 */
async function capture(ctx: ScriptContext<unknown>, label: string, tree?: UiNode | null): Promise<void> {
  const name = `${ARTIFACT_PREFIX}-${label}`
  await ctx.artifact.screenshot(name).catch((err: unknown) => ctx.log.warn(`could not save the ${name} screenshot`, { error: String(err) }))
  try {
    const read = tree ?? (await ctx.device.dump())
    await ctx.artifact.file(name, JSON.stringify(read, null, 2), { ext: 'json' })
  } catch (err) {
    ctx.log.warn(`could not save the ${name} tree`, { error: String(err) })
  }
}

/**
 * The picker's sort-order label when newest-first (E11) — confirmed against the checked-in
 * `__fixtures__/screen-picker.json`: `tv_title` reads "Terbaru" on this pack's reference device and
 * locale (id-ID). If a future device or locale reads something else, the picker check below fails
 * loudly rather than silently assuming order — exactly what it exists to prevent.
 */
const PICKER_SORT_NEWEST_FIRST_LABELS = ['Terbaru', 'Recent', 'Recents', 'Newest', 'Terkini']

/*
  The post screen's own publish button — read directly off `__fixtures__/screen-post.json`: a `Button`
  with text "Posting" (`sp3` on the moto, `t6b`/`tc0` on the Samsungs). Matched by TEXT, never by
  those obfuscated ids (E10). The labels live in `screens.ts` as `POST_BUTTON_LABELS` since 1.35.0,
  because `detectScreen` now needs the button on screen to call a screen the post screen.
*/

/**
 * Case-insensitive membership. Every label this pack matches was read off an id-ID device — the only
 * locale it has ever run on — and a farm's phones will not all share one: a differently-sourced SKU
 * arrives in a different language, and a selector that knows one word fails there silently. The
 * English spellings are confident; the rest are plausible and UNVERIFIED, kept because a candidate
 * that never matches costs nothing while a missing one costs the run.
 */
function labelIs(text: string, labels: string[]): boolean {
  const t = text.trim().toLowerCase()
  return labels.some((l) => t === l.toLowerCase())
}

/**
 * `sweepModals` for the ABANDON path (task 6, and the modal worker's own flag on `UPLOAD_MODAL_POLICIES`)
 *
 * `UPLOAD_MODAL_POLICIES['tt.discard-draft']` is `'abort'` — correct for the FORWARD walk (`run()`'s
 * own screens 1–6), because that walk never intentionally raises the discard-draft dialog (no BACK
 * fallback, per modals.ts's own comment), so seeing it there means something already went wrong and
 * the safe response is to stop loudly. A run that has already failed and is backing OUT, on the
 * other hand, WILL raise it — leaving the editor or post screen is exactly what shows it — and there
 * "Buang" (discard) is the correct, intended answer: keeping a half-written draft around ("Simpan
 * draf") is what would leave the app in a NOT-sane state for the next run to trip over. This map is
 * `UPLOAD_MODAL_POLICIES` with exactly that one entry overridden; every other entry keeps its
 * forward-path answer (deny the camera/mic, allow media, ignore the camera wall, ack a notice)
 * because none of those change meaning on the way out.
 */
const ABANDON_MODAL_POLICIES: Record<string, ModalPolicy> = {
  ...UPLOAD_MODAL_POLICIES,
  'tt.discard-draft': 'deny', // "Buang" — see the comment above.
  // Never "Simpan draf" on the way out (1.36.0): a resume-edit banner is noted and left unanswered — `backOutOfEditor`
  // stops at it — and the next run answers it and deletes the draft it makes (`clearDrafts`).
  'tt.resume-edit': 'ignore',
}

/** Matches a `Selector`'s `{ id }` rule — the same short-id rule `screens.ts`'s own private `hasId` uses, duplicated here because it is not exported (this file needs it for `upload_hot_area`, which `screens.ts` has no export for). */
function hasShortId(n: UiNode, shortId: string): boolean {
  return n.resourceId === shortId || n.resourceId.endsWith(`:id/${shortId}`)
}

/**
 * The device's usable surface, read off a dumped tree — the widest `right` and tallest `bottom`
 * any node reports. Used to aim the one tap this member makes blind (the feed's `+`, E3), and
 * deliberately NOT a hardcoded 720x1640: the 2026-08-17 walk happened to be on exactly that
 * resolution, which is the trap, not the answer.
 */
function measureSurface(root: UiNode): { width: number; height: number } | null {
  let width = 0
  let height = 0
  const visit = (n: UiNode): void => {
    const b = n.bounds
    if (b) {
      if (b.right > width) width = b.right
      if (b.bottom > height) height = b.bottom
    }
    for (const c of n.children ?? []) visit(c)
  }
  visit(root)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * Taps "Berikutnya" on a screen that may or may not have been readable. When the dump succeeded, the
 * node's own bounds win — `nextButtonIn` resolves E9's two-button ambiguity structurally, and a real
 * measurement always beats a remembered ratio. When it did not, the proportional fallback is used
 * and SAID SO in the log, so a run's own trace shows which taps were aimed and which were remembered.
 */
/**
 * Narrows a non-optional `enterScreen` result. Only the `optional: true` screens (preview, editor)
 * can answer with a null tree, so this never fires in practice — it exists so the two screens that
 * genuinely CANNOT be read are the only place in this file where a missing tree is a legal state,
 * rather than every caller quietly assuming one.
 */
/**
 * The device's real screen size, from the farm's own device record.
 *
 * This replaced a `measureSurface(dump())` reading after the 2026-08-18 end-to-end runs kept missing
 * the editor's "Berikutnya" button. The blind taps on the two video screens are aimed as a FRACTION
 * of the surface, so the surface has to be exactly right — and the one dump those runs could take
 * was of the FEED, the one screen this pack already knows cannot be read reliably (E3). A partial
 * feed tree measuring 720x1556 instead of 720x1640 moves the aim point 76px up: still inside the
 * screen, comfortably ABOVE a button that spans y 1451-1528, and therefore a tap that lands on
 * nothing at all — which is exactly what "still on the editor after ${rounds} settle rounds and two
 * re-taps" looks like from the outside.
 *
 * `device.get` answers from the farm's own record, so it cannot be wrong about the screen the way a
 * half-parsed accessibility dump can. The dump measurement stays as the fallback for a farm whose
 * plugin has not been granted the capability.
 */
async function measureFrame(ctx: ScriptContext<unknown>): Promise<{ width: number; height: number }> {
  try {
    const device = await ctx.farm.call(
      'device.get',
      { deviceId: ctx.job.deviceId },
      z.object({ screenW: z.number().int().positive(), screenH: z.number().int().positive() }),
    )
    ctx.log.info('measured the surface from the farm device record', { width: device.screenW, height: device.screenH })
    return { width: device.screenW, height: device.screenH }
  } catch (err) {
    ctx.log.warn('device.get was unavailable — falling back to measuring the surface from a dump, which is less reliable on an animated screen', { error: String(err) })
    const measured = measureSurface(await ctx.device.dump())
    if (!measured) throw Object.assign(new Error('could not read the surface size from the device record or a dump — cannot aim a blind tap safely'), { code: 'E_FRAME_UNREADABLE' })
    return measured
  }
}

/**
 * How long to let a video screen finish arriving before its button is pressed.
 *
 * This is the difference between the runs that worked and the runs that did not, and it took a
 * measured batch to see it. A diagnostic screenshot from a stuck run shows the editor fully drawn
 * with "Berikutnya" solid and enabled, at exactly the coordinates the tap used — so the tap was
 * neither missing the button nor hitting a disabled one. What separated the successful manual walk
 * from the failing automated one was patience: by hand there were ~10s of looking at the screen
 * before pressing, while the script pressed as soon as the screen could be identified, with the
 * video still loading behind it. TikTok appears to drop taps during that window.
 *
 * Charged once per video screen, and only there — the static screens do not need it.
 */
const VIDEO_SCREEN_DWELL_MS = 4_000

/** Android keycodes, sent as raw numbers because `KeyCode` accepts them (`packages/protocol/src/ui-node.ts`) and the named set carries no cursor/delete entries. */
const KEY_MOVE_END = 123
const KEY_DEL = 67

/**
 * Empties the caption field before typing into it.
 *
 * Found on hardware, 2026-08-18: the field is NOT reliably empty when this flow reaches it. A run
 * that had already typed once — after a back-navigation, a retry, or a draft TikTok restored — left
 * its text behind, and typing again produced `#test #video #fy#test #video fyp`: two captions
 * interleaved into one post. Nothing about that is recoverable afterwards, so the field is cleared
 * first, every time.
 *
 * MOVE_END then DEL, once per character plus a small margin, rather than a select-all: Android has
 * no select-all keycode, and long-press-to-select opens a menu that is one more surface to read.
 * Bounded, so a mis-read field length cannot become hundreds of key events.
 */
/**
 * What the caption field ACTUALLY holds — its placeholder is not content (1.31.0).
 *
 * The farm's UI tree has no hint field, so an empty EditText reports its placeholder as its text:
 * "Tambah deskripsi..." on the owner's production SM-A075F (2026-09-14, run 3f250632). Read as
 * content, it sent ~60 DEL presses at a field that had already lost focus, and the presses the
 * field did not take went to TikTok — which backed out of the post screen to the camera. Nothing
 * was posted, but the run then reported the missing Post button as its failure. A field whose text
 * is only its placeholder is empty and is not cleared at all.
 */
export function captionTextToClear(field: Pick<UiNode, 'text'>): string {
  const text = field.text.trim()
  const normalised = text.replace(/[.…\s]+$/u, '').toLowerCase()
  return CAPTION_PLACEHOLDERS.some((p) => normalised === p) ? '' : text
}

/** TikTok's caption placeholders, lowercased without trailing dots. Only seen text belongs here. */
const CAPTION_PLACEHOLDERS = ['tambah deskripsi', 'add description']

async function clearCaptionField(ctx: ScriptContext<unknown>, field: UiNode): Promise<void> {
  const existing = captionTextToClear(field)
  if (existing.length === 0) return
  const strokes = Math.min(existing.length + 5, 120)
  await ctx.device.key(KEY_MOVE_END)
  for (let i = 0; i < strokes; i += 1) await ctx.device.key(KEY_DEL)
  ctx.log.info('cleared the caption field before typing', { had: existing.slice(0, 40), strokes })
}

/**
 * Trims a caption to at most `max` hashtags, keeping the first and dropping the rest.
 *
 * The owner asked for this after watching a real post. A caption file is written by a human and can
 * easily carry more tags than the app will take. **The platform's exact maximum is not verified
 * here** — nothing in this repo can ask TikTok what it is, and inventing a number while calling it
 * TikTok\'s would be the confident fiction this pack refuses everywhere else. So this is a POLICY
 * cap the operator sets, with a conservative default, and the run says plainly when it trimmed.
 *
 * Trimming rather than refusing is deliberate: one tag too many should still post.
 */
function capHashtags(caption: string, max: number): { caption: string; dropped: string[] } {
  const tags = caption.match(/#[^\s#]+/g) ?? []
  if (tags.length <= max) return { caption, dropped: [] }
  const dropped = tags.slice(max)
  let out = caption
  for (const tag of dropped) out = out.replace(tag, '')
  return { caption: out.replace(/\s{2,}/g, ' ').trim(), dropped }
}

function requireTree(res: { tree: UiNode | null }, screen: ScreenId): UiNode {
  if (!res.tree) throw Object.assign(new Error(`the "${screen}" screen returned no tree, which only the optional screens may do`), { code: 'E_UNEXPECTED_SCREEN' })
  return res.tree
}

async function tapNext(
  ctx: ScriptContext<unknown>,
  tree: UiNode | null,
  screen: 'preview' | 'editor',
  frame: { width: number; height: number },
  learned?: { x: number; y: number } | null,
): Promise<void> {
  const node = tree ? nextButtonIn(tree, screen) : null
  if (node) {
    await ctx.device.tap({ point: centreOf(node) })
    ctx.log.info(`tapped the next button on the ${screen} screen from its own bounds`, { id: node.resourceId })
    return
  }
  // `learned` is measured from THIS device's own picker screen, which sits in the same place and CAN
  // be read; the baked-in constant is only the last resort. That ordering is what makes the blind
  // taps survive a phone this pack has never seen: a fraction measured at 720x1640 is a guess about
  // every other panel, while one measured on the device in hand is a fact about it.
  const fraction = learned ?? NEXT_BUTTON_FRACTION
  const point = { x: Math.round(frame.width * fraction.x), y: Math.round(frame.height * fraction.y) }
  await ctx.device.tap({ point })
  ctx.log.warn(`tapped the next button on the ${screen} screen from a proportional position — the screen could not be read`, {
    ...point,
    source: learned ? "this device's own picker screen" : 'the pack default (720x1640)',
  })
}

function isPostButton(n: UiNode): boolean {
  return labelIs(n.text, POST_BUTTON_LABELS)
}

/**
 * A node TikTok actually drew inside the frame (1.34.0): not a page kept in the tree off to the side,
 * whose bounds run past the left or right edge, and not a zero-size placeholder. The Instagram pack
 * met exactly that on 2026-09-14 — a hidden feed's "+" tapped at x=-1398, a stale profile's post
 * count read eight times — and every reading in this file that picks a node to tap or to believe now
 * goes through this. Width only: the frame's height comes from the farm's device record, which a
 * phone's navigation bar can disagree with, while a stale page is always off to the SIDE.
 */
export function insideFrame(n: Pick<UiNode, 'bounds'>, frameWidth: number): boolean {
  const b = n.bounds
  return b.left >= -FRAME_SLACK_PX && b.right <= frameWidth + FRAME_SLACK_PX && b.right > b.left && b.bottom > b.top
}

/**
 * How far past an edge a node may reach and still be on screen (1.34.1). A page kept off to the side is
 * off by a whole screen width (x=-1398 in the Instagram case); a node flush with the edge that reports
 * one pixel more than the device record's width is rounding, and must not hide a tab from a reading.
 */
const FRAME_SLACK_PX = 2

/**
 * A caption compared the way a person reads it: runs of whitespace (and the zero-width characters an
 * editor can leave between words) collapse to one space, the ends are trimmed, and NOTHING else is
 * forgiven — `#` and `@` are significant, because "#fyp" that landed as "fyp" is not the caption that
 * was asked for (the Instagram pack's "#liquidity tradingindonesia", 2026-09-14).
 */
export function normaliseCaption(text: string): string {
  return text.replace(/[\s\u200b-\u200d\u2060\ufeff]+/gu, ' ').trim()
}

/** True when the caption field holds exactly `intended`, by `normaliseCaption`. A field showing only its placeholder holds nothing. */
export function captionLanded(field: Pick<UiNode, 'text'>, intended: string): boolean {
  return normaliseCaption(captionTextToClear(field)) === normaliseCaption(intended)
}

/** The post screen's caption field, only when it is on screen. */
export function onScreenCaptionField(tree: UiNode, frameWidth: number): UiNode | null {
  return all(tree, (n) => n.className === 'android.widget.EditText' && insideFrame(n, frameWidth))[0] ?? null
}

/**
 * The Post button that is actually on screen (1.34.0). `findNode(isPostButton)` took the first
 * "Posting" in tree order, visible or not; a stale copy off to the side would be tapped at a point
 * where nothing is. A clickable node is preferred over a bare label, and an editable node never
 * counts — a caption reading "Post" is not a button.
 */
export function postButtonOnScreen(tree: UiNode, frameWidth: number): UiNode | null {
  const hits = all(tree, (n) => isPostButton(n) && !isEditableNode(n) && insideFrame(n, frameWidth))
  return hits.find((n) => n.clickable) ?? hits[0] ?? null
}

/** The soft keyboards this farm's phones carry: Gboard (moto), Samsung's honeyboard, SwiftKey, and anything else that says "keyboard". */
const KEYBOARD_PACKAGE = /inputmethod|honeyboard|swiftkey|keyboard/i

/**
 * Where the soft keyboard starts, or `null` when none is showing. The keyboard is its own window
 * drawn over the bottom of the screen, and the farm's dump carries it beside the app's nodes (the
 * Instagram pack's `screen-share-keyboard-open.json`). Its keys are what mark its top: a keyboard
 * window can report a root taller than the keys themselves.
 */
export function keyboardTop(tree: UiNode, frame: { width: number; height: number }): number | null {
  const nodes = all(tree, (n) => KEYBOARD_PACKAGE.test(n.packageName) && insideFrame(n, frame.width))
  if (nodes.length === 0) return null
  const keys = nodes.filter((n) => n.clickable)
  const basis = keys.length > 0 ? keys : nodes.filter((n) => n.bounds.bottom - n.bounds.top < frame.height * 0.7)
  if (basis.length === 0) return null
  return Math.min(...basis.map((n) => n.bounds.top))
}

export function keyboardShowing(tree: UiNode, frame: { width: number; height: number }): boolean {
  return keyboardTop(tree, frame) !== null
}

/** True when a showing keyboard covers `post`'s centre — a tap there lands on a key, and nothing is posted. */
export function postCoveredByKeyboard(tree: UiNode, post: UiNode, frame: { width: number; height: number }): boolean {
  const top = keyboardTop(tree, frame)
  return top !== null && centreOf(post).y >= top - 4
}

/** How far a dismiss tap stays from anything tappable, and from the keyboard — about a fingertip. */
const DISMISS_CLEARANCE_PX = 24

function boxArea(n: UiNode): number {
  return (n.bounds.right - n.bounds.left) * (n.bounds.bottom - n.bounds.top)
}

function containsPoint(n: UiNode, x: number, y: number): boolean {
  return n.bounds.left <= x && x <= n.bounds.right && n.bounds.top <= y && y <= n.bounds.bottom
}

function distanceToBox(n: UiNode, x: number, y: number): number {
  const dx = Math.max(n.bounds.left - x, 0, x - n.bounds.right)
  const dy = Math.max(n.bounds.top - y, 0, y - n.bounds.bottom)
  return Math.hypot(dx, dy)
}

/**
 * Where a person taps to put the keyboard away: plain page above it (1.34.0, the Instagram pack's
 * `keyboardDismissPoint` rule). BACK is not what someone who has just finished typing does, and on
 * this screen it is worse than unnatural — BACK without a keyboard up LEFT THE POST SCREEN and
 * discarded the caption (2026-08-18).
 *
 * Instagram's version picks a plain LABEL. TikTok's post screen has almost none: every label sits
 * inside a clickable row (`screen-post.json`). So this looks for plain PAGE instead — a point inside
 * the app's content, above the keyboard, that is at least a fingertip away from every tappable node
 * smaller than a page-sized container and from the caption field itself. The point with the most
 * room wins (lowest, then most central, on a tie). `null` when there is no such spot; the caller
 * then falls back to BACK, pressed only while the keyboard is seen.
 */
export function keyboardDismissPoint(tree: UiNode, frame: { width: number; height: number }): { x: number; y: number } | null {
  const top = keyboardTop(tree, frame)
  if (top === null) return null
  const frameArea = frame.width * frame.height
  const content = all(tree, (n) => !KEYBOARD_PACKAGE.test(n.packageName) && n.packageName !== 'com.android.systemui' && insideFrame(n, frame.width))
  const obstacles = content.filter((n) => isEditableNode(n) || (n.clickable && boxArea(n) < frameArea * 0.4))
  const minY = Math.round(frame.height * 0.12)
  const midX = frame.width / 2
  let best: { x: number; y: number; clearance: number } | null = null
  for (let y = minY; y <= top - DISMISS_CLEARANCE_PX; y += 8) {
    for (let x = 16; x <= frame.width - 16; x += 16) {
      if (!content.some((n) => containsPoint(n, x, y))) continue
      let clearance = top - y
      for (const o of obstacles) clearance = Math.min(clearance, distanceToBox(o, x, y))
      if (clearance < DISMISS_CLEARANCE_PX) continue
      const better =
        best === null ||
        clearance > best.clearance ||
        (clearance === best.clearance && (y > best.y || (y === best.y && Math.abs(x - midX) < Math.abs(best.x - midX))))
      if (better) best = { x, y, clearance }
    }
  }
  return best ? { x: best.x, y: best.y } : null
}

/**
 * The post screen, still showing THIS caption with a Post button on screen — how a Post tap that was
 * not taken looks (1.34.0). TikTok leaves the post screen the moment it accepts an upload, so this
 * reading after a tap means the tap went nowhere: under the keyboard, under a suggestion panel, or
 * into a frame that dropped it.
 */
export function postScreenStillShowing(tree: UiNode, frameWidth: number, caption: string): boolean {
  const field = onScreenCaptionField(tree, frameWidth)
  return field !== null && captionLanded(field, caption) && postButtonOnScreen(tree, frameWidth) !== null
}

/**
 * Sweeps modals, then takes the ONE dump this screen transition spends (§3.5) — used for every
 * screen after the feed. When the tree does not read as `expected`, that is reported loudly with a
 * screenshot rather than acted on blindly: this member's whole design is dump-and-walk BECAUSE
 * guessing which screen a script is on is how a wrong tap happens.
 */
async function enterScreen(
  ctx: ScriptContext<unknown>,
  policies: Record<string, ModalPolicy>,
  expected: ScreenId,
  opts?: {
    optional?: boolean
    /**
     * "If the screen still reads as the one we just left, the tap did not take — do it again."
     *
     * The 2026-08-18 end-to-end run reached `feed → camera → picker → preview → editor` and then
     * failed with *"expected the post screen but the dump reads editor"*. A tap onto a screen that
     * plays video is delivered blind (see `optional` above), so it can be swallowed — by the video
     * still loading, by a frame the button had not been drawn into yet — with nothing to notice at
     * the time. Waiting longer does not help a tap that never landed; re-tapping does, and the
     * screen check is what makes the retry safe (it only fires while the OLD screen is still there,
     * so it cannot double-tap the new one).
     */
    retapWhen?: Array<{
      /** The screen (or any of the screens) the old tap should have left. */
      screen: ScreenId | ScreenId[]
      tap: (tree: UiNode | null) => Promise<void>
      /** A further condition on the tree just read, and the modals cleared so far, for a retap that is only safe on some trees of that screen (1.34.1). */
      when?: (tree: UiNode, cleared: readonly string[]) => boolean
      /** At most this many retaps from this entry. Absent: one per round, as before. */
      max?: number
    }>
    /**
     * How many settle rounds to spend. Default five; the POST screen gets more, because it is the
     * slowest transition in the flow — TikTok processes the video before drawing it, and a run that
     * had already succeeded twice failed here on the third with "the dump reads editor". The cost of
     * a longer budget is paid only by a run that is genuinely going to fail; the cost of too short a
     * one is a false failure on a run that would have worked.
     */
    rounds?: number
  },
): Promise<{ tree: UiNode | null; cleared: string[] }> {
  const cleared: string[] = []
  let screen: ScreenId = 'unknown'
  let tree: UiNode | null = null

  // A screen transition is not instant, and neither is the dialog that rides on top of it. The
  // FIRST hardware run of folder mode failed here with `screens: ['feed']`, `modalsHandled: []` and
  // a dump reading "unknown": the `+` tap had been delivered, `sweepModals` dumped before Android
  // had drawn the camera-permission prompt, found nothing, and then the single screen dump landed
  // on a window that was neither the feed nor the camera. One sweep and one dump cannot tell "the
  // screen is wrong" apart from "the screen has not arrived yet", and only one of those is worth
  // failing a run over.
  //
  // So this settles: sweep, dump, and if the tree does not read as `expected`, wait and go round
  // again. `dialogs.ts`'s own `waitForAnchor` reached the same conclusion for the older members
  // ("treats one miss as an ordinary hiccup — sweep for a blocking dialog once, settle, and retry")
  // and this is that rule, applied per screen rather than per anchor.
  //
  // Bounded at three rounds on purpose: a fourth is not a new idea, it is the same one again — the
  // reasoning `nextDialogAction` already spells out for the auto-scroll detector.
  // Five rounds at 2s, not three at 1.5s: the first end-to-end hardware run reached
  // `feed → camera → picker → preview` and then failed with *"expected the editor screen but the
  // dump reads preview"* — the editor had simply not arrived inside 4.5s. The same run's core log
  // recorded a single `device.dump` taking 8,853ms on this device, so the old budget could be spent
  // by ONE slow dump before the screen was ever given a chance to change. A genuinely wrong screen
  // now takes ~10s to fail instead of ~4.5s, which is the right trade: a slow transition reported as
  // a wrong screen is a false failure, and a false failure on a posting run is the expensive kind.
  const rounds = opts?.rounds ?? 5
  const retaps = new Map<number, number>()
  for (let round = 0; round < rounds; round += 1) {
    if (round > 0) await sleep(2_000)
    const swept = await sweepModals(ctx, policies)
    for (const id of swept.cleared) if (!cleared.includes(id)) cleared.push(id)
    const read = await ctx.device.dump()
    tree = read
    screen = detectScreen(read)
    if (screen === expected) return { tree: read, cleared }
    const at = (opts?.retapWhen ?? []).findIndex(
      (r, i) =>
        (Array.isArray(r.screen) ? r.screen.includes(screen) : r.screen === screen) &&
        (r.max === undefined || (retaps.get(i) ?? 0) < r.max) &&
        (r.when === undefined || r.when(read, cleared)),
    )
    const stuck = at >= 0 ? opts?.retapWhen?.[at] : undefined
    if (stuck && round < rounds - 1) {
      retaps.set(at, (retaps.get(at) ?? 0) + 1)
      ctx.log.warn(`still on the "${screen}" screen — re-tapping, because the tap that should have left it did not take`, { round })
      await stuck.tap(read)
    }
  }

  // `optional` is for the two screens that PLAY THE VIDEO — preview and editor. The 2026-08-18
  // hardware runs proved they cannot be read on this device: Android's accessibility layer never
  // reports idle while a video loops, so `dump` returns a stale tree or fails outright — the same
  // fact E3 already recorded for the feed and which this plan had simply not extended to the two
  // later screens that also animate. Watching the physical device, the owner described it as the
  // run "getting stuck on the AutoCut/Berikutnya and Story Anda/Berikutnya screens"; the taps were
  // in fact landing correctly every time, and only the READING was blind.
  //
  // So those screens proceed without confirmation and are checked at the next screen that CAN be
  // read. The post screen is static and dumps reliably, so reaching it is what proves both blind
  // taps landed. Verify where verification is possible; never pretend anywhere else.
  if (opts?.optional) {
    ctx.log.warn(`the "${expected}" screen could not be confirmed by dump — it plays video and never reports idle; proceeding blind, to be checked at the next readable screen`, {
      read: screen,
      cleared: cleared.join(', ') || 'none',
    })
    return { tree: null, cleared }
  }

  await capture(ctx, `unexpected-screen-${screen}`, tree)

  /*
    Before blaming the screen we were looking for, say whether the app could
    load anything at all.

    Measured 2026-09-10 (moto g06): the phone's saved Wi-Fi networks were out
    of range and it had no cellular service, so TikTok drew its "Ada masalah /
    Coba lagi nanti" panel over the feed. Every tap after that went nowhere,
    and this threw *"expected the camera screen but the dump reads unknown"* —
    true, useless, and pointing at the camera, which was never the problem. An
    operator reading that goes looking for a selector bug in a flow that could
    not have run.
  */
  const offline = feedErrorText(tree)
  if (offline !== null) {
    throw Object.assign(
      new Error(
        `TikTok could not load — the app is showing "${offline}" instead of its feed, so nothing could be tapped. Check this phone's network: a phone with no route out cannot post.`,
      ),
      { code: 'E_APP_OFFLINE' },
    )
  }

  // The "add phone number" sheet closes back onto whatever it covered — the feed, which this classifier
  // never names — so a run that closed it and then read "unknown" says so, rather than blaming the screen.
  const phoneHint = cleared.includes('tt.phone-prompt')
    ? ` — TikTok's "add phone number" sheet was on screen and was closed; if it returns every time "+" is tapped, this account may need a phone number before TikTok lets it post`
    : ''
  throw Object.assign(
    new Error(`expected the "${expected}" screen but the dump reads "${screen}" after ${rounds} settle rounds${cleared.length > 0 ? ` (cleared: ${cleared.join(', ')})` : ' (no modal matched)'}${phoneHint}`),
    { code: 'E_UNEXPECTED_SCREEN' },
  )
}

/**
 * TikTok's own "I could not load anything" panel, in both languages this farm
 * has seen, or `null` when the tree carries no such thing.
 *
 * Matched on the app's own words rather than a resource id: this panel is
 * drawn by several surfaces (feed, inbox, profile) and its ids differ between
 * them, while the sentence is the same one a person would read off the screen.
 */
function feedErrorText(tree: UiNode | null): string | null {
  if (!tree) return null
  const NEEDLES = ['Ada masalah', 'Coba lagi nanti', 'Something went wrong', 'No internet connection', 'Tidak ada koneksi internet']
  const hit = all(tree, (n) => {
    const label = (n.text || n.desc).trim()
    return label !== '' && NEEDLES.some((needle) => label.toLowerCase() === needle.toLowerCase())
  })[0]
  return hit ? (hit.text || hit.desc).trim() : null
}

/**
 * Where "Berikutnya" sits on the preview and editor screens, as a FRACTION of the surface — the
 * fallback for when those screens cannot be dumped (above). Measured on the 2026-08-18 run at
 * 720x1640: preview (529, 1489) and editor (531, 1473), which agree to within one part in a
 * hundred, so one constant covers both rather than two that would drift apart.
 *
 * Proportional, never raw pixels — the same trap `measureSurface` exists to avoid.
 */
const NEXT_BUTTON_FRACTION = { x: 0.735, y: 0.903 }

/** A grid cell's view-count label: `0`, `1.559`, `118,6 rb`, `2,1 jt`, `3K` — digits, TikTok's separators, an optional magnitude. */
const VIEW_COUNT = /^[\d.,]+(?:[\s\u00a0]*(?:rb|jt|m|k|K|M|B))?$/
/** An upload still in flight, drawn over its own cell: `4%`, `57 %`. */
const UPLOAD_PERCENT = /^\d{1,3}\s?%$/

export type NewestCell =
  | { kind: 'new' }
  | { kind: 'uploading'; percent: string }
  | { kind: 'old'; views: string }
  | { kind: 'same' }
  | { kind: 'none' }
  /** The grid was not readable (or was empty) before Post, so nothing on it can be proved new — at most `unverified`. */
  | { kind: 'no-baseline'; views: string }

/** Labels TikTok draws on a pinned cell. A pinned video sits first regardless of age, so it says nothing about what is newest. */
const PINNED_LABELS = ['Disematkan', 'Pinned']

/**
 * The own-profile grid as a person reads it: each video cell's view-count (or
 * upload-percent) label, newest first — top row left to right, then the next.
 *
 * A cell is recognised by carrying a view-count or percent label, not by its
 * shape alone — the shape test also matched the bottom nav, whose tabs are
 * labelled "Beranda" and "Toko". Pinned cells are left out: they lead the grid
 * whatever their age. Only cells inside the frame count (1.34.0): a profile page
 * TikTok keeps in the tree off to the side still carries its old grid.
 */
export function readGrid(tree: UiNode, belowY: number, frameWidth: number): string[] {
  const labelOf = (n: UiNode): string | null => {
    for (const m of all(n, () => true)) {
      const v = (m.text || m.desc).trim()
      if (VIEW_COUNT.test(v) || UPLOAD_PERCENT.test(v)) return v
    }
    return null
  }
  const pinned = (n: UiNode): boolean => all(n, (m) => PINNED_LABELS.includes((m.text || m.desc).trim())).length > 0
  const cells = all(tree, (n) => {
    if (!n.clickable || n.bounds.top < belowY || !insideFrame(n, frameWidth)) return false
    const w = n.bounds.right - n.bounds.left
    const h = n.bounds.bottom - n.bounds.top
    const widthFraction = w / frameWidth
    return widthFraction >= 0.18 && widthFraction <= 0.5 && h / w > 0.5 && h / w < 2.5 && labelOf(n) !== null && !pinned(n)
  })
  return [...cells]
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)
    .map((n) => labelOf(n) as string)
}

/**
 * What the NEWEST cell says, with no earlier reading to compare against. Not used
 * to confirm a post since 1.34.0 — with no baseline `judgeGrid` answers
 * `no-baseline` and the run reports `unverified` — kept as the plain reading.
 *
 * `0` views reads as new, a percentage as still uploading, any other count as
 * an older video. The weakness is stated rather than hidden: an account whose
 * previous post also sits at 0 views reads as new here, which is why
 * `judgeGrid` below compares against a baseline whenever one exists.
 */
export function readNewestCell(tree: UiNode, belowY: number, frameWidth: number): NewestCell {
  const grid = readGrid(tree, belowY, frameWidth)
  const label = grid[0]
  if (label === undefined) return { kind: 'none' }
  if (UPLOAD_PERCENT.test(label)) return { kind: 'uploading', percent: label }
  if (label === '0') return { kind: 'new' }
  return { kind: 'old', views: label }
}

/** True when the caption's last token is a hashtag or mention — the case that leaves TikTok's suggestion list open. */
export function endsInTagToken(caption: string): boolean {
  return /(^|\s)[#@][^\s#@]+$/.test(caption)
}

/** `1.559` → 1559, `118,6 rb` → 118600, `2,1 jt` → 2100000, `3.5K` → 3500. `null` for anything else. */
export function parseViews(label: string): number | null {
  const m = label.trim().match(/^([\d.,]+)[\s\u00a0]*(rb|jt|k|K|m|M|B)?$/)
  if (!m) return null
  const [, digits, unit] = m as unknown as [string, string, string | undefined]
  if (!unit) {
    const n = Number(digits.replace(/[.,]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  const n = Number(digits.replace(',', '.'))
  if (!Number.isFinite(n)) return null
  const scale = unit === 'rb' || unit === 'k' || unit === 'K' ? 1e3 : unit === 'B' ? 1e9 : 1e6
  return Math.round(n * scale)
}

/** A cell read twice a few minutes apart: views never go down, and a rounded label grows by a little, not by much. */
function sameCell(before: string, after: string): boolean {
  const b = parseViews(before)
  const a = parseViews(after)
  if (b === null || a === null) return before === after
  return a >= b && a <= b * 1.25 + 25
}

/**
 * Did THIS post appear? Judged from the grid read before Post was tapped
 * (`before`) and the grid now (`after`).
 *
 * The newest-cell reading alone has a hole the owner's farm fell into on
 * 2026-09-11: the account's newest video was an earlier test post still at 0
 * views, so "the newest cell shows 0" was true before this run did anything. A
 * new post does something no other change does — it pushes every existing
 * cell one place along. So:
 *
 * - `after` is `before` shifted by one (each old cell one place later,
 *   views unchanged or a little higher) and NOT still `before` in place → new.
 * - the newest cell went from a real count to `0` → new (views never fall to 0).
 * - `after` still lines up with `before` in place → `same`: nothing appeared.
 * - anything else → the newest label, worded as an older video; the caller
 *   reports `unverified`, never `posted`.
 *
 * `before === null` (unreadable) is NO BASELINE, and with no baseline nothing
 * is ever `new`: the caller reports `unverified`. A missing baseline let any
 * newest cell at 0 views count, which is exactly the old test post the
 * 2026-09-11 run fell for. An EMPTY `before` is a baseline again (1.40.0): 1.34.0
 * made it no-baseline because a grid read before its labels arrived was also
 * empty, but `readOwnGrid` has since waited for a labelled cell or TikTok's own
 * "no videos" state and returns `[]` only for the latter. On the owner's
 * production farm (2026-09-15) every first post on a fresh account ended
 * `unverified` this way although the video was live.
 */
export function judgeGrid(before: string[] | null, after: string[]): NewestCell {
  const newest = after[0]
  if (newest === undefined) return { kind: 'none' }
  if (UPLOAD_PERCENT.test(newest)) return { kind: 'uploading', percent: newest }
  if (before === null) return { kind: 'no-baseline', views: newest }
  // An empty `before` is a profile PROVEN empty (1.40.0): `readOwnGrid` returns `[]` only on TikTok's own
  // "no videos" state and `null` for a grid that never loaded, so a cell after it can only be this post.
  if (before.length === 0) return { kind: 'new' }
  if (newest === '0' && before[0] !== '0') return { kind: 'new' }

  const inPlace = Math.min(before.length, after.length)
  const stillInPlace = Array.from({ length: inPlace }, (_, i) => sameCell(before[i] as string, after[i] as string)).every(Boolean)
  const shiftLen = Math.min(before.length, after.length - 1)
  const shifted = shiftLen > 0 && Array.from({ length: shiftLen }, (_, i) => sameCell(before[i] as string, after[i + 1] as string)).every(Boolean)
  if (shifted && !stillInPlace) return { kind: 'new' }
  if (stillInPlace) return { kind: 'same' }
  return { kind: 'old', views: newest }
}

/**
 * TikTok's own words for a profile with no videos. A wrong candidate costs nothing that matters: an empty
 * reading is NO BASELINE, exactly like an unreadable one, so recognising the state only saves the wait for
 * a grid that will never draw.
 *
 * Only two of these have been seen (1.35.0): "Bagikan video kenangan" (production bundle 04fe3367
 * ui/00024) and "Bagikan rutinitas harian Anda" (4063f322 ui/00024), on the Samsung fleet's empty
 * profiles. The rest are unverified.
 */
const EMPTY_GRID_TEXTS = [
  'belum ada video',
  'tidak ada video',
  'bagikan video pertama',
  'unggah video pertama',
  'bagikan video kenangan',
  'bagikan rutinitas harian anda',
  'no videos yet',
  'share your first video',
  'upload your first video',
]

/**
 * The empty profile's own upload button (1.35.0): `upload_work`, "Unggah", under both Samsung empty-profile
 * texts above (and bundle 4063f322 ui/00065). Matched by that id, or by EXACTLY that label — never by a
 * substring, because "Mengunggah... 4%" is an upload in progress, not an empty grid.
 */
const EMPTY_GRID_UPLOAD_ID = 'upload_work'
const EMPTY_GRID_UPLOAD_LABELS = ['unggah']

/** True when the profile below `belowY` says it has no videos (see `EMPTY_GRID_TEXTS`). */
export function gridEmptyState(tree: UiNode, belowY: number, frameWidth: number): boolean {
  return all(tree, (n) => {
    if (isEditableNode(n) || n.bounds.top < belowY || !insideFrame(n, frameWidth)) return false
    if (hasShortId(n, EMPTY_GRID_UPLOAD_ID)) return true
    const label = (n.text || n.desc).trim().toLowerCase()
    return label !== '' && (EMPTY_GRID_TEXTS.some((t) => label.includes(t)) || EMPTY_GRID_UPLOAD_LABELS.includes(label))
  }).length > 0
}

/** The bottom nav's Home tab, in both languages (the same pair `gesture.ts`'s readiness wait uses). */
const HOME_TAB_DESCS = ['Beranda', 'Home']

/** How long the own-profile grid gets to draw its first labelled cell before the reading is given up. */
const GRID_LOAD_MS = 12_000

function descOf(sel: Selector): string {
  return 'desc' in sel ? sel.desc : ''
}

/**
 * The on-screen node whose `desc` is one of `descs` — the lowest one, since the bottom nav is where
 * these tabs live. Replaces `waitFor(PROFIL_TAB)`/`waitFor(MENU_PROFIL)`, which took the first match in
 * tree order, visible or not (1.34.0).
 */
export function descNodeOnScreen(tree: UiNode, descs: string[], frameWidth: number): UiNode | null {
  const wanted = descs.filter((d) => d.trim() !== '')
  const hits = all(
    tree,
    (n) =>
      insideFrame(n, frameWidth) &&
      (wanted.some((d) => labelMatches(n.desc, d)) || wanted.some((d) => n.text.trim().toLowerCase() === d.trim().toLowerCase())),
  )
  return hits.sort((a, b) => b.bounds.bottom - a.bounds.bottom)[0] ?? null
}

/**
 * `value` reads as `label` (1.34.1): the same words, case-insensitive, or those words followed by
 * something that is not a letter or digit — "Profil, 2 notifikasi", "Home tab". Only the moto g06's
 * build has been dumped, where a tab's desc is exactly its label; another build may append its badge
 * or position to the same desc, and an exact match then reads a tab that is on screen as missing.
 * "Profil" still never matches "Profile": a letter straight after the label is a different word.
 */
export function labelMatches(value: string, label: string): boolean {
  const v = value.trim().toLowerCase()
  const l = label.trim().toLowerCase()
  if (l === '' || !v.startsWith(l)) return false
  return v.length === l.length || !/[\p{L}\p{N}]/u.test(v.charAt(l.length))
}

/**
 * The create ("+") button's labels — UNVERIFIED (1.34.1): no dump of TikTok's feed or profile exists in
 * this pack (E3), so these are the app's own word for Create in id-ID and en, offered because a wrong
 * candidate never matches while a right one turns a blind tap into an aimed one.
 */
const CREATE_BUTTON_LABELS = ['Buat', 'Create']

/**
 * The on-screen "+" in the bottom nav, or null (1.34.1). Only a node in the lower fifth of the frame and
 * near its middle counts, so a "Create" anywhere else on a page is never tapped for it; the caller falls
 * back to the measured blind point.
 */
export function createButtonOnScreen(tree: UiNode, frame: { width: number; height: number }): UiNode | null {
  const hit = descNodeOnScreen(tree, CREATE_BUTTON_LABELS, frame.width)
  if (!hit) return null
  const c = centreOf(hit)
  return c.y >= frame.height * 0.8 && Math.abs(c.x - frame.width / 2) <= frame.width * 0.15 ? hit : null
}

/** The feed's (or profile's) own bottom nav is on screen: its Home tab AND its Profil tab (1.34.1). */
export function feedNavOnScreen(tree: UiNode, frameWidth: number): boolean {
  return descNodeOnScreen(tree, HOME_TAB_DESCS, frameWidth) !== null && descNodeOnScreen(tree, [descOf(PROFIL_TAB), 'Profile'], frameWidth) !== null
}

/**
 * Closes a known modal over the feed BEFORE the feed is read or tapped (1.34.1).
 *
 * The production SM-A065F run (2026-09-14): the "add phone number" sheet was over the feed from launch.
 * It covers the bottom nav, so the Profil tab was "not on screen" and the blind "+" tap landed on the
 * sheet; the first sweep that met the sheet was the camera screen's, which closed it and left the feed —
 * "the dump reads unknown" five rounds running. Sweeping here is the register's own answer, earlier.
 *
 * A security check or an unhandled modal still stops the run by its own code, as it would have one
 * screen later. A dump that fails over an autoplaying feed (E3) is not a reason to stop: the run
 * continues and the next screen's own sweep looks again.
 */
async function clearOverFeed(ctx: ScriptContext<unknown>, before: string): Promise<void> {
  try {
    const swept = await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    recordCleared(swept.cleared)
    if (swept.cleared.length > 0) {
      ctx.log.info(`cleared a modal over the feed before ${before}`, { cleared: swept.cleared.join(', ') })
      await sleep(1_000)
    }
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'E_SECURITY_CHECK' || code === 'E_MODAL_UNHANDLED' || code === 'E_MODAL_STUCK') throw err
    ctx.log.warn(`could not sweep the feed for modals before ${before} — continuing`, { error: String(err) })
  }
}

async function waitForOnScreen(ctx: ScriptContext<unknown>, frameWidth: number, descs: string[], timeoutMs: number): Promise<UiNode | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const hit = descNodeOnScreen(await ctx.device.dump(), descs, frameWidth)
      if (hit) return hit
    } catch {
      // A dump that fails over an autoplaying feed is a miss, not an answer — go round again.
    }
    if (Date.now() >= deadline) return null
    await sleep(1_000)
  }
}

/**
 * Open the own profile and read its grid. Used twice: before the upload walk,
 * for the baseline `judgeGrid` compares against, and after Post, to confirm.
 * Returns `null` when the profile could not be reached or read — never throws,
 * because a failed reading is not evidence about the post either way.
 *
 * Polls (1.34.0). It used to sleep 1.5 s and read once, and a grid whose labels
 * had not arrived yet read as `[]` — "no videos" — which `judgeGrid` then took
 * as a baseline any later cell beat. It now waits until the grid shows a
 * labelled cell or a clear "no videos" state, and reports `null` when neither
 * arrives. `reopen` goes Home first, so a confirmation round reads a freshly
 * drawn profile rather than the page the previous round left open.
 *
 * 1.42.0: `lingerMs` is how long a `reopen` stays on Home; `stay` reads the
 * profile already on screen instead of tapping Profil again; `pull` pulls the
 * profile down to refresh it before the grid is read — a drag inside the grid,
 * after the modal sweep, never a tap.
 */
async function readOwnGrid(
  ctx: ScriptContext<unknown>,
  frame: { width: number; height: number },
  opts: { reopen?: boolean; lingerMs?: number; stay?: boolean; pull?: () => number } = {},
): Promise<string[] | null> {
  const frameWidth = frame.width
  try {
    if (opts.reopen) {
      const home = await waitForOnScreen(ctx, frameWidth, HOME_TAB_DESCS, 6_000)
      if (home) {
        await ctx.device.tap({ point: centreOf(home) })
        await sleep(opts.lingerMs ?? 1_500)
      } else {
        ctx.log.warn('could not find the Home tab to re-open the profile — reading the profile from wherever TikTok is')
      }
    }
    const here = opts.stay ? await waitForOnScreen(ctx, frameWidth, [descOf(MENU_PROFIL), 'Profile menu'], 2_000) : null
    const menuNode = here ?? (await openOwnProfile(ctx, frameWidth))
    if (!menuNode) throw new Error('the own profile could not be opened (no on-screen Profil tab, or no "Menu profil" after tapping it)')
    // Swept AFTER arriving: `tt.contacts` is raised BY the profile screen (observed 2026-08-18).
    try {
      await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    } catch {
      // Reported by the caller's own check if it matters; a reading is still worth attempting.
    }
    if (opts.pull) {
      await pullToRefresh(ctx, frame, opts.pull)
      await sleep(between(opts.pull, 2_000, 3_500))
    }

    const deadline = Date.now() + GRID_LOAD_MS
    for (;;) {
      let tree: UiNode | null = null
      try {
        tree = await ctx.device.dump()
      } catch {
        tree = null
      }
      if (tree) {
        const belowY = (descNodeOnScreen(tree, [descOf(MENU_PROFIL), 'Profile menu'], frameWidth) ?? menuNode).bounds.bottom
        const cells = readGrid(tree, belowY, frameWidth)
        if (cells.length > 0) {
          // Labels arrive cell by cell; one more look catches a grid still filling in.
          await sleep(1_000)
          try {
            const again = readGrid(await ctx.device.dump(), belowY, frameWidth)
            if (again.length > cells.length) return again
          } catch {
            // The first reading stands.
          }
          return cells
        }
        if (gridEmptyState(tree, belowY, frameWidth)) {
          ctx.log.info('the own profile says it has no videos')
          return []
        }
      }
      if (Date.now() >= deadline) break
      await sleep(1_500)
    }
    ctx.log.warn(`the own-profile grid showed no labelled cell and no "no videos" state within ${GRID_LOAD_MS / 1000}s — no reading`)
    return null
  } catch (err) {
    ctx.log.warn('could not read the own-profile grid', { error: String(err) })
    return null
  }
}

/**
 * Opens the own profile from the bottom nav and returns its on-screen "Menu profil" node — or null, with the
 * tree and a screenshot saved, when the Profil tab or the profile could not be found. Never throws. Shared by
 * `readOwnGrid` and `clearDrafts` (1.36.0).
 */
async function openOwnProfile(ctx: ScriptContext<unknown>, frameWidth: number): Promise<UiNode | null> {
  const profilNode = await waitForOnScreen(ctx, frameWidth, [descOf(PROFIL_TAB), 'Profile'], 10_000)
  if (!profilNode) {
    await capture(ctx, 'profil-tab-missing')
    ctx.log.warn('the Profil tab is not on screen')
    return null
  }
  await ctx.device.tap({ point: centreOf(profilNode) })
  let menuNode = await waitForOnScreen(ctx, frameWidth, [descOf(MENU_PROFIL), 'Profile menu'], 10_000)
  if (!menuNode) {
    // A sheet TikTok raises as the profile opens can hide "Menu profil" (1.42.0, production #9's "Riwayat penonton
    // diaktifkan"): close a known one and look again.
    const { dismissed } = await dismissInterruptions(ctx)
    if (dismissed.length > 0) {
      ctx.log.info('closed a sheet over the own profile', { dismissed: dismissed.join(', ') })
      menuNode = await waitForOnScreen(ctx, frameWidth, [descOf(MENU_PROFIL), 'Profile menu'], 6_000)
    }
  }
  if (!menuNode) {
    await capture(ctx, 'profile-not-open')
    ctx.log.warn('the own profile did not open (no on-screen "Menu profil")')
    return null
  }
  return menuNode
}

/*
  Clearing the account's drafts before posting (1.36.0).

  The owner's decision (2026-09-15): the farm deletes ALL TikTok drafts on the account before it posts. A
  leftover edit reaches the drafts two ways — the resume-edit banner, answered "Simpan draf", and a build that
  saves an abandoned edit by itself — and 1.35.0's way of throwing one away ("Edit", BACK, "Buang") was
  measured never to see "Buang" on the moto. Deleting a draft is PERMANENT.

  Every id, label and bound named below was transcribed from a uiautomator dump of the owner's moto g06
  (Android 15, TikTok id-ID, 720x1640) on 2026-09-15. The English labels are guesses and say so. NOT measured:
  what tapping "Hapus" raises, what a profile or a folder with no drafts shows, and any Samsung build.
*/

/** The own profile's drafts entry: `tv_draft` "Draf: 2" at [11,557][227,585] — a text, not clickable itself; its clickable parent is unknown, so its centre is tapped. */
const DRAFTS_ENTRY_ID = 'tv_draft'
/** "Draf: 2" is measured; "Drafts: 2" is the English spelling, UNMEASURED. */
const DRAFTS_ENTRY_TEXT = /^\s*draf(?:ts?)?\s*:\s*(\d+)\s*$/i
/** The Drafts folder's header, `gf0` "2 draf" (measured); "2 drafts" is UNMEASURED. */
const DRAFTS_FOLDER_COUNT_TEXT = /^\s*(\d+)\s+draf(?:ts?)?\s*$/i
/** The folder's "Pilih" at [623,70][706,161], text and desc, clickable. "Select" is UNMEASURED. */
const DRAFTS_SELECT_LABELS = ['Pilih', 'Select']
/** Select mode's "Pilih semua" at [14,70][190,161]. "Select all" is UNMEASURED. */
const DRAFTS_SELECT_ALL_LABELS = ['Pilih semua', 'Select all']
/** Select mode's "Batalkan" at [566,70][706,161]. "Cancel" is UNMEASURED. */
const DRAFTS_CANCEL_LABELS = ['Batalkan', 'Cancel']
/** Select mode's delete bar, `cu1` "Hapus" at [28,1465][692,1556]. "Delete" is UNMEASURED. */
const DRAFTS_DELETE_ID = 'cu1'
const DRAFTS_DELETE_LABELS = ['Hapus', 'Delete']
/** Each draft cell's select circle, `gec`, desc "@2131827210" — an unresolved resource name. The tree carries no selected state, so a tick cannot be read from it. */
const DRAFTS_SELECT_CIRCLE_ID = 'gec'
/** The refusal that marks a confirmation dialog. Used only to RECOGNISE the dialog — `clearDrafts` never taps it. UNMEASURED. */
const DIALOG_CANCEL_LABELS = ['Batalkan', 'Batal', 'Cancel']
/** The folder's own buttons sit in its title bar: the top fifth of the frame (measured bottom 161 of 1640). */
const DRAFTS_TOP_BAR_FRACTION = 0.2

const DRAFTS_ENTRY_WAIT_MS = 8_000
const DRAFTS_SCREEN_WAIT_MS = 8_000
/** How long a confirmation gets to appear after "Hapus". */
const DRAFTS_CONFIRM_WAIT_MS = 4_000
const DRAFTS_GONE_WAIT_MS = 10_000
const DRAFTS_PROFILE_CHECK_MS = 6_000

const DRAFTS_BY_HAND =
  'Nothing was posted. On the phone, open TikTok → Profil → "Draf", tap "Pilih" → "Pilih semua" → "Hapus" to delete the drafts by hand (or turn off "Clear drafts first"), then re-run.'

function nodeLabel(n: UiNode): string {
  return (n.text || n.desc).trim()
}

function sameBounds(a: Bounds, b: Bounds): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom
}

/** A clickable, on-screen node that is not a text field, whose text or desc is exactly one of `labels`. */
function buttonLabelled(n: UiNode, frameWidth: number, labels: string[]): boolean {
  return n.clickable && !isEditableNode(n) && insideFrame(n, frameWidth) && (labelIs(n.text, labels) || labelIs(n.desc, labels))
}

/** The own profile's drafts entry on screen, with the count it reads (`null` when its words cannot be read); null when there is no entry. */
export function draftsEntry(tree: UiNode, frameWidth: number): { node: UiNode; count: number | null } | null {
  const hits = all(tree, (n) => !isEditableNode(n) && insideFrame(n, frameWidth) && (hasShortId(n, DRAFTS_ENTRY_ID) || DRAFTS_ENTRY_TEXT.test(nodeLabel(n))))
  const node = hits.find((n) => DRAFTS_ENTRY_TEXT.test(nodeLabel(n))) ?? hits[0]
  if (!node) return null
  const m = nodeLabel(node).match(DRAFTS_ENTRY_TEXT)
  return { node, count: m ? Number(m[1]) : null }
}

/** What the profile's drafts entry counts, or null when no readable entry is on screen. */
export function draftCount(tree: UiNode, frameWidth: number): number | null {
  return draftsEntry(tree, frameWidth)?.count ?? null
}

/** What the Drafts folder's header counts ("2 draf"), or null when no such header is on screen. */
export function draftsFolderCount(tree: UiNode, frameWidth: number): number | null {
  const node = all(tree, (n) => !isEditableNode(n) && insideFrame(n, frameWidth) && DRAFTS_FOLDER_COUNT_TEXT.test(nodeLabel(n)))[0]
  const m = node ? nodeLabel(node).match(DRAFTS_FOLDER_COUNT_TEXT) : null
  return m ? Number(m[1]) : null
}

export interface DraftsControls {
  select: UiNode | null
  selectAll: UiNode | null
  cancel: UiNode | null
  delete: UiNode | null
  circles: UiNode[]
}

/**
 * The Drafts folder's controls on screen. Title-bar buttons match their EXACT label in the top fifth of the
 * frame, so "Pilih semua" is never read as "Pilih"; the delete bar is in the lower half, `cu1` first.
 */
export function draftsFolderControls(tree: UiNode, frame: { width: number; height: number }): DraftsControls {
  const topBar = (labels: string[]): UiNode | null =>
    all(tree, (n) => buttonLabelled(n, frame.width, labels) && n.bounds.bottom <= frame.height * DRAFTS_TOP_BAR_FRACTION)[0] ?? null
  const deletes = all(
    tree,
    (n) =>
      n.clickable &&
      !isEditableNode(n) &&
      insideFrame(n, frame.width) &&
      n.bounds.top >= frame.height * 0.5 &&
      (labelIs(nodeLabel(n), DRAFTS_DELETE_LABELS) || (hasShortId(n, DRAFTS_DELETE_ID) && DRAFTS_DELETE_LABELS.some((l) => labelMatches(nodeLabel(n), l)))),
  )
  return {
    select: topBar(DRAFTS_SELECT_LABELS),
    selectAll: topBar(DRAFTS_SELECT_ALL_LABELS),
    cancel: topBar(DRAFTS_CANCEL_LABELS),
    delete: deletes.find((n) => hasShortId(n, DRAFTS_DELETE_ID)) ?? deletes[0] ?? null,
    circles: all(tree, (n) => hasShortId(n, DRAFTS_SELECT_CIRCLE_ID) && insideFrame(n, frame.width)),
  }
}

/** Select mode: "Pilih semua" and "Batalkan" both in the title bar. */
export function selectModeShowing(tree: UiNode, frame: { width: number; height: number }): boolean {
  const c = draftsFolderControls(tree, frame)
  return c.selectAll !== null && c.cancel !== null
}

/** The Drafts folder: its "N draf" header, its "Pilih" button, or select mode. */
export function draftsFolderShowing(tree: UiNode, frame: { width: number; height: number }): boolean {
  return draftsFolderCount(tree, frame.width) !== null || draftsFolderControls(tree, frame).select !== null || selectModeShowing(tree, frame)
}

/**
 * What refuses the drafts confirmation (1.42.0). The dialog measured on the owner's Samsung SM-A075F (720x1600,
 * TikTok id-ID, production run #17, 2026-09-15) asks "Hapus 1 draf?" with "Hapus" beside "Pertahankan" — keep, not
 * a cancel. Only the cancel words counted before, so that dialog, on screen, read as no confirmation at all and the
 * drafts stayed. The refusal is only ever the evidence that this is a dialog; it is never tapped.
 */
const DRAFTS_CONFIRM_REFUSAL_LABELS = [...DIALOG_CANCEL_LABELS, 'Pertahankan', 'Keep']

/**
 * The confirmation's own delete button after "Hapus" was tapped, or null. Only the one shape a confirmation can
 * safely be recognised by counts: a clickable button whose label is EXACTLY "Hapus"/"Delete", that is not the
 * select mode's own delete bar (`cu1`, or any bounds in `exclude`), sharing a container smaller than the screen
 * with a refusal ("Pertahankan"/"Keep" — measured on #17 — or "Batalkan"/"Batal"/"Cancel", again none in
 * `exclude`). The refusal is never returned.
 */
export function confirmDeleteButton(tree: UiNode, frame: { width: number; height: number }, exclude: Bounds[] = []): UiNode | null {
  const excluded = (n: UiNode): boolean => exclude.some((b) => sameBounds(b, n.bounds))
  const isConfirm = (n: UiNode): boolean => buttonLabelled(n, frame.width, DRAFTS_DELETE_LABELS) && !hasShortId(n, DRAFTS_DELETE_ID) && !excluded(n)
  const isRefusal = (n: UiNode): boolean => buttonLabelled(n, frame.width, DRAFTS_CONFIRM_REFUSAL_LABELS) && !excluded(n)
  const screenArea = frame.width * frame.height
  // Deepest container first, so the answer comes from the smallest box holding both buttons.
  const visit = (n: UiNode): UiNode | null => {
    for (const c of n.children) {
      const hit = visit(c)
      if (hit) return hit
    }
    const inside = flatten(n).slice(1)
    const confirm = inside.find(isConfirm)
    if (!confirm || !inside.some(isRefusal)) return null
    const area = boxArea(n)
    return area > 0 && area < screenArea * 0.9 ? confirm : null
  }
  return visit(tree)
}

function profileShowing(tree: UiNode, frameWidth: number): boolean {
  return descNodeOnScreen(tree, [descOf(MENU_PROFIL), 'Profile menu'], frameWidth) !== null
}

/** Dumps about once a second until `read` answers something other than null, or `timeoutMs` passes. A failed dump is a miss, not an answer. */
async function pollTree<T>(ctx: ScriptContext<unknown>, timeoutMs: number, read: (tree: UiNode) => T | null): Promise<{ value: T | null; tree: UiNode | null }> {
  const deadline = Date.now() + timeoutMs
  let last: UiNode | null = null
  for (;;) {
    try {
      const tree = await ctx.device.dump()
      last = tree
      const value = read(tree)
      if (value !== null) return { value, tree }
    } catch {
      // Go round again.
    }
    if (Date.now() >= deadline) return { value: null, tree: last }
    await sleep(1_000)
  }
}

/**
 * Backs out of the Drafts folder without deleting anything: "Batalkan" while select mode is up (and no dialog
 * is), BACK otherwise, at most three steps, stopping once the profile or the bottom nav is back and the folder
 * is not. Never taps "Hapus". Never throws.
 */
async function leaveDraftsFolder(ctx: ScriptContext<unknown>, frame: { width: number; height: number }): Promise<void> {
  try {
    for (let step = 0; step < 3; step++) {
      const tree = await ctx.device.dump().catch(() => null)
      if (tree && (profileShowing(tree, frame.width) || feedNavOnScreen(tree, frame.width)) && !draftsFolderShowing(tree, frame)) return
      const cancel = tree && selectModeShowing(tree, frame) && !confirmDeleteButton(tree, frame) ? draftsFolderControls(tree, frame).cancel : null
      if (cancel) await ctx.device.tap({ point: centreOf(cancel) })
      else await ctx.device.key('BACK')
      await sleep(1_200)
    }
  } catch (err) {
    ctx.log.warn('could not back out of the Drafts folder', { error: String(err) })
  }
}

export interface DraftsCleared {
  /** How many drafts the account had; 0 when there were none, null when a count could not be read. */
  found: number | null
  /** How many were deleted — always 0 in a dry run. */
  removed: number | null
  dryRun: boolean
}

function draftsPhrase(count: number | null): string {
  return count === null ? 'the drafts (count unreadable)' : `${count} draft${count === 1 ? '' : 's'}`
}

/**
 * Deletes every TikTok draft on this account before anything is posted (1.36.0) — the owner's decision, and
 * permanent. Own profile → "Draf: N" → the Drafts folder → "Pilih" → "Pilih semua" → "Hapus" → the
 * confirmation's own "Hapus" (never "Batalkan"/"Batal") → back on the profile with no drafts left, or the
 * folder reading 0.
 *
 * A dry run stops after "Pilih": it proves the controls, backs out with "Batalkan" and BACK, and reports the
 * count it would delete. It never taps "Hapus".
 *
 * Anything not recognised backs out and stops the run with `E_DRAFTS_NOT_CLEARED`, saving the tree and a
 * screenshot, before anything is posted. A profile that shows no drafts entry at all is taken as no drafts —
 * what a profile with none shows is not measured, so that reading is logged as such.
 */
async function clearDrafts(ctx: ScriptContext<unknown>, opts: { frame: { width: number; height: number }; dryRun: boolean }): Promise<DraftsCleared> {
  const { frame, dryRun } = opts
  const fail = async (label: string, why: string, tree?: UiNode | null, leave = true): Promise<never> => {
    await capture(ctx, `drafts-${label}`, tree)
    if (leave) await leaveDraftsFolder(ctx, frame)
    throw Object.assign(new Error(`The account's TikTok drafts could not be cleared before posting: ${why} ${DRAFTS_BY_HAND}`), { code: 'E_DRAFTS_NOT_CLEARED' })
  }

  const menu = await openOwnProfile(ctx, frame.width)
  if (!menu) return fail('profile-not-open', 'the own profile could not be opened to look for drafts.', null, false)
  try {
    recordCleared((await sweepModals(ctx, UPLOAD_MODAL_POLICIES)).cleared)
  } catch (err) {
    if ((err as { code?: string }).code === 'E_SECURITY_CHECK') throw err
    ctx.log.warn('the profile could not be swept for modals before looking for drafts — looking anyway', { error: String(err) })
  }

  // The entry, or a profile whose own content (a grid cell, or its empty state) has drawn twice without one.
  let loadedReads = 0
  const looked = await pollTree(ctx, DRAFTS_ENTRY_WAIT_MS, (tree): { entry: { node: UiNode; count: number | null } | null } | null => {
    const entry = draftsEntry(tree, frame.width)
    if (entry) return { entry }
    const belowY = (descNodeOnScreen(tree, [descOf(MENU_PROFIL), 'Profile menu'], frame.width) ?? menu).bounds.bottom
    if (readGrid(tree, belowY, frame.width).length > 0 || gridEmptyState(tree, belowY, frame.width)) loadedReads += 1
    return loadedReads >= 2 ? { entry: null } : null
  })
  const entry = looked.value?.entry ?? null
  if (!entry) {
    if (looked.value) {
      ctx.log.info('the own profile shows no drafts entry — no drafts to clear')
    } else {
      await capture(ctx, 'drafts-entry-unseen', looked.tree)
      ctx.log.warn(`no drafts entry appeared on the own profile within ${DRAFTS_ENTRY_WAIT_MS / 1000}s — taking it as no drafts (what a profile with no drafts shows has not been measured)`)
    }
    return { found: 0, removed: 0, dryRun }
  }
  if (entry.count === 0) {
    ctx.log.info('the own profile shows 0 drafts — nothing to clear')
    return { found: 0, removed: 0, dryRun }
  }
  ctx.log.info(`the own profile shows ${draftsPhrase(entry.count)} — opening the Drafts folder`)
  await ctx.device.tap({ point: centreOf(entry.node) })

  const folder = await pollTree(ctx, DRAFTS_SCREEN_WAIT_MS, (tree) => (draftsFolderShowing(tree, frame) ? tree : null))
  if (!folder.value) return fail('folder-not-open', `"${nodeLabel(entry.node)}" was tapped on the profile, but the Drafts folder ("N draf" or "Pilih") did not open within ${DRAFTS_SCREEN_WAIT_MS / 1000}s.`, folder.tree)
  const selectRead = await pollTree(ctx, DRAFTS_SCREEN_WAIT_MS, (tree) => {
    const select = draftsFolderControls(tree, frame).select
    return select ? { select, tree } : null
  })
  if (!selectRead.value) return fail('select-missing', 'the Drafts folder opened, but its "Pilih" button was not found.', selectRead.tree)
  const count = draftsFolderCount(selectRead.value.tree, frame.width) ?? draftsFolderCount(folder.value, frame.width) ?? entry.count
  const drafts = draftsPhrase(count)
  if (count === 0) {
    ctx.log.info('the Drafts folder reads 0 drafts — nothing to clear')
    await leaveDraftsFolder(ctx, frame)
    return { found: 0, removed: 0, dryRun }
  }

  await ctx.device.tap({ point: centreOf(selectRead.value.select) })
  const mode = await pollTree(ctx, DRAFTS_SCREEN_WAIT_MS, (tree) => (selectModeShowing(tree, frame) ? tree : null))
  if (!mode.value) return fail('select-mode-not-open', '"Pilih" was tapped, but select mode ("Pilih semua" and "Batalkan") did not appear.', mode.tree)
  const modeControls = draftsFolderControls(mode.value, frame)

  if (dryRun) {
    await leaveDraftsFolder(ctx, frame)
    ctx.log.info(`dry run: would delete ${drafts} — opened the Drafts folder and its select mode, then backed out with "Batalkan" without deleting anything`)
    return { found: count, removed: 0, dryRun }
  }

  const selectAll = modeControls.selectAll
  if (!selectAll) return fail('select-all-missing', 'select mode opened, but "Pilih semua" was not found.', mode.value)
  const circlesBefore = modeControls.circles.map((c) => c.desc)
  await ctx.device.tap({ point: centreOf(selectAll) })
  await sleep(1_000)

  // The tree has no selected state. What CAN be read: "Hapus" is there and enabled after "Pilih semua".
  const armed = await pollTree(ctx, 4_000, (tree) => {
    const controls = draftsFolderControls(tree, frame)
    return controls.delete && controls.delete.enabled ? { controls, deleteButton: controls.delete } : null
  })
  if (!armed.value) {
    const missing = !armed.tree || draftsFolderControls(armed.tree, frame).delete === null
    return fail(
      missing ? 'delete-missing' : 'nothing-selected',
      missing ? '"Pilih semua" was tapped, but the "Hapus" button was not found.' : '"Pilih semua" was tapped, but "Hapus" stayed disabled, so nothing reads as selected.',
      armed.tree,
    )
  }
  const { controls, deleteButton } = armed.value
  const circlesAfter = controls.circles.map((c) => c.desc)
  if (circlesAfter.length > 0 && circlesAfter.some((d, i) => d !== circlesBefore[i])) {
    ctx.log.info('the select circles changed after "Pilih semua"', { before: circlesBefore.join(' | '), after: circlesAfter.join(' | ') })
  } else {
    ctx.log.info('whether each draft is ticked cannot be read from the tree — proceeding on the "Pilih semua" tap', { circles: circlesAfter.length })
  }

  // The screen's own buttons, so the confirmation is never mistaken for them.
  const exclude = [deleteButton.bounds, ...[controls.cancel, controls.selectAll].flatMap((n) => (n ? [n.bounds] : []))]
  ctx.log.warn(`deleting ${drafts} from this account before posting — permanent, as the owner decided`)
  await ctx.device.tap({ point: centreOf(deleteButton) })

  const asked = await pollTree(ctx, DRAFTS_CONFIRM_WAIT_MS, (tree): UiNode | 'gone' | null =>
    confirmDeleteButton(tree, frame, exclude) ?? (draftsFolderCount(tree, frame.width) === 0 ? 'gone' : null),
  )
  let confirmed = false
  if (asked.value !== null && asked.value !== 'gone') {
    await ctx.device.tap({ point: centreOf(asked.value) })
    confirmed = true
    ctx.log.info(`confirmed the deletion with "${nodeLabel(asked.value)}"`)
  } else if (asked.value === null) {
    // Evidence for the one step no dump has shown yet.
    await capture(ctx, 'drafts-no-confirmation', asked.tree)
    ctx.log.warn(`no confirmation was recognised within ${DRAFTS_CONFIRM_WAIT_MS / 1000}s of "Hapus" — checking whether the drafts are gone`)
  }

  const gone = await pollTree(ctx, DRAFTS_GONE_WAIT_MS, (tree): 'folder-empty' | 'left-folder' | null => {
    if (confirmDeleteButton(tree, frame, exclude)) return null
    if (draftsFolderCount(tree, frame.width) === 0) return 'folder-empty'
    return draftsFolderShowing(tree, frame) ? null : 'left-folder'
  })
  const tapped = `"Hapus" was tapped${confirmed ? ' and confirmed' : ' (no confirmation was recognised)'}`
  if (!gone.value) {
    const left = gone.tree ? draftsFolderCount(gone.tree, frame.width) : null
    return fail('not-deleted', `${tapped}, but the Drafts folder still showed ${left === null ? 'its drafts' : draftsPhrase(left)} after ${DRAFTS_GONE_WAIT_MS / 1000}s.`, gone.tree)
  }

  await leaveDraftsFolder(ctx, frame)
  const seen: { count: number | null } = { count: null }
  let absentReads = 0
  const back = await pollTree(ctx, DRAFTS_PROFILE_CHECK_MS, (tree): 'clear' | null => {
    if (!profileShowing(tree, frame.width) || draftsFolderShowing(tree, frame)) return null
    const onProfile = draftsEntry(tree, frame.width)
    if (!onProfile) {
      absentReads += 1
      return absentReads >= 2 ? 'clear' : null
    }
    seen.count = onProfile.count
    return onProfile.count === 0 ? 'clear' : null
  })
  if (!back.value) {
    if (seen.count !== null && seen.count > 0) {
      return fail('still-on-profile', `${tapped} and the Drafts folder ${gone.value === 'folder-empty' ? 'read 0 drafts' : 'closed'}, but the own profile still shows "Draf: ${seen.count}".`, back.tree)
    }
    if (gone.value !== 'folder-empty') {
      return fail('unconfirmed', `${tapped} and the Drafts folder closed, but the own profile could not be read afterwards to prove the drafts are gone.`, back.tree)
    }
    ctx.log.warn('the Drafts folder read 0 drafts, but the own profile could not be read afterwards — carrying on, the folder is the evidence')
  }
  ctx.log.info(`deleted ${drafts} from this account before posting`, { confirmed })
  return { found: count, removed: count, dryRun }
}

/** True when TikTok's security-check sheet is on screen (`tt.security-check` in the register). */
async function securityCheckShowing(ctx: ScriptContext<unknown>): Promise<boolean> {
  try {
    return matchModals(await ctx.device.dump()).some((e) => e.id === 'tt.security-check')
  } catch {
    return false
  }
}

const SECURITY_CHECK_DETAIL =
  'TikTok raised its security check on this account ("pemeriksaan keamanan") after Post was tapped. The run did not touch it — completing it is the account owner\'s job, on the phone. Whether the post landed cannot be read until it is done, so check the profile before re-sending.'

/** How long `confirmPosted` keeps looking at the profile after Post, at least (1.41.0). */
const CONFIRM_MIN_MS = 3 * 60_000
/** …and while the newest cell still reads an upload percentage (1.41.0). */
const CONFIRM_UPLOADING_MS = 5 * 60_000
/**
 * How the looks after the first one vary (1.42.0): jittered 4–10 s gaps (the fixed 5 s before), a trip Home and
 * back to Profil about 40% of the time, and a pull to refresh on every other look — half the Home trips pull too,
 * since a profile re-opened from Home is already redrawn (1.34.0).
 */
export const CONFIRM_PLAN: ConfirmPlan = { waitMs: [4_000, 10_000], homeChance: 0.4, pullAfterHome: 0.5 }

/**
 * The confirmation §3.6 exists for (step 113.6, §9 Q1's recommendation): after Post is tapped, open
 * the account's own profile and read the NEWEST grid cell, with a bounded wait (upload/publish is
 * not instant — E1 measured the media SCAN alone at ~1.6s, and TikTok's own remote publish step is
 * slower still).
 *
 * `PROFIL_TAB`/`MENU_PROFIL` are the two confirmed-unique selectors `sheet.ts` already verified for
 * this exact navigation (its own header: "safe to find/waitFor directly").
 *
 * This used to accept ANY grid-shaped cell as proof, and its own comment said a hardware run would
 * "either prove this right or give the next reader a real dump to replace it with". The run came on
 * 2026-09-11 and proved it wrong: on an account that already had six videos, with the upload stuck
 * at 4%, the grid was full of cells that existed before the run began, and the run reported
 * `posted`. `readNewestCell` replaced it — what the newest cell SAYS, `0` views meaning live — and
 * the same day showed that was not enough either: the account's previous post was itself still at 0
 * views. So the grid is now read BEFORE the walk too, and `judgeGrid` asks for the one change only a
 * new post makes: every earlier cell pushed one place along. TikTok's security check
 * (`tt.security-check`) is reported by name rather than as an unreadable grid. A run that cannot
 * confirm still reports `unverified`, never `posted`.
 */
async function confirmPosted(
  ctx: ScriptContext<unknown>,
  frame: { width: number; height: number },
  before: string[] | null,
): Promise<{ confirmed: boolean; detail: string; securityCheck: boolean }> {
  const attempts = 6
  /*
    Time, not only a count (1.41.0). The owner watched production phones (2026-09-15): the new video appears on
    the profile only once its upload has finished, which on a slow phone is minutes after Post, and a run that
    stopped looking before then closed TikTok and said "unverified". So at least `CONFIRM_MIN_MS` of looks, and
    `CONFIRM_UPLOADING_MS` while the newest cell still reads an upload percentage.
  */
  const startedAt = Date.now()
  /*
    A real refresh, at a person's rhythm (1.42.0). The owner asked (2026-09-15) for the looks after Post to stop
    being one mechanical loop: each round after the first is planned by `planConfirmStep` — a pull to refresh on the
    profile already open, or a trip Home and back to Profil — after a jittered wait. Neither move force-stops or
    relaunches TikTok, which could kill an upload in flight.
  */
  const rng = makeRng((Date.now() ^ Number(ctx.job.attempt)) >>> 0)
  const moves: ConfirmMove[] = []
  let step: ConfirmStep | null = null

  let lastSeen: NewestCell = { kind: 'none' }
  const keepLooking = (round: number): boolean =>
    round < attempts || Date.now() - startedAt < (lastSeen.kind === 'uploading' ? CONFIRM_UPLOADING_MS : CONFIRM_MIN_MS)
  for (let round = 0; keepLooking(round); round++) {
    // Checked before the sweep, so the security check is reported by name and screenshotted here.
    if (await securityCheckShowing(ctx)) {
      await capture(ctx, 'security-check')
      return { confirmed: false, detail: SECURITY_CHECK_DETAIL, securityCheck: true }
    }
    try {
      await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    } catch (err) {
      if ((err as { code?: string }).code === 'E_SECURITY_CHECK') return { confirmed: false, detail: SECURITY_CHECK_DETAIL, securityCheck: true }
      ctx.log.warn('confirmPosted: modal sweep did not settle this attempt', { round, error: String(err) })
    }
    // Never re-reads a stale page (1.34.0): tapping Profil on a profile that is already open can leave the grid
    // exactly as the previous round read it. So a later round either goes Home and back, or stays and pulls the
    // profile to refresh it (1.42.0). Not a relaunch — force-stopping TikTok could kill an upload in flight.
    const after = await readOwnGrid(
      ctx,
      frame,
      step === null
        ? {}
        : step.move === 'home'
          ? { reopen: true, lingerMs: step.lingerMs, pull: step.pull ? rng : undefined }
          : { stay: true, pull: rng },
    )
    if (after !== null) {
      const judged = judgeGrid(before, after)
      if (judged.kind === 'new') {
        return {
          confirmed: true,
          detail: 'a new cell appeared at the head of the own-profile grid, pushing every earlier video one place along',
          securityCheck: false,
        }
      }
      lastSeen = judged
      // With no baseline no later reading can prove anything; an upload still in flight is the one reading worth waiting on.
      if (judged.kind === 'no-baseline') break
      ctx.log.warn(`confirmPosted: the grid does not show this post yet (attempt ${round + 1})`, { judged: JSON.stringify(judged) })
    }
    if (keepLooking(round + 1)) {
      step = planConfirmStep(rng, moves, CONFIRM_PLAN)
      moves.push(step.move)
      ctx.log.info(`confirmPosted: next look in ${Math.round(step.waitMs / 1000)}s — ${step.move === 'home' ? 'via Home' : 'on the open profile'}${step.pull ? ', pulled to refresh' : ''}`)
      await sleep(step.waitMs)
    }
  }

  await capture(ctx, 'unverified')
  const waited = Math.round((Date.now() - startedAt) / 1000)
  const saw =
    lastSeen.kind === 'uploading'
      ? `it was still uploading (${lastSeen.percent}) — submitted, not yet live. A phone whose network cannot carry the upload stays here.`
      : lastSeen.kind === 'same'
        ? 'the profile grid was exactly as it was before Post was tapped, so this post had not appeared.'
        : lastSeen.kind === 'old'
          ? `the newest video on the profile was an older one (${lastSeen.views} views), so this post had not appeared.`
          : lastSeen.kind === 'no-baseline'
            ? `the newest video on the profile shows ${lastSeen.views} views${lastSeen.views === '0' ? ', which may be this post' : ''}, but the grid could not be read (or was empty) before Post was tapped, so there is nothing to compare it against.`
            : 'no readable video grid was found.'
  return {
    confirmed: false,
    detail: `Post was tapped, but after ${waited}s ${saw} Reporting "unverified" rather than assuming the tap succeeded (§3.6).`,
    securityCheck: false,
  }
}

/**
 * Reads the post screen after a step that sends keystrokes or taps at it, and says plainly when it is
 * gone (1.34.0). A known other screen is `E_LEFT_POST_SCREEN` — kept from 1.31.0. `unknown` is no longer
 * waved through: a dialog, or TikTok's tag-suggestion list standing in for the post screen, gets a
 * modal sweep and another read, and after three reads with no post screen the run stops with
 * `E_POST_SCREEN_UNREADABLE`. Everything here happens BEFORE Post, so nothing was posted.
 */
async function readPostScreen(ctx: ScriptContext<unknown>, step: string): Promise<UiNode> {
  for (let round = 0; round < 3; round++) {
    if (round > 0) await sleep(1_000)
    let tree: UiNode
    try {
      tree = await ctx.device.dump()
    } catch (err) {
      ctx.log.warn(`after ${step} the screen could not be dumped — reading again`, { round, error: String(err) })
      continue
    }
    const screen = detectScreen(tree)
    if (screen === 'post') return tree
    if (screen !== 'unknown') {
      await capture(ctx, 'left-post-screen', tree)
      throw Object.assign(new Error(`${step} left the post screen (TikTok is now on "${screen}") — nothing was posted`), { code: 'E_LEFT_POST_SCREEN' })
    }
    ctx.log.warn(`after ${step} the screen reads "unknown" — sweeping modals and reading again`, { round })
    const swept = await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    recordCleared(swept.cleared)
  }
  await capture(ctx, 'post-screen-unreadable')
  throw Object.assign(
    new Error(`after ${step} the post screen could not be read three times running (no caption field in the tree) — Post was not tapped, so nothing was posted. See the post-screen-unreadable screenshot.`),
    { code: 'E_POST_SCREEN_UNREADABLE' },
  )
}

/**
 * How many code points one `type` call carries (1.35.0). The guest agent's IME types one code point at a
 * time, 40–140 ms apart, and the drivers gave the whole call a flat 15 s — about 160 characters. Two
 * production captions (200 and 306 characters, bundles 04fe3367 and 4063f322, Samsung SM-A075F) failed
 * "guest agent did not respond within 15000ms" while the phone went on typing. Sixty code points is at
 * most 8.4 s at the slowest delay, inside that budget even on a core that predates the drivers' fix.
 */
const CAPTION_PIECE_CODE_POINTS = 60

/**
 * `caption` cut into pieces of at most `max` code points that join back to exactly `caption` (1.35.0).
 * A cut goes right AFTER a space where one fits, so every piece but the last ends a word: a `#tag` or
 * `@name` is never left open at the end of a piece, with TikTok's suggestion list up while the next call
 * starts. A cut never falls inside a grapheme — a surrogate pair, a skin-toned emoji or a ZWJ family stays
 * whole. A single word longer than `max` is cut between its graphemes.
 */
export function captionPieces(caption: string, max: number = CAPTION_PIECE_CODE_POINTS): string[] {
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(caption), (s) => s.segment)
  const size = (g: string): number => [...g].length
  const pieces: string[] = []
  let start = 0
  let length = 0
  for (let i = 0; i < graphemes.length; i++) {
    const g = graphemes[i] as string
    while (length + size(g) > max && i > start) {
      let cut = i
      for (let j = i - 1; j > start; j--) {
        if (/^\s+$/u.test(graphemes[j] as string)) {
          cut = j + 1
          break
        }
      }
      pieces.push(graphemes.slice(start, cut).join(''))
      start = cut
      length = graphemes.slice(start, i).reduce((sum, s) => sum + size(s), 0)
    }
    length += size(g)
  }
  if (start < graphemes.length) pieces.push(graphemes.slice(start).join(''))
  return pieces
}

/** Types the caption in pieces (`captionPieces`), then one space when it ends in `#tag`/`@name` — see the comment at the call site. Returns the typing rung that ran. */
async function typeCaption(ctx: ScriptContext<unknown>, caption: string): Promise<string> {
  // The field is read back once, after the last piece, by `enterCaption` — as before.
  const pieces = caption === '' ? [caption] : captionPieces(caption)
  let via = ''
  for (const piece of pieces) via = (await ctx.device.type(piece)).via
  if (pieces.length > 1) ctx.log.info('typed the caption in pieces', { pieces: pieces.length, codePoints: [...caption].length })
  if (endsInTagToken(caption)) {
    // A caption ending in `#tag` or `@name` leaves TikTok's suggestion list open, and that list
    // REPLACES the post screen — no Post button anywhere in the tree (observed 2026-09-11 with
    // "… #test": `E_ANCHOR_NOT_FOUND`, nothing posted). One space ends the token and closes the
    // list, which is what a person does; TikTok trims trailing whitespace from the caption.
    await ctx.device.type(' ')
    ctx.log.info('closed the tag suggestions with a trailing space')
  }
  return via
}

/**
 * Types the caption and PROVES it landed (1.34.0). Before this nothing read the field back, so a
 * caption the typing path mangled — a lost `#`, an app suggestion that swallowed a word, a character
 * the rung could not carry — was posted as it came out. The field is re-read and compared by
 * `captionLanded` (whitespace collapsed, `#` and `@` significant); on a mismatch it is cleared and
 * typed once more; a second mismatch is `E_CAPTION_MISMATCH` before Post. Returns the text that
 * actually landed, which is what the run's result reports.
 */
async function enterCaption(ctx: ScriptContext<unknown>, frame: { width: number; height: number }, field: UiNode, caption: string): Promise<string> {
  let target = field
  for (let round = 1; round <= 2; round++) {
    await ctx.device.tap({ point: centreOf(target) })
    await clearCaptionField(ctx, target)
    const via = await typeCaption(ctx, caption)
    ctx.log.info('typed the caption', { via, attempt: round, hashtags: (caption.match(/#[^\s#]+/g) ?? []).length })
    await sleep(800)
    // Clearing and typing are keystrokes, and a keystroke the field does not take goes to TikTok — which,
    // on the production fleet, backed out to the camera (1.31.0). `readPostScreen` says so by name.
    const tree = await readPostScreen(ctx, round === 1 ? 'typing the caption' : 'retyping the caption')
    const now = onScreenCaptionField(tree, frame.width)
    if (now && captionLanded(now, caption)) return captionTextToClear(now)
    const holds = now ? captionTextToClear(now) : '(no caption field on screen)'
    if (round === 2) {
      await capture(ctx, 'caption-mismatch', tree)
      throw Object.assign(
        new Error(
          `the caption field holds "${holds.slice(0, 120)}" but the caption to post is "${caption.slice(0, 120)}", after typing it twice (via ${via}) — Post was not tapped, so nothing was posted. A character the typing path cannot carry (an emoji, an accent) or an app suggestion that replaced a word is the usual cause; check the caption, then re-run.`,
        ),
        { code: 'E_CAPTION_MISMATCH' },
      )
    }
    ctx.log.warn('the caption field does not hold the caption that was typed — clearing it and typing once more', { holds: holds.slice(0, 80) })
    target = now ?? captionField(tree) ?? target
  }
  throw new Error('unreachable')
}

/**
 * The on-screen Post button, with nothing over it (1.34.0). When a keyboard is showing over Post, it
 * is put away first the way a person does it — a tap on plain page above the keys
 * (`keyboardDismissPoint`) — with BACK only as the fallback, and pressed only while a keyboard is
 * actually seen: with the keyboard up Android hands BACK to the keyboard, while on the bare post screen
 * BACK leaves it (2026-08-18). The caption is checked again afterwards, because a tap that missed plain
 * page could have changed it. Every failure here is before Post, so nothing was posted.
 */
async function postButtonClear(ctx: ScriptContext<unknown>, frame: { width: number; height: number }, caption: string): Promise<UiNode> {
  let tree = await readPostScreen(ctx, 'reaching the Post button')
  let post = postButtonOnScreen(tree, frame.width)
  if (post && postCoveredByKeyboard(tree, post, frame)) {
    const spot = keyboardDismissPoint(tree, frame)
    if (spot) {
      ctx.log.info('the keyboard is up over Post — tapping plain page above it, as a person would', spot)
      await sleep(400 + Math.round(Math.random() * 500))
      await ctx.device.tap({ point: spot })
      for (let i = 0; i < 3; i++) {
        await sleep(1_000)
        tree = await readPostScreen(ctx, 'tapping the page to put the keyboard away')
        if (!keyboardShowing(tree, frame)) break
      }
    }
    if (keyboardShowing(tree, frame)) {
      ctx.log.info(spot ? 'the keyboard stayed up after the tap — closing it with BACK' : 'no plain page above the keyboard — closing it with BACK')
      await ctx.device.key('BACK')
      await sleep(1_200)
      tree = await readPostScreen(ctx, 'closing the keyboard with BACK')
    }
    const field = onScreenCaptionField(tree, frame.width)
    if (!field || !captionLanded(field, caption)) {
      await capture(ctx, 'caption-mismatch', tree)
      throw Object.assign(
        new Error(`putting the keyboard away changed the caption field (it now holds "${(field ? captionTextToClear(field) : '(no caption field on screen)').slice(0, 120)}") — Post was not tapped, so nothing was posted`),
        { code: 'E_CAPTION_MISMATCH' },
      )
    }
    post = postButtonOnScreen(tree, frame.width)
    if (post && postCoveredByKeyboard(tree, post, frame)) {
      await capture(ctx, 'keyboard-over-post', tree)
      throw Object.assign(
        new Error('the keyboard would not close and still covers the Post button (tried a tap above it, then BACK) — Post was not tapped, so nothing was posted'),
        { code: 'E_KEYBOARD_OVER_POST' },
      )
    }
  }
  if (!post) {
    await capture(ctx, 'missing-post-button', tree)
    throw Object.assign(new Error(`the post screen's Post button is not on screen — Post was not tapped, so nothing was posted`), { code: 'E_ANCHOR_NOT_FOUND' })
  }
  return post
}

/** How long a Post tap gets to take the post screen away before it counts as not taken. */
const POST_TAP_SETTLE_MS = 8_000

/**
 * Did the Post tap take? (1.34.0.) `taken` — a readable screen that is no longer the post screen with
 * this caption. `still-there` — every read showed the post screen, this caption, and a Post button on
 * screen. `unreadable` — no read succeeded, so the tap's effect is unknown. Never throws: Post has been
 * pressed.
 */
async function watchPostTap(ctx: ScriptContext<unknown>, frameWidth: number, caption: string): Promise<'taken' | 'still-there' | 'unreadable'> {
  const deadline = Date.now() + POST_TAP_SETTLE_MS
  let sawPost = false
  for (;;) {
    await sleep(1_500)
    try {
      const tree = await ctx.device.dump()
      if (!postScreenStillShowing(tree, frameWidth, caption)) return 'taken'
      sawPost = true
    } catch (err) {
      ctx.log.warn('could not read the screen after the Post tap — trying again', { error: String(err) })
    }
    if (Date.now() >= deadline) break
  }
  return sawPost ? 'still-there' : 'unreadable'
}

/** How long a failed run waits for the caption to stop changing before it presses BACK (1.35.0). */
const TYPING_SETTLE_MS = 5_000

/**
 * Waits, bounded, until two reads in a row show the caption field holding the same number of code points
 * (1.35.0). A `type` call that timed out on the host does not stop the phone: the guest agent's IME goes
 * on committing the rest of the text (bundles 04fe3367 and 4063f322). BACK pressed into that sends the
 * remaining keys to whatever screen BACK opens. Returns at once when the screen reads as something other
 * than the post screen; a failed read is a miss, and the wait goes on to its deadline.
 */
async function waitForTypingToStop(ctx: ScriptContext<unknown>): Promise<void> {
  const deadline = Date.now() + TYPING_SETTLE_MS
  let previous: number | null = null
  for (;;) {
    try {
      const tree = await ctx.device.dump()
      const field = detectScreen(tree) === 'post' ? captionField(tree) : null
      if (!field) return
      const length = [...captionTextToClear(field)].length
      if (length === previous) return
      previous = length
    } catch {
      previous = null
    }
    if (Date.now() >= deadline) {
      ctx.log.warn(`the caption field was still changing after ${TYPING_SETTLE_MS / 1000}s — backing out anyway`)
      return
    }
    await sleep(700)
  }
}

/**
 * `finish`'s abandon walk (1.35.0): leave an unfinished post without keeping it. Returns true when
 * TikTok's security check was met, which is left on screen. Best effort — the caller force-stops TikTok
 * whatever happens here.
 *
 * Only when the run got past the camera screen, or TikTok reads as one of the later upload screens (a
 * fresh process after a timeout kill has no attempt state) — before that no unfinished post exists, and
 * BACK on the feed only sends TikTok to the background ahead of the force-stop. A caption still being
 * typed is let finish first (`waitForTypingToStop`). Then up to four BACK presses, each after a sweep:
 * the sweep taps "Buang" the moment the exit dialog is up (`ABANDON_MODAL_POLICIES`), and nothing the
 * register resolves can tap "Simpan draf" or "Draf" (`keepsDraft`). The walk ends at "Buang", or as soon
 * as the feed or profile is back.
 *
 * What each build does here is known only from the production bundles: the moto (E14) and the Samsung
 * build with ids like `upu` (04fe3367) raise "Buang" / "Simpan draf" on BACK from the editor, and "Buang"
 * lands on the picker; the Samsung build with ids like `oju` (4063f322) went from the editor straight to
 * the profile with no dialog, and on the moto (MEASURED 2026-09-15) BACK from the editor also returns to the feed
 * with no dialog, TikTok keeping the edit as a draft by itself. So a missing dialog is normal (1.36.0): the walk
 * never waits on one, never throws, and leaves whatever TikTok kept to the next run, which answers the resume-edit
 * banner "Simpan draf" and deletes every draft before posting (`clearDrafts`). A resume-edit banner met here is
 * left unanswered.
 */
async function backOutOfEditor(ctx: ScriptContext<unknown>): Promise<boolean> {
  let tree: UiNode | null = await ctx.device.dump().catch(() => null)
  const screen = tree ? detectScreen(tree) : 'unknown'
  const inUpload = screen === 'picker' || screen === 'preview' || screen === 'editor' || screen === 'post'
  if (!inUpload && !attempt.screens.includes('camera')) {
    ctx.log.info('the run failed before any unfinished post existed — not backing out', { screen })
    return false
  }
  if (screen === 'post') await waitForTypingToStop(ctx)

  for (let press = 0; press < 4; press++) {
    if (press > 0) tree = await ctx.device.dump().catch(() => null)
    if (tree && detectScreen(tree) === 'feed') {
      ctx.log.info(press === 0 ? 'TikTok is already on its feed or profile — nothing to back out of' : 'left the upload flow without an exit dialog — nothing to discard here', { presses: press })
      return false
    }
    try {
      const swept = await sweepModals(ctx, ABANDON_MODAL_POLICIES, { maxRounds: 2 })
      recordCleared(swept.cleared)
      if (swept.cleared.includes('tt.discard-draft')) {
        ctx.log.info('threw the unfinished post away with "Buang"', { presses: press })
        return false
      }
      if (swept.cleared.includes('tt.resume-edit')) {
        ctx.log.warn('TikTok offered to resume the unfinished post while backing out — left unanswered; the next run saves it as a draft and deletes it with the rest')
        return false
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'E_SECURITY_CHECK') return true
      ctx.log.warn('a modal could not be answered while backing out — stopping the walk; TikTok is force-stopped next', { error: String(err) })
      return false
    }
    await ctx.device.key('BACK')
    await sleep(900)
  }
  try {
    const last = await sweepModals(ctx, ABANDON_MODAL_POLICIES, { maxRounds: 2 })
    recordCleared(last.cleared)
    if (last.cleared.includes('tt.discard-draft')) ctx.log.info('threw the unfinished post away with "Buang"')
    else ctx.log.info('no exit dialog appeared while backing out — a build that shows none keeps the edit as a draft, which the next run deletes')
  } catch (err) {
    if ((err as { code?: string }).code === 'E_SECURITY_CHECK') return true
    ctx.log.warn('the last sweep while backing out did not settle — TikTok is force-stopped next', { error: String(err) })
  }
  return false
}

/**
 * §4.1, extended by plan 115 §3.7/§4.5 — still a flat schema with a `source` enum rather than a
 * discriminated union (§3.2: `planField` degrades a multi-branch union to a raw JSON textarea).
 * `folder` is now the default source (plan 115 §1 goal 5/§4.5, verbatim) — the owner's own manual
 * workflow, and the reason `videoFolder` returns after plan 113 §3.1 deleted it: that ruling was
 * about the WORKSPACE holding video bytes, which plan 115 still refuses (its own §3.1 note); this
 * field instead names a workspace FOLDER whose entries are read one at a time and minted into
 * artifacts (`folder.ts`'s `resolveVideoFromFolder`), never stored as video itself.
 */
const params = z.object({
  source: z
    .enum(['queue', 'folder', 'direct'])
    .default('folder')
    .describe('Where the video and caption come from.')
    .meta(ui({ title: 'Source', group: 'Source' })),

  // direct
  videoArtifactId: z
    .string()
    .optional()
    .describe('The uploaded video to post. Required when Source is "direct".')
    // `kind: 'artifact'` is the whole reason step 113.9 exists (gap G6): without it Studio renders
    // a bare text box and the operator pastes a UUID by hand, which is exactly the state that step
    // was built to end. The plan's own §4.1 code block omitted it — an error in the plan, corrected
    // here rather than copied forward.
    .meta(ui({ title: 'Video', kind: 'artifact', group: 'Direct' })),
  caption: z
    .string()
    .max(2_200)
    .optional()
    .describe('The caption to type. Required when Source is "direct".')
    .meta(ui({ title: 'Caption', group: 'Direct' })),

  // queue
  pick: z
    .enum(['in-order', 'random'])
    .default('in-order')
    .describe('Which queued item to claim.')
    .meta(ui({ title: 'Order', group: 'Queue' })),

  // folder (plan 115 §4.5, verbatim) — the two picks below are independent of each other and of
  // the queue's own `pick` above, on purpose (§3.7: "one shared pick would have conflated two
  // independent choices").
  videoFolder: z
    .string()
    .optional()
    .describe('A workspace folder of video files. Required when Source is "folder". Non-video files (including captions.txt) are ignored.')
    .meta(ui({ title: 'Video folder', kind: 'workspaceFolder', group: 'Folder' })),
  videoPick: z
    .enum(['random', 'in-order'])
    .default('random')
    .describe('Which video in the folder to pick. Random remembers what it already posted and prefers a video it has not (or least recently has).')
    .meta(ui({ title: 'Video order', group: 'Folder' })),
  captionPick: z
    .enum(['random', 'in-order'])
    .default('random')
    .describe('Which line of the captions file to use — independent of Video order.')
    .meta(ui({ title: 'Caption order', group: 'Folder' })),
  // Shared with the queue's own captions fallback (`resolveFromQueue`) — a queued item with no
  // caption of its own falls back to this file using `pick` above; folder mode always uses this
  // file, picked with `captionPick`.
  captionsFile: z
    .string()
    .optional()
    .describe('A workspace text file, one caption per line. Required when Source is "folder"; used as a fallback when a queued item carries no caption of its own.')
    .meta(ui({ title: 'Captions file', kind: 'workspaceFile', extensions: ['.txt'], group: 'Folder' })),

  privacy: z
    .enum(['leave', 'public', 'friends', 'private'])
    .default('leave')
    .describe("Leave the app's current setting, or state one explicitly.")
    .meta(ui({ title: 'Who can see it', group: 'Post' })),
  maxHashtags: z
    .number()
    .int()
    .min(0)
    .max(30)
    .default(5)
    .describe('At most this many hashtags are typed; extras in the caption are dropped. A policy cap set by the operator — the platform\'s own maximum is not read by this pack.')
    .meta(ui({ title: 'Max hashtags', kind: 'count', group: 'Post' })),

  dryRun: z
    .boolean()
    .default(false)
    .describe('Walk the whole flow and stop at the Post button without pressing it.')
    .meta(ui({ title: 'Dry run', group: 'Post' })),

  // 1.36.0, the owner's decision (2026-09-15) — see `clearDrafts`.
  clearDrafts: z
    .boolean()
    .default(true)
    .describe(
      'Before posting, delete ALL TikTok drafts on this account (Profil → Draf → Pilih semua → Hapus). Permanent: deleted drafts cannot be recovered. An unfinished post TikTok offers to resume is deleted with them. A dry run deletes nothing and reports how many it would delete.',
    )
    .meta(ui({ title: 'Clear drafts first', group: 'Post' })),
})

/** §4.1, verbatim — `outcome` is the four-state enum §3.6 needs, never a boolean. */
const result = z.object({
  outcome: z.enum(['posted', 'unverified', 'skipped', 'failed']).meta(ui({ title: 'Outcome', summary: true })),
  videoArtifactId: z.string().nullable(),
  caption: z.string().nullable(),
  queueKey: z.string().nullable().describe('The queue entry claimed, when Source was "queue".'),
  videoPath: z.string().nullable().describe('The workspace file picked, when Source was "folder".'),
  remotePath: z.string().nullable().describe('Where the video was left on the device — nothing removes it (G8).'),
  screens: z.array(z.string()).describe('The screens the run actually reached, in order.'),
  modalsHandled: z.array(z.string()).describe('Register entry ids that fired.'),
  reason: z.string().nullable().meta(ui({ title: 'Reason', summary: true })),
})

type Params = z.infer<typeof params>

interface AttemptState {
  videoArtifactId: string | null
  caption: string | null
  /**
   * The CLAIM, not just its key (plan 800). `settle` has to prove the claim is
   * still held — same `claimedBy`, same `claimedAt` — because re-reading the
   * version immediately before writing cannot detect that a stale claim was
   * reclaimed mid-run, and stomping the reclaiming device's write would be
   * silent. The key is still what the result reports; it is read off this.
   */
  queueClaim: TikTokQueueClaim | null
  remotePath: string | null
  screens: string[]
  modalsHandled: string[]
  /** Set only when `source === 'folder'` — the picked file's own content hash and workspace path,
   * carried from `resolveFromFolder` to the post-Post `recordVideoPosted` call (§3.8) the same way
   * the queue claim is carried to `settle` for the queue source. */
  folderVideo: { hash: string; path: string } | null
  /** Set when TikTok's security check was seen after Post: `finish` then leaves TikTok open on it instead of force-stopping. */
  leaveOnScreen: boolean
}

function freshAttemptState(): AttemptState {
  return { videoArtifactId: null, caption: null, queueClaim: null, remotePath: null, screens: [], modalsHandled: [], folderVideo: null, leaveOnScreen: false }
}

/**
 * Shared between `run()` and `finish()` WITHIN one process (module-level, like every other stateful
 * thing this runtime hands a script). Reset at the top of every `run()` call. A timeout kill restarts
 * the whole process (per `finish`'s own contract: it "ALWAYS runs — must be stateless and idempotent
 * ... after a timeout kill the core runs it again in a fresh process"), which loses this object —
 * `finish()` falls back to a minimal, still-honest partial result in that case (see its own comment),
 * and a claimed-but-orphaned queue entry is recovered later by `claimNext`'s own stale-claim reclaim
 * (queue.ts §3.3 — "no reaper... becomes a candidate again"), not by anything in this file.
 */
let attempt: AttemptState = freshAttemptState()

function recordCleared(cleared: string[]): void {
  for (const id of cleared) {
    if (!attempt.modalsHandled.includes(id)) attempt.modalsHandled.push(id)
  }
}

/** Atomically advances a farm-wide caption cursor for `path` and returns the NEXT 0-based index for `pickCaption` (§4.5: "the index is stored back ... so in-order means something across runs"). `QueueItemSchema` (already shipped, `.strict()`, no cursor field of its own — see the module comment on why this lives in its own key) has no room to carry this, so it lives under its own `storage.global` key rather than on the queue entry. `increment` is atomic (KvApi's own doc) and starts an unset key at 0, so the first call anywhere returns 1 → index 0. */
async function nextCaptionIndex(ctx: ScriptContext<unknown>, path: string): Promise<number> {
  const next = await ctx.storage.global.increment(captionCursorKey(path), 1)
  return next - 1
}

/**
 * A workspace path is not a legal KV key, and the first hardware `dryRun` of folder mode is what
 * proved it: `caption-cursor:/videos/captions.txt` was refused with *"contains a character outside
 * [A-Za-z0-9._:-] — no whitespace, no `/`"* (`packages/core/src/kv/store.ts`'s `KEY_PATTERN`), and
 * the run failed before it ever opened TikTok. The unit tests missed it because they cover
 * `pickCaption`, which is pure and never sees a key — the defect lived entirely in how the key was
 * spelled.
 *
 * The transform is a readable slug PLUS a hash of the original path, and it is both halves on
 * purpose. The slug alone would collide — `/a/b.txt` and `/a-b.txt` slugify identically and would
 * then silently share one cursor, so two different caption files would advance each other. A bare
 * hash alone would be collision-safe but opaque: an operator looking at the KV browser would see
 * `caption-cursor:8f3a1c07` and have no way to tell which file it belongs to. Together the key is
 * greppable by a human and unique to the path.
 *
 * FNV-1a, not a cryptographic digest: nothing here is a security boundary, and it stays synchronous
 * and dependency-free inside a job child.
 */
function captionCursorKey(path: string): string {
  const slug = path.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i += 1) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `caption-cursor:${slug}.${h.toString(16).padStart(8, '0')}`
}

async function resolveDirect(ctx: ScriptContext<Params>): Promise<{ artifactId: string; caption: string }> {
  const { videoArtifactId, caption } = ctx.params
  if (!videoArtifactId || videoArtifactId.trim() === '') {
    throw Object.assign(
      new Error('Source is "direct" but no video was chosen — pick a video artifact (Direct → Video) before running this member.'),
      { code: 'E_PARAMS_INVALID' },
    )
  }
  if (!caption || caption.trim() === '') {
    throw Object.assign(new Error('Source is "direct" but no caption was given — Direct mode requires a caption (Direct → Caption).'), { code: 'E_PARAMS_INVALID' })
  }
  return { artifactId: videoArtifactId, caption }
}

/**
 * `skipped: true` (never thrown — §3.6/goal 5, acceptance criterion 8: an empty queue is
 * `outcome: 'skipped'`, never a job failure) when `claimNext` found nothing pending or reclaimable.
 * Otherwise resolves the claimed item's caption: the entry's own caption wins when it has one (§9
 * Q6 — the entry is authoritative); the captions file is consulted ONLY when it is `null`.
 */
async function resolveFromQueue(ctx: ScriptContext<Params>): Promise<{ skipped: true } | { skipped: false; artifactId: string; caption: string }> {
  const claim = await tiktokQueue(ctx).claimNext({ pick: ctx.params.pick, claimedBy: ctx.job.deviceId })
  if (!claim) return { skipped: true }
  attempt.queueClaim = claim

  if (claim.item.payload.caption !== null) {
    return { skipped: false, artifactId: claim.item.id, caption: claim.item.payload.caption }
  }
  if (!ctx.params.captionsFile) {
    throw Object.assign(
      new Error(`queue entry "${claim.key}" has no caption of its own, and no Captions file was given (Queue → Captions file) to fall back to.`),
      { code: 'E_PARAMS_INVALID' },
    )
  }
  const source = await readCaptionsFile(ctx, ctx.params.captionsFile)
  const index = await nextCaptionIndex(ctx, ctx.params.captionsFile)
  const picked = pickCaption(source, ctx.params.pick, index)
  ctx.log.info('picked a caption from the captions file', { path: ctx.params.captionsFile, index, nextCursor: picked.nextCursor })
  return { skipped: false, artifactId: claim.item.id, caption: picked.caption }
}

/**
 * `source: 'folder'` — plan 115 §3.7/§4.5's own workflow, and the default. `folder.ts`'s
 * `resolveVideoFromFolder` does the whole list → filter → pick → read → mint chain (task instruction
 * 1, 2, 3); this function's own job is validating the two required parameters, always reading the
 * caption from `captionsFile` with `captionPick` (independent of `videoPick`, §3.7), and stashing the
 * picked file's hash/path on `attempt.folderVideo` so it can be recorded as posted once Post is
 * actually tapped (§3.8, mirrored below where `resolveFromQueue`'s `queueKey` is settled).
 *
 * Unlike `resolveFromQueue`, there is no `skipped` outcome here — an empty folder is `E_FOLDER_EMPTY`
 * (`resolveVideoFromFolder`'s own throw), a misconfiguration to fix rather than an ordinary "nothing
 * to do this time".
 */
async function resolveFromFolder(ctx: ScriptContext<Params>): Promise<{ artifactId: string; caption: string }> {
  const { videoFolder, videoPick, captionsFile, captionPick } = ctx.params
  if (!videoFolder || videoFolder.trim() === '') {
    throw Object.assign(
      new Error('Source is "folder" but no video folder was chosen — pick a workspace folder (Folder → Video folder) before running this member.'),
      { code: 'E_PARAMS_INVALID' },
    )
  }
  if (!captionsFile || captionsFile.trim() === '') {
    throw Object.assign(
      new Error('Source is "folder" but no captions file was given — Folder mode requires one (Folder → Captions file).'),
      { code: 'E_PARAMS_INVALID' },
    )
  }

  const video = await resolveVideoFromFolder(ctx, { folder: videoFolder, pick: videoPick })
  attempt.folderVideo = { hash: video.hash, path: video.path }
  ctx.log.info('picked a video from the folder', { folder: videoFolder, path: video.path, pick: videoPick })

  const source = await readCaptionsFile(ctx, captionsFile)
  const index = await nextCaptionIndex(ctx, captionsFile)
  const picked = pickCaption(source, captionPick, index)
  ctx.log.info('picked a caption from the captions file', { path: captionsFile, index, nextCursor: picked.nextCursor })

  return { artifactId: video.artifactId, caption: picked.caption }
}

const postVideo: PluginMemberScript<typeof params, typeof result> = {
  id: 'post-video',
  title: 'Post a video',
  description: `Pushes a video artifact to the device and drives TikTok's own upload flow to post it, sweeping every known blocking modal along the way.`,
  /** Plan 310 §3.3 — the script's own icon; `node.icon` (same value) stays as a fallback read for a core older than this plan. */
  icon: 'upload',
  node: { category: 'device', icon: 'upload', summary: [], keywords: ['post', 'upload', 'video'] },
  params,
  result,
  // Generous: six screens, up to four modal-sweep rounds each, and the confirmation's own bounded
  // wait (§9 Q1, up to ~30s) all add up — the same "slack for dialog sweeps, not for any one step
  // being slow" reasoning `switch-account.ts` states for its own budget.
  timeout: 10 * 60_000,

  async prepare(ctx) {
    attempt = freshAttemptState()
    /*
      `relaunch` — the pack's own launch, not a blind sleep.

      1.20.0 moved every navigating member off fixed settles after five runs
      were lost on the owner's farm, and recorded the measurement: TikTok on a
      budget phone is drawing its first feed at ten seconds, not done with it.
      This member kept `sleep(4_000)` and was missed — and it is the member
      that navigates most.

      **This is a consistency fix, not a proven repair.** It was made while
      chasing a failure that turned out to be the phone having no network at
      all, so no run has yet demonstrated it changing an outcome. It is still
      correct: four seconds was less than the six this pack already knew was
      too short, and waiting for the nav to exist is strictly better than
      hoping.

      E3 is not contradicted: the FEED is still never inspected, because an
      autoplaying video churns the tree. The bottom nav `relaunch` waits on is
      the stable chrome around it.
    */
    // A feed that never showed its nav is saved as it stood (1.34.1): the next anchor's failure is
    // usually minutes and several screens away, and by then what covered the feed is gone.
    if (!(await relaunch(ctx))) await capture(ctx, 'feed-not-ready')
  },

  async run(ctx) {
    if (ctx.params.privacy !== 'leave') {
      // Found, not built: `__fixtures__/screen-post.json` shows a real "Semua orang dapat melihat
      // posting ini" (audience) row — so the control genuinely exists — but the 2026-08-17 walk never
      // opened it, so nothing confirms what its Public/Friends/Private sub-screen looks like. Guessing
      // a selector there is exactly the fabrication this task forbids; refusing loudly is the honest
      // alternative until a hardware walk records the real one.
      throw Object.assign(
        new Error(
          `privacy "${ctx.params.privacy}" was requested, but no selector for the post screen's audience sub-menu has been confirmed on hardware — only "leave" (the app's current default) is supported today. Leave Who can see it on "leave" until a hardware walk records the real selectors.`,
        ),
        { code: 'E_PRIVACY_CONTROL_UNKNOWN' },
      )
    }

    let resolved: { artifactId: string; caption: string }
    if (ctx.params.source === 'direct') {
      resolved = await resolveDirect(ctx)
    } else if (ctx.params.source === 'folder') {
      resolved = await resolveFromFolder(ctx)
    } else {
      const queueResolved = await resolveFromQueue(ctx)
      if (queueResolved.skipped) {
        return {
          outcome: 'skipped',
          videoArtifactId: null,
          caption: null,
          queueKey: null,
          videoPath: null,
          remotePath: null,
          screens: [],
          modalsHandled: [],
          reason: 'the queue had no pending (or reclaimable stale) entry',
        }
      }
      resolved = queueResolved
    }
    attempt.videoArtifactId = resolved.artifactId
    attempt.caption = resolved.caption

    // The remote extension matches the SOURCE video's own for folder mode, where it is actually
    // known (`VIDEO_EXTENSIONS` in `folder.ts`) — pushing a .mov/.webm/.m4v file under a hardcoded
    // ".mp4" name would mismatch container and extension, which some gallery apps refuse to play.
    // `direct`/`queue` keep the pre-existing hardcoded "mp4" unchanged (criterion 9): neither mode
    // has ever known the artifact's real extension, and inventing one now would be a behaviour
    // change to a mode this step must leave alone.
    const remoteExt = attempt.folderVideo ? (attempt.folderVideo.path.match(/\.([^./]+)$/)?.[1] ?? 'mp4') : 'mp4'
    const remotePath = `/sdcard/DCIM/Camera/post-${ctx.job.id}-${ctx.job.attempt}.${remoteExt}`
    const pushResult = await ctx.device.push({ artifactId: resolved.artifactId, remotePath, mediaScan: 'auto' })
    attempt.remotePath = remotePath // only recorded once the push actually completed — an honest "where it was left" (G8, §3.8)
    ctx.log.info('pushed the video to the device', { remotePath, mediaScan: pushResult.mediaScan })

    // Screen 1: feed (§4.3 row 1). E3: never inspected — the accessibility layer cannot keep up with
    // an autoplaying feed, so the tap is aimed from the device's OWN measured surface, never a
    // hardcoded 720x1640 (§0.2's own walk was on exactly that resolution, which is the trap: the
    // next device this pack runs on will not necessarily match it).
    //
    // The surface is measured from a DUMP, not a screenshot, and that choice was forced by
    // hardware. On the reference moto g06 the on-device ui-server's two endpoints fail
    // independently: `/screenshot/0` began timing out ("the socket connection was closed
    // unexpectedly") while `/jsonrpc/0` kept answering dumps perfectly. A screenshot taken purely
    // to learn the screen's width and height therefore added a second, flakier dependency for a
    // number the dump already carries in its own root bounds — and it failed the run at the very
    // first step, before a single screen had been read (`screens: []`, four separate runs).
    //
    // `measureSurface` walks the tree for the widest/tallest bounds rather than trusting the root
    // node's own, because a root arriving as `0,0,0,0` was observed in this pack's own fixtures.
    const frame = await measureFrame(ctx)

    // The baseline `judgeGrid` compares against after Post — read now, before anything is posted.
    // The profile carries the same bottom nav as the feed, so the "Buat" tap below lands the same
    // from either. A dry run posts nothing and has nothing to confirm, so it skips the detour.
    await clearOverFeed(ctx, 'reading the profile')
    const gridBefore = ctx.params.dryRun ? null : await readOwnGrid(ctx, frame)
    if (!ctx.params.dryRun) {
      ctx.log.info('read the own-profile grid before posting', { cells: gridBefore === null ? 'unreadable' : String(gridBefore.length) })
      if (gridBefore === null || gridBefore.length === 0) {
        ctx.log.warn('no baseline grid before posting (unreadable, or no videos) — a new post cannot be proved against it, so this run can at best report "unverified"')
      }
      if (await securityCheckShowing(ctx)) {
        await capture(ctx, 'security-check')
        throw Object.assign(
          new Error('TikTok is asking this account for a security check ("pemeriksaan keamanan"). Nothing was posted. Complete it on the phone, then re-run.'),
          { code: 'E_SECURITY_CHECK' },
        )
      }
    }

    // Every draft on the account is deleted before anything is posted (1.36.0, the owner's decision) — after the
    // baseline, so the run is already on the profile. A dry run only counts them. `E_DRAFTS_NOT_CLEARED` stops the run here.
    let draftsNote = 'drafts were left alone (clearDrafts is off)'
    if (ctx.params.clearDrafts) {
      const drafts = await clearDrafts(ctx, { frame, dryRun: ctx.params.dryRun })
      draftsNote =
        drafts.found === 0
          ? 'no drafts to delete'
          : ctx.params.dryRun
            ? `would delete ${draftsPhrase(drafts.found)}`
            : `deleted ${draftsPhrase(drafts.removed)}`
    } else {
      ctx.log.info('clearDrafts is off — leaving the account\'s drafts alone')
    }

    await clearOverFeed(ctx, 'tapping "+"')
    // Aimed where the tree draws "+" when it can be read, blind at the measured nav position otherwise (1.34.1).
    const tapCreate = async (tree: UiNode | null): Promise<void> => {
      const node = tree ? createButtonOnScreen(tree, frame) : null
      const point = node ? centreOf(node) : { x: Math.round(frame.width * 0.5), y: Math.round(frame.height * 0.922) }
      ctx.log.info(node ? 'tapping "+" where the tree draws it' : 'tapping "+" blind, at its measured place in the bottom nav', point)
      await ctx.device.tap({ point })
    }
    await tapCreate(await ctx.device.dump().catch(() => null))
    attempt.screens.push('feed')
    await sleep(700)

    // Screen 2: camera (§4.3 row 2). sys.camera/sys.microphone fire here, queued (E5) — sweepModals
    // (inside enterScreen) clears both before the dump this screen's own act reads.
    //
    // One retap of "+" (1.34.1), for a sheet that took the first tap and was then closed by this
    // screen's own sweep, leaving the feed. Only while the feed's own nav is on screen, and only once
    // — so a camera still arriving can never take a second tap on its record button.
    //
    // 1.35.0: on a screen that reads "feed" too, now that the Samsung feed reads as itself instead of
    // "post" (bundle 997c7cfe) or "unknown". After a cleared modal it fires as before. With nothing
    // cleared it waits for a SECOND read that still shows the nav: rounds are 2 s apart, so by then a
    // camera that was merely slow has arrived, and "+" is never tapped into it.
    let navReads = 0
    const camera = await enterScreen(ctx, UPLOAD_MODAL_POLICIES, 'camera', {
      retapWhen: [
        {
          screen: ['unknown', 'feed'],
          when: (tree, cleared) => {
            if (!feedNavOnScreen(tree, frame.width)) return false
            navReads += 1
            return cleared.length > 0 || navReads >= 2
          },
          max: 1,
          tap: tapCreate,
        },
      ],
    })
    recordCleared(camera.cleared)
    const uploadButton = findNode(requireTree(camera, 'camera'), (n) => hasShortId(n, 'upload_hot_area'))
    if (!uploadButton) {
      await capture(ctx, 'missing-upload-hot-area', camera.tree)
      throw Object.assign(new Error(`the camera screen's "upload_hot_area" (gallery) button was not found in the dump`), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    await ctx.device.tap({ point: centreOf(uploadButton) })
    attempt.screens.push('camera')
    await sleep(700)

    // Screen 3: picker (§4.3 row 3). sys.media fires here — must be ALLOWED, never denied (E6);
    // UPLOAD_MODAL_POLICIES already carries that. Verify newest-first sort and a readable duration
    // on the first cell before tapping — the module header explains why this cannot be an EXACT
    // duration match (no capability measures the pushed file's own duration, G7/§9 Q3).
    const picker = await enterScreen(ctx, UPLOAD_MODAL_POLICIES, 'picker')
    recordCleared(picker.cleared)
    const pickerTree = requireTree(picker, 'picker')
    const sortLabel = pickerSortLabel(pickerTree)
    if (!sortLabel || !labelIs(sortLabel, PICKER_SORT_NEWEST_FIRST_LABELS)) {
      await capture(ctx, 'picker-sort-unexpected', pickerTree)
      throw Object.assign(
        new Error(`the picker's sort order reads "${sortLabel ?? '(none)'}" — expected "newest-first" (newest first). Tapping the first cell is only safe when it is the newest video, so this run refuses to guess.`),
        { code: 'E_PICKER_SORT_UNEXPECTED' },
      )
    }
    const firstCell = pickerCells(pickerTree)[0]
    if (!firstCell) {
      await capture(ctx, 'picker-empty', pickerTree)
      throw Object.assign(new Error('the picker grid has no cells — the pushed video may not have appeared in the gallery yet'), { code: 'E_PICKER_EMPTY' })
    }
    if (!firstCell.durationText) {
      await capture(ctx, 'picker-no-duration', pickerTree)
      throw Object.assign(new Error(`the picker's first cell has no readable duration — refusing to tap a cell this run cannot identify (§8: "a wrong video is posted")`), { code: 'E_PICKER_DURATION_UNREADABLE' })
    }
    ctx.log.warn(
      `picker check passed on sort order and a readable duration, but could NOT be cross-checked against a measured duration of the pushed file — no capability in this SDK reads a video's own duration (G7, §9 Q3)`,
      { firstCellDuration: firstCell.durationText },
    )
    // Learn where THIS device puts its next button, from the one screen that carries it and can be
    // read. Both later screens put it in the same place, and neither of them can be dumped.
    const pickerNext = nextButtonIn(pickerTree, 'picker')
    const learnedNextFraction = pickerNext
      ? { x: centreOf(pickerNext).x / frame.width, y: centreOf(pickerNext).y / frame.height }
      : null
    if (learnedNextFraction) ctx.log.info('calibrated the blind-tap position from this device\'s own picker screen', learnedNextFraction)

    await ctx.device.tap({ point: firstCell.centre })
    attempt.screens.push('picker')
    await sleep(700)

    // Screen 4: preview (§4.3 row 4). E9: "Berikutnya" is ambiguous here (the picker is still mounted
    // underneath) — `nextButtonIn` resolves it structurally rather than via a plain text find().
    const preview = await enterScreen(ctx, UPLOAD_MODAL_POLICIES, 'preview', { optional: true })
    recordCleared(preview.cleared)
    await sleep(VIDEO_SCREEN_DWELL_MS)
    await tapNext(ctx, preview.tree, 'preview', frame, learnedNextFraction)
    attempt.screens.push('preview')
    await sleep(1_500)

    // Screen 5: editor (§4.3 row 5).
    const editor = await enterScreen(ctx, UPLOAD_MODAL_POLICIES, 'editor', { optional: true })
    recordCleared(editor.cleared)
    await sleep(VIDEO_SCREEN_DWELL_MS)
    await tapNext(ctx, editor.tree, 'editor', frame, learnedNextFraction)
    attempt.screens.push('editor')
    await sleep(1_500)

    // Screen 6: post (§4.3 row 6) — type the caption, close the keyboard (E13: Post moves to the top
    // right while it's open and the bottom bar is covered), then find Post fresh.
    const post = await enterScreen(ctx, UPLOAD_MODAL_POLICIES, 'post', {
      // BOTH video screens, not just the editor. A diagnostic screenshot from the failing run
      // settled which one it was: the phone was still sitting on the PREVIEW screen at the end,
      // so the dump was accurate and the preview's own tap had simply not advanced anything —
      // while the recovery only ever watched for `editor` and therefore never fired.
      retapWhen: [
        { screen: 'preview', tap: async (t) => tapNext(ctx, t, 'preview', frame, learnedNextFraction) },
        { screen: 'editor', tap: async (t) => tapNext(ctx, t, 'editor', frame, learnedNextFraction) },
      ],
      rounds: 10,
    })
    recordCleared(post.cleared)
    const postTree0 = requireTree(post, 'post')
    const field = onScreenCaptionField(postTree0, frame.width) ?? captionField(postTree0)
    if (!field) {
      await capture(ctx, 'missing-caption-field', postTree0)
      throw Object.assign(new Error(`the post screen's caption field (the only EditText) was not found`), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    const capped = capHashtags(resolved.caption, ctx.params.maxHashtags)
    if (capped.dropped.length > 0) {
      ctx.log.warn(`caption carried more than ${ctx.params.maxHashtags} hashtags — the extras were dropped, not posted`, { dropped: capped.dropped.join(' ') })
    }
    attempt.caption = capped.caption
    // Tap, clear, type, then read the field back — `enterCaption` throws before Post when it did not land.
    const landed = await enterCaption(ctx, frame, field, capped.caption)
    attempt.caption = landed

    // No BACK to close the keyboard as a matter of course, and that is a correction the hardware
    // forced: `BACK` on this screen once LEFT THE POST SCREEN ENTIRELY and discarded the typed caption
    // (observed 2026-08-18). With the IME open Post usually moves to the top right and stays tappable
    // (E13); only a keyboard actually covering Post is put away, by `postButtonClear`.
    await sleep(1_000)
    attempt.screens.push('post')

    const postSweep = await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    recordCleared(postSweep.cleared)
    const postButton = await postButtonClear(ctx, frame, capped.caption)

    if (ctx.params.dryRun) {
      return {
        outcome: 'unverified',
        videoArtifactId: attempt.videoArtifactId,
        caption: attempt.caption,
        queueKey: attempt.queueClaim?.key ?? null,
        videoPath: attempt.folderVideo?.path ?? null,
        remotePath: attempt.remotePath,
        screens: attempt.screens,
        modalsHandled: attempt.modalsHandled,
        reason: `dry run: the flow reached the Post button and stopped without tapping it; ${draftsNote}`,
      }
    }

    await ctx.device.tap({ point: centreOf(postButton) })
    ctx.log.info('tapped Post — checking the tap took the post screen away, then confirming on the grid (§3.6)')

    /*
      Did the tap take? (1.34.0.) A Post under the keyboard or the suggestion panel posts nothing,
      and the run used to say `unverified`, mark the queue entry done and remember the folder video as
      posted all the same. TikTok leaves the post screen the moment it accepts an upload, so a post
      screen still showing THIS caption after the settle means the tap went nowhere: it is tapped once
      more, and if the screen is STILL there, nothing was posted and the run says so by name.
      Only that positive reading throws. Anything this cannot read is `unreadable`, never "not taken".
    */
    let tapState = await watchPostTap(ctx, frame.width, capped.caption)
    if (tapState === 'still-there') {
      ctx.log.warn('the post screen is still showing this caption after the Post tap — tapping Post once more')
      try {
        recordCleared((await sweepModals(ctx, UPLOAD_MODAL_POLICIES)).cleared)
        const again = await postButtonClear(ctx, frame, capped.caption)
        await ctx.device.tap({ point: centreOf(again) })
        tapState = await watchPostTap(ctx, frame.width, capped.caption)
      } catch (err) {
        // The screen changed under the second attempt (it left, a dialog arrived): the first tap may
        // have landed late, so from here on this is unknown, never "not taken".
        if ((err as { code?: string }).code === 'E_SECURITY_CHECK') attempt.leaveOnScreen = true
        ctx.log.warn('could not make the second Post tap cleanly — treating the tap as unreadable, never as not taken', { error: err instanceof Error ? err.message : String(err) })
        tapState = 'unreadable'
      }
      if (tapState === 'still-there') {
        await capture(ctx, 'post-tap-not-taken')
        throw Object.assign(
          new Error(
            `Post was tapped twice, but TikTok stayed on the post screen with the caption both times — the tap was not taken, so nothing was posted. See the post-tap-not-taken screenshot for what covered the button; re-running is safe.`,
          ),
          { code: 'E_POST_TAP_NOT_TAKEN' },
        )
      }
    }
    ctx.log.info('the Post tap', { state: tapState })

    // The POST-post modals, and they are their own discovery. Accepting an upload puts TikTok back
    // on the feed and immediately offers a home-screen widget (`tt.widget-prompt`); opening the
    // profile to verify raises its contacts pitch (`tt.contacts`). Neither existed in the register
    // before 2026-08-18 for a simple reason: the 2026-08-17 walk stopped AT the Post button, so
    // every modal that only appears after a real submission was invisible to it. An unattended run
    // that knew only the pre-post modals would sail through the whole flow and then stall on the
    // first screen it reached after actually succeeding.
    /*
      Past this line Post HAS been tapped, so nothing below may end the run as "failed" (1.31.0).

      A failed attempt is one the session's Retry re-sends, and re-sending a video TikTok already
      took is a duplicate post on a real account. The owner's production farm (2026-09-14) showed
      exactly that shape: runs that failed on `tt.widget-prompt … no on-screen node satisfied its
      "deny" action` — a prompt TikTok shows only AFTER accepting an upload — were recorded as
      failures. So the post-Post sweep and the confirmation are guarded: an error here is logged,
      the grid is still read if it can be, and the outcome is "posted" when the grid proves it and
      "unverified" otherwise, with the error in the reason.
    */
    await sleep(4_000)
    let afterPostError: string | null = null
    try {
      const postedSweep = await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
      recordCleared(postedSweep.cleared)
    } catch (err) {
      afterPostError = err instanceof Error ? err.message : String(err)
      if ((err as { code?: string }).code === 'E_SECURITY_CHECK') attempt.leaveOnScreen = true
      ctx.log.warn('a modal after Post could not be answered — confirming on the grid anyway, never reporting failed', { error: afterPostError })
    }

    let confirmation: { confirmed: boolean; detail: string; securityCheck: boolean }
    try {
      confirmation = await confirmPosted(ctx, frame, gridBefore)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.log.warn('confirming the post failed after Post was tapped — reporting unverified, never failed', { error: message })
      confirmation = { confirmed: false, detail: `Post was tapped, but confirming it failed (${message.slice(0, 160)}). Reporting "unverified" — it may well have posted.`, securityCheck: false }
    }
    if (confirmation.securityCheck) attempt.leaveOnScreen = true
    if (!confirmation.confirmed && afterPostError !== null) {
      confirmation = { ...confirmation, detail: `${confirmation.detail} After Post, TikTok showed something this run could not answer: ${afterPostError.slice(0, 160)}` }
    }
    if (!confirmation.confirmed && tapState === 'unreadable') {
      confirmation = { ...confirmation, detail: `Whether TikTok took the Post tap could not be read. ${confirmation.detail}` }
    }

    /*
      Bookkeeping only for a tap that is known to have been taken (1.34.0): the post screen went away,
      or the grid proved the post. A tap whose effect could not be read is NOT recorded as posted — the
      folder memory is left alone, and a queue entry is settled `failed` with a note to check the
      profile first. `failed` rather than left claimed: the queue never re-claims a failed entry by
      itself, while a claim left open is re-claimed after it goes stale, which could post the video twice.
    */
    const tapKnownTaken = tapState === 'taken' || confirmation.confirmed
    try {
      if (tapKnownTaken) {
        if (attempt.queueClaim) {
          // The queue envelope has no 'unverified' state; a taken tap is settled done, and the run's own
          // `outcome` is where the unverified nuance survives — re-claiming it would risk a duplicate.
          await tiktokQueue(ctx).settle(attempt.queueClaim, { status: 'done' })
        }
        if (attempt.folderVideo) {
          // §3.8's memory: the next `videoPick: 'random'` run should prefer a different video.
          await recordVideoPosted(ctx, attempt.folderVideo.hash, attempt.folderVideo.path)
        }
      } else {
        if (attempt.queueClaim) {
          await tiktokQueue(ctx).settle(attempt.queueClaim, {
            status: 'failed',
            error: 'Post was tapped, but whether TikTok took it could not be read and the profile did not confirm it. Check the profile before putting this back in the queue.',
          })
        }
        ctx.log.warn('the Post tap could not be confirmed — not recording this video as posted', { queueKey: attempt.queueClaim?.key ?? null, videoPath: attempt.folderVideo?.path ?? null })
      }
    } catch (err) {
      // Bookkeeping about a Post that already happened; its failure is not the post's.
      ctx.log.warn('could not record the post in the queue or folder memory — the outcome below still stands', { error: err instanceof Error ? err.message : String(err) })
    }

    return {
      outcome: confirmation.confirmed ? 'posted' : 'unverified',
      videoArtifactId: attempt.videoArtifactId,
      caption: attempt.caption,
      queueKey: attempt.queueClaim?.key ?? null,
      videoPath: attempt.folderVideo?.path ?? null,
      remotePath: attempt.remotePath,
      screens: attempt.screens,
      modalsHandled: attempt.modalsHandled,
      reason: confirmation.confirmed
        ? `the picker's duration check was a heuristic (sort order + a readable duration), not a measured match — see this file's own header comment`
        : confirmation.detail,
    }
  },

  /**
   * ALWAYS runs (stateless, idempotent — a timeout kill re-runs this in a fresh process, per the
   * SDK's own contract). On a failure it does three things, in order, none of which may throw past
   * this function:
   *
   * 1. A screenshot artifact, so a failed run always leaves a picture of where it died.
   * 2. Settles the queue claim as `failed` (if this process still holds `attempt.queueKey` — a
   *    fresh process after a timeout kill does not, and the claim is recovered instead by
   *    `claimNext`'s own stale-claim reclaim, queue.ts §3.3).
   * 3. **The abandon walk** (task 6; `backOutOfEditor` since 1.35.0): backs out of an unfinished post
   *    with bounded BACK presses, tapping "Buang" when the exit dialog shows and never "Simpan draf"
   *    or "Draf", sweeping with `ABANDON_MODAL_POLICIES` between each — the one place in this
   *    file BACK is the right tool, because here the goal genuinely IS to navigate backward out of
   *    the flow, unlike `run()`'s forward walk. Every step is wrapped so a failure here (the
   *    inspector being unusable, e.g.) is logged and swallowed, never thrown — `finish()` must not
   *    itself become the reason a job's failure looks worse than it is.
   *
   * Then, success or failure alike, force-stops the app (session hygiene — the same unconditional
   * cleanup every other member in this pack ends with).
   */
  async finish(ctx) {
    if (ctx.error) {
      await capture(ctx, 'failed')

      if (attempt.queueClaim) {
        try {
          await tiktokQueue(ctx).settle(attempt.queueClaim, { status: 'failed', error: ctx.error.message.slice(0, 400) })
        } catch (err) {
          // Includes the case where this run took longer than the stale-claim
          // window and another device already reclaimed the item: `settle` now
          // refuses rather than stomping that device's write (plan 800). A
          // warning is the right outcome — the item is being worked by someone
          // else, which is the mechanism doing its job, not this run's failure.
          ctx.log.warn('could not settle the queue claim after a failed run', { error: String(err) })
        }
      }

      // A security check is left exactly where it is: TikTok open, the sheet showing, for the
      // operator to complete by hand. BACK would dismiss it and a force-stop would hide it — and the
      // register's whole stance on `tt.security-check` is that a run never answers it.
      if (ctx.error.code !== 'E_SECURITY_CHECK') {
        let securityCheck = false
        try {
          // Backs out of an unfinished post with "Buang" and never keeps a draft (1.35.0) — see `backOutOfEditor`.
          securityCheck = await backOutOfEditor(ctx)
          if (securityCheck) ctx.log.warn('a security check appeared while backing out — leaving TikTok open on it')
        } catch (err) {
          // The register raises the security check by its own code wherever it appears — the abandon
          // walk included — and it is left on screen here too.
          securityCheck = (err as { code?: string }).code === 'E_SECURITY_CHECK'
          ctx.log.warn(securityCheck ? 'a security check appeared while backing out — leaving TikTok open on it' : 'abandon walk did not fully settle — force-stopping anyway', { error: String(err) })
        }

        if (!securityCheck) await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })
      }

      const failed = {
        outcome: 'failed' as const,
        videoArtifactId: attempt.videoArtifactId,
        caption: attempt.caption,
        queueKey: attempt.queueClaim?.key ?? null,
        videoPath: attempt.folderVideo?.path ?? null,
        remotePath: attempt.remotePath,
        screens: attempt.screens,
        modalsHandled: attempt.modalsHandled,
        reason: ctx.error.message,
      }
      attempt = freshAttemptState()
      return failed
    }

    if (attempt.leaveOnScreen) {
      ctx.log.warn('TikTok raised its security check after Post — leaving the app open on it for the operator')
    } else {
      await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })
    }
    attempt = freshAttemptState()
  },
}

export default postVideo
