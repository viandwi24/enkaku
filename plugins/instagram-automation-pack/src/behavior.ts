import type { ScriptContext } from '@enkaku/sdk'
import { aimInside, between, makeRng, pick, pickDwellMs, planRevisitStep, type DwellBucket, type RevisitMove, type RevisitPlan, type RevisitStep } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { flatten } from './tree'

/* ── Jittered tap ───────────────────────────────────────────────────────── */

/**
 * The aim now comes from the SDK (2026-09-17): `aimInside` is the same rule this pack had inlined —
 * a uniform point in the middle 70% of the node, the plain centre on an axis under 24px — and it is
 * the same one the TikTok and YouTube packs each carried their own copy of. Three copies is how the
 * behaviour drifted apart in the first place, so the copy is gone and the rule has one home.
 *
 * `rng` is optional here for the same reason it is optional there: most callers of this helper hold
 * no rng at all (`likeFeedPost`, the story-tray tap, the whole of `search-keyword`). A member that
 * HAS a seeded rng should pass it, and its taps then replay with the rest of the run.
 */
export async function tapNodeJittered(ctx: ScriptContext<unknown>, node: UiNode, rng?: () => number): Promise<void> {
  await ctx.device.tap({ point: aimInside(node.bounds, rng) })
}

/**
 * Shared behaviour primitives for the Instagram pack.
 * Mirrors `youtube-automation-pack`'s `behavior.ts` + `tiktok-automation-pack`'s
 * `gesture.ts` + `human.ts` so every pack gets the same human-shaped randomness
 * and keyword tilt without cross-pack imports.
 */

/* ── RNG ─────────────────────────────────────────────────────────────────── */

/*
  The rng and `between` come from the SDK now (0.10.9), and are re-exported so no call site in this
  pack changes. They are not merely equivalent — the SDK's `makeRng` was checked against this one
  across 8 seeds x 2000 draws and produces the identical sequence, and its default seed constant was
  changed to this pack's `0x2f6e2b1` so even the zero case matches. A seeded run replays exactly as
  it did before.
*/
export { between, makeRng }

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ── Human dwell (heavy-tailed, same buckets YouTube & TikTok use) ──────── */

/*
  The TABLE stays here, the MODEL comes from the SDK (0.10.9).

  These four ranges are Instagram's own: a reel is not a Short and not a TikTok clip, and the numbers
  were read off this app. What was duplicated was never the table — it was the weighted draw around
  it, written three times in three packs. `pickDwellMs` takes the table as an argument for exactly
  this reason, so each pack keeps what it measured and shares only the machinery.
*/
const DWELL: readonly DwellBucket[] = [
  { label: 'skip', weight: 0.14, ms: [1_200, 3_000] },
  { label: 'watch', weight: 0.52, ms: [3_500, 10_000] },
  { label: 'engaged', weight: 0.24, ms: [10_000, 25_000] },
  { label: 'hooked', weight: 0.1, ms: [25_000, 55_000] },
]

export function pickDwell(rng: () => number): { ms: number; label: string } {
  return pickDwellMs(rng, 0, DWELL)
}

/* ── Byte-equal + frame ─────────────────────────────────────────────────── */

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0) !== 0x89504e47) return null
  const w = dv.getUint32(16), h = dv.getUint32(20)
  return w > 0 && h > 0 ? { width: w, height: h } : null
}

export interface Frame { width: number; height: number }

export async function frameOf(ctx: ScriptContext<unknown>): Promise<Frame> {
  const sz = pngSize(await ctx.device.screenshot())
  if (!sz) throw new Error('could not read frame size from screenshot')
  return sz
}

/* ── Verified random up-swipe (same corridor rule as TikTok & YouTube) ─── */

export async function verifiedSwipeUp(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number): Promise<boolean> {
  // The retry reach is drawn too (0.10.8): it used to be the bare constant 0.88, so a feed that
  // needed a second push got a byte-identical swipe every time — the first randomised, the second a
  // signature. A harder push stays a harder push; it just is not the same one twice.
  for (const dist of [between(rng, 0.55, 0.75), between(rng, 0.82, 0.94)]) {
    const before = await ctx.device.screenshot()
    const x = Math.round(between(rng, 0.14, 0.55) * frame.width)
    const sy = Math.round(between(rng, 0.68, 0.80) * frame.height)
    const ey = Math.max(Math.round(0.06 * frame.height), sy - Math.round(dist * frame.height))
    const ms = Math.round(between(rng, 140, 260))
    await ctx.device.swipe({ x, y: sy }, { x: Math.round(x + between(rng, -12, 12)), y: ey }, ms, {
      // Drawn per swipe (0.10.8) — a thumb has no single acceleration curve, and one fixed easing on
      // every reel advance is a shape of its own. `pullToRefresh` keeps `easeInOutCubic` on purpose:
      // that gesture must DRAG to trigger the refresh rather than flick past it.
      easing: pick(rng, ['linear', 'easeOutQuad', 'easeInOutCubic'] as const),
      curvature: Number(between(rng, 0, 0.06).toFixed(3)),
    })
    await sleep(between(rng, 900, 1_600))
    if (!bytesEqual(before, await ctx.device.screenshot())) return true
  }
  return false
}

