import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, runMigrations, type Db } from '../db'
import { batches, deviceEvents, devices, jobNodes, jobs } from '../db/schema'
import { createJobStore, parseJobRuntimeOverride, rowToJobInfo } from './job-store'

/**
 * The claim query (plan 20 §4.2, §7) is the only place device booking is
 * made race-free (spec §10.3). These tests are written against the gate the
 * rewrite must add: a batch's `concurrency` must never be exceeded, batch
 * order must be respected, and neither may ever push a standalone job — or a
 * higher-priority one — behind a batch. Written before the rewrite so they
 * fail against the old statement (no batch awareness at all) and pass
 * against the new one.
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'idle' | 'busy' | 'offline' = 'idle') {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status })
    .run()
}

function seedBatch(db: Db, id: string, concurrency: number, order: 'as-listed' | 'random' = 'as-listed') {
  db.insert(batches)
    .values({ id, scriptId: 'internal:sleep', concurrency, order, status: 'queued', createdAt: new Date() })
    .run()
}

let seq = 0
/** created_at is integer unix seconds: two jobs seeded in the same test tick
 * would otherwise tie, which is exactly the scenario worth exercising, but
 * `createdAt` lets a test force an explicit order when it needs one. */
function seedJob(
  db: Db,
  input: {
    deviceId: string
    priority?: number
    batchId?: string | null
    batchSeq?: number | null
    createdAt?: Date
    /** Defaults to 'internal:sleep', matching every pre-existing call site. */
    scriptId?: string
    /** Plan 98 §3.7, §4.6, step 98.5 — the claim gate is keyed on this, not `scriptId` (§4.6, §9 Q5). */
    scriptName?: string | null
    /** Plan 98 §3.7, §4.4, §4.6, step 98.5 — the ONE resolved runtime value ever pinned onto a row. `undefined` stores `null` — "unlimited", matching every job before this column existed. */
    maxConcurrent?: number | null
    /** Plan 94 §3.8, §4.8, step 94.6 — unix seconds; `undefined` stores `null` — "claimable now", matching every job before this column existed. No producer wires this yet (94.7's pacer), so tests set it directly. */
    notBefore?: number | null
  },
) {
  const id = `job-${++seq}`
  db.insert(jobs)
    .values({
      id,
      scriptId: input.scriptId ?? 'internal:sleep',
      deviceId: input.deviceId,
      params: { durationMs: 1000 },
      priority: input.priority ?? 0,
      status: 'queued',
      createdAt: input.createdAt ?? new Date(),
      batchId: input.batchId ?? null,
      batchSeq: input.batchSeq ?? null,
      scriptName: input.scriptName ?? null,
      maxConcurrent: input.maxConcurrent ?? null,
      notBefore: input.notBefore ?? null,
    })
    .run()
  return id
}

describe('claimNext — standalone jobs', () => {
  test('a standalone job (no batch) is claimed exactly once', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })

    const first = store.claimNext(60)
    expect(first?.job.id).toBe(jobId)
    expect(first?.job.status).toBe('running')

    const second = store.claimNext(60)
    expect(second).toBeNull()
  })
})

/**
 * Plan 98 §3.9 item 4, §4.4, H1 — step 98.2, "measure before limiting". This
 * runs against a REAL SQLite database migrated through the REAL generated
 * migration (`bun run --cwd packages/core db:generate`, `0045_workable_venus.sql`
 * per this step), not a hand-shaped fixture — proving `peak_rss_bytes`
 * actually exists on the row and survives a genuine write/read round trip,
 * the same DB path a running job's own settle takes.
 */
describe('finish — peakRssBytes (plan 98 §4.4, H1)', () => {
  test('a peakRssBytes passed to finish() lands on the row and rowToJobInfo carries it through', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })
    store.claimNext(60)

    const updated = store.finish(jobId, 'success', { result: 'ok', peakRssBytes: 209_715_200 })
    expect(updated?.peakRssBytes).toBe(209_715_200)

    // Read back independently of finish()'s own return value — proves it is
    // really on the row, not just echoed back from the call's input.
    const row = store.get(jobId)
    expect(row?.peakRssBytes).toBe(209_715_200)
    expect(rowToJobInfo(row!).peakRssBytes).toBe(209_715_200)
  })

  test('omitting peakRssBytes leaves the column untouched (never overwrites a real number with null)', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })
    store.claimNext(60)

    // A job that never spawned a subprocess (or an executor with no rss
    // reporting) calls finish() with no peakRssBytes at all — the column
    // must stay null, not get coerced to some other falsy value.
    const updated = store.finish(jobId, 'success', { result: 'ok' })
    expect(updated?.peakRssBytes).toBeNull()
  })
})

