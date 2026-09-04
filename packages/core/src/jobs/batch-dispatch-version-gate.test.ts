import { describe, expect, test } from 'bun:test'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs } from '../db/schema'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import { createBatch } from '../groups/dispatch'

/**
 * Plan 98 §3.3 S1, §4.5, step 98.6 — the version gate on the FOURTH write
 * path onto `jobs`. FIXED 2026-08-13 (audited by a separate worker; `groups/**`
 * and `api/batches.ts` were reassigned to that worker mid-audit once the
 * previous holder of those files finished, which is what made fixing this in
 * place — rather than only reporting it — possible).
 *
 * `services/job-service.ts`'s `enqueue()`/`resume()` and `jobs/triggers.ts`'s
 * `trigger()` all call `checkRuntimeMajor` the instant they resolve a
 * script's `runtime` (see each file's own "the version gate" describe
 * block). `groups/dispatch.ts`'s `createBatch` is the plan's own
 * documented FOURTH path — step 98.5's own status paragraph named it as a
 * pre-existing gap because the file had no `ScriptRegistry` in its
 * dependency graph at all, and step 98.6's own status paragraph repeated
 * that reasoning to explain why the version gate did not reach it either.
 *
 * That reasoning stopped being true without the version gate following it:
 * `docs/plans/96-m61-hotfixes.md` §96.14 gave `BatchDispatchDeps` an optional
 * `scriptNameOf`, closing the ORIGINAL gap (`maxConcurrent` resolving to
 * 0/unlimited for every batch member, `scriptName` staying null). `createBatch`
 * resolved `named = deps.scriptNameOf?.(...)` (`groups/dispatch.ts`) and
 * read `named?.runtime` to resolve `maxConcurrent` — but, until this fix,
 * never called `checkRuntimeMajor` on `named?.runtime?.sdk`, unlike every
 * other write path holding the identical `named` local. A script declaring
 * an unsupported `runtime.sdk`, dispatched as a batch, was never refused:
 * every member job was created, queued, and eventually claimed a device —
 * the exact failure acceptance criterion 11 ("a bundle declaring an
 * unsupported runtime.sdk ... never claims a device") forbids.
 *
 * THE FIX (now landed, `packages/core/src/groups/dispatch.ts`, immediately
 * after `const named = deps.scriptNameOf?.(input.scriptId) ?? null`, before
 * `resolveBatchMemberMaxConcurrent`): the identical
 * `checkRuntimeMajor(named?.runtime?.sdk)` → `throw new EnkakuError(...)`
 * shape `jobs/triggers.ts` already uses right after its own `entry.runtime`
 * resolves, checked before the target-resolution/`assertDeviceAllowed` work
 * does anything — matching `job-service.ts`'s "before params validation and
 * before any device is claimed" ordering. No `jobs.ts` `ERROR_STATUS` change
 * was needed — 98.6 already mapped `E_RUNTIME_UNSUPPORTED` to 400 there, and
 * `api/batches.ts` already funnels a thrown `EnkakuError` through the same
 * handler `api/jobs.ts` uses.
 *
 * These two tests stayed exactly as originally written (they pinned the gap
 * red before the fix, per this document's own self-detecting-gap
 * convention) — only this docstring and the `describe` title changed to
 * record that the fix landed; a green run now IS the proof.
 */
describe('createBatch — the version gate (plan 98 §3.3 S1, step 98.6)', () => {
  function setUp() {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    return opened.db
  }

  function seedDevice(db: Db, id: string) {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'idle' }).run()
  }

  function fakeScheduler(): Scheduler {
    return { kick: () => {}, start: () => {}, stop: () => {} }
  }

  test('a script declaring an unsupported runtime.sdk, dispatched as a batch, is refused with E_RUNTIME_UNSUPPORTED and no job row is created', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const audit = createAuditLogger(db)

    let caught: EnkakuError | undefined
    try {
      createBatch(
        {
          db,
          scheduler: fakeScheduler(),
          audit,
          onJobStatus: () => {},
          scriptNameOf: () => ({ name: 'future-batch-script', version: '1.0.0', runtime: { sdk: 99 } }),
        },
        { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1', 'd2'] }, concurrency: 0, order: 'as-listed' },
      )
    } catch (err) {
      caught = err as EnkakuError
    }

    expect(caught).toBeInstanceOf(EnkakuError)
    expect(caught?.code).toBe('E_RUNTIME_UNSUPPORTED')
    // The bar every other write path's own test meets (job-service.test.ts,
    // triggers.test.ts): nothing written, not even a partial batch.
    expect(db.select().from(jobs).all().length).toBe(0)
  })

  test('a script declaring no runtime.sdk at all (every pre-plan-98 script) dispatches unaffected — the control for the test above', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const audit = createAuditLogger(db)

    const { jobs: created } = createBatch(
      {
        db,
        scheduler: fakeScheduler(),
        audit,
        onJobStatus: () => {},
        scriptNameOf: () => ({ name: 'login', version: '1.0.0', runtime: null }),
      },
      { scriptId: 'internal:sleep', params: {}, target: { deviceIds: ['d1'] }, concurrency: 0, order: 'as-listed' },
    )
    expect(created.length).toBe(1)
  })
})

// A SEPARATE, still-open gap this audit found while verifying the fix above
// was not defeated by a hidden dependency one layer up (the coordinator's
// own warning: `docs/plans/96-m61-hotfixes.md` §96.14 fixed `maxConcurrent`/
// `scriptName` for batch dispatch, but ONLY at `api/batches.ts`'s two
// `createBatch(...)` call sites — `packages/core/src/schedules/runner.ts`'s
// OWN `createBatch(batchDeps, ...)` call, the batch a firing SCHEDULE
// dispatches, never got the same `scriptNameOf` wiring, so a schedule firing
// a script with an unsupported `runtime.sdk` still dispatches unrefused) has
// its own dedicated, genuinely failing test against the REAL `fireOnce`:
// `packages/core/src/jobs/scheduled-batch-version-gate.test.ts`. See that
// file's own header for the full reasoning and the verbatim fix.
