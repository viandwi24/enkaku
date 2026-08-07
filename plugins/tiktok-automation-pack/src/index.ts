import { definePlugin, type ScriptContext } from '@enkaku/sdk'
import type { Selector } from '@enkaku/protocol'
import { z } from 'zod'

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

/** A small deterministic PRNG so a run can be replayed exactly — `Math.random()` cannot be seeded. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x2f6e2b1
  return () => {
    // xorshift32 — plenty for gesture jitter, not for anything that needs real entropy.
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

function between(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo)
}

/**
 * How long a person leaves one video on screen.
 *
 * A single uniform range is the tell: real watch times are heavy-tailed and lumpy. Most clips get a
 * few seconds, a fair number get abandoned almost immediately, and a small minority hold attention
 * for a long time. The weights below are a coarse model of that shape, not measured data — they
 * exist so the *distribution* is uneven, which is the property that matters.
 */
const WATCH_BUCKETS = [
  { weight: 0.12, lo: 600, hi: 1_900, label: 'skip' },
  { weight: 0.58, lo: 2_500, hi: 9_000, label: 'watch' },
  { weight: 0.22, lo: 9_000, hi: 22_000, label: 'engaged' },
  { weight: 0.08, lo: 22_000, hi: 50_000, label: 'hooked' },
] as const

/**
 * Picks a watch time, TILTED by how well the video matched — never switched by it.
 *
 * `tilt > 0` moves probability mass towards the long buckets, `tilt < 0` towards `skip`. It does
 * NOT pick a bucket outright, and that distinction is the whole design: "matched ⇒ long, unmatched
 * ⇒ short" produces a perfectly bimodal watch-time distribution with nothing in the middle, which
 * is a sharper fingerprint than no randomisation at all — no person is that consistent. Tilting the
 * weights keeps the buckets overlapping, so a matched video is sometimes abandoned in a second and
 * an unmatched one is sometimes watched to the end, exactly as happens with a real viewer.
 */
