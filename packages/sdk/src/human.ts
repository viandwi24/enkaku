/**
 * The human-behaviour kit, for every plugin (2026-09-17).
 *
 * ## Why this exists
 *
 * A survey of the TikTok, Instagram and YouTube packs on 2026-09-16 found all three carrying their
 * own copy of the same four things: a seeded rng, a `between`, a heavy-tailed dwell model, and a
 * "revisit the page without looking mechanical" planner. The copies had already drifted — TikTok's
 * dwell buckets are `600–1900 / 2500–9000 / 9000–22000 / 22000–50000`, YouTube's are
 * `1500–3500 / 4000–10000 / 10000–25000 / 25000–55000`, Instagram's a third set — and the drift had
 * turned into real behavioural gaps, because a fix written in one pack never reached the other two.
 *
 * So the kit moves here, where a plugin imports it instead of re-deriving it. Nothing about the
 * device is touched: every function below is pure, takes its randomness as an argument, and can be
 * unit-tested without a phone. The device-side variation (a jittered aim point, a varied corridor)
 * belongs to the API instead — `tap(…, { human: true })`, `swipe(…, { human: true })`,
 * `scroll({ …, human: true })` — so that one implementation serves every plugin.
 *
 * ## The one design rule
 *
 * Randomising a number is not the same as looking human, and can be worse. A uniform dwell between
 * two bounds is a flat distribution no person produces; a bimodal one is a SHARPER fingerprint than
 * no randomisation at all. What people actually produce is a heavy tail: mostly short looks, a long
 * one every so often. `pickDwellMs` models that, and `tilt` biases WHICH bucket is likely rather
 * than switching to a different distribution.
 */

/** Just the corners — spelled out rather than imported, so this module stays free of every dependency. */
export interface AimBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** How much of each edge an aim keeps clear by default: the middle 70% of the box. */
const DEFAULT_INSET = 0.15
/** Below this, an axis keeps its centre — see `aimInside`. */
const MIN_SPAN_PX = 24

/**
 * A point inside a node's box, rather than its exact centre.
 *
 * This is the pure twin of the API's own `tap(…, { human: true })`, and it exists because a pack
 * usually has the NODE, not a selector: it dumped the tree itself, walked it, and holds the box. The
 * API deliberately never moves a `{ point }` target — on some screens a measured point is the only
 * one that works — so a pack that aims from bounds needs the aim, not the flag.
 *
 * All three packs had written this already (`jitteredPoint`, `jitterPoint`, `insetPoint`), each
 * drawing from `Math.random`, which is why their seeded runs never replayed their taps.
 *
 * `rng` is therefore OPTIONAL, and that is a deliberate migration decision rather than laziness: the
 * three helpers this replaces take a node and nothing else, and most of their call sites — Instagram's
 * `likeFeedPost` and its story-tray tap, the whole of `search-keyword` — hold no rng at all. Demanding
 * one would turn a mechanical swap into eleven signature changes through functions that never needed
 * randomness of their own. Omitted, it draws from `Math.random`, which is exactly what those packs do
 * today; passed, the tap joins the run's seeded sequence and replays with it. A member that already
 * has an rng should pass it.
 *
 * A box under 24 px on an axis keeps its centre on that axis: on a thin rail the "middle 70%" is a
 * target small enough to miss, and missing is a real failure while the realism gained is nothing.
 */
export function aimInside(box: AimBox, rng: () => number = Math.random, opts?: { inset?: number }): { x: number; y: number } {
  const w = box.right - box.left
  const h = box.bottom - box.top
  const centre = { x: Math.round((box.left + box.right) / 2), y: Math.round((box.top + box.bottom) / 2) }
  if (w <= 0 || h <= 0) return centre
  const inset = Math.max(0, Math.min(0.45, opts?.inset ?? DEFAULT_INSET))
  const fx = w < MIN_SPAN_PX ? 0 : inset
  const fy = h < MIN_SPAN_PX ? 0 : inset
  return {
    x: Math.round(box.left + w * (fx + rng() * (1 - 2 * fx))),
    y: Math.round(box.top + h * (fy + rng() * (1 - 2 * fy))),
  }
}

/** A seeded xorshift32. Same seed, same sequence — so a run can be replayed exactly. */
export function makeRng(seed: number): () => number {
  // The same fallback the three packs use, so this is a drop-in for their own `makeRng`: every
  // non-zero seed already produced an identical sequence (verified across 8 seeds x 2000 draws), and
  // this makes the zero case identical too.
  let s = seed >>> 0 || 0x2f6e2b1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

/** A number in `[lo, hi)`, from the rng given. */
export function between(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo)
}

/** One of `items`, uniformly. Throws on an empty list rather than returning undefined. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() needs at least one item')
  return items[Math.floor(rng() * items.length)] as T
}

/** How long one piece of content is looked at, and what that length means. */
export interface DwellBucket {
  label: 'skip' | 'watch' | 'engaged' | 'hooked'
  /** Relative likelihood before `tilt` is applied. */
  weight: number
  /** Inclusive-exclusive range, in milliseconds. */
  ms: [number, number]
}

/**
 * The consolidated defaults, a middle reading of the three packs' own measured tables. A caller that
 * wants its own shape passes `buckets` — the model is the shape, not these particular numbers.
 */
export const DWELL_BUCKETS: readonly DwellBucket[] = [
  { label: 'skip', weight: 0.14, ms: [1_200, 3_000] },
  { label: 'watch', weight: 0.53, ms: [3_500, 10_000] },
  { label: 'engaged', weight: 0.24, ms: [10_000, 24_000] },
  { label: 'hooked', weight: 0.09, ms: [24_000, 52_000] },
]

