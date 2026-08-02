import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db'
import { jobs, scripts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from '../api/pagination'

const PublishBody = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
  bundle: z.string().min(1),
  /** The entry file's source, for the readable preview. Optional for older CLIs. */
  source: z.string().optional(),
  paramsSchema: z.unknown().optional(),
})

const PatchBody = z.object({ enabled: z.boolean() })

const ERROR_STATUS: Record<string, number> = {
  script_not_found: 404,
  script_version_exists: 409,
  script_in_use: 409,
  unauthorized: 401,
  E_BAD_REQUEST: 400,
}

/**
 * Script CRUD (plan 05 §4.9). Every publish creates a new row; (name, version)
 * is unique so older jobs stay reproducible.
 */
export function createScriptRoutes(deps: { db: Db; publishToken?: string }): Hono {
  const app = new Hono()
  const { db } = deps

  // Mutation guard: a token when one is configured (full auth arrives in Plan 09).
  app.use('*', async (c, next) => {
    const mutating = c.req.method !== 'GET'
    if (mutating && deps.publishToken) {
      const auth = c.req.header('authorization')
      if (auth !== `Bearer ${deps.publishToken}`) {
        throw new EnkakuError('unauthorized', 'invalid publish token')
      }
    }
    await next()
  })

  app.get('/', (c) => {
    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const cursor = decodeCursor(cursorParam)
    const keyset = keysetWhere(
      cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
      scripts.createdAt,
      scripts.id,
    )
    const page = db
      .select({
        id: scripts.id,
        name: scripts.name,
        version: scripts.version,
        paramsSchema: scripts.paramsSchema,
        enabled: scripts.enabled,
        createdBy: scripts.createdBy,
        createdAt: scripts.createdAt,
      })
      .from(scripts)
      .where(keyset)
      .orderBy(desc(scripts.createdAt), desc(scripts.id))
      .limit(limit + 1)
      .all()
    const hasMore = page.length > limit
    const rows = hasMore ? page.slice(0, limit) : page
    const last = rows[rows.length - 1]
    const nextCursor =
      hasMore && last ? encodeCursor(Math.floor((last.createdAt ?? new Date(0)).getTime() / 1000), last.id) : null
    const total = db.select().from(scripts).all().length

    const items = rows.map((r) => ({ ...r, createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : null }))
    return c.json({ items, nextCursor, total, scripts: items })
  })

  app.get('/:id', (c) => {
    const row = db.select().from(scripts).where(eq(scripts.id, c.req.param('id'))).get()
    if (!row) throw new EnkakuError('script_not_found', 'no such script')
    const includeBundle = c.req.query('bundle') === '1'
    return c.json({
      script: {
        id: row.id,
        name: row.name,
        version: row.version,
        paramsSchema: row.paramsSchema,
        source: row.source,
        enabled: row.enabled,
        createdBy: row.createdBy,
        createdAt: row.createdAt ? Math.floor(row.createdAt.getTime() / 1000) : null,
        ...(includeBundle ? { bundle: row.bundle } : {}),
      },
    })
  })

  app.post('/', async (c) => {
    const body = PublishBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    }
    const existing = db
      .select()
      .from(scripts)
      .where(and(eq(scripts.name, body.data.name), eq(scripts.version, body.data.version)))
      .get()
    if (existing) {
      throw new EnkakuError('script_version_exists', `${body.data.name}@${body.data.version} already exists`)
    }
    const id = crypto.randomUUID()
    db.insert(scripts)
      .values({
        id,
        name: body.data.name,
        version: body.data.version,
        bundle: body.data.bundle,
        source: body.data.source ?? null,
        paramsSchema: body.data.paramsSchema ?? null,
        enabled: true,
        createdAt: new Date(),
      })
      .run()
    return c.json({ script: { id, name: body.data.name, version: body.data.version } }, 201)
  })

  app.patch('/:id', async (c) => {
    const body = PatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: 'a body of { enabled } is required' } }, 400)
    const row = db.select().from(scripts).where(eq(scripts.id, c.req.param('id'))).get()
    if (!row) throw new EnkakuError('script_not_found', 'no such script')
    db.update(scripts).set({ enabled: body.data.enabled }).where(eq(scripts.id, row.id)).run()
    return c.json({ script: { id: row.id, enabled: body.data.enabled } })
  })

  app.delete('/:id', (c) => {
    const id = c.req.param('id')
    const row = db.select().from(scripts).where(eq(scripts.id, id)).get()
    if (!row) throw new EnkakuError('script_not_found', 'no such script')
    const active = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.scriptId, id), inArray(jobs.status, ['queued', 'running'])))
      .all()
    if (active.length > 0) {
      throw new EnkakuError('script_in_use', `${active.length} queued or running job(s) still use this script`)
    }
    db.delete(scripts).where(eq(scripts.id, id)).run()
    return c.json({ ok: true })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
