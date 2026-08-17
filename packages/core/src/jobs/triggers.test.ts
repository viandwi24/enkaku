import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs, scripts, type JobRow } from '../db/schema'
import { createScriptRegistry } from '../scripts/registry'
import { createDevSlotStore } from '../plugins/dev-slots'
import { EnkakuError } from '../util/errors'
import { createJobTrigger, type TriggerBudgets } from './triggers'

/**
 * `jobs/triggers.ts` (plan 81) — unit tests against a real in-memory DB and
 * the REAL `ScriptRegistry` (so §3.4 pinning and §3.4/§3.5 dev-slot
 * resolution are exercised for real, not mocked). Criteria 7 and 8 (the
 * runner-level idempotency and retry-budget interaction) live in
 * `trigger-runner.integration.test.ts` instead — a unit test of the key
 * function would pass while the runner interaction stayed broken (plan 81
 * §7).
 */

const DEFAULT_BUDGETS: TriggerBudgets = { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 }

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status = 'idle') {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

function seedScript(db: Db, id: string, name: string, version = '1.0.0', runtime: unknown = null) {
  db.insert(scripts).values({ pluginId: 'p-fixture', exportId: 'main', id, name, version, bundle: 'export {}', enabled: true, createdAt: new Date(), runtime }).run()
}

let seq = 0
/** A bare JobRow, as if enqueued the ordinary way — no lineage (plan 81 §4.1's own default). */
function seedRootJob(db: Db, input: { deviceId: string; scriptId?: string; expiresAt?: number | null }): JobRow {
  const id = `root-${++seq}`
  db.insert(jobs)
    .values({
      id,
      scriptId: input.scriptId ?? 'internal:sleep',
      deviceId: input.deviceId,
      status: 'running',
      priority: 0,
      createdAt: new Date(),
      expiresAt: input.expiresAt ?? null,
      depth: 0,
    })
    .run()
  return db.select().from(jobs).where(eq(jobs.id, id)).get() as JobRow
}

function makeRegistry(db: Db) {
  return createScriptRegistry({ db, dataDir: '/tmp/enkaku-triggers-test', devSlots: createDevSlotStore() })
}

describe('createJobTrigger — basic enqueue and lineage (plan 81 criteria 1, 2)', () => {
  test('triggers a job on the caller\'s own device; the row carries triggeredByJobId, rootJobId, depth 1', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const from = seedRootJob(db, { deviceId: 'd1' })
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })

    const result = trigger.trigger(from, { script: 'warmup@1.0.0', key: 'k1' })
    expect(result.deduped).toBe(false)

    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.status).toBe('queued')
    expect(row?.deviceId).toBe('d1')
    expect(row?.triggeredByJobId).toBe(from.id)
    expect(row?.rootJobId).toBe(from.id)
    expect(row?.depth).toBe(1)
    expect(row?.scriptName).toBe('warmup')
    expect(row?.scriptVersion).toBe('1.0.0')
  })

  test('a chain of triggers accumulates depth and shares one rootJobId', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })
    const root = seedRootJob(db, { deviceId: 'd1' })

    const c1 = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'c1' })
    const c1Row = db.select().from(jobs).where(eq(jobs.id, c1.jobId)).get() as JobRow
    const c2 = trigger.trigger(c1Row, { script: 'warmup@1.0.0', key: 'c2' })
    const c2Row = db.select().from(jobs).where(eq(jobs.id, c2.jobId)).get() as JobRow

    expect(c1Row.depth).toBe(1)
    expect(c1Row.rootJobId).toBe(root.id)
    expect(c2Row.depth).toBe(2)
    expect(c2Row.rootJobId).toBe(root.id) // NOT c1's id — the root propagates, it never re-roots
  })
})

