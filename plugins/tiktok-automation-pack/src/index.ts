import { defineService, definePlugin, ui, type PluginMemberScript, type PluginServiceContext, type ScriptContext } from '@enkaku/sdk'
import type { Selector, UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { between, makeRng, pickWatchMs, pngSize, sleep } from './human'
import { clearBlockingDialog, nextDialogAction } from './dialogs'
import { flatten } from './tree'
import { dismissInterruptions, keyboardWindowShowing } from './interruptions'
import switchAccount from './switch-account'
import searchFollow from './search-follow'
import listAccounts from './list-accounts'
import postVideo from './post-video'
import enqueueVideo from './enqueue-video'
import searchKeyword from './search-keyword'
import clearDraftsScript from './clear-drafts'
import keywordVideos from './keyword-videos'
import liveBrowse from './live-browse'
import shopBrowse from './shop-browse'
import notificationActivity from './notification-activity'
import { ACCOUNTS_KEY } from './accounts'
import { migrateLegacyQueueEntries } from './queue'

/**
 * TikTok automation pack.
 *
 * ## What the inspector actually showed (device ZP2222RMBS, 720×1640, app `com.ss.android.ugc.trill`)
 *
 * The feed is an `androidx.viewpager.widget.ViewPager` (`:id/viewpager`) filling `[0,0][720,1470]`,
 * with the video surface (`:id/player_view`, `long_press_layout`, `content-desc="Video"`) on top of
 * it. Three regions must NOT be touched by a scroll gesture:
 *
 * - the right action rail from x≈608 — avatar, follow, like, comment, favourite, share, sound.
 *   A swipe starting there taps a button instead of scrolling, and `Ikuti`/`Suka` are side effects
 *   this pack must never cause by accident.
 * - `:id/video_seek_bar` at `[0,1444][720,1493]` — a drag there scrubs the video.
 * - the tab strip `[0,70][720,172]` and the bottom nav `[0,1470][720,1556]`.
 *
 * The engine's own `directionalSwipe` (`packages/session/src/device-executor.ts`) draws from the
 * frame centre — x = width/2 = 360, well clear of the rail, and y ≈ 1230 → 410 for a normal fling,
 * clear of the seek bar. So `fling`/`scroll` are safe here **and** the geometry stays derived from
 * the device rather than hardcoded to one screen size.
 *
 * ## Why no raw coordinates
 *
 * A script cannot read the frame size: `DeviceApi` exposes no accessor, and `find()` deliberately
 * refuses a viewport-sized container (plan 60 §3.1), which is exactly what `:id/viewpager` is. So
 * absolute `swipe()` points would mean hardcoding 720×1640 and silently mis-aiming on any other
 * device. Direction-based gestures keep this pack portable; the human-ness lives in *timing* and
 * *strength*, which is where it belongs anyway — a bot is given away by a metronome, not by
 * swiping down the middle.
 *
 * ## What it deliberately does not do
 *
 * No liking, following, commenting, or sharing. This pack only watches and scrolls. Anything that
 * writes to the account is a separate, explicit decision.
 */

/**
 * One swipe that actually turns the page.
 *
 * The feed is a `ViewPager`, which snaps back unless a drag either crosses ~half a page or is
 * released at high velocity. `fling()` fails both tests here: `normal` moves 0.35 × height (574px
 * on this phone, against a ~1470px page) and every built-in profile eases OUT, so the finger is
 * nearly stopped at release. The observed result was exactly the bounce-back an operator described
 * — the feed lifts, then falls back to the same video, and consecutive screenshots are identical.
 *
 * So: cross the displacement threshold outright (58–78% of the screen) and release at full speed
 * (`linear` is the only easing here that does not decelerate). Randomising the start point, the
 * distance, the duration and the curvature is what keeps it human — variation in the path, not in
 * whether the gesture works.
 *
 * The corridor avoids what the inspector showed sits on top of the feed: the right action rail from
 * x≈0.85w (like/comment/share — a swipe starting there presses a button) and the seek bar at
 * y≈0.88h (a drag there scrubs the video).
 */
async function advanceFeed(
  ctx: ScriptContext<unknown>,
  frame: { width: number; height: number },
  rng: () => number,
): Promise<void> {
  const x = Math.round(between(rng, 0.14, 0.60) * frame.width)
  const startY = Math.round(between(rng, 0.72, 0.80) * frame.height)
  const distance = Math.round(between(rng, 0.58, 0.78) * frame.height)
  const endY = Math.max(Math.round(0.06 * frame.height), startY - distance)
  const ms = Math.round(between(rng, 140, 230))
  await ctx.device.swipe({ x, y: startY }, { x: Math.round(x + between(rng, -12, 12)), y: endY }, ms, {
    easing: 'linear',
    curvature: Number(between(rng, 0, 0.06).toFixed(3)),
  })
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const TIKTOK_PACKAGE = 'com.ss.android.ugc.trill'

/**
 * Node ids that survived across app restarts in the inspector dumps, unlike the obfuscated
 * three-character ones (`ei1`, `p4e`, …) that change between builds. Only these are selected on.
 */
const ID_AUTHOR = `${TIKTOK_PACKAGE}:id/title`
const ID_TAG = `${TIKTOK_PACKAGE}:id/feed_multi_tag_layout`
const ID_AVATAR = `${TIKTOK_PACKAGE}:id/user_avatar`

/** Free text about the current video, read WITHOUT touching anything. Empty strings for whatever could not be read. */
async function readVisibleSignals(ctx: ScriptContext<unknown>): Promise<{ author: string; tag: string; ok: boolean }> {
  let ok = false
  const read = async (sel: Selector, field: 'text' | 'desc'): Promise<string> => {
    try {
      const node = await ctx.device.find(sel)
      if (!node) return ''
      ok = true
      return (field === 'text' ? node.text : node.desc) ?? ''
    } catch {
      return ''
    }
  }
  const author = (await read({ id: ID_AUTHOR }, 'text')) || (await read({ id: ID_AVATAR }, 'desc'))
  const tag = await read({ id: ID_TAG }, 'desc')
  return { author, tag, ok }
}

/**
 * Does this video look like the kind we are trying to teach the feed to send more of?
 *
 * Matches only what is on screen for free — the account name, and the effect/tag when present. The
 * CAPTION is deliberately absent: it is not in the accessibility tree at all on this app (verified
 * by dumping the whole tree; the longest strings there are button labels like "Bagikan video"), so
 * any code pretending to match against it would be matching against nothing.
 */
export function scoreContent(text: string, keywords: string[], blocked: string[]): number {
  const hay = text.toLowerCase()
  if (blocked.some((k) => matches(hay, k))) return -1
  return keywords.filter((k) => matches(hay, k)).length
}

/**
 * Substring for long words, word-boundary for short ones.
 *
 * A plain `includes` is right for `xauusd` — it should still hit inside a handle like
 * `goldxauusdtrader`, where nobody typed a space. It is wrong for the short trading acronyms:
 * `ict` alone matches "pred**ict**", "add**ict**ive", "v**ict**im", and `smc` is no better. Those
 * false hits would tilt a completely unrelated video towards a long watch, which is worse than
 * missing a real one — it teaches the feed the opposite of what was asked.
 *
 * Three characters is the cut-off because that is where the acronyms live; anything longer is
 * specific enough that an accidental substring hit is vanishingly unlikely.
 */
export function matches(hay: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase()
  if (!k) return false
  if (k.length > 3) return hay.includes(k)
  // `\b` alone will not do: a handle like `xau_ict` has an underscore, which is a word character,
  // so the boundary never fires. Anything that is not a letter or a digit counts as a separator.
  return new RegExp(`(?:^|[^a-z0-9])${escapeForRegex(k)}(?:[^a-z0-9]|$)`, 'i').test(hay)
}

const escapeForRegex = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Opens the comment sheet, scrolls it like someone reading, and closes it.
 *
 * Tapped by POSITION, not by selector: the comment button's own id is one of the obfuscated ones,
 * and its `content-desc` embeds the comment count ("Baca atau tambahkan komentar. 1.043 komentar"),
 * so there is no stable exact string to select on. The fraction comes from the inspector dump —
 * the button sits at x≈0.92w, y≈0.67h — and is applied to the frame read from the screenshot, so it
 * is not hardcoded to one screen size.
 *
 * Opening comments is itself an engagement signal, which is the point: it is spent only on videos
 * that already matched, never on every video, because a session that opens every comment section is
 * neither a useful signal nor a human-looking one.
 */
/**
 * Strip the bidirectional marks Android puts in front of counted labels, which `trim()` does not
 * (1.50.0). MEASURED on the owner's moto g06 (`screen-comment-sheet.json`): the sheet's own title is
 * `"‎16 komentar"` — a LEFT-TO-RIGHT MARK, then the count. `"‎16 komentar".trim()` still
 * begins with U+200E, so every comparison against it failed silently.
 */
function plain(s: string): string {
  return s.replace(/[‎‏؜⁦-⁩]/g, '').trim()
}

/**
 * Is the comment sheet up? (rewritten 1.50.0)
 *
 * 1.49.0 looked for a node whose whole text was `Komentar`. There is no such node. The real sheet,
 * dumped from the owner's phone with the sheet plainly open, carries `"‎16 komentar"` (the
 * COUNT, bidi-marked) as its title and `"Tambahkan komentar..."` as its input — so the predicate
 * answered `false` on the very screen it exists to recognise, `leaveCommentSheet` returned without
 * pressing anything, and the phone sat in the comments until the run ended. The owner's wall showed
 * a dozen phones parked there at once, some with the reply field focused.
 *
 * Matched on a CONTAINED word, not an exact one, because the title is a count in every locale, and
 * on the sheet's own close button as a second, independent witness. Deliberately NOT on the obfuscated
 * ids this dump also carries (`id/w5r`, `id/bqo`): TikTok regenerates those every build, so pinning to
 * them would make this fail again on the next update, silently, exactly as 1.49.0 did.
 */
const COMMENT_SHEET_WORDS = /\b(komentar|comments?)\b/i

export function commentSheetShowing(tree: UiNode): boolean {
  return flatten(tree).some((n) => {
    const text = plain(n.text)
    /*
      Only sheet-shaped nodes count, and only their `text`.

      NOT the close button on its own: "Tutup"/"Close" is `interruptions.ts`'s `CLOSE_LABELS`, carried
      by every modal this app raises, and a false positive here costs a BACK press on the bare feed —
      which leaves TikTok, the one recovery this member must never invent.

      NOT `desc` either: the FEED's own rail button is `desc: "Baca atau tambahkan komentar. 279
      komentar"`, so reading descriptions would call the closed feed an open sheet.

      What is left is the sheet's own two nodes: the counted title (`text`, not clickable, has a
      digit) and the input placeholder (an EditText).
    */
    if (n.className === 'android.widget.EditText' && COMMENT_SHEET_WORDS.test(text)) return true
    return !n.clickable && COMMENT_SHEET_WORDS.test(text) && /\d/.test(text)
  })
}

/** The sheet's own close control — `content-desc` "Tutup"/"Close", clickable. The one thing that closes it without BACK. */
export function closeButton(n: UiNode): boolean {
  const d = plain(n.desc).toLowerCase()
  return n.clickable && (d === 'tutup' || d === 'close')
}

/**
 * Is a reply being composed? (1.50.0)
 *
 * This pack NEVER replies to a comment — comments are opened, read, and closed, on every platform.
 * So a focused input, or TikTok's "Membalas <name>" placeholder, is always an accident that must be
 * backed out of rather than something to finish. Three phones on the owner's wall were sitting in
 * exactly this state with the farm's keyboard up.
 */
export function replyComposerShowing(tree: UiNode): boolean {
  return flatten(tree).some(
    (n) => (n.className === 'android.widget.EditText' && n.focused) || /^membalas\b|^replying to\b/i.test(plain(n.text)) || /^membalas\b|^replying to\b/i.test(plain(n.desc)),
  )
}

/**
 * Leave the comment sheet, one proven step at a time (1.49.0).
 *
 * The owner met a phone parked here mid warm-up, the farm's own keyboard flickering under it. A swipe
 * inside the sheet had landed on "Tambahkan komentar…" — the input sits directly below the list — and
 * the field took focus, so the single BACK this function used to be closed the KEYBOARD and left the
 * sheet up. The run then went round its loop against a screen that is not the feed.
 *
 * BACK is pressed only while something is READ on screen that BACK should close: the keyboard, then
 * the sheet. Never blindly — BACK on the bare feed leaves TikTok, which is the one recovery this
 * member must never invent.
 */
async function leaveCommentSheet(ctx: ScriptContext<unknown>, rng: () => number): Promise<void> {
  for (let step = 0; step < 4; step++) {
    let tree: UiNode | null = null
    try {
      tree = await ctx.device.dump()
    } catch {
      // The inspector is not dependable on this app (see `readVisibleSignals`). One BACK is still owed
      // for the sheet this function was called to close, and only on the first step.
      if (step === 0) {
        await ctx.device.key('BACK')
        await sleep(Math.round(between(rng, 500, 1_100)))
      }
      return
    }
    const keyboard = keyboardWindowShowing(tree)
    const replying = replyComposerShowing(tree)
    if (!keyboard && !replying && !commentSheetShowing(tree)) return

    /*
      The sheet's own close button, when it is there (1.50.0). BACK closes the KEYBOARD first when one
      is up, which is what left 1.49.0 pressing once and leaving the sheet behind; tapping "Tutup"
      closes the sheet itself in one move and needs no guess about what BACK will hit. This is the
      ladder `youtube-automation-pack`'s `COMMENTS_CLOSE_RUNGS` has always had and this member did not.
    */
    const closer = !keyboard && !replying ? flatten(tree).find(closeButton) : undefined
    if (closer) {
      ctx.log.info('closing the comment sheet with its own close button')
      await ctx.device.tap({ point: { x: Math.round((closer.bounds.left + closer.bounds.right) / 2), y: Math.round((closer.bounds.top + closer.bounds.bottom) / 2) } })
    } else {
      ctx.log.info(replying ? 'backing out of a reply this member never meant to start' : keyboard ? 'closing the keyboard the comment field opened' : 'closing the comment sheet')
      await ctx.device.key('BACK')
    }
    await sleep(Math.round(between(rng, 500, 1_100)))
  }
  ctx.log.warn('the comment sheet was still readable after four attempts — carrying on, the feed check below decides')
}

async function browseComments(
  ctx: ScriptContext<unknown>,
  frame: { width: number; height: number },
  rng: () => number,
): Promise<boolean> {
  const before = await snapshot(ctx)
  await ctx.device.tap({ point: { x: Math.round(0.92 * frame.width), y: Math.round(0.67 * frame.height) } })
  await sleep(Math.round(between(rng, 1_200, 2_200)))
  const opened = await snapshot(ctx)
  if (before && opened && bytesEqual(before, opened)) {
    ctx.log.warn('the comment sheet did not open — leaving the video alone')
    return false
  }

  // Read a couple of screenfuls the way a person skims them: the sheet's own list sits well inside
  // the screen, so these swipes stay clear of both the video above and the input box below.
  const passes = 1 + Math.floor(rng() * 3)
  for (let i = 0; i < passes; i++) {
    await sleep(Math.round(between(rng, 900, 2_600)))
    const x = Math.round(between(rng, 0.25, 0.7) * frame.width)
    /*
      Clear of the "Balas" column (1.50.0), which is what 1.49.0 actually walked into.

      1.49.0 moved this swipe to 0.72h → 0.30–0.42h "because Tambahkan komentar sits at roughly
      0.50–0.57h". That measurement was wrong. MEASURED from a real dump of the open sheet
      (`screen-comment-sheet.json`, moto g06, 720×1640): the input box is at y1465–1519 (0.89–0.93h),
      far BELOW where the comment said — and the five "Balas" buttons sit at y802, y944, y1086,
      y1228 and y1370, x170–262. So 1.49.0 dragged the finger from 1180 up through three of them,
      inside the x-range it draws from (0.25–0.7w = 180–504). A touch that begins or settles on one
      opens the reply composer, which is why the owner's wall showed phones sitting on
      "Membalas <name>" with the keyboard up.

      This pack never replies to a comment. So the swipe now stays in the band ABOVE the topmost
      reply button and below the sheet's title: 0.46h → 0.26–0.36h. Same list, same reading, no
      clickable control anywhere in the path.
    */
    await ctx.device.swipe(
      { x, y: Math.round(0.46 * frame.height) },
      { x, y: Math.round(between(rng, 0.26, 0.36) * frame.height) },
      Math.round(between(rng, 220, 420)),
      { easing: 'easeInOutCubic' },
    )
  }
  await sleep(Math.round(between(rng, 700, 1_800)))
  await leaveCommentSheet(ctx, rng)
  return true
}

/**
 * Waits until the feed is actually LIVE, using screenshots rather than the inspector.
 *
 * The inspector is the wrong tool here twice over. It is unreliable on this app — `uiautomator dump`
 * comes back `Killed`, and the farm's ui-server has answered `did not respond within 3000ms` mid-run
 * — and worse, `find({desc:'Beranda'})` is answered `rejected-oversized` (matches=1): the node
 * exists but fills the screen, and `find()` refuses those (plan 60 §3.1). That outcome NEVER
 * succeeds on retry, so the polling loop that used to live here burned ~50 seconds at the start of
 * every run for an answer it could never get.
 *
 * A playing video is a better readiness signal than any selector: if two screenshots a second apart
 * differ, something is animating, which on this app means the feed is up and rendering. A splash
 * screen, a frozen load, or the launcher all sit still. Cheap, honest, and it works on any locale.
 */
async function waitForLiveFeed(ctx: ScriptContext<unknown>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  let previous: Uint8Array | null = null
  while (Date.now() < until) {
    const current = await snapshot(ctx)
    if (current && previous && !bytesEqual(previous, current)) return true
    previous = current
    await sleep(900)
  }
  return false
}

/**
 * A screenshot that answers `null` instead of throwing.
 *
 * `screenshot()` goes through whichever inspector the session picked, and the ui-server's own budget
 * is 10s. That is generous when the device is idle — the endpoint answers in about half a second —
 * and not generous at all in the seconds after `app.launch()`, when the phone is saturated bringing
 * an app up. Polling into that window with a bare `screenshot()` killed a whole run on one slow
 * call. A missing frame is not a failure; it is one poll that has nothing to say yet.
 */
async function snapshot(ctx: ScriptContext<unknown>): Promise<Uint8Array | null> {
  try {
    return await ctx.device.screenshot()
  } catch {
    return null
  }
}

/**
 * Force-stop, launch, and give the app time to settle — the one place a restart is spelled out, so
 * `prepare` and the mid-run recovery cannot drift apart.
 *
 * The wait is a poll on the inspector when it answers, and a plain settle when it does not. That is
 * deliberately weaker than the repo's usual "always poll, never sleep" rule, and the reason is
 * written above `clearBlockingDialog`: on this device the inspector is not dependable enough to
 * gate a run on. Progress is verified afterwards by screenshot instead, which needs nothing.
 */
async function relaunch(ctx: ScriptContext<unknown>, pkg: string): Promise<void> {
  await ctx.device.app.forceStop(pkg)
  await ctx.device.app.launch(pkg)
  // Let the launch get past its own storm before asking the device for anything. Polling straight
  // into it is what timed the inspector out; four seconds of patience costs less than a dead run.
  await sleep(4_000)
  if (!(await waitForLiveFeed(ctx, 40_000))) {
    ctx.log.warn('nothing on screen changed within 40s of launching — continuing anyway, the run will report if it cannot advance')
  }
}

/** How many times one scroll run will put TikTok back on screen before it reports the feed as blocked. */
const MAX_FOREGROUND_RELAUNCHES = 2

/**
 * Is TikTok still the app on screen? (1.49.2)
 *
 * An unanswered dump reads as YES on purpose: the inspector is not dependable on this app (see
 * `clearBlockingDialog`), and a failed reading is not evidence that the app left. The caller only
 * uses this to choose between a relaunch and an error it was about to throw anyway, so the
 * conservative answer costs nothing and a wrong `false` would restart a perfectly healthy feed.
 */
async function inTikTok(ctx: ScriptContext<unknown>): Promise<boolean> {
  try {
    const tree = await ctx.device.dump()
    return flatten(tree).some((n) => n.packageName === TIKTOK_PACKAGE && n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top)
  } catch {
    return true
  }
}

/**
 * Five parameters — the original three, plus `commentChance` and `idlePauseSeconds`, pulled
 * back OUT of the constants below now that plan 95's vocabulary gives them a control that can
 * actually hold them: a `kind: 'chance'` slider (fixed to [0,1], so there is no 0–100 vs 0–1
 * mixup to get wrong) and an ordered `kind: 'duration'` range (`ui()`'s own worked example).
 * Everything else that used to sit here stays a constant dressed as nothing — `relaunch`,
 * `stopOnFinish`, `screenshotEvery`, `seed`, `package` — because there is still no form control
 * that would let an operator reason about them, which is the actual bar, not "is it a number".
 *
 * `commentProbe` (the sixth candidate) stays deleted: it was an enum whose default the OLD run
 * form failed to apply, so pressing Run with nothing touched submitted an empty string and the
 * job died on a validation error before it did anything. `commentChance` does not repeat that
 * mistake — `applyDefaults` seeds a chance's default before first paint exactly like every
 * other field, and the slider cannot express an out-of-domain value to begin with.
 *
 * Declared as a named `const` (plan 97 §3.2, §5 step 97.8), not inline inside `scripts: [...]`
 * the way it read before this plan — `definePlugin`'s own array-position inference cannot carry a
 * SECOND, independent generic per element for `result` below (`plugin.ts`'s own doc comment), so
 * H1 (a wrong `run` return is a compile error) is proven at THIS declaration instead, exactly the
 * pattern `switch-account.ts`/`search-follow.ts` already use for their own members.
 */
const paramsSchema = z.object({
        videos: z
          .number()
          .int()
          .positive()
          .max(2_000)
          .default(30)
          .describe('How many videos to watch before stopping.')
          .meta(ui({ title: 'Videos', kind: 'count', group: 'Core settings' })),
        maxMinutes: z
          .number()
          .positive()
          .max(600)
          .default(20)
          .describe('Wall-clock ceiling. Whichever limit is reached first ends the run.')
          .meta(ui({ title: 'Stop after', kind: 'duration', unit: 'min', group: 'Core settings' })),
        keywords: z
          .array(z.string())
          .default(['trade', 'trading', 'xau', 'usd', 'scalping', 'swing', 'smc', 'ict'])
          .describe(
            'Words that mark a video as wanted, matched against the account name and effect tag. A match makes a long watch more likely — never certain.',
          )
          .meta(ui({ title: 'Interest keywords', group: 'Core settings' })),
        commentChance: z
          .number()
          .min(0)
          .max(1)
          .default(0.85)
          .describe(
            'Chance of opening the comment sheet to READ it on a video that matched your keywords, then closing it. It never writes, sends or likes a comment. Skipped entirely on a video that did not match.',
          )
          .meta(ui({ title: 'Open comments to read them', kind: 'chance', group: 'Interaction' })),
        idlePauseSeconds: z
          .tuple([z.number().int().min(0), z.number().int().min(0)])
          .default([25, 75])
          .describe('How long an occasional mid-feed pause lasts. Only triggers on a run long enough for a pause this size to still be a small part of it.')
          .meta(ui({ title: 'Idle pause length', kind: 'duration', unit: 's', group: 'Interaction' })),
})

// Plan 97 §3.2, §4.2, §5 step 97.8 (proves H3) — what `run()` actually
// returns (`:514+` below). Twelve scalars and one `Record<string, number>`
// — exactly H3's own claim about what a real result schema looks like: no
// `planField`/`ResultView` row needed a fourth rule for this (97.6's own
// worked-example test). `summary: true` on exactly two fields —
// `videos`/`watchSeconds` — the same worked example `result.ts`'s own doc
// comment names: `"312 videos · 42 min"`.
const resultSchema = z.object({
  videos: z
    .number()
    .int()
    .describe('How many videos were watched before the run stopped.')
    .meta(ui({ title: 'Videos watched', kind: 'count', summary: true })),
  watchSeconds: z
    .number()
    .int()
    .describe('Total time spent watching, summed across every video.')
    .meta(ui({ title: 'Total watch time', kind: 'duration', unit: 's', summary: true })),
  meanWatchSeconds: z
    .number()
    .int()
    .describe('Average watch time per video (0 when none were watched).')
    .meta(ui({ title: 'Average watch time', kind: 'duration', unit: 's' })),
  byLabel: z
    .record(z.string(), z.number().int())
    .describe('How many videos fell into each watch-length bucket (e.g. "skim", "full").')
    .meta(ui({ title: 'Watch-length buckets' })),
  backScrolls: z
    .number()
    .int()
    .describe('How many times the run scrolled back to re-watch the previous video.')
    .meta(ui({ title: 'Back-scrolls', kind: 'count' })),
  idlePauses: z.number().int().describe('How many mid-feed idle pauses were taken.').meta(ui({ title: 'Idle pauses', kind: 'count' })),
  recoveries: z
    .number()
    .int()
    .describe('How many times the feed stalled and the app had to be restarted.')
    .meta(ui({ title: 'Recoveries', kind: 'count' })),
  matched: z.number().int().describe('How many videos matched the interest keywords.').meta(ui({ title: 'Matched videos', kind: 'count' })),
  commentVisits: z
    .number()
    .int()
    .describe('How many times the comment sheet was opened.')
    .meta(ui({ title: 'Comment visits', kind: 'count' })),
  unreadable: z
    .number()
    .int()
    .describe('How many screenshots the run could not read a signal from.')
    .meta(ui({ title: 'Unreadable frames', kind: 'count' })),
  endedOnStall: z
    .boolean()
    .describe('Whether the run gave up after three consecutive swipes changed nothing.')
    .meta(ui({ title: 'Ended on stall' })),
  dialogSweeps: z
    .number()
    .int()
    .describe('How many times a blocking dialog was swept away mid-run.')
    .meta(ui({ title: 'Dialog sweeps', kind: 'count' })),
  seed: z.number().int().describe('Replaying with this seed reproduces the exact same sequence.').meta(ui({ title: 'Seed' })),
})

// Declared as a named `const`, not inline inside `scripts: [...]` (plan 97
// §3.2, §5 step 97.8) — see `paramsSchema`'s own doc comment above for why:
// `definePlugin`'s array-position inference cannot carry this member's own
// `result` generic, so H1 is proven HERE instead, at the declaration.
export const autoScrollScript: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'auto-scroll',
  title: 'Auto-scroll the feed',
  description:
    'Opens TikTok and scrolls the feed with randomised watch times, gesture strength, occasional re-watches, back-scrolls and idle pauses. Never likes, follows, or comments.',
  /** Plan 310 §3.3 — the script's own icon; `node.icon` (same value) stays as a fallback read for a core older than this plan. */
  icon: 'activity',
  node: { category: 'device', icon: 'activity', summary: ['videos', 'keywords'], keywords: ['scroll', 'feed', 'watch'] },
  result: resultSchema,
  params: paramsSchema,
  // The wall-clock ceiling plus generous slack for launch, settling, and the long-idle bucket.
  timeout: 60 * 60_000,

  async prepare(ctx) {
        await relaunch(ctx, TIKTOK_PACKAGE)
        // Poll for the feed rather than sleeping a guessed number of seconds: the splash screen
        // took ~10s on the device this was written against, and a fixed sleep is either wrong on a
        // slower device or wasted on a faster one. `Beranda` (bottom-nav home) is the first thing
        // that proves the feed is really up, not just that the process started.
      },

      async run(ctx) {
        // Was `seed`: useful for replaying a run, useless as something to type. Minted here and
        // RETURNED in the result, so a run can still be reproduced exactly — by reading it back,
        // not by inventing one up front.
        const seed = Math.floor(Math.random() * 0xffffffff)
        // Was `commentProbe` + two hardcoded chances; the matched half is now `ctx.params.commentChance`
        // (plan 95's `kind: 'chance'`). The unmatched half stays fixed, deliberately much lower: comments
        // are opened mostly on videos that matched and occasionally on ones that did not — never opening
        // them on an ordinary video draws a straight line between "matched" and "engaged", which is
        // itself a pattern, so a small constant chance stays even when the matched chance is turned down.
        const COMMENT_CHANCE = 0.15
        const rng = makeRng(seed)
        const deadline = Date.now() + ctx.params.maxMinutes * 60_000

        // No selector precheck. See `waitForLiveFeed` for why asking the inspector here cost ~50s
        // and could never have succeeded. `prepare` has already waited for motion when it relaunched;
        // whether the feed really advances is proved below, by the screenshot check, on every swipe.

        const watched: { label: string; ms: number }[] = []
        let stalled = 0
        let backScrolls = 0
        let idlePauses = 0
        let recoveries = 0
        let matched = 0
        let commentVisits = 0
        let unreadable = 0
        let consecutiveBlind = 0
        let dialogSweeps = 0
        let foregroundRelaunches = 0
        let before = await snapshot(ctx)
        if (!before) throw new Error('could not take a first screenshot — the inspector never answered')
        const frame = pngSize(before)
        if (!frame) throw new Error('could not read the frame size from the screenshot PNG — cannot aim a swipe safely')
        ctx.log.info('frame size read from the screenshot', frame)

        for (let i = 0; i < ctx.params.videos; i++) {
          if (Date.now() >= deadline) {
            ctx.log.info(`stopping at the ${ctx.params.maxMinutes}-minute ceiling after ${i} videos`)
            break
          }

          /*
            A keyboard over the feed is not a dialog (1.49.0): the sweep ladder below looks for ack and
            deny buttons and finds none, so a phone whose comment field took focus sat there spamming
            the same reading. BACK closes a keyboard and nothing else when one is up, so it is safe to
            press for exactly that.
          */
          try {
            const before = await ctx.device.dump()
            if (keyboardWindowShowing(before)) {
              ctx.log.warn('a keyboard is up over the feed — closing it before reading the video')
              await ctx.device.key('BACK')
              await sleep(1_200)
              const after = await ctx.device.dump()
              if (commentSheetShowing(after)) {
                await ctx.device.key('BACK')
                await sleep(1_000)
              }
              recoveries += 1
            }
          } catch {
            // The inspector is unreliable on this app; the ladder below is the fallback it always was.
          }

          const signals = await readVisibleSignals(ctx)
          if (!signals.ok) unreadable += 1

          // `readVisibleSignals()` already runs every iteration for the keyword match just below,
          // so this rides along on that call instead of adding a periodic sweep or an extra
          // inspector round-trip in the happy path — reactive, not polling. It exists because the
          // screenshot stall ladder further down cannot see this failure mode at all: a modal like
          // "Item Virtual dan pembaruan Kebijakan Reward" only covers the middle of the screen, so
          // the live-stream video above it and the scrolling chat below it keep two consecutive
          // screenshots different even while the feed itself is completely stuck — `bytesEqual`
          // never fires and the swipe/relaunch ladder never gets a chance to run.
          if (signals.ok) {
            consecutiveBlind = 0
            dialogSweeps = 0
          } else {
            consecutiveBlind += 1
          }
          const dialogAction = nextDialogAction(consecutiveBlind, dialogSweeps)
          if (dialogAction === 'blocked') {
            /*
              Not every stuck feed is a modal (1.49.2). The `blocked` screenshot this branch saved on
              the owner's farm showed the phone's LAUNCHER: TikTok had left the foreground entirely —
              killed by the system, or sent home by something outside this run — and every dialog
              sweep after that was hunting for an ack button on a home screen that could never have
              one. Giving up there reports a policy notice nobody ever saw, and kills a run that was
              one relaunch from fine. So the foreground is checked once, and a phone that is simply
              not in TikTok any more gets the restart `prepare` would have given it.
            */
            if (foregroundRelaunches < MAX_FOREGROUND_RELAUNCHES && !(await inTikTok(ctx))) {
              foregroundRelaunches += 1
              recoveries += 1
              ctx.log.warn('TikTok is no longer the app on screen — relaunching instead of reporting a modal', { foregroundRelaunches })
              await ctx.artifact.screenshot('left-tiktok')
              await relaunch(ctx, TIKTOK_PACKAGE)
              consecutiveBlind = 0
              dialogSweeps = 0
              continue
            }
            // A silent `success` on a screen that has been stuck behind a modal for three sweeps
            // is worse than any thrown error — it is exactly the failure this fix exists to catch.
            ctx.log.warn('giving up: the feed never came back after repeated dialog sweeps', { dialogSweeps })
            await ctx.artifact.screenshot('blocked')
            throw new Error(
              `blocked: the feed did not recover after ${dialogSweeps} dialog-clearing sweeps — a modal (e.g. a policy-consent notice) is likely still covering the screen`,
            )
          }
          if (dialogAction === 'sweep') {
            dialogSweeps += 1
            consecutiveBlind = 0
            ctx.log.warn('feed selectors came back not-found twice in a row — sweeping for a blocking dialog', { dialogSweeps })
            await clearBlockingDialog(ctx)
            await sleep(2_000)
            // Do not swipe or watch into whatever was just covering the screen, and do not count
            // this iteration as a watched video — `watched.push` below never runs for it.
            continue
          }

          const score = scoreContent(`${signals.author} ${signals.tag}`, ctx.params.keywords, [])
          // −1 is a blocked word: tilt hard towards `skip`. 0 is "nothing matched", which is NOT the
          // same as "bad" — it stays neutral, because most of the feed is neither wanted nor unwanted.
          const tilt = score < 0 ? -0.9 : score === 0 ? 0 : Math.min(0.9, 0.45 * score)
          if (score > 0) matched += 1

          const { ms, label } = pickWatchMs(rng, tilt)
          await sleep(ms)
          watched.push({ label, ms })

          // Plan 97 §3.7, §5 step 97.8 (proves H4) — the same numbers the old
          // one-shot `ctx.log.info('finished scrolling', {...})` used to report
          // only at the very end (now replaced below), pushed LIVE after every
          // video instead. `ctx.progress` is coalesced and unpersisted — a
          // script emitting it in a loop this tight costs nothing extra, and an
          // operator watching the job detail screen sees the video count climb
          // rather than scrolling a log to find one final line.
          ctx.progress({
            videos: watched.length,
            watchSeconds: Math.round(watched.reduce((sum, w) => sum + w.ms, 0) / 1000),
            matched,
            commentVisits,
            backScrolls,
            idlePauses,
            recoveries,
          })

          // Randomised in BOTH directions — a match makes comments likely, not certain, and a
          // non-match makes them unlikely, not impossible.
          const probe = rng() < (score > 0 ? ctx.params.commentChance : COMMENT_CHANCE)
          if (probe && (await browseComments(ctx, frame, rng))) commentVisits += 1

          // A person often lets a short clip loop once before moving on — an extra dwell that is
          // NOT drawn from the same bucket, so it breaks up the distribution rather than widening it.
          if (rng() < 0.06) await sleep(Math.round(between(rng, 1_000, 4_000)))

          // Rarely: put the phone down mid-feed. This is the single biggest difference between a
          // human session and a script — a script never stops for a minute and then resumes.
          // Only on runs long enough for a minute-long pause to be a small part of the whole: on a
          // three-video run it is most of the job, which is a bad way to spend an operator's time.
          const remainingMs = deadline - Date.now()
          if (ctx.params.videos >= 10 && rng() < 0.03 && remainingMs > 180_000) {
            const [idleLoSeconds, idleHiSeconds] = ctx.params.idlePauseSeconds
            const idle = Math.round(between(rng, idleLoSeconds * 1_000, idleHiSeconds * 1_000))
            idlePauses += 1
            ctx.log.info(`idling ${Math.round(idle / 1000)}s`, { after: i + 1 })
            await sleep(idle)
          }

          // Occasionally go back to the previous video, then forward again. `up` moves the feed
          // backwards; the engine's own geometry keeps both gestures clear of the action rail.
          if (rng() < 0.05 && i > 0) {
            backScrolls += 1
            await ctx.device.fling({ direction: 'up', strength: 'hard' })
            await sleep(Math.round(between(rng, 1_500, 5_000)))
          }

          // The add-phone sheet (and any other known interruption) covers only the bottom half, so neither the blind-read
          // detector above nor the identical-frame check below ever sees it — look for it by name before every swipe.
          await dismissInterruptions(ctx).catch(() => undefined)

          await advanceFeed(ctx, frame, rng)

          // A burst of two quick skips — the "not interested, not interested" pattern.
          if (rng() < 0.07) {
            await sleep(Math.round(between(rng, 350, 900)))
            await advanceFeed(ctx, frame, rng)
          }

          // Let the next clip render before judging whether the feed moved at all.
          await sleep(Math.round(between(rng, 700, 1_400)))

          const after = await snapshot(ctx)
          if (!after) {
            // One unanswered poll proves nothing either way — do not count it as a stall, and do
            // not let it end a run that may be going perfectly well.
            unreadable += 1
            continue
          }
          if (bytesEqual(before, after)) {
            // Two identical frames a second apart mean the feed did not advance. On this device that
            // is usually one of TikTok's own modals sitting on top — the contact prompt is the one
            // seen in practice — and not a dead network. Escalate rather than keep flinging into it:
            // clear whatever is there (never granting anything), then restart the app, then give up.
            stalled += 1
            ctx.log.warn('the feed did not change after the swipe', { atVideo: i + 1, stalledSoFar: stalled })
            if (stalled === 1) {
              await clearBlockingDialog(ctx)
              await sleep(2_000)
            } else if (stalled === 2) {
              ctx.log.warn('still stuck — restarting TikTok')
              await relaunch(ctx, TIKTOK_PACKAGE)
              recoveries += 1
            } else {
              // Fails the run instead of returning a success (1.33.0): the owner found phones left on the For You feed
              // with the job reporting done. A run that could not move the feed for three swipes and a restart did not
              // do its work, and a green job hides exactly the phone that needs a look. `finish` still closes TikTok.
              ctx.log.warn('giving up: three consecutive swipes changed nothing, and a restart did not help')
              await ctx.artifact.screenshot('stalled')
              throw Object.assign(new Error(`the feed did not move after ${stalled} swipes and a restart of TikTok (after ${watched.length} videos) — see the stalled screenshot`), { code: 'E_FEED_STALLED' })
            }
            before = (await snapshot(ctx)) ?? before
            continue
          } else {
            stalled = 0
          }
          before = after

        }

        const totalMs = watched.reduce((sum, w) => sum + w.ms, 0)
        const byLabel: Record<string, number> = {}
        for (const w of watched) byLabel[w.label] = (byLabel[w.label] ?? 0) + 1

        // Plan 97 §3.7, §5 step 97.8 (proves H4) — the one-shot
        // `ctx.log.info('finished scrolling', {...})` that used to sit here is
        // gone: every number it reported was already pushed live, per video,
        // by `ctx.progress` above, and the same numbers are now also the job's
        // declared `result` (`resultSchema` below) — a human reads them off
        // the job detail screen as formatted values, not by scrolling a log.

        return {
          videos: watched.length,
          watchSeconds: Math.round(totalMs / 1000),
          meanWatchSeconds: watched.length ? Math.round(totalMs / watched.length / 1000) : 0,
          byLabel,
          backScrolls,
          idlePauses,
          recoveries,
          matched,
          commentVisits,
          unreadable,
          endedOnStall: stalled >= 3,
          // How many times a blocking dialog was swept away mid-run. There is deliberately no
          // `endedOnBlocked` counterpart to `endedOnStall`: a blocked run THROWS (see
          // `nextDialogAction`) and never reaches this return, so such a field could only ever be
          // reported false. The blocked outcome is carried by the failed job and its `blocked`
          // screenshot artifact instead — a constant in the result would just be noise.
          dialogSweeps,
          /** Replaying with this seed reproduces the exact same sequence. */
          seed: seed,
        }
      },

      /**
       * Stateless and idempotent, as the runner requires — it may run again in a fresh process
       * after a timeout kill, and `forceStop` on an already-stopped package is a no-op.
       *
       * The screenshot is taken BEFORE the app is stopped: capturing evidence of a failure and then
       * destroying the screen it happened on, in that order, is the only order that is any use.
       */
  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    // `clearRecents` too: force-stop kills the process but leaves the card in Android's task
    // switcher, so a device handed back still shows the app as if a session were open.
    await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })
  },
}