/**
 * Plan 98 §3.8, §4.4, §5 step 98.7 — `jobs.runtime_override`, pinned at
 * enqueue by the caller (`services/job-service.ts`, already validated and
 * ceiling-checked there) and read back through `parseJobRuntimeOverride`,
 * the same defensive discipline `scripts.runtime`'s own `parseScriptRuntime`
 * established: never an `as`-cast, a parse failure degrades to `null`.
 */
describe('enqueue — runtimeOverride (plan 98 §3.8, §4.4, step 98.7)', () => {
  test('a runtimeOverride passed to enqueue() lands on the row unchanged, read back independently', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const override = { maxRssBytes: 256 * 1024 * 1024, timeoutMs: 60_000 }

    const row = store.enqueue({ scriptId: 'internal:sleep', deviceId: 'd1', params: {}, priority: 0, runtimeOverride: override })
    expect(row.runtimeOverride).toEqual(override)

    const readBack = store.get(row.id)
    expect(readBack?.runtimeOverride).toEqual(override)
  })

  test('omitting runtimeOverride stores null — identical to every job enqueued before this column existed', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')

    const row = store.enqueue({ scriptId: 'internal:sleep', deviceId: 'd1', params: {}, priority: 0 })
    expect(row.runtimeOverride).toBeNull()
  })
})

describe('parseJobRuntimeOverride (plan 98 §3.8, §4.4, step 98.7)', () => {
  test('parses a valid envelope', () => {
    expect(parseJobRuntimeOverride({ maxRssBytes: 100 * 1024 * 1024 })).toEqual({ maxRssBytes: 100 * 1024 * 1024 })
  })

  test('null and undefined both parse to null', () => {
    expect(parseJobRuntimeOverride(null)).toBeNull()
    expect(parseJobRuntimeOverride(undefined)).toBeNull()
  })

  test('a corrupt/future-shaped value degrades to null rather than throwing', () => {
    expect(parseJobRuntimeOverride({ retries: -1 })).toBeNull()
    expect(parseJobRuntimeOverride('not an object')).toBeNull()
    expect(parseJobRuntimeOverride(42)).toBeNull()
  })

  test('an unknown key alone still parses (stripped, not refused) — S3 applies to this column too', () => {
    expect(parseJobRuntimeOverride({ someBrandNewField: true })).toEqual({})
  })
})

/**
 * Plan 91 §3.5, §4.9, §5 step 91.5 — the range query behind `GET
 * /api/jobs/:id/assists`, run against a REAL SQLite `device_events` table
 * (not a hand-shaped fixture), the same DB path the real endpoint uses.
 */
