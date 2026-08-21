/**
 * The planner — plan 122 §4.4 ("Plan, then apply — never write blind"), as a
 * pure function. No I/O: the wiring step (122.6) gathers the desired state
 * (the union of active groups' entries, §4.6/§4.9), the router's current
 * rules (`RouterDriver.listRules()` — managed AND foreign, unfiltered) and
 * path health (`RouterDriver.inventory()`, §4.5), and this module only
 * computes the diff Studio renders for confirmation:
 *
 *   + create   192.168.10.215 → via-modem7-p12          (Jadwal-2)
 *   ~ update   192.168.10.216   via-modem2 → via-modem9 (Jadwal-2)
 *   - delete   192.168.10.219 → via-modem4              (was jadwal-1)
 *   ! skip     192.168.10.222 → via-modem31             path is DOWN
 *   ? foreign  192.168.100.230 → via-modem1             not managed, untouched
 *
 * Reuses `resolveTarget` (`resolve.ts`, §4.3) for the create/update/duplicate
 * decision and `parseMarker` (`marker.ts`, §4.2) to read a doomed rule's own
 * `groupId` back out of its comment — this module does not reimplement
 * either.
 *
 * ## Design decisions worth stating explicitly
 *
 * 1. **`skip` outranks `create`/`update`, and covers three reasons, not just
 *    "path is down".** §4.5: an assignment pointing at a dead path must never
 *    be applied silently. This module treats a target path that no longer
 *    EXISTS on the router at all (`pathIds` — §4.5's `Path.id`) as a
 *    genuinely different condition from one that exists but is unhealthy
 *    (`health` — §4.5's up/down flag), because the fix an operator reaches
 *    for differs (recreate the routing table vs. wait for the modem). Rather
 *    than inventing a second vocabulary, this reuses `drift.ts`'s own
 *    `path-missing` term for the first case (`SkipReason: 'path-missing'`)
 *    and adds `'path-down'` for the second — both are `skip`, per §4.4's five
 *    row kinds, distinguished only by `reason`. A third reason, `'duplicate'`,
 *    covers `resolveTarget`'s `refuse-duplicate` outcome: §4.3 is explicit
 *    that two matching rules means REFUSE, never guess which to keep, so an
 *    endpoint in that state can no more become `create`/`update` than a dead
 *    path can — it is exactly as unsafe to write blind, just for a different
 *    reason. Extending `skip`'s reason vocabulary (rather than adding a sixth
 *    row kind) is a deliberate, minimal reading of §4.4: it still produces
 *    "exactly these five row kinds," and a duplicate is not safely
 *    actionable any other way.
 * 2. **`delete` carries the raw marker `groupId`, never a "friendly" group
 *    name.** §4.4's own example shows `(was Jadwal-1)`, but a `delete` row is
 *    for an endpoint the CURRENT desired state (this module's only group
 *    input) no longer claims at all — by definition, no active group's
 *    `groupName` is available for it. The router's own rule comment only
 *    ever carries the group's `id` (`marker.ts`'s `ParsedMarker.groupId`),
 *    never a display name, so `delete.groupId` is that raw string (`null`
 *    when the marker does not parse as `ok` — malformed, wrong version, or
 *    genuinely foreign-but-still-prefixed data). Resolving `groupId` to a
 *    human name (e.g. by reading every `group:<id>` KV row, not just active
 *    ones) is a presentation concern for the wiring/UI step, which has
 *    `ctx.storage` and this module deliberately does not.
 * 3. **A `delete` candidate is any rule whose comment starts with the
 *    write-scope prefix (`MANAGED_COMMENT_PREFIX`) and whose `src-address`
 *    is not claimed by the desired set** — the same coarse, literal
 *    write-scope test `resolve.ts` and `router-driver.ts`'s `doctor()`
 *    already use, not a full `parseMarker` gate. A malformed managed rule is
 *    still ours to delete (§4.2: "the plugin only ever creates/patches/
 *    deletes rules whose comment starts with `enkaku:mikrotik-routing:`") —
 *    its identity being unreadable does not make it foreign.
 * 4. **`foreign` is classified purely by the absence of the write-scope
 *    prefix — never by `src-address`.** A foreign rule whose `src-address`
 *    happens to equal a managed endpoint's address stays `foreign` and can
 *    never become `delete`: ownership is decided by the comment the plugin
 *    itself writes, never by inferring intent from an address collision
 *    (§4.4: "the operator can see the plugin is NOT touching them").
 * 5. **A resolved `update` whose existing `table` already equals the desired
 *    `pathId` produces no row at all** — mirrors `drift.ts`'s own "matches
 *    exactly — no drift" rule. Only an actual state change is worth showing
 *    an operator in a plan they are about to confirm.
 * 6. **Determinism.** Rows are sorted by `(kind, endpointKey, rule id)`, in
 *    that order — `kind` first, in the same reading order §4.4's own example
 *    lists them (additions, then changes, then removals, then blocked, then
 *    passthrough-for-visibility last); `endpointKey` (plain string
 *    comparison, `''` for the rare row with none) as the natural per-device
 *    grouping a human scans for; the underlying rule's `.id` last, purely to
 *    break a tie between two rows that would otherwise share both (e.g. two
 *    stray `delete` candidates for the same address). The same inputs always
 *    produce the same order — no `Map`/`Set` iteration order is exposed
 *    without going through this sort first.
 */

import { MANAGED_COMMENT_PREFIX } from '../shared'
import type { DesiredAssignment } from './drift'
import { parseMarker } from './marker'
import type { PathHealth } from './router-driver'
import { resolveTarget } from './resolve'
import type { RouterRule } from './schemas'

