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

/** Force-stop, launch, plain settle — the same ladder `relaunch` in index.ts documents: on this device the inspector is not dependable enough to gate a run on. */
export async function relaunch(ctx: ScriptContext<unknown>): Promise<void> {
  await ctx.device.app.forceStop(TIKTOK_PACKAGE)
  await ctx.device.app.launch(TIKTOK_PACKAGE)
  await sleep(6_000)
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
