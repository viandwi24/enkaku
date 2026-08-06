import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs, scripts, type JobRow } from '../db/schema'
import { createJobStore } from '../queue/job-store'
import { createScriptJobsReader } from './script-jobs'

/**
 * `jobs/script-jobs.ts` — plan 80 §6, criteria 1–10. An in-memory DB seeded
 * with jobs across two devices and two script "namespaces" (script names),
 * exactly as plan 80 §7 specifies.
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened
}

function seedDevice(db: Db, id: string) {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'idle' }).run()
}

function seedScript(db: Db, id: string, name: string, version = '1.0.0') {
  db.insert(scripts).values({ id, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
}

/** Whole seconds only — `createdAt`/`startedAt`/`finishedAt` are `{ mode: 'timestamp' }` columns
 * (integer unix seconds), and two jobs a few hundred ms apart would otherwise collide. */
const sec = (n: number): Date => new Date(n * 1000)

let seq = 0
function seedJob(
  db: Db,
  input: {
    deviceId: string
    scriptId?: string
    status?: string
    createdAt?: Date
    startedAt?: Date | null
    finishedAt?: Date | null
    priority?: number
    batchSeq?: number | null
    result?: unknown
    error?: string | null
    failureClass?: string | null
    errorPhase?: string | null
  },
): JobRow {
  const id = `job-${++seq}`
  db.insert(jobs)
    .values({
      id,
      scriptId: input.scriptId ?? 'internal:sleep',
      deviceId: input.deviceId,
      params: null,
      priority: input.priority ?? 0,
      status: input.status ?? 'queued',
      createdAt: input.createdAt ?? sec(seq),
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      result: input.result ?? null,
      error: input.error ?? null,
      failureClass: input.failureClass ?? null,
      errorPhase: input.errorPhase ?? null,
      batchSeq: input.batchSeq ?? null,
    })
    .run()
  // Re-fetched rather than constructed by hand — the CALLER's own `JobRow`
  // must be byte-for-byte what a later query would compare against (the
  // timestamp columns round-trip through integer seconds).
  return db.select().from(jobs).where(eq(jobs.id, id)).get() as JobRow
}

describe('createScriptJobsReader — list() (plan 80 §6, criteria 1–5, 10)', () => {
  test('criterion 1: a script sees its own job in list()', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running', startedAt: sec(100) })
    const reader = createScriptJobsReader({ jobStore: store, db })

    const page = reader.list(caller, { limit: 10 })
    expect(page.items.map((j) => j.jobId)).toContain(caller.id)
  })

  test('criterion 2: another device\'s jobs never appear, whatever status filter is passed', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running', startedAt: sec(100) })
    const foreign = seedJob(db, { deviceId: 'd2', scriptId: 's1', status: 'queued' })
    const reader = createScriptJobsReader({ jobStore: store, db })

    const unfiltered = reader.list(caller, { limit: 100 })
    expect(unfiltered.items.some((j) => j.jobId === foreign.id)).toBe(false)

    // No status value widens the scope to another device either.
    const filtered = reader.list(caller, { limit: 100, status: 'queued' })
    expect(filtered.items.some((j) => j.jobId === foreign.id)).toBe(false)
  })

  test('criterion 3: two pages of 2 over 5 jobs return disjoint sets and a working cursor', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', createdAt: sec(100) })
    for (let i = 0; i < 4; i++) seedJob(db, { deviceId: 'd1', scriptId: 's1', createdAt: sec(200 + i) })
    const reader = createScriptJobsReader({ jobStore: store, db })

    const page1 = reader.list(caller, { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()

    const page2 = reader.list(caller, { limit: 2, cursor: page1.nextCursor })
    expect(page2.items).toHaveLength(2)

    const ids1 = new Set(page1.items.map((j) => j.jobId))
    const ids2 = new Set(page2.items.map((j) => j.jobId))
    for (const id of ids2) expect(ids1.has(id)).toBe(false)
    expect(page1.total).toBe(5)
  })

  test('criterion 4: limit 5000 is clamped to 100, not refused', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', createdAt: sec(1000) })
    for (let i = 0; i < 150; i++) seedJob(db, { deviceId: 'd1', scriptId: 's1', createdAt: sec(2000 + i) })
    const reader = createScriptJobsReader({ jobStore: store, db })

    const page = reader.list(caller, { limit: 5000 })
    expect(page.items.length).toBe(100)
  })

  test('criterion 5: a listed JobSummary carries no params/result key at all, on the wire', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', result: { secret: 'shh' } })
    const reader = createScriptJobsReader({ jobStore: store, db })

    const page = reader.list(caller, { limit: 10 })
    const wire = JSON.parse(JSON.stringify(page.items[0]))
    expect(Object.prototype.hasOwnProperty.call(wire, 'params')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(wire, 'result')).toBe(false)
  })

  test('criterion 10: a 100-row page issues exactly one scriptNames query, not one per row', () => {
    const opened = setUp()
    const { db, sqlite } = opened
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    for (let i = 0; i < 100; i++) seedScript(db, `s${i}`, `script-${i}`)
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's0', createdAt: sec(1) })
    for (let i = 1; i < 100; i++) seedJob(db, { deviceId: 'd1', scriptId: `s${i}`, createdAt: sec(1 + i) })
    const reader = createScriptJobsReader({ jobStore: store, db })

    let scriptQueries = 0
    const originalPrepare = sqlite.prepare.bind(sqlite) as (sql: string, params?: unknown) => unknown
    sqlite.prepare = ((sql: string, params?: unknown) => {
      if (sql.includes('"scripts"') || sql.includes('scripts')) scriptQueries++
      return originalPrepare(sql, params)
    }) as typeof sqlite.prepare

    const page = reader.list(caller, { limit: 100 })
    expect(page.items).toHaveLength(100)
    expect(scriptQueries).toBe(1)
  })
})

