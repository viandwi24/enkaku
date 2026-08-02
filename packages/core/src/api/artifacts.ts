import { join, normalize } from 'node:path'
import { Hono } from 'hono'
import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { artifacts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
  log: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  mp4: 'video/mp4',
}

/** Per-job artifacts: list and download (spec §11.2, §19 job detail). */
export function createArtifactRoutes(deps: { db: Db; dataDir: string }): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    const jobId = c.req.query('jobId')
    const deviceId = c.req.query('deviceId')
    if (!jobId && !deviceId) throw new EnkakuError('E_BAD_REQUEST', 'either ?jobId= or ?deviceId= is required')
    // The owner column (plan 24 §4.6 — exactly one of jobId/deviceId is set
    // on any row, so this is never ambiguous).
    const ownerColumn = jobId ? artifacts.jobId : artifacts.deviceId
    const ownerValue = jobId ?? deviceId
    if (!ownerValue) throw new EnkakuError('E_BAD_REQUEST', 'either ?jobId= or ?deviceId= is required')
    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const cursor = decodeCursor(cursorParam)
    // Kept ascending (oldest first) — an artifact list reads as a timeline,
    // and pagination changes only how a list is windowed, not its existing
    // sort direction (plan 30 §2 non-goals).
    const keyset = keysetWhere(
      cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
      artifacts.createdAt,
      artifacts.id,
      'asc',
    )
    const where = keyset ? and(eq(ownerColumn, ownerValue), keyset) : eq(ownerColumn, ownerValue)
    const page = deps.db
      .select()
      .from(artifacts)
      .where(where)
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
      .limit(limit + 1)
      .all()
    const hasMore = page.length > limit
    const rows = hasMore ? page.slice(0, limit) : page
    const last = rows[rows.length - 1]
    const nextCursor =
      hasMore && last ? encodeCursor(Math.floor((last.createdAt ?? new Date(0)).getTime() / 1000), last.id) : null
    const total = deps.db.select().from(artifacts).where(eq(ownerColumn, ownerValue)).all().length

    const items = rows.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      deviceId: r.deviceId,
      kind: r.kind,
      label: r.label,
      path: r.path,
      sizeBytes: r.sizeBytes,
      createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : 0,
    }))
    return c.json({ items, nextCursor, total, artifacts: items })
  })

  app.get('/:id/content', async (c) => {
    const row = deps.db.select().from(artifacts).where(eq(artifacts.id, c.req.param('id'))).get()
    if (!row) throw new EnkakuError('artifact_not_found', 'no such artifact')
    // The DB path is relative to app-data; reject traversal.
    const rel = normalize(row.path)
    if (rel.startsWith('..')) throw new EnkakuError('E_BAD_REQUEST', 'invalid artifact path')
    const abs = join(deps.dataDir, rel)
    const file = Bun.file(abs)
    if (!(await file.exists())) throw new EnkakuError('artifact_not_found', 'the artifact file is no longer on disk')
    const ext = rel.split('.').pop() ?? ''
    return new Response(file, {
      headers: { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' },
    })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      return c.json(err.toJSON(), (err.code === 'artifact_not_found' ? 404 : 400) as 400)
    }
    throw err
  })

  return app
}
