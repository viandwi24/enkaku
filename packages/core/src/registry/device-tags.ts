import { eq, inArray } from 'drizzle-orm'
import { TagSchema } from '@enkaku/protocol'
import type { Db } from '../db'
import { deviceTags } from '../db/schema'
import { EnkakuError } from '../util/errors'

export interface TagDiff {
  added: string[]
  removed: string[]
}

/**
 * Bulk tag lookup (plan 19 §4.3, acceptance #7): one query for a whole list
 * of devices, never one query per row. Pass `deviceIds` to scope it (e.g. a
 * single device); omit it to load every tag row in the farm.
 */
export function loadDeviceTags(db: Db, deviceIds?: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (deviceIds && deviceIds.length === 0) return map
  const rows = deviceIds
    ? db.select().from(deviceTags).where(inArray(deviceTags.deviceId, deviceIds)).all()
    : db.select().from(deviceTags).all()
  for (const r of rows) {
    const list = map.get(r.deviceId)
    if (list) list.push(r.tag)
    else map.set(r.deviceId, [r.tag])
  }
  for (const list of map.values()) list.sort()
  return map
}

export function tagsForDevice(db: Db, deviceId: string): string[] {
  return loadDeviceTags(db, [deviceId]).get(deviceId) ?? []
}

/** Every tag in use, with how many devices carry it (plan 19 §4.3 — GET /api/tags). */
export function tagCounts(db: Db): Array<{ tag: string; count: number }> {
  const rows = db.select().from(deviceTags).all()
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.tag, (counts.get(r.tag) ?? 0) + 1)
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag))
}

/**
 * Validate, normalise, dedupe, and sort a raw tag list from a client.
 * Throws E_BAD_REQUEST on the first invalid entry.
 */
export function normaliseTagList(raw: string[]): string[] {
  const next: string[] = []
  for (const t of raw) {
    const parsed = TagSchema.safeParse(t)
    if (!parsed.success) {
      throw new EnkakuError('E_BAD_REQUEST', `invalid tag "${t}": ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    }
    next.push(parsed.data)
  }
  return [...new Set(next)].sort()
}

function diffTags(before: string[], after: string[]): TagDiff {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((t) => !beforeSet.has(t)),
    removed: before.filter((t) => !afterSet.has(t)),
  }
}

/**
 * Replace a device's whole tag set in one transaction (plan 19 §4.3 — PUT
 * replaces rather than patches, so the editor stays a plain form). Returns
 * the normalised set plus a diff for the audit log.
 */
export function replaceDeviceTags(db: Db, deviceId: string, tags: string[]): { tags: string[]; diff: TagDiff } {
  const next = normaliseTagList(tags)
  const before = tagsForDevice(db, deviceId)
  const now = new Date()
  db.transaction((tx) => {
    tx.delete(deviceTags).where(eq(deviceTags.deviceId, deviceId)).run()
    for (const tag of next) tx.insert(deviceTags).values({ deviceId, tag, at: now }).run()
  })
  return { tags: next, diff: diffTags(before, next) }
}

/**
 * Delete a device's tag rows. There is no device-delete endpoint in this
 * codebase yet — plan 19 §4.1 assumes one exists elsewhere and asks for tag
 * cleanup to run inside that same transaction, rather than relying on a
 * foreign key. This is exposed so that whichever plan adds device deletion
 * (see plan 19's Open questions) calls it alongside the device row delete.
 */
export function deleteDeviceTags(db: Db, deviceId: string): void {
  db.delete(deviceTags).where(eq(deviceTags.deviceId, deviceId)).run()
}
