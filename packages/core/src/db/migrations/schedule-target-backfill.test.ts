import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../index'
import { migrationMarkers, schedules } from '../schema'
import { backfillScheduleTargets, MARKER_ID } from './schedule-target-backfill'
import { createLogger } from '../../util/logger'

/**
 * The `target` migration (plan 68 §4.1, step 68.1): every schedule created
 * before this plan reads as `{kind: 'script'}` by construction — absence of
 * a `schedule_agent_targets` row IS the discriminator (see that table's own
 * doc comment in `db/schema.ts`), so there is nothing to physically
 * convert. This pass is still guarded by a `migration_markers` row, exactly
 * like plan 22.0's cluster migration and plan 62's script-ref backfill, so
 * "did the 68 migration run" is answerable without reading source.
 */
function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedSchedule(db: ReturnType<typeof setUp>, id: string) {
  db.insert(schedules)
    .values({
      id,
      name: 'pre-existing',
      enabled: true,
      cron: '0 * * * *',
      timezone: 'UTC',
      scriptRef: 'checkout@1.0.0',
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
      lastFiredAt: null,
      lastBatchId: null,
      createdBy: null,
      createdAt: new Date(),
    })
    .run()
}

describe('backfillScheduleTargets — the target migration marker (plan 68 §4.1)', () => {
  test('runs once, writes the marker, and reports the pre-existing schedule count', () => {
    const db = setUp()
    seedSchedule(db, 's1')
    seedSchedule(db, 's2')

    const report = backfillScheduleTargets(db, { log: createLogger('test') })
    expect(report).not.toBeNull()
    expect(report?.totalSchedules).toBe(2)

    const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
    expect(marker).toBeDefined()
  })

  test('is a no-op on a second run — the marker guards it', () => {
    const db = setUp()
    seedSchedule(db, 's1')
    const first = backfillScheduleTargets(db, { log: createLogger('test') })
    expect(first).not.toBeNull()
    const second = backfillScheduleTargets(db, { log: createLogger('test') })
    expect(second).toBeNull()
  })

  test('runs cleanly with zero pre-existing schedules', () => {
    const db = setUp()
    const report = backfillScheduleTargets(db, { log: createLogger('test') })
    expect(report?.totalSchedules).toBe(0)
  })

  test('every pre-existing schedule remains a script target (no schedule_agent_targets row exists for it)', () => {
    const db = setUp()
    seedSchedule(db, 's1')
    backfillScheduleTargets(db, { log: createLogger('test') })
    const row = db.select().from(schedules).where(eq(schedules.id, 's1')).get()
    expect(row?.scriptRef).toBe('checkout@1.0.0') // untouched — still the literal reference
  })
})
