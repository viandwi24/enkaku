import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { JobSettings } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs, type JobRow } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import type { Logger } from '../util/logger'
import { createJobService } from '../services/job-service'
import { createBatchRoutes, type BatchRoutesDeps } from './batches'
import { createJobRoutes } from './jobs'

/**
 * Plan 98 §3.8, step 98.7 — the gap this test file closes
 * (docs/plans/96-m61-hotfixes.md, continuing that document's numbering):
 * `EnqueueBody` (`api/jobs.ts`) and the create-batch body (`api/batches.ts`)
 * did not accept a `runtimeOverride` field at all, so it was silently
 * STRIPPED by each route's own `z.object` parse (no `.strict()`) before
 * `JobService.enqueue()`/`createBatch()` ever saw it — both of which already
 * accepted and correctly enforced it (step 98.7's own unit tests in
 * `services/job-service.test.ts` proved the SERVICE layer honours an
 * override it is handed; that is exactly what let the wire-level gap slip
 * past those tests). Every test below goes through the REAL HTTP route —
 * `app.request(...)`, a real in-memory DB, a real `JobService`/`createBatch`
 * — never a fake service that would hide a body field the route itself
 * drops.
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id = 'd1') {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'idle' }).run()
}

function silentLog(): Logger {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function fakeScheduler(): Scheduler {
  return { kick: () => {}, start: () => {}, stop: () => {} }
}

function builtinRegistry(): ExecutorRegistry {
  const registry = new ExecutorRegistry()
  registry.register('internal:sleep', { validateParams: (p) => p, run: async () => undefined })
  return registry
}

/** A farm with a real, concrete ceiling on both fields `resolveRuntime` can refuse an override against — the identical fixture `services/job-service.test.ts`'s own `CEILING_FARM` uses. */
const CEILING_FARM: JobSettings = {
  resetPolicy: 'home',
  resetTimeoutMs: 60_000,
  resetStrict: false,
  retry: { maxInfraAttempts: 3, backoffBaseMs: 500, backoffMaxMs: 5_000, timeoutIsInfra: true, rebindOnInfra: true },
  crashPolicy: 'declared',
  defaultTimeoutMs: 3_600_000,
  startupTimeoutMs: 5_000,
  maxTimeoutMs: 4_000_000, // the ceiling these tests exercise
  memory: { defaultMaxRssBytes: null, maxRssBytes: 512 * 1024 * 1024, enforce: 'kill' as const, sampleIntervalMs: 2_000 },
  trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
  maxResultBytes: 65_536,
  progressIntervalMs: 1_000,
}

function jobsApp(db: Db, farmJobSettings?: () => JobSettings) {
  const jobStore = createJobStore(db)
  const service = createJobService({
    jobStore,
    registry: builtinRegistry(),
    scheduler: fakeScheduler(),
    host: {} as ExecutorHost,
    log: silentLog(),
    onJobStatus: () => {},
    farmJobSettings,
  })
  return createJobRoutes(service)
}

describe('POST /api/jobs — runtimeOverride reaches JobService.enqueue() (plan 98 §3.8, step 98.7 gap)', () => {
  test('an override inside the farm ceiling enqueues normally and is pinned onto the job row', async () => {
    const db = setUp()
    seedDevice(db)
    const app = jobsApp(db, () => CEILING_FARM)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scriptId: 'internal:sleep',
        deviceId: 'd1',
        params: {},
        runtimeOverride: { timeoutMs: 1_000_000, maxRssBytes: 256 * 1024 * 1024 },
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: { jobId: string } }
    const row = db.select().from(jobs).where(eq(jobs.id, body.job.jobId)).get() as JobRow
    expect(row.runtimeOverride).toEqual({ timeoutMs: 1_000_000, maxRssBytes: 256 * 1024 * 1024 })
  })

  test('an override over the farm ceiling is refused with E_RUNTIME_OVER_CEILING as a real HTTP 400, and no job row is written', async () => {
    const db = setUp()
    seedDevice(db)
    const app = jobsApp(db, () => CEILING_FARM)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scriptId: 'internal:sleep',
        deviceId: 'd1',
        params: {},
        runtimeOverride: { timeoutMs: 6_000_000 }, // above CEILING_FARM.maxTimeoutMs (4_000_000)
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_RUNTIME_OVER_CEILING')
    expect(body.error.message).toContain('6000000')
    expect(body.error.message).toContain('4000000')
    expect(db.select().from(jobs).all()).toHaveLength(0)
  })

  test('a malformed override refuses with E_RUNTIME_ENVELOPE_INVALID (400), never a silent drop or a 500', async () => {
    const db = setUp()
    seedDevice(db)
    const app = jobsApp(db)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scriptId: 'internal:sleep',
        deviceId: 'd1',
        params: {},
        runtimeOverride: { timeoutMs: 'not-a-number' },
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_RUNTIME_ENVELOPE_INVALID')
    expect(db.select().from(jobs).all()).toHaveLength(0)
  })

  test('no runtimeOverride at all enqueues exactly as before this field existed — pinned null', async () => {
    const db = setUp()
    seedDevice(db)
    const app = jobsApp(db, () => CEILING_FARM)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptId: 'internal:sleep', deviceId: 'd1', params: {} }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: { jobId: string } }
    const row = db.select().from(jobs).where(eq(jobs.id, body.job.jobId)).get() as JobRow
    expect(row.runtimeOverride).toBeNull()
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

function batchesApp(db: Db, farmJobSettings?: () => JobSettings) {
  const jobStore = createJobStore(db)
  const audit = createAuditLogger(db)
  const deps: BatchRoutesDeps = {
    db,
    jobStore,
    scheduler: fakeScheduler(),
    audit,
    broadcastBatchStatus: () => {},
    scriptNames: (ids) => jobStore.scriptNames(ids),
    registry: builtinRegistry(),
    findScript: () => null,
    farmJobSettings,
  }
  return withUser('operator', createBatchRoutes(deps))
}

describe('POST /api/batches — runtimeOverride reaches createBatch() (plan 98 §3.8, step 98.7 gap)', () => {
  test('an override inside the farm ceiling dispatches normally and is pinned onto every member job row', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const app = batchesApp(db, () => CEILING_FARM)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scriptId: 'internal:sleep',
        params: {},
        target: { deviceIds: ['d1', 'd2'] },
        concurrency: 0,
        order: 'as-listed',
        runtimeOverride: { timeoutMs: 1_000_000 },
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { batch: { id: string } }
    const rows = db.select().from(jobs).where(eq(jobs.batchId, body.batch.id)).all()
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.runtimeOverride).toEqual({ timeoutMs: 1_000_000 })
  })

  test('an override over the farm ceiling is refused with E_RUNTIME_OVER_CEILING as a real HTTP 400, and no batch or job row is written', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const app = batchesApp(db, () => CEILING_FARM)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scriptId: 'internal:sleep',
        params: {},
        target: { deviceIds: ['d1'] },
        concurrency: 0,
        order: 'as-listed',
        runtimeOverride: { maxRssBytes: 1024 * 1024 * 1024 }, // above CEILING_FARM.memory.maxRssBytes
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_RUNTIME_OVER_CEILING')
    expect(db.select().from(jobs).all()).toHaveLength(0)
  })

  test('no runtimeOverride at all dispatches exactly as before this field existed — pinned null on every member', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const app = batchesApp(db, () => CEILING_FARM)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1'] }, concurrency: 0, order: 'as-listed' }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { batch: { id: string } }
    const rows = db.select().from(jobs).where(eq(jobs.batchId, body.batch.id)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.runtimeOverride).toBeNull()
  })
})
