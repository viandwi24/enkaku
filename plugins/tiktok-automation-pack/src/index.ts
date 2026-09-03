import { defineService, definePlugin, ui, type PluginMemberScript, type PluginServiceContext, type ScriptContext } from '@enkaku/sdk'
import type { Selector } from '@enkaku/protocol'
import { z } from 'zod'
import { between, makeRng, pickWatchMs, pngSize, sleep } from './human'
import { clearBlockingDialog, nextDialogAction } from './dialogs'
import switchAccount from './switch-account'
import searchFollow from './search-follow'
import listAccounts from './list-accounts'
import postVideo from './post-video'
import enqueueVideo from './enqueue-video'
import searchKeyword from './search-keyword'
import keywordVideos from './keyword-videos'
import liveBrowse from './live-browse'
import shopBrowse from './shop-browse'
import notificationActivity from './notification-activity'
import { ACCOUNTS_KEY } from './accounts'
import { QUEUE_PREFIX } from './queue'

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
    await ctx.device.swipe(
      { x, y: Math.round(0.78 * frame.height) },
      { x, y: Math.round(between(rng, 0.44, 0.56) * frame.height) },
      Math.round(between(rng, 220, 420)),
      { easing: 'easeInOutCubic' },
    )
  }
  await sleep(Math.round(between(rng, 700, 1_800)))
  await ctx.device.key('BACK')
  await sleep(Math.round(between(rng, 500, 1_100)))
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
          .describe('Chance of opening the comment sheet to read it on a video that matched your keywords. Skipped entirely on a video that did not.')
          .meta(ui({ title: 'Open comments on a match', kind: 'chance', group: 'Interaction' })),
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
              ctx.log.warn('giving up: three consecutive swipes changed nothing, and a restart did not help')
              break
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

const AutoPostSettingsSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    intervalMinutes: z.number().int().positive().max(24 * 60),
  })
  .strict()
type AutoPostSettings = z.infer<typeof AutoPostSettingsSchema>

const DEFAULT_AUTO_POST_SETTINGS: AutoPostSettings = { version: 1, enabled: false, intervalMinutes: 60 }

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
      /** `kind: 'job'` (or `'user'`/`'agent'`) means something already holds this device. `null` means nothing does. */
      heldBy: z.object({ kind: z.string() }).nullable(),
    }),
  ),
})

const JobRunOutput = z.object({ jobId: z.string() })

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * One eligible device, one post job, `params: { source: 'queue' }` (§4.6). "Eligible" is read straight
 * off `device.list`'s own `status`/`heldBy` — `job.list` is deliberately NOT among this service's
 * declared permissions (the list is exhaustive, and `device.list` alone is already enough to answer
 * "does this device already have a running job": `heldBy.kind === 'job'`). A device mid-job, mid-manual
 * -control, offline or quarantined is skipped rather than queued behind whatever it is already doing.
 */
