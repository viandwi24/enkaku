/**
 * Human-shaped timing primitives — lifted verbatim out of `index.ts` (plan 86 §3.1, §5 step 1) so
 * `switch-account`, `search`, and `search-follow` can share the same seeded RNG and watch-time model
 * `auto-scroll` already uses, instead of every script re-deriving its own idea of "looks human".
 * Nothing here was rewritten; only `export` was added where a function previously stayed private to
 * `index.ts` and now needs to cross a module boundary.
 */

import { between, makeRng, pickDwellMs, planRevisitStep, type DwellBucket, type RevisitMove, type RevisitPlan, type RevisitStep } from '@enkaku/sdk'

/** A small deterministic PRNG so a run can be replayed exactly — `Math.random()` cannot be seeded. */
/*
  The rng and `between` are the SDK's now (1.49.7), re-exported so no call site in this pack changes.
  The generator is the same xorshift32 this file has always used — verified across 8 seeds x 2000
  draws — and the SDK adopted this file's `0x2f6e2b1` fallback so even a zero seed matches. A seeded
  run replays exactly as it did before.
*/
export { between, makeRng }

/**
 * What a post-confirmation round does before it reads the profile again (1.42.0). `refresh` pulls the profile on
 * screen down; `home` goes Home first and comes back to Profil. The owner asked for this on 2026-09-15: a person
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
  // This body is the SDK's `planRevisitStep` (1.49.7). It is not a look-alike: the SDK's test
  // transcribes the implementation that used to live here and asserts the two agree step for step
  // over 120 rounds on four seeds, including the draw ORDER, which is what a seeded replay depends
  // on. The numbers stay this pack's — they arrive in `plan`.
  return planRevisitStep(rng, recent as readonly RevisitMove[], { ...plan, waitMs: [plan.waitMs[0], plan.waitMs[1]] } as RevisitPlan) as ConfirmStep
}

/**
 * How long a person leaves one video on screen.
 *
 * A single uniform range is the tell: real watch times are heavy-tailed and lumpy. Most clips get a
 * few seconds, a fair number get abandoned almost immediately, and a small minority hold attention
 * for a long time. The weights below are a coarse model of that shape, not measured data — they
 * exist so the *distribution* is uneven, which is the property that matters.
 */
const WATCH_BUCKETS: readonly DwellBucket[] = [
  { label: 'skip', weight: 0.12, ms: [600, 1_900] },
  { label: 'watch', weight: 0.58, ms: [2_500, 9_000] },
  { label: 'engaged', weight: 0.22, ms: [9_000, 22_000] },
  { label: 'hooked', weight: 0.08, ms: [22_000, 50_000] },
]

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
  /*
    The argument above is now implemented once, in the SDK's `pickDwellMs` — including the per-bucket
    tilt bias (`skip` -1, `watch` 0, `engaged` 0.8, `hooked` 1) and the 0.01 weight floor, which the
    SDK takes as `minWeight` precisely so this pack keeps the property the paragraph above defends:
    even at full tilt every bucket stays reachable.

    One difference, stated rather than buried: the SDK CLAMPS tilt to [-1, 1] where this copy did not.
    For every value the callers here pass the two agree exactly; outside that range the old code
    produced negative weights, which the floor then papered over.
  */
  return pickDwellMs(rng, tilt, WATCH_BUCKETS, { minWeight: 0.01 })
}

export function sleep(ms: number): Promise<void> {
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
