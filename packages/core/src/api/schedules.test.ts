import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, scheduleRuns, schedules } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import { createScheduleRoutes, queryScheduleRunsRows, querySchedulesRows, type ScheduleRoutesDeps } from './schedules'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

let seq = 0
function seedSchedule(db: Db, n: number) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `sched-${String(++seq).padStart(4, '0')}`
    ids.push(id)
    db.insert(schedules)
      .values({
        id,
        name: `job-${i}`,
        cron: '0 0 * * *',
        timezone: 'UTC',
        scriptId: 'internal:sleep',
        clusterId: null,
        deviceIds: ['d1'],
        createdAt: new Date((base + i) * 1000),
      })
      .run()
  }
  return ids
}

let runSeq = 0
function seedRuns(db: Db, scheduleId: string, n: number) {
  const base = 1_700_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `run-${String(++runSeq).padStart(4, '0')}`
    ids.push(id)
    db.insert(scheduleRuns)
      .values({ id, scheduleId, dueAt: new Date((base + i) * 1000), outcome: 'dispatched', missedCount: 0 })
      .run()
  }
  return ids
}

describe('querySchedulesRows keyset pagination', () => {
  test('pages through 5 rows with limit=2: union is exactly the 5, no duplicates', () => {
    const db = setUp()
    const ids = seedSchedule(db, 5)

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const { rows, nextCursor, total } = querySchedulesRows(db, { cursor, limit: 2 })
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

  test('a malformed cursor is rejected', () => {
    const db = setUp()
    expect(() => querySchedulesRows(db, { cursor: 'not-valid-base64!!!', limit: 50 })).toThrow()
  })
})

describe('queryScheduleRunsRows keyset pagination', () => {
  test('pages through 5 runs with limit=2, scoped to one schedule, no duplicates', () => {
    const db = setUp()
    const [schedA] = seedSchedule(db, 1)
    const [schedB] = seedSchedule(db, 1)
    const idsA = seedRuns(db, schedA!, 5)
    seedRuns(db, schedB!, 3) // a different schedule's runs must never leak in

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const { rows, nextCursor, total } = queryScheduleRunsRows(db, schedA!, { cursor, limit: 2 })
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
    expect([...seen].sort()).toEqual([...idsA].sort())
  })

  test('a run inserted mid-paging is never skipped or repeated', () => {
    const db = setUp()
    const [schedA] = seedSchedule(db, 1)
    seedRuns(db, schedA!, 4)

    const page1 = queryScheduleRunsRows(db, schedA!, { cursor: null, limit: 2 })
    expect(page1.rows).toHaveLength(2)
    seedRuns(db, schedA!, 1)
    const page2 = queryScheduleRunsRows(db, schedA!, { cursor: page1.nextCursor, limit: 2 })
    const overlap = page2.rows.filter((r) => page1.rows.some((p) => p.id === r.id))
    expect(overlap).toHaveLength(0)
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
  const deps: ScheduleRoutesDeps = {
    db,
    jobStore: {} as ScheduleRoutesDeps['jobStore'],
    scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
    audit,
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as ScheduleRoutesDeps['log'],
    runner: { start: () => {}, stop: () => {}, reload: () => {}, nextFires: () => new Map() },
    registry,
    findScript: () => null,
    scriptNames: () => new Map(),
    onJobStatus: () => {},
    broadcastBatchStatus: () => {},
    broadcastFired: () => {},
  }
  return withUser(role, createScheduleRoutes(deps))
}

/**
 * `requirePermission('job.run')` on the mutating schedule routes (plan 34
 * §4.4, §4.5) — there is no `job.manage` permission; `job.run` is the
 * closest existing fit and, being an OPERATOR permission, must not lock an
 * operator out of a flow they already had.
 */
describe('requirePermission("job.run") on /api/schedules mutations (plan 34 §4.4, §4.5)', () => {
  const scheduleBody = {
    name: 'nightly',
    cron: '0 0 * * *',
    timezone: 'UTC',
    scriptId: 'internal:sleep',
    params: {},
    target: { deviceIds: ['d1'] },
  }

  test('POST / is refused with no authenticated user', async () => {
    const db = setUp()
    const app = makeApp(db, null)
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scheduleBody) })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an operator (job.run is an OPERATOR permission) may create a schedule — no lockout', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator')
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scheduleBody) })
    expect(res.status).toBe(201)
  })

  test('DELETE /:id is refused with no authenticated user', async () => {
    const db = setUp()
    const [id] = seedSchedule(db, 1)
    const app = makeApp(db, null)
    const res = await app.request(`/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  test('GET / needs no permission at all — read routes stay open', async () => {
    const db = setUp()
    const app = makeApp(db, null)
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })
})
