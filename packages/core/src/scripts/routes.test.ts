import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { createScriptRoutes } from './routes'

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

let seq = 0
function seed(db: Db, n: number) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const n2 = ++seq
    const id = `script-${String(n2).padStart(4, '0')}`
    ids.push(id)
    db.insert(scripts)
      .values({ id, name: `script-${n2}`, version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date((base + i) * 1000) })
      .run()
  }
  return ids
}

describe('GET /api/scripts keyset pagination', () => {
  test('pages through 5 rows with limit=2: union is exactly the 5, no duplicates', async () => {
    const db = setUp()
    const ids = seed(db, 5)
    const app = createScriptRoutes({ db })

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const url = cursor ? `/?limit=2&cursor=${encodeURIComponent(cursor)}` : '/?limit=2'
      const res = await app.request(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null; total: number | null }
      for (const s of body.items) {
        expect(seen.has(s.id)).toBe(false)
        seen.add(s.id)
      }
      expect(body.total).toBe(5)
      pages++
      if (body.nextCursor === null) break
      cursor = body.nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  test('a script inserted mid-paging is never skipped or repeated', async () => {
    const db = setUp()
    seed(db, 4)
    const app = createScriptRoutes({ db })

    const first = await app.request('/?limit=2')
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    seed(db, 1)
    const second = await app.request(`/?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`)
    const secondBody = (await second.json()) as { items: Array<{ id: string }> }
    const overlap = secondBody.items.filter((s) => firstBody.items.some((f) => f.id === s.id))
    expect(overlap).toHaveLength(0)
  })

  test('a malformed cursor returns 400', async () => {
    const db = setUp()
    const app = createScriptRoutes({ db })
    const res = await app.request('/?cursor=not-valid-base64!!!')
    expect(res.status).toBe(400)
  })

  test('a limit above the cap is clamped, not honoured', async () => {
    const db = setUp()
    seed(db, 3)
    const app = createScriptRoutes({ db })
    const res = await app.request('/?limit=99999')
    const body = (await res.json()) as { items: unknown[]; total: number | null }
    expect(body.items).toHaveLength(3)
    expect(body.total).toBe(3)
  })
})

describe('requirePermission on /api/scripts mutations (plan 34 §4.4, §4.5, acceptance #7)', () => {
  const publishBody = { name: 'my-script', version: '1.0.0', bundle: 'export {}' }

  test('POST / (script.publish) is refused with no authenticated user', async () => {
    const db = setUp()
    const app = withUser(null, createScriptRoutes({ db }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(publishBody) })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an operator (script.publish is an OPERATOR permission) may publish — no lockout', async () => {
    const db = setUp()
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(publishBody) })
    expect(res.status).toBe(201)
  })

  test('PATCH /:id (script.publish) is refused with no authenticated user', async () => {
    const db = setUp()
    const [id] = seed(db, 1)
    const app = withUser(null, createScriptRoutes({ db }))
    const res = await app.request(`/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    expect(res.status).toBe(403)
  })

  test('DELETE /:id (script.delete) refuses an operator — admin-only', async () => {
    const db = setUp()
    const [id] = seed(db, 1)
    const app = withUser('operator', createScriptRoutes({ db }))
    const res = await app.request(`/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')

    // The script must still exist — a refused request changes nothing.
    const still = await withUser('admin', createScriptRoutes({ db })).request(`/${id}`)
    expect(still.status).toBe(200)
  })

  test('DELETE /:id (script.delete) admits an admin', async () => {
    const db = setUp()
    const [id] = seed(db, 1)
    const app = withUser('admin', createScriptRoutes({ db }))
    const res = await app.request(`/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  test('GET / needs no permission at all — read routes stay open', async () => {
    const db = setUp()
    const app = withUser(null, createScriptRoutes({ db }))
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })
})
