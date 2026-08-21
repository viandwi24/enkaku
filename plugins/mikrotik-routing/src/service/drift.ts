/**
 * Drift classification — the exact table in plan 122 §4.7, as a pure
 * function. No I/O: the caller (reconcile, step 122.9) gathers the four
 * inputs from KV, the router, and the device registry, and this module only
 * compares them.
 *
 * | Drift | Meaning | Default handling |
 * |---|---|---|
 * | `missing-rule` | Expected rule absent from router | Report; offer re-apply |
 * | `unexpected-managed-rule` | Marker present, no KV record | Orphan — adopt or remove |
 * | `wrong-path` | Rule exists, `table` differs | Report; offer re-apply |
 * | `duplicate` | Two managed rules, same endpoint | Report only, never auto-fix |
 * | `path-missing` | `table` no longer on router | Report; assignment invalid |
 * | `stale-owner` | Device blocked or gone from fleet, rule still live | Report; offer remove |
 *
 * ## Two judgement calls this module makes, spelled out
 *
 * 1. **A managed-prefixed rule whose marker does not parse as `ok`**
 *    (`malformed` or `version-mismatch`, see `marker.ts`) is classified as
 *    `unexpected-managed-rule` alongside true orphans. The table has no
 *    seventh row for "we can't even read this," and refusing to touch it
 *    while still surfacing it to a human — exactly what the orphan handling
 *    already does (§4.2: "the plugin does neither on its own — both
 *    directions can be wrong, so both are a human decision") — is the
 *    conservative reading. A future marker version colliding with this one
 *    is exactly the scenario §4.2 says must be "detected rather than
 *    mis-parsed," and reporting it as an orphan (never silently adopted,
 *    never silently removed) satisfies that without inventing an eighth
 *    drift kind the plan does not ask for.
 * 2. **`duplicate` is computed before anything else and takes priority.**
 *    Two (or more) managed rules sharing one `endpointKey` are flagged
 *    regardless of whether that endpoint even appears in the desired set —
 *    §4.3's "REFUSE, flag duplicate drift, never guess" applies to the
 *    existence of the duplication itself, not to whether it happens to also
 *    be wanted.
 *
 * `stale-owner` only fires when a rule actually exists for the device's
 * endpoint — the table's own wording is "rule still live." A blocked or
 * forgotten device with NO router rule is not drift at all: no rule is
 * exactly what should be there once a device has left the fleet.
 */

import type { RouterRule } from './schemas'
import { parseMarker } from './marker'

/** One entry of "what KV believes should be live" — the union of active groups' entries (plan 122 §4.6/§4.9), already flattened by the caller. */
export interface DesiredAssignment {
  groupId: string
  /** The device's LAN IP or other router-visible identity — matches the marker's `endpointKey` segment and the rule's `src-address`. */
  endpointKey: string
  deviceId: string
  /** The routing table (egress path) this endpoint should be routed through. */
  pathId: string
}

export interface ClassifyDriftInput {
  /** The union of active groups' entries — what KV believes should be live. */
  desired: readonly DesiredAssignment[]
  /** ALL router rules, managed and foreign alike — foreign ones are ignored entirely. */
  rules: readonly RouterRule[]
  /** Routing tables that currently exist on the router (§4.5's `Path.id`/`table`). */
  pathIds: ReadonlySet<string>
  /** Device ids that are still normal fleet members — not blocked, not forgotten/gone (§3.5). */
  activeDeviceIds: ReadonlySet<string>
}

export type Drift =
  | { kind: 'missing-rule'; desired: DesiredAssignment }
  | { kind: 'unexpected-managed-rule'; rule: RouterRule; groupId: string | null; endpointKey: string | null }
  | { kind: 'wrong-path'; desired: DesiredAssignment; rule: RouterRule; actualTable: string | null }
  | { kind: 'duplicate'; endpointKey: string; rules: RouterRule[] }
  | { kind: 'path-missing'; desired: DesiredAssignment }
  | { kind: 'stale-owner'; desired: DesiredAssignment; rule: RouterRule }

