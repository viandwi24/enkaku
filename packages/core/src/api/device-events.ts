import { Hono } from 'hono'
import { DeviceEventStreamSchema, type DeviceEvent } from '@enkaku/protocol'
import { and, desc, eq, like, type SQL } from 'drizzle-orm'
import type { Db } from '../db'
import { deviceEvents, type DeviceEventRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery, type Page } from './pagination'

function toDeviceEvent(row: DeviceEventRow): DeviceEvent {
  return {
    id: row.id,
    deviceId: row.deviceId,
    stream: row.stream as DeviceEvent['stream'],
    kind: row.kind,
    actor: row.actor,
    meta: (row.meta as Record<string, unknown> | null) ?? null,
    at: Math.floor(row.at.getTime() / 1000),
  }
}

/**
 * Keyset pagination on `(at DESC, id DESC)` (plan 18 §4.5, converted to the
 * shared helper by plan 30 §4.2). `at` is stored in whole seconds (the
 * repo-wide DB timestamp convention), so a burst of events sharing one
 * second is common on the input stream — that used to need a special
 * tie-extension pass (a page boundary landing mid-tie would drop rows), but
 * with `id` as a mandatory tiebreaker the standard "fetch one extra row"
 * keyset pattern already handles ties correctly, so that pass is gone.
 */
export function queryDeviceEventsPage(
  db: Db,
  opts: { deviceId: string; stream: 'main' | 'input'; cursor: string | null; limit: number; kindPrefix: string | null },
): Page<DeviceEvent> {
  const base: SQL[] = [eq(deviceEvents.deviceId, opts.deviceId), eq(deviceEvents.stream, opts.stream)]
  if (opts.kindPrefix) base.push(like(deviceEvents.kind, `${opts.kindPrefix}%`))

  const cursor = decodeCursor(opts.cursor)
  const keyset = keysetWhere(
    cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
    deviceEvents.at,
    deviceEvents.id,
  )
  const conds = keyset ? [...base, keyset] : base

  const page = db
    .select()
    .from(deviceEvents)
    .where(and(...conds))
    .orderBy(desc(deviceEvents.at), desc(deviceEvents.id))
    .limit(opts.limit + 1)
    .all()

  const hasMore = page.length > opts.limit
  const rows = hasMore ? page.slice(0, opts.limit) : page
  const last = rows[rows.length - 1]
  // Total is deliberately null (plan 30 §8 risks) — counting an
  // append-heavy, potentially month-long event log on every page would be
  // the opposite of cheap.
  const nextCursor = hasMore && last ? encodeCursor(Math.floor(last.at.getTime() / 1000), last.id) : null
  return { items: rows.map(toDeviceEvent), nextCursor, total: null }
}

export function createDeviceEventsRoutes(deps: { db: Db }): Hono {
  const app = new Hono()

  app.get('/:id/events', (c) => {
    const deviceId = c.req.param('id')
    const streamResult = DeviceEventStreamSchema.safeParse(c.req.query('stream'))
    if (!streamResult.success) throw new EnkakuError('E_BAD_REQUEST', "'stream' must be 'main' or 'input'")

    const { cursor, limit } = parsePageQuery(c)
    const kindPrefix = c.req.query('kind') ?? null

    const result = queryDeviceEventsPage(deps.db, { deviceId, stream: streamResult.data, cursor, limit, kindPrefix })
    return c.json({
      ...result,
      // Legacy keys, kept alongside `items`/`nextCursor` for one release
      // (plan 30 §3.3) — `nextBefore` carries the same boundary as a raw
      // unix-seconds number, matching its pre-plan-30 shape.
      events: result.items,
      nextBefore: result.nextCursor ? decodeCursor(result.nextCursor)!.sortValue : null,
    })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), 400)
    throw err
  })

  return app
}
