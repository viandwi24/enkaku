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

/**
 * `resetSections` — the only way a farm that has already run picks up a
 * default CHANGED in a later release.
 *
 * The row is written out in full on first boot, so every key is stored
 * explicitly and a stored value always beats a new schema default. Dropping
 * the key and re-parsing is what hands the section back to the schema.
 */
describe('createFarmSettingsStore — resetSections (owner, 2026-09-06)', () => {
  test('a section an operator changed goes back to the schema default', () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' } })
    expect(store.get().general.name).toBe('Rack B')

    const after = store.resetSections(['general'])
    expect(after.general.name).toBe('Enkaku farm')
    expect(store.get().general.name).toBe('Enkaku farm')
  })

  test('only the named section moves — everything else keeps the operator’s values', () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' }, privacy: { overControl: 'forbid' } })

    store.resetSections(['general'])
    expect(store.get().general.name).toBe('Enkaku farm')
    expect(store.get().privacy.overControl).toBe('forbid')
  })

  test('several sections at once', () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' }, privacy: { overControl: 'forbid' } })

    const after = store.resetSections(['general', 'privacy'])
    expect(after.general.name).toBe('Enkaku farm')
    expect(after.privacy.overControl).toBe('allow')
  })

  test('the write is persisted, not just cached — a second store on the same db reads it back', () => {
    const db = setUpDb()
    const store = createFarmSettingsStore(db)
    store.update({ general: { name: 'Rack B' } })
    store.resetSections(['general'])

    expect(createFarmSettingsStore(db).get().general.name).toBe('Enkaku farm')
  })

  test('onChange listeners are notified, the same as an update', () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' } })
    const seen: string[] = []
    store.onChange((s) => seen.push(s.general.name))

    store.resetSections(['general'])
    expect(seen).toEqual(['Enkaku farm'])
  })

  /**
   * The one that matters most. `privacy.adbCommand` is `true` in the schema
   * and `false` on a server-mode (network-exposed) farm, and that difference
   * is applied outside Zod. A reset that handed back the schema's own `true`
   * would quietly re-enable the Adb command action for every operator on an
   * install that had deliberately been given it off — a settings reset must
   * never widen what a farm exposes.
   */
  test('resetting privacy on a server-mode farm keeps adbCommand off, not the schema’s true', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'server' })
    store.update({ privacy: { adbCommand: true, overControl: 'forbid' } })
    expect(store.get().privacy.adbCommand).toBe(true)

    const after = store.resetSections(['privacy'])
    expect(after.privacy.adbCommand).toBe(false)
    // ...and the rest of the section still resets normally.
    expect(after.privacy.overControl).toBe('allow')
  })

  test('a loopback farm resetting privacy gets the ordinary schema default', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'local' })
    store.update({ privacy: { adbCommand: false } })

    expect(store.resetSections(['privacy']).privacy.adbCommand).toBe(true)
  })

  test('an unknown section is refused, and nothing is written', () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' } })

    expect(() => store.resetSections(['generall'])).toThrow(/not a settings section/)
    expect(store.get().general.name).toBe('Rack B')
  })

  test('one bad name in a list refuses the whole call — never a partial reset', () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' }, privacy: { overControl: 'forbid' } })

    expect(() => store.resetSections(['general', 'nope'])).toThrow(/not a settings section/)
    expect(store.get().general.name).toBe('Rack B')
    expect(store.get().privacy.overControl).toBe('forbid')
  })

  test('an empty list is a caller bug, not a silent no-op', () => {
    const store = createFarmSettingsStore(setUpDb())
    expect(() => store.resetSections([])).toThrow(/at least one/)
  })

  test('resetting a section that is already at its defaults is a harmless no-op', () => {
    const store = createFarmSettingsStore(setUpDb())
    const before = store.get()
    expect(store.resetSections(['general'])).toEqual(before)
  })

  test('the reset never reaches outside farm_settings — the row count is unchanged', () => {
    const db = setUpDb()
    const store = createFarmSettingsStore(db)
    store.update({ general: { name: 'Rack B' } })
    store.resetSections(['general'])

    expect(db.select().from(farmSettings).all()).toHaveLength(1)
    expect(db.select().from(farmSettings).where(eq(farmSettings.id, 1)).get()).toBeDefined()
  })
})
