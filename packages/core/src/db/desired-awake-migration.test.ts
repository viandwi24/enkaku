import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from './index'
import { devices, farmSettings } from './schema'

/**
 * Migration 0066 (plan 206 §3.7, §4.7): `desired_readiness` defaults to
 * `awake` for every device, old and new. Run through the REAL migrator —
 * migrate up to (but not including) 0066, seed pre-migration-shaped rows,
 * then apply the remainder — rather than by re-executing a copy of the SQL,
 * which would only prove the paste (`cluster-materialise.test.ts`'s own
 * `runMigrationsUpTo` pattern).
 */
const CUT_TAG = '0066_desired_awake'

function seedDevice(db: ReturnType<typeof openDb>['db'], id: string, desiredReadiness: string | null): void {
  db.run(
    sql`INSERT INTO devices (id, stable_id, serial, label, status, desired_readiness) VALUES (${id}, ${`stable-${id}`}, ${`serial-${id}`}, ${`device ${id}`}, 'online', ${desiredReadiness})`,
  )
}

describe('0066 — desired readiness defaults to awake for every device, old and new', () => {
  test('NULL and asleep rows become awake; hot is left alone', () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, CUT_TAG)
    seedDevice(opened.db, 'd-null', null)
    seedDevice(opened.db, 'd-asleep', 'asleep')
    seedDevice(opened.db, 'd-hot', 'hot')

    runMigrations(opened.db)

    expect(opened.db.select().from(devices).where(eq(devices.id, 'd-null')).get()?.desiredReadiness).toBe('awake')
    expect(opened.db.select().from(devices).where(eq(devices.id, 'd-asleep')).get()?.desiredReadiness).toBe('awake')
    expect(opened.db.select().from(devices).where(eq(devices.id, 'd-hot')).get()?.desiredReadiness).toBe('hot')
  })

  test("a device already awake is left untouched (idempotent in effect, not just in re-run)", () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, CUT_TAG)
    seedDevice(opened.db, 'd-awake', 'awake')

    runMigrations(opened.db)

    expect(opened.db.select().from(devices).where(eq(devices.id, 'd-awake')).get()?.desiredReadiness).toBe('awake')
  })

  test("farm_settings' readiness.defaultDesired: 'asleep' is corrected to 'awake', the rest of the blob untouched", () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, CUT_TAG)
    opened.db
      .insert(farmSettings)
      .values({
        id: 1,
        value: { readiness: { defaultDesired: 'asleep', maxHot: 8 }, session: { buildsPerUsbRoot: 4 } },
        updatedAt: new Date(),
      })
      .run()

    runMigrations(opened.db)

    const value = opened.db.select().from(farmSettings).where(eq(farmSettings.id, 1)).get()?.value as {
      readiness: { defaultDesired: string; maxHot: number }
      session: { buildsPerUsbRoot: number }
    }
    expect(value.readiness.defaultDesired).toBe('awake')
    // Surgical: one key, nothing else in a settings blob an operator has tuned.
    expect(value.readiness.maxHot).toBe(8)
    expect(value.session.buildsPerUsbRoot).toBe(4)
  })

  test('a farm_settings row whose defaultDesired is already awake is left alone', () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, CUT_TAG)
    opened.db
      .insert(farmSettings)
      .values({ id: 1, value: { readiness: { defaultDesired: 'awake' } }, updatedAt: new Date() })
      .run()

    runMigrations(opened.db)

    const value = opened.db.select().from(farmSettings).where(eq(farmSettings.id, 1)).get()?.value as { readiness: { defaultDesired: string } }
    expect(value.readiness.defaultDesired).toBe('awake')
  })

  test('no farm_settings row at all survives the migration without error', () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, CUT_TAG)
    expect(() => runMigrations(opened.db)).not.toThrow()
  })

  test('running the remainder twice changes nothing the second time', () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, CUT_TAG)
    seedDevice(opened.db, 'd1', 'asleep')
    runMigrations(opened.db)
    const once = opened.db.select().from(devices).where(eq(devices.id, 'd1')).get()?.desiredReadiness
    expect(() => runMigrations(opened.db)).not.toThrow()
    expect(opened.db.select().from(devices).where(eq(devices.id, 'd1')).get()?.desiredReadiness).toBe(once)
  })
})
