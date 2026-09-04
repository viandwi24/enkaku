import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs, scripts } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createScriptRegistry } from '../scripts/registry'
import { createBatch } from './dispatch'

/**
 * Plan 98 §3.7, §4.4, §4.6, step 98.5 (batch dispatch half, closed here per
 * `docs/plans/96-m61-hotfixes.md`) — `createBatch` (`groups/dispatch.ts`)
 * previously wrote every batch member with `maxConcurrent: null` regardless
 * of what the script declared, because this file had no `ScriptRegistry` in
 * its dependency graph at all (its own `toJobRow` comment used to say so by
 * name). A script's `runtime.maxConcurrent` was therefore honoured for a
 * standalone `enqueue()`/`resume()` (`services/job-service.ts`) and a
 * triggered job (`jobs/triggers.ts`) but silently ignored the moment the
 * SAME script ran as a batch — which is the ordinary way an operator runs a
 * script across a farm of many phones (the brief's own framing).
 *
 * This is the exact proof `job-store.test.ts`'s own
 * "claimNext — maxConcurrent gate" describe block already established for a
 * hand-seeded job — reused here, not reinvented, for a BATCH-dispatched one:
 * a same-process sequential check that the gate held (right below), and a
 * genuinely multi-process race (`claim-race-worker.ts`, unmodified, spawned
 * via `Bun.spawn` exactly as `job-store.test.ts`'s own race test does) that
 * hammers `claimNext` from real, separate OS processes against the SAME
 * on-disk database `createBatch` just wrote to. The claim gate itself
 * (`queue/job-store.ts`'s `BEGIN IMMEDIATE` transaction) is not this file's
 * to re-prove — `job-store.test.ts` already does, exhaustively — the only
 * new fact this file proves is that a BATCH member's row now carries a real
 * `maxConcurrent`/`scriptName` for that gate to act on at all.
 */

function seedDevice(db: Db, id: string) {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'online' }).run()
}

function fakeScheduler(): Scheduler {
  return { kick: () => {}, start: () => {}, stop: () => {} }
}

/** A minimal, valid script row declaring `runtime.maxConcurrent` — the same `scripts.runtime` JSON column `scripts/registry.ts`'s `parseScriptRuntime` reads. */
function publishCappedScript(db: Db, id: string, name: string, maxConcurrent: number) {
  db.insert(scripts)
    .values({
      pluginId: 'p-fixture',
      exportId: 'main',
      id,
      name,
      version: '1.0.0',
      kind: 'script',
      bundle: 'export default { run: async () => null }',
      enabled: true,
      paramsSchema: null,
      runtime: { maxConcurrent },
      createdAt: new Date(),
    })
    .run()
}