describe('assists (plan 91 §3.5, §4.9)', () => {
  test('finds a non-job input event on the job device within its run window, and excludes everything else', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })
    db.update(jobs)
      .set({ startedAt: new Date(1_700_000_000_000), finishedAt: new Date(1_700_000_100_000) })
      .where(eq(jobs.id, jobId))
      .run()

    // Inside the window, human-attributed — a real assist.
    db.insert(deviceEvents)
      .values({ id: 'ev-1', deviceId: 'd1', stream: 'input', kind: 'input.tap', actor: 'user-1', meta: { assist: true, jobId }, at: new Date(1_700_000_050_000) })
      .run()
    // Inside the window, but job-attributed (F3: this cannot happen through
    // the real recorder today, but the filter must still exclude it if it
    // ever did — matching the plan's own literal query).
    db.insert(deviceEvents)
      .values({ id: 'ev-2', deviceId: 'd1', stream: 'input', kind: 'input.tap', actor: `job:${jobId}`, meta: null, at: new Date(1_700_000_060_000) })
      .run()
    // Outside the window entirely (before the job started).
    db.insert(deviceEvents)
      .values({ id: 'ev-3', deviceId: 'd1', stream: 'input', kind: 'input.tap', actor: 'user-1', meta: null, at: new Date(1_699_999_000_000) })
      .run()
    // Outside the window entirely (after the job finished).
    db.insert(deviceEvents)
      .values({ id: 'ev-4', deviceId: 'd1', stream: 'input', kind: 'input.tap', actor: 'user-1', meta: null, at: new Date(1_700_000_200_000) })
      .run()
    // Inside the window, but the MAIN stream — never an "assist action".
    db.insert(deviceEvents)
      .values({ id: 'ev-5', deviceId: 'd1', stream: 'main', kind: 'control.assist.started', actor: 'user-1', meta: null, at: new Date(1_700_000_050_000) })
      .run()

    const result = store.assists(jobId)
    expect(result.map((e) => e.id)).toEqual(['ev-1'])
    expect(result[0]?.meta).toEqual({ assist: true, jobId })
  })

  test('a job that never started has no assists', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })
    expect(store.assists(jobId)).toEqual([])
  })

  test('a still-running job (no finishedAt) is bounded by now, not left open-ended', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })
    db.update(jobs).set({ startedAt: new Date(Date.now() - 60_000) }).where(eq(jobs.id, jobId)).run()
    db.insert(deviceEvents)
      .values({ id: 'ev-1', deviceId: 'd1', stream: 'input', kind: 'input.tap', actor: 'user-1', meta: null, at: new Date() })
      .run()

    const result = store.assists(jobId)
    expect(result.map((e) => e.id)).toEqual(['ev-1'])
  })

  test('three assists on a finished job come back in order, with the operator id on each', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })
    db.update(jobs)
      .set({ startedAt: new Date(1_700_000_000_000), finishedAt: new Date(1_700_000_100_000) })
      .where(eq(jobs.id, jobId))
      .run()
    for (let i = 0; i < 3; i++) {
      db.insert(deviceEvents)
        .values({
          id: `ev-${i}`,
          deviceId: 'd1',
          stream: 'input',
          kind: 'input.tap',
          actor: 'operator-1',
          meta: { assist: true, jobId },
          at: new Date(1_700_000_010_000 + i * 1000),
        })
        .run()
    }

    const result = store.assists(jobId)
    expect(result.map((e) => e.id)).toEqual(['ev-0', 'ev-1', 'ev-2'])
    expect(result.every((e) => e.actor === 'operator-1')).toBe(true)
  })
})

describe('claimNext — batch concurrency gate (plan 20 §4.2)', () => {
  test('concurrency=1 never yields two running jobs in the same batch', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })

    const claim1 = store.claimNext(60)
    expect(claim1).not.toBeNull()

    // Both devices are idle at this point except the one just claimed — the
    // second device is still idle, so a device-status-only gate would wrongly
    // let this second claim through.
    const claim2 = store.claimNext(60)
    expect(claim2).toBeNull()

    const running = db.select().from(jobs).where(eq(jobs.batchId, 'b1')).all().filter((j) => j.status === 'running')
    expect(running.length).toBe(1)
  })

  test('concurrency=1: finishing the running job frees the next slot', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const job0 = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })

    const claim1 = store.claimNext(60)
    expect(claim1?.job.id).toBe(job0)
    expect(store.claimNext(60)).toBeNull()

    store.finish(job0, 'success', {})
    // The device frees up independently of the batch gate (plan 20 §3.3 —
    // per-device idleness is a separate, pre-existing constraint).
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd1')).run()

    const claim2 = store.claimNext(60)
    expect(claim2).not.toBeNull()
    expect(claim2?.deviceId).toBe('d2')
  })

  test('concurrency=2 never yields three running jobs in the same batch', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 2)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })
    seedJob(db, { deviceId: 'd3', batchId: 'b1', batchSeq: 2 })

    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).toBeNull()

    const running = db.select().from(jobs).where(eq(jobs.batchId, 'b1')).all().filter((j) => j.status === 'running')
    expect(running.length).toBe(2)
  })

  test('concurrency=0 (unlimited) starts every device at once', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 0)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })
    seedJob(db, { deviceId: 'd3', batchId: 'b1', batchSeq: 2 })

    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).toBeNull()
  })

  test('a batch of 5 with concurrency=1: exactly one claim succeeds until it finishes (§7)', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    const deviceIds = ['d1', 'd2', 'd3', 'd4', 'd5']
    for (const d of deviceIds) seedDevice(db, d)
    const jobIds = deviceIds.map((d, i) => seedJob(db, { deviceId: d, batchId: 'b1', batchSeq: i }))

    const firstClaim = store.claimNext(60)
    expect(firstClaim?.job.id).toBe(jobIds[0])
    // Repeated calls, all devices still idle except the claimed one — none succeed.
    for (let i = 0; i < 4; i++) expect(store.claimNext(60)).toBeNull()
  })
})