describe('createJobTrigger — depth cap fails closed (plan 81 criterion 3)', () => {
  test('a chain reaching maxDepth refuses with E_TRIGGER_TOO_DEEP and writes no row', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => ({ maxDepth: 2, maxPerChain: 200, maxPerJob: 10 }) })
    const root = seedRootJob(db, { deviceId: 'd1' })

    const c1 = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'c1' })
    const c1Row = db.select().from(jobs).where(eq(jobs.id, c1.jobId)).get() as JobRow
    const c2 = trigger.trigger(c1Row, { script: 'warmup@1.0.0', key: 'c2' }) // depth 2 — exactly at the cap, allowed
    const c2Row = db.select().from(jobs).where(eq(jobs.id, c2.jobId)).get() as JobRow

    const before = db.select().from(jobs).all().length
    expect(() => trigger.trigger(c2Row, { script: 'warmup@1.0.0', key: 'c3' })).toThrow(EnkakuError)
    try {
      trigger.trigger(c2Row, { script: 'warmup@1.0.0', key: 'c3-b' })
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_TRIGGER_TOO_DEEP')
    }
    const after = db.select().from(jobs).all().length
    expect(after).toBe(before) // no row written by either refused call
  })
})

describe('createJobTrigger — chain-size cap fails closed (plan 81 criterion 4)', () => {
  test('a self-triggering script run to exhaustion stops at maxPerChain, not one row more', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-self', 'self-trigger')
    const budgets: TriggerBudgets = { maxDepth: 1_000, maxPerChain: 5, maxPerJob: 1_000 }
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => budgets })
    let current = seedRootJob(db, { deviceId: 'd1' })

    let created = 0
    let refusedAt = -1
    for (let i = 0; i < 50; i++) {
      try {
        const result = trigger.trigger(current, { script: 'self-trigger@1.0.0', key: `k${i}` })
        created++
        current = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get() as JobRow
      } catch (err) {
        expect((err as EnkakuError).code).toBe('E_TRIGGER_CHAIN_FULL')
        refusedAt = i
        break
      }
    }
    expect(created).toBe(5) // exactly maxPerChain — the chain genuinely stops
    expect(refusedAt).toBe(5)
    const descendantCount = db.select().from(jobs).where(eq(jobs.scriptId, 's-self')).all().length
    expect(descendantCount).toBe(5)
  })
})

describe('createJobTrigger — fan-out cap (plan 81 §3.2)', () => {
  test('one job triggering repeatedly is stopped by maxPerJob before maxPerChain', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => ({ maxDepth: 50, maxPerChain: 200, maxPerJob: 3 }) })
    const root = seedRootJob(db, { deviceId: 'd1' })

    trigger.trigger(root, { script: 'warmup@1.0.0', key: 'a' })
    trigger.trigger(root, { script: 'warmup@1.0.0', key: 'b' })
    trigger.trigger(root, { script: 'warmup@1.0.0', key: 'c' })
    expect(() => trigger.trigger(root, { script: 'warmup@1.0.0', key: 'd' })).toThrow(EnkakuError)
    try {
      trigger.trigger(root, { script: 'warmup@1.0.0', key: 'e' })
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_TRIGGER_FAN_OUT')
    }
  })
})

