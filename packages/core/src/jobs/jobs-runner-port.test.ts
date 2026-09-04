import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs, scripts, type JobRow } from '../db/schema'
import type { Logger } from '../util/logger'
import type { ScriptRegistry } from '../scripts/registry'
import { createJobStore } from '../queue/job-store'
import { createJobsRunnerPort, type JobsRunnerPortDeps } from './jobs-runner-port'

const DEFAULT_BUDGETS = { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 }

/** A minimal `ScriptRegistry` stand-in — `list`/`get`/`bundlePath`/`invalidate` throw
 * (unused by these tests); `resolve` answers from a fixed table of `name@version` → entry. */
function fakeRegistry(entries: Record<string, { id: string; name: string; version: string }> = {}): ScriptRegistry {
  return {
    list: () => {
      throw new Error('not used')
    },
    get: () => {
      throw new Error('not used')
    },
    resolve: (ref) => {
      const entry = entries[ref]
      if (!entry) throw new Error(`fakeRegistry: no entry for "${ref}"`)
      return { ...entry, origin: 'plugin', pluginName: entry.name.includes('/') ? (entry.name.split('/')[0] ?? null) : null, exportId: null, enabled: true, paramsSchema: null, runtime: null, bundle: { kind: 'db', scriptId: entry.id }, ephemeral: false }
    },
    bundlePath: () => {
      throw new Error('not used')
    },
    invalidate: () => {},
  }
}

function makePort(overrides: Partial<JobsRunnerPortDeps> & { db: Db; jobStore: JobsRunnerPortDeps['jobStore'] }) {
  return createJobsRunnerPort({ registry: fakeRegistry(), triggerBudgets: () => DEFAULT_BUDGETS, ...overrides })
}

/** `createJobsRunnerPort` — the parent-side implementation `daemon.ts` wires into
 * `JobRunnerDeps.jobs` (plan 80 §4.2). Resolves `{ jobId, deviceId }` to the caller's
 * own `JobRow` and delegates to `createScriptJobsReader`. */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string) {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'idle' }).run()
}

function seedScript(db: Db, id: string, name: string, version = '1.0.0') {
  db.insert(scripts).values({ id, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
}

let seq = 0
function seedJob(db: Db, input: { deviceId: string; scriptId?: string; status?: string; finishedAt?: Date | null; result?: unknown }): JobRow {
  const id = `job-${++seq}`
  db.insert(jobs)
    .values({
      id,
      scriptId: input.scriptId ?? 'internal:sleep',
      deviceId: input.deviceId,
      status: input.status ?? 'queued',
      createdAt: new Date(seq * 1000),
      finishedAt: input.finishedAt ?? null,
      result: input.result ?? null,
    })
    .run()
  return db.select().from(jobs).where(eq(jobs.id, id)).get() as JobRow
}

function fakeLog(): Logger & { warnings: Array<{ msg: string; extra?: Record<string, unknown> }> } {
  const warnings: Array<{ msg: string; extra?: Record<string, unknown> }> = []
  const self: Logger & { warnings: typeof warnings } = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (msg, extra) => warnings.push({ msg, extra }),
    error: () => {},
    child: () => self,
  }
  return self
}

describe('createJobsRunnerPort (plan 80 §4.2)', () => {
  test('list — resolves the caller job from { jobId, deviceId } and scopes to its device', async () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    seedJob(db, { deviceId: 'd2', scriptId: 's1', status: 'queued' })
    const port = makePort({ db, jobStore: store })

    const result = (await port.call({ jobId: caller.id, deviceId: 'd1' }, { method: 'list', limit: 10 })) as {
      items: Array<{ jobId: string }>
    }
    expect(result.items.map((i) => i.jobId)).toEqual([caller.id])
  })

  test('an unknown caller jobId throws E_JOB_NOT_FOUND', async () => {
    const db = setUp()
    const store = createJobStore(db)
    const port = makePort({ db, jobStore: store })

    await expect(port.call({ jobId: 'no-such', deviceId: 'd1' }, { method: 'previous' })).rejects.toThrow()
  })

  test('resultOf — a same-namespace, finished job resolves to its result', async () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const target = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'success', finishedAt: new Date(), result: { ok: true } })
    const port = makePort({ db, jobStore: store })

    const value = await port.call({ jobId: caller.id, deviceId: 'd1' }, { method: 'resultOf', jobId: target.id })
    expect(value).toEqual({ ok: true })
  })

  test('resultOf — criterion 9: a refusal collapses to null on the wire but is logged parent-side, naming the reason', async () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    seedScript(db, 's2', 'login')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const target = seedJob(db, { deviceId: 'd1', scriptId: 's2', status: 'success', finishedAt: new Date(), result: { token: 'x' } })
    const log = fakeLog()
    const port = makePort({ db, jobStore: store, log })

    const value = await port.call({ jobId: caller.id, deviceId: 'd1' }, { method: 'resultOf', jobId: target.id })
    expect(value).toBeNull()
    expect(log.warnings).toHaveLength(1)
    expect(log.warnings[0]?.extra?.reason).toBe('foreign-namespace')
    expect(log.warnings[0]?.extra?.targetJobId).toBe(target.id)
  })
})

