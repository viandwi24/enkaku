import type { ScriptContext } from '@enkaku/sdk'
import { aimInside, clearTouchBlocker, foreignAppOnTop as sdkForeignAppOnTop, pick } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { between, sleep, pngSize } from './human'
import { flatten } from './tree'

/**
 * Verified, randomised gestures for the members added in 1.13.0.
 *
 * `auto-scroll`'s `advanceFeed` (index.ts) proved the geometry on hardware —
 * corridor x 0.14–0.60 of the width (the right action rail starts at x≈608 of
 * 720 = 0.84w, and its `Ikuti`/`Suka` buttons are side effects a scroll must
 * never cause), start y 0.72–0.80 of the height (the bottom nav starts at
 * y=1470 = 0.90h, measured 2026-09-03). This file re-uses that corridor and
 * adds the one thing `auto-scroll` does per-loop that a one-shot browser needs
 * per-gesture: **proof the screen moved**. A swipe whose before/after
 * screenshots are byte-identical did not scroll anything, and here — like in
 * `scroll-shorts` — it is retried harder once and then REPORTED, never counted.
 */

export const TIKTOK_PACKAGE = 'com.ss.android.ugc.trill'

/**
 * Which OTHER app is covering the screen, or `null` when TikTok is where it should be.
 *
 * ## Why this exists
 *
 * Production, 2026-09-18: `shop-browse` failed with "the Shop tab was not on the bottom navigation"
 * and the artifact it saved showed the phone sitting in **Android Settings**, on TikTok's "Open by
 * default" page. The nav was missing because TikTok was not in front — and the message accused
 * TikTok's own UI, which is where anyone reading it would then go looking. That farm had 1082
 * failed jobs; a share of them say this.
 *
 * ## Why it only ever writes a message
 *
 * This is deliberately NOT a gate. It runs on a path that has already failed, to say what is
 * actually on screen — it can never abort a healthy run, which matters because it keys on one
 * package name and this pack has only ever measured `com.ss.android.ugc.trill`. A phone carrying
 * the `com.zhiliaoapp.musically` build would look "foreign" to a naive check; used only to word an
 * error, the worst case is a sentence naming the wrong package, not a run killed for nothing.
 *
 * Shape, not a list of known intruders: any package that is not TikTok and not the system UI,
 * covering most of the screen, with no TikTok node anywhere. The launcher qualifies, which is
 * correct — that is TikTok having failed to come up at all.
 *
 * The rule itself moved to the SDK (1.52.0). It used to say it was "copied rather than imported
 * because a pack is bundled standalone" — which `aimInside` had already disproved by moving there
 * a day earlier and being imported from here ever since. What forced the move is that
 * `youtube-automation-pack` had written this function independently, with identical logic and a
 * different return type, and Instagram was about to become the third copy. `@enkaku/sdk`'s
 * `foreignAppOnTop` carries the evidence from both packs; this keeps the one-argument shape the
 * members already call.
 */
export function foreignAppOnTop(tree: UiNode): string | null {
  return sdkForeignAppOnTop(tree, TIKTOK_PACKAGE)
}

/** The bottom-nav failure, worded by what is actually on screen (2026-09-18). */
export function navMissingReason(tree: UiNode, tabName: string): string {
  const foreign = foreignAppOnTop(tree)
  return foreign === null
    ? `the ${tabName} tab was not on the bottom navigation — see the first artifact`
    : `TikTok was not in front — "${foreign}" was covering the screen, so no TikTok navigation could be there. Looking for the ${tabName} tab is the wrong question; see the first artifact.`
}

