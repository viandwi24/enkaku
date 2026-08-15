import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { createBatchPacer } from '../clusters/pacer'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, batches, devices, jobs, scripts } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import { createScriptExecutor } from '../jobs/executors/script'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createJobStore } from '../queue/job-store'
import { createScriptRegistry } from '../scripts/registry'
import { createLogger } from '../util/logger'
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

/**
 * Plan 94 §3.9, §4.9, step 94.8 — `POST /:id/stop` replaces `/cancel`. This
 * fake mirrors exactly what `services/job-service.ts`'s real `cancel()`
 * does for the two statuses `stopBatch` ever calls it on (`queued`,
 * `running`) — a `JobService.cancel`-shaped test double, not a second
 * implementation of the abort logic itself (that belongs to
 * `services/job-service.test.ts` alone); it exists so this file can assert
 * `stopBatch` calls through to it correctly without standing up a full
 * `ExecutorHost`.
 */
function fakeJobServiceFor(db: Db) {
  const calls: { jobId: string; wasStatus: string }[] = []
  return {
    calls,
    service: {
      cancel(jobId: string) {
        const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get()
        if (!row) throw new Error(`no such job: ${jobId}`)
        calls.push({ jobId, wasStatus: row.status ?? 'queued' })
        if (row.status !== 'queued' && row.status !== 'running') throw new Error(`job is ${row.status}`)
        db.update(jobs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(jobs.id, jobId)).run()
        return { job: {} as never, cancelledDescendants: 0 }
      },
    },
  }
}