/**
 * Auto-posting settings (plan 113 §4.6, step 113.10) — plugin storage an operator changes from the
 * "content" surface's own "Auto-post settings" form (below), never a hardcoded constant and never a
 * republish. `enabled` defaults OFF: a farm that installs this pack must not start posting to real
 * accounts just because a timer exists — the timer (`AUTO_POST_POLL_MS`) always runs once the service
 * is active; `enabled`/`intervalMinutes` decide whether any one poll actually dispatches anything.
 */
const AUTO_POST_SETTINGS_KEY = 'settings:auto-post'
/** When the auto-post timer last actually dispatched jobs, unix seconds — what `intervalMinutes` is measured against. */
const AUTO_POST_LAST_RUN_KEY = 'state:auto-post-last-run'

/** 1.37.0 — the label a phone must carry to be auto-posted to; the same `tiktok` label the SMM router routes on. */
const DEFAULT_AUTO_POST_LABEL = 'tiktok'

export const AutoPostSettingsSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    intervalMinutes: z.number().int().positive().max(24 * 60),
    /**
     * 1.37.0. Defaulted, so a settings row saved before it still parses — and reads as `tiktok`, which
     * NARROWS an existing farm's auto-post to labelled phones. That is the safe direction: posting to every
     * online phone is how an unlabelled phone with some other account on it got a TikTok upload.
     */
    label: z.string().trim().min(1).max(64).default(DEFAULT_AUTO_POST_LABEL),
  })
  .strict()
