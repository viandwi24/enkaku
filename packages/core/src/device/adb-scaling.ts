/**
 * The adb global-semaphore scaling rule (plan 23 §3.2 — this is the change
 * that amends spec §10.4 "a loose global semaphore (6–8)"):
 *
 *   auto = min(24, max(6, ceil(deviceCount * 0.75)))
 *
 * - 4 devices  → 6  (unchanged from before this plan — small setups see no behaviour change)
 * - 10 devices → 8  (the old hardcoded ceiling, reached exactly at the plan's stated test scale)
 * - 20 devices → 15
 * - 32+ devices → 24 (capped — beyond this the adb server itself becomes the bottleneck)
 *
 * `nonOfflineDeviceCount` must exclude offline devices — an unplugged phone
 * should not reserve concurrency capacity (plan 23 §3.2).
 */
export function computeAutoConcurrency(nonOfflineDeviceCount: number): number {
  return Math.min(24, Math.max(6, Math.ceil(nonOfflineDeviceCount * 0.75)))
}

/**
 * The streaming lane's farm-wide budget (plan 85 §3.1). Derived from what a
 * device holds at steady state on the counted lane: the crash feed (one
 * slot for the life of the session) plus one and a half slots of headroom
 * for the bursty users of the lane (a Monitor tab, a file transfer, an APK
 * install). The ui-server instrumentation is pinned since plan 208 and
 * holds no slot on this counted budget — the formula's constant is
 * unchanged (plan 223 measures it), only its rationale.
 *
 *  5 devices → 13    10 → 25    20 → 50    26+ → 64 (the adb server, not
 *  this budget, is the limit past there)
 */
export function computeAutoStreams(nonOfflineDeviceCount: number): number {
  return Math.min(64, Math.max(8, Math.ceil(nonOfflineDeviceCount * 2.5)))
}

/**
 * How wide one `POST /api/actions/:verb` fans out over its selection (plan
 * 227 §3.2).
 *
 * Both widths used to be compiled-in numbers — `ACTION_FANOUT_CONCURRENCY = 4`
 * and `ACTION_SYNC_FANOUT_CONCURRENCY = 16` in `actions/verbs.ts`, neither
 * with an override, neither aware of how many phones the farm has. On a farm
 * of 73 that made a bulk screenshot nineteen waves of four, and the second
 * constant's own comment justified 16 by "adb's own farm-wide semaphore,
 * `adb.maxConcurrent`, 6 by default" — a floor that is 24 at this size
 * (`computeAutoConcurrency` above), so the stated reason had stopped being
 * true of the farm it was bounding.
 *
 * So the width is derived from the lane it will actually queue behind rather
 * than asserted. The adb semaphore already scales with the farm; these follow
 * it.
 *
 * **The ratios below are reasoned, not measured.** `bun run bench:wake` is the
 * instrument, and `ENKAKU_ACTION_FANOUT_MAX` / `ENKAKU_ACTION_SYNC_FANOUT_MAX`
 * exist so a farm can move them without a build — which is the rule
 * CLAUDE.md already states for a value expected to keep being tuned, and
 * which the two constants this replaces both broke.
 */

/**
 * The `sync` verbs (wake, sleep, set-group, settings…): each is one or two
 * short adb round trips, or none at all. They queue on the counted semaphore,
 * so its live width is the honest bound.
 *
 * The floor is the width this repo shipped before, so no farm gets narrower
 * than it was: at 10 devices the semaphore is 8 and the floor still gives 16,
 * which the semaphore then limits anyway — the floor costs nothing and only
 * protects a farm whose `adb.maxConcurrent` an operator has pinned low.
 */
export function computeSyncFanout(adbConcurrency: number, max: number): number {
  return Math.max(SYNC_FANOUT_FLOOR, Math.min(max, adbConcurrency))
}

/**
 * The `async` verbs (install, push, pull, adb shell, screenshot…): long, and
 * several of them move megabytes. Half the adb lane, so a farm-wide install
 * still leaves room for the session builds, the readiness sweep and every
 * other caller sharing the same semaphore.
 *
 * The floor is 4 — the value this replaces — so a small farm behaves exactly
 * as it did.
 */
export function computeAsyncFanout(adbConcurrency: number, max: number): number {
  return Math.max(ASYNC_FANOUT_FLOOR, Math.min(max, Math.ceil(adbConcurrency / 2)))
}

/** The width `ACTION_SYNC_FANOUT_CONCURRENCY` was, kept as a floor so nothing narrows. */
const SYNC_FANOUT_FLOOR = 16
/** The width `ACTION_FANOUT_CONCURRENCY` was, kept as a floor for the same reason. */
const ASYNC_FANOUT_FLOOR = 4