/* ── Pull to refresh (0.7.0) ────────────────────────────────────────────── */

/** Where a pull starts and ends, as fractions of the frame height. */
export interface PullBand { startY: readonly [number, number]; endY: readonly [number, number] }

/**
 * The own profile's pull band, measured on `screen-profile-empty.json` (moto g06 power, 720x1640): the scrolling
 * content is `[0,168][720,1479]` — the action bar sits above it at y 70–168 (0.04–0.10h), the status bar above
 * that, and the bottom nav starts at y=1479 (0.90h). A pull starting at 0.24–0.34h (y 394–558) is inside the
 * header the list scrolls, well below the notification-shade edge, and ending at 0.70–0.80h (y 1148–1312) never
 * reaches the nav. The pre-0.7.0 loop pulled 0.30h→0.75h and the owner saw the count update after it.
 */
export const PROFILE_PULL_BAND: PullBand = { startY: [0.24, 0.34], endY: [0.7, 0.8] }

/**
 * One pull-to-refresh drag, fully randomised and pure so the geometry is testable. The corridor x 0.28–0.66 keeps
 * clear of both side edges (the system back gesture), and the slow, `easeInOutCubic` release is a deliberate drag
 * that holds the list at its top — a fast flick would fling instead of refreshing. It is a drag, never a tap.
 */
export function pullToRefreshPath(frame: Frame, rng: () => number, band: PullBand = PROFILE_PULL_BAND): { from: { x: number; y: number }; to: { x: number; y: number }; ms: number; curvature: number } {
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

/* ── Confirmation rounds (0.7.0) ────────────────────────────────────────── */

/**
 * What a post-confirmation round does before it reads the profile again. `refresh` pulls the profile on screen
 * down; `home` visits Home first and comes back to the profile. The owner asked for this on 2026-09-15: a person
 * waiting for an upload checks back at uneven intervals, and sometimes wanders off and returns, rather than
 * re-reading one page on a fixed period.
 */
export type ConfirmMove = 'refresh' | 'home'

export interface ConfirmStep {
  move: ConfirmMove
  /** How long to wait before this round's move. */
  waitMs: number
  /** How long to stay on Home before coming back (0 for `refresh`). */
  lingerMs: number
  /** Pull to refresh once on the profile. Always true for `refresh`. */
  pull: boolean
}

export interface ConfirmPlan {
  /** The usual wait between rounds; now and then one runs 1.3–1.7x longer. */
  waitMs: readonly [number, number]
  /** The chance a round visits Home first, when the rules below leave the choice open. */
  homeChance: number
  /** The chance a `home` round also pulls to refresh once back on the profile. */
  pullAfterHome: number
}

/** A run of pulls this long is broken by a trip Home, so the loop is never pull-only. */
export const MAX_REFRESHES_IN_A_ROW = 3

/**
 * Plan the next round from the moves already made. Two rules keep it from reading as either mechanical or
 * erratic: never two Home trips in a row, and never more than `MAX_REFRESHES_IN_A_ROW` pulls in a row. Pure and
 * seeded, so a run replays exactly.
 */
export function planConfirmStep(rng: () => number, recent: readonly ConfirmMove[], plan: ConfirmPlan): ConfirmStep {
  // The SDK's `planRevisitStep` is this function (0.10.9) — its own test transcribes the body that
  // used to live here and asserts the two agree, step for step, over 120 rounds on four seeds. The
  // rules it keeps are the ones this pack wrote: never two Home trips in a row, never more than three
  // refreshes running, and a refresh always pulls.
  return planRevisitStep(rng, recent as readonly RevisitMove[], plan as RevisitPlan) as ConfirmStep
}

/* ── Keyword tilt (shared across IG / YouTube / TikTok) ─────────────────── */

/**
 * If any keyword appears in `text` (case-insensitive), the effective
 * probability is boosted.  No penalty on non-match — the operator's base
 * chance stays untouched, and only matched content gets the lift.
 */
export function keywordBoost(text: string, keywords: string[], base: number, factor: number): number {
  if (!keywords.length || base <= 0) return base
  const lower = text.toLowerCase()
  const hit = keywords.some((k) => k.trim() !== '' && lower.includes(k.toLowerCase()))
  return hit ? Math.min(1, base * factor) : base
}

/** Read every non-empty desc/text under `minTop` out of the tree — the caption,
 *  author, and other readable signals this pack's keyword match needs. */
export function readableStrings(tree: UiNode, minTop = 0): string[] {
  const seen = new Set<string>(), out: string[] = []
  for (const n of flatten(tree)) {
    for (const raw of [n.desc, n.text]) {
      const v = raw.trim()
      if (v && n.bounds.top >= minTop && !seen.has(v)) { seen.add(v); out.push(v) }
    }
  }
  return out
}
