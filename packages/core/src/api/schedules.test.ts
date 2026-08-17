import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, scheduleAgentTargets, scheduleRuns, schedules, scripts } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import { createScriptExecutor } from '../jobs/executors/script'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry } from '../scripts/registry'
import type { ScheduleAgentDispatch } from '../schedules/runner'
import { createScheduleRoutes, queryScheduleRunsRows, querySchedulesRows, type ScheduleRoutesDeps } from './schedules'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  // Every schedule below references `test-script@1.0.0` by default (plan 62
  // §4.4) — the route resolves the reference against the real `scripts`
  // table before writing or reading a schedule row.
  opened.db
    .insert(scripts)
    .values({ pluginId: 'p-fixture', exportId: 'main', id: 'test-script-1.0.0', name: 'test-script', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date() })
    .run()
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
        scriptRef: 'test-script@1.0.0',
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

function makeApp(db: Db, role: 'admin' | 'operator' | null, overrides: Partial<ScheduleRoutesDeps> = {}) {
  const audit = createAuditLogger(db)
  const registry = new ExecutorRegistry()
  // Not `internal:sleep` — routes resolve `scriptRef` against real
  // `scripts.id`s now, so the fallback executor covers every real script
  // (plan 62 §4.4), the same as the daemon's actual wiring.
  registry.setFallback({ validateParams: (p) => p, run: async () => undefined })
  const deps: ScheduleRoutesDeps = {
    db,
    jobStore: {} as ScheduleRoutesDeps['jobStore'],
    scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
    audit,
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as ScheduleRoutesDeps['log'],
    runner: { start: () => {}, stop: () => {}, reload: () => {}, nextFires: () => new Map() },
    registry,
    findScript: () => ({ enabled: true }),
    scriptNames: () => new Map(),
    onJobStatus: () => {},
    broadcastBatchStatus: () => {},
    broadcastFired: () => {},
    ...overrides,
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
    scriptRef: 'test-script@1.0.0',
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

describe('scriptRef on POST/PATCH /api/schedules (plan 62 §4.4)', () => {
  test('stores the reference verbatim; the response echoes what it resolves to right now (acceptance #6)', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    db.insert(scripts).values({ pluginId: 'p-fixture', exportId: 'main', id: 'test-script-2.0.0', name: 'test-script', version: '2.0.0', bundle: 'x', enabled: true, createdAt: new Date() }).run()
    const app = makeApp(db, 'operator')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nightly', cron: '0 0 * * *', timezone: 'UTC', scriptRef: 'test-script@latest', params: {}, target: { deviceIds: ['d1'] } }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { schedule: { scriptRef: string }; resolvesTo: { scriptId: string; name: string; version: string } | null }
    expect(body.schedule.scriptRef).toBe('test-script@latest') // verbatim, never resolved-and-stored
    expect(body.resolvesTo).toEqual({ scriptId: 'test-script-2.0.0', name: 'test-script', version: '2.0.0' })
  })

  test('a reference that cannot resolve is refused at creation, before any row is written', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nightly', cron: '0 0 * * *', timezone: 'UTC', scriptRef: 'no-such-script@1.0.0', params: {}, target: { deviceIds: ['d1'] } }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('script_not_found')

    const list = await (await app.request('/')).json() as { total: number }
    expect(list.total).toBe(0)
  })

  test('PATCH can re-pin an existing schedule to a different reference', async () => {
    const db = setUp()
    db.insert(scripts).values({ pluginId: 'p-fixture', exportId: 'main', id: 'test-script-2.0.0', name: 'test-script', version: '2.0.0', bundle: 'x', enabled: true, createdAt: new Date() }).run()
    const [id] = seedSchedule(db, 1) // starts on test-script@1.0.0
    const app = makeApp(db, 'operator')

    const res = await app.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptRef: 'test-script@2.0.0' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schedule: { scriptRef: string }; resolvesTo: { version: string } | null }
    expect(body.schedule.scriptRef).toBe('test-script@2.0.0')
    expect(body.resolvesTo?.version).toBe('2.0.0')
  })

  test('the schedules list shows the raw reference verbatim', async () => {
    const db = setUp()
    seedSchedule(db, 1)
    const app = makeApp(db, null)
    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ scriptRef: string }> }
    expect(body.items[0]?.scriptRef).toBe('test-script@1.0.0')
  })
})

