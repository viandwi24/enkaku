import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs, schedules, scheduleRuns, scripts, type ScheduleRow } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createScriptRegistry } from '../scripts/registry'
import { createLogger } from '../util/logger'
import { fireOnce, type ScheduleRunnerDeps } from '../schedules/runner'

/**
 * A gap found while auditing plan 98 steps 98.6/98.7, sibling to (and NOT
 * fixed by) the `clusters/dispatch.ts` fix `batch-dispatch-version-gate.test.ts`
 * pins: `packages/core/src/schedules/runner.ts`'s `fireOnce` builds its own
 * `batchDeps: BatchDispatchDeps` literal (the object it passes to
 * `createBatch`) with ONLY `db`/`scheduler`/`audit`/`onJobStatus`/
 * `validateScript` — never `scriptNameOf`, never `farmJobSettings` — even
 * though `daemon.ts` already wires a real `ScriptRegistry` onto
 * `ScheduleRunnerDeps.registry` (used a few lines later, inside the SAME
 * function, to resolve `resolved = deps.registry.resolve(parsedRef.data)`
 * before dispatch). `docs/plans/96-m61-hotfixes.md` §96.14 wired
 * `scriptNameOf` into `api/batches.ts`'s two `createBatch(...)` call sites
 * but never into this THIRD one — a schedule firing a batch is `api/schedules
 * .ts`'s own documented behaviour ("triggers a **batch** ... never a bare
 * job"), so this is a real, reachable path, not a hypothetical one.
 *
 * The consequence touches BOTH gates `clusters/dispatch.ts` now enforces:
 * with `named` always `null` on this call site, `createBatch`'s
 * `checkRuntimeMajor(named?.runtime?.sdk)` (plan 98 §3.3 S1, step 98.6 —
 * added by this same audit) resolves `undefined` and never refuses — a
 * schedule firing a script declaring an unsupported `runtime.sdk` still
 * dispatches a batch and every member job claims a device, exactly the
 * failure acceptance criterion 11 forbids — and `resolveBatchMemberMaxConcurrent`
 * (plan 98 §3.7, step 98.5, closed everywhere else by 96.14) still resolves
 * `0`/unlimited and `scriptName` still writes `null`, i.e. the PRE-96.14
 * behaviour that entry believed it had closed for every batch path.
 *
 * `packages/core/src/schedules/runner.ts` is outside every file list this
 * worker was assigned, even after the `clusters/**`/`api/batches.ts`
 * reassignment, so — per this plan's own "make the gap self-detecting"
 * instruction — it is reported and pinned here rather than edited directly.
 * This test calls the REAL, exported `fireOnce` (not a re-implementation)
 * against a REAL SQLite DB, a REAL `ScriptRegistry`, and a script row that
 * genuinely declares `runtime.sdk: 99`, reproducing the exact production
 * wiring `daemon.ts` builds (`registry: scriptRegistry` IS supplied here —
 * this is not a "what if nobody wired it" test, `no-registry-at-all` is a
 * separate, already-graceful case). It fails today: `outcome` reads
 * `'dispatched'`, not `'error'`, and a job row exists for the refused
 * script.
 *
 * THE FIX, verbatim (`packages/core/src/schedules/runner.ts`, inside the
 * `batchDeps: BatchDispatchDeps = { ... }` object literal that `fireOnce`
 * already builds, a few lines before its `createBatch(batchDeps, ...)`
 * call):
 *
 *   const batchDeps: BatchDispatchDeps = {
 *     db: deps.db,
 *     scheduler: deps.scheduler,
 *     audit: deps.audit,
 *     onJobStatus: deps.onJobStatus,
 *     ...(deps.validateScript ? { validateScript: deps.validateScript } : {}),
 *     ...(deps.registry ? { scriptNameOf: (scriptId: string) => deps.registry!.get(scriptId) } : {}),
 *   }
 *
 * — the identical `(scriptId) => deps.scriptRegistry?.get(scriptId) ?? null`
 * shape `api/batches.ts` already uses at both of ITS call sites, adapted to
 * this file's own `registry` field name and its `ScriptRegistry.get`'s own
 * `| undefined` return (folded to `| null` by `ScriptEntry | undefined`
 * already being assignable where `BatchDispatchDeps.scriptNameOf`'s return
 * type accepts `null` — a bare `deps.registry!.get(scriptId)` compiles as
 * `ScriptEntry | undefined`, which the interface's own `| null` return type
 * widens to accept unchanged, matching how `job-service.ts`'s own
 * `scriptNameOf` is typed). `farmJobSettings` has no equivalent source on
 * `ScheduleRunnerDeps` at all today; leaving it unwired is not a new gap —
 * it resolves exactly like every other unwired `farmJobSettings` already
 * does ("no ceiling", never a refusal an operator did not configure) — so
 * only `scriptNameOf` is required to close this finding.
 */
describe('fireOnce (schedules/runner.ts) — the version gate is NOT reached (open gap, not fixed by this audit)', () => {
  function setUp() {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    return opened.db
  }

  function seedDevice(db: Db, id: string) {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'idle' }).run()
  }

  function seedScript(db: Db, id: string, name: string, runtime: unknown) {
    db.insert(scripts).values({ pluginId: 'p-fixture', exportId: 'main', id, name, version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date(), runtime }).run()
  }

  function seedSchedule(db: Db, scriptRef: string): ScheduleRow {
    const row: ScheduleRow = {
      id: 'sched-1',
      name: 'fires an unsupported-sdk script',
      enabled: true,
      cron: '0 * * * *',
      timezone: 'UTC',
      scriptRef,
      params: {},
      clusterId: null,
      deviceIds: ['d1'],
      concurrency: 0,
      order: 'as-listed',
      onOverlap: 'skip',
      queueTimeoutSec: null,
      catchUp: 'skip',
      jitterSec: 0,
      priority: 0,
      repeatCount: 1,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      deviceIntervalMs: 0,
      lastFiredAt: null,
      lastBatchId: null,
      createdBy: null,
      createdAt: new Date(),
    }
    db.insert(schedules).values(row).run()
    return row
  }

  function fakeScheduler(): Scheduler {
    return { kick: () => {}, start: () => {}, stop: () => {} }
  }

  test('a schedule firing a script declaring an unsupported runtime.sdk still dispatches — this is the gap', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedScript(db, 'future-1.0.0', 'future', { sdk: 99 })
    const schedule = seedSchedule(db, 'future@1.0.0')

    const registry = createScriptRegistry({ db, dataDir: '/tmp/enkaku-schedule-version-gate-test', devSlots: createDevSlotStore() })
    const deps: ScheduleRunnerDeps = {
      db,
      jobStore: createJobStore(db),
      scheduler: fakeScheduler(),
      audit: createAuditLogger(db),
      log: createLogger('test'),
      onJobStatus: () => {},
      broadcastBatchStatus: () => {},
      broadcastFired: () => {},
      // The exact production shape (`daemon.ts:1286` wires `registry: scriptRegistry`)
      // — this is not an "unwired registry" test.
      registry,
    }

    await fireOnce(deps, schedule, new Date())

    const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, schedule.id)).get()
    // DESIRED (post-fix) behaviour, matching every other write path's own
    // test in this plan: the version gate refuses, `outcome` is `'error'`
    // naming `E_RUNTIME_UNSUPPORTED`, and no job is ever created.
    expect(run?.outcome).toBe('error')
    expect(run?.detail).toContain('E_RUNTIME_UNSUPPORTED')
    expect(db.select().from(jobs).all().length).toBe(0)
  })
})
