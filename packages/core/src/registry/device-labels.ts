import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  DEFAULT_LABEL_COLOR,
  LabelColorSchema,
  LabelNameSchema,
  type DeviceLabelRef,
  type LabelColor,
  type LabelInfo,
} from '@enkaku/protocol'
import type { Db } from '../db'
import { deviceLabels, labels, type LabelRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/** What changed on one device, for the audit log. */
export interface LabelDiff {
  added: string[]
  removed: string[]
}

function toSec(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0
}

function colorOf(raw: string): LabelColor {
  // A row written by a future version with a colour this build does not know
  // renders in the default rather than crashing the whole device list — the
  // same "a stored value that fails validation falls back" discipline
  // `DEFAULT_AGENT_STATUS` follows.
  return LabelColorSchema.safeParse(raw).data ?? DEFAULT_LABEL_COLOR
}

export function rowToLabelRef(row: LabelRow): DeviceLabelRef {
  return { id: row.id, name: row.name, color: colorOf(row.color) }
}

/**
 * Bulk label lookup: ONE query for a whole list of devices, never one per row
 * — the same N+1 rule `loadGroupNames`/`loadRecentCrashes` state. Pass
 * `deviceIds` to scope it (e.g. a single device); omit it to load every
 * membership in the farm. Each device's labels come back sorted by name, so
 * a row of chips never reorders itself between two reads.
 */
export function loadDeviceLabels(db: Db, deviceIds?: string[]): Map<string, DeviceLabelRef[]> {
  const map = new Map<string, DeviceLabelRef[]>()
  if (deviceIds && deviceIds.length === 0) return map
  const rows = db
    .select({ deviceId: deviceLabels.deviceId, id: labels.id, name: labels.name, color: labels.color })
    .from(deviceLabels)
    .innerJoin(labels, eq(labels.id, deviceLabels.labelId))
    .where(deviceIds ? inArray(deviceLabels.deviceId, deviceIds) : undefined)
    .all()
  for (const r of rows) {
    const ref: DeviceLabelRef = { id: r.id, name: r.name, color: colorOf(r.color) }
    const list = map.get(r.deviceId)
    if (list) list.push(ref)
    else map.set(r.deviceId, [ref])
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return map
}

export function labelsForDevice(db: Db, deviceId: string): DeviceLabelRef[] {
  return loadDeviceLabels(db, [deviceId]).get(deviceId) ?? []
}

/**
 * Every label in the farm with its live device count (`GET /api/labels`).
 * The count is a `left join` aggregate rather than a stored column so a label
 * nobody carries reports `0` instead of going missing, and no write path can
 * leave the number disagreeing with the memberships.
 */
export function listLabels(db: Db): LabelInfo[] {
  return db
    .select({
      id: labels.id,
      name: labels.name,
      color: labels.color,
      description: labels.description,
      createdAt: labels.createdAt,
      deviceCount: sql<number>`count(${deviceLabels.deviceId})`,
    })
    .from(labels)
    .leftJoin(deviceLabels, eq(deviceLabels.labelId, labels.id))
    .groupBy(labels.id)
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: colorOf(r.color),
      description: r.description,
      createdAt: toSec(r.createdAt),
      deviceCount: Number(r.deviceCount),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function labelInfo(db: Db, id: string): LabelInfo | null {
  return listLabels(db).find((l) => l.id === id) ?? null
}

/**
 * Refuse a name a label already has, case-insensitively — the near-duplicate
 * problem free-form tags could not see. `idx_labels_name` enforces the same
 * rule in SQLite; this exists so the operator gets a sentence naming the
 * label they already have rather than a constraint violation.
 */
function assertNameFree(db: Db, name: string, exceptId?: string): void {
  const clash = db
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(sql`lower(${labels.name}) = lower(${name})`)
    .get()
  if (clash && clash.id !== exceptId) {
    throw new EnkakuError('label_exists', `a label named "${clash.name}" already exists`)
  }
}

export function createLabel(db: Db, input: { name: string; color?: string; description?: string | null }): LabelInfo {
  const name = LabelNameSchema.parse(input.name)
  const color = input.color === undefined ? DEFAULT_LABEL_COLOR : LabelColorSchema.parse(input.color)
  assertNameFree(db, name)
  const row: LabelRow = {
    id: crypto.randomUUID(),
    name,
    color,
    description: input.description ?? null,
    createdAt: new Date(),
  }
  db.insert(labels).values(row).run()
  return { ...rowToLabelRef(row), description: row.description, createdAt: toSec(row.createdAt), deviceCount: 0 }
}

export function updateLabel(db: Db, id: string, patch: { name?: string; color?: string; description?: string | null }): LabelInfo {
  const row = db.select().from(labels).where(eq(labels.id, id)).get()
  if (!row) throw new EnkakuError('label_not_found', `no such label: ${id}`)
  const next: Partial<LabelRow> = {}
  if (patch.name !== undefined) {
    const name = LabelNameSchema.parse(patch.name)
    assertNameFree(db, name, id)
    next.name = name
  }
  if (patch.color !== undefined) next.color = LabelColorSchema.parse(patch.color)
  if (patch.description !== undefined) next.description = patch.description
  if (Object.keys(next).length > 0) db.update(labels).set(next).where(eq(labels.id, id)).run()
  return labelInfo(db, id)!
}

/**
 * Delete a label and every membership it has, in one transaction — the
 * devices stay, only the label goes away, exactly as deleting a group leaves
 * its members standing (`deleteGroupAndUnassign`). Returns the device ids
 * that lost it, so the caller can broadcast a `device.updated` for each.
 */
export function deleteLabel(db: Db, id: string): { name: string; deviceIds: string[] } {
  const row = db.select().from(labels).where(eq(labels.id, id)).get()
  if (!row) throw new EnkakuError('label_not_found', `no such label: ${id}`)
  const deviceIds = db
    .select({ deviceId: deviceLabels.deviceId })
    .from(deviceLabels)
    .where(eq(deviceLabels.labelId, id))
    .all()
    .map((r) => r.deviceId)
  db.transaction((tx) => {
    tx.delete(deviceLabels).where(eq(deviceLabels.labelId, id)).run()
    tx.delete(labels).where(eq(labels.id, id)).run()
  })
  return { name: row.name, deviceIds }
}

/** Refuse a label id that does not exist, before any device is touched — a partial apply across a bulk target is worse than a flat refusal. */
export function assertLabelsExist(db: Db, labelIds: string[]): void {
  if (labelIds.length === 0) return
  const found = new Set(
    db
      .select({ id: labels.id })
      .from(labels)
      .where(inArray(labels.id, labelIds))
      .all()
      .map((r) => r.id),
  )
  const missing = labelIds.filter((id) => !found.has(id))
  if (missing.length > 0) throw new EnkakuError('label_not_found', `no such label: ${missing.join(', ')}`)
}

/**
 * Add, remove or replace labels on ONE device (plan 225 §4.5).
 *
 * Three ops rather than the whole-set PUT the tag editor used, because the
 * surface that needs this most is a multi-device context menu: "add Smoke
 * Pool to these twelve phones" must not erase whatever else each of the
 * twelve already carries, which a replace would. `replace` is still there for
 * the single-device editor, where the operator IS looking at the whole set.
 */
export function applyDeviceLabels(
  db: Db,
  deviceId: string,
  op: 'add' | 'remove' | 'replace',
  labelIds: string[],
): { labels: DeviceLabelRef[]; diff: LabelDiff } {
  const before = labelsForDevice(db, deviceId)
  const beforeIds = new Set(before.map((l) => l.id))
  const wanted = [...new Set(labelIds)]
  const now = new Date()

  db.transaction((tx) => {
    if (op === 'replace') {
      tx.delete(deviceLabels).where(eq(deviceLabels.deviceId, deviceId)).run()
      for (const labelId of wanted) tx.insert(deviceLabels).values({ deviceId, labelId, at: now }).run()
      return
    }
    if (op === 'remove') {
      if (wanted.length > 0) {
        tx.delete(deviceLabels)
          .where(and(eq(deviceLabels.deviceId, deviceId), inArray(deviceLabels.labelId, wanted)))
          .run()
      }
      return
    }
    for (const labelId of wanted) {
      if (beforeIds.has(labelId)) continue
      tx.insert(deviceLabels).values({ deviceId, labelId, at: now }).run()
    }
  })

  const after = labelsForDevice(db, deviceId)
  const afterIds = new Set(after.map((l) => l.id))
  return {
    labels: after,
    diff: {
      added: after.filter((l) => !beforeIds.has(l.id)).map((l) => l.name),
      removed: before.filter((l) => !afterIds.has(l.id)).map((l) => l.name),
    },
  }
}

/**
 * Delete a device's label rows. There is no foreign key to `devices` (see the
 * table's own comment), so whichever path deletes a device row calls this in
 * the same transaction — exactly as `deleteDeviceTags` was called before it.
 */
export function deleteDeviceLabels(db: Db, deviceId: string): void {
  db.delete(deviceLabels).where(eq(deviceLabels.deviceId, deviceId)).run()
}