describe('POST /api/batches/:id/stop (plan 94 §3.9, §4.9, step 94.8 — replaces /cancel)', () => {
  function makeStopApp(db: Db, opts: { jobService?: ReturnType<typeof fakeJobServiceFor>['service']; role?: 'admin' | 'operator' | null } = {}) {
    const audit = createAuditLogger(db)
    const deps: BatchRoutesDeps = {
      db,
      jobStore: createJobStore(db),
      scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
      audit,
      broadcastBatchStatus: () => {},
      scriptNames: () => new Map(),
      registry: new ExecutorRegistry(),
      findScript: () => null,
      jobService: opts.jobService,
    }
    return withUser(opts.role ?? 'operator', createBatchRoutes(deps))
  }

  test('cancels every queued member and aborts every running one, reporting {cancelled, aborted, refused}', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle', ownerId: null }).run()
    db.insert(devices).values({ id: 'd2', stableId: 's-d2', serial: 'ser-d2', label: 'd2', status: 'busy', ownerId: null }).run()
    db.insert(batches).values({ id: 'b1', scriptId: 'internal:sleep', concurrency: 0, order: 'as-listed', status: 'running', createdAt: new Date() }).run()
    db.insert(jobs).values({ id: 'j1', scriptId: 'internal:sleep', deviceId: 'd1', params: {}, priority: 0, status: 'queued', createdAt: new Date(), batchId: 'b1', batchSeq: 0 }).run()
    db.insert(jobs).values({ id: 'j2', scriptId: 'internal:sleep', deviceId: 'd2', params: {}, priority: 0, status: 'running', createdAt: new Date(), batchId: 'b1', batchSeq: 1 }).run()

    const { service, calls } = fakeJobServiceFor(db)
    const app = makeStopApp(db, { jobService: service })

    const res = await app.request('/b1/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cancelled: number; aborted: number; refused: number; refusedDeviceIds: string[] }
    expect(body).toEqual({ cancelled: 1, aborted: 1, refused: 0, refusedDeviceIds: [] })
    expect(calls).toEqual([
      { jobId: 'j1', wasStatus: 'queued' },
      { jobId: 'j2', wasStatus: 'running' },
    ])

    const j1 = db.select().from(jobs).where(eq(jobs.id, 'j1')).get()
    const j2 = db.select().from(jobs).where(eq(jobs.id, 'j2')).get()
    expect(j1?.status).toBe('cancelled')
    expect(j2?.status).toBe('cancelled')

    // Every member settled — the batch moves on from `stopping` to a real terminal status (plan 94 §3.9).
    const batchRow = db.select().from(batches).where(eq(batches.id, 'b1')).get()
    expect(batchRow?.status).toBe('cancelled')
  })

  test('a device the operator does not own is refused, counted and named — not silently skipped (F27)', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle', ownerId: null }).run()
    db.insert(devices).values({ id: 'd2', stableId: 's-d2', serial: 'ser-d2', label: 'd2', status: 'idle', ownerId: 'someone-else' }).run()
    db.insert(batches).values({ id: 'b1', scriptId: 'internal:sleep', concurrency: 0, order: 'as-listed', status: 'queued', createdAt: new Date() }).run()
    db.insert(jobs).values({ id: 'j1', scriptId: 'internal:sleep', deviceId: 'd1', params: {}, priority: 0, status: 'queued', createdAt: new Date(), batchId: 'b1', batchSeq: 0 }).run()
    db.insert(jobs).values({ id: 'j2', scriptId: 'internal:sleep', deviceId: 'd2', params: {}, priority: 0, status: 'queued', createdAt: new Date(), batchId: 'b1', batchSeq: 1 }).run()

    const { service } = fakeJobServiceFor(db)
    // `withUser` fixes the acting user's id at `u1` (line 110 above) — not
    // `someone-else`, so `canCancelJob` refuses d2 exactly like a real
    // operator without rights to it.
    const app = makeStopApp(db, { jobService: service, role: 'operator' })

    const res = await app.request('/b1/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cancelled: number; aborted: number; refused: number; refusedDeviceIds: string[] }
    expect(body.cancelled).toBe(1)
    expect(body.refused).toBe(1)
    expect(body.refusedDeviceIds).toEqual(['d2'])

    const j1 = db.select().from(jobs).where(eq(jobs.id, 'j1')).get()
    const j2 = db.select().from(jobs).where(eq(jobs.id, 'j2')).get()
    expect(j1?.status).toBe('cancelled')
    expect(j2?.status).toBe('queued') // untouched — refused, not silently skipped
  })

  test('an admin (job.cancel.any) is refused nothing, even on a device it does not own', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle', ownerId: 'someone-else' }).run()
    db.insert(batches).values({ id: 'b1', scriptId: 'internal:sleep', concurrency: 0, order: 'as-listed', status: 'queued', createdAt: new Date() }).run()
    db.insert(jobs).values({ id: 'j1', scriptId: 'internal:sleep', deviceId: 'd1', params: {}, priority: 0, status: 'queued', createdAt: new Date(), batchId: 'b1', batchSeq: 0 }).run()

    const { service } = fakeJobServiceFor(db)
    const app = makeStopApp(db, { jobService: service, role: 'admin' })

    const res = await app.request('/b1/stop', { method: 'POST' })
    const body = (await res.json()) as { cancelled: number; refused: number }
    expect(body).toMatchObject({ cancelled: 1, refused: 0 })
  })

  test('with no jobService wired, every affected member is refused rather than silently doing nothing', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle', ownerId: null }).run()
    db.insert(batches).values({ id: 'b1', scriptId: 'internal:sleep', concurrency: 0, order: 'as-listed', status: 'queued', createdAt: new Date() }).run()
    db.insert(jobs).values({ id: 'j1', scriptId: 'internal:sleep', deviceId: 'd1', params: {}, priority: 0, status: 'queued', createdAt: new Date(), batchId: 'b1', batchSeq: 0 }).run()

    const app = makeStopApp(db, {})
    const res = await app.request('/b1/stop', { method: 'POST' })
    const body = (await res.json()) as { cancelled: number; aborted: number; refused: number }
    expect(body).toMatchObject({ cancelled: 0, aborted: 0, refused: 1 })
    const j1 = db.select().from(jobs).where(eq(jobs.id, 'j1')).get()
    expect(j1?.status).toBe('queued') // nothing was falsely reported as cancelled
  })

  test('a settle arriving DURING the stop plans no further repetition — the pacer is checked first (plan 94 §3.9 rule 1, criterion 12)', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle', ownerId: null }).run()
    // A paced batch (repeatCount 4) with one device still `running` its
    // FIRST repetition — exactly the "mid-flight" scenario the step's own
    // verifiable result names.
    db.insert(batches)
      .values({
        id: 'b1',
        scriptId: 'internal:sleep',
        concurrency: 0,
        order: 'as-listed',
        status: 'running',
        createdAt: new Date(),
        repeatCount: 4,
        intervalMinMs: 1000,
        intervalMaxMs: 2000,
        deviceIntervalMs: 0,
      })
      .run()
    db.insert(jobs)
      .values({ id: 'j1', scriptId: 'internal:sleep', deviceId: 'd1', params: {}, priority: 0, status: 'running', createdAt: new Date(), batchId: 'b1', batchSeq: 0, batchRepeat: 0 })
      .run()

    const pacer = createBatchPacer({ db, scheduler: { kick: () => {}, start: () => {}, stop: () => {} }, log: createLogger('test') })
    const { service } = fakeJobServiceFor(db)
    const app = makeStopApp(db, { jobService: service })

    const res = await app.request('/b1/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    const before = db.select().from(jobs).where(eq(jobs.batchId, 'b1')).all()
    expect(before).toHaveLength(1) // stop itself planned nothing

    // Simulate the late settle a real `ExecutorHost` would fire for the job
    // this stop just aborted (`executor-host.ts`'s own `settle()` calls
    // `recomputeBatchStatus(..., deviceId)` → `pacer.onMemberSettled`) —
    // arriving AFTER the stop request already returned, the worst-case
    // interleaving named in the step's own brief.
    pacer.onMemberSettled('b1', 'd1')

    const after = db.select().from(jobs).where(eq(jobs.batchId, 'b1')).all()
    expect(after).toHaveLength(1) // still exactly one job — no repetition 1 was planned
  })
})