describe('createScriptJobsReader — previous() (plan 80 §6, criteria 6, 7)', () => {
  test('criterion 6: returns the job that finished most recently before this one started, even one created after it', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running', createdAt: sec(10), startedAt: sec(100) })
    // Created before the caller, but never finished — must not count.
    seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running', createdAt: sec(5) })
    // Created AFTER the caller, but finished before the caller started.
    const realPrevious = seedJob(db, {
      deviceId: 'd1',
      scriptId: 's1',
      status: 'success',
      createdAt: sec(50),
      startedAt: sec(60),
      finishedAt: sec(90),
    })
    // Finished, but after the caller started — must not count either.
    seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'success', createdAt: sec(1), startedAt: sec(2), finishedAt: sec(150) })
    const reader = createScriptJobsReader({ jobStore: store, db })

    const prev = reader.previous(caller)
    expect(prev?.jobId).toBe(realPrevious.id)
  })

  test('criterion 7: a device\'s first-ever job returns null', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running', startedAt: sec(100) })
    const reader = createScriptJobsReader({ jobStore: store, db })

    expect(reader.previous(caller)).toBeNull()
  })

  test('previous() never crosses devices', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running', createdAt: sec(10), startedAt: sec(100) })
    seedJob(db, { deviceId: 'd2', scriptId: 's1', status: 'success', createdAt: sec(50), startedAt: sec(60), finishedAt: sec(90) })
    const reader = createScriptJobsReader({ jobStore: store, db })

    expect(reader.previous(caller)).toBeNull()
  })
})

describe('createScriptJobsReader — queuedAfter() (plan 80 §6, criterion 8)', () => {
  test('criterion 8: queued jobs come back in claim order (priority DESC, createdAt ASC, batchSeq ASC) and exclude the caller', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running', startedAt: sec(1) })
    const low = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'queued', priority: 0, createdAt: sec(20) })
    const high = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'queued', priority: 5, createdAt: sec(30) })
    const older = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'queued', priority: 0, createdAt: sec(10) })
    const reader = createScriptJobsReader({ jobStore: store, db })

    const result = reader.queuedAfter(caller, 10)
    expect(result.map((j) => j.jobId)).toEqual([high.id, older.id, low.id])
    expect(result.some((j) => j.jobId === caller.id)).toBe(false)
  })

  test('queuedAfter() never crosses devices', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running', startedAt: sec(1) })
    seedJob(db, { deviceId: 'd2', scriptId: 's1', status: 'queued' })
    const reader = createScriptJobsReader({ jobStore: store, db })

    expect(reader.queuedAfter(caller, 10)).toEqual([])
  })
})

describe('createScriptJobsReader — resultOf() (plan 80 §6, criterion 9)', () => {
  test('same-namespace (same script name), finished — returns the result', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1v1', 'checkout', '1.0.0')
    seedScript(db, 's1v2', 'checkout', '2.0.0')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1v2', status: 'running' })
    const target = seedJob(db, {
      deviceId: 'd1',
      scriptId: 's1v1',
      status: 'success',
      finishedAt: sec(10),
      result: { exitIp: '1.2.3.4' },
    })
    const reader = createScriptJobsReader({ jobStore: store, db })

    const outcome = reader.resultOf(caller, target.id)
    expect(outcome).toEqual({ ok: true, result: { exitIp: '1.2.3.4' } })
  })

  test('foreign namespace (a different script name) is refused', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    seedScript(db, 's2', 'login')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const target = seedJob(db, { deviceId: 'd1', scriptId: 's2', status: 'success', finishedAt: sec(10), result: { token: 'x' } })
    const reader = createScriptJobsReader({ jobStore: store, db })

    expect(reader.resultOf(caller, target.id)).toEqual({ ok: false, reason: 'foreign-namespace' })
  })

  test('an unknown job id is refused as not-found', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const reader = createScriptJobsReader({ jobStore: store, db })

    expect(reader.resultOf(caller, 'no-such-job')).toEqual({ ok: false, reason: 'not-found' })
  })

  test('a same-namespace job that has not finished yet is refused as not-finished', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const target = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const reader = createScriptJobsReader({ jobStore: store, db })

    expect(reader.resultOf(caller, target.id)).toEqual({ ok: false, reason: 'not-finished' })
  })

  test('resultOf is not device-scoped — a same-namespace job on another device still resolves', () => {
    const { db } = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const target = seedJob(db, { deviceId: 'd2', scriptId: 's1', status: 'success', finishedAt: sec(10), result: 42 })
    const reader = createScriptJobsReader({ jobStore: store, db })

    expect(reader.resultOf(caller, target.id)).toEqual({ ok: true, result: 42 })
  })
})
