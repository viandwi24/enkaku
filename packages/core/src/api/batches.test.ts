import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { batches, devices, jobs, scripts } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import { createScriptExecutor } from '../jobs/executors/script'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createJobStore } from '../queue/job-store'
import { createScriptRegistry } from '../scripts/registry'
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

/**
 * Plan 95 §5 step 95.6's verifiable result: `dispatch.ts:131` already called
 * `deps.validateScript` before ANY target resolution or row write (F11) —
 * what was missing was the fallback executor actually enforcing anything.
 * This exercises the real `POST /api/batches` route with the REAL
 * `createScriptExecutor` wired as the fallback, exactly as `daemon.ts` wires
 * it, so the "batches are covered by the same edit" claim is proven through
 * the HTTP layer, not just at the function-call level.
 */
describe('POST /api/batches rejects invalid params before any job or device is touched (plan 95 §5 step 95.6)', () => {
  function makeAppWithRealValidation(db: Db, role: 'admin' | 'operator' | null) {
    db.insert(scripts)
      .values({
        id: 'checkout-1.0.0',
        name: 'checkout',
        version: '1.0.0',
        bundle: 'export {}',
        enabled: true,
        paramsSchema: { type: 'object', properties: { videos: { type: 'integer', maximum: 2000 } }, required: ['videos'] },
        createdAt: new Date(),
      })
      .run()
    const scriptRegistry = createScriptRegistry({ db, dataDir: `/tmp/enkaku-batches-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
    const audit = createAuditLogger(db)
    const registry = new ExecutorRegistry()
    registry.setFallback(createScriptExecutor({ registry: scriptRegistry, runner: {} as never }))
    const deps: BatchRoutesDeps = {
      db,
      jobStore: { listByBatch: () => [] } as unknown as BatchRoutesDeps['jobStore'],
      scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
      audit,
      broadcastBatchStatus: () => {},
      scriptNames: () => new Map(),
      registry,
      findScript: (id) => (id === 'checkout-1.0.0' ? { enabled: true } : null),
    }
    return withUser(role, createBatchRoutes(deps))
  }

  test('{ videos: 9999 } is refused with 400 invalid_job_params, naming the field, with no batch or job row created and no device touched', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    db.insert(devices).values({ id: 'd2', stableId: 'stable-d2', serial: 'serial-d2', label: 'd2', status: 'idle' }).run()
    const app = makeAppWithRealValidation(db, 'operator')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptId: 'checkout-1.0.0', params: { videos: 9999 }, target: { deviceIds: ['d1', 'd2'] } }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; issues?: { path: string; message: string }[] } }
    expect(body.error.code).toBe('invalid_job_params')
    expect(body.error.issues).toEqual([{ path: 'videos', message: 'must be at most 2000' }])
    expect(db.select().from(batches).all().length).toBe(0)
    expect(db.select().from(jobs).all().length).toBe(0)
    expect(db.select().from(devices).all().every((d) => d.status === 'idle')).toBe(true)
  })

  test('a params value inside every bound creates the batch normally', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = makeAppWithRealValidation(db, 'operator')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptId: 'checkout-1.0.0', params: { videos: 30 }, target: { deviceIds: ['d1'] } }),
    })

    expect(res.status).toBe(201)
    expect(db.select().from(jobs).all().length).toBe(1)
  })
})

/**
 * Plan 95 §4.4, §5 step 95.7 — rerun-failed reconciles the ORIGINAL batch's
 * stored `params` against its script's CURRENT schema before re-enqueuing.
 * `row.scriptId` is a concrete, immutable version (plan 62 §3.3) so its own
 * schema cannot itself drift — in real use the trigger is a dev-slot
 * script's schema redefined under the SAME stable id between the batch's
 * first run and the rerun (plan 82 §3.3). These tests seed the incompatible
 * state directly, which exercises the handler's own reconciliation logic
 * without needing the full dev-slot machinery.
 */
describe('POST /:id/rerun-failed reconciles params before re-enqueuing (plan 95 §4.4, §5 step 95.7)', () => {
  function makeAppWithReconciliation(db: Db, role: 'admin' | 'operator' | null) {
    const scriptRegistry = createScriptRegistry({ db, dataDir: `/tmp/enkaku-batches-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
    const audit = createAuditLogger(db)
    const registry = new ExecutorRegistry()
    registry.setFallback(createScriptExecutor({ registry: scriptRegistry, runner: {} as never }))
    const deps: BatchRoutesDeps = {
      db,
      jobStore: createJobStore(db),
      scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
      audit,
      broadcastBatchStatus: () => {},
      scriptNames: () => new Map(),
      registry,
      findScript: (id) => (db.select().from(scripts).where(eq(scripts.id, id)).get() ? { enabled: true } : null),
      scriptRegistry,
    }
    return withUser(role, createBatchRoutes(deps))
  }

  function seedFailedBatch(db: Db, params: unknown) {
    db.insert(batches).values({ id: 'b1', scriptId: 'checkout-1.0.0', params, concurrency: 0, order: 'as-listed', status: 'error', createdAt: new Date() }).run()
    db.insert(jobs)
      .values({ id: 'j1', scriptId: 'checkout-1.0.0', deviceId: 'd1', params, priority: 0, status: 'failed', createdAt: new Date(), batchId: 'b1', batchSeq: 0 })
      .run()
  }

  test('a blocking finding (missing, no default) refuses the rerun with 409 params_incompatible naming the field, enqueueing nothing', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    db.insert(scripts)
      .values({
        id: 'checkout-1.0.0',
        name: 'checkout',
        version: '1.0.0',
        bundle: 'export {}',
        enabled: true,
        createdAt: new Date(),
        paramsSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] },
      })
      .run()
    seedFailedBatch(db, {}) // region is required by the (same, concrete) schema and was never set
    const app = makeAppWithReconciliation(db, 'operator')

    const res = await app.request('/b1/rerun-failed', { method: 'POST' })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; issues?: { path: string; message: string }[] } }
    expect(body.error.code).toBe('params_incompatible')
    expect(body.error.issues?.[0]?.path).toBe('region')
    // Only the ORIGINAL batch/job exist — nothing new was enqueued.
    expect(db.select().from(batches).all()).toHaveLength(1)
    expect(db.select().from(jobs).all()).toHaveLength(1)
  })

  test('a non-blocking finding (tightened bound, has a default) reruns using the RECONCILED value, not the stale stored one', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    db.insert(scripts)
      .values({
        id: 'checkout-1.0.0',
        name: 'checkout',
        version: '1.0.0',
        bundle: 'export {}',
        enabled: true,
        createdAt: new Date(),
        paramsSchema: { type: 'object', properties: { videos: { type: 'integer', maximum: 2000, default: 30 } } },
      })
      .run()
    seedFailedBatch(db, { videos: 9999 }) // valid when the batch first ran, no longer valid — but there IS a default
    const app = makeAppWithReconciliation(db, 'operator')

    const res = await app.request('/b1/rerun-failed', { method: 'POST' })

    expect(res.status).toBe(201)
    const rerunBatchId = ((await res.json()) as { batch: { id: string } }).batch.id
    const rerunJobs = db.select().from(jobs).where(eq(jobs.batchId, rerunBatchId)).all()
    expect(rerunJobs[0]?.params).toEqual({ videos: 30 })
  })

  test('an unchanged schema (the ordinary case — no drift at all) reruns the params verbatim', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    db.insert(scripts)
      .values({
        id: 'checkout-1.0.0',
        name: 'checkout',
        version: '1.0.0',
        bundle: 'export {}',
        enabled: true,
        createdAt: new Date(),
        paramsSchema: { type: 'object', properties: { videos: { type: 'integer', maximum: 2000 } } },
      })
      .run()
    seedFailedBatch(db, { videos: 30 })
    const app = makeAppWithReconciliation(db, 'operator')

    const res = await app.request('/b1/rerun-failed', { method: 'POST' })

    expect(res.status).toBe(201)
    const rerunBatchId = ((await res.json()) as { batch: { id: string } }).batch.id
    const rerunJobs = db.select().from(jobs).where(eq(jobs.batchId, rerunBatchId)).all()
    expect(rerunJobs[0]?.params).toEqual({ videos: 30 })
  })
})