/**
 * `JobExecutor.requires` at the batch dispatch gate (plan 93 §3.12, §4.6,
 * step 93.8) — closes F10: `POST /api/batches {scriptId:'internal:install'}`
 * used to require only `job.run`, no `device.files`, no `transfer.enabled`.
 * The fake `internal:install` registered here carries the SAME `requires`
 * declaration the real `jobs/executors/install.ts` does.
 */
function makeAppWithInstallGate(db: Db, opts: { role: 'admin' | 'operator' | null; shellMode: 'off' | 'operator' | 'admin'; transferEnabled: boolean }) {
  const audit = createAuditLogger(db)
  const registry = new ExecutorRegistry()
  registry.register('internal:install', {
    validateParams: (p) => p,
    run: async () => undefined,
    requires: { gate: 'files', setting: 'transfer.enabled' },
  })
  const deps: BatchRoutesDeps = {
    db,
    jobStore: createJobStore(db),
    scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
    audit,
    broadcastBatchStatus: () => {},
    scriptNames: () => new Map(),
    registry,
    findScript: () => null,
    shellMode: () => opts.shellMode,
    transferEnabled: () => opts.transferEnabled,
  }
  return withUser(opts.role, createBatchRoutes(deps))
}

describe('POST /api/batches — JobExecutor.requires closes F10 (plan 93 §3.12, §4.6, step 93.8)', () => {
  const installBody = { scriptId: 'internal:install', params: {}, target: { deviceIds: ['d1'] } }

  test('an operator without device.files, shell.mode: admin, gets 403 — no batch, no job row', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    const app = makeAppWithInstallGate(db, { role: 'operator', shellMode: 'admin', transferEnabled: true })

    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(installBody) })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
    expect(db.select().from(batches).all()).toHaveLength(0)
    expect(db.select().from(jobs).all()).toHaveLength(0)
  })

  test('transfer.enabled: false refuses even an admin', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    const app = makeAppWithInstallGate(db, { role: 'admin', shellMode: 'admin', transferEnabled: false })

    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(installBody) })
    expect(res.status).toBe(403)
    expect(db.select().from(batches).all()).toHaveLength(0)
  })

  test('an admin with transfer.enabled: true and shell.mode: admin dispatches successfully', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    const app = makeAppWithInstallGate(db, { role: 'admin', shellMode: 'admin', transferEnabled: true })

    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(installBody) })
    expect(res.status).toBe(201)
  })
})

/**
 * `BatchInfo.skipped` (plan 93 §3.12, §4.2, §4.6, step 93.8, closing F11) —
 * every device in the target that never got a job row, with why, surfaced
 * on the batch itself instead of only in the audit log.
 */
/** Unlike `makeApp` above (whose `jobStore` is a stub always returning `[]`), `?only=failed` needs a REAL job store to filter by status. */
function makeAppWithRealJobStore(db: Db, role: 'admin' | 'operator' | null) {
  const audit = createAuditLogger(db)
  const registry = new ExecutorRegistry()
  registry.register('internal:sleep', { validateParams: (p) => p, run: async () => undefined })
  const deps: BatchRoutesDeps = {
    db,
    jobStore: createJobStore(db),
    scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
    audit,
    broadcastBatchStatus: () => {},
    scriptNames: () => new Map(),
    registry,
    findScript: () => null,
  }
  return withUser(role, createBatchRoutes(deps))
}