interface ManagedRuleEntry {
  rule: RouterRule
  /** `null` when the marker did not parse as `ok` (malformed or version-mismatch) — still ours by prefix, just unreadable. */
  groupId: string | null
  endpointKey: string | null
}

export function classifyDrift(input: ClassifyDriftInput): Drift[] {
  const drifts: Drift[] = []

  const managed: ManagedRuleEntry[] = []
  for (const rule of input.rules) {
    const parsed = parseMarker(rule.comment)
    if (parsed.kind === 'foreign') continue
    if (parsed.kind === 'ok') {
      managed.push({ rule, groupId: parsed.groupId, endpointKey: parsed.endpointKey })
    } else {
      // malformed or version-mismatch: still write-scoped (has the prefix),
      // but its identity cannot be read — see this file's header, point 1.
      managed.push({ rule, groupId: null, endpointKey: null })
    }
  }

  // Group by endpointKey. Rules whose marker did not parse (endpointKey ===
  // null) each get their own single-entry "group" keyed by rule id, since
  // they have no endpointKey to share and must never be silently folded
  // together with an unrelated rule.
  const byEndpoint = new Map<string, ManagedRuleEntry[]>()
  const unresolved: ManagedRuleEntry[] = []
  for (const entry of managed) {
    if (entry.endpointKey === null) {
      unresolved.push(entry)
      continue
    }
    const group = byEndpoint.get(entry.endpointKey)
    if (group) {
      group.push(entry)
    } else {
      byEndpoint.set(entry.endpointKey, [entry])
    }
  }

  const consumedEndpoints = new Set<string>()

  // Duplicates first (point 2 above) — independent of desired state.
  for (const [endpointKey, entries] of byEndpoint) {
    if (entries.length >= 2) {
      drifts.push({ kind: 'duplicate', endpointKey, rules: entries.map((e) => e.rule) })
      consumedEndpoints.add(endpointKey)
    }
  }

  for (const desired of input.desired) {
    // Also guards a second `desired` entry sharing an `endpointKey` already
    // consumed by a prior one in this same loop — the exclusivity invariant
    // (§4.6) means the caller should never hand this function two active
    // groups claiming the same device, but this function does not trust
    // that and simply reports the first and is silent on the rest, rather
    // than emitting a contradictory second classification for one endpoint.
    if (consumedEndpoints.has(desired.endpointKey)) continue
    consumedEndpoints.add(desired.endpointKey)

    const entries = byEndpoint.get(desired.endpointKey) ?? []
    const deviceActive = input.activeDeviceIds.has(desired.deviceId)

    if (entries.length === 0) {
      if (!deviceActive) {
        // No rule, and none is expected for a device that has left the fleet — not drift.
        continue
      }
      if (!input.pathIds.has(desired.pathId)) {
        drifts.push({ kind: 'path-missing', desired })
      } else {
        drifts.push({ kind: 'missing-rule', desired })
      }
      continue
    }

    // entries.length === 1 here — 2+ was already consumed as a duplicate above.
    const only = entries[0]
    if (!only) continue
    const rule = only.rule

    if (!deviceActive) {
      drifts.push({ kind: 'stale-owner', desired, rule })
      continue
    }
    if (!input.pathIds.has(desired.pathId)) {
      drifts.push({ kind: 'path-missing', desired })
      continue
    }
    if (rule.table !== desired.pathId) {
      drifts.push({ kind: 'wrong-path', desired, rule, actualTable: rule.table ?? null })
      continue
    }
    // Matches exactly — no drift.
  }

  // Remaining managed rules — never consumed by a desired assignment or already reported as a duplicate — are orphans.
  for (const [endpointKey, entries] of byEndpoint) {
    if (consumedEndpoints.has(endpointKey)) continue
    for (const entry of entries) {
      drifts.push({ kind: 'unexpected-managed-rule', rule: entry.rule, groupId: entry.groupId, endpointKey: entry.endpointKey })
    }
  }
  for (const entry of unresolved) {
    drifts.push({ kind: 'unexpected-managed-rule', rule: entry.rule, groupId: entry.groupId, endpointKey: entry.endpointKey })
  }

  return drifts
}
