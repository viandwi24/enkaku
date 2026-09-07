import { eq, inArray } from 'drizzle-orm'
import type { Target } from '@enkaku/protocol'
import type { Db } from '../db'
import { devices, groups, labels, type GroupRow, type DeviceRow } from '../db/schema'
import { loadDeviceLabels } from '../registry/device-labels'
import { EnkakuError } from '../util/errors'

export interface ResolvedTarget {
  deviceId: string
  /** Why it was picked, for the batch report (plan 20 §4.3; plan 22.0 §4.2 adds 'group'; plan 225 renames 'tag' to 'label'). */
  via: 'label' | 'explicit' | 'group'
}

export interface ResolvedGroup {
  usable: ResolvedTarget[]
  skipped: { deviceId: string; reason: string }[]
}

/** Same "cannot take a job" rule as the Studio picker (plan 19 §4.4) — offline
 * and quarantined devices are reported as skipped, never silently dropped. */
function unavailableReason(row: DeviceRow): string | null {
  if (row.status === 'offline') return 'offline'
  if (row.status === 'quarantined') return 'quarantined'
  return null
}

/**
 * Resolve a label set plus an explicit device list to devices, right now
 * (plan 20 §4.3, unchanged by plan 22.0 §3.5 — a batch or schedule can still
 * target labels without ever saving a group; plan 225 swaps the free-form
 * tags this took for label ids). Returns every match including unusable
 * ones, each with a reason, so the caller can report "3 of 5 devices were
 * offline" instead of quietly running on a smaller set than the operator
 * expected (plan 20 §3.1).
 */
export function resolveTarget(db: Db, target: { labelIds: string[]; deviceIds: string[] }): ResolvedGroup {
  const usable: ResolvedTarget[] = []
  const skipped: { deviceId: string; reason: string }[] = []
  const seen = new Set<string>()

  // Labels: AND semantics — a device must carry EVERY label in the target,
  // the same intersection the tags this replaces resolved.
  let labelledIds: string[] = []
  if (target.labelIds.length > 0) {
    const labelMap = loadDeviceLabels(db)
    const rows = db.select({ id: devices.id }).from(devices).all()
    labelledIds = rows
      .filter((r) => {
        const carried = new Set((labelMap.get(r.id) ?? []).map((l) => l.id))
        return target.labelIds.every((id) => carried.has(id))
      })
      .map((r) => r.id)
  }

  const explicitSet = new Set(target.deviceIds)
  const allIds = [...new Set([...labelledIds, ...target.deviceIds])]
  if (allIds.length === 0) return { usable, skipped }

  const rows = db.select().from(devices).where(inArray(devices.id, allIds)).all()
  const rowById = new Map(rows.map((r) => [r.id, r]))

  for (const id of allIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = rowById.get(id)
    const via: 'label' | 'explicit' = explicitSet.has(id) ? 'explicit' : 'label'
    if (!row) {
      skipped.push({ deviceId: id, reason: 'no longer exists' })
      continue
    }
    const reason = unavailableReason(row)
    if (reason) {
      skipped.push({ deviceId: id, reason })
      continue
    }
    usable.push({ deviceId: id, via })
  }

  return { usable, skipped }
}

/**
 * Resolve a saved group — a membership lookup, nothing more (plan 22.0
 * §3.5, §4.3): `SELECT * FROM devices WHERE group_id = ?`. An offline or
 * quarantined member is still reported, just under `skipped` with a reason —
 * a batch never silently shrinks the set an operator expects (plan 20 §3.1,
 * carried over unchanged).
 */
export function resolveGroup(db: Db, group: GroupRow): ResolvedGroup {
  const usable: ResolvedTarget[] = []
  const skipped: { deviceId: string; reason: string }[] = []
  const rows = db.select().from(devices).where(eq(devices.groupId, group.id)).all()
  for (const row of rows) {
    const reason = unavailableReason(row)
    if (reason) {
      skipped.push({ deviceId: row.id, reason })
      continue
    }
    usable.push({ deviceId: row.id, via: 'group' })
  }
  return { usable, skipped }
}

export interface ResolvedActionTargetEntry {
  deviceId: string
  via: 'label' | 'explicit' | 'group'
}
export interface ResolvedTargetSet {
  usable: ResolvedActionTargetEntry[]
  skipped: { deviceId: string; reason: 'offline' | 'quarantined' | 'no longer exists' }[]
}

/**
 * Every label id whose NAME is in `names`, case-insensitively.
 *
 * Only the legacy `{ tags }` target below calls this. A target stored before
 * plan 225 named free-form tags by text, and migration 0080 gave each of
 * those tags a label of the same name — so resolving the text back to a
 * label id lands that stored batch, operation or workflow document on the
 * devices it always meant. A name that matches nothing resolves to no
 * devices, which is what a tag nobody carries did too.
 */
function labelIdsByName(db: Db, names: string[]): string[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  return db
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .all()
    .filter((l) => wanted.has(l.name.toLowerCase()))
    .map((l) => l.id)
}

/**
 * The one entry point the actions router (plan 207 §4.3) and the
 * `actions.run` capability use to resolve a `Target` (`{ deviceIds }` |
 * `{ groupId }` | `{ labelIds }`, `@enkaku/protocol`) to devices. Dedupes.
 * Throws `EnkakuError('group_not_found', ...)` for an unknown `groupId`.
 */
export function resolveActionTarget(db: Db, target: Target): ResolvedTargetSet {
  if ('groupId' in target) {
    const row = db.select().from(groups).where(eq(groups.id, target.groupId)).get()
    if (!row) throw new EnkakuError('group_not_found', `no such group: ${target.groupId}`)
    return resolveGroup(db, row) as ResolvedTargetSet
  }
  if ('labelIds' in target) return resolveTarget(db, { labelIds: target.labelIds, deviceIds: [] }) as ResolvedTargetSet
  if ('tags' in target) {
    // Legacy, read-only (see `TargetSchema`'s own comment). A name that no
    // longer matches a label resolves to nothing — deliberately NOT to every
    // device, which is what an empty `labelIds` here would mean.
    const labelIds = labelIdsByName(db, target.tags)
    if (labelIds.length !== target.tags.length) return { usable: [], skipped: [] }
    return resolveTarget(db, { labelIds, deviceIds: [] }) as ResolvedTargetSet
  }
  return resolveTarget(db, { labelIds: [], deviceIds: target.deviceIds }) as ResolvedTargetSet
}
