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
