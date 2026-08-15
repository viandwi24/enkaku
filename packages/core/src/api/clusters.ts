import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ClusterMoveResponseSchema, ClusterResponseSchema, type ClusterInfo, type ConnectionMedium, type DeviceInfo, type LeaseHolder } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { clusters, type ClusterRow } from '../db/schema'
import { assignDevices, clusterMembers, deleteClusterAndUnassign, unassignDevices } from '../clusters/membership'
import { resolveCluster, resolveTarget } from '../clusters/resolve'
import { loadClusterNames, rowToDeviceInfo, type FarmNetwork } from '../registry/device-registry'
import { loadDeviceNumbers } from '../registry/device-number'
import { loadDeviceTags } from '../registry/device-tags'
import { EnkakuError } from '../util/errors'
import { decodeCursor, decodeStringCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

const ClusterBody = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
})

const ClusterPatchBody = ClusterBody.partial()

/** Plan 22.0 §4.4 — assign multiple devices to a cluster in one call. */
const AssignBody = z.object({ deviceIds: z.array(z.string()).min(1) })

/** Ad-hoc target preview (plan 22.0 §3.5, §4.4) — tags plus an optional explicit list, not a saved cluster. */
const TargetPreviewBody = z.object({
  tags: z.array(z.string()).default([]),
  deviceIds: z.array(z.string()).default([]),
})

function toSec(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0
}

