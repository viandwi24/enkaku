/**
 * Exponential backoff with full jitter (plan 36 §3.5): a device that just
 * dropped off USB needs seconds, not milliseconds, to re-enumerate, and full
 * jitter is what stops twenty batch members from retrying in lockstep.
 *
 *   delay  = min(backoffMaxMs, backoffBaseMs * 2^(infraAttempt - 1))
 *   actual = random(0, delay)
 *
 * `infraAttempt` is 1-based: the first infra-classified retry uses
 * `backoffAttempt(1, ...)`.
 */
export function backoffDelayMs(infraAttempt: number, opts: { backoffBaseMs: number; backoffMaxMs: number }, rand: () => number = Math.random): number {
  const exponent = Math.max(0, infraAttempt - 1)
  const cap = Math.min(opts.backoffMaxMs, opts.backoffBaseMs * 2 ** exponent)
  return Math.floor(rand() * cap)
}
