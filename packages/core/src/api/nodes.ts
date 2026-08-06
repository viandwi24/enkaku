import { Hono } from 'hono'
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { NodeCreateResponseSchema } from '@enkaku/protocol'
import { can } from '../auth/acl'
import type { AuthEnv } from '../auth/middleware'
import type { Db } from '../db'
import { nodes } from '../db/schema'
import { buildIceServers } from '../relay/ice-credentials'
import type { NodeAuth } from '../tunnel/node-auth'
import { EnkakuError } from '../util/errors'
import { type Page, decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

const EnrollBody = z.object({ token: z.string().min(1), name: z.string().min(1), platform: z.string() })
const CreateBody = z.object({ name: z.string().min(1) })

const ERROR_STATUS: Record<string, number> = {
  'node.invalid_token': 401,
  'auth.forbidden': 403,
}

export interface NodeInfo {
  id: string
  name: string
  status: string
  platform: string | null
  lastSeen: number | null
}

/** Keyset over `nodes` (`createdAt DESC, id DESC`, plan 30 §4.2) — a plain function so it is testable without the auth layer. */
export function queryNodesPage(db: Db, opts: { cursor: string | null; limit: number }): Page<NodeInfo> {
  const cursor = decodeCursor(opts.cursor)
  const keyset = keysetWhere(
    cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
    nodes.createdAt,
    nodes.id,
  )
  const page = db
    .select()
    .from(nodes)
    .where(keyset)
    .orderBy(desc(nodes.createdAt), desc(nodes.id))
    .limit(opts.limit + 1)
    .all()
  const hasMore = page.length > opts.limit
  const rows = hasMore ? page.slice(0, opts.limit) : page
  const last = rows[rows.length - 1]
  const nextCursor =
    hasMore && last ? encodeCursor(Math.floor((last.createdAt ?? new Date(0)).getTime() / 1000), last.id) : null
  const total = db.select().from(nodes).all().length

  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status ?? 'pending',
    platform: r.platform,
    lastSeen: r.lastSeen ? Math.floor(r.lastSeen.getTime() / 1000) : null,
  }))
  return { items, nextCursor, total }
}

/**
 * Node management (plan 11 §4.2, renamed from "agent" in plan 61). Endpoint
 * `/enroll` is deliberately public: the enrollment token itself is the
 * authentication (single-use), the same join-token pattern other
 * orchestrators use.
 */
export function createNodeRoutes(deps: { nodeAuth: NodeAuth; db: Db }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.post('/enroll', async (c) => {
    const body = EnrollBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('node.invalid_token', 'a body of { token, name, platform } is required')
    const result = deps.nodeAuth.redeem(body.data.token, { name: body.data.name, platform: body.data.platform })
    return c.json(result, 201)
  })

  app.get('/', (c) => {
    if (!can(c.get('user').role, 'user.manage')) throw new EnkakuError('auth.forbidden', 'requires the admin role')
    const { cursor, limit } = parsePageQuery(c)
    const result = queryNodesPage(deps.db, { cursor, limit })
    return c.json(result)
  })

  app.post('/', async (c) => {
    if (!can(c.get('user').role, 'user.manage')) throw new EnkakuError('auth.forbidden', 'requires the admin role')
    const body = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('auth.forbidden', 'a body of { name } is required')
    // The token is shown once only — the DB stores its hash.
    return typedJson(c, NodeCreateResponseSchema, deps.nodeAuth.createEnrollment(body.data.name), 201)
  })

  app.delete('/:id', (c) => {
    if (!can(c.get('user').role, 'user.manage')) throw new EnkakuError('auth.forbidden', 'requires the admin role')
    deps.nodeAuth.disable(c.req.param('id'))
    return c.json({ ok: true })
  })

  /** ICE configuration for the browser (self-hosted STUN/TURN, time-limited credentials). */
  app.get('/ice-config', (c) => c.json({ iceServers: buildIceServers(c.get('user')?.id ?? 'anon') }))

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    throw err
  })

  return app
}
