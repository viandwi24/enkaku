import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { farmSettings } from '../db/schema'
import { createFarmSettingsStore } from './farm-settings'

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/**
 * The server-mode `privacy.adbCommand: false` default (plan 26 §3.2, §4.1,
 * §5 step 26.1, acceptance #4; plan 212 §4.1 F44 turned the farm setting
 * into a boolean) — applied here at config load, since the Zod schema for
 * `FarmSettingsSchema.privacy` has no way to see the bind address the auth
 * mode is derived from.
 */
describe('createFarmSettingsStore — plan 26 privacy.adbCommand default (§3.2, §4.1; plan 212 §4.1 F44)', () => {
  test('no authMode opinion (undefined) → the ordinary Zod default, true', () => {
    const store = createFarmSettingsStore(setUpDb())
    expect(store.get().privacy.adbCommand).toBe(true)
  })

  test('authMode "local" → still true (the loopback default is unaffected)', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'local' })
    expect(store.get().privacy.adbCommand).toBe(true)
  })

  test('authMode "server" on a BRAND NEW farm → privacy.adbCommand defaults to false', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'server' })
    expect(store.get().privacy.adbCommand).toBe(false)
  })

  test('the server-mode override touches ONLY privacy.adbCommand — overControl keeps its ordinary default', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'server' })
    expect(store.get().privacy.overControl).toBe('allow')
  })

  test('an EXISTING row is never rewritten by the server-mode default — an operator who already turned it on keeps it', () => {
    const db = setUpDb()
    // First boot in local mode: the row is created with the ordinary "true" default.
    createFarmSettingsStore(db, { authMode: 'local' })
    const first = createFarmSettingsStore(db, { authMode: 'local' })
    first.update({ privacy: { adbCommand: true, overControl: 'allow' } })

    // The farm is later rebound to a non-loopback address (server mode) —
    // the existing row, and the operator's explicit choice, must survive.
    const second = createFarmSettingsStore(db, { authMode: 'server' })
    expect(second.get().privacy.adbCommand).toBe(true)
  })
})

/**
 * `createFarmSettingsStore` migrates a legacy (pre-212) stored row through
 * `migrateFarmSettings` before ever parsing it against the current schema
 * (plan 212 §4.8; the transform itself is covered exhaustively by
 * `migrate-settings.test.ts`'s six cases). This proves the store WIRES that
 * migration in, and writes the migrated value back once rather than
 * re-migrating on every boot.
 */
describe('createFarmSettingsStore — legacy row migration (plan 212 §4.8)', () => {
  test('a pre-212 row boots cleanly onto the new nine-key shape, keeping its own distinctive values', () => {
    const db = setUpDb()
    const legacyValue = {
      defaults: {
        engines: { transport: 'adb-tcp', display: 'screencap-loop', input: 'adb-input', inspection: 'uiautomator-dump' },
        autoReconnect: false,
      },
      battery: { pollIntervalSec: 77, autoQuarantine: false, tempThresholdC: 41 },
    }
    db.insert(farmSettings).values({ id: 1, value: legacyValue, updatedAt: new Date() }).run()

    const store = createFarmSettingsStore(db)

    // The legacy row's own distinctive value survived through the migration
    // (devices.tempThresholdC replaces battery.tempThresholdC) — this is a
    // real migration of the stored row, not a silent fallback to defaults.
    expect(store.get().devices.tempThresholdC).toBe(41)
    expect(store.get()).not.toHaveProperty('defaults')
    expect(store.get()).not.toHaveProperty('battery')
  })

  test('the migrated row is written back once — a second store built on the same db does not re-migrate', () => {
    const db = setUpDb()
    db.insert(farmSettings)
      .values({ id: 1, value: { battery: { tempThresholdC: 41 } }, updatedAt: new Date() })
      .run()

    createFarmSettingsStore(db)
    const row = db.select().from(farmSettings).where(eq(farmSettings.id, 1)).get()
    expect(row).toBeTruthy()
    expect((row!.value as Record<string, unknown>).general).toBeTruthy()

    const second = createFarmSettingsStore(db)
    expect(second.get().devices.tempThresholdC).toBe(41)
  })
})
