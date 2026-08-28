import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations } from './index'
import { devices, farmSettings } from './schema'
import { eq } from 'drizzle-orm'

/**
 * Migration 0064, run through the REAL migrator rather than by re-executing a
 * copy of its SQL — a test that pastes the statement it is checking proves only
 * that the paste works.
 *
 * ## The defect
 *
 * Reported from the owner's farm, 2026-08-28: "device sering blank, harus
 * di-trigger dulu."
 *
 * `prep.keepAwake: 'while-charging'` maps to `svc power stayon usb`
 * (`session/power.ts`'s `STAYON`), and this repo already documents that `usb`
 * holds the screen ONLY while charging over USB — nothing at all for a device
 * reached over `adb-tcp` or an OTG hub. Plan 125 §3.3 moved the DEFAULT to
 * `'always'` for exactly that reason, and `settings.ts` states just as plainly
 * why that helped nobody who already had a farm: every device row stores a
 * fully materialised `DeviceSettings`, so an existing device re-reads its own
 * literal `'while-charging'` forever and never sees the new default.
 *
 * So `ensureAwake` wrote a no-op on every reconnect, and then wrote the phone's
 * own `screen_off_timeout` — thirty minutes. Half an hour later the screen went
 * dark, and nothing woke it: readiness has a deliberate no-timer rule, so the
 * next wake needs a status transition that may never come. The phones are
 * sealed in a box with no hand to reach them (plan 125 §0.2).
 */
function seeded() {
  const { db, sqlite } = openDb(':memory:')
  runMigrations(db, sqlite)
  return { db, sqlite }
}

/**
 * Apply 0064 to rows that already exist.
 *
 * `runMigrations` cannot be used twice for this: drizzle records 0064 as
 * applied on the first call, so a row inserted afterwards is never seen. And
 * seeding BEFORE the tables exist is impossible. So the shipped `.sql` file is
 * read from disk and executed — the exact artifact that reaches a real farm,
 * not a copy of it pasted into this test, which would only prove the paste.
 */
function apply0064(sqlite: { exec: (sql: string) => void }) {
  const sql = readFileSync(new URL('../../drizzle/0064_awake_on_connect.sql', import.meta.url), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) sqlite.exec(statement)
}

const prepOf = (settings: unknown) => (settings as { prep?: { keepAwake?: string } } | null)?.prep?.keepAwake

function addDevice(db: ReturnType<typeof seeded>['db'], id: string, keepAwake: string | null) {
  db.insert(devices)
    .values({
      id,
      stableId: `s-${id}`,
      serial: `ser-${id}`,
      label: id,
      status: 'idle',
      ...(keepAwake === null ? {} : { settings: { prep: { keepAwake, screenOffTimeoutMs: 1_800_000 }, engines: { transport: 'adb-usb' } } }),
    })
    .run()
}

describe('0064 — a device that cannot hold its screen is corrected', () => {
  test("'while-charging' becomes 'always' on an existing device", () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd1', 'while-charging')
    apply0064(sqlite)
    expect(prepOf(db.select().from(devices).where(eq(devices.id, 'd1')).get()?.settings)).toBe('always')
  })

  /**
   * The line between "correct a value that could never work" and "reset an
   * operator's policy". Only the first is this migration's business — and the
   * owner's farm has a real reason to keep the switch: it already hit a
   * temperature quarantine at 45 °C, and turning a phone's screen off is the
   * only remedy for that.
   */
  test("a device deliberately set to 'off' is left alone", () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd2', 'off')
    apply0064(sqlite)
    expect(prepOf(db.select().from(devices).where(eq(devices.id, 'd2')).get()?.settings)).toBe('off')
  })

  test("a device already on 'always' is unchanged", () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd3', 'always')
    apply0064(sqlite)
    expect(prepOf(db.select().from(devices).where(eq(devices.id, 'd3')).get()?.settings)).toBe('always')
  })

  test('a device with no settings at all survives the migration', () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd4', null)
    apply0064(sqlite)
    expect(db.select().from(devices).where(eq(devices.id, 'd4')).get()?.settings ?? null).toBeNull()
  })

  /**
   * The half that would have made the whole fix look successful and then break
   * every phone enrolled the next day.
   *
   * `farm_settings` holds `defaults.prep`, which is what a newly admitted
   * device is materialised from. Repairing only `devices.settings` fixes
   * today's phones and hands tomorrow's the same broken value — a worse bug
   * than the original, because it looks fixed.
   */
  test("the farm's own default is corrected too, so a device enrolled tomorrow is not born broken", () => {
    const { db, sqlite } = seeded()
    db.insert(farmSettings)
      .values({ id: 1, value: { defaults: { prep: { keepAwake: 'while-charging', screenOffTimeoutMs: 1_800_000 } }, readiness: { defaultDesired: 'awake' } }, updatedAt: new Date() })
      .run()
    apply0064(sqlite)

    const value = db.select().from(farmSettings).where(eq(farmSettings.id, 1)).get()?.value as {
      defaults: { prep: { keepAwake: string; screenOffTimeoutMs: number } }
      readiness: { defaultDesired: string }
    }
    expect(value.defaults.prep.keepAwake).toBe('always')
    // Surgical: one key, nothing else in a settings blob an operator has tuned.
    expect(value.defaults.prep.screenOffTimeoutMs).toBe(1_800_000)
    expect(value.readiness.defaultDesired).toBe('awake')
  })

  test('running it twice changes nothing the second time', () => {
    const { db, sqlite } = seeded()
    addDevice(db, 'd5', 'while-charging')
    apply0064(sqlite)
    const once = db.select().from(devices).where(eq(devices.id, 'd5')).get()?.settings
    apply0064(sqlite)
    expect(db.select().from(devices).where(eq(devices.id, 'd5')).get()?.settings).toEqual(once as never)
  })
})
