import { Hono } from 'hono'
import { asc, eq, max } from 'drizzle-orm'
import { z } from 'zod'
import { GroupOrderBodySchema, GroupOrderResponseSchema, GroupResponseSchema, type GroupInfo, type ConnectionMedium, type DeviceInfo } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { groups, type GroupRow } from '../db/schema'
import { deleteGroupAndUnassign, groupMembers } from '../groups/membership'
import { resolveGroup } from '../groups/resolve'
import { rowToDeviceInfo, type DeviceActivityState, type FarmNetwork } from '../registry/device-registry'
import { loadDeviceNumbers } from '../registry/device-number'
import { loadDeviceLabels } from '../registry/device-labels'
import { EnkakuError } from '../util/errors'
import { decodeCursor, decodeStringCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

const GroupBody = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
})

const GroupPatchBody = GroupBody.partial()

function toSec(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0
}

function rowToGroupInfo(db: Db, row: GroupRow): GroupInfo {
  const resolved = resolveGroup(db, row)
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: toSec(row.createdAt),
    deviceCount: resolved.usable.length + resolved.skipped.length,
    usableCount: resolved.usable.length,
  }
}

/**
 * Group CRUD, read-only membership (plan 22.0 §4.4, renamed by plan 207 —
 * MVP 15 §0.1): a group is a container, so its own body carries only `name`
 * and `description`. Membership is now the `set-group` actions API verb
 * (`POST /api/actions/set-group`), never a route on this router.
 */
