import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiTokenService } from '../auth/api-tokens'
import type { AuthEnv } from '../auth/middleware'
import type { AuthUser } from '../auth/service'
import { apiTokens as apiTokensTable, users } from '../db/schema'
import { openDb, runMigrations, type Db } from '../db'
import { createTokenRoutes } from './tokens'

function setUp(): { db: Db; userId: string } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const userId = 'admin-1'
  // `ApiTokenService.validate` joins back to `users` (a token whose user was
  // deleted must not authenticate), so a real row is needed here.
  opened.db.insert(users).values({ id: userId, email: 'admin@example.com', role: 'admin', createdAt: new Date() }).run()
  return { db: opened.db, userId }
}

/** Mirrors `authMiddleware` well enough for a route test — the same pattern `artifacts.test.ts` uses. */
function withUser(inner: Hono<AuthEnv>, user: AuthUser): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', user)
    await next()
  })
  app.route('/', inner)
  return app
}

describe('POST/GET/DELETE /api/tokens', () => {
  test('POST returns the plaintext once; the row afterward carries only a hash', async () => {
    const { db, userId } = setUp()
    const app = withUser(createTokenRoutes({ apiTokens: createApiTokenService(db) }), {
      id: userId,
      email: 'admin@example.com',
      role: 'admin',
    })

    const res = await app.request('/', { method: 'POST', body: JSON.stringify({ label: 'ci runner' }) })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { id: string; token: string; label: string; userId: string }
    expect(created.token).toBeTruthy()
    expect(created.label).toBe('ci runner')
    expect(created.userId).toBe(userId)

    const stored = db.select().from(apiTokensTable).where(eq(apiTokensTable.id, created.id)).get()
    expect(stored).toBeTruthy()
    expect(stored?.tokenHash).not.toBe(created.token)

    // GET never returns the plaintext or the hash again.
    const list = await app.request('/')
    const body = (await list.json()) as { tokens: Array<Record<string, unknown>> }
    expect(body.tokens).toHaveLength(1)
    expect(body.tokens[0]).not.toHaveProperty('token')
    expect(body.tokens[0]).not.toHaveProperty('tokenHash')
  })

  test('an operator (no user.manage) is refused on every route', async () => {
    const { db, userId } = setUp()
    const app = withUser(createTokenRoutes({ apiTokens: createApiTokenService(db) }), {
      id: userId,
      email: 'op@example.com',
      role: 'operator',
    })
    expect((await app.request('/')).status).toBe(403)
    expect((await app.request('/', { method: 'POST', body: JSON.stringify({ label: 'x' }) })).status).toBe(403)
    expect((await app.request('/some-id', { method: 'DELETE' })).status).toBe(403)
  })

  test('DELETE revokes the token; a subsequent auth attempt through the service fails', async () => {
    const { db, userId } = setUp()
    const svc = createApiTokenService(db)
    const app = withUser(createTokenRoutes({ apiTokens: svc }), { id: userId, email: 'a@example.com', role: 'admin' })

    const created = svc.create(userId, 'to delete')
    expect(svc.validate(created.token)).not.toBeNull()

    const del = await app.request(`/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(svc.validate(created.token)).toBeNull()
  })

  test('DELETE of an unknown id is refused (404), not silently ok', async () => {
    const { db, userId } = setUp()
    const app = withUser(createTokenRoutes({ apiTokens: createApiTokenService(db) }), {
      id: userId,
      email: 'a@example.com',
      role: 'admin',
    })
    const res = await app.request('/does-not-exist', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('a malformed create body is refused with 400', async () => {
    const { db, userId } = setUp()
    const app = withUser(createTokenRoutes({ apiTokens: createApiTokenService(db) }), {
      id: userId,
      email: 'a@example.com',
      role: 'admin',
    })
    const res = await app.request('/', { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(400)
  })
})