describe('BatchInfo.skipped and POST /:id/rerun?only= (plan 93 §3.12, §4.6, step 93.8)', () => {
  test('a batch targeting two offline devices among three returns them under skipped with reasons', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    db.insert(devices).values({ id: 'd2', stableId: 's-d2', serial: 'ser-d2', label: 'd2', status: 'offline' }).run()
    db.insert(devices).values({ id: 'd3', stableId: 's-d3', serial: 'ser-d3', label: 'd3', status: 'quarantined' }).run()
    const app = makeAppWithRealJobStore(db, 'operator')

    const body = { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1', 'd2', 'd3'] } }
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(res.status).toBe(201)
    const parsed = (await res.json()) as { batch: { id: string; skipped: { deviceId: string; reason: string }[] } }
    expect(parsed.batch.skipped.sort((a, b) => a.deviceId.localeCompare(b.deviceId))).toEqual([
      { deviceId: 'd2', reason: 'offline' },
      { deviceId: 'd3', reason: 'quarantined' },
    ])

    // GET /:id also reports it — not just the create response.
    const getRes = await app.request(`/${parsed.batch.id}`)
    const getBody = (await getRes.json()) as { batch: { skipped: { deviceId: string; reason: string }[] } }
    expect(getBody.batch.skipped).toHaveLength(2)
  })

  test('a batch with no skips reports skipped: []', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator')

    const body = { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1'] } }
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const parsed = (await res.json()) as { batch: { skipped: unknown[] } }
    expect(parsed.batch.skipped).toEqual([])
  })

  test('?only=skipped re-runs exactly the skipped devices, ?only=failed re-runs exactly the failed ones', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    db.insert(devices).values({ id: 'd2', stableId: 's-d2', serial: 'ser-d2', label: 'd2', status: 'offline' }).run()
    db.insert(devices).values({ id: 'd3', stableId: 's-d3', serial: 'ser-d3', label: 'd3', status: 'idle' }).run()
    const app = makeAppWithRealJobStore(db, 'operator')

    const body = { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1', 'd2', 'd3'] } }
    const createRes = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const created = (await createRes.json()) as { batch: { id: string } }

    // d3's job fails; d1's stays queued.
    const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, created.batch.id)).all()
    const d3Job = memberJobs.find((j) => j.deviceId === 'd3')
    if (d3Job) db.update(jobs).set({ status: 'failed' }).where(eq(jobs.id, d3Job.id)).run()

    // d2 came back online since the original dispatch — a real reason to retarget it.
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd2')).run()

    const skippedRes = await app.request(`/${created.batch.id}/rerun?only=skipped`, { method: 'POST' })
    expect(skippedRes.status).toBe(201)
    const skippedBatch = (await skippedRes.json()) as { batch: { id: string } }
    const skippedJobs = db.select().from(jobs).where(eq(jobs.batchId, skippedBatch.batch.id)).all()
    expect(skippedJobs.map((j) => j.deviceId)).toEqual(['d2'])

    const failedRes = await app.request(`/${created.batch.id}/rerun?only=failed`, { method: 'POST' })
    expect(failedRes.status).toBe(201)
    const failedBatch = (await failedRes.json()) as { batch: { id: string } }
    const failedJobs = db.select().from(jobs).where(eq(jobs.batchId, failedBatch.batch.id)).all()
    expect(failedJobs.map((j) => j.deviceId)).toEqual(['d3'])
  })

  test('an unknown "only" value is a 400, and rerunning an empty subset is a coded E_NO_TARGETS', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator')

    const body = { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1'] } }
    const createRes = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const created = (await createRes.json()) as { batch: { id: string } }

    const badOnly = await app.request(`/${created.batch.id}/rerun?only=bogus`, { method: 'POST' })
    expect(badOnly.status).toBe(400)

    const noSkips = await app.request(`/${created.batch.id}/rerun?only=skipped`, { method: 'POST' })
    expect(noSkips.status).toBe(409)
    const noSkipsBody = (await noSkips.json()) as { error: { code: string } }
    expect(noSkipsBody.error.code).toBe('E_NO_TARGETS')
  })
})

/**
 * Plan 94 §5 step 94.11, acceptance criterion 19 (F30) — `rerun-failed` and
 * `?only=failed` must both carry the original batch's own pacing/priority/
 * queue-timeout forward, on the SAME `carryForwardShape` helper, so the two
 * routes cannot diverge later (this step's own trap (a): the dominant defect
 * class of this whole session was exactly a sibling call site left behind).
 */