export function createGroupRoutes(deps: {
  db: Db
  audit: AuditLogger
  /** Live activities plus last-control tail (plan 205 §4.10) — omitted (as in tests that predate this plan) falls back to `{ activities: [], lastControl: null }`. */
  activitiesOf?: (deviceId: string) => DeviceActivityState
  /**
   * Farm networks (plan 88 §3.6, §4.1) — `discovery.networks`, read fresh
   * per request, same "read settings live" discipline `api/devices.ts`'s own
   * `farmNetworks()` already follows. Optional, defaulting to no network
   * match, so every existing caller keeps compiling and behaving exactly as
   * before.
   */
  networks?: () => FarmNetwork[]
  /**
   * The address book's declared media (plan 88 §3.1, §3.2, §4.3) —
   * `loadDeclaredMedia`'s own return shape, resolved fresh per request, same
   * discipline as `networks` above. Optional, same reasoning.
   */
  declaredMedia?: () => Map<string, ConnectionMedium | null> | undefined
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  const nextPosition = (): number => {
    const top = db.select({ value: max(groups.position) }).from(groups).get()
    return top?.value == null ? 0 : top.value + 1
  }

  const mustGet = (id: string): GroupRow => {
    const row = db.select().from(groups).where(eq(groups.id, id)).get()
    if (!row) throw new EnkakuError('group_not_found', `no such group: ${id}`)
    return row
  }

  // The farm's own order (`groups.position` ASC, id as the tiebreak), keyset
  // paged on that same pair. It used to be `created_at` DESC; migration 0088
  // backfilled `position` from exactly that order, so no strip moved when the
  // column arrived.
  app.get('/', (c) => {
    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const cursor = decodeCursor(cursorParam)
    const keyset = keysetWhere(cursor ? { value: cursor.sortValue, id: cursor.id } : null, groups.position, groups.id, 'asc')
    const page = db
      .select()
      .from(groups)
      .where(keyset)
      .orderBy(asc(groups.position), asc(groups.id))
      .limit(limit + 1)
      .all()
    const hasMore = page.length > limit
    const rows = hasMore ? page.slice(0, limit) : page
    const last = rows[rows.length - 1]
    const nextCursor = hasMore && last ? encodeCursor(last.position, last.id) : null
    const total = db.select().from(groups).all().length

    const items = rows.map((r) => rowToGroupInfo(db, r))
    return c.json({ items, nextCursor, total, groups: items })
  })

  // `device.settings` (plan 34 §4.4, §4.5) — there is no `device.manage` in
  // the ACL matrix; a group is device organisation, and `device.settings`
  // is already the audit action label the `set-group` verb uses too, so it
  // is the closest existing permission, not an invented one.
  app.post('/', requirePermission('device.settings'), async (c) => {
    const body = GroupBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { name, description? } is required')
    const row: GroupRow = {
      id: crypto.randomUUID(),
      name: body.data.name,
      description: body.data.description ?? null,
      createdAt: new Date(),
      // A new group joins the END of the strip, after every group an
      // operator has already placed.
      position: nextPosition(),
    }
    db.insert(groups).values(row).run()
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'group.create', target: row.id, meta: { name: row.name } })
    return typedJson(c, GroupResponseSchema, { group: rowToGroupInfo(db, row) }, 201)
  })

  /**
   * Stores the farm's group order: `{ ids }` is EVERY group id, first tab
   * first. Anything else — a missing id, an unknown one, a duplicate — is a
   * 409 naming the difference, because it means the caller's list is stale
   * (a group was created or deleted since it read), and guessing where the
   * missing group belongs would move a tab nobody touched.
   *
   * Registered before `/:id` routes read nothing from this path, but it sits
   * above them anyway so a later `PUT /:id` can never shadow it.
   */
  app.put('/order', requirePermission('device.settings'), async (c) => {
    const body = GroupOrderBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { ids: string[] } is required')
    const ids = body.data.ids
    const known = db.select({ id: groups.id }).from(groups).all().map((r) => r.id)
    const knownSet = new Set(known)
    const given = new Set(ids)
    const unknown = ids.filter((id) => !knownSet.has(id))
    const missing = known.filter((id) => !given.has(id))
    if (given.size !== ids.length || unknown.length > 0 || missing.length > 0) {
      const detail = [
        unknown.length > 0 ? `unknown: ${unknown.join(', ')}` : null,
        missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
        given.size !== ids.length ? 'duplicate ids' : null,
      ].filter((x): x is string => x !== null)
      throw new EnkakuError('E_GROUP_ORDER_STALE', `ids must list every group exactly once (${detail.join('; ')})`)
    }
    db.transaction((tx) => {
      ids.forEach((id, index) => {
        tx.update(groups).set({ position: index }).where(eq(groups.id, id)).run()
      })
    })
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'group.reorder', meta: { ids } })
    const rows = db.select().from(groups).orderBy(asc(groups.position), asc(groups.id)).all()
    return typedJson(c, GroupOrderResponseSchema, { groups: rows.map((r) => rowToGroupInfo(db, r)) })
  })

  app.patch('/:id', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = GroupPatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'invalid body')
    const patch: Partial<GroupRow> = {}
    if (body.data.name !== undefined) patch.name = body.data.name
    if (body.data.description !== undefined) patch.description = body.data.description
    if (Object.keys(patch).length > 0) db.update(groups).set(patch).where(eq(groups.id, row.id)).run()
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'group.update', target: row.id, meta: { patch: Object.keys(patch) } })
    return typedJson(c, GroupResponseSchema, { group: rowToGroupInfo(db, mustGet(row.id)) })
  })

  // Deleting a group unassigns its members in the same transaction — the
  // devices stay, only the container goes away (plan 22.0 §3.6, acceptance #3).
  // Past batch reports that named this group stand alone, unaffected.
  app.delete('/:id', requirePermission('device.settings'), (c) => {
    const row = mustGet(c.req.param('id'))
    deleteGroupAndUnassign(db, row.id)
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'group.delete', target: row.id, meta: { name: row.name } })
    return c.body(null, 204)
  })

  // This group's members, paginated the same way `/api/devices` is (plan
  // 22.0 §4.4) — label ASC, id ASC, since membership already forces an
  // in-memory pass (labels live in a separate table, same as the main list).
  app.get('/:id/devices', (c) => {
    const row = mustGet(c.req.param('id'))
    const rows = groupMembers(db, row.id)
    const labelMap = loadDeviceLabels(
      db,
      rows.map((r) => r.id),
    )
    const group = { id: row.id, name: row.name }
    // Resolved ONCE for the whole list, never per row — the same N+1 rule
    // `device-registry.ts`'s `loadGroupNames`/`loadRecentCrashes` already
    // state, extended here to `connection.medium` (plan 88 §3.6, §4.1).
    const networks = deps.networks?.() ?? []
    const media = deps.declaredMedia?.() ?? new Map<string, ConnectionMedium | null>()
    // The number (plan 89 §4.3) — one query for this list, same N+1
    // discipline as `labelMap`/`networks`/`media` above.
    const numbers = loadDeviceNumbers(db)
    const infos: DeviceInfo[] = rows
      .map((r) =>
        rowToDeviceInfo(r, labelMap.get(r.id) ?? [], group, null, null, deps.activitiesOf?.(r.id) ?? { activities: [], lastControl: null }, networks, media, numbers.get(r.stableId) ?? null),
      )
      .sort((a, b) => (a.label === b.label ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.label < b.label ? -1 : 1))

    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const cursor = decodeStringCursor(cursorParam)
    const startIdx = cursor
      ? infos.findIndex((d) => d.label > cursor.sortValue || (d.label === cursor.sortValue && d.id > cursor.id))
      : 0
    const windowed = startIdx === -1 ? [] : infos.slice(startIdx, startIdx + limit + 1)
    const hasMore = windowed.length > limit
    const items = hasMore ? windowed.slice(0, limit) : windowed
    const last = items[items.length - 1]
    const nextCursor = hasMore && last ? encodeCursor(last.label, last.id) : null

    return c.json({ items, nextCursor, total: infos.length })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const status = err.code === 'group_not_found' ? 404 : err.code === 'device_not_found' ? 404 : err.code === 'E_BAD_REQUEST' ? 400 : err.code === 'E_GROUP_ORDER_STALE' ? 409 : 500
      return c.json(err.toJSON(), status as 400)
    }
    throw err
  })

  return app
}