type AutoPostSettings = z.infer<typeof AutoPostSettingsSchema>

const DEFAULT_AUTO_POST_SETTINGS: AutoPostSettings = { version: 1, enabled: false, intervalMinutes: 60, label: DEFAULT_AUTO_POST_LABEL }

/**
 * How often the timer WAKES UP to check the clock — not how often it posts. Deliberately much finer
 * than any sane `intervalMinutes`, so a setting an operator just changed is honoured within a minute
 * rather than only at the next multiple of the OLD interval.
 */
const AUTO_POST_POLL_MS = 60_000

/**
 * Enough of `device.list`'s own `DeviceInfoSchema` to decide eligibility, declared locally rather than
 * imported — `FarmApi.call`'s own doc comment: the farm's output shape can change under a plugin
 * published months ago, so the CALLER validates against what it needs, nothing more.
 */
const DeviceListOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      stableId: z.string(),
      status: z.string(),
      /** Any live entry (a `job`, a `control` marker, …) means something is already happening on this device. An empty list means nothing is. */
      activities: z.array(z.object({ kind: z.string() })),
      labels: z.array(z.object({ name: z.string() })).default([]),
      /** 1.37.0 — someone controlling or watching the phone in Device Control. Defaulted for a farm older than the field. */
      inUse: z.object({ control: z.boolean(), viewers: z.number().int().min(0) }).default({ control: false, viewers: 0 }),
      /** Present during the quiet period after a control marker ends. */
      lastControl: z.object({ endedAt: z.number() }).nullable().default(null),
    }),
  ),
})