/**
 * Plan 98 §3.7, §4.6, step 98.5 — the SAME correlated-`COUNT(*)` style as the
 * batch gate immediately above, keyed on `script_name` instead of `batch_id`
 * (`jobs.max_concurrent`, resolved and pinned at enqueue — this store never
 * resolves it itself, only claims against the integer already on the row).
 *
 * The two properties the step's own brief calls out by name: (1) the bound
 * narrows only ITS OWN script's additional jobs — a `maxConcurrent`-capped
 * script blocked on every device must never make the whole claim query
 * return nothing, or a farm would idle around one popular script (the
 * "device famine" failure mode a naive `WHERE` clause produces); (2) the
 * gate lives INSIDE the claim transaction, in SQL — proven two ways below:
 * a same-process sequential test asserting the SQL clause's own semantics,
 * and a genuinely multi-process test (`claim-race-worker.ts`, spawned via
 * `Bun.spawn`, each in its OWN OS process with its OWN SQLite connection to
 * the SAME on-disk file) hammering `claimNext` concurrently — a TypeScript
 * pre-filter (job-store.ts:256-260's own standing warning, repeated for this
 * gate in claimNext's comment) could only be caught by REAL concurrent
 * callers, never by sequential calls dressed up as parallel ones.
 */
describe('claimNext — maxConcurrent gate (plan 98 §3.7, §4.6, step 98.5)', () => {
  test("the plan's own verifiable result: three jobs of a maxConcurrent:1 script on three idle devices yield exactly one running, two queued — and the freed devices stay claimable by a DIFFERENT script immediately (no device famine)", () => {
    const db = setUp()
    const store = createJobStore(db)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    const capped = ['d1', 'd2', 'd3'].map((d) => seedJob(db, { deviceId: d, scriptName: 'capped', maxConcurrent: 1 }))

    const first = store.claimNext(60)
    if (!first) throw new Error('fixture: expected the first claim of a capped script to succeed')
    expect(capped).toContain(first.job.id)

    // The cap is already saturated — the other two capped jobs must NOT
    // claim, even though their own devices are still idle.
    expect(store.claimNext(60)).toBeNull()

    const runningCapped = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.scriptName, 'capped'), eq(jobs.status, 'running')))
      .all()
    expect(runningCapped.length).toBe(1)
    const queuedCapped = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.scriptName, 'capped'), eq(jobs.status, 'queued')))
      .all()
    expect(queuedCapped.length).toBe(2)

    // One of the two still-idle devices now gets a job from a DIFFERENT
    // script — the property this step's brief calls the one that "makes or
    // breaks this step": a blocked script must never idle a device that a
    // different script could use right now.
    const idleDeviceId = ['d1', 'd2', 'd3'].find((d) => d !== first.deviceId)
    if (!idleDeviceId) throw new Error('fixture: expected an idle device other than the one just claimed')
    const otherJob = seedJob(db, { deviceId: idleDeviceId, scriptName: 'different-script', maxConcurrent: 1 })

    const second = store.claimNext(60)
    expect(second?.job.id).toBe(otherJob)
    expect(second?.deviceId).toBe(idleDeviceId)
  })

  test('finishing the running capped job frees the slot for the next queued job of the SAME script', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const job0 = seedJob(db, { deviceId: 'd1', scriptName: 'capped', maxConcurrent: 1 })
    const job1 = seedJob(db, { deviceId: 'd2', scriptName: 'capped', maxConcurrent: 1 })

    const claim1 = store.claimNext(60)
    expect(claim1?.job.id).toBe(job0)
    expect(store.claimNext(60)).toBeNull()

    store.finish(job0, 'success', {})
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd1')).run()

    const claim2 = store.claimNext(60)
    expect(claim2?.job.id).toBe(job1)
  })

  test('maxConcurrent=0 is unlimited, exactly like the batch gate’s own concurrency=0', () => {
    const db = setUp()
    const store = createJobStore(db)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    for (const d of ['d1', 'd2', 'd3']) seedJob(db, { deviceId: d, scriptName: 'uncapped', maxConcurrent: 0 })

    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).toBeNull()
  })

  test('maxConcurrent=NULL (a pre-plan-98 row, or a script that declares no cap) is unlimited', () => {
    const db = setUp()
    const store = createJobStore(db)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    // `maxConcurrent` omitted entirely — `seedJob` stores NULL, the exact
    // shape of every job enqueued before this column existed.
    for (const d of ['d1', 'd2', 'd3']) seedJob(db, { deviceId: d, scriptName: 'legacy' })

    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).not.toBeNull()
  })

  test('keyed on script_name, not script_id (plan 98 §4.6, §9 Q5) — two different scriptIds sharing one name are gated together', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    // Same script NAME, two different resolved scriptIds — e.g. two
    // versions of the same published script, or a dev-slot id alongside a
    // persisted one. The gate must still see them as one script.
    seedJob(db, { deviceId: 'd1', scriptId: 'script-row-v1', scriptName: 'shared-name', maxConcurrent: 1 })
    seedJob(db, { deviceId: 'd2', scriptId: 'script-row-v2', scriptName: 'shared-name', maxConcurrent: 1 })

    expect(store.claimNext(60)).not.toBeNull()
    expect(store.claimNext(60)).toBeNull()
  })

  /**
   * The concurrency test the step's brief demands by name: "a concurrency
   * test hammering claimNext from parallel callers proving no
   * over-admission" — "write it to genuinely run parallel callers, not
   * sequential ones dressed up as parallel." A single Bun process cannot
   * genuinely race itself (synchronous `claimNext` calls in one JS thread
   * never interleave), so this spawns real, separate OS PROCESSES
   * (`claim-race-worker.ts`, via `Bun.spawn` — the same "spawn a real
   * process" discipline this plan's own `memory-limit.integration.test.ts`
   * and `peak-rss.integration.test.ts` already established for a different
   * boundary), each opening its OWN SQLite connection to the SAME on-disk
   * database file and hammering `claimNext` in a tight loop with no
   * coordination between them. If the gate were a TypeScript pre-filter (or
   * anything outside the `BEGIN IMMEDIATE` transaction), two of these
   * processes could each observe "0 running" and both admit — this is the
   * exact race job-store.ts's own claimNext comment warns about for the
   * batch gate, now proven closed for this one too.
   */
  test('a real multi-process race: N processes hammering claimNext concurrently against a maxConcurrent:1 script never admit more than one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enkaku-claim-race-'))
    const dbPath = join(dir, 'race.db')
    try {
      const { db } = openDb(dbPath)
      runMigrations(db)

      const workerCount = 8
      const deviceIds = Array.from({ length: workerCount }, (_, i) => `race-d${i}`)
      for (const d of deviceIds) seedDevice(db, d)
      const jobIds = deviceIds.map((d) => seedJob(db, { deviceId: d, scriptName: 'race-script', maxConcurrent: 1 }))

      const workerPath = join(import.meta.dir, 'claim-race-worker.ts')
      const attemptsPerWorker = 25
      const procs = Array.from({ length: workerCount }, () =>
        Bun.spawn(['bun', workerPath, dbPath, String(attemptsPerWorker)], { stdout: 'pipe', stderr: 'pipe' }),
      )

      const results = await Promise.all(
        procs.map(async (p) => {
          const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
          if (exitCode !== 0) throw new Error(`claim-race-worker exited ${exitCode}: ${stderr}`)
          return JSON.parse(stdout) as string[]
        }),
      )

      const allClaimed = results.flat()
      // No job claimed twice, by different workers or the same one.
      expect(new Set(allClaimed).size).toBe(allClaimed.length)
      // The cap: across every process, every attempt, exactly one job of
      // this script was EVER admitted — the whole point of the gate living
      // inside the SQL transaction rather than in application code.
      expect(allClaimed.length).toBe(1)
      const winner = allClaimed[0]
      if (!winner) throw new Error('fixture: expected exactly one claimed job id')
      expect(jobIds).toContain(winner)

      const runningCount = db
        .select()
        .from(jobs)
        .where(and(eq(jobs.scriptName, 'race-script'), eq(jobs.status, 'running')))
        .all().length
      expect(runningCount).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

/**
 * Plan 94 §3.8, §4.8, step 94.6's own verifiable result: a job inserted with
 * `notBefore = now + 5` is not claimed for 5s on an idle device, and with
 * `notBefore` null, claim behaviour is byte-identical to before this step
 * (plan's own named risk: SQL's `=` never matches `NULL = NULL`, so the null
 * path is exercised explicitly, not just the new one).
 */
describe('claimNext — notBefore gate (plan 94 §3.8, §4.8, step 94.6)', () => {
  test('notBefore in the future is not claimed; the SAME row becomes claimable the instant notBefore is at or before now — proving the gate reacts to the column, not a one-time refusal', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const nowSec = Math.floor(Date.now() / 1000)
    const jobId = seedJob(db, { deviceId: 'd1', notBefore: nowSec + 5 })

    // Not due for 5s — must not be claimed right now.
    expect(store.claimNext(60)).toBeNull()
    const stillQueued = db.select().from(jobs).where(eq(jobs.id, jobId)).get()
    expect(stillQueued?.status).toBe('queued')

    // Simulate the clock reaching the floor (no real sleep — the gate reads
    // the column, not a timer this test would have to wait out).
    db.update(jobs).set({ notBefore: nowSec - 1 }).where(eq(jobs.id, jobId)).run()
    const claimed = store.claimNext(60)
    expect(claimed?.job.id).toBe(jobId)
  })

  test('notBefore exactly equal to now IS claimable — the floor is inclusive (<=), not exclusive', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const nowSec = Math.floor(Date.now() / 1000)
    const jobId = seedJob(db, { deviceId: 'd1', notBefore: nowSec })

    const claimed = store.claimNext(60)
    expect(claimed?.job.id).toBe(jobId)
  })

  test('notBefore NULL claims exactly as before this column existed — the risk the plan itself names: SQL "=" never matches NULL = NULL, so this path is not just implied by the future-date test above', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    // notBefore omitted entirely — seedJob stores NULL, the exact shape of
    // every job before this column existed.
    const jobId = seedJob(db, { deviceId: 'd1' })

    const claimed = store.claimNext(60)
    expect(claimed?.job.id).toBe(jobId)
  })

  test('a paced job never blocks a different, immediately-claimable job on another device — only the paced row itself is skipped', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const nowSec = Math.floor(Date.now() / 1000)
    seedJob(db, { deviceId: 'd1', notBefore: nowSec + 3600 })
    const readyJob = seedJob(db, { deviceId: 'd2' })

    const claimed = store.claimNext(60)
    expect(claimed?.job.id).toBe(readyJob)
    expect(claimed?.deviceId).toBe('d2')
  })
})