/** `screenshot()` can time out behind a busy inspector (see index.ts's `snapshot`); a missing frame is not a failure. */
export async function snapshot(ctx: ScriptContext<unknown>): Promise<Uint8Array | null> {
  try {
    return await ctx.device.screenshot()
  } catch {
    return null
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export interface Frame {
  width: number
  height: number
}

export async function frameOf(ctx: ScriptContext<unknown>): Promise<Frame> {
  const shot = await snapshot(ctx)
  const size = shot && pngSize(shot)
  if (!size) throw new Error('could not read the frame size from a screenshot — cannot aim a swipe safely')
  return size
}

/**
 * A point inside the node, never its exact centre twice.
 *
 * Same rule `youtube-automation-pack`'s `insetPoint` records: the farm jitters
 * the TAP (`tapJitterMs`), this insets the AIM — a uniform point in the middle
 * 70% of the node, so it can never leave the node onto whatever sits beside
 * it. Rails narrower than 24px on an axis keep the plain centre there.
 */
export function jitteredPoint(node: UiNode, rng?: () => number): { x: number; y: number } {
  // The rule moved to the SDK (2026-09-17): `aimInside` is this function, and the identical copies
  // the Instagram and YouTube packs carried. Three copies is how these packs drifted apart, so the
  // copy is gone. Callers with a seeded rng pass it and their taps replay with the run.
  return aimInside(node.bounds, rng)
}

/**
 * The feed's own bottom-nav entry, in both languages TikTok ships here.
 *
 * Selectors match exactly (`{desc}`/`{text}`/`{id}` — no regex), so a
 * bilingual anchor is a list to try in turn rather than one pattern. The
 * resource id would be language-proof but rotates between TikTok builds,
 * which is worse: a wrong id never matches on ANY phone.
 */
const HOME_TAB: { desc: string }[] = [{ desc: 'Beranda' }, { desc: 'Home' }]

/** How long to keep looking for the feed after a cold launch before going ahead anyway. */
const READY_TIMEOUT_MS = 25_000

/**
 * The second launch's budget, spent only when another app is proven to be holding the screen.
 * Shorter than the first on purpose: this one is not waiting on a cold start competing with
 * TikTok's own first-feed network fetch — the app has already been through that once.
 */
const RETRY_TIMEOUT_MS = 15_000

/**
 * Force-stop, launch, and WAIT FOR THE FEED — not for a fixed six seconds.
 *
 * This used to be `sleep(6_000)`, on the reasoning that the inspector is not
 * dependable enough on these phones to gate a run on. That reasoning is
 * sound and is kept below; the six seconds was the problem. Read off the
 * owner's farm (2026-09-07, SM-A075F, trace of a failed `search`):
 *
 *     0.9s  app.forceStop
 *     1.0s  app.launch
 *     7.5s  launch phase ends      ← the 6 s settle, spent
 *     8.7s  dump
 *    10.6s  tap (the search icon)  ← 9.6 s after a COLD start
 *   11.5s→26.6s  waitFor           ← the tap never navigated; 15 s wasted
 *
 * TikTok on a budget phone is drawing its first feed at ten seconds, not
 * done with it. The tap landed on an app that could not act on it yet, and
 * every anchor after that was looked for on the wrong screen. The steps that
 * PASSED in the same runs (`notification-activity`, `auto-scroll`) never
 * navigate — they scroll what is already there, which is why the fixed
 * settle held for years and only the navigating scripts failed.
 *
 * So: a short blind settle (the inspector cannot dump a window that does not
 * exist yet), then poll for the feed itself. What happens when the feed never
 * arrives depends on WHY — two unrelated faults look identical from here, and
 * 1.52.0 is where they stopped sharing one outcome:
 *
 *   - THE INSPECTOR will not answer, about an app that is perfectly up. Carry
 *     on. That restraint is the original design and it is kept deliberately:
 *     the caller's own anchor reports what it actually found, which beats any
 *     error invented here, and the phone still gets its run.
 *   - ANOTHER APP is holding the screen. Nothing downstream can work — every
 *     anchor would be looked for in someone else's UI — so launch once more
 *     before letting the run go ahead.
 *
 * `foreignAppOnTop` is what tells the two apart, and production is what asked
 * for it: phones sat on Android Settings through a whole warm-up rotation,
 * each member reporting a missing TikTok control that could not have been
 * there. 1.51.0 made those messages honest; this is the half that tries to
 * fix the phone rather than describe it.
 */
async function launchAndWait(ctx: ScriptContext<unknown>, budgetMs: number): Promise<boolean> {
  await ctx.device.app.forceStop(TIKTOK_PACKAGE)
  await ctx.device.app.launch(TIKTOK_PACKAGE)
  await sleep(3_000)

  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    for (const sel of HOME_TAB) {
      try {
        await ctx.device.waitFor(sel, { timeout: 2_000 })
        return true
      } catch {
        // Not this label, or not yet — try the other, then go round again.
      }
    }
  }
  return false
}

export async function relaunch(ctx: ScriptContext<unknown>): Promise<boolean> {
  await answerPermissionsBeforeLaunch(ctx)
  if (await launchAndWait(ctx, READY_TIMEOUT_MS)) return true

  /*
    The phone's own touch blocker (1.53.0), which `foreignAppOnTop` cannot see and must not.

    Samsung's accidental-touch protection is a full-screen System UI window that swallows every
    touch until someone swipes up. A run that meets one reads a tree with no TikTok node in it at
    all — and `foreignAppOnTop` excludes the system UI on purpose, so it answers `null` and this
    function used to report "the feed did not appear", which sent the reader to TikTok. Seven
    post-video runs on the owner's farm died that way in three days (2026-09-18), reporting the
    camera screen as "unknown".

    `clearTouchBlocker` swipes past it, which is all this case needs; the foreign-app path below is
    unchanged and still the one that answers for another APP being in front.
  */
  const blocker = await clearTouchBlocker(ctx)
  if (blocker !== null) {
    ctx.log.warn(`the phone was showing "${blocker}" instead of TikTok — swiped past it and launching once more`)
    if (await launchAndWait(ctx, RETRY_TIMEOUT_MS)) return true
  }

  let intruder: string | null = null
  try {
    intruder = foreignAppOnTop(await ctx.device.dump())
  } catch {
    // An inspector that cannot be asked IS the first case above — there is nothing to tell apart.
  }

  if (intruder === null) {
    ctx.log.warn(`the feed did not appear within ${READY_TIMEOUT_MS / 1000}s of launching — continuing, and the next anchor will say where the device is`)
    // `false` (1.34.1) so a caller can save what the screen held instead: `post-video` saves the
    // tree and a screenshot, and every other member carries on exactly as before.
    return false
  }

  ctx.log.warn(`"${intruder}" was still holding the screen ${READY_TIMEOUT_MS / 1000}s after TikTok was launched — launching once more before the run goes ahead`)
  if (await launchAndWait(ctx, RETRY_TIMEOUT_MS)) return true

  ctx.log.warn(`TikTok never came to the front — "${intruder}" held the screen through two launches. The run continues, and its first anchor will name it rather than blame a TikTok control.`)
  return false
}

/**
 * The runtime permissions TikTok asks for on the screens this pack walks: camera and microphone on
 * the create screen, media for the gallery, notifications at launch (Android 13+). Contacts is never
 * granted: it is REFUSED before launch (1.39.0), because after TikTok's own "Temukan kontak" pitch
 * Android asks "Izinkan TikTok mengakses kontak?" in a system dialog the reader cannot see
 * (production SM-A075F warm-up, 2026-09-15) — `tt.contacts` only ever answers TikTok's own pitch.
 */
const TIKTOK_PERMISSIONS = ['CAMERA', 'RECORD_AUDIO', 'READ_MEDIA_VIDEO', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VISUAL_USER_SELECTED', 'READ_EXTERNAL_STORAGE', 'POST_NOTIFICATIONS'] as const

/**
 * Answer TikTok's permission dialogs before TikTok can show them (1.30.0).
 *
 * On Android 14+ the system permission dialog is hidden from the farm's reader, and so is TikTok
 * behind it: on the owner's production SM-A075F fleet (2026-09-14) every upload stopped at
 * "the dump reads unknown" with Samsung's "Izinkan TikTok mengambil gambar dan merekam video?" on
 * screen, because nobody had ever answered it on those phones. The dev farm's moto worked only
 * because its owner had answered the same dialogs by hand. Granting through the package manager
 * before launch means the dialog is never shown, on any phone, first run or not.
 *
 * Never fatal. A core older than this capability refuses the call, and a phone where a grant does
 * not take still gets its run — the settle loop names what it finds, exactly as before.
 */
async function answerPermissionsBeforeLaunch(ctx: ScriptContext<unknown>): Promise<void> {
  try {
    const results = await ctx.device.app.grantPermissions(TIKTOK_PACKAGE, TIKTOK_PERMISSIONS)
    const granted = results.filter((r) => r.outcome === 'granted').map((r) => r.permission)
    const failed = results.filter((r) => r.outcome === 'failed')
    if (granted.length > 0) ctx.log.info('granted TikTok permissions before launch, so their dialogs never show', { granted: granted.join(', ') })
    if (failed.length > 0) ctx.log.warn('some TikTok permissions could not be granted — their dialog may still appear, hidden from this run', { failed: failed.map((f) => `${f.permission}: ${f.detail ?? ''}`).join('; ') })
  } catch (err) {
    ctx.log.warn('could not set TikTok permissions before launch — continuing; a hidden permission dialog may stop the run', { error: String(err) })
  }
  // Contacts is refused and fixed, in its own call (1.39.0): a core older than the deny list's
  // READ_CONTACTS refuses the whole call, which must not cost the grants above.
  try {
    const denied = await ctx.device.app.denyPermissions(TIKTOK_PACKAGE, ['READ_CONTACTS'])
    const failed = denied.filter((r) => r.outcome === 'failed')
    if (denied.some((r) => r.outcome === 'denied')) ctx.log.info('refused TikTok contacts access before launch, so its dialog never shows')
    if (failed.length > 0) ctx.log.warn('TikTok contacts access could not be refused — its dialog may still appear, hidden from this run', { failed: failed.map((f) => f.detail ?? '').join('; ') })
  } catch (err) {
    ctx.log.warn('could not refuse TikTok contacts access before launch — continuing', { error: String(err) })
  }
}

/** Save the current tree and a screenshot under one label — a failed run should carry its own bug report. */
export async function capture(ctx: ScriptContext<unknown>, label: string): Promise<UiNode> {
  let tree: UiNode
  try {
    tree = await ctx.device.dump()
  } catch {
    await ctx.artifact.screenshot(`${label}-dump-failed`)
    throw new Error(`the inspector could not dump the ${label} screen`)
  }
  await ctx.artifact.file(label, JSON.stringify(tree, null, 2), { ext: 'json' })
  await ctx.artifact.screenshot(label)
  return tree
}

/** Every non-empty text/description below an optional top edge, de-duplicated in first-seen order. */
export function readableStrings(tree: UiNode, minTop = 0): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of flatten(tree)) {
    for (const raw of [n.desc, n.text]) {
      const v = raw.trim()
      if (v === '' || n.bounds.top < minTop || seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/** `capture` that never throws — for screens whose inspector is dead (measured: LIVE rooms kill the ui-server mid-job). Reports whether it got through. */
export async function captureSafe(ctx: ScriptContext<unknown>, label: string): Promise<UiNode | null> {
  try {
    return await capture(ctx, label)
  } catch {
    return null
  }
}

/**
 * Poll dumps until `ready` accepts one, or the budget runs out — the dump-safe
 * sibling of `waitForAnchor`, for PREDICATES over a whole tree rather than a
 * single selector. A dump that fails (the inspector going briefly unresponsive
 * is documented in `dialogs.ts` as a hardware fact on this device) counts as
 * "not yet", never as a rejection: a gate must not fail a run because the
 * reader hiccuped.
 */
export async function readGate(
  ctx: ScriptContext<unknown>,
  ready: (tree: UiNode) => boolean,
  opts: { budgetMs: number; intervalMs?: number },
): Promise<boolean> {
  const interval = opts.intervalMs ?? 1_200
  const started = Date.now()
  for (;;) {
    try {
      if (ready(await ctx.device.dump())) return true
    } catch {
      /* not yet — see header */
    }
    if (Date.now() - started >= opts.budgetMs) return false
    await sleep(interval)
  }
}

/**
 * One UP-swipe inside the measured corridor, fully randomised: start, reach,
 * duration, horizontal drift and curvature all come from the RNG, so no two
 * swipes are the same gesture, and the `linear` release is what carries a
 * page-pager past its snap-back threshold.
 */
export async function swipeUp(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number, distance = between(rng, 0.58, 0.78)): Promise<void> {
  const x = Math.round(between(rng, 0.14, 0.60) * frame.width)
  const startY = Math.round(between(rng, 0.72, 0.80) * frame.height)
  const endY = Math.max(Math.round(0.06 * frame.height), startY - Math.round(distance * frame.height))
  const ms = Math.round(between(rng, 140, 240) * (distance < 0.5 ? 1.4 : 1))
  await ctx.device.swipe({ x, y: startY }, { x: Math.round(x + between(rng, -12, 12)), y: endY }, ms, {
    // Drawn per swipe (1.49.6). A thumb has no single acceleration curve, and `linear` on every
    // feed swipe is a shape of its own — the one gesture family this pack has, always released the
    // same way. `pullToRefresh` below keeps `easeInOutCubic` deliberately: that one must DRAG to
    // trigger the refresh, not flick.
    easing: pick(rng, ['linear', 'easeOutQuad', 'easeInOutCubic'] as const),
    curvature: Number(between(rng, 0, 0.06).toFixed(3)),
  })
}

/**
 * Swipe until the screen actually changes. Returns false when both attempts
 * left it byte-identical — the caller reports the stall, never hides it.
 */
export async function verifiedSwipeUp(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number): Promise<boolean> {
  // The retry distance is drawn too (1.49.6). It used to be the bare constant 0.85, so a feed that
  // needed a second push got a byte-identical reach every single time — the first swipe randomised,
  // the second a signature. A harder push is still a harder push; it just is not the same one twice.
  for (const distance of [between(rng, 0.58, 0.78), between(rng, 0.80, 0.92)]) {
    const before = await snapshot(ctx)
    await swipeUp(ctx, frame, rng, distance)
    await sleep(between(rng, 900, 1_600))
    const after = await snapshot(ctx)
    if (before && after && !bytesEqual(before, after)) return true
  }
  return false
}

/** A gentler, verified page-turn for CONTINUOUS lists (results grids, inbox) — 0.28–0.45 of a screen, slower release. */
export async function verifiedPageDown(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number): Promise<boolean> {
  for (const distance of [between(rng, 0.28, 0.45), between(rng, 0.55, 0.68)]) {
    const before = await snapshot(ctx)
    await swipeUp(ctx, frame, rng, distance)
    await sleep(between(rng, 1_200, 2_400))
    const after = await snapshot(ctx)
    if (before && after && !bytesEqual(before, after)) return true
  }
  return false
}

/** Where a pull starts and ends, as fractions of the frame height (1.42.0). */
export interface PullBand {
  startY: readonly [number, number]
  endY: readonly [number, number]
}

/**
 * The own profile's pull band (1.42.0) — UNVERIFIED on a profile dump: this pack has no fixture of TikTok's own
 * profile. What is measured is the bottom nav, from y=1470 of 1640 (0.90h, this file's header). So the pull starts
 * at 0.50–0.58h, low enough to be in the video grid under the profile header rather than on the header's buttons
 * and far below the status bar and the notification shade's edge, and ends at 0.76–0.84h, above the nav. A drag of
 * 0.18–0.34h is several times Android's swipe-refresh trigger distance.
 */
export const PROFILE_PULL_BAND: PullBand = { startY: [0.5, 0.58], endY: [0.76, 0.84] }

/**
 * One pull-to-refresh drag, fully randomised and pure so its geometry is testable. The corridor x 0.28–0.66 keeps
 * clear of both side edges (the system back gesture), and the slow `easeInOutCubic` release is a deliberate drag
 * that holds the list at its top — a fast flick flings instead of refreshing. A drag, never a tap.
 */
export function pullToRefreshPath(
  frame: Frame,
  rng: () => number,
  band: PullBand = PROFILE_PULL_BAND,
): { from: { x: number; y: number }; to: { x: number; y: number }; ms: number; curvature: number } {
  const x = Math.round(between(rng, 0.28, 0.66) * frame.width)
  const fromY = Math.round(between(rng, band.startY[0], band.startY[1]) * frame.height)
  const toY = Math.round(between(rng, band.endY[0], band.endY[1]) * frame.height)
  return {
    from: { x, y: fromY },
    to: { x: Math.round(x + between(rng, -18, 18)), y: toY },
    ms: Math.round(between(rng, 420, 720)),
    curvature: Number(between(rng, 0, 0.05).toFixed(3)),
  }
}

export async function pullToRefresh(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number, band: PullBand = PROFILE_PULL_BAND): Promise<void> {
  const p = pullToRefreshPath(frame, rng, band)
  await ctx.device.swipe(p.from, p.to, p.ms, { easing: 'easeInOutCubic', curvature: p.curvature })
}