describe('createJobTrigger — concurrent triggers at the boundary (plan 81 criterion 5)', () => {
  test('two triggers back-to-back against a chain at maxPerChain - 1 result in exactly one new job', () => {
    // Bun/JS is single-threaded and `trigger()` is fully synchronous (one
    // `db.transaction()`, no `await` inside it) — there is no window for two
    // JS-level calls to interleave within one process. The atomicity this
    // criterion cares about is that the COUNT and the INSERT happen in one
    // transaction (so a real multi-connection race could not read the same
    // stale count twice); this test proves the observable outcome — back to
    // back calls at the exact boundary — which is what an operator sees.
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const budgets: TriggerBudgets = { maxDepth: 50, maxPerChain: 3, maxPerJob: 50 }
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => budgets })
    const root = seedRootJob(db, { deviceId: 'd1' })

    trigger.trigger(root, { script: 'warmup@1.0.0', key: 'a' })
    trigger.trigger(root, { script: 'warmup@1.0.0', key: 'b' }) // chain now at maxPerChain - 1 = 2... wait maxPerChain=3, 2 so far
    trigger.trigger(root, { script: 'warmup@1.0.0', key: 'c' }) // chain now AT maxPerChain (3)

    let succeeded = 0
    let refused = 0
    for (const key of ['d1', 'd2']) {
      try {
        trigger.trigger(root, { script: 'warmup@1.0.0', key })
        succeeded++
      } catch {
        refused++
      }
    }
    expect(succeeded).toBe(0) // already AT the cap before this pair — neither should insert
    expect(refused).toBe(2)
    expect(db.select().from(jobs).where(eq(jobs.scriptId, 's-warmup')).all()).toHaveLength(3)
  })

  test('exactly one of two calls at maxPerChain - 1 succeeds', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const budgets: TriggerBudgets = { maxDepth: 50, maxPerChain: 3, maxPerJob: 50 }
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => budgets })
    const root = seedRootJob(db, { deviceId: 'd1' })

    trigger.trigger(root, { script: 'warmup@1.0.0', key: 'a' })
    trigger.trigger(root, { script: 'warmup@1.0.0', key: 'b' }) // chain at 2 = maxPerChain - 1

    let succeeded = 0
    let refused = 0
    for (const key of ['c1', 'c2']) {
      try {
        trigger.trigger(root, { script: 'warmup@1.0.0', key })
        succeeded++
      } catch {
        refused++
      }
    }
    expect(succeeded).toBe(1)
    expect(refused).toBe(1)
    expect(db.select().from(jobs).where(eq(jobs.scriptId, 's-warmup')).all()).toHaveLength(3)
  })
})

describe('createJobTrigger — idempotency (plan 81 criterion 6)', () => {
  test('the same key twice returns the same jobId with deduped: true, and the queue grows by one, not two', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })
    const root = seedRootJob(db, { deviceId: 'd1' })

    const first = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'same-key' })
    const second = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'same-key' })
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.jobId).toBe(first.jobId)
    expect(db.select().from(jobs).where(eq(jobs.scriptId, 's-warmup')).all()).toHaveLength(1)
  })

  test('idempotency wins over a budget that would otherwise refuse — a re-run must not be punished by state that changed since', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    let budgets: TriggerBudgets = { maxDepth: 50, maxPerChain: 50, maxPerJob: 50 }
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => budgets })
    const root = seedRootJob(db, { deviceId: 'd1' })

    const first = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'same-key' })
    // The farm setting is lowered to zero AFTER the first trigger succeeded.
    budgets = { maxDepth: 0, maxPerChain: 0, maxPerJob: 0 }
    const second = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'same-key' })
    expect(second.deduped).toBe(true)
    expect(second.jobId).toBe(first.jobId)
  })

  test('a DIFFERENT key against the same chain is a genuinely new job', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })
    const root = seedRootJob(db, { deviceId: 'd1' })

    const first = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'key-a' })
    const second = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'key-b' })
    expect(second.deduped).toBe(false)
    expect(second.jobId).not.toBe(first.jobId)
  })
})

describe('createJobTrigger — @latest is pinned at trigger time (plan 81 criterion 9)', () => {
  test('publishing a higher version after the trigger does not change what the queued job runs', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup-1', 'warmup', '1.0.0')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })
    const root = seedRootJob(db, { deviceId: 'd1' })

    const result = trigger.trigger(root, { script: 'warmup@latest', key: 'k1' })
    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.scriptId).toBe('s-warmup-1')
    expect(row?.scriptVersion).toBe('1.0.0')

    // A higher version is published AFTER the trigger ran.
    seedScript(db, 's-warmup-2', 'warmup', '2.0.0')

    const stillRow = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(stillRow?.scriptId).toBe('s-warmup-1') // unchanged — resolved once, at trigger time
    expect(stillRow?.scriptVersion).toBe('1.0.0')
  })
})