export function pickWatchMs(rng: () => number, tilt = 0): { ms: number; label: string } {
  // `skip` scales down as tilt rises and up as it falls; `engaged`/`hooked` do the opposite.
  const bias: Record<string, number> = { skip: -1, watch: 0, engaged: 0.8, hooked: 1 }
  const weights = WATCH_BUCKETS.map((b) => Math.max(0.01, b.weight * (1 + tilt * (bias[b.label] ?? 0))))
  const total = weights.reduce((sum, w) => sum + w, 0)
  const r = rng() * total
  let acc = 0
  for (let i = 0; i < WATCH_BUCKETS.length; i++) {
    acc += weights[i] as number
    if (r <= acc) {
      const b = WATCH_BUCKETS[i] as (typeof WATCH_BUCKETS)[number]
      return { ms: Math.round(between(rng, b.lo, b.hi)), label: b.label }
    }
  }
  const last = WATCH_BUCKETS[WATCH_BUCKETS.length - 1] as (typeof WATCH_BUCKETS)[number]
  return { ms: Math.round(between(rng, last.lo, last.hi)), label: last.label }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Frame size, read straight out of the PNG `screenshot()` already returns.
 *
 * `DeviceApi` exposes no frame size, and `find()` refuses the viewport-sized containers that would
 * otherwise reveal it — but every screenshot is a PNG, and a PNG's IHDR carries width and height in
 * bytes 16..24. Exact, free, and it works on any device instead of hardcoding this phone's 720×1640.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0) !== 0x89504e47) return null
  const width = dv.getUint32(16)
  const height = dv.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

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
 * Every way a runtime-permission dialog spells "deny".
 *
 * TikTok's contact prompt is NOT the Android system dialog — it is TikTok's own modal ("Temukan
 * kontak", buttons `Izinkan` / `Jangan izinkan`), so the `permissioncontroller` ids never match it.
 * They are kept anyway because a genuine system prompt can still appear, and matching one by its
 * stable id beats matching a translated label. Nothing here spells "allow".
 */
const DENY_SELECTORS: Selector[] = [
  { id: 'com.android.permissioncontroller:id/permission_deny_button' },
  { id: 'com.android.packageinstaller:id/permission_deny_button' },
  { text: 'Jangan izinkan' },
  { text: 'JANGAN IZINKAN' },
  { text: 'Tolak' },
  { text: "Don't allow" },
  { text: 'Deny' },
]

/**
 * Gets rid of whatever modal is in the way WITHOUT ever granting anything.
 *
 * Two mechanisms, in order, because on this device the first one often cannot run at all:
 *
 * 1. Tap an explicit deny button, when the inspector can see one. Preferred — it is unambiguous.
 * 2. Otherwise press BACK. Verified on hardware against the live "Izinkan TikTok mengakses kontak?"
 *    modal: one BACK closed it and returned to the feed with nothing granted. BACK is safe by
 *    construction — no Android dialog and no in-app pre-prompt treats it as consent.
 *
 * Why the fallback is not optional: `uiautomator dump` on this phone comes back **Killed** on the
 * modal screen (and intermittently on the feed too), and the farm's own ui-server answered
 * `did not respond within 3000ms` during a real run. A recovery path that depends on the inspector
 * is a recovery path that is unavailable exactly when it is needed.
 */
async function clearBlockingDialog(ctx: ScriptContext<unknown>): Promise<void> {
  for (const sel of DENY_SELECTORS) {
    try {
      if ((await ctx.device.find(sel)) === null) continue
      await ctx.device.tap(sel)
      ctx.log.warn('denied a permission prompt', { selector: JSON.stringify(sel) })
      return
    } catch {
      // Inspector unavailable — fall through to BACK rather than pretending we know what is there.
    }
  }
  ctx.log.warn('pressing BACK to clear whatever is on top — no deny button was readable')
  await ctx.device.key('BACK')
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

export default definePlugin({
  id: 'tiktok',
  version: '1.0.0',
  title: 'TikTok automation pack',
  description: 'Watch-and-scroll automation for the TikTok feed, with human-shaped timing.',
  scripts: [
    {
      id: 'auto-scroll',
      title: 'Auto-scroll the feed',
      description:
        'Opens TikTok and scrolls the feed with randomised watch times, gesture strength, occasional re-watches, back-scrolls and idle pauses. Never likes, follows, or comments.',
      /**
       * Three parameters, because three things are genuinely an operator's (or an agent's) call:
       * how long to run, when to stop, and what the feed should be nudged towards. Everything else
       * that used to sit here was either a constant dressed as a choice or a lever nobody could
       * reason about from a form — `commentProbe`, `commentChance`, `matchedCommentChance`,
       * `relaunch`, `stopOnFinish`, `screenshotEvery`, `seed`, `package`. They are set below, next
       * to the behaviour they govern.
       *
       * `commentProbe` in particular had to go: it was an enum whose default the run form failed to
       * apply, so pressing Run with nothing touched submitted an empty string and the job died on a
       * validation error before it did anything. A parameter that can fail like that, for a decision
       * nobody wanted to make, is worse than no parameter.
       */
      params: z.object({
        videos: z
          .number()
          .int()
          .positive()
          .max(2_000)
          .default(30)
          .describe('How many videos to watch before stopping.')
          .meta({ title: 'Videos' }),
        maxMinutes: z
          .number()
          .positive()
          .max(600)
          .default(20)
          .describe('Wall-clock ceiling. Whichever limit is reached first ends the run.')
          .meta({ title: 'Stop after (minutes)' }),
        keywords: z
          .array(z.string())
          .default(['trade', 'trading', 'xau', 'usd', 'scalping', 'swing', 'smc', 'ict'])
          .describe(
            'Words that mark a video as wanted, matched against the account name and effect tag. A match makes a long watch more likely — never certain.',
          )
          .meta({ title: 'Interest keywords' }),
      }),
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
        // Was `commentProbe` + two chances. Comments are opened mostly on videos that matched and
        // occasionally on ones that did not: never opening them on an ordinary video draws a
        // straight line between "matched" and "engaged", which is itself a pattern.
        const MATCHED_COMMENT_CHANCE = 0.85
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
          const score = scoreContent(`${signals.author} ${signals.tag}`, ctx.params.keywords, [])
          // −1 is a blocked word: tilt hard towards `skip`. 0 is "nothing matched", which is NOT the
          // same as "bad" — it stays neutral, because most of the feed is neither wanted nor unwanted.
          const tilt = score < 0 ? -0.9 : score === 0 ? 0 : Math.min(0.9, 0.45 * score)
          if (score > 0) matched += 1

          const { ms, label } = pickWatchMs(rng, tilt)
          await sleep(ms)
          watched.push({ label, ms })

          // Randomised in BOTH directions — a match makes comments likely, not certain, and a
          // non-match makes them unlikely, not impossible.
          const probe = rng() < (score > 0 ? MATCHED_COMMENT_CHANCE : COMMENT_CHANCE)
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
            const idle = Math.round(between(rng, 25_000, 75_000))
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

        ctx.log.info('finished scrolling', {
          videos: watched.length,
          watchSeconds: Math.round(totalMs / 1000),
          byLabel,
          backScrolls,
          idlePauses,
          recoveries,
          matched,
          commentVisits,
          unreadable,
          seed: seed,
        })

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
        await ctx.device.app.forceStop(TIKTOK_PACKAGE)
      },
    },
  ],
})