describe('rerun carries pacing, priority and queue timeout forward (plan 94 §5 step 94.11, F30, acceptance criterion 19)', () => {
  function makeAppWithPacer(db: Db, role: 'admin' | 'operator' | null) {
    const audit = createAuditLogger(db)
    const registry = new ExecutorRegistry()
    registry.register('internal:sleep', { validateParams: (p) => p, run: async () => undefined })
    const deps: BatchRoutesDeps = {
      db,
      jobStore: createJobStore(db),
      scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
      audit,
      broadcastBatchStatus: () => {},
      scriptNames: () => new Map(),
      registry,
      findScript: () => null,
      pacer: createBatchPacer({ db, scheduler: { kick: () => {}, start: () => {}, stop: () => {} }, log: createLogger('test') }),
    }
    return withUser(role, createBatchRoutes(deps))
  }

  /** One paced, prioritised, queue-timed batch over 3 devices — d1/d2 fail, d3 succeeds. `pastTimeout` puts the ORIGINAL batch's own `expiresAt` in the past, on purpose (trap b's own test case). */
  function seedPacedBatch(db: Db, opts: { pastTimeout: boolean }) {
    const createdAt = new Date(1_700_000_000 * 1000)
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    db.insert(devices).values({ id: 'd2', stableId: 's-d2', serial: 'ser-d2', label: 'd2', status: 'idle' }).run()
    db.insert(devices).values({ id: 'd3', stableId: 's-d3', serial: 'ser-d3', label: 'd3', status: 'idle' }).run()
    db.insert(batches)
      .values({
        id: 'b1',
        scriptId: 'internal:sleep',
        params: null,
        concurrency: 0,
        order: 'as-listed',
        status: 'failed',
        createdAt,
        repeatCount: 5,
        intervalMinMs: 1000,
        intervalMaxMs: 2000,
        deviceIntervalMs: 500,
      })
      .run()
    // The original batch's own queue timeout: a 3600s duration from its own createdAt.
    // `pastTimeout: true` seeds a value that has ALREADY passed relative to `now` (the
    // test always evaluates well after 1_700_000_000) — the exact case trap (b) exists for.
    const expiresAt = opts.pastTimeout ? Math.floor(createdAt.getTime() / 1000) + 3600 : Math.floor(Date.now() / 1000) + 999_999_999
    for (const [deviceId, status] of [
      ['d1', 'failed'],
      ['d2', 'expired'],
      ['d3', 'success'],
    ] as const) {
      db.insert(jobs)
        .values({
          id: `j-${deviceId}`,
          scriptId: 'internal:sleep',
          deviceId,
          params: null,
          priority: 7,
          status,
          createdAt,
          batchId: 'b1',
          batchSeq: 0,
          expiresAt,
        })
        .run()
    }
  }

  test('rerun-failed carries priority, pacing (full shape) and expiresAt-as-duration forward, and targets failed AND expired devices, once each', async () => {
    const db = setUp()
    seedPacedBatch(db, { pastTimeout: false })
    const app = makeAppWithPacer(db, 'operator')

    const res = await app.request('/b1/rerun-failed', { method: 'POST' })
    expect(res.status).toBe(201)
    const rerunBatchId = ((await res.json()) as { batch: { id: string } }).batch.id

    const rerunBatch = db.select().from(batches).where(eq(batches.id, rerunBatchId)).get()
    expect(rerunBatch?.repeatCount).toBe(5)
    expect(rerunBatch?.intervalMinMs).toBe(1000)
    expect(rerunBatch?.intervalMaxMs).toBe(2000)
    expect(rerunBatch?.deviceIntervalMs).toBe(500)

    const rerunJobs = db.select().from(jobs).where(eq(jobs.batchId, rerunBatchId)).all()
    // d1 (failed) and d2 (expired) — deduplicated, d3 (success) excluded.
    expect(rerunJobs.map((j) => j.deviceId).sort()).toEqual(['d1', 'd2'])
    expect(rerunJobs.every((j) => j.priority === 7)).toBe(true)
    // A future original expiresAt survives with the SAME remaining-from-now
    // shape: still comfortably in the future, not instantly expired.
    expect(rerunJobs.every((j) => (j.expiresAt ?? 0) > Math.floor(Date.now() / 1000) + 1000)).toBe(true)
  })

  test('an already-expired original queue timeout does NOT make the rerun expire instantly (trap b)', async () => {
    const db = setUp()
    seedPacedBatch(db, { pastTimeout: true })
    const app = makeAppWithPacer(db, 'operator')

    const res = await app.request('/b1/rerun-failed', { method: 'POST' })
    expect(res.status).toBe(201)
    const rerunBatchId = ((await res.json()) as { batch: { id: string } }).batch.id
    const rerunJobs = db.select().from(jobs).where(eq(jobs.batchId, rerunBatchId)).all()

    // The original job's `expiresAt` was already in the past — a byte-verbatim
    // copy would make every one of these <= now. The carried-forward DURATION
    // (3600s from the original batch's own createdAt) must instead be
    // re-applied from THIS rerun's own "now".
    const nowSec = Math.floor(Date.now() / 1000)
    for (const j of rerunJobs) {
      expect(j.expiresAt).not.toBeNull()
      expect(j.expiresAt as number).toBeGreaterThan(nowSec)
      expect(j.expiresAt as number).toBeLessThanOrEqual(nowSec + 3600 + 5) // +5s test slack
    }
  })

  test('a rerun of a paced batch reruns the FAILED DEVICES with the full original repeat count, not "however many repetitions were owed" (trap d)', async () => {
    const db = setUp()
    // d1 fails on repetition 2 of 5 (batchRepeat: 1), having already
    // succeeded on repetition 0 and 1 — there is no single well-defined
    // "how many repetitions does d1 still owe" answer for this device, which
    // is exactly why this step chose "redo the whole thing" over "resume".
    const createdAt = new Date(1_700_000_000 * 1000)
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    db.insert(batches)
      .values({
        id: 'b1',
        scriptId: 'internal:sleep',
        params: null,
        concurrency: 0,
        order: 'as-listed',
        status: 'failed',
        createdAt,
        repeatCount: 5,
        intervalMinMs: 1000,
        intervalMaxMs: 1000,
        deviceIntervalMs: 0,
      })
      .run()
    for (const [seq, batchRepeat, status] of [
      [0, 0, 'success'],
      [1, 1, 'success'],
      [2, 2, 'failed'],
    ] as const) {
      db.insert(jobs)
        .values({
          id: `j-d1-${seq}`,
          scriptId: 'internal:sleep',
          deviceId: 'd1',
          params: null,
          priority: 0,
          status,
          createdAt,
          batchId: 'b1',
          batchSeq: 0,
          batchRepeat,
        })
        .run()
    }
    const app = makeAppWithPacer(db, 'operator')

    const res = await app.request('/b1/rerun-failed', { method: 'POST' })
    expect(res.status).toBe(201)
    const rerunBatchId = ((await res.json()) as { batch: { id: string } }).batch.id
    const rerunBatch = db.select().from(batches).where(eq(batches.id, rerunBatchId)).get()
    // The FULL original repeatCount, not `5 - 2` or any other "remaining" arithmetic.
    expect(rerunBatch?.repeatCount).toBe(5)
    const rerunJobs = db.select().from(jobs).where(eq(jobs.batchId, rerunBatchId)).all()
    expect(rerunJobs.map((j) => j.deviceId)).toEqual(['d1'])
  })

  test('?only=failed carries the SAME shape forward as /rerun-failed (the two routes cannot diverge)', async () => {
    const db = setUp()
    seedPacedBatch(db, { pastTimeout: false })
    const app = makeAppWithPacer(db, 'operator')

    const res = await app.request('/b1/rerun?only=failed', { method: 'POST' })
    expect(res.status).toBe(201)
    const rerunBatchId = ((await res.json()) as { batch: { id: string } }).batch.id
    const rerunBatch = db.select().from(batches).where(eq(batches.id, rerunBatchId)).get()
    expect(rerunBatch?.repeatCount).toBe(5)
    expect(rerunBatch?.deviceIntervalMs).toBe(500)
    const rerunJobs = db.select().from(jobs).where(eq(jobs.batchId, rerunBatchId)).all()
    expect(rerunJobs.map((j) => j.deviceId).sort()).toEqual(['d1', 'd2'])
    expect(rerunJobs.every((j) => j.priority === 7)).toBe(true)
  })

  test('an unpaced batch reruns unpaced — no pacing block appears on the new batch (regression: byte-identical to before this step for the common case)', async () => {
    const db = setUp()
    const createdAt = new Date(1_700_000_000 * 1000)
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'd1', status: 'idle' }).run()
    db.insert(batches)
      .values({ id: 'b1', scriptId: 'internal:sleep', params: null, concurrency: 0, order: 'as-listed', status: 'failed', createdAt })
      .run()
    db.insert(jobs)
      .values({ id: 'j1', scriptId: 'internal:sleep', deviceId: 'd1', params: null, priority: 0, status: 'failed', createdAt, batchId: 'b1', batchSeq: 0 })
      .run()
    const app = makeAppWithPacer(db, 'operator')

    const res = await app.request('/b1/rerun-failed', { method: 'POST' })
    expect(res.status).toBe(201)
    const rerunBatchId = ((await res.json()) as { batch: { id: string } }).batch.id
    const rerunBatch = db.select().from(batches).where(eq(batches.id, rerunBatchId)).get()
    expect(rerunBatch?.repeatCount).toBe(1)
    expect(rerunBatch?.intervalMinMs).toBe(0)
    expect(rerunBatch?.intervalMaxMs).toBe(0)
    expect(rerunBatch?.deviceIntervalMs).toBe(0)
  })
})

