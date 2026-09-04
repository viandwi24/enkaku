import { ui, type PluginMemberScript, type ScriptContext } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { sleep } from './human'
import { all } from './tree'
import { centreOf, detectScreen, findNode, captionField, nextButtonIn, pickerCells, pickerSortLabel, type ScreenId } from './screens'
import { sweepModals, UPLOAD_MODAL_POLICIES, type ModalPolicy } from './modals'
import { claimNext, settleClaim } from './queue'
import { readCaptionsFile, pickCaption } from './captions'
import { resolveVideoFromFolder, recordVideoPosted } from './folder'
import { TIKTOK_PACKAGE, PROFIL_TAB, MENU_PROFIL } from './sheet'

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
 * The picker's sort-order label when newest-first (E11) — confirmed against the checked-in
 * `__fixtures__/screen-picker.json`: `tv_title` reads "Terbaru" on this pack's reference device and
 * locale (id-ID). If a future device or locale reads something else, the picker check below fails
 * loudly rather than silently assuming order — exactly what it exists to prevent.
 */
const PICKER_SORT_NEWEST_FIRST_LABELS = ['Terbaru', 'Recent', 'Recents', 'Newest', 'Terkini']

/**
 * The post screen's own publish button — read directly off `__fixtures__/screen-post.json`
 * (the fixture 113.2 already ships): a `Button` with text "Posting", the only node in that whole
 * dump carrying that exact text. Matched by TEXT, not by its resource id (`sp3`) — E10 names `sp3`
 * among the obfuscated ids this pack refuses to anchor on, the same reason `nextButtonIn` matches
 * "Berikutnya" by text rather than id. `findNode` walks depth-first from the root for it — safe
 * here because it is unique in the fixture, the same posture `nextButtonIn`'s own comment takes for
 * every screen besides picker/preview, where E9's ambiguity does not apply.
 */