describe('claimNext — batch order (plan 20 §3.2, §4.2)', () => {
  test('as-listed claims ascending batchSeq regardless of insert order', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 0)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    // Inserted out of seq order on purpose.
    const j2 = seedJob(db, { deviceId: 'd3', batchId: 'b1', batchSeq: 2 })
    const j0 = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    const j1 = seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })

    // concurrency=1 forces one-at-a-time so claim order is directly observable.
    db.update(batches).set({ concurrency: 1 }).where(eq(batches.id, 'b1')).run()

    const claim1 = store.claimNext(60)
    expect(claim1?.job.id).toBe(j0)
    store.finish(j0, 'success', {})
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd1')).run()

    const claim2 = store.claimNext(60)
    expect(claim2?.job.id).toBe(j1)
    store.finish(j1, 'success', {})
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd2')).run()

    const claim3 = store.claimNext(60)
    expect(claim3?.job.id).toBe(j2)
  })

  test('a standalone job (NULL batch_seq) is not pushed to the back at equal priority', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 0)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const now = new Date()
    // Same priority, same created_at second — the tie a NULLS-LAST ordering would lose.
    const batched = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0, priority: 0, createdAt: now })
    const standalone = seedJob(db, { deviceId: 'd2', priority: 0, createdAt: now })

    const claimed: string[] = []
    for (let i = 0; i < 2; i++) {
      const c = store.claimNext(60)
      if (c) claimed.push(c.job.id)
    }
    expect(claimed).toContain(standalone)
    expect(claimed).toContain(batched)
    // The standalone job must not be last among equal-priority, equal-age jobs.
    expect(claimed.indexOf(standalone)).toBeLessThanOrEqual(claimed.indexOf(batched))
  })
})