describe('pacing on POST/PATCH /api/schedules (plan 94 §3.7, §4.8, step 94.9, F34)', () => {
  test('POST round-trips repeatCount/intervalMinMs/intervalMaxMs/deviceIntervalMs; defaults are unpaced', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator')

    const paced = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'paced',
        cron: '0 0 * * *',
        timezone: 'UTC',
        scriptRef: 'test-script@1.0.0',
        params: {},
        target: { deviceIds: ['d1'] },
        repeatCount: 5,
        intervalMinMs: 1000,
        intervalMaxMs: 2000,
        deviceIntervalMs: 500,
      }),
    })
    expect(paced.status).toBe(201)
    const pacedBody = (await paced.json()) as {
      schedule: { repeatCount: number; intervalMinMs: number; intervalMaxMs: number; deviceIntervalMs: number }
    }
    expect(pacedBody.schedule.repeatCount).toBe(5)
    expect(pacedBody.schedule.intervalMinMs).toBe(1000)
    expect(pacedBody.schedule.intervalMaxMs).toBe(2000)
    expect(pacedBody.schedule.deviceIntervalMs).toBe(500)

    const unpaced = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'unpaced', cron: '0 0 * * *', timezone: 'UTC', scriptRef: 'test-script@1.0.0', params: {}, target: { deviceIds: ['d1'] } }),
    })
    const unpacedBody = (await unpaced.json()) as {
      schedule: { repeatCount: number; intervalMinMs: number; intervalMaxMs: number; deviceIntervalMs: number }
    }
    expect(unpacedBody.schedule.repeatCount).toBe(1)
    expect(unpacedBody.schedule.intervalMinMs).toBe(0)
    expect(unpacedBody.schedule.intervalMaxMs).toBe(0)
    expect(unpacedBody.schedule.deviceIntervalMs).toBe(0)
  })

  test('an inverted interval range is refused on POST', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'inverted',
        cron: '0 0 * * *',
        timezone: 'UTC',
        scriptRef: 'test-script@1.0.0',
        params: {},
        target: { deviceIds: ['d1'] },
        intervalMinMs: 2000,
        intervalMaxMs: 1000,
      }),
    })
    expect(res.status).toBe(400)
  })

  test('PATCH updates pacing independently of the other fields', async () => {
    const db = setUp()
    const [id] = seedSchedule(db, 1)
    const app = makeApp(db, 'operator')

    const res = await app.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repeatCount: 3, intervalMinMs: 100, intervalMaxMs: 300, deviceIntervalMs: 50 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      schedule: { repeatCount: number; intervalMinMs: number; intervalMaxMs: number; deviceIntervalMs: number }
    }
    expect(body.schedule.repeatCount).toBe(3)
    expect(body.schedule.intervalMinMs).toBe(100)
    expect(body.schedule.intervalMaxMs).toBe(300)
    expect(body.schedule.deviceIntervalMs).toBe(50)
  })

  test('PATCH refuses an inverted interval range against the merged (existing + patched) values', async () => {
    const db = setUp()
    const [id] = seedSchedule(db, 1)
    db.update(schedules).set({ intervalMinMs: 0, intervalMaxMs: 5000 }).where(eq(schedules.id, id!)).run()
    const app = makeApp(db, 'operator')

    // Patching only the min above the EXISTING max must still be caught.
    const res = await app.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervalMinMs: 9000 }),
    })
    expect(res.status).toBe(400)
  })
})