const POST_BUTTON_LABELS = ['Posting', 'Post', 'Publicar']

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
async function clearCaptionField(ctx: ScriptContext<unknown>, field: UiNode): Promise<void> {
  const existing = field.text.trim()
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
    retapWhen?: Array<{ screen: ScreenId; tap: (tree: UiNode | null) => Promise<void> }>
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
  for (let round = 0; round < rounds; round += 1) {
    if (round > 0) await sleep(2_000)
    const swept = await sweepModals(ctx, policies)
    for (const id of swept.cleared) if (!cleared.includes(id)) cleared.push(id)
    tree = await ctx.device.dump()
    screen = detectScreen(tree)
    if (screen === expected) return { tree, cleared }
    const stuck = opts?.retapWhen?.find((r) => r.screen === screen)
    if (stuck && round < rounds - 1) {
      ctx.log.warn(`still on the "${screen}" screen — re-tapping, because a blind tap onto a video screen can be swallowed`, { round })
      await stuck.tap(tree)
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

  await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-unexpected-screen-${screen}`)
  throw Object.assign(
    new Error(`expected the "${expected}" screen but the dump reads "${screen}" after ${rounds} settle rounds${cleared.length > 0 ? ` (cleared: ${cleared.join(', ')})` : ' (no modal matched)'}`),
    { code: 'E_UNEXPECTED_SCREEN' },
  )
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

/**
 * The confirmation §3.6 exists for (step 113.6, §9 Q1's recommendation): after Post is tapped, open
 * the account's own profile and look for the new video in the first grid cell, with a bounded wait
 * (upload/publish is not instant — E1 measured the media SCAN alone at ~1.6s, and TikTok's own
 * remote publish step is unmeasured and almost certainly slower).
 *
 * `PROFIL_TAB`/`MENU_PROFIL` are the two confirmed-unique selectors `sheet.ts` already verified for
 * this exact navigation (its own header: "safe to find/waitFor directly"). What is NOT confirmed is
 * the shape of the profile's own video grid — the 2026-08-17 walk never reached it (§0.2: it stopped
 * at Post and discarded the draft), so there is no fixture and no id/className to anchor on here.
 * `looksLikeGridCell` below is therefore a GEOMETRIC heuristic (roughly square, thumbnail-sized,
 * below the profile header) rather than an invented id — the least-fabricated thing that can still
 * be called "a grid cell" without hardware to confirm it. A hardware run (113.4) either proves this
 * right or gives the next reader a real dump to replace it with; until then every call here logs
 * that it is unverified, and a run that cannot confirm reports `unverified`, never `posted`.
 */
async function confirmPosted(ctx: ScriptContext<unknown>, frameWidth: number): Promise<{ confirmed: boolean; detail: string }> {
  const attempts = 6
  const intervalMs = 5_000
  // The profile raises TikTok's contacts pitch on arrival (observed 2026-08-18) — swept here so the
  // verification step is not defeated by a dialog that has nothing to do with whether a post landed.
  const sweepProfileModals = async (): Promise<void> => {
    try {
      await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    } catch {
      // A sweep failure must never turn a SUCCESSFUL post into a failed run: this function only
      // decides how confidently the outcome is worded, and its own errors are not evidence either way.
    }
  }

  const looksLikeGridCell = (n: UiNode, belowY: number): boolean => {
    if (!n.clickable) return false
    if (n.bounds.top < belowY) return false // stay below the profile header/menu row
    const w = n.bounds.right - n.bounds.left
    const h = n.bounds.bottom - n.bounds.top
    if (w <= 0 || h <= 0) return false
    const widthFraction = w / frameWidth
    if (widthFraction < 0.18 || widthFraction > 0.5) return false // a 2–4 column grid, roughly
    const aspect = h / w
    return aspect > 0.5 && aspect < 2.5 // squarish to portrait-ish thumbnail, not a full-width row
  }

  for (let round = 0; round < attempts; round++) {
    try {
      await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
      const profilNode = await ctx.device.waitFor(PROFIL_TAB, { timeout: 10_000 })
      await ctx.device.tap({ point: centreOf(profilNode) })
      const menuNode = await ctx.device.waitFor(MENU_PROFIL, { timeout: 10_000 })
      // Swept AFTER arriving, not only before leaving: `tt.contacts` is raised BY the profile
      // screen, so a sweep that ran before the tap cannot have seen it (observed 2026-08-18).
      await sweepProfileModals()
      const tree = await ctx.device.dump()
      const cell = all(tree, (n) => looksLikeGridCell(n, menuNode.bounds.bottom))[0]
      if (cell) {
        return {
          confirmed: true,
          detail: `the own-profile screen showed a grid-shaped cell after posting (a geometric heuristic — no hardware dump of this screen exists yet, plan 113 §9 Q1; see confirmPosted()'s own comment)`,
        }
      }
      ctx.log.warn(`confirmPosted: reached the own-profile screen but no grid cell was found yet (attempt ${round + 1}/${attempts})`)
    } catch (err) {
      ctx.log.warn('confirmPosted: could not reach or read the own-profile screen this attempt', { round, error: String(err) })
    }
    if (round < attempts - 1) await sleep(intervalMs)
  }

  await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-unverified`)
  return {
    confirmed: false,
    detail: `Post was tapped, but the own-profile grid never showed a matching cell within ${Math.round((attempts * intervalMs) / 1000)}s — reporting "unverified" rather than assuming the tap succeeded (§3.6)`,
  }
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
  queueKey: string | null
  remotePath: string | null
  screens: string[]
  modalsHandled: string[]
  /** Set only when `source === 'folder'` — the picked file's own content hash and workspace path,
   * carried from `resolveFromFolder` to the post-Post `recordVideoPosted` call (§3.8) the same way
   * `queueKey` is carried to `settleClaim` for the queue source. */
  folderVideo: { hash: string; path: string } | null
}

function freshAttemptState(): AttemptState {
  return { videoArtifactId: null, caption: null, queueKey: null, remotePath: null, screens: [], modalsHandled: [], folderVideo: null }
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
  const claim = await claimNext(ctx, { pick: ctx.params.pick, claimedBy: ctx.job.deviceId })
  if (!claim) return { skipped: true }
  attempt.queueKey = claim.key

  if (claim.item.caption !== null) {
    return { skipped: false, artifactId: claim.item.artifactId, caption: claim.item.caption }
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
  return { skipped: false, artifactId: claim.item.artifactId, caption: picked.caption }
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
  node: { category: 'device', icon: 'upload', summary: [], keywords: ['post', 'upload', 'video'] },
  params,
  result,
  // Generous: six screens, up to four modal-sweep rounds each, and the confirmation's own bounded
  // wait (§9 Q1, up to ~30s) all add up — the same "slack for dialog sweeps, not for any one step
  // being slow" reasoning `switch-account.ts` states for its own budget.
  timeout: 10 * 60_000,

  async prepare(ctx) {
    attempt = freshAttemptState()
    await ctx.device.app.forceStop(TIKTOK_PACKAGE)
    await ctx.device.app.launch(TIKTOK_PACKAGE)
    await sleep(4_000) // let the launch storm settle before the feed tap below (E3: the feed cannot be dumped to check itself)
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
    await ctx.device.tap({ point: { x: Math.round(frame.width * 0.5), y: Math.round(frame.height * 0.922) } })
    attempt.screens.push('feed')
    await sleep(700)

    // Screen 2: camera (§4.3 row 2). sys.camera/sys.microphone fire here, queued (E5) — sweepModals
    // (inside enterScreen) clears both before the dump this screen's own act reads.
    const camera = await enterScreen(ctx, UPLOAD_MODAL_POLICIES, 'camera')
    recordCleared(camera.cleared)
    const uploadButton = findNode(requireTree(camera, 'camera'), (n) => hasShortId(n, 'upload_hot_area'))
    if (!uploadButton) {
      await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-missing-upload-hot-area`)
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
      await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-picker-sort-unexpected`)
      throw Object.assign(
        new Error(`the picker's sort order reads "${sortLabel ?? '(none)'}" — expected "newest-first" (newest first). Tapping the first cell is only safe when it is the newest video, so this run refuses to guess.`),
        { code: 'E_PICKER_SORT_UNEXPECTED' },
      )
    }
    const firstCell = pickerCells(pickerTree)[0]
    if (!firstCell) {
      await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-picker-empty`)
      throw Object.assign(new Error('the picker grid has no cells — the pushed video may not have appeared in the gallery yet'), { code: 'E_PICKER_EMPTY' })
    }
    if (!firstCell.durationText) {
      await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-picker-no-duration`)
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
    const field = captionField(requireTree(post, 'post'))
    if (!field) {
      await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-missing-caption-field`)
      throw Object.assign(new Error(`the post screen's caption field (the only EditText) was not found`), { code: 'E_ANCHOR_NOT_FOUND' })
    }
    await ctx.device.tap({ point: centreOf(field) })
    await clearCaptionField(ctx, field)
    const capped = capHashtags(resolved.caption, ctx.params.maxHashtags)
    if (capped.dropped.length > 0) {
      ctx.log.warn(`caption carried more than ${ctx.params.maxHashtags} hashtags — the extras were dropped, not posted`, { dropped: capped.dropped.join(' ') })
    }
    attempt.caption = capped.caption
    const typed = await ctx.device.type(capped.caption)
    ctx.log.info('typed the caption', { via: typed.via, hashtags: (capped.caption.match(/#[^\s#]+/g) ?? []).length })

    // NO `BACK` here, and that is a correction the hardware forced. Typing a hashtag opens TikTok's
    // own tag-suggestion panel, which covers the bottom bar — and `BACK`, which was supposed to
    // close the IME, instead LEFT THE POST SCREEN ENTIRELY and discarded the typed caption (observed
    // 2026-08-18). The Post button does not need the keyboard closed: with the IME open it simply
    // moves to the top right and stays in the tree (E13), so the dump below finds it wherever it is.
    await sleep(1_000)
    attempt.screens.push('post')

    const postSweep = await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    recordCleared(postSweep.cleared)
    const postTree = await ctx.device.dump()
    const postButton = findNode(postTree, isPostButton)
    if (!postButton) {
      await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-missing-post-button`)
      throw Object.assign(new Error(`the post screen's Post button was not found after closing the keyboard`), { code: 'E_ANCHOR_NOT_FOUND' })
    }

    if (ctx.params.dryRun) {
      return {
        outcome: 'unverified',
        videoArtifactId: attempt.videoArtifactId,
        caption: attempt.caption,
        queueKey: attempt.queueKey,
        videoPath: attempt.folderVideo?.path ?? null,
        remotePath: attempt.remotePath,
        screens: attempt.screens,
        modalsHandled: attempt.modalsHandled,
        reason: 'dry run: the flow reached the Post button and stopped without tapping it',
      }
    }

    await ctx.device.tap({ point: centreOf(postButton) })
    ctx.log.info('tapped Post — confirming rather than trusting the tap (§3.6)')

    // The POST-post modals, and they are their own discovery. Accepting an upload puts TikTok back
    // on the feed and immediately offers a home-screen widget (`tt.widget-prompt`); opening the
    // profile to verify raises its contacts pitch (`tt.contacts`). Neither existed in the register
    // before 2026-08-18 for a simple reason: the 2026-08-17 walk stopped AT the Post button, so
    // every modal that only appears after a real submission was invisible to it. An unattended run
    // that knew only the pre-post modals would sail through the whole flow and then stall on the
    // first screen it reached after actually succeeding.
    await sleep(4_000)
    const postedSweep = await sweepModals(ctx, UPLOAD_MODAL_POLICIES)
    recordCleared(postedSweep.cleared)

    const confirmation = await confirmPosted(ctx, frame.width)
    if (attempt.queueKey) {
      // Post was tapped either way — settle the queue as 'posted' regardless of confirmation
      // strength. QueueItemSchema has no 'unverified' state, and re-claiming an item whose Post
      // button was already tapped risks a DUPLICATE submission, which is worse than an optimistic
      // mark; the run's own `outcome` is where the unverified nuance survives.
      await settleClaim(ctx, attempt.queueKey, { status: 'posted' })
    }
    if (attempt.folderVideo) {
      // §3.8's memory, recorded the moment Post was tapped — same "either way" reasoning as the
      // queue settle above: this run genuinely acted on the file, confirmed or not, and the next
      // `videoPick: 'random'` run should prefer a different one over reposting it immediately.
      await recordVideoPosted(ctx, attempt.folderVideo.hash, attempt.folderVideo.path)
    }

    return {
      outcome: confirmation.confirmed ? 'posted' : 'unverified',
      videoArtifactId: attempt.videoArtifactId,
      caption: attempt.caption,
      queueKey: attempt.queueKey,
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
   * 3. **The abandon walk** (task 6): backs out of whatever screen the flow died on with bounded
   *    BACK presses, sweeping with `ABANDON_MODAL_POLICIES` between each — the one place in this
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
      await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-failed`).catch(() => {})

      if (attempt.queueKey) {
        try {
          await settleClaim(ctx, attempt.queueKey, { status: 'failed', error: ctx.error.message.slice(0, 400) })
        } catch (err) {
          ctx.log.warn('could not settle the queue claim after a failed run', { error: String(err) })
        }
      }

      try {
        for (let i = 0; i < 3; i++) {
          await sweepModals(ctx, ABANDON_MODAL_POLICIES, { maxRounds: 2 })
          await ctx.device.key('BACK')
          await sleep(600)
        }
        await sweepModals(ctx, ABANDON_MODAL_POLICIES, { maxRounds: 2 })
      } catch (err) {
        ctx.log.warn('abandon walk did not fully settle — force-stopping anyway', { error: String(err) })
      }

      await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })

      const failed = {
        outcome: 'failed' as const,
        videoArtifactId: attempt.videoArtifactId,
        caption: attempt.caption,
        queueKey: attempt.queueKey,
        videoPath: attempt.folderVideo?.path ?? null,
        remotePath: attempt.remotePath,
        screens: attempt.screens,
        modalsHandled: attempt.modalsHandled,
        reason: ctx.error.message,
      }
      attempt = freshAttemptState()
      return failed
    }

    await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })
    attempt = freshAttemptState()
  },
}

export default postVideo