describe('claimNext — priority still dominates (plan 20 §3.3, acceptance #7)', () => {
  test('a standalone job at priority 10 wins over a batched job at priority 0', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 0)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const batched = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0, priority: 0 })
    const standalone = seedJob(db, { deviceId: 'd2', priority: 10 })

    const claim = store.claimNext(60)
    expect(claim?.job.id).toBe(standalone)
    expect(claim?.job.id).not.toBe(batched)
  })

  test('a standalone job is not blocked behind a running (concurrency-saturated) batch', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0, priority: 0 })
    const standaloneHigh = seedJob(db, { deviceId: 'd2', priority: 5 })

    // The batch's only slot fills first (it happens to be higher in this
    // ordering only because of priority — verify the standalone still gets served).
    const claim1 = store.claimNext(60)
    expect(claim1?.job.id).toBe(standaloneHigh)

    const claim2 = store.claimNext(60)
    expect(claim2).not.toBeNull() // the batch job, unaffected by the standalone
  })
})

describe('claimNext — restart continuation (plan 20 §7)', () => {
  test('with jobs half-finished, a fresh claimNext continues at the right batchSeq', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedBatch(db, 'b1', 1)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    const j0 = seedJob(db, { deviceId: 'd1', batchId: 'b1', batchSeq: 0 })
    const j1 = seedJob(db, { deviceId: 'd2', batchId: 'b1', batchSeq: 1 })
    const j2 = seedJob(db, { deviceId: 'd3', batchId: 'b1', batchSeq: 2 })

    const c0 = store.claimNext(60)
    expect(c0?.job.id).toBe(j0)
    store.finish(j0, 'success', {})
    db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd1')).run()

    // Simulate a fresh JobStore instance (as a core restart would create).
    const restarted = createJobStore(db)
    const c1 = restarted.claimNext(60)
    expect(c1?.job.id).toBe(j1)
    expect(c1?.job.id).not.toBe(j2)
  })
})

