/**
 * Resolve-before-write (plan 122 §4.3), as a pure function.
 *
 * `.id` returned by RouterOS is not stable across a reboot or config reload
 * (§3.3), so every write re-resolves its target by marker prefix +
 * `src-address` rather than trusting a remembered id:
 *
 *   rules where comment starts with marker prefix AND src-address == endpoint
 *     → 0 matches : create   (PUT)
 *     → 1 match   : update   (PATCH)
 *     → 2+ matches: refuse-duplicate — never guess which to keep
 *
 * Deliberately matched by the coarse write-scope PREFIX check (the same one
 * `doctor()` in `router-driver.ts` uses), not by a full `parseMarker` — §4.3
 * itself says "comment starts with marker prefix," and this stays exactly
 * that literal rule rather than silently requiring a fully well-formed
 * marker before a rule counts as "ours."
 *
 * No I/O — `RouterDriver.createRule`/`updateRule`/`deleteRule` (step 122.6)
 * call this to decide which of the three to do; this module never calls
 * them itself.
 */

import { MANAGED_COMMENT_PREFIX } from '../shared'
import type { RouterRule } from './schemas'

export type ResolveResult =
  | { action: 'create' }
  | { action: 'update'; rule: RouterRule }
  | { action: 'refuse-duplicate'; rules: RouterRule[] }

/**
 * `endpoint` is the desired rule's `src-address` (the device's LAN IP or
 * other endpoint key) — the same value the marker's `endpointKey` segment
 * carries, but matched here against the rule's actual `src-address` field,
 * per §4.3's literal wording, not against the comment's embedded copy.
 */
export function resolveTarget(rules: readonly RouterRule[], endpoint: string): ResolveResult {
  const matches = rules.filter((r) => r.comment.startsWith(MANAGED_COMMENT_PREFIX) && r['src-address'] === endpoint)

  const [only, ...rest] = matches
  if (!only) {
    return { action: 'create' }
  }
  if (rest.length === 0) {
    return { action: 'update', rule: only }
  }
  return { action: 'refuse-duplicate', rules: matches }
}