describe('createJobTrigger — target device checks (plan 81 criterion 10)', () => {
  test('triggering onto an unknown device refuses with device_not_found', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })
    const root = seedRootJob(db, { deviceId: 'd1' })

    expect(() => trigger.trigger(root, { script: 'warmup@1.0.0', key: 'k1', deviceId: 'no-such-device' })).toThrow(EnkakuError)
    try {
      trigger.trigger(root, { script: 'warmup@1.0.0', key: 'k1-b', deviceId: 'no-such-device' })
    } catch (err) {
      expect((err as EnkakuError).code).toBe('device_not_found')
    }
  })

  test('triggering onto a quarantined device refuses with device_unavailable', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2', 'quarantined')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })
    const root = seedRootJob(db, { deviceId: 'd1' })

    try {
      trigger.trigger(root, { script: 'warmup@1.0.0', key: 'k1', deviceId: 'd2' })
      throw new Error('expected a throw')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('device_unavailable')
    }
  })
})

describe('createJobTrigger — expiresAt inheritance (plan 81 §8)', () => {
  test('defaults to the triggering job\'s own expiresAt', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })
    const root = seedRootJob(db, { deviceId: 'd1', expiresAt: 12_345 })

    const result = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'k1' })
    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.expiresAt).toBe(12_345)
  })

  test('explicit null overrides inheritance to "no expiry"', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })
    const root = seedRootJob(db, { deviceId: 'd1', expiresAt: 12_345 })

    const result = trigger.trigger(root, { script: 'warmup@1.0.0', key: 'k1', expiresAt: null })
    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.expiresAt).toBeNull()
  })
})

describe('createJobTrigger — dev-slot resolution (plan 81 criterion 13)', () => {
  test('a dev-slot script triggers a job whose row records the build-stamped version', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const devSlots = createDevSlotStore()
    devSlots.put({
      pluginName: 'tiktok',
      declaredVersion: '1.0.0',
      bundlePath: '/tmp/dev-bundle.mjs',
      scripts: [{ exportId: 'warmup', paramsSchema: null, runtime: null }],
      owner: { kind: 'cli', label: 'dev@laptop' },
    })
    const registry = createScriptRegistry({ db, dataDir: '/tmp/enkaku-triggers-test', devSlots })
    const trigger = createJobTrigger({ db, registry, budgets: () => DEFAULT_BUDGETS })
    const root = seedRootJob(db, { deviceId: 'd1' })

    const result = trigger.trigger(root, { script: 'tiktok/warmup@latest', key: 'k1' })
    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.scriptId).toBe('dev:tiktok/warmup')
    expect(row?.scriptVersion).toBe('1.0.0+dev.1')
    expect(row?.status).toBe('queued')

    // The slot is dropped (session ended) — the row still reads its name/version.
    devSlots.drop('tiktok')
    const stillRow = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(stillRow?.scriptVersion).toBe('1.0.0+dev.1')
  })
})

describe('createJobTrigger — a pre-existing (pre-plan-81) job row (criterion 12)', () => {
  test('a job with no lineage columns set can still be the "from" for a trigger', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })
    // No triggeredByJobId/rootJobId/triggerKey — exactly a pre-plan-81 row.
    const legacy = seedRootJob(db, { deviceId: 'd1' })
    expect(legacy.rootJobId).toBeNull()
    expect(legacy.depth).toBe(0)

    const result = trigger.trigger(legacy, { script: 'warmup@1.0.0', key: 'k1' })
    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.rootJobId).toBe(legacy.id) // the legacy row becomes the chain's root
    expect(row?.depth).toBe(1)
  })
})