/**
 * Plan 95 §4.4, §4.8, §5 step 95.7 — `paramsCompatible`/`paramsFindingCount`,
 * computed fresh on every GET against what `scriptRef` resolves to RIGHT
 * NOW. Written so it would FAIL if the badge only turned on after a firing
 * actually happened: this test never calls `fireOnce` or `run-now` at
 * all — it only ever GETs — so a badge that flips true→false BEFORE the
 * first missed run is the whole point being asserted.
 */
describe('paramsCompatible / paramsFindingCount on GET /api/schedules (plan 95 §4.4, §4.8)', () => {
  test('a schedule visible and compatible, then incompatible the moment a new version publishes — with no firing in between', async () => {
    const db = setUp()
    db.update(scripts)
      .set({ paramsSchema: { type: 'object', properties: { videos: { type: 'number' } } } })
      .where(eq(scripts.id, 'test-script-1.0.0'))
      .run()
    const [id] = seedSchedule(db, 1) // scriptRef: test-script@1.0.0
    db.update(schedules).set({ scriptRef: 'test-script@latest', params: { videos: 30 } }).where(eq(schedules.id, id!)).run()
    const app = makeApp(db, null)

    const before = (await (await app.request('/')).json()) as { items: Array<{ id: string; paramsCompatible: boolean; paramsFindingCount: number }> }
    const rowBefore = before.items.find((i) => i.id === id)
    expect(rowBefore).toEqual(expect.objectContaining({ paramsCompatible: true, paramsFindingCount: 0 }))

    // 1.1.0 adds a REQUIRED `region` with no default — the schedule was never touched.
    db.insert(scripts)
      .values({
        pluginId: 'p-fixture',
        exportId: 'main',
        id: 'test-script-1.1.0',
        name: 'test-script',
        version: '1.1.0',
        bundle: 'export {}',
        enabled: true,
        createdAt: new Date(),
        paramsSchema: { type: 'object', properties: { videos: { type: 'number' }, region: { type: 'string' } }, required: ['videos', 'region'] },
      })
      .run()

    // No firing happened — this GET is the ONLY thing that ran since the publish above.
    const after = (await (await app.request('/')).json()) as { items: Array<{ id: string; paramsCompatible: boolean; paramsFindingCount: number }> }
    const rowAfter = after.items.find((i) => i.id === id)
    expect(rowAfter).toEqual(expect.objectContaining({ paramsCompatible: false, paramsFindingCount: 1 }))

    // GET /:id agrees with the list.
    const detail = (await (await app.request(`/${id}`)).json()) as { schedule: { paramsCompatible: boolean; paramsFindingCount: number } }
    expect(detail.schedule).toEqual(expect.objectContaining({ paramsCompatible: false, paramsFindingCount: 1 }))
  })

  test('an agent-target schedule is always compatible — there is nothing to reconcile', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator', { agentExists: () => true })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'agent check',
        cron: '0 2 * * *',
        timezone: 'UTC',
        workTarget: { kind: 'agent', agentId: 'agent-1', prompt: 'check things' },
        target: { deviceIds: ['d1'] },
      }),
    })
    const body = (await res.json()) as { schedule: { paramsCompatible: boolean; paramsFindingCount: number } }
    expect(body.schedule).toEqual(expect.objectContaining({ paramsCompatible: true, paramsFindingCount: 0 }))
  })

  test('a reference that cannot resolve is reported compatible (nothing to say about PARAMS specifically — a separate failure mode)', async () => {
    const db = setUp()
    const [id] = seedSchedule(db, 1)
    db.update(schedules).set({ scriptRef: 'test-script@9.9.9' }).where(eq(schedules.id, id!)).run()
    const app = makeApp(db, null)
    const res = await (await app.request('/')).json() as { items: Array<{ id: string; paramsCompatible: boolean }> }
    expect(res.items.find((i) => i.id === id)?.paramsCompatible).toBe(true)
  })
})