/**
 * `GET /api/batches/:id/artifacts` and `.../artifacts.zip` (plan 93 §3.13,
 * §4.4, §4.7, step 93.10) — the collected-files surface for a bulk pull.
 * F12's fix (step 93.9) is what makes this possible at all: a pulled file's
 * artifact row now carries the pulling job's id, so these routes are a
 * plain join from that job back to its batch, never a second write path.
 */
describe('GET /api/batches/:id/artifacts and .../artifacts.zip (plan 93 §3.13, §4.4, §4.7, step 93.10)', () => {
  function makeArtifactApp(db: Db, dataDir: string, opts?: { archiveSettings?: () => { maxArchiveBytes: number } }) {
    const deps: BatchRoutesDeps = {
      db,
      jobStore: createJobStore(db),
      scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
      audit: createAuditLogger(db),
      broadcastBatchStatus: () => {},
      scriptNames: () => new Map(),
      registry: new ExecutorRegistry(),
      findScript: () => null,
      dataDir,
      archiveSettings: opts?.archiveSettings,
    }
    return withUser('operator', createBatchRoutes(deps))
  }

  /** Seeds a batch whose three member jobs each "pulled" one file — two devices SHARE a label AND a filename, on purpose (the collision this whole feature exists to survive). Returns the batch id and the temp data dir (caller must clean it up). */
  async function seedBulkPull(db: Db) {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-batch-artifacts-'))
    db.insert(devices).values({ id: 'd1', stableId: 's-d1', serial: 'ser-d1', label: 'Pixel 6', status: 'idle' }).run()
    db.insert(devices).values({ id: 'd2', stableId: 's-d2', serial: 'ser-d2', label: 'Pixel 6', status: 'idle' }).run() // SAME label as d1
    db.insert(devices).values({ id: 'd3', stableId: 's-d3', serial: 'ser-d3', label: 'Note 20', status: 'idle' }).run()
    db.insert(batches).values({ id: 'b1', scriptId: 'internal:pull', concurrency: 0, order: 'as-listed', status: 'success', createdAt: new Date() }).run()
    db.insert(jobs).values({ id: 'j1', scriptId: 'internal:pull', deviceId: 'd1', batchId: 'b1', status: 'success', createdAt: new Date() }).run()
    db.insert(jobs).values({ id: 'j2', scriptId: 'internal:pull', deviceId: 'd2', batchId: 'b1', status: 'success', createdAt: new Date() }).run()
    db.insert(jobs).values({ id: 'j3', scriptId: 'internal:pull', deviceId: 'd3', batchId: 'b1', status: 'success', createdAt: new Date() }).run()

    const files: Array<{ id: string; jobId: string; deviceId: string; label: string; content: string }> = [
      { id: 'art-1', jobId: 'j1', deviceId: 'd1', label: 'screenshot.png', content: 'PIXEL-6-D1-CONTENT' },
      { id: 'art-2', jobId: 'j2', deviceId: 'd2', label: 'screenshot.png', content: 'PIXEL-6-D2-CONTENT' }, // same filename as art-1, different device
      { id: 'art-3', jobId: 'j3', deviceId: 'd3', label: 'report.log', content: 'NOTE-20-D3-CONTENT' },
    ]
    for (const f of files) {
      const relDir = join('artifacts', `device-${f.deviceId}`)
      const dir = join(dataDir, relDir)
      mkdirSync(dir, { recursive: true })
      const relPath = join(relDir, `${f.id}.bin`)
      await Bun.write(join(dataDir, relPath), f.content)
      db.insert(artifacts)
        .values({ id: f.id, jobId: f.jobId, deviceId: f.deviceId, kind: 'file', label: f.label, path: relPath, sizeBytes: f.content.length, createdAt: new Date() })
        .run()
    }
    return { dataDir, files }
  }

  test('GET /:id/artifacts returns one row per device with label, stableId, filename, size, and a content URL', async () => {
    const db = setUp()
    const { dataDir } = await seedBulkPull(db)
    const app = makeArtifactApp(db, dataDir)

    const res = await app.request('/b1/artifacts')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ artifactId: string; deviceId: string; deviceLabel: string; stableId: string; filename: string; sizeBytes: number; contentUrl: string }> }
    expect(body.items).toHaveLength(3)
    const byId = new Map(body.items.map((i) => [i.artifactId, i]))
    expect(byId.get('art-1')).toMatchObject({ deviceId: 'd1', deviceLabel: 'Pixel 6', stableId: 's-d1', filename: 'screenshot.png' })
    expect(byId.get('art-2')).toMatchObject({ deviceId: 'd2', deviceLabel: 'Pixel 6', stableId: 's-d2', filename: 'screenshot.png' })
    expect(byId.get('art-3')).toMatchObject({ deviceId: 'd3', deviceLabel: 'Note 20', stableId: 's-d3', filename: 'report.log' })
    for (const item of body.items) expect(item.contentUrl).toBe(`/api/artifacts/${item.artifactId}/content`)

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('a batch with no collected files returns an empty list, not an error', async () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-batch-artifacts-empty-'))
    db.insert(batches).values({ id: 'b2', scriptId: 'internal:sleep', concurrency: 0, order: 'as-listed', status: 'success', createdAt: new Date() }).run()
    const app = makeArtifactApp(db, dataDir)

    const res = await app.request('/b2/artifacts')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('GET /:id/artifacts requires job.view — no authenticated user is refused', async () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-batch-artifacts-noauth-'))
    db.insert(batches).values({ id: 'b1', scriptId: 'internal:pull', concurrency: 0, order: 'as-listed', status: 'success', createdAt: new Date() }).run()
    const deps: BatchRoutesDeps = {
      db,
      jobStore: createJobStore(db),
      scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
      audit: createAuditLogger(db),
      broadcastBatchStatus: () => {},
      scriptNames: () => new Map(),
      registry: new ExecutorRegistry(),
      findScript: () => null,
      dataDir,
    }
    const app = withUser(null, createBatchRoutes(deps))
    const res = await app.request('/b1/artifacts')
    expect(res.status).toBe(403)
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('.../artifacts.zip: entries are "<label>-<stableId>/<filename>", and two devices sharing a label AND a filename land in different directories', async () => {
    const db = setUp()
    const { dataDir, files } = await seedBulkPull(db)
    const app = makeArtifactApp(db, dataDir)

    const res = await app.request('/b1/artifacts.zip')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('content-disposition')).toContain('.zip')

    const buf = new Uint8Array(await res.arrayBuffer())
    const asText = Buffer.from(buf)

    // Directory names: label first (slugged), FULL stableId appended — never shortened.
    expect(asText.includes(Buffer.from('pixel-6-s-d1/screenshot.png'))).toBe(true)
    expect(asText.includes(Buffer.from('pixel-6-s-d2/screenshot.png'))).toBe(true)
    expect(asText.includes(Buffer.from('note-20-s-d3/report.log'))).toBe(true)
    // The two same-named files are NOT the same bytes in the same slot — each is present with its OWN content, proving they occupy different entries.
    for (const f of files) expect(asText.includes(Buffer.from(f.content))).toBe(true)

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('over transfer.maxArchiveBytes refuses with 413 BEFORE any byte is written — no body, no partial archive', async () => {
    const db = setUp()
    const { dataDir } = await seedBulkPull(db)
    const app = makeArtifactApp(db, dataDir, { archiveSettings: () => ({ maxArchiveBytes: 10 }) }) // far under even one entry's own overhead

    const res = await app.request('/b1/artifacts.zip')
    expect(res.status).toBe(413)
    // The whole body parses cleanly as the coded JSON error — a truncated
    // zip (bytes cut mid-stream) could never do that; a `.zip` local-header
    // signature (`PK\x03\x04`) is never seen because nothing was ever
    // written before the refusal fired.
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_TRANSFER_TOO_LARGE')

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('.../artifacts.zip requires job.view — no authenticated user is refused before any archive work happens', async () => {
    const db = setUp()
    const { dataDir } = await seedBulkPull(db)
    const deps: BatchRoutesDeps = {
      db,
      jobStore: createJobStore(db),
      scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
      audit: createAuditLogger(db),
      broadcastBatchStatus: () => {},
      scriptNames: () => new Map(),
      registry: new ExecutorRegistry(),
      findScript: () => null,
      dataDir,
    }
    const app = withUser(null, createBatchRoutes(deps))
    const res = await app.request('/b1/artifacts.zip')
    expect(res.status).toBe(403)
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('a batch with no collected files still produces a valid (empty) archive rather than erroring', async () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-batch-artifacts-emptyzip-'))
    db.insert(batches).values({ id: 'b3', scriptId: 'internal:sleep', concurrency: 0, order: 'as-listed', status: 'success', createdAt: new Date() }).run()
    const app = makeArtifactApp(db, dataDir)

    const res = await app.request('/b3/artifacts.zip')
    expect(res.status).toBe(200)
    const buf = new Uint8Array(await res.arrayBuffer())
    // A structurally valid (if empty) zip always ends in the End Of Central Directory signature.
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const eocdSig = view.getUint32(buf.length - 22, true)
    expect(eocdSig).toBe(0x06054b50)
    rmSync(dataDir, { recursive: true, force: true })
  })
})