type AutoPostDevice = z.infer<typeof DeviceListOutput>['items'][number]

/**
 * May auto-post queue a post job on this phone? (1.37.0, owner field report 2026-09-15.)
 *
 * Online and idle, as before — plus two rules the old check lacked. The phone must carry `label` (compared the
 * way the SMM router compares its platform label: case-insensitive, spaces ignored), because "every online
 * phone" included phones signed in to nothing on TikTok. And nobody may be using it: a `control` activity
 * exists only while input flows, so a phone someone is watching in Device Control looked idle; `inUse` says
 * so, and a `lastControl` tail is a short quiet period after they stop.
 */
export function isAutoPostEligible(
  device: Pick<AutoPostDevice, 'status' | 'activities' | 'labels' | 'inUse' | 'lastControl'>,
  label: string,
): boolean {
  if (device.status !== 'online' || device.activities.length > 0) return false
  if (device.inUse.control || device.inUse.viewers > 0 || device.lastControl !== null) return false
  const want = label.toLowerCase().replace(/\s+/g, '')
  return want.length > 0 && device.labels.some((l) => l.name.toLowerCase().replace(/\s+/g, '') === want)
}

const JobRunOutput = z.object({ jobId: z.string() })

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * One eligible device, one post job, `params: { source: 'queue' }` (§4.6). "Eligible" is read straight
 * off `device.list`'s own `status`/`activities` — `job.list` is deliberately NOT among this service's
 * declared permissions (the list is exhaustive, and `device.list` alone is already enough to answer
 * "does this device already have a running job": an `activities` entry with `kind === 'job'`). A device
 * mid-job, mid-control, offline or quarantined is skipped rather than queued behind whatever it is
 * already doing.
 */
async function runAutoPostTick(ctx: PluginServiceContext, label: string): Promise<void> {
  let devices: z.infer<typeof DeviceListOutput>
  try {
    devices = await ctx.farm.call('device.list', {}, DeviceListOutput)
  } catch (err) {
    ctx.log.warn('auto-post tick could not list devices — skipping this tick', { error: messageOf(err) })
    return
  }

  const eligible = devices.items.filter((device) => isAutoPostEligible(device, label))
  if (eligible.length === 0) {
    ctx.log.info('auto-post tick found no eligible device (online, idle, not in use, labelled)', { label })
    return
  }

  for (const device of eligible) {
    try {
      await ctx.farm.call('job.run', { scriptRef: 'tiktok/post-video@latest', deviceId: device.id, params: { source: 'queue' } }, JobRunOutput)
    } catch (err) {
      // Never let one device's refusal (offline since the list was read, no grant, whatever) stop the
      // rest — the same "one bad record must not take the others down" posture `proxy-manager`'s own
      // `startEnabled` takes with its catalogue.
      ctx.log.warn('auto-post tick could not enqueue a post job', { device: device.stableId, error: messageOf(err) })
    }
  }
}

/**
 * The timer's own tick body — reads the stored settings fresh on every poll (so a changed
 * `enabled`/`intervalMinutes` takes effect without a republish, per the step's own requirement), and
 * only actually dispatches jobs once `intervalMinutes` has genuinely elapsed since the last dispatch.
 */
async function maybeRunAutoPostTick(ctx: PluginServiceContext): Promise<void> {
  let settings: AutoPostSettings
  try {
    settings = (await ctx.storage.global.get(AUTO_POST_SETTINGS_KEY, AutoPostSettingsSchema)) ?? DEFAULT_AUTO_POST_SETTINGS
  } catch (err) {
    // A stored shape this build cannot understand must never be misread as "enabled" — fail closed,
    // exactly the posture `queue.ts`/`accounts.ts` already take on their own stored shapes.
    ctx.log.warn('auto-post settings entry has an incompatible shape — leaving auto-posting off this tick', { error: messageOf(err) })
    return
  }
  if (!settings.enabled) return

  const nowSec = Math.floor(Date.now() / 1000)
  const lastRunSec = (await ctx.storage.global.get(AUTO_POST_LAST_RUN_KEY, z.number().int().nonnegative())) ?? 0
  if (nowSec - lastRunSec < settings.intervalMinutes * 60) return

  // Stamped BEFORE dispatching: a tick slow enough to still be running (many eligible devices) must
  // not be re-entered by the next 60s poll before it has even finished.
  await ctx.storage.global.set(AUTO_POST_LAST_RUN_KEY, nowSec)
  await runAutoPostTick(ctx, settings.label)
}