describe('createJobsRunnerPort — trigger (plan 81 §4.2)', () => {
  test('dispatches to the trigger mechanism and fires onTriggered on a fresh (non-deduped) job', async () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    seedScript(db, 's2', 'warmup')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const registry = fakeRegistry({ 'warmup@1.0.0': { id: 's2', name: 'warmup', version: '1.0.0' } })
    const triggered: Array<{ fromId: string; targetDeviceId: string; jobId: string }> = []
    const port = makePort({
      db,
      jobStore: store,
      registry,
      onTriggered: (from, targetDeviceId, result) => triggered.push({ fromId: from.id, targetDeviceId, jobId: result.jobId }),
    })

    const result = (await port.call(
      { jobId: caller.id, deviceId: 'd1' },
      { method: 'trigger', script: 'warmup@1.0.0', key: 'k1' },
    )) as { jobId: string; deduped: boolean }
    expect(result.deduped).toBe(false)
    expect(triggered).toEqual([{ fromId: caller.id, targetDeviceId: 'd1', jobId: result.jobId }])

    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.triggeredByJobId).toBe(caller.id)
    expect(row?.depth).toBe(1)
  })

  test('does NOT fire onTriggered for a deduped call', async () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    seedScript(db, 's2', 'warmup')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const registry = fakeRegistry({ 'warmup@1.0.0': { id: 's2', name: 'warmup', version: '1.0.0' } })
    const triggered: unknown[] = []
    const port = makePort({ db, jobStore: store, registry, onTriggered: (...args) => triggered.push(args) })

    const first = (await port.call({ jobId: caller.id, deviceId: 'd1' }, { method: 'trigger', script: 'warmup@1.0.0', key: 'k1' })) as {
      jobId: string
      deduped: boolean
    }
    const second = (await port.call({ jobId: caller.id, deviceId: 'd1' }, { method: 'trigger', script: 'warmup@1.0.0', key: 'k1' })) as {
      jobId: string
      deduped: boolean
    }
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.jobId).toBe(first.jobId)
    expect(triggered).toHaveLength(1)
  })

  test('a refusal (E_TRIGGER_TOO_DEEP) rejects the call — no onTriggered, no row written', async () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedScript(db, 's1', 'checkout')
    seedScript(db, 's2', 'warmup')
    const caller = seedJob(db, { deviceId: 'd1', scriptId: 's1', status: 'running' })
    const registry = fakeRegistry({ 'warmup@1.0.0': { id: 's2', name: 'warmup', version: '1.0.0' } })
    const triggered: unknown[] = []
    const port = makePort({
      db,
      jobStore: store,
      registry,
      triggerBudgets: () => ({ maxDepth: 0, maxPerChain: 200, maxPerJob: 10 }),
      onTriggered: (...args) => triggered.push(args),
    })

    await expect(
      port.call({ jobId: caller.id, deviceId: 'd1' }, { method: 'trigger', script: 'warmup@1.0.0', key: 'k1' }),
    ).rejects.toMatchObject({ code: 'E_TRIGGER_TOO_DEEP' })
    expect(triggered).toHaveLength(0)
    const rows = db.select().from(jobs).where(eq(jobs.scriptId, 's2')).all()
    expect(rows).toHaveLength(0)
  })
})
