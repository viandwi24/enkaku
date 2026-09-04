import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../index'
import { migrationMarkers, schedules } from '../schema'
import { createLogger } from '../../util/logger'
import { backfillScheduleTargets, MARKER_ID } from './schedule-target-backfill'

const log = createLogger('test').child('schedule-target-backfill')

function seedSchedule(db: ReturnType<typeof openDb>['db'], id: string) {
  db.insert(schedules)
    .values({
      id,
      name: id,
      enabled: true,
      cron: '0 * * * *',
      timezone: 'UTC',
      scriptRef: 'checkout@1.0.0',
      createdAt: new Date(1_700_000_000_000),
    })
    .run()
}

/**
 * `schedule-target-backfill.test.ts` (plan 68 §4.1) — restores the coverage
 * `docs/plans/200-mvp-program.md` §8.9/§10.1 records as lost when plan 211
 * deleted this file. The migration itself is still live (`daemon.ts` calls
 * `backfillScheduleTargets` on every boot); this is a data migration over
 * rows already on disk, exactly plan 200 §8.3's critical list.
 */
describe('backfillScheduleTargets (plan 68 §4.1)', () => {
  test('every pre-existing schedule is reported as already a script target — no data to convert, marker recorded once', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db, opened.sqlite)
    const db = opened.db
    seedSchedule(db, 'sched-1')
    seedSchedule(db, 'sched-2')
    seedSchedule(db, 'sched-3')

    const report = backfillScheduleTargets(db, { log })
    expect(report).not.toBeNull()
    expect(report?.totalSchedules).toBe(3)

    const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
    expect(marker).toBeTruthy()

    // Nothing about the rows themselves changed — the migration's whole point
    // is that "script" is the absence of a companion row, not a stored value.
    const rows = db.select().from(schedules).all()
    expect(rows.map((r) => r.scriptRef).sort()).toEqual(['checkout@1.0.0', 'checkout@1.0.0', 'checkout@1.0.0'])
  })

  test('a second call is a no-op: the marker guard stops it from running twice', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db, opened.sqlite)
    const db = opened.db
    seedSchedule(db, 'sched-1')

    const first = backfillScheduleTargets(db, { log })
    expect(first).not.toBeNull()

    const second = backfillScheduleTargets(db, { log })
    expect(second).toBeNull()

    const markers = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).all()
    expect(markers).toHaveLength(1)
  })

  test('an empty database still runs and records the marker, reporting zero schedules', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db, opened.sqlite)
    const db = opened.db

    const report = backfillScheduleTargets(db, { log })
    expect(report?.totalSchedules).toBe(0)
    const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
    expect(marker).toBeTruthy()
  })
})
