import { eq, inArray } from 'drizzle-orm'
import type { Target } from '@enkaku/protocol'
import type { Db } from '../db'
import { devices, groups, type GroupRow, type DeviceRow } from '../db/schema'
import { loadDeviceTags } from '../registry/device-tags'
import { EnkakuError } from '../util/errors'

export interface ResolvedTarget {
  deviceId: string
  /** Why it was picked, for the batch report (plan 20 §4.3; plan 22.0 §4.2 adds 'group'). */
  via: 'tag' | 'explicit' | 'group'
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
 * Resolve an ad-hoc tag set plus an explicit device list to devices, right
 * now (plan 20 §4.3, unchanged by plan 22.0 §3.5 — a batch or schedule can
 * still target ad-hoc tags without ever saving a group). Returns every
 * match including unusable ones, each with a reason, so the caller can
 * report "3 of 5 devices were offline" instead of quietly running on a
 * smaller set than the operator expected (plan 20 §3.1).
 */
export function resolveTarget(db: Db, target: { tags: string[]; deviceIds: string[] }): ResolvedGroup {
  const usable: ResolvedTarget[] = []
  const skipped: { deviceId: string; reason: string }[] = []
  const seen = new Set<string>()

  // Tags: AND semantics, matching Plan 19 §4.3 (a device must carry every tag).
  let taggedIds: string[] = []
  if (target.tags.length > 0) {
    const tagMap = loadDeviceTags(db)
    const rows = db.select().from(devices).all()
    taggedIds = rows.filter((r) => target.tags.every((t) => (tagMap.get(r.id) ?? []).includes(t))).map((r) => r.id)
  }

  const explicitSet = new Set(target.deviceIds)
  const allIds = [...new Set([...taggedIds, ...target.deviceIds])]
  if (allIds.length === 0) return { usable, skipped }

  const rows = db.select().from(devices).where(inArray(devices.id, allIds)).all()
  const rowById = new Map(rows.map((r) => [r.id, r]))

  for (const id of allIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = rowById.get(id)
    const via: 'tag' | 'explicit' = explicitSet.has(id) ? 'explicit' : 'tag'
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
  via: 'tag' | 'explicit' | 'group'
}
export interface ResolvedTargetSet {
  usable: ResolvedActionTargetEntry[]
  skipped: { deviceId: string; reason: 'offline' | 'quarantined' | 'no longer exists' }[]
}

/**
 * The one entry point the actions router (plan 207 §4.3) and the
 * `actions.run` capability use to resolve a `Target` (`{ deviceIds }` |
 * `{ groupId }` | `{ tags }`, `@enkaku/protocol`) to devices. Dedupes.
 * Throws `EnkakuError('group_not_found', ...)` for an unknown `groupId`.
 */
export function resolveActionTarget(db: Db, target: Target): ResolvedTargetSet {
  if ('groupId' in target) {
    const row = db.select().from(groups).where(eq(groups.id, target.groupId)).get()
    if (!row) throw new EnkakuError('group_not_found', `no such group: ${target.groupId}`)
    return resolveGroup(db, row) as ResolvedTargetSet
  }
  if ('tags' in target) return resolveTarget(db, { tags: target.tags, deviceIds: [] }) as ResolvedTargetSet
  return resolveTarget(db, { tags: [], deviceIds: target.deviceIds }) as ResolvedTargetSet
}