describe('cancelQueuedDescendants (plan 81 §4.4, criterion 11)', () => {
  function trigger(db: Db, parentId: string, id: string, status: string) {
    db.insert(jobs)
      .values({ id, scriptId: 'internal:sleep', deviceId: 'd1', status, priority: 0, createdAt: new Date(), triggeredByJobId: parentId, depth: 1 })
      .run()
  }

  test('cancels every still-queued descendant, transitively, and leaves unrelated jobs alone', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const root = seedJob(db, { deviceId: 'd1' })
    // root -> c1 (queued) -> gc1 (queued)
    //      -> c2 (queued)
    trigger(db, root, 'c1', 'queued')
    trigger(db, 'c1', 'gc1', 'queued')
    trigger(db, root, 'c2', 'queued')
    // An unrelated standalone job — never triggered by anything.
    const unrelated = seedJob(db, { deviceId: 'd1' })

    const cancelled = store.cancelQueuedDescendants(root)
    expect(cancelled).toBe(3)
    expect(store.get('c1')?.status).toBe('cancelled')
    expect(store.get('gc1')?.status).toBe('cancelled')
    expect(store.get('c2')?.status).toBe('cancelled')
    expect(store.get(unrelated)?.status).toBe('queued') // untouched
    expect(store.get(root)?.status).toBe('queued') // the root itself is never touched by this call
  })

  test('a non-queued descendant (already running/finished) is left alone, not cancelled', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const root = seedJob(db, { deviceId: 'd1' })
    trigger(db, root, 'c1', 'running')
    trigger(db, root, 'c2', 'success')
    trigger(db, root, 'c3', 'queued')

    const cancelled = store.cancelQueuedDescendants(root)
    expect(cancelled).toBe(1)
    expect(store.get('c1')?.status).toBe('running')
    expect(store.get('c2')?.status).toBe('success')
    expect(store.get('c3')?.status).toBe('cancelled')
  })

  test('a sibling subtree (same root, different parent) is left alone — this walks triggeredByJobId, not rootJobId', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const root = seedJob(db, { deviceId: 'd1' })
    trigger(db, root, 'c1', 'queued')
    trigger(db, root, 'c2', 'queued') // c1's SIBLING — not a descendant of c1

    const cancelled = store.cancelQueuedDescendants('c1')
    expect(cancelled).toBe(0)
    expect(store.get('c2')?.status).toBe('queued')
  })
})

describe('list — rootJobId filter (plan 81 §4.5)', () => {
  function trigger(db: Db, rootId: string, parentId: string, id: string, depth: number) {
    db.insert(jobs)
      .values({
        id,
        scriptId: 'internal:sleep',
        deviceId: 'd1',
        status: 'queued',
        priority: 0,
        createdAt: new Date(),
        triggeredByJobId: parentId,
        rootJobId: rootId,
        depth,
      })
      .run()
  }

  test('returns every other member of the chain, excluding the root itself', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const root = seedJob(db, { deviceId: 'd1' })
    trigger(db, root, root, 'c1', 1)
    trigger(db, root, 'c1', 'gc1', 2)
    const unrelatedRoot = seedJob(db, { deviceId: 'd1' })
    trigger(db, unrelatedRoot, unrelatedRoot, 'other-c1', 1)

    const { rows, total } = store.list({ rootJobId: root, limit: 50 })
    expect(rows.map((r) => r.id).sort()).toEqual(['c1', 'gc1'])
    expect(total).toBe(2)
    // Neither the root's own row nor a different chain's members leak in.
    expect(rows.some((r) => r.id === root)).toBe(false)
    expect(rows.some((r) => r.id === 'other-c1')).toBe(false)
  })

  test('a job with no chain returns an empty page, not an error', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const standalone = seedJob(db, { deviceId: 'd1' })

    const { rows, total } = store.list({ rootJobId: standalone, limit: 50 })
    expect(rows).toEqual([])
    expect(total).toBe(0)
  })
})

