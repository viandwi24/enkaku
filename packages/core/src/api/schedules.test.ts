import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, scheduleAgentTargets, scheduleRuns, schedules, scripts } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
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
    .values({ id: 'test-script-1.0.0', name: 'test-script', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date() })
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
    db.insert(scripts).values({ id: 'test-script-2.0.0', name: 'test-script', version: '2.0.0', bundle: 'x', enabled: true, createdAt: new Date() }).run()
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
    db.insert(scripts).values({ id: 'test-script-2.0.0', name: 'test-script', version: '2.0.0', bundle: 'x', enabled: true, createdAt: new Date() }).run()
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
    db.insert(scripts).values({ id: 'test-script-2.0.0', name: 'test-script', version: '2.0.0', bundle: 'x', enabled: true, createdAt: new Date() }).run()
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