/**
 * Plan 98 §3.7, §4.6, step 98.5 — a triggered job is a THIRD write path onto
 * `jobs` (alongside `services/job-service.ts`'s `enqueue`/`resume`), and must
 * pin `max_concurrent` exactly the same way: a `maxConcurrent: 1` script that
 * re-triggers itself must stay bounded by the claim gate, not escape it by
 * using `ctx.jobs.trigger()` instead of an ordinary enqueue. Against the REAL
 * `ScriptRegistry` (this file's own stated intent), not a mock — `entry.runtime`
 * comes straight off the `scripts.runtime` column this test seeds.
 */
describe('createJobTrigger — maxConcurrent resolution (plan 98 §3.7, §4.6, step 98.5)', () => {
  test('a triggered job of a script declaring runtime.maxConcurrent pins that value onto the row', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-capped', 'capped', '1.0.0', { maxConcurrent: 1 })
    const from = seedRootJob(db, { deviceId: 'd1' })
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })

    const result = trigger.trigger(from, { script: 'capped@1.0.0', key: 'k1' })
    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.maxConcurrent).toBe(1)
  })

  test('a triggered job of a script declaring no runtime resolves to 0 (unlimited), never null', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const from = seedRootJob(db, { deviceId: 'd1' })
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })

    const result = trigger.trigger(from, { script: 'warmup@1.0.0', key: 'k1' })
    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.maxConcurrent).toBe(0)
  })

  test('omitting farmJobSettings entirely still resolves correctly — the field has no farm layer at all', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-capped', 'capped', '1.0.0', { maxConcurrent: 2 })
    const from = seedRootJob(db, { deviceId: 'd1' })
    // No `farmJobSettings` key at all — the default constant inside
    // `triggers.ts` must carry this correctly (same equivalence proof as
    // `services/job-service.ts`'s own default).
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })

    const result = trigger.trigger(from, { script: 'capped@1.0.0', key: 'k1' })
    const row = db.select().from(jobs).where(eq(jobs.id, result.jobId)).get()
    expect(row?.maxConcurrent).toBe(2)
  })
})

/**
 * Plan 98 §3.3 S1, §4.5, step 98.6 — the version gate on the THIRD write
 * path onto `jobs`. Against the REAL `ScriptRegistry`, exactly like the
 * `maxConcurrent` describe block above: `entry.runtime` comes straight off
 * the `scripts.runtime` column this test seeds, never a mock.
 */
describe('createJobTrigger — the version gate (plan 98 §3.3 S1, step 98.6)', () => {
  test('a script declaring an unsupported runtime.sdk is refused with E_RUNTIME_UNSUPPORTED, and no job row is created', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-future', 'future', '1.0.0', { sdk: 99 })
    const from = seedRootJob(db, { deviceId: 'd1' })
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })

    const before = db.select().from(jobs).all().length
    let caught: EnkakuError | undefined
    try {
      trigger.trigger(from, { script: 'future@1.0.0', key: 'k1' })
    } catch (err) {
      caught = err as EnkakuError
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('E_RUNTIME_UNSUPPORTED')
    expect(caught?.message).toContain('99')
    // No row created for the refused trigger — the same "nothing written"
    // bar this plan's other refusals (`E_TRIGGER_TOO_DEEP` and friends) meet.
    expect(db.select().from(jobs).all().length).toBe(before)
  })

  test('a script declaring no runtime.sdk at all (every pre-plan-98 script) is unaffected', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-warmup', 'warmup')
    const from = seedRootJob(db, { deviceId: 'd1' })
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })

    const result = trigger.trigger(from, { script: 'warmup@1.0.0', key: 'k1' })
    expect(result.deduped).toBe(false)
  })

  test('a script declaring the current major (SCRIPT_RUNTIME_MAJOR) is unaffected', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 's-current', 'current', '1.0.0', { sdk: 1 })
    const from = seedRootJob(db, { deviceId: 'd1' })
    const trigger = createJobTrigger({ db, registry: makeRegistry(db), budgets: () => DEFAULT_BUDGETS })

    const result = trigger.trigger(from, { script: 'current@1.0.0', key: 'k1' })
    expect(result.deduped).toBe(false)
  })
})
