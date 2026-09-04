import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from './index'
import { devices, farmSettings } from './schema'

/**
 * Migration 0071, run through the REAL migrator's own generated SQL, applied a
 * SECOND time against pre-existing rows — the same pattern `awake-migration.test.ts`
 * uses for 0064, and for the same reason: `seeded()` below already runs every
 * migration (including 0071) once, on an EMPTY database, to establish the
 * schema. A row inserted afterwards was never touched by that first pass, so
 * the shipped `.sql` file is re-executed against it here — the exact artifact
 * that reaches a real farm, not a copy of it pasted into this test.
 */
function seeded() {
  const { db, sqlite } = openDb(':memory:')
  runMigrations(db, sqlite)
  return { db, sqlite }
}

function apply0071(sqlite: { exec: (sql: string) => void }) {
  const sql = readFileSync(new URL('../../drizzle/0071_thick_thunderbolt_ross.sql', import.meta.url), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) sqlite.exec(statement)
}

function addDevice(db: ReturnType<typeof seeded>['db'], id: string, inspection: string | null, settings?: unknown) {
  db.insert(devices)
    .values({
      id,
      stableId: `s-${id}`,
      serial: `ser-${id}`,
      label: id,
      status: 'offline',
      ...(inspection === null ? {} : { inspection }),
      ...(settings !== undefined ? { settings } : {}),
    })
    .run()
}

describe('0071 — ui-tree becomes the default inspector engine (plan 222 §4.7)', () => {
  test('every stored ui-server engine becomes ui-tree, in all three places', () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd1', 'ui-server', { engines: { inspection: 'ui-server', transport: 'adb-usb' } })
    db.insert(farmSettings)
      .values({ id: 1, value: { defaults: { engines: { inspection: 'ui-server' } }, readiness: { defaultDesired: 'awake' } }, updatedAt: new Date() })
      .run()

    apply0071(sqlite)

    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()
    expect(row?.inspection).toBe('ui-tree')
    expect((row?.settings as { engines: { inspection: string } }).engines.inspection).toBe('ui-tree')

    const farm = db.select().from(farmSettings).where(eq(farmSettings.id, 1)).get()
    const value = farm?.value as { defaults: { engines: { inspection: string } }; readiness: { defaultDesired: string } }
    expect(value.defaults.engines.inspection).toBe('ui-tree')
    // Surgical: nothing else in the settings blob is touched.
    expect(value.readiness.defaultDesired).toBe('awake')
  })

  test('a device pinned to uiautomator-dump is untouched', () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd2', 'uiautomator-dump', { engines: { inspection: 'uiautomator-dump', transport: 'adb-usb' } })
    apply0071(sqlite)
    const row = db.select().from(devices).where(eq(devices.id, 'd2')).get()
    expect(row?.inspection).toBe('uiautomator-dump')
    expect((row?.settings as { engines: { inspection: string } }).engines.inspection).toBe('uiautomator-dump')
  })

  test('a device pinned to appium is untouched', () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd3', 'appium', { engines: { inspection: 'appium', transport: 'adb-usb' } })
    apply0071(sqlite)
    const row = db.select().from(devices).where(eq(devices.id, 'd3')).get()
    expect(row?.inspection).toBe('appium')
  })

  test('a settings JSON with no engines block is untouched and does not throw', () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd4', 'ui-server', { prep: { keepAwake: 'always' } })
    expect(() => apply0071(sqlite)).not.toThrow()
    const row = db.select().from(devices).where(eq(devices.id, 'd4')).get()
    expect(row?.inspection).toBe('ui-tree')
    expect(row?.settings).toEqual({ prep: { keepAwake: 'always' } })
  })

  test('a null settings column is untouched', () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd5', 'ui-server', null)
    expect(() => apply0071(sqlite)).not.toThrow()
    const row = db.select().from(devices).where(eq(devices.id, 'd5')).get()
    expect(row?.inspection).toBe('ui-tree')
    expect(row?.settings ?? null).toBeNull()
  })
})