/**
 * `nodes()` / `recordResume()` / `resumeInfo()` (plan 99 §3.5, §4.9, step
 * 99.8) — the node timeline read and the resume-lineage write `JobService`'s
 * `nodes()`/`resume()` sit on top of.
 */
describe('nodes / recordResume / resumeInfo (plan 99 §3.5, §4.9, step 99.8)', () => {
  test('nodes() returns job_nodes rows in seq order, regardless of insert order', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })
    db.insert(jobNodes)
      .values([
        { id: 'n2', jobId, seq: 1, nodeId: 'b', kind: 'script', status: 'success', attempts: 1 },
        { id: 'n1', jobId, seq: 0, nodeId: 'a', kind: 'script', status: 'success', attempts: 1 },
      ])
      .run()

    // `!` throughout this describe block: `nodes`/`recordResume`/`resumeInfo`
    // are OPTIONAL on the `JobStore` interface (so the many hand-written
    // partial fakes elsewhere in the tree keep compiling — see the
    // interface's own comment), but `createJobStore`'s REAL implementation,
    // under test here, always provides them.
    const rows = store.nodes(jobId)
    expect(rows.map((r) => [r.seq, r.nodeId])).toEqual([
      [0, 'a'],
      [1, 'b'],
    ])
  })

  test('nodes() is [] for a job that never executed one — every non-workflow job, and a workflow job not yet started', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const jobId = seedJob(db, { deviceId: 'd1' })
    expect(store.nodes(jobId)).toEqual([])
  })

  test('recordResume() + resumeInfo() round trip; a job never resumed answers null', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1')
    const originalId = seedJob(db, { deviceId: 'd1' })
    const newId = seedJob(db, { deviceId: 'd1' })

    expect(store.resumeInfo(newId)).toBeNull()
    store.recordResume(newId, { resumedFromJobId: originalId, resumedFromNode: 'b' })
    expect(store.resumeInfo(newId)).toEqual({ resumedFromJobId: originalId, resumedFromNode: 'b' })
    // The ORIGINAL job was not itself created by a resume.
    expect(store.resumeInfo(originalId)).toBeNull()
  })
})

/**
 * The boot sweep (plan 99 §3.5, §4.9, step 99.8's own checklist item): a
 * workflow job left `running` by a crash is failed by the EXISTING
 * `failOrphanRunning` (plan 04 §4.6) — unchanged by this plan, and correctly
 * so, since resume reads `job_nodes`, never `jobs.status` alone. The one
 * thing this step's brief asks to assert: those rows are NOT deleted. There
 * is no cascade anywhere in this store that could delete them today, but
 * this test is written so it fails BY NAME the day someone adds one.
 */
describe('failOrphanRunning leaves job_nodes intact (plan 99 §3.5, §4.9, step 99.8 boot sweep)', () => {
  test('a workflow job orphaned mid-pipeline is failed, and its job_nodes rows survive untouched', () => {
    const db = setUp()
    const store = createJobStore(db)
    seedDevice(db, 'd1', 'busy')
    const jobId = seedJob(db, { deviceId: 'd1' })
    db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, jobId)).run()
    db.insert(jobNodes)
      .values([
        { id: 'n1', jobId, seq: 0, nodeId: 'a', kind: 'script', status: 'success', attempts: 1 },
        { id: 'n2', jobId, seq: 1, nodeId: 'b', kind: 'script', status: 'success', attempts: 1 },
        { id: 'n3', jobId, seq: 2, nodeId: 'c', kind: 'script', status: 'running', attempts: 1 },
      ])
      .run()

    const affected = store.failOrphanRunning()
    expect(affected).toBeGreaterThanOrEqual(1)

    const row = store.get(jobId)
    expect(row?.status).toBe('failed')
    expect(row?.failureClass).toBe('infra')

    // THE assertion: failOrphanRunning touches `jobs` only. `job_nodes` for
    // this job is exactly what it was before the sweep — this is what
    // POST /:id/resume reads after a crash.
    const nodes = store.nodes(jobId)
    expect(nodes).toHaveLength(3)
    expect(nodes.map((n) => [n.seq, n.nodeId, n.status])).toEqual([
      [0, 'a', 'success'],
      [1, 'b', 'success'],
      [2, 'c', 'running'],
    ])
  })
})