function rowToClusterInfo(db: Db, row: ClusterRow): ClusterInfo {
  const resolved = resolveCluster(db, row)
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
 * Cluster CRUD plus membership (plan 22.0 §4.4, superseding plan 20 §4.6): a
 * cluster is a container now, so its own body carries only `name` and
 * `description` — membership moves through the `/:id/devices` routes and
 * `PUT /api/devices/:id/cluster` (in `api/devices.ts`), never through the
 * cluster's own PATCH body.
 */
export function createClusterRoutes(deps: {
  db: Db
  audit: AuditLogger
  /** Lease holder (plan 71 §4.4) — omitted (as in tests that predate this plan) falls back to `null`. */
  heldByOf?: (deviceId: string) => LeaseHolder | null
  /**
   * Farm networks (plan 88 §3.6, §4.1) — `discovery.networks`, read fresh
   * per request, same "read settings live" discipline `api/devices.ts`'s own
   * `farmNetworks()` already follows. Residual gap: 88.5's own pass wired
   * `daemon.ts`, `capability/context.ts`, `api/topology.ts` and
   * `api/devices.ts`'s GET routes, but missed this router entirely — a
   * device's connection badge on its OWN device page could read `OTG` while
   * the exact same device, viewed through its cluster's device list, read
   * `TCP`. Optional, defaulting to no network match, so every existing
   * caller (tests, and any caller that predates this plan) keeps compiling
   * and behaving exactly as before.
   */
  networks?: () => FarmNetwork[]
  /**
   * The address book's declared media (plan 88 §3.1, §3.2, §4.3) —
   * `loadDeclaredMedia`'s own return shape, resolved fresh per request, same
   * discipline as `networks` above. Optional, same reasoning.
   */
  declaredMedia?: () => Map<string, ConnectionMedium | null> | undefined
  /**
   * Who is currently assisting a device (plan 91 §3.4 item 4, §4.4) — the
   * same producer gap `networks`/`declaredMedia` above already document:
   * step 91.4 wired this into `api/devices.ts` alone and flagged this router
   * as a known gap (see docs/plans/96-m61-hotfixes.md's continuation of
   * §96.5–96.9). Resolved from the co-control manager's `assistedBy`
   * (`lease/co-control.ts`), the same `heldByOf`-shaped per-device accessor.
   * Optional, defaulting to `[]` per device — an unknown assist state is
   * "nobody is assisting", never a guess — so every existing caller
   * (`clusters.test.ts`, and any caller that predates this field) keeps
   * compiling and behaving exactly as before.
   */
  assistedByOf?: (deviceId: string) => LeaseHolder[]
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  const mustGet = (id: string): ClusterRow => {
    const row = db.select().from(clusters).where(eq(clusters.id, id)).get()
    if (!row) throw new EnkakuError('cluster_not_found', `no such cluster: ${id}`)
    return row
  }

  app.get('/', (c) => {
    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const cursor = decodeCursor(cursorParam)
    const keyset = keysetWhere(
      cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
      clusters.createdAt,
      clusters.id,
    )
    const page = db
      .select()
      .from(clusters)
      .where(keyset)
      .orderBy(desc(clusters.createdAt), desc(clusters.id))
      .limit(limit + 1)
      .all()
    const hasMore = page.length > limit
    const rows = hasMore ? page.slice(0, limit) : page
    const last = rows[rows.length - 1]
    const nextCursor =
      hasMore && last ? encodeCursor(Math.floor((last.createdAt ?? new Date(0)).getTime() / 1000), last.id) : null
    const total = db.select().from(clusters).all().length

    const items = rows.map((r) => rowToClusterInfo(db, r))
    return c.json({ items, nextCursor, total, clusters: items })
  })

  // `device.settings` (plan 34 §4.4, §4.5) — there is no `device.manage` in
  // the ACL matrix; a cluster is device organisation, and `device.settings`
  // is already the audit action label these exact mutations use below
  // (`cluster.assign`/`cluster.unassign` in `api/devices.ts` too), so it is
  // the closest existing permission, not an invented one.
  app.post('/', requirePermission('device.settings'), async (c) => {
    const body = ClusterBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { name, description? } is required')
    const row: ClusterRow = {
      id: crypto.randomUUID(),
      name: body.data.name,
      description: body.data.description ?? null,
      createdAt: new Date(),
    }
    db.insert(clusters).values(row).run()
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'cluster.create', target: row.id, meta: { name: row.name } })
    return typedJson(c, ClusterResponseSchema, { cluster: rowToClusterInfo(db, row) }, 201)
  })

  app.patch('/:id', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = ClusterPatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'invalid body')
    const patch: Partial<ClusterRow> = {}
    if (body.data.name !== undefined) patch.name = body.data.name
    if (body.data.description !== undefined) patch.description = body.data.description
    if (Object.keys(patch).length > 0) db.update(clusters).set(patch).where(eq(clusters.id, row.id)).run()
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'cluster.update', target: row.id, meta: { patch: Object.keys(patch) } })
    return typedJson(c, ClusterResponseSchema, { cluster: rowToClusterInfo(db, mustGet(row.id)) })
  })

  // Deleting a cluster unassigns its members in the same transaction — the
  // devices stay, only the container goes away (plan 22.0 §3.6, acceptance #3).
  // Past batch reports that named this cluster stand alone, unaffected.
  app.delete('/:id', requirePermission('device.settings'), (c) => {
    const row = mustGet(c.req.param('id'))
    deleteClusterAndUnassign(db, row.id)
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'cluster.delete', target: row.id, meta: { name: row.name } })
    return c.body(null, 204)
  })

  // Assign devices into this cluster — moves any that already belong to
  // another one, and reports what each moved from (plan 22.0 §4.3, §4.4,
  // acceptance #2).
  app.post('/:id/devices', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = AssignBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { deviceIds: string[] } is required')
    const { moved } = assignDevices(db, row.id, body.data.deviceIds)
    deps.audit.record({
      userId: c.get('user')?.id ?? null,
      action: 'cluster.assign',
      target: row.id,
      meta: { deviceIds: body.data.deviceIds, moved },
    })
    return typedJson(c, ClusterMoveResponseSchema, { moved })
  })

  // Remove one device from this cluster (idempotent — a device already
  // unclustered, or clustered elsewhere, is left exactly as it was).
  app.delete('/:id/devices/:deviceId', requirePermission('device.settings'), (c) => {
    const row = mustGet(c.req.param('id'))
    const deviceId = c.req.param('deviceId')
    const members = new Set(clusterMembers(db, row.id).map((d) => d.id))
    if (members.has(deviceId)) {
      unassignDevices(db, [deviceId])
      deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'cluster.unassign', target: row.id, meta: { deviceId } })
    }
    return c.body(null, 204)
  })

  // This cluster's members, paginated the same way `/api/devices` is (plan
  // 22.0 §4.4) — label ASC, id ASC, since membership already forces an
  // in-memory pass (tags live in a separate table, same as the main list).
  app.get('/:id/devices', (c) => {
    const row = mustGet(c.req.param('id'))
    const rows = clusterMembers(db, row.id)
    const tagMap = loadDeviceTags(
      db,
      rows.map((r) => r.id),
    )
    const cluster = { id: row.id, name: row.name }
    // Resolved ONCE for the whole list, never per row — the same N+1 rule
    // `device-registry.ts:171-175` already states for `loadClusterNames`/
    // `loadRecentCrashes`, extended here to `connection.medium` (plan 88
    // §3.6, §4.1).
    const networks = deps.networks?.() ?? []
    const media = deps.declaredMedia?.() ?? new Map<string, ConnectionMedium | null>()
    // The number (plan 89 §4.3) — one query for this list, same N+1
    // discipline as `tagMap`/`networks`/`media` above.
    const numbers = loadDeviceNumbers(db)
    const infos: DeviceInfo[] = rows
      .map((r) => ({
        ...rowToDeviceInfo(r, tagMap.get(r.id) ?? [], cluster, null, null, deps.heldByOf?.(r.id) ?? null, networks, media, numbers.get(r.stableId) ?? null),
        // Plan 91 §3.4 item 4, §4.4 — `assistedBy` alongside `heldBy`, the
        // same override-after-build shape `api/devices.ts` established:
        // `rowToDeviceInfo` has no `assistedByOf` parameter of its own, so
        // this overrides its `[]` default with the real, live answer.
        assistedBy: deps.assistedByOf?.(r.id) ?? [],
      }))
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

  // The ad-hoc target preview (plan 22.0 §3.5, §4.6, superseding plan 20's
  // per-cluster preview — a saved cluster's members are now read directly
  // from `GET /:id/devices`). Still resolves `resolveTarget`, unchanged:
  // dispatching to a tag set you cannot see first is how scripts run on the
  // wrong phones.
  app.post('/preview', async (c) => {
    const body = TargetPreviewBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { tags?, deviceIds? } is required')
    return c.json(resolveTarget(db, body.data))
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const status = err.code === 'cluster_not_found' ? 404 : err.code === 'device_not_found' ? 404 : err.code === 'E_BAD_REQUEST' ? 400 : 500
      return c.json(err.toJSON(), status as 400)
    }
    throw err
  })

  return app
}