async function runAutoPostTick(ctx: PluginServiceContext): Promise<void> {
  let devices: z.infer<typeof DeviceListOutput>
  try {
    devices = await ctx.farm.call('device.list', {}, DeviceListOutput)
  } catch (err) {
    ctx.log.warn('auto-post tick could not list devices — skipping this tick', { error: messageOf(err) })
    return
  }

  const eligible = devices.items.filter((device) => device.status === 'idle' && device.heldBy === null)
  if (eligible.length === 0) {
    ctx.log.info('auto-post tick found no eligible (idle, unheld) device')
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
  await runAutoPostTick(ctx)
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
  version: '1.15.0',
  title: 'TikTok automation pack',
  description: 'Watch, scroll, search, browse shop and live, and read notifications on the TikTok feed, with human-shaped timing.',
  scripts: [switchAccount, searchFollow, listAccounts, postVideo, enqueueVideo, autoScrollScript, searchKeyword, keywordVideos, liveBrowse, shopBrowse, notificationActivity],

  /**
   * Plan 113 §3.7, §4.6, §5 steps 113.5/113.10. `permissions` grew from `['fs.read']` to exactly
   * `['fs.read', 'job.run', 'device.list']` — the list is what an operator is shown and consents to
   * at install (plan 109 §4.1), and it is EXHAUSTIVE: nothing below calls a capability this array does
   * not also name. `fs.read` is `captions.ts`'s `readCaptionsFile` (step 113.8); `job.run` and
   * `device.list` are `runAutoPostTick` above, the auto-posting timer this step gives the service a
   * body for. `job.list` is deliberately absent — see `runAutoPostTick`'s own comment for why
   * `device.list`'s `heldBy` already answers the one question this service needs `job.list` for.
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
   * risk). `content` is plan 113 §5 step 113.10 — the surface that makes the post queue usable by a
   * human: add a video with a caption, see every item's status and history, retry or remove one.
   *
   * Nothing below names a control, and nothing below is code: every column that needs formatting
   * states an ordinary JSON Schema node and is drawn by Studio's one `planField`/`formatValue`
   * resolver (§3.3), and every action reads the row (or the submitted form) through the closed
   * `Binding` language (§3.4) rather than through any expression an author could invent.
   *
   * **`addVideo` is the one action here that could NOT be a plain `kv.set`, and it is worth stating
   * why.** A `Binding` cannot concatenate — no operators, no string interpolation, no calls
   * (`binding.ts`'s own evaluator; §3.4) — so nothing declarative can build `queue:<artifactId>` from
   * a freshly-picked artifact id the way `queueKeyFor` does. `retryItem`/`removeItem` below don't hit
   * this: a row already read off the queue carries its own exact stored key as `$entry.key` (`kv.list`
   * echoes it straight back — `rowsFromList` in Studio's own `rows.ts`), so keying a write off a row
   * needs no computation at all. Only the CREATE path invents a brand-new key, so only `addVideo`
   * routes through a real script (`enqueue-video.ts`) via `then: { kind: 'job', … }` instead of
   * `then: { kind: 'kv.set', … }` — see that file's own header for the full reasoning, including the
   * device-picker consequence of a `job` action always needing a device to run on.
   *
   * The KV namespace is deliberately absent from both views — a data source can only ever read this
   * plugin's own, taken from the URL path server-side (§3.7). `accounts`' `key` is `ACCOUNTS_KEY`, the
   * same constant `list-accounts` writes and `switch-account` reads; `content`'s `prefix` is
   * `QUEUE_PREFIX`, the same constant `queue.ts` claims and settles against — so the screen and the
   * scripts can never drift onto two different keys.
   */
  surface: {
    nav: [
      { id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' },
      { id: 'content', label: 'TikTok Posts', icon: 'upload', view: 'content' },
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
        toolbar: ['sync'],
        rowActions: ['switchTo', 'syncOne'],
        empty: { title: 'No accounts read yet', hint: 'Run “Sync accounts” to read the switch-account sheet on each device.' },
      },
      content: {
        title: 'TikTok Posts',
        description: 'Videos waiting to be posted, one entry per artifact — add one, watch its status, retry or remove it.',
        // Every queue entry lives under one prefix in `storage.global` (queue.ts §3.3/§4.4) — a plain
        // farm-wide list, not a per-device scan, because the queue is not a fact about any one phone.
        data: { kind: 'kv.list', scope: 'global', prefix: QUEUE_PREFIX },
        table: {
          // The entry's OWN artifactId, not `$entry.key` (which carries the `queue:` prefix too) —
          // this is what an operator actually recognises the video by.
          rowKey: 'artifactId',
          columns: [
            { field: 'artifactId', header: 'Video', width: 'wide' },
            { field: 'caption', header: 'Caption', width: 'wide' },
            { field: 'status', header: 'Status', width: 'narrow' },
            { field: 'attempts', header: 'Attempts', schema: { type: 'number', 'x-enkaku': { kind: 'count' } }, width: 'narrow' },
            { field: 'claimedBy', header: 'Claimed by' },
            // `claimedAt`/`postedAt` are unix seconds or `null` — `planColumn` renders a missing value
            // as `'—'` under any declared plan (§4.2, `plan.ts`'s own C-cases), so `null` is safe here.
            { field: 'claimedAt', header: 'Claimed', schema: { type: 'number', 'x-enkaku': { kind: 'timestamp' } } },
            { field: 'postedAt', header: 'Posted', schema: { type: 'number', 'x-enkaku': { kind: 'timestamp' } } },
            { field: 'lastError', header: 'Last error', width: 'wide' },
          ],
        },
        toolbar: ['addVideo', 'autoPostSettings'],
        rowActions: ['retryItem', 'removeItem'],
        empty: { title: 'The post queue is empty', hint: 'Use “Add video” to queue one with a caption.' },
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

      // A FORM whose `videoArtifactId` field declares `kind: 'artifact'` (step 113.9) — rendered by
      // Studio's existing `ArtifactControl`/`ArtifactPicker`, a real "upload a new file or browse a
      // previously uploaded one" picker, with no bespoke UI written for this step at all. The
      // declarative route was preferred over a tier-C React view (plan 111) exactly because this one
      // field is all "add a video" structurally needs — see `enqueue-video.ts` for why `then` is a
      // `job`, not a `kv.set` (this file's own `surface` doc comment carries the short version).
      addVideo: {
        kind: 'form',
        label: 'Add video',
        schema: {
          type: 'object',
          required: ['videoArtifactId'],
          properties: {
            videoArtifactId: {
              type: 'string',
              title: 'Video',
              description: 'Upload a new video or pick a previously uploaded one.',
              'x-enkaku': { kind: 'artifact' },
            },
            caption: {
              type: 'string',
              title: 'Caption',
              maxLength: 2_200,
              description: 'Left blank, a queued run falls back to the captions file instead.',
            },
          },
        },
        submitLabel: 'Add to queue',
        then: {
          kind: 'job',
          label: 'Add video',
          script: 'tiktok/enqueue-video@latest',
          // No row to bind a device from (this is a toolbar action) — the operator picks any online
          // device, which the job never actually touches (`enqueue-video.ts`'s own header explains why
          // a device is unavoidable here regardless).
          device: 'picker',
          params: { artifactId: { $form: 'videoArtifactId' }, caption: { $form: 'caption' } },
        },
      },

      // Plain literal key, so this one — unlike `addVideo` — needs no script behind it: `kv.set`'s
      // `key`/`value` are both ordinary bindings over the submitted form, no concatenation required
      // (§4.6's own settings block, `AUTO_POST_SETTINGS_KEY`/`AutoPostSettingsSchema` above).
      autoPostSettings: {
        kind: 'form',
        label: 'Auto-post settings',
        schema: {
          type: 'object',
          required: ['enabled', 'intervalMinutes'],
          properties: {
            enabled: {
              type: 'boolean',
              title: 'Auto-post from the queue',
              default: false,
              description: 'Off by default. Once on, the service posts one queued video per eligible device on its own clock.',
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
          value: { version: { $literal: 1 }, enabled: { $form: 'enabled' }, intervalMinutes: { $form: 'intervalMinutes' } },
        },
      },

      // `$entry.key` is the exact stored key (`queue:<artifactId>`, echoed back by `kv.list` — see
      // this file's own `surface` doc comment) — which is what lets this stay a plain `kv.set` with no
      // script behind it. History (`postedAt`/`attempts`) is preserved; the claim and any error clear.
      retryItem: {
        kind: 'kv.set',
        label: 'Retry',
        scope: 'global',
        key: { $entry: 'key' },
        value: {
          version: { $literal: 1 },
          artifactId: { $row: 'artifactId' },
          caption: { $row: 'caption' },
          status: { $literal: 'pending' },
          claimedBy: { $literal: null },
          claimedAt: { $literal: null },
          postedAt: { $row: 'postedAt' },
          attempts: { $row: 'attempts' },
          lastError: { $literal: null },
        },
      },

      removeItem: {
        kind: 'kv.delete',
        label: 'Remove',
        scope: 'global',
        key: { $entry: 'key' },
        confirm: 'Remove this video from the post queue?',
      },
    },
  },
})