describe('createBatch → claimNext — a batch member now carries the SAME runtime.maxConcurrent cap a standalone enqueue() applies', () => {
  test("dispatching a maxConcurrent:1 script as a batch across three idle devices pins maxConcurrent:1 and scriptName on all three rows — the gate's own precondition", () => {
    const db = openDb(':memory:').db
    runMigrations(db)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    publishCappedScript(db, 'capped-1.0.0', 'capped', 1)
    const scriptRegistry = createScriptRegistry({ db, dataDir: `/tmp/enkaku-batch-cap-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
    const audit = createAuditLogger(db)

    const { jobs: created } = createBatch(
      {
        db,
        scheduler: fakeScheduler(),
        audit,
        onJobStatus: () => {},
        scriptNameOf: (scriptId) => scriptRegistry.get(scriptId),
      },
      { scriptId: 'capped-1.0.0', params: {}, target: { deviceIds: ['d1', 'd2', 'd3'] }, concurrency: 0, order: 'as-listed' },
    )

    expect(created.length).toBe(3)
    for (const row of created) {
      expect(row.maxConcurrent).toBe(1)
      expect(row.scriptName).toBe('capped')
      expect(row.scriptVersion).toBe('1.0.0')
    }
  })

  test('without scriptNameOf wired (the pre-fix shape), a batch member still resolves to unlimited — never a regression for a caller with no interest in the cap', () => {
    const db = openDb(':memory:').db
    runMigrations(db)
    seedDevice(db, 'd1')
    const audit = createAuditLogger(db)
    const { jobs: created } = createBatch(
      { db, scheduler: fakeScheduler(), audit, onJobStatus: () => {} },
      { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1'] }, concurrency: 0, order: 'as-listed' },
    )
    expect(created[0]?.maxConcurrent).toBe(0) // "unlimited" — same fallback shape job-service.ts's own enqueue() has unwired
    expect(created[0]?.scriptName).toBeNull()
  })

  test("the plan's own verifiable result, batch-dispatched: a maxConcurrent:1 script dispatched as ONE BATCH across three idle devices yields exactly one running, two queued (same-process, sequential claimNext calls)", () => {
    const db = openDb(':memory:').db
    runMigrations(db)
    for (const d of ['d1', 'd2', 'd3']) seedDevice(db, d)
    publishCappedScript(db, 'capped-1.0.0', 'capped', 1)
    const scriptRegistry = createScriptRegistry({ db, dataDir: `/tmp/enkaku-batch-cap-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
    const audit = createAuditLogger(db)
    const store = createJobStore(db)

    createBatch(
      {
        db,
        scheduler: fakeScheduler(),
        audit,
        onJobStatus: () => {},
        scriptNameOf: (scriptId) => scriptRegistry.get(scriptId),
      },
      { scriptId: 'capped-1.0.0', params: {}, target: { deviceIds: ['d1', 'd2', 'd3'] }, concurrency: 0, order: 'as-listed' },
    )

    const first = store.claimNext(60)
    expect(first).not.toBeNull()
    // The cap is saturated — the other two batch members' own devices are
    // still idle, but the maxConcurrent:1 gate must refuse them anyway.
    expect(store.claimNext(60)).toBeNull()

    const running = db.select().from(jobs).where(and(eq(jobs.scriptName, 'capped'), eq(jobs.status, 'running'))).all()
    const queued = db.select().from(jobs).where(and(eq(jobs.scriptName, 'capped'), eq(jobs.status, 'queued'))).all()
    expect(running.length).toBe(1)
    expect(queued.length).toBe(2)
  })

  /**
   * The genuine article: real, separate OS processes (not sequential calls
   * dressed up as parallel — `claim-race-worker.ts`'s own doc comment)
   * hammering `claimNext` against a real on-disk database that `createBatch`
   * — unmodified, the actual production function — just populated. If a
   * batch member's `maxConcurrent`/`scriptName` were still null (the
   * pre-fix state), every one of these processes would freely admit its own
   * device's job and this test would see 3 winners, not 1 — see the
   * non-vacuousness check in this file's own report for the direct
   * confirmation of that failure mode.
   */
  test('a real multi-process race: N processes hammering claimNext concurrently against a maxConcurrent:1 script dispatched as a BATCH never admit more than one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enkaku-batch-claim-race-'))
    const dbPath = join(dir, 'race.db')
    try {
      const { db } = openDb(dbPath)
      runMigrations(db)
      for (const d of ['race-d0', 'race-d1', 'race-d2']) seedDevice(db, d)
      publishCappedScript(db, 'race-capped-1.0.0', 'race-capped', 1)
      const scriptRegistry = createScriptRegistry({ db, dataDir: `/tmp/enkaku-batch-cap-race-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
      const audit = createAuditLogger(db)

      const { jobs: created } = createBatch(
        {
          db,
          scheduler: fakeScheduler(),
          audit,
          onJobStatus: () => {},
          scriptNameOf: (scriptId) => scriptRegistry.get(scriptId),
        },
        { scriptId: 'race-capped-1.0.0', params: {}, target: { deviceIds: ['race-d0', 'race-d1', 'race-d2'] }, concurrency: 0, order: 'as-listed' },
      )
      const jobIds = created.map((j) => j.id)
      expect(jobIds.length).toBe(3)

      const workerCount = 8
      const workerPath = join(import.meta.dir, '..', 'queue', 'claim-race-worker.ts')
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
      expect(new Set(allClaimed).size).toBe(allClaimed.length) // no double-claim
      expect(allClaimed.length).toBe(1) // the cap: exactly one of the three EVER admitted, across every process/attempt
      const winner = allClaimed[0]
      if (!winner) throw new Error('fixture: expected exactly one claimed job id')
      expect(jobIds).toContain(winner)

      const runningCount = db.select().from(jobs).where(and(eq(jobs.scriptName, 'race-capped'), eq(jobs.status, 'running'))).all().length
      expect(runningCount).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
