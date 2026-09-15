import type { ScriptContext } from '@enkaku/sdk'
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
export function jitteredPoint(node: UiNode): { x: number; y: number } {
  const { left, top, right, bottom } = node.bounds
  const w = right - left
  const h = bottom - top
  const cx = Math.round((left + right) / 2)
  const cy = Math.round((top + bottom) / 2)
  if (w <= 0 || h <= 0) return { x: cx, y: cy }
  const fx = w < 24 ? 0 : 0.15
  const fy = h < 24 ? 0 : 0.15
  return {
    x: Math.round(left + w * (fx + Math.random() * (1 - 2 * fx))),
    y: Math.round(top + h * (fy + Math.random() * (1 - 2 * fy))),
  }
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
 * exist yet), then poll for the feed itself, then give up and continue
 * anyway. Giving up is deliberate — a phone whose inspector will not answer
 * still gets its run, and the caller's own `waitForAnchor` reports what it
 * actually found, which is a better error than one invented here.
 */
export async function relaunch(ctx: ScriptContext<unknown>): Promise<boolean> {
  await answerPermissionsBeforeLaunch(ctx)
  await ctx.device.app.forceStop(TIKTOK_PACKAGE)
  await ctx.device.app.launch(TIKTOK_PACKAGE)
  await sleep(3_000)

  const deadline = Date.now() + READY_TIMEOUT_MS
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
  ctx.log.warn(`the feed did not appear within ${READY_TIMEOUT_MS / 1000}s of launching — continuing, and the next anchor will say where the device is`)
  // `false` (1.34.1) so a caller can save what the screen held instead: every member ignores it and
  // carries on exactly as before, and `post-video` saves the tree and a screenshot.
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
    easing: 'linear',
    curvature: Number(between(rng, 0, 0.06).toFixed(3)),
  })
}

/**
 * Swipe until the screen actually changes. Returns false when both attempts
 * left it byte-identical — the caller reports the stall, never hides it.
 */
export async function verifiedSwipeUp(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number): Promise<boolean> {
  for (const distance of [between(rng, 0.58, 0.78), 0.85]) {
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
  for (const distance of [between(rng, 0.28, 0.45), 0.6]) {
    const before = await snapshot(ctx)
    await swipeUp(ctx, frame, rng, distance)
    await sleep(between(rng, 1_200, 2_400))
    const after = await snapshot(ctx)
    if (before && after && !bytesEqual(before, after)) return true
  }
  return false
}
