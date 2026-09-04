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