/** How much each bucket answers to `tilt`: −1 is "interest makes this less likely", +1 "more". */
const TILT_BIAS: Record<DwellBucket['label'], number> = { skip: -1, watch: 0, engaged: 0.8, hooked: 1 }

/**
 * Draw a dwell.
 *
 * `tilt` runs −1 … +1 and expresses how interesting this particular item is (a keyword matched, a
 * blocked word appeared). It re-weights the buckets; it never replaces the distribution, because a
 * run that switches between two different distributions is easier to spot than one that does not
 * randomise at all.
 */
export function pickDwellMs(
  rng: () => number,
  tilt = 0,
  buckets: readonly DwellBucket[] = DWELL_BUCKETS,
  opts?: { minWeight?: number },
): { label: DwellBucket['label']; ms: number } {
  const clamped = Math.max(-1, Math.min(1, tilt))
  // `minWeight` keeps a tilted-away bucket reachable. The TikTok pack floors at 0.01 so that even at
  // full tilt a matched video is sometimes abandoned in a second — its own comment argues that a
  // perfectly bimodal watch time is a SHARPER fingerprint than no randomisation. Default 0, which is
  // what a caller that never tilts (Instagram, YouTube) gets either way.
  const floor = opts?.minWeight ?? 0
  const weighted = buckets.map((b) => ({ b, w: Math.max(floor, b.weight * (1 + clamped * TILT_BIAS[b.label])) }))
  const total = weighted.reduce((sum, x) => sum + x.w, 0)
  if (total <= 0) {
    const fallback = buckets[0] as DwellBucket
    return { label: fallback.label, ms: Math.round(between(rng, fallback.ms[0], fallback.ms[1])) }
  }
  let roll = rng() * total
  for (const { b, w } of weighted) {
    roll -= w
    if (roll <= 0) return { label: b.label, ms: Math.round(between(rng, b.ms[0], b.ms[1])) }
  }
  const last = weighted[weighted.length - 1]?.b as DwellBucket
  return { label: last.label, ms: Math.round(between(rng, last.ms[0], last.ms[1])) }
}

/** What a revisit round does: look again where you are, or go Home first and come back. */
export type RevisitMove = 'refresh' | 'home'

export interface RevisitStep {
  move: RevisitMove
  /** How long to wait before this round's reading. */
  waitMs: number
  /** Non-zero only for a `home` move: how long to linger there before coming back. */
  lingerMs: number
  /** True when this round should pull the page down to refresh it after returning. */
  pull: boolean
}

export interface RevisitPlan {
  /** The ordinary gap between rounds. */
  waitMs: [number, number]
  /** Chance a round goes Home and back instead of simply looking again. */
  homeChance: number
  /** Chance a `home` round also pulls to refresh once it is back. */
  pullAfterHome: number
  /**
   * Whether a plain `refresh` round pulls the page down. Default TRUE, which is what all three packs
   * already do — a round that looks again without refreshing is not a check, it is a wait.
   */
  pullOnRefresh?: boolean
}

/** Never this many refreshes in a row — the one pattern that reads as a script watching a page. */
export const MAX_REFRESHES_IN_A_ROW = 3

/**
 * Plan one round of "check whether it landed yet".
 *
 * Two rules are baked in because every pack had written them separately: never two Home trips back
 * to back, and never more than `MAX_REFRESHES_IN_A_ROW` plain refreshes in a row. `previous` is the
 * moves already made, oldest first; the caller keeps that list.
 */
export function planRevisitStep(rng: () => number, previous: readonly RevisitMove[], plan: RevisitPlan): RevisitStep {
  const lastWasHome = previous[previous.length - 1] === 'home'
  const trailingRefreshes = (() => {
    let n = 0
    for (let i = previous.length - 1; i >= 0 && previous[i] === 'refresh'; i--) n += 1
    return n
  })()
  const mustLeave = trailingRefreshes >= MAX_REFRESHES_IN_A_ROW
  const move: RevisitMove = mustLeave ? 'home' : lastWasHome ? 'refresh' : rng() < plan.homeChance ? 'home' : 'refresh'
  /*
    The draw order below is not arbitrary: the base wait is drawn FIRST and the stretch second,
    matching the three packs this replaces exactly. Swapping them consumes the same rng in a
    different order and yields different numbers for the same seed, which would make this a
    look-alike rather than a drop-in — the whole point of moving the helper here.

    A person does not check back on a metronome: one round in seven runs long.
  */
  const base = between(rng, plan.waitMs[0], plan.waitMs[1])
  const waitMs = Math.round(base * (rng() < 0.15 ? between(rng, 1.3, 1.7) : 1))
  if (move === 'refresh') return { move, waitMs, lingerMs: 0, pull: plan.pullOnRefresh ?? true }
  return { move, waitMs, lingerMs: Math.round(between(rng, 1_500, 5_000)), pull: rng() < plan.pullAfterHome }
}

/**
 * The pause between two words being typed, as a person produces it: mostly short, occasionally a
 * real stop to think. Bimodal ON PURPOSE here — unlike a dwell, an inter-word gap genuinely is two
 * populations (finger speed, and attention), and both packs that measured it landed on the same
 * shape.
 */
export function pauseBetweenWordsMs(rng: () => number): number {
  return rng() < 0.17 ? Math.round(between(rng, 900, 2_400)) : Math.round(between(rng, 180, 800))
}
