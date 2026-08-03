import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import { createBatchRoutes, queryBatchRows, type BatchRoutesDeps } from './batches'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

let seq = 0
function seed(db: Db, n: number, createdAt?: Date) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `batch-${String(++seq).padStart(4, '0')}`
    ids.push(id)
    db.insert(batches)
      .values({
        id,
        scriptId: 'internal:sleep',
        concurrency: 0,
        order: 'as-listed',
        status: 'queued',
        createdAt: createdAt ?? new Date((base + i) * 1000),
      })
      .run()
  }
  return ids
}

describe('queryBatchRows keyset pagination', () => {
  test('pages through 5 rows with limit=2: union is exactly the 5, no duplicates', () => {
    const db = setUp()
    const ids = seed(db, 5)

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const { rows, nextCursor, total } = queryBatchRows(db, { cursor, limit: 2 })
      for (const r of rows) {
        expect(seen.has(r.id)).toBe(false)
        seen.add(r.id)
      }
      expect(total).toBe(5)
      pages++
      if (nextCursor === null) break
      cursor = nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  test('a batch inserted mid-paging is never skipped or repeated', () => {
    const db = setUp()
    seed(db, 4)

    const page1 = queryBatchRows(db, { cursor: null, limit: 2 })
    expect(page1.rows).toHaveLength(2)

    seed(db, 1) // newer than everything already loaded

    const page2 = queryBatchRows(db, { cursor: page1.nextCursor, limit: 2 })
    const overlap = page2.rows.filter((r) => page1.rows.some((p) => p.id === r.id))
    expect(overlap).toHaveLength(0)
  })

  test('same-second timestamps (a batch stamps one `now` across its jobs — but two batches can also share a tick) still page correctly via id', () => {
    const db = setUp()
    const sameInstant = new Date(1_700_000_000 * 1000)
    const ids = seed(db, 6, sameInstant)

    const seen: string[] = []
    let cursor: string | null = null
    for (;;) {
      const { rows, nextCursor } = queryBatchRows(db, { cursor, limit: 2 })
      if (rows.length === 0) break
      seen.push(...rows.map((r) => r.id))
      if (nextCursor === null) break
      cursor = nextCursor
    }
    expect(new Set(seen).size).toBe(6)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  test('a malformed cursor is rejected, not silently ignored', () => {
    const db = setUp()
    expect(() => queryBatchRows(db, { cursor: 'not-valid-base64!!!', limit: 50 })).toThrow()
  })
})

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function makeApp(db: Db, role: 'admin' | 'operator' | null) {
  const audit = createAuditLogger(db)
  const registry = new ExecutorRegistry()
  registry.register('internal:sleep', { validateParams: (p) => p, run: async () => undefined })
  const deps: BatchRoutesDeps = {
    db,
    jobStore: { listByBatch: () => [] } as unknown as BatchRoutesDeps['jobStore'],
    scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
    audit,
    broadcastBatchStatus: () => {},
    scriptNames: () => new Map(),
    registry,
    findScript: () => null,
  }
  return withUser(role, createBatchRoutes(deps))
}

/**
 * `requirePermission('job.run')` on `POST /` (plan 34 §4.4, §4.5) — there is
 * no `job.manage` permission; `job.run` is the closest existing fit and,
 * being an OPERATOR permission, must not lock an operator out of a flow
 * they already had.
 */
describe('requirePermission("job.run") on /api/batches mutations (plan 34 §4.4, §4.5)', () => {
  const createBody = { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1'] } }

  test('POST / is refused with no authenticated user', async () => {
    const db = setUp()
    const app = makeApp(db, null)
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody) })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an operator (job.run is an OPERATOR permission) may create a batch — no lockout', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator')
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody) })
    expect(res.status).toBe(201)
  })

  test('GET / needs no permission at all — read routes stay open', async () => {
    const db = setUp()
    const app = makeApp(db, null)
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })
})