/**
 * The agent target (plan 68 §3.1, §4.1, §4.2) — `workTarget` as a
 * discriminated pair alongside the legacy `scriptRef` shape. Every test
 * above never sends `workTarget`, which is exactly what keeps them, and the
 * `scheduleAgentTargets` companion table, out of each other's way
 * (acceptance #2: the tests above stay byte-for-byte unedited).
 */
function fakeAgentDispatch(overrides: Partial<ScheduleAgentDispatch> = {}): ScheduleAgentDispatch {
  return {
    agentExists: overrides.agentExists ?? (() => true),
    runStatus: overrides.runStatus ?? (() => null),
    cancelRun: overrides.cancelRun ?? (() => {}),
    countActiveScheduledRuns: overrides.countActiveScheduledRuns ?? (() => 0),
    spentOutputTokensSince: overrides.spentOutputTokensSince ?? (() => 0),
    dispatch: overrides.dispatch ?? (() => ({ runId: 'run-1', threadId: 'thread-1' })),
  }
}

describe('workTarget: agent on POST/PATCH /api/schedules (plan 68 §3.1, §4.1, §4.2)', () => {
  test('POST with an agent target creates a schedule whose GET reflects target.kind "agent"', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator', { agentExists: () => true })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'nightly agent check',
        cron: '0 2 * * *',
        timezone: 'UTC',
        workTarget: { kind: 'agent', agentId: 'agent-1', prompt: 'check the checkout flow' },
        target: { deviceIds: ['d1'] },
        threadMode: 'continue',
        onApprovalRequired: 'pause',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { schedule: { target: { kind: string; agentId?: string; prompt?: string }; scriptRef: string | null; threadMode: string; onApprovalRequired: string } }
    expect(body.schedule.target).toEqual({ kind: 'agent', agentId: 'agent-1', prompt: 'check the checkout flow' })
    expect(body.schedule.scriptRef).toBeNull() // legacy field is null for an agent target
    expect(body.schedule.threadMode).toBe('continue')
    expect(body.schedule.onApprovalRequired).toBe('pause')

    const agentRow = db.select().from(scheduleAgentTargets).all()[0]
    expect(agentRow?.agentId).toBe('agent-1')
  })

  test('POST with an unknown agentId is refused with agent_not_found — never silently saved', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = makeApp(db, 'operator', { agentExists: () => false })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'bad agent',
        cron: '0 2 * * *',
        timezone: 'UTC',
        workTarget: { kind: 'agent', agentId: 'no-such-agent', prompt: 'x' },
        target: { deviceIds: ['d1'] },
      }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('agent_not_found')
    expect(db.select().from(scheduleAgentTargets).all()).toHaveLength(0)
    expect(db.select().from(schedules).all()).toHaveLength(0)
  })

  test('PATCH can switch an existing SCRIPT schedule to an agent target', async () => {
    const db = setUp()
    const [id] = seedSchedule(db, 1)
    const app = makeApp(db, 'operator', { agentExists: () => true })

    const res = await app.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workTarget: { kind: 'agent', agentId: 'agent-2', prompt: 'watch for regressions' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schedule: { target: { kind: string } } }
    expect(body.schedule.target.kind).toBe('agent')
    expect(db.select().from(scheduleAgentTargets).all()).toHaveLength(1)
  })

  test('PATCH can switch an existing AGENT schedule back to a script target, removing the companion row', async () => {
    const db = setUp()
    db.insert(scripts).values({ pluginId: 'p-fixture', exportId: 'main', id: 'test-script-2.0.0', name: 'test-script', version: '2.0.0', bundle: 'x', enabled: true, createdAt: new Date() }).run()
    const app = makeApp(db, 'operator', { agentExists: () => true })
    const createdRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'switch-me',
        cron: '0 2 * * *',
        timezone: 'UTC',
        workTarget: { kind: 'agent', agentId: 'agent-1', prompt: 'x' },
        target: { deviceIds: ['d1'] },
      }),
    })
    const created = (await createdRes.json()) as { schedule: { id: string } }

    const res = await app.request(`/${created.schedule.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workTarget: { kind: 'script', ref: 'test-script@2.0.0' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schedule: { target: { kind: string }; scriptRef: string | null } }
    expect(body.schedule.target.kind).toBe('script')
    expect(body.schedule.scriptRef).toBe('test-script@2.0.0')
    expect(db.select().from(scheduleAgentTargets).all()).toHaveLength(0)
  })

  test('run-now on an agent-kind schedule dispatches through agentDispatch and returns a run, never a batch', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    let dispatchCalls = 0
    const app = makeApp(db, 'operator', {
      agentExists: () => true,
      agentDispatch: fakeAgentDispatch({
        dispatch: () => {
          dispatchCalls++
          return { runId: 'run-99', threadId: 'thread-99' }
        },
      }),
    })

    const createdRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'run-now agent',
        cron: '0 2 * * *',
        timezone: 'UTC',
        workTarget: { kind: 'agent', agentId: 'agent-1', prompt: 'check now' },
        target: { deviceIds: ['d1'] },
      }),
    })
    const created = (await createdRes.json()) as { schedule: { id: string } }

    const res = await app.request(`/${created.schedule.id}/run-now`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { run?: { runId: string; threadId: string | null }; batch?: unknown }
    // `threadId` on the SCHEDULE ROW only tracks a 'continue'-mode thread (§3.2); this schedule
    // defaulted to 'new', so each firing gets its own thread and there is no single "the" thread to
    // persist — `run.runId` is still exactly what `agentDispatch.dispatch` returned.
    expect(body.run?.runId).toBe('run-99')
    expect(body.run?.threadId).toBeNull()
    expect(body.batch).toBeUndefined()
    expect(dispatchCalls).toBe(1)
  })
})

/**
 * Plan 95 §5 step 95.6's checklist item "the same validation on create and
 * patch": `POST /` and `PATCH /:id` already routed through
 * `validateScriptForRun` before this plan (`schedules.ts:290,370,458,491`)
 * — what was missing was the fallback executor actually validating anything
 * (F10). These tests exercise the real HTTP routes, with the REAL
 * `createScriptExecutor` wired as the fallback (exactly as `daemon.ts`
 * wires it), so the wiring claim is exercised end to end rather than only
 * at the function-call level.
 */
describe('schedule routes validate params against the real paramsSchema (plan 95 §5 step 95.6)', () => {
  function setUpWithParamsSchema(): Db {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    opened.db
      .insert(scripts)
      .values({
        pluginId: 'p-fixture',
        exportId: 'main',
        id: 'checkout-1.0.0',
        name: 'checkout',
        version: '1.0.0',
        bundle: 'export {}',
        enabled: true,
        paramsSchema: { type: 'object', properties: { videos: { type: 'integer', maximum: 2000 } }, required: ['videos'] },
        createdAt: new Date(),
      })
      .run()
    return opened.db
  }

  function appWithRealValidation(db: Db, role: 'admin' | 'operator' | null) {
    const scriptRegistry = createScriptRegistry({ db, dataDir: `/tmp/enkaku-schedules-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
    const registry = new ExecutorRegistry()
    registry.setFallback(createScriptExecutor({ registry: scriptRegistry, runner: {} as never }))
    return makeApp(db, role, { registry })
  }

  test('POST / rejects an out-of-range params value with 400 invalid_job_params and field-level issues, and creates no schedule row', async () => {
    const db = setUpWithParamsSchema()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = appWithRealValidation(db, 'operator')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'nightly',
        cron: '0 2 * * *',
        timezone: 'UTC',
        scriptRef: 'checkout@1.0.0',
        params: { videos: 9999 },
        target: { deviceIds: ['d1'] },
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; issues?: { path: string; message: string }[] } }
    expect(body.error.code).toBe('invalid_job_params')
    expect(body.error.issues).toEqual([{ path: 'videos', message: 'must be at most 2000' }])
    expect(db.select().from(schedules).all().length).toBe(0)
  })

  test('PATCH /:id rejects an out-of-range params value the same way, and leaves the stored params untouched', async () => {
    const db = setUpWithParamsSchema()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = appWithRealValidation(db, 'operator')

    const createdRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'nightly',
        cron: '0 2 * * *',
        timezone: 'UTC',
        scriptRef: 'checkout@1.0.0',
        params: { videos: 30 },
        target: { deviceIds: ['d1'] },
      }),
    })
    expect(createdRes.status).toBe(201)
    const created = (await createdRes.json()) as { schedule: { id: string } }

    const patchRes = await app.request(`/${created.schedule.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: { videos: 9999 } }),
    })
    expect(patchRes.status).toBe(400)
    const body = (await patchRes.json()) as { error: { code: string; issues?: { path: string; message: string }[] } }
    expect(body.error.code).toBe('invalid_job_params')
    expect(body.error.issues).toEqual([{ path: 'videos', message: 'must be at most 2000' }])

    const row = db.select().from(schedules).all().find((r) => r.id === created.schedule.id)
    expect(row?.params).toEqual({ videos: 30 })
  })
})

/**
 * `JobExecutor.requires` at schedule create/edit time (plan 93 §3.12, §4.6,
 * step 93.8) — the interactive counterpart of the batch/job gate: a schedule
 * resolves through `scripts` rows, never a raw `internal:*` id, so the fake
 * executor here is registered under the RESOLVED concrete script id
 * (`registry.register('install-1.0.0', ...)`) rather than a built-in name —
 * `ExecutorRegistry.get` finds it before falling back to the generic script
 * executor, exactly as `daemon.ts`'s real wiring would for a plugin script
 * declaring `requires`.
 */
describe('POST/PATCH /api/schedules — JobExecutor.requires (plan 93 §3.12, §4.6, step 93.8)', () => {
  function setUpWithInstallScript(): Db {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    opened.db
      .insert(scripts)
      .values({ pluginId: 'p-fixture', exportId: 'main', id: 'install-1.0.0', name: 'install', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date() })
      .run()
    return opened.db
  }

  function appWithInstallGate(db: Db, role: 'admin' | 'operator' | null, opts: { shellMode: 'off' | 'operator' | 'admin'; transferEnabled: boolean }) {
    const registry = new ExecutorRegistry()
    registry.register('install-1.0.0', {
      validateParams: (p) => p,
      run: async () => undefined,
      requires: { gate: 'files', setting: 'transfer.enabled' },
    })
    return makeApp(db, role, { registry, shellMode: () => opts.shellMode, transferEnabled: () => opts.transferEnabled })
  }

  const body = { name: 'nightly', cron: '0 0 * * *', timezone: 'UTC', scriptRef: 'install@1.0.0', params: {}, target: { deviceIds: ['d1'] } }

  test('an operator without device.files, shell.mode: admin, is refused at create time — no schedule row', async () => {
    const db = setUpWithInstallScript()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = appWithInstallGate(db, 'operator', { shellMode: 'admin', transferEnabled: true })

    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(res.status).toBe(403)
    expect(db.select().from(schedules).all()).toHaveLength(0)
  })

  test('transfer.enabled: false refuses even an admin at create time', async () => {
    const db = setUpWithInstallScript()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = appWithInstallGate(db, 'admin', { shellMode: 'admin', transferEnabled: false })

    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(res.status).toBe(403)
  })

  test('an admin with the gate satisfied creates the schedule; PATCH re-checks the gate too', async () => {
    const db = setUpWithInstallScript()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()
    const app = appWithInstallGate(db, 'admin', { shellMode: 'admin', transferEnabled: true })

    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { schedule: { id: string } }

    const patchRes = await app.request(`/${created.schedule.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    })
    expect(patchRes.status).toBe(200)
  })
})
