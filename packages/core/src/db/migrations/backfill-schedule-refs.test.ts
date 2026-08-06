import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from '../index'
import { schedules, scripts } from '../schema'
import { createLogger } from '../../util/logger'
import { backfillScheduleScriptRefs, SCHEDULE_SCRIPT_REF_RENAME_TAG } from './backfill-schedule-refs'

const log = createLogger('test').child('schedule-ref-backfill')

/**
 * Seeds a schedule row the way it would have looked BEFORE plan 62: a
 * concrete `scripts.id` in the (not-yet-renamed) `script_id` column.
 */
function seedPreMigrationSchedule(db: ReturnType<typeof openDb>['db'], opts: { id: string; name: string; scriptId: string }) {
  db.run(
    sql`INSERT INTO schedules (id, name, enabled, cron, timezone, script_id, cluster_id, concurrency, "order", on_overlap, catch_up, jitter_sec, priority, created_at)
        VALUES (${opts.id}, ${opts.name}, 1, '0 * * * *', 'UTC', ${opts.scriptId}, 'c1', 0, 'as-listed', 'skip', 'skip', 0, 0, 1700000000)`,
  )
}

describe('backfillScheduleScriptRefs (plan 62 §4.3)', () => {
  test('three pre-existing schedules on three versions become three pinned references, not @latest (acceptance #9)', () => {
    const opened = openDb(':memory:')
    // Stop strictly BEFORE the rename so `schedules.script_id` still exists.
    runMigrationsUpTo(opened.db, SCHEDULE_SCRIPT_REF_RENAME_TAG)
    const db = opened.db

    db.insert(scripts)
      .values([
        { id: 's-checkout-100', name: 'checkout', version: '1.0.0', bundle: 'x', enabled: true, createdAt: new Date() },
        { id: 's-checkout-200', name: 'checkout', version: '2.0.0', bundle: 'x', enabled: true, createdAt: new Date() },
        { id: 's-login-050', name: 'login', version: '0.5.0', bundle: 'x', enabled: true, createdAt: new Date() },
      ])
      .run()

    // Three schedules, each pinned to a DIFFERENT version — including one
    // pinned to the OLDER checkout version, so a naive "just resolve latest"
    // backfill would visibly get this one wrong.
    seedPreMigrationSchedule(db, { id: 'sched-1', name: 'nightly-checkout-old', scriptId: 's-checkout-100' })
    seedPreMigrationSchedule(db, { id: 'sched-2', name: 'nightly-checkout-new', scriptId: 's-checkout-200' })
    seedPreMigrationSchedule(db, { id: 'sched-3', name: 'nightly-login', scriptId: 's-login-050' })

    // Now apply the rest, including the rename.
    runMigrations(db)

    const report = backfillScheduleScriptRefs(db, { log })
    expect(report).not.toBeNull()
    expect(report?.converted).toBe(3)
    expect(report?.unresolved).toHaveLength(0)

    const rows = db.select().from(schedules).all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    // Pinned exactly to what they were pinned to — the OLD version for
    // sched-1, never bumped to @latest or to 2.0.0.
    expect(byId.get('sched-1')?.scriptRef).toBe('checkout@1.0.0')
    expect(byId.get('sched-2')?.scriptRef).toBe('checkout@2.0.0')
    expect(byId.get('sched-3')?.scriptRef).toBe('login@0.5.0')
  })

  test('running it twice changes nothing on the second pass (idempotent, acceptance #9)', () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, SCHEDULE_SCRIPT_REF_RENAME_TAG)
    const db = opened.db

    db.insert(scripts).values({ id: 's1', name: 'checkout', version: '1.0.0', bundle: 'x', enabled: true, createdAt: new Date() }).run()
    seedPreMigrationSchedule(db, { id: 'sched-1', name: 'nightly', scriptId: 's1' })
    // A second, brand-new version published AFTER the migration ran once —
    // if the marker did not hold, a second backfill pass would have nothing
    // left to convert anyway (the ref no longer looks like a raw id), but
    // this also proves the marker itself short-circuits before even looking.
    runMigrations(db)

    const first = backfillScheduleScriptRefs(db, { log })
    expect(first?.converted).toBe(1)

    const second = backfillScheduleScriptRefs(db, { log })
    expect(second).toBeNull() // short-circuited by the marker

    const row = db.select().from(schedules).where(eq(schedules.id, 'sched-1')).get()
    expect(row?.scriptRef).toBe('checkout@1.0.0')
  })

  test('a schedule whose script no longer exists is reported, not guessed at', () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, SCHEDULE_SCRIPT_REF_RENAME_TAG)
    const db = opened.db

    seedPreMigrationSchedule(db, { id: 'sched-orphan', name: 'orphaned', scriptId: 'script-that-was-deleted' })
    runMigrations(db)

    const report = backfillScheduleScriptRefs(db, { log })
    expect(report?.converted).toBe(0)
    expect(report?.unresolved).toEqual([{ scheduleId: 'sched-orphan', scheduleName: 'orphaned', oldScriptId: 'script-that-was-deleted' }])

    const row = db.select().from(schedules).where(eq(schedules.id, 'sched-orphan')).get()
    // Left as-is — not silently converted to something that did not exist.
    expect(row?.scriptRef).toBe('script-that-was-deleted')
  })

  test('a schedule created fresh, already carrying a reference, is left untouched', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db

    db.insert(scripts).values({ id: 's1', name: 'checkout', version: '1.0.0', bundle: 'x', enabled: true, createdAt: new Date() }).run()
    db.insert(schedules)
      .values({
        id: 'sched-fresh',
        name: 'fresh',
        enabled: true,
        cron: '0 * * * *',
        timezone: 'UTC',
        scriptRef: 'checkout@latest',
        clusterId: 'c1',
        concurrency: 0,
        order: 'as-listed',
        onOverlap: 'skip',
        catchUp: 'skip',
        jitterSec: 0,
        priority: 0,
        createdAt: new Date(),
      })
      .run()

    const report = backfillScheduleScriptRefs(db, { log })
    expect(report?.converted).toBe(0)
    const row = db.select().from(schedules).where(eq(schedules.id, 'sched-fresh')).get()
    expect(row?.scriptRef).toBe('checkout@latest')
  })
})
