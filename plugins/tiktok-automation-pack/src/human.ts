/**
 * Human-shaped timing primitives — lifted verbatim out of `index.ts` (plan 86 §3.1, §5 step 1) so
 * `switch-account`, `search`, and `search-follow` can share the same seeded RNG and watch-time model
 * `auto-scroll` already uses, instead of every script re-deriving its own idea of "looks human".
 * Nothing here was rewritten; only `export` was added where a function previously stayed private to
 * `index.ts` and now needs to cross a module boundary.
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

export function between(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo)
}

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
  let refreshRun = 0
  for (let i = recent.length - 1; i >= 0 && recent[i] === 'refresh'; i--) refreshRun++
  const last = recent[recent.length - 1]
  const move: ConfirmMove = last === 'home' ? 'refresh' : refreshRun >= MAX_REFRESHES_IN_A_ROW ? 'home' : rng() < plan.homeChance ? 'home' : 'refresh'
  const [lo, hi] = plan.waitMs
  const waitMs = Math.round(between(rng, lo, hi) * (rng() < 0.15 ? between(rng, 1.3, 1.7) : 1))
  if (move === 'refresh') return { move, waitMs, lingerMs: 0, pull: true }
  return { move, waitMs, lingerMs: Math.round(between(rng, 1_500, 5_000)), pull: rng() < plan.pullAfterHome }
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