/**
 * One entry of "what KV believes should be live" — the union of active
 * groups' entries (§4.6/§4.9), already flattened by the caller. Extends
 * `drift.ts`'s own `DesiredAssignment` (same four fields, same meaning) with
 * `groupName`, the one extra thing a plan row needs to render `(Jadwal-2)`
 * that a drift row does not.
 */
export interface PlanDesiredEntry extends DesiredAssignment {
  /** The group's display name (`Group.name`, §4.9) — used only for rendering, never for matching. */
  groupName: string
}

export interface BuildPlanInput {
  /** The desired state — the union of active groups' entries. */
  desired: readonly PlanDesiredEntry[]
  /** ALL router rules, managed and foreign alike (`RouterDriver.listRules()`). */
  rules: readonly RouterRule[]
  /** Routing tables that currently exist on the router (§4.5's `Path.id`, from `inventory().paths`). */
  pathIds: ReadonlySet<string>
  /** Path health, from `inventory().health` — "up" iff the path's default route carries the active flag (§4.5). A `pathId` with no entry here is treated as down (fail-safe — see this file's header). */
  health: readonly PathHealth[]
}

/** Why a `skip` row was produced instead of `create`/`update` — see this file's header, point 1. */
export type SkipReason = 'path-down' | 'path-missing' | 'duplicate'

export type PlanRow =
  | { kind: 'create'; endpointKey: string; pathId: string; groupId: string; groupName: string }
  | { kind: 'update'; endpointKey: string; fromPathId: string; toPathId: string; groupId: string; groupName: string; rule: RouterRule }
  | { kind: 'delete'; endpointKey: string; pathId: string | null; groupId: string | null; rule: RouterRule }
  | { kind: 'skip'; endpointKey: string; pathId: string; groupId: string; groupName: string; reason: SkipReason }
  | { kind: 'foreign'; endpointKey: string | null; pathId: string | null; rule: RouterRule }

const KIND_ORDER: Record<PlanRow['kind'], number> = { create: 0, update: 1, delete: 2, skip: 3, foreign: 4 }

/** `RouterRule['.id']` when the row carries one, `''` otherwise — the sort's final tiebreaker (point 6 above). */
function ruleIdOf(row: PlanRow): string {
  switch (row.kind) {
    case 'create':
      return ''
    case 'update':
    case 'delete':
    case 'foreign':
      return row.rule['.id']
    case 'skip':
      return ''
  }
}

function sortRows(rows: PlanRow[]): PlanRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const kindDiff = KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind]
      if (kindDiff !== 0) return kindDiff
      const endpointA = a.row.endpointKey ?? ''
      const endpointB = b.row.endpointKey ?? ''
      if (endpointA !== endpointB) return endpointA < endpointB ? -1 : 1
      const idA = ruleIdOf(a.row)
      const idB = ruleIdOf(b.row)
      if (idA !== idB) return idA < idB ? -1 : 1
      // Stable fallback — should not be reached given the inputs are each
      // keyed uniquely by (endpointKey) for desired entries and by rule
      // identity for router rules, but a plain array sort is not guaranteed
      // stable-by-spec on every engine, so this pins it explicitly.
      return a.index - b.index
    })
    .map((entry) => entry.row)
}

/**
 * §4.4's desired-vs-actual diff. Pure — no network, no KV, no clock read
 * beyond what `input.health`/`input.pathIds` already carry.
 */
export function buildPlan(input: BuildPlanInput): PlanRow[] {
  const rows: PlanRow[] = []
  const healthByPath = new Map<string, boolean>()
  for (const h of input.health) healthByPath.set(h.pathId, h.up)

  const desiredEndpoints = new Set(input.desired.map((d) => d.endpointKey))

  // create / update / skip — one row per desired entry, at most.
  for (const d of input.desired) {
    if (!input.pathIds.has(d.pathId)) {
      rows.push({ kind: 'skip', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName, reason: 'path-missing' })
      continue
    }
    if (!(healthByPath.get(d.pathId) ?? false)) {
      rows.push({ kind: 'skip', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName, reason: 'path-down' })
      continue
    }

    const resolved = resolveTarget(input.rules, d.endpointKey)
    if (resolved.action === 'create') {
      rows.push({ kind: 'create', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName })
    } else if (resolved.action === 'update') {
      if (resolved.rule.table === d.pathId) {
        // Already correct — no row (mirrors drift.ts's "matches exactly — no drift").
        continue
      }
      rows.push({
        kind: 'update',
        endpointKey: d.endpointKey,
        fromPathId: resolved.rule.table ?? '',
        toPathId: d.pathId,
        groupId: d.groupId,
        groupName: d.groupName,
        rule: resolved.rule,
      })
    } else {
      // 'refuse-duplicate' — never guess which to keep (§4.3); this endpoint is not safely actionable.
      rows.push({ kind: 'skip', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName, reason: 'duplicate' })
    }
  }

  // delete / foreign — one row per router rule not claimed by the desired set.
  for (const rule of input.rules) {
    if (!rule.comment.startsWith(MANAGED_COMMENT_PREFIX)) {
      rows.push({ kind: 'foreign', endpointKey: rule['src-address'] ?? null, pathId: rule.table ?? null, rule })
      continue
    }

    const endpointKey = rule['src-address'] ?? ''
    if (desiredEndpoints.has(endpointKey)) {
      // Claimed by a desired entry — already handled above (create/update/skip), never also a delete.
      continue
    }

    const parsed = parseMarker(rule.comment)
    const groupId = parsed.kind === 'ok' ? parsed.groupId : null
    rows.push({ kind: 'delete', endpointKey, pathId: rule.table ?? null, groupId, rule })
  }

  return sortRows(rows)
}