export default definePlugin({
  id: 'tiktok',
  // 1.13.0 — five new members, every anchor measured on this device 2026-09-03:
  // `search-keyword`, `keyword-videos`, `live-browse`, `shop-browse`,
  // `notification-activity`, plus `gesture.ts` (verified randomised swipes — no
  // two alike, each one proven by a screenshot byte-diff). The measured facts
  // they carry: search result GRIDS and LIVE ROOMS expose nothing to the
  // inspector (verified swipes and screenshot motion, never anchor taps); the
  // shop's first-run Tokopedia gate reads "Lanjutkan" and is passed AND REPORTED;
  // the inbox badge `99+` is a nav text node; the query-input id rotated from
  // `hhu` to `ho3` (the `search.ts` geometry fallback exists for that); and the
  // "Simpan info login" sheet's refusal "Tidak sekarang" joined ACK_SELECTORS.
  // The house rule holds: nothing writes — no likes, follows, comments, or
  // purchases — the only taps are navigational and named in each member.
  // 1.14.0 — `live-browse` learned the hard way what happens INSIDE a live room:
  // two consecutive jobs (f2f45632, dd278a4c) both had the device ui-server die
  // the moment a room opened (`/screenshot/0` answering, then refusing). The run
  // now treats every screenshot in the room as optional, distinguishes "stream
  // moving" from "inspector dead" from "room still" as three separate honest
  // outcomes, leaves by BACK (a key event needs no inspector), and polls for
  // recovery before touching anything else.
  // 1.15.0 — touch AIM now jitters too: the 1.13/1.14 members tap nodes at a
  // random point inside their middle 70% (`gesture.ts` `jitteredPoint`, same
  // rule as `youtube-automation-pack`'s `insetPoint`) and grid-cell taps carry
  // a ±4% offset — the farm's `tapJitterMs` jitters the tap; this jitters where.
  // 1.15.1 — MVP 04 (plan 205): `runAutoPostTick`'s eligibility check reads
  // `device.list`'s new `activities` list instead of the old per-holder
  // field (an empty list is now what "unheld" means) — invisible to an
  // operator, since eligibility is unchanged, only what it is computed from.
  // 1.15.2 — groups rename, MVP 15 §0.1 (plan 207): `queue.ts`'s own doc
  // comment cited `clusters/dispatch.ts`, the core-side module plan 207
  // renamed to `groups/dispatch.ts` — reworded to match. No behavior change.
  // 1.16.0 — keyword tilt on `keyword-videos`: `keywords` + `keywordBoostFactor`
  // shift the DWELL toward the long buckets when the opened player's caption /
  // author text matches (the pack still never likes/follows/comments — the
  // tilt lands on watch time, the one thing this pack is allowed to vary).
  // 1.17.0 — every member is now a workflow flow-editor node (plan 303 §4.5):
  // all 11 scripts gain a `node` descriptor (category, icon, up to 3 summary
  // params, keywords) so the flow editor's palette can present them —
  // presentation only, nothing about how any member EXECUTES changes (plan
  // 300 D6, D7).
  // 1.21.0 — `search` captures the screen immediately after tapping the search
  // icon. A failure there used to carry only the page as it looked a minute
  // later, after the anchor wait and the dialog sweep, which cannot tell "the
  // tap did nothing" apart from "the tap worked and the anchor is wrong".
  // 1.20.0 — wait for the app, do not guess at it. `relaunch` settled a fixed
  // six seconds after a COLD start and every navigating script then acted on
  // an app still drawing its first feed; `shop-browse` slept another 3-5 s
  // after tapping Toko and judged the screen once. Read off the owner's farm:
  // five devices, five runs lost, the failing dumps showing the FEED rather
  // than the destination (2026-09-07). Both now poll for the surface they
  // need, with the old blind sleep kept only as the opening settle. The
  // readiness anchor is bilingual (Beranda / Home).
  // 1.19.0 — `commentChance` says what it does. Its name reads like "chance
  // of commenting", and the owner read it that way and asked for the default
  // to be 0 on the grounds that posting comments by default is dangerous
  // (2026-09-07) — a correct instinct aimed at the wrong parameter. It has
  // only ever opened the sheet to READ, and nothing in this pack types into
  // a comment box at all. The behaviour is unchanged; the label and the
  // description now say so, so nobody disables human-shaped browsing again
  // believing they are disabling posting.
  // 1.18.0 — icons, plugin and member (plan 310 §3.3): the pack declares
  // `icon: 'activity'`; every one of the 11 members that already had a
  // `node` descriptor now carries the SAME icon as a top-level field
  // (`node.icon` stays as a fallback read for a core older than this plan).
  // Cosmetic; nothing about how any member runs changed.
  // 1.51.0 — a phone stranded in Android Settings was reported as TikTok missing a tab.
  //   Production, 2026-09-18: `shop-browse` failed with "the Shop tab was not on the bottom
  //   navigation" and the artifact it saved was Android Settings — TikTok's own "Open by default"
  //   page. The nav was missing because TIKTOK WAS NOT IN FRONT, and the message accused TikTok's
  //   UI, which is where anyone reading it then goes looking. That farm had 1082 failed jobs.
  //
  //   `foreignAppOnTop` (gesture.ts) names whichever package actually covers the screen, and
  //   `navMissingReason` words the failure from it. `shop-browse` and `notification-activity` use
  //   it; the latter runs TWICE per warm-up rotation, so it was saying this twice a phone.
  //
  //   Deliberately NOT a gate. It runs only on a path that has already failed, so it cannot abort a
  //   healthy run — which matters because it keys on one package name and this pack has only ever
  //   measured `com.ss.android.ugc.trill`. On a `com.zhiliaoapp.musically` build the worst case is a
  //   sentence naming the wrong package, not a run killed for nothing. The YouTube pack has had the
  //   same guard since 0.39.14; this one never got it.
  // 1.50.0 — the comment sheet is recognised, closed with its own button, and no longer swiped
  //   across "Balas". The owner's wall, 2026-09-17: a dozen phones parked in TikTok's comments mid
  //   warm-up, several sitting on "Membalas <name>" with the farm's keyboard up — a reply this pack
  //   must never start. Comments are opened, read and closed, on every platform. Three faults, all
  //   measured against a dump of the real open sheet (`screen-comment-sheet.json`, moto g06, 720×1640,
  //   id-ID), which is also the first fixture of that screen this repo has ever had:
  //
  //   1. `commentSheetShowing` looked for a node whose whole text is "Komentar". No such node exists.
  //      The title is the COUNT — `"‎16 komentar"`, a LEFT-TO-RIGHT MARK then the number — and
  //      `trim()` does not remove U+200E, so the comparison could never hold. The predicate answered
  //      `false` on the very screen it exists to recognise, `leaveCommentSheet` returned without
  //      pressing anything, and `auto-scroll`'s recovery (which hangs its second BACK on the same
  //      predicate) never fired either. The phone then read a screen that is not the feed, round and
  //      round, which is the minute-long stall the owner saw. It now matches a CONTAINED word on the
  //      sheet's own two nodes — the counted title and the input placeholder — never on `desc` (the
  //      FEED's rail button is `desc: "Baca atau tambahkan komentar. 279 komentar"`) and never on a
  //      close button alone (every modal has one; a false positive costs a BACK on the bare feed,
  //      which leaves TikTok).
  //   2. The sheet has a real close control (`content-desc` "Tutup", clickable) and this member never
  //      used it, unlike `youtube-automation-pack`'s `COMMENTS_CLOSE_RUNGS`. `leaveCommentSheet` now
  //      taps it when no keyboard is in the way, falls back to BACK, and gets a fourth attempt.
  //   3. The swipe crossed the reply buttons. 1.49.0 moved it to 0.72h → 0.30–0.42h "because
  //      Tambahkan komentar sits at roughly 0.50–0.57h". That measurement was wrong: the input is at
  //      y1465–1519 (0.89–0.93h), and the five "Balas" buttons are at y802, y944, y1086, y1228 and
  //      y1370, x170–262 — inside the 0.25–0.7w the swipe draws from. So it dragged through three of
  //      them every pass. The band is now 0.46h → 0.26–0.36h, above the topmost one, and
  //      `comments.test.ts` asserts the old band crossed three and the new one crosses none.
  //
  //   `replyComposerShowing` is new and backs out of a composer whatever opened it, so a stray tap
  //   from any source ends in a BACK rather than a focused field. There were no tests for any of
  //   this before — not for the predicate, not for the close, not for the geometry.
  // 1.49.13 — the tree is saved at the step that actually broke, not only at the end.
  //   1.49.12 captured a dump in `list-accounts`' own failure paths, and it paid immediately — but it
  //   revealed the gap it did not close. `openSwitchAccountSheet` fails through `sheet.ts`'s
  //   `waitForAnchor`/`waitForAnyAnchor`, which saved a SCREENSHOT alone, so the screen that broke a
  //   five-screen walk was recorded as a picture while only the final `finish` artifact carried a
  //   tree. Both now save the dump beside the picture, through `captureSafe` so a dead inspector
  //   cannot replace a real error with one about the inspector.
  //   What 1.49.12's dump already established, and why this matters: on a clean PACK-DRIVEN run —
  //   no manual taps — `list-accounts-failed` was TikTok's video editor (Music, "Moss Burial", Your
  //   Story, Next, AutoCut, Effects, Filters, Stickers, Text, Video templates). I had previously
  //   blamed that editor on my own stray tap while walking the phone by hand. It is not mine. On a
  //   profile holding 10 drafts, the step that should open the settings drawer lands in a draft
  //   editor, which is exactly why the run then reports "profile drawer (Settings and privacy)
  //   never appeared".
  //   And the walk is NOT deterministic: two consecutive runs of the same version on the same phone
  //   died at different steps — once with the sheet reached but read empty, once with the editor in
  //   front. One wrong selector cannot produce both, so this is not being guessed at; the next
  //   failure will carry the dump of whichever step actually broke.
  // 1.49.12 — `list-accounts` saves the TREE when it fails, not just a picture.
  //   Not a behaviour fix: an instrumentation one, and it is here because its absence cost a
  //   diagnosis today. On 2026-09-17 the member failed with "the switch-account sheet listed no
  //   accounts at all", and the two artifacts it saved were both screenshots (identical, 115206
  //   bytes each). The picture shows the sheet OPEN and POPULATED — "Switch account",
  //   `dewi_purnama280` with its checkmark, `user2578127329501` with a 9+ badge, `Add account` —
  //   while `scanSheet` read zero rows.
  //   That rules the locale work out: rows come from `rowsById(sheetNode, 'l_z')`, an obfuscated id
  //   this app rotates between builds, and the checkmark lookup missed as well although a tick was
  //   plainly drawn — and `CHECKMARK_DESCS` has been bilingual since 1.49.8. Both readers key on the
  //   row SUBTREE. Which id that subtree carries now cannot be learned from a screenshot, so the
  //   diagnosis had to wait for the device instead of being answered from what the run already had.
  //   `captureSafe`, not `capture`: this is already a failure path, and `capture` throws when the
  //   inspector cannot dump, which would replace the accurate message with a complaint about the
  //   inspector. Adding evidence must never remove evidence.
  //   The same swap is made in `finish`, whose `ctx.error` artifact was also a screenshot alone.
  //   Worth recording as a general lesson from this day: three separate times a screenshot suggested
  //   one cause and the tree showed another — sponsored cards that were nav icons, a promo modal
  //   that was not in the tree at all, and a "missing feed" that was my own stray tap. On Compose
  //   surfaces, what a person sees and what a script can read diverge constantly.
  // 1.49.11 — the shop's category strip was missed twice over: wrong word AND wrong place.
  //   `shop-browse` reported "the shop opened neither on a consent gate nor on a readable category
  //   strip" over a perfectly good shop. The tree it saved (`shop-missing`, 297 nodes) held the
  //   strip, drawn and clickable:
  //       'All'  [14,650][78,720]   'Beauty' [417,650]   "Women's Clothing" [536,650]
  //   Both `hasShopSurface` and the strip check demanded `text === 'Semua'` AND `top` between 800
  //   and 1300. The chip reads `All` here, and it sits at y=650 — outside that band. Fixing only the
  //   word would have left the member failing and looked like a fix that did not take.
  //   The band is WIDENED, not moved, because both readings are real: 800..1300 was measured on the
  //   Indonesian build (2026-09-03), 650 on this English one (2026-09-17). 300 keeps the search bar
  //   out (y 85..139), 1400 keeps the bottom nav out (1470..1556).
  //   Worth recording what this was NOT: the failure screenshot shows a full-screen promo
  //   interstitial ("Brands Crazy Deals!") over the shop, and I diagnosed that first. The tree has
  //   no trace of it — no headline, no "Shop now", no close control — so it is drawn outside the
  //   accessibility tree and the script never saw it. Adding it to the modal register would have
  //   changed nothing. The strip check was always the cause.
  // 1.49.10 — three videos opened, and the run reported that none of them had.
  //   `keyword-videos`' `playerUp` was Indonesian-only: it required two of `Sukai video`, `Baca atau
  //   tambahkan komentar`, `Bagikan video`. On the owner's en-US moto the rail reads `Like video.
  //   1,778 likes`, `Read or add comments. 105 comments`, `Share video. 57 shares` — measured from a
  //   live dump of this phone, not translated — so the check saw nothing and the member reported
  //   `cell 2,1 opened no readable player` three times before `maxMisses` ended the run.
  //   The `miss-1` screenshot saved beside that message shows the video PLAYING: author, 2,703
  //   likes, 112 comments, the share rail, the comment bar. The taps were never the problem, and
  //   nothing in the result said so — `played: 0, misses: 3` reads as "the grid is broken" when the
  //   grid was fine.
  //   This is the eighth member this locale work has touched, and the third distinct failure SHAPE:
  //   an anchor that could not be found (1.49.8), a control that could not be found (1.49.9), and
  //   now a PROOF that could not be read. The first two failed loudly at the right place; this one
  //   blamed the wrong thing, which is the more expensive kind.
  //   Two rail controls are still required, unchanged: one alone can be drawn over a grid.
  // 1.49.9 — the rest of the English phone: the Switch account row, the results tab strip, and the
  //   Shop and Inbox tabs.
  //   1.49.8 was fixed from dumps; this one was fixed from a RUN. The whole pack was driven on the
  //   owner's moto g06 with TikTok in `en-US` and scored 4 of 9, which found three things the dumps
  //   had not:
  //   (1) `openSwitchAccountSheet` had a FOURTH anchor I missed — `waitForAnchor(…, 'Beralih akun
  //       row', BERALIH_AKUN)`. 1.49.8 made the row's SEARCH bilingual but not its WAIT, so the walk
  //       got three screens further and then died in the same way. Now `waitForAnyAnchor`. The
  //       measured-bounds tap is untouched: "Keluar" sits 98px below that row with no gap, and that
  //       is why this step may never aim at a screen fraction.
  //   (2) `search-keyword` AND `keyword-videos` both died at the results tab strip — `the "results
  //       tab strip (Teratas)"/(Video)" anchor never appeared` — after the search itself had
  //       worked. The `tab` parameter stays Indonesian, because every stored workflow and schedule
  //       already carries those values and changing them would invalidate them silently; only the
  //       selector gained the second spelling. Read off the failure screenshot: the English strip is
  //       `Ask | Top | LIVE | Videos | Users | Photos | Shop`. Note `Video` -> `VideoS`. A translated
  //       guess would have failed exactly like the bug it fixes.
  //   (3) `shop-browse` and `notification-activity` could not find their BOTTOM-NAV tabs: `Toko` and
  //       `Kotak Masuk` read `Shop` and `Inbox`. Neither showed up in a static scan of this pack,
  //       because both are built inline rather than as `desc:` literals — only running it found
  //       them. `notification-activity` is called TWICE per warm-up rotation, so an English farm
  //       lost it on every single run.
  //   That makes SEVEN of twelve members, not five: the 1.49.8 note's count was an undercount taken
  //   before the pack had ever been run in English.
  //   The `top > 1_400` nav band is kept in both: it is what stops a tab match landing on the same
  //   word elsewhere on the page, and it is not language-bound.
  // 1.49.8 — five members could not work at all on a phone whose TikTok is in English.
  //   Found by testing this pack on the owner's own moto g06, whose TikTok runs `en-US`
  //   (`cmd locale get-app-locales` says so). `list-accounts` failed twice with `the "home feed
  //   (Profil tab)" anchor never appeared` while its OWN failure screenshot showed the feed, bottom
  //   nav and all, reading "Profile". A Selector matches exactly — `{desc}`/`{text}`/`{id}`, no
  //   regex — so `{desc:'Profil'}` can never match `Profile`, and every anchor on the five-screen
  //   walk in `sheet.ts` was spelled in Indonesian only: Profil, Menu profil, Pengaturan dan
  //   privasi, Beralih akun, Lembar bawah. So were the search flow's `desc:"Cari"` icon and its
  //   `text:"Cari"` submit fallback. That is `list-accounts`, `switch-account`, `search-keyword`,
  //   `keyword-videos` and `search-follow` — five of twelve — dead on any farm whose app is not in
  //   Indonesian, with no test in this repo able to see it: the suite was 362 green before this fix
  //   and 362 green after, which is why this commit adds the failing cases it lacked.
  //   `gesture.ts` had already solved this for the feed tab (`HOME_TAB`, both spellings, tried in
  //   turn) and `post-video.ts` had worked around it at each call site (`[descOf(PROFIL_TAB),
  //   'Profile']`). Neither reached the constants themselves, so the two members that use them
  //   directly were the ones left behind. They are ladders now, with `waitForAnyAnchor` splitting
  //   the caller's timeout across the spellings so a second language cannot double how long a
  //   genuinely-missing anchor takes to report.
  //   The en spellings are measured, not translated — read off this phone's dumps: 'Profile' (live
  //   feed, 2026-09-17), 'Profile menu', 'Settings and privacy', 'Switch account', 'Bottom sheet',
  //   'Add account', 'Checkmark'.
  //   One of these was worse than a red job: `TAMBAH_AKUN_DESC` DROPS the "Tambah akun" row so it
  //   can never be a switch target. Unmatched, it stayed in the list as an ordinary account row —
  //   `switch-account` tapping "row N" could tap "Add account" and walk into the sign-in flow. A
  //   wrong tap beats a loud failure every time, and not in a good way.
  //   Still open, deliberately: `search-keyword`'s `tab` enum is `['Teratas','Video','Pengguna',
  //   'LIVE']` — an operator-facing parameter, not just a selector. Its English spellings have not
  //   been read off the device yet, and guessing them is exactly how this bug was born.
  // 1.49.7 — the timing kit is the SDK's now, not this pack's own copy.
  //   `makeRng`, `between`, the watch-time model and `planConfirmStep` existed three times over —
  //   once here, once in the Instagram pack, once in the YouTube pack — and the copies had already
  //   drifted apart, which is precisely why a fix written in one of them never reached the other
  //   two. They delegate to `@enkaku/sdk` now: `makeRng`, `between`, `pickDwellMs`,
  //   `planRevisitStep`. Nothing about the behaviour changes, and that is verified rather than
  //   claimed — the SDK's own test transcribes the implementation this file carried and compares the
  //   two step for step, four seeds and 120 rounds each, including the ORDER the rng is drawn in,
  //   which is what a seeded replay depends on. The watch-time TABLE stays here, and so does the
  //   0.01 weight floor (it is the SDK's `minWeight` argument now), because those numbers are this
  //   app's and the model around them is not. One difference worth stating rather than burying: the
  //   SDK clamps `tilt` to [-1, 1] where this copy did not — identical for every value the callers
  //   here pass, and safer outside that range, where the old code made negative weights the floor
  //   then papered over. No call site in this pack changed.
  // 1.49.6 — the second swipe stops being the same swipe, and nothing deletes at zero milliseconds.
  //   Three leftovers from the 2026-09-17 survey. (1) Both verified page-turns drew their first reach
  //   at random and then fell back to a bare constant — 0.85 and 0.6 — so any feed that needed a
  //   second push got a byte-identical gesture every time; both are ranges now. (2) `swipeUp` pinned
  //   `easing: 'linear'` on every feed swipe, which is a shape of its own on the one gesture family
  //   this pack has; it is drawn per swipe from the three the engine supports. `pullToRefresh` keeps
  //   `easeInOutCubic` deliberately — that gesture must DRAG to trigger a refresh, not flick.
  //   (3) `clearCaptionField` sent every DEL back to back with no delay whatsoever. A hand does
  //   produce a fast repeat, because a person holds the key and Android repeats it; what it never
  //   produces is a perfectly even zero, so the strokes are jittered with a longer beat every dozen,
  //   as if the key were released and pressed again. `notification-activity` also pauses to read
  //   between scrolls, the way `shop-browse` in this same pack already did.
  // 1.49.5 — the aim comes from the SDK now, and a search is typed like a person types. A survey of
  //   this pack against the Instagram and YouTube packs (2026-09-17) found all three carrying their own
  //   copy of the same jitter helper, each drawing from `Math.random` — so a seeded run replayed every
  //   decision it made except where it tapped. `jitteredPoint` is now `aimInside` from `@enkaku/sdk`,
  //   one home for the rule, and the five call sites in `notification-activity` and `shop-browse` pass
  //   the run's own rng, so their taps replay with everything else. `search.ts` also stops typing at a
  //   flat cadence: the SDK's `human` mode adds the beat at the end of a word and the occasional pause
  //   to think, the same thing the caption path has done since 1.46. Typos stay OFF in search — a
  //   backspace edits TikTok's suggestion list under the cursor, and what gets committed is then not
  //   what was typed. The caption keeps its 4% because that field has no such list.
  // 1.49.4 — the emoji diagnosis wins on the second round too. Production #27 (2026-09-16) lost exactly one
  //   character of its caption — a 📊 the `scrcpy-text` path cannot carry, because that phone's active keyboard
  //   is its own and not the guest agent's — and because the mismatch was noticed on round 2, the run reported
  //   the generic "the field holds X but the caption to post is Y" and asked the operator to spot the difference
  //   between two nearly identical strings. The round a mismatch is seen on says nothing about its cause: when
  //   the ONLY difference is characters the typing path cannot carry, that is the answer either time, and the
  //   answer names the fix (make the guest agent keyboard active on that phone).
  //   Also in 1.49.4: when the camera's gallery button cannot be found, the failure now carries where the
  //   capture-mode strip sits and which clickables share its row. Production #73 (2026-09-16) hit that
  //   branch on a build with neither `upload_hot_area` nor anything clickable left of "POST", and the
  //   message named only the two things that were missing — nothing a third anchor could be built from,
  //   on a farm that was hours from being switched off. This reports what it saw; it guesses no new tap.
  // 1.49.3 — a caption that put TikTok back on the editor is walked forward again, once. Production #24
  //   (2026-09-16) typed its caption through the agent IME and the next read found the EDITOR — the saved
  //   screenshot is that screen plainly, and its dump carries `prf` "Berikutnya", the button this flow
  //   already presses by its own bounds because TikTok draws it unclickable. The post screen was one tap
  //   forward and the run reported it gone. `enterCaption` now presses it once, waits for the post screen
  //   the ordinary way, and types into the field that comes back; a second visit, or any other screen, is
  //   still the failure it was. Nothing is posted on that path, so a repeat costs a caption, not a post.
  // 1.49.2 — a feed that stopped because TikTok LEFT is relaunched, not reported as a modal. The `blocked`
  //   screenshot a production auto-scroll saved (2026-09-16) showed the phone's launcher: the app was gone from
  //   the foreground, so every dialog sweep was looking for an ack button on a home screen. The branch now reads
  //   the foreground once before giving up and restarts TikTok instead, at most twice per run, which is the
  //   difference between a dead run and a two-minute gap in one.
  // 1.49.1 — a screen wait also closes what the INTERRUPTIONS register knows. Production #34 (2026-09-16, on
  //   1.49.0) failed "expected the camera screen but the dump reads unknown (no modal matched)" while TikTok's
  //   "Riwayat penonton diaktifkan" sheet covered it — a sheet `interruptions.ts` has known since 1.44.0, which
  //   `enterScreen` never consulted because it swept the MODAL register alone. It now sweeps interruptions too,
  //   but only in a round the modal register cleared nothing, and never fatally.
  // 1.49.0 — the comment sheet is left properly, and a keyboard over the feed is closed. The owner found a phone
  //   parked in TikTok's comments during a warm-up, the farm's own keyboard flickering under it: a swipe inside the
  //   sheet ended on "Tambahkan komentar…", the field took focus, and the single BACK that followed closed the
  //   KEYBOARD rather than the sheet. Swipes now end well above the input box, `leaveCommentSheet` presses BACK only
  //   while a keyboard or the sheet's own title is read on screen (never blindly — BACK on the bare feed leaves
  //   TikTok), and the scroll loop closes a keyboard it finds over the feed instead of reading the same screen again.
  // 1.48.0 — the owner's own TikTok handles are out of this pack's source and tests. They were transcribed
  //   from the hardware runs of plan 86 and had been sitting in `switch-account.ts`'s comments (which ship in the
  //   bundle) and four test files ever since; the fixtures and tests now use masked handles, the way the rest of
  //   this repo's fixtures already do. Nothing about how the pack behaves changed.
  // 1.47.0 — the "TikTok Posts" screen is gone, at the owner's request (2026-09-16): the Social Media
  //   Manager posts to every platform from one page, so a TikTok-only post queue screen was a second
  //   place to do the same job. Its "Add video", "Retry" and "Remove" actions went with it; the queue
  //   and `enqueue-video` stay (a run with `source: 'queue'` still claims from it), and "Auto-post
  //   settings" moved onto the TikTok accounts screen so auto-posting can still be turned off.
  // 1.46.1 — the videos this pack pushed onto the phone are cleaned up. Every run left its video in /sdcard/DCIM/Camera and nothing removed it (the owner, 2026-09-16: old video files pile up). Before pushing, `removeStalePushedVideos` deletes this pack's own pushed files older than six hours — never a fresh one an upload may still read, never any other file.
  // 1.46.0 — drafts are cleared AFTER posting, and `clear-drafts` cleans them on its own. The owner's decision
  //   (2026-09-16): clearing first put a profile visit and a folder walk in front of every post, and on production
  //   (2026-09-15) "the own profile could not be opened" before posting failed ~39 runs that had posted nothing. Now
  //   `post-video` clears after Post and its confirmation — a failure there is a note in the reason, never a failed run,
  //   because a retried run would post the video twice — while a dry run still only counts them up front. The new
  //   `clear-drafts` member runs the same `clearDrafts` on its own, for the Social Media Manager's "Clear drafts" menu.
  //   The param is now titled "Clear drafts after posting".
  //   And the caption is typed at a person's pace (the owner, 2026-09-16: "like a robot, or like copy and paste"): pieces
  //   of a few words through the SDK's `human` typing — a slower cadence, a longer beat at each word's end, a thinking
  //   pause every few words, the odd corrected typo (none inside a #tag/@name piece) — with the run's own varied pause
  //   between pieces, which is what still paces the guest agent's IME rung.
  // 1.45.3 — the camera's gallery button is found beside the capture-mode strip when its id is gone. The English
  //   production camera (Samsung, 2026-09-15) carried no `upload_hot_area`; 1.45.2 recognised the camera but stopped at
  //   its gallery button. Measured on the owner's moto g06 with TikTok 46.6.3 switched to English
  //   (`screen-camera-en-moto.json`): the gallery button is the clickable left of the "POST" mode label, in its row
  //   (`upload_hot_area` [0,1407][140,1512] beside "POST" [302,1429][419,1508]). `galleryButtonBesideModes` reads it
  //   that way when the id is missing; the id stays the first choice.
  //   And an after-Post sheet the sweep cannot answer no longer hides the grid for five minutes. Five phones of one
  //   production session (1.45.1) ended "unverified" behind an English `tt.widget-prompt` whose only answer was "Tidak,
  //   terima kasih": the English text is now its own entry, `tt.widget-prompt-en` ("No thanks", UNVERIFIED), and when an
  //   answer is still not found after Post, `closeUnansweredSheets` presses BACK — only while an answerable entry is read on
  //   screen, never for the security check, never on the bare feed — before the confirmation opens the profile.
  //   Finally the own profile gets two blind recoveries when its Profil tab is missing and nothing known is in front
  //   (`profilTabRecovery`; #27/#38/#39 still stopped there on 1.45.1): TikTok not in front is launched again — never
  //   force-stopped, an upload may be running — and a TikTok page with no bottom navigation is left with BACK.
  // 1.45.2 — the English camera is recognised, and the English resume-edit banner has its own answer. Production,
  //   2026-09-15, pack 1.45.1, English TikTok builds on Samsung SM-A075F. A post-video run failed "expected the camera
  //   screen but the dump reads unknown after 5 settle rounds (no modal matched)" (artifact
  //   post-video-unexpected-screen-unknown): that camera carries neither `video_record_new_scene_root` nor
  //   `upload_hot_area`, every id on it obfuscated. `detectScreen` now also reads a camera from its labels — "Record
  //   video" drawn on screen, two capture modes ("POST", "CREATE", "PHOTO", "TEXT"), and no Next button — after the
  //   post screen. The gallery button is still found only by `upload_hot_area`, which that build lacks and for which no
  //   label was read, so such a run now stops on the camera by name ("gallery button was not found") until a dump of
  //   the English camera shows the button's label. Another run failed `"tt.resume-edit" matched with policy "ack" but
  //   no on-screen node satisfied its "ack" action`: the English banner text matched, and its only answer was "Simpan
  //   draf". The banner is now two entries — `tt.resume-edit` (id-ID, "Simpan draf") and `tt.resume-edit-en` ("Save
  //   draft", UNVERIFIED) — with the same policies and the same exact-label-only rule.
  // 1.45.1 — the English wording of two dialogs, measured. Production session g-1789475048-2bac (2026-09-15, 1.45.0):
  //   5 of 6 TikTok failures were "the own profile could not be opened", all on English builds, under a sheet reading
  //   "Viewer history turned on" (#41 #44 #50) or a dialog reading "Save login for next time" with "Save login" and
  //   "Not now" (#46). The pack only had guessed English wordings for both ("Profile view history is on", "Save login
  //   info for next time"), so neither was recognised. The measured wording is now part of each identity; the sheet is
  //   still closed with BACK (its close is unlabelled) and the dialog refused with "Not now".
  // 1.45.0 — a Profil tap that was not taken is tapped again, and the "Add phone" sheet is closed with its keyboard up.
  //   Two production failures on English TikTok builds (2026-09-15, pack 1.44.0, Samsung). Job 64d97391 stopped 5 times
  //   with "the own profile could not be opened to look for drafts": it found and tapped "Profile", and both captures
  //   after the wait still showed the For You feed with nothing over it. Opening the own profile now taps the tab again,
  //   at most twice, after a short pause, while the menu is missing, the tab is still on screen and no known dialog is
  //   up. Job bf283f3d logged `sweepModals: deny "tt.phone-prompt"` four rounds running and stopped "did not settle":
  //   the sheet's phone field was focused, the farm keyboard up, and the same close was tapped four times. A sheet still
  //   up after its close was tapped is now answered with BACK first while a keyboard shows (the farm IME,
  //   `dev.enkaku.guestagent`, is now recognised as one), then its own close when readable, else BACK — in the modal
  //   sweep and in `dismissInterruptions` alike. "Continue" is never tapped and nothing is typed into the field.
  // 1.44.0 — dialogs over the feed are refused before the Profil tab is looked for. Two production sessions
  //   (2026-09-15) stopped 19 times with "the own profile could not be opened to look for drafts". Their dumps: 6 under
  //   the viewer-history sheet (known, but only closed after Profil was tapped), 4 under "Simpan info login untuk lain
  //   waktu?", 4 under "Izinkan TikTok mengakses daftar teman Facebook dan email Anda", 1 under "Izinkan lokasi
  //   presisi", and 4 where only System UI was readable (a hidden system dialog). The new interruptions carry their own
  //   refusal ("Tidak sekarang", "Jangan izinkan" — never "Simpan info login" or "OK"; the location dialog has none and
  //   is closed with BACK), and opening the own profile now closes known dialogs first, then again — with BACK for a
  //   hidden system dialog — while the tab is missing. The same dialogs over the profile are why some runs said "no
  //   readable video grid" after Post.
  // 1.43.1 — a wait for an on-screen tab reads the screen at least three times, however slow each read is, and logs
  //   why the last read failed. A moto g06 dry run on a loaded host (2026-09-15) stopped with "the own profile could
  //   not be opened to look for drafts" while "Profil" was on screen: its 10 s wait ended on the first slow read.
  // 1.43.0 — the caption field is emptied before it is typed into, or nothing is typed. The owner saw TikTok's "at most 5
  //   hashtags" alert on phones whose run had capped the caption at five (2026-09-15). The moto g06 dry run showed why:
  //   a retype cleared at most 120 characters with DEL after MOVE_END, which reaches only the end of the tapped LINE, so
  //   the 205-character caption was typed into what was left of the first — "Sambil Sambil nunggu…", two captions and
  //   ten hashtags in one field. A clear is now sized to the whole text, removes what follows the cursor with
  //   FORWARD_DEL, reads the field back, and stops with E_CAPTION_MISMATCH when text is still there. And a first
  //   typing that lost only the emoji or accents (a phone typing through scrcpy-text or adb, not the guest agent
  //   keyboard) stops at once with that reason, instead of clearing and retyping a text that can only land the same.
  // Also in 1.42.0 — the "Riwayat penonton diaktifkan" sheet over the own profile is closed. Production #9 (2026-09-15)
  //   stopped at "the own profile could not be opened to look for drafts" with that sheet (a viewer-history toggle, a
  //   "Simpan" button, an unlabelled close) hiding "Menu profil". It is a new interruption, `tt.viewer-history`, and
  //   opening the own profile now closes a known sheet with BACK and looks again — never "Simpan".
  // 1.42.0 — the profile is pulled to refresh after Post, at a person's rhythm; and TikTok's drafts dialog is
  //   recognised. The owner asked (2026-09-15) for a real refresh and less of a mechanical loop: every look after
  //   the first either pulls the open profile down to refresh it (a slow drag inside the grid, never a tap) or goes
  //   Home and back to Profil (half the time pulling there too), at jittered 4–10 s gaps, never Home twice in a row
  //   and never more than three pulls in a row. The 3/5-minute watch and "unverified, never failed" are unchanged,
  //   and nothing force-stops TikTok meanwhile. Production #17 (Samsung SM-A075F): "Clear drafts first" tapped
  //   "Hapus", TikTok asked "Hapus 1 draf?" with "Hapus" and "Pertahankan", and the run reported no confirmation
  //   and "Draf: 1" left — only "Batal"/"Batalkan"/"Cancel" counted as a dialog's refusal. "Pertahankan"/"Keep"
  //   count now, so its "Hapus" is tapped; "Pertahankan" is never tapped.
  // 1.41.0 — the profile is watched by time: at least 3 minutes after Post, 5 while the newest cell still shows an
  //   upload percentage. The owner watched production phones (2026-09-15): a new video shows on the profile only
  //   once its upload finishes, minutes after Post on a slow phone, and a run that stopped looking earlier closed
  //   TikTok and said "unverified".
  // 1.40.0 — a first post on an empty account is confirmed, and a slow upload is watched longer. The owner's
  //   production farm (2026-09-15, #12): the video went live but the run said "unverified" after 18 s. The profile
  //   read "no videos" before posting, and 1.34.0 treated that empty grid as no baseline and stopped at once.
  //   `readOwnGrid` only returns an empty grid for TikTok's own "no videos" state, so it is a baseline again and
  //   the first finished cell after it is this post. While the newest cell still shows an upload percentage the
  //   confirmation now looks up to 18 times instead of 6.
  // 1.39.0 — TikTok's contacts access is refused before every launch. The owner's production farm (2026-09-15):
  //   a warm-up sat under Android's "Izinkan TikTok mengakses kontak?", a system dialog the farm's reader cannot
  //   see, after TikTok's own "Temukan kontak" pitch. Every member that relaunches TikTok now refuses
  //   READ_CONTACTS and fixes it, so the dialog never appears; it needs a core whose deny list has contacts.
  // 1.38.0 — One UI's "Tambah ke Layar depan?" sheet is answered with "Batal". The owner's production farm
  //   (2026-09-15, Samsung): a post failed "expected the camera screen" with the launcher's confirmation for
  //   the "Kamera TikTok" widget over the feed. New register entry `tt.widget-pin` (deny → "Batal");
  //   `tt.widget-prompt` no longer matches that sheet, because its fallback could have tapped the widget.
  //   Every job also now ends with TikTok closed and the phone on its home screen (core runner hand-back).
  // 1.37.0 — auto-post leaves alone the phones people are using, and only posts to labelled phones. The owner
  //   (2026-09-15): runs reached phones that were open in Device Control. Auto-post counted a phone idle when it
  //   was online with no activity, but a `control` activity exists only while input is being sent, so a
  //   watched phone looked free — and it queued on EVERY such phone, labelled or not. It now skips a phone
  //   `device.list` reports `inUse` (controlled, or open in Device Control) or still inside its `lastControl`
  //   quiet period, and requires the `label` setting (default `tiktok`, the SMM router's own platform label).
  //   A settings row saved before this reads as `tiktok`, which narrows an existing farm's auto-post.
  //
  // 1.36.1 — the clearDrafts description fits the farm's 300-character limit. 1.36.0's was 347 characters,
  // and the farm refused to install the pack (E_PARAMS_SCHEMA_INVALID) — so nothing of 1.36.0 ever ran. A
  // test now checks every member's param descriptions against that limit.
  //
  // 1.36.0 — post-video clears the account's drafts before it posts, and stops failing on the resume-edit banner.
  //   The owner's decision (2026-09-15): the farm deletes ALL TikTok drafts on the account before posting.
  //   Deleting a draft is PERMANENT — TikTok keeps no bin for drafts — so the new `clearDrafts` param (default
  //   on) says so in its description, and a dry run never deletes: it opens the Drafts folder, reads the count,
  //   taps "Pilih" to prove the controls, backs out with "Batalkan" and reports "would delete N drafts".
  //   1. `clearDrafts` runs once per run before "+": own profile → "Draf: N" (`tv_draft`) → Drafts folder →
  //      "Pilih" → "Pilih semua" → "Hapus" → the confirmation's own "Hapus", then checks the profile shows no
  //      drafts. Anything it does not recognise backs out ("Batalkan", BACK) and stops the run with
  //      E_DRAFTS_NOT_CLEARED before anything is posted, saving the tree and a screenshot.
  //   2. 1.35.0's resume-edit walk is gone. MEASURED on the owner's moto g06 (Android 15, id-ID, 2026-09-15):
  //      "Edit" on the banner opens the editor and one BACK returns straight to the feed with NO "Buang" dialog,
  //      TikTok keeping the edit as a draft by itself; the editor's back arrow on a draft does the same, and an
  //      exported Samsung run (ids like `oju`) showed no dialog either. So 1.35.0 stopped with
  //      E_RESUME_EDIT_NO_EXIT_DIALOG on every run once a leftover edit existed. The banner is answered "Simpan
  //      draf" again — the one narrow exception `assertNeverList` allows — and `clearDrafts` deletes that draft
  //      in the same run. E_RESUME_EDIT_BANNER/UNREADABLE/NOT_OPENED/NO_EXIT_DIALOG/PERSISTS no longer exist.
  //   3. A failed run's back-out (`backOutOfEditor`) still taps "Buang" on a build that shows it, never waits
  //      on a dialog that does not come, never throws, and leaves a resume-edit banner unanswered.
  //   Not measured: what "Hapus" raises, what a profile with no drafts shows, the English strings, and any
  //   Samsung build's Drafts folder.
  //
  // 1.35.0 — post-video stops misreading the Samsung feed, types long captions in pieces, and leaves no
  // drafts behind. From 20 production debug bundles (Samsung SM-A075F/A065F, Android 15/16, id-ID, 2026-09-14).
  //   1. The feed is no longer the post screen. Any EditText used to mean "post"; the Samsung feed carries two
  //      inside its video player and the add-phone sheet one more, so a run failed "expected the camera screen
  //      but the dump reads post" (997c7cfe). The post screen now needs a caption field on the frame and
  //      outside the player AND an on-screen "Posting"; Beranda, Buat and Profil all on screen read "feed"
  //      (the own profile too), and "+" is tapped once more on "feed" as it already was on "unknown".
  //   2. A long caption no longer times out. The guest agent types one character at a time and the farm gave
  //      up after a flat 15 s — about 160 characters — while the phone kept typing (04fe3367, 4063f322). The
  //      caption is typed in pieces of at most 60 code points, cut after a space and never inside an emoji,
  //      and read back at the end as before; a failed run waits (at most 5 s) for the caption to stop
  //      changing before it presses BACK. The drivers' text.commit budget now grows with the text too — that
  //      half ships with the core, not with this pack.
  //   3. No drafts. The resume-edit banner is no longer answered "Simpan draf": the run taps "Edit", leaves
  //      the editor through its exit dialog with "Buang", relaunches, and stops by name (E_RESUME_EDIT_*) when
  //      the dialog does not come. A failed run backs out the same way. `tt.discard-draft` lost its "Simpan
  //      draf" answer, and no answer anywhere in the register — declared, locale or identity fallback — can
  //      tap "Simpan draf" or "Draf". Which build shows which dialog is known only from these bundles: on the
  //      Samsung build with ids like `oju`, BACK from the editor raised no dialog at all (4063f322).
  //   4. The Samsung empty profile ("Bagikan video kenangan", "Bagikan rutinitas harian Anda", its "Unggah"
  //      button) is recognised, so a profile with no videos no longer waits 12 s for a grid.
  //   Fixtures: screen-feed-samsung-player-edittext.json, screen-feed-samsung-phone-sheet.json and
  //   screen-post-samsung.json, from those bundles' trees.
  //
  // 1.34.2 — the resume-edit banner over the feed is answered "Simpan draf".
  // A dry run of 1.34.1 on the owner's moto (2026-09-14) stopped before the camera on
  // "Lanjut mengedit postingan ini?" (Simpan draf / Edit), left by an earlier dry run —
  // a failed production run leaves the same. It matched tt.discard-draft (same button)
  // with policy abort. A new tt.resume-edit entry recognises the banner on screen and
  // taps "Simpan draf" (the draft stays, nothing is posted); tt.discard-draft no longer
  // matches while that banner is up (fixture screen-feed-resume-edit-banner.json).
  //
  // 1.34.1 — post-video leaves evidence, and closes a sheet over the feed before it reads or taps the feed. A
  // production run on the SM-A065F/SM-A075F fleet (2026-09-14) failed "expected the camera screen but the dump reads
  // unknown (cleared: tt.phone-prompt)" with an ordinary feed in its only screenshot, and no tree to read.
  //   1. Every failure path saves the tree (`post-video-<label>` JSON) beside its screenshot, and so do a feed that
  //      never appeared after launch (`feed-not-ready`), a Profil tab that could not be found (`profil-tab-missing`)
  //      and a profile that did not open (`profile-not-open`).
  //   2. Known modals are swept over the feed before the profile is read and before "+" is tapped. The "add phone
  //      number" sheet covers the bottom nav, so the Profil tab was not found and the blind "+" tap landed on the
  //      sheet; the camera's own sweep then closed it and left the feed, which the classifier calls "unknown". When
  //      that sweep closes a sheet and the feed's nav is back on screen, "+" is now tapped once more, and a camera
  //      failure after the phone sheet was closed says the account may need a phone number.
  //   3. "+" is tapped where the tree draws it when an on-screen "Buat"/"Create" sits in the middle of the bottom nav
  //      (labels unverified on hardware); otherwise the measured blind point, as before.
  //   4. Readings are more tolerant: a tab matches its label followed by more ("Profil, 2 notifikasi"), or a text that
  //      is exactly the label; a node one or two pixels past the frame edge is rounding, not a page off to the side.
  //   5. `tt.phone-prompt` is identified and answered only from nodes drawn on screen, so a copy kept in the tree
  //      off to the side can no longer have some other close tapped for it.
  //
  // 1.34.0 — post-video reports to the Social Media Manager only what it saw. An audit of the post path found
  // six ways to say the wrong thing, fixed together (the Instagram pack's 0.4.x readings carried over):
  //   1. No false `posted` from an unloaded grid. The profile grid was read once, 1.5 s after the header, and an
  //      unloaded grid read as "no videos" — a baseline any later cell beat. It is now polled until a labelled
  //      cell or a "no videos" state shows, and an unreadable OR empty baseline can never confirm: at most
  //      `unverified` (`judgeGrid` answers `no-baseline`).
  //   2. A caption containing "OK", "Oke", "Skip", "Lewati", "Got it" or "Not now" no longer blocks the run.
  //      `tt.notice` matched by substring, the caption field included, so "Oke banget #fyp" was tapped as a
  //      notice and the run failed `E_MODAL_STUCK`. Notice labels now match exactly, and no register entry ever
  //      matches or taps an editable field.
  //   3. The caption is read back after typing (whitespace collapsed, `#` and `@` significant), retyped once on
  //      a mismatch, and a second mismatch is `E_CAPTION_MISMATCH` before Post. The result's `caption` is what
  //      actually landed.
  //   4. Readings take only nodes inside the frame: the grid's cells, the Profil tab and the profile menu (a
  //      page kept in the tree off to the side is not the screen), and confirmation rounds go Home and back to
  //      the profile rather than re-reading the page the last round left.
  //   5. The Post tap is checked. The on-screen Post is picked; a keyboard covering it is put away by a tap on
  //      plain page above it, BACK only as the fallback while a keyboard is seen (`E_KEYBOARD_OVER_POST` if it
  //      will not go). After the tap the post screen must go away; still there with the caption, Post is tapped
  //      once more, and still there after that is `E_POST_TAP_NOT_TAKEN` — nothing was posted, re-running is
  //      safe. Only a tap known to be taken (or a post the grid proved) marks the queue entry done and the
  //      folder video posted; an unreadable one settles the queue entry `failed` with "check the profile
  //      first". An unreadable post screen before Post is `E_POST_SCREEN_UNREADABLE`, no longer waved through.
  //   6. TikTok's security check raises `E_SECURITY_CHECK` wherever `sweepModals` meets it, so `finish` leaves
  //      it on screen instead of pressing BACK and force-stopping; seen after Post, the app is left open on it.
  //
  // 1.33.0 — a feed that never moves fails the run. auto-scroll used to give up after three unmoved swipes and a
  // restart by BREAKING out of its loop and returning success, so the owner found phones left on the For You feed
  // behind green jobs (2026-09-14). It now throws E_FEED_STALLED with a `stalled` screenshot; `finish` still closes
  // TikTok, and the warm-up workflow carries on with its next activity.
  //
  // 1.32.0 — the "add phone number" sheet is closed, not swiped into. On the production SM-A075F fleet
  // (2026-09-14, id-ID and en) TikTok raised "Tambah nomor telepon" / "Add phone" over the For You feed. It
  // covers only the bottom half, so auto-scroll's blind-read and identical-frame detectors never fired and the
  // run kept swiping into it; notification-activity could not find Kotak Masuk under it. `interruptions.ts`
  // recognises it by name and taps the sheet's OWN close (never the reward badge's, never "Lanjutkan"/"Continue",
  // nothing typed), BACK if that close is unreadable — before every auto-scroll swipe, in searchFor, before the
  // inbox tap, in keyword-videos' player, and first in clearBlockingDialog. The upload register gains
  // `tt.phone-prompt` (deny), and "lanjut"/"continue" join the never-tap terms.
  //
  // 1.31.0 — nothing after Post is ever "failed", and the caption placeholder is not content. The
  // owner's production farm (2026-09-14) reported uploads that landed while the run said failed:
  // `tt.widget-prompt` — a prompt TikTok shows only AFTER accepting an upload — could not be
  // answered, the post-Post sweep threw, and the job failed, so Retry re-sent a video TikTok already
  // had. The post-Post sweep and the confirmation are now guarded: the outcome is "posted" when the
  // grid proves it and "unverified" otherwise, never "failed". Separately, an empty caption field
  // reports its placeholder ("Tambah deskripsi...") as text; clearing it sent ~60 DEL presses that
  // backed TikTok out to the camera (run 3f250632). `captionTextToClear` ignores the placeholder,
  // and the run checks it is still on the post screen before tapping anything.
  // 1.30.0 — permissions are answered before TikTok opens. On Android 14+ the system permission
  // dialog is hidden from the farm's reader, and TikTok behind it: the owner's production SM-A075F
  // fleet (2026-09-14) stopped every upload at "the dump reads unknown" under Samsung's camera
  // dialog, because nobody had ever answered it on those phones (the dev moto had been answered by
  // hand). `relaunch` now grants camera, microphone, media and notifications through the farm's
  // new `app.grantPermissions` before force-stopping and launching, so the dialog never shows. The
  // camera is GRANTED, not refused — the owner's call, and the state the moto that walked this
  // flow is in. Contacts stays refused (TikTok's own prompt, `tt.contacts`). Needs a core with
  // `app.grantPermissions`; an older core logs a warning and the run proceeds as before.
  // 1.29.0 — a caption ending in a hashtag no longer strands the run. TikTok's
  // tag-suggestion list replaces the post screen while a `#tag`/`@name` is the
  // last thing typed, so the Post button was not in the tree and the run failed
  // with nothing posted (the router's first real two-phone run, 2026-09-11,
  // caption "… #test"). One trailing space closes the list, as a person would.
  // 1.28.0 — posted means THIS post. The same day 1.27.0 shipped, the owner's
  // account showed why "the newest cell reads 0 views" was not enough: the
  // previous test post was itself still at 0 views, so it was true before the
  // run did anything. `post-video` now reads the own-profile grid BEFORE the
  // walk and confirms only when the grid has shifted by one — every earlier
  // cell pushed one place along, which nothing but a new post does. TikTok's
  // security-check sheet ("pemeriksaan keamanan"), met right after a duplicate
  // post on the same account, is a new register entry that is never tapped:
  // before the walk it stops the run as `E_SECURITY_CHECK` (nothing posted,
  // TikTok left open on the sheet for the operator); after Post it is reported
  // by name as `unverified`, so the Social Media Manager does not re-send.
  // 1.27.0 — `posted` means posted. `confirmPosted` accepted ANY grid-shaped
  // cell on the own profile as proof, and on an account that has posted
  // before there always is one. Measured 2026-09-11 (moto g06): six existing
  // videos, the upload stuck at "Mengunggah... 4%", the profile unchanged —
  // and the run reported `outcome: "posted"`. The shape test also matched the
  // bottom nav's tabs. `readNewestCell` reads the NEWEST cell's own label
  // instead: `0` views is live and the only reading worded `posted`; a
  // percentage is an upload still in flight; any other count means the newest
  // video is an older one. Everything but `0` is `unverified`, with the
  // reading in the sentence — "still uploading (4%)" is an answer an operator
  // can act on, "posted" was not.
  // 1.26.0 — the camera is the camera again. A TikTok update put
  // `tv_top_text` on the camera's "Tambah suara" pill, and `detectScreen`
  // tested for the editor first, keyed on that id — so every camera read as
  // the editor and `post-video` failed at its first screen with "expected the
  // camera screen but the dump reads editor", on a run whose tap had landed
  // and whose screen was right. The editor now needs `tv_quick_publish`, or
  // `tv_top_text` WITHOUT the gallery button (`upload_hot_area`), which no
  // editor has ever carried and every camera does. Pinned by a new fixture,
  // `screen-camera-2026-09.json`, read off the same moto g06 on 2026-09-11.
  // 1.25.0 — two honest improvements to `post-video`, neither yet proven to
  // change an outcome on hardware, because the phone under test turned out to
  // have no network at all.
  //   1. It waits for the app like every other navigating member has since
  //      1.20.0. It kept `sleep(4_000)` — less than the six seconds this pack
  //      already knew was too short — and was simply missed by that change.
  //   2. A failure now says when TIKTOK could not load, instead of blaming
  //      the screen it was looking for. Measured 2026-09-10 (moto g06): the
  //      phone's saved Wi-Fi was out of range and cellular was out of service,
  //      so TikTok drew "Ada masalah / Coba lagi nanti" over the feed, every
  //      tap went nowhere, and the run failed with "expected the camera screen
  //      but the dump reads unknown" — true, useless, and pointing at the
  //      camera, which was never the problem. `E_APP_OFFLINE` names it, in
  //      both languages this farm has seen.
  //   (1.24.0 was this same change staged mid-session with only the first
  //   half of it; nothing else shipped under that number.)
  // 1.23.0 — the post queue moves to `@enkaku/sdk`'s shared queue (plan 800).
  // The claim protocol is unchanged; what changes is that this pack no longer
  // owns a private copy of it, so Instagram and YouTube can share one instead
  // of growing two more that differ subtly. THREE operator-visible
  // consequences, none cosmetic:
  //   1. Stored entries move from a flat shape to `{ id, payload: { caption } }`,
  //      with `posted` -> `done` and `postedAt` -> `settledAt`. The service
  //      rewrites every pre-800 entry once at start, idempotently and through
  //      `setIfVersion` so a live claim is never overwritten; readers also
  //      translate on the fly, so nothing breaks in the window before it runs.
  //   2. Settling a claim now REFUSES when the claim is no longer held — the
  //      old code compare-and-swapped on a version it had just re-read, which
  //      could not detect a stale claim being reclaimed mid-run and would
  //      silently stomp the reclaiming device's write. A run slower than the
  //      30-minute stale window now logs a warning instead of overwriting.
  //   3. The Posts table reads `id` / `payload.caption` / `settledAt`, and
  //      Retry writes the new shape.
  version: '1.51.0',
  /** Plan 310 §3.3 — shown wherever this plugin is offered as a choice (the script palette's plugin page, the Plugins rail). */
  icon: 'activity',
  title: 'TikTok automation pack',
  description: 'Watch, scroll, search, browse shop and live, and read notifications on the TikTok feed, with human-shaped timing.',
  scripts: [switchAccount, searchFollow, listAccounts, postVideo, enqueueVideo, autoScrollScript, searchKeyword, keywordVideos, liveBrowse, shopBrowse, notificationActivity, clearDraftsScript],

  /**
   * Plan 113 §3.7, §4.6, §5 steps 113.5/113.10. `permissions` grew from `['fs.read']` to exactly
   * `['fs.read', 'job.run', 'device.list']` — the list is what an operator is shown and consents to
   * at install (plan 109 §4.1), and it is EXHAUSTIVE: nothing below calls a capability this array does
   * not also name. `fs.read` is `captions.ts`'s `readCaptionsFile` (step 113.8); `job.run` and
   * `device.list` are `runAutoPostTick` above, the auto-posting timer this step gives the service a
   * body for. `job.list` is deliberately absent — see `runAutoPostTick`'s own comment for why
   * `device.list`'s `activities` already answers the one question this service needs `job.list` for.
   *
   * Two consequences follow regardless of what this manifest declares (C4, C5): a declared permission
   * is still refused if the publishing user's ROLE does not hold it, and a dev slot (`enkaku dev`) has
   * no `ctx.farm` at all until this pack has been published once.
   *
   * Plan 115 §5 step 115.6 adds `fs.list` — `folder.ts`'s `listVideoCandidates` (§4.5's flow, step 1)
   * needs it, and without it here the call is refused before it runs, `E_FARM_UNDECLARED` (plan 113
   * finding C3).
   */
  service: defineService({
    permissions: ['fs.read', 'fs.list', 'job.run', 'device.list', 'device.get'],

    setup(ctx) {
      // Plan 800 — one-time, idempotent translation of every pre-800 queue entry
      // into the shared shape. Deliberately NOT awaited: `setup` must not block
      // the plugin from starting on a KV scan, and every reader already copes
      // with an unmigrated entry (`readLegacyQueueEntry`). A failure is logged
      // and nothing else — the scripts keep working either way, and the next
      // start tries again.
      void migrateLegacyQueueEntries(ctx).catch((err: unknown) => {
        ctx.log.warn('could not migrate legacy queue entries', { error: String(err) })
      })

      // Registered BEFORE the timer starts, so a `setup` that somehow throws between these two lines
      // still leaves a disposer for whatever did get created — the same ordering `proxy-manager`'s own
      // service takes with its listeners. `timer` is `null` only in that impossible window.
      let ticking = false
      let timer: ReturnType<typeof setInterval> | null = null
      ctx.onStop(() => {
        if (timer) clearInterval(timer)
      })
      timer = setInterval(() => {
        // A poll that is still running when the next one fires is skipped rather than overlapped —
        // `runAutoPostTick` awaits a farm call per eligible device, so a slow farm must not stack two
        // ticks on top of each other.
        if (ticking) return
        ticking = true
        void maybeRunAutoPostTick(ctx).finally(() => {
          ticking = false
        })
      }, AUTO_POST_POLL_MS)
    },
  }),

  /**
   * The screens this plugin contributes to Studio. `accounts` is plan 108 §4.3's own worked example,
   * built at 108.11 to prove the vocabulary against a real case before it was frozen (§8's first
   * risk).
   *
   * The "TikTok Posts" screen that plan 113 step 113.10 added is GONE since 1.47.0, at the owner's
   * request (2026-09-16): the Social Media Manager plugin posts to TikTok, YouTube and Instagram from
   * one page, so a TikTok-only post queue was a second place to do the same job. Its `addVideo`,
   * `retryItem` and `removeItem` actions went with it. The queue itself (`queue.ts`, `enqueue-video`)
   * is untouched — `post-video` still claims from it when a run asks for `source: 'queue'` — and
   * `autoPostSettings` moved onto the accounts screen, so auto-posting can still be turned off by the
   * operator who turned it on.
   *
   * Nothing below names a control, and nothing below is code: every column that needs formatting
   * states an ordinary JSON Schema node and is drawn by Studio's one `planField`/`formatValue`
   * resolver (§3.3), and every action reads the row (or the submitted form) through the closed
   * `Binding` language (§3.4) rather than through any expression an author could invent.
   *
   * The KV namespace is deliberately absent from the view — a data source can only ever read this
   * plugin's own, taken from the URL path server-side (§3.7). `accounts`' `key` is `ACCOUNTS_KEY`, the
   * same constant `list-accounts` writes and `switch-account` reads, so the screen and the scripts can
   * never drift onto two different keys.
   */
  surface: {
    nav: [
      { id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' },
    ],
    views: {
      accounts: {
        title: 'TikTok accounts',
        description: 'Which accounts are signed in on each device, as last read from the switch-account sheet.',
        // One row per ACCOUNT, not per device: `rows: 'items'` flattens the stored value's
        // `accounts` array, and `includeMissing` keeps a device that has never been synced visible
        // as a row rather than silently absent (§4.2).
        data: { kind: 'kv.scan', key: ACCOUNTS_KEY, rows: 'items', itemsAt: 'accounts', includeMissing: true },
        table: {
          rowKey: 'username',
          selectable: true,
          columns: [
            // The three ways an operator identifies a phone, in the order they narrow it down: the
            // unique id, the number printed on it, and the name it was given. `stableId` is the
            // identity the whole farm keys on (`ro.serialno` → ANDROID_ID) and the one an operator
            // can match to hardware — never the internal uuid, which means nothing to a human.
            { field: '$device.stableId', header: 'Device ID' },
            // `device_numbers`, LEFT JOINed by the scan — empty for a device with no reservation.
            { field: '$device.number', header: 'Device #', width: 'narrow' },
            { field: '$device.label', header: 'Device' },
            { field: 'username', header: 'Account' },
            { field: 'position', header: 'Slot', width: 'narrow' },
            { field: 'current', header: 'Signed in', schema: { type: 'boolean' }, width: 'narrow' },
            // `$entry.updatedAt` is unix seconds. `kind: 'timestamp'` was added to `PARAM_KINDS`
            // in step 108.7 precisely because this column found the hole: the vocabulary had
            // `duration` for a span and nothing for an instant. Studio renders it through
            // `relativeTime`; the server-side formatter writes an absolute UTC stamp, since a
            // result summary is frozen at settle and must not say "2 minutes ago" forever.
            { field: '$entry.updatedAt', header: 'Last synced', schema: { type: 'number', 'x-enkaku': { kind: 'timestamp' } } },
          ],
        },
        toolbar: ['sync', 'autoPostSettings'],
        rowActions: ['switchTo', 'syncOne'],
        empty: { title: 'No accounts read yet', hint: 'Run “Sync accounts” to read the switch-account sheet on each device.' },
      },
    },
    actions: {
      // A BATCH, because syncing is a per-device read that an operator wants across a fleet at once
      // — `name@latest` is resolved to a concrete script id server-side (§4.5, finding G7).
      sync: { kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest', target: 'picker' },
      // The SAME read as `sync`, on one device, as a job rather than a batch —
      // and the difference is not convenience. Plan 82 §3.5 refuses a dev-slot
      // script as the target of a batch (a batch pins a reference and must
      // survive the laptop closing; a dev slot expires after 30 idle minutes,
      // so a paced batch can outlive the entry it was enqueued against and die
      // mid-run with `unknown_script`). A job takes `allowDev: true` — the
      // "explicit ad-hoc run" the registry's own `script_is_dev` message names.
      // So this row is what makes `enkaku dev` on this pack a working loop, and
      // it is a better per-device affordance regardless.
      syncOne: {
        kind: 'job',
        label: 'Sync this device',
        script: 'tiktok/list-accounts@latest',
        device: 'row',
      },
      // A JOB on the row's own device, with the row's username bound as the target — which is
      // exactly the string `switch-account`'s `parseTarget` treats as a username, and which it then
      // resolves through the very entry `sync` wrote (§4.7's last hop).
      switchTo: {
        kind: 'job',
        label: 'Switch to this account',
        script: 'tiktok/switch-account@latest',
        device: 'row',
        params: { target: { $row: 'username' } },
        // A plain sentence, never a template: plan 108 §3.4 makes bindings the
        // ONLY way a declared value reaches an action, and adding interpolation
        // to this one field would be a second, weaker path to the same place.
        // Which account and which device are named by the dialog itself, from
        // the view's own `rowKey` (plan 108 §5 step 108.7).
        confirm: 'Switch this device to the selected account?',
      },

      // Plain literal key, so this one — unlike `addVideo` — needs no script behind it: `kv.set`'s
      // `key`/`value` are both ordinary bindings over the submitted form, no concatenation required
      // (§4.6's own settings block, `AUTO_POST_SETTINGS_KEY`/`AutoPostSettingsSchema` above).
      autoPostSettings: {
        kind: 'form',
        label: 'Auto-post settings',
        schema: {
          type: 'object',
          required: ['enabled', 'intervalMinutes', 'label'],
          properties: {
            enabled: {
              type: 'boolean',
              title: 'Auto-post from the queue',
              default: false,
              description: 'Off by default. Once on, the service posts one queued video per eligible device on its own clock.',
            },
            label: {
              type: 'string',
              title: 'Only phones labelled',
              default: DEFAULT_AUTO_POST_LABEL,
              minLength: 1,
              maxLength: 64,
              description: 'Posts only to online, idle phones carrying this label. A phone open in Device Control, or used in the last two minutes, is skipped.',
            },
            intervalMinutes: {
              type: 'number',
              title: 'Post every',
              minimum: 5,
              maximum: 1_440,
              default: 60,
              'x-enkaku': { kind: 'duration', unit: 'min' },
            },
          },
        },
        submitLabel: 'Save',
        then: {
          kind: 'kv.set',
          label: 'Save auto-post settings',
          scope: 'global',
          key: { $literal: AUTO_POST_SETTINGS_KEY },
          value: { version: { $literal: 1 }, enabled: { $form: 'enabled' }, intervalMinutes: { $form: 'intervalMinutes' }, label: { $form: 'label' } },
        },
      },
    },
  },
})
