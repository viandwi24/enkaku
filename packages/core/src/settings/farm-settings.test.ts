import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { farmSettings } from '../db/schema'
import { createFarmSettingsStore } from './farm-settings'

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/**
 * The server-mode `shell.mode: 'off'` default (plan 26 §3.2, §4.1, §5 step
 * 26.1, acceptance #4) — applied here at config load, since the Zod schema
 * for `FarmSettingsSchema.shell` has no way to see the bind address the
 * auth mode is derived from.
 */
describe('createFarmSettingsStore — plan 26 shell.mode default (§3.2, §4.1)', () => {
  test('no authMode opinion (undefined) → the ordinary Zod default, "admin"', () => {
    const store = createFarmSettingsStore(setUpDb())
    expect(store.get().shell.mode).toBe('admin')
  })

  test('authMode "local" → still "admin" (the loopback default is unaffected)', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'local' })
    expect(store.get().shell.mode).toBe('admin')
  })

  test('authMode "server" on a BRAND NEW farm → shell.mode defaults to "off"', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'server' })
    expect(store.get().shell.mode).toBe('off')
  })

  test('the server-mode override touches ONLY shell.mode — every other shell field keeps its ordinary default', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'server' })
    expect(store.get().shell.execTimeoutMs).toBe(15_000)
    expect(store.get().shell.maxOutputBytes).toBe(262_144)
  })

  test('an EXISTING row is never rewritten by the server-mode default — an operator who already chose "operator" keeps it', () => {
    const db = setUpDb()
    // First boot in local mode: the row is created with the ordinary "admin" default.
    createFarmSettingsStore(db, { authMode: 'local' })
    const first = createFarmSettingsStore(db, { authMode: 'local' })
    first.update({ shell: { mode: 'operator' } })

    // The farm is later rebound to a non-loopback address (server mode) —
    // the existing row, and the operator's explicit choice, must survive.
    const second = createFarmSettingsStore(db, { authMode: 'server' })
    expect(second.get().shell.mode).toBe('operator')
  })
})

/**
 * The server-mode `shell.fanoutEnabled: false` default (plan 93 §3.8, §4.1)
 * — the SAME override as `shell.mode` above, applied alongside it: fleet-
 * wide command fan-out defaulting off on a network-exposed farm is the same
 * instinct as the terminal defaulting off there, and inverting it for
 * convenience would be exactly the mistake that instinct exists to prevent.
 */
describe('createFarmSettingsStore — plan 93 shell.fanoutEnabled default (§3.8, §4.1)', () => {
  test('no authMode opinion (undefined) → the ordinary Zod default, true', () => {
    const store = createFarmSettingsStore(setUpDb())
    expect(store.get().shell.fanoutEnabled).toBe(true)
  })

  test('authMode "local" (a loopback install) → true — a laptop farm gets the feature', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'local' })
    expect(store.get().shell.fanoutEnabled).toBe(true)
  })

  test('authMode "server" on a BRAND NEW farm → fanoutEnabled defaults to false, alongside shell.mode', () => {
    const store = createFarmSettingsStore(setUpDb(), { authMode: 'server' })
    expect(store.get().shell.fanoutEnabled).toBe(false)
    expect(store.get().shell.mode).toBe('off')
  })

  test('an EXISTING row is never rewritten by the server-mode default — an operator who already turned fan-out back on keeps it', () => {
    const db = setUpDb()
    createFarmSettingsStore(db, { authMode: 'local' })
    const first = createFarmSettingsStore(db, { authMode: 'local' })
    first.update({ shell: { fanoutEnabled: false } })

    const second = createFarmSettingsStore(db, { authMode: 'server' })
    expect(second.get().shell.fanoutEnabled).toBe(false)
  })
})

/**
 * `defaults.identity` no longer exists on `FarmSettingsSchema` (docs/settings-audit.md
 * #1, `docs/plans/96-m61-hotfixes.md`) — a farm-wide default GPS/timezone/
 * locale used to be stamped onto every device admitted while it was set
 * (`registry/admission.ts`'s `defaultsForNewDevice`). A farm that upgraded
 * from before this change may still have a raw JSON blob on disk whose
 * `defaults` carries an `identity` key. Config precedence (CLAUDE.md, 00-overview.md
 * §7) is explicit: an invalid config fails the boot with `E_BAD_CONFIG` and
 * must never silently fall back — this proves that stored key is handled
 * deliberately (stripped by Zod's own default "strip" mode) rather than
 * tripping `createFarmSettingsStore`'s `safeParse` failure branch, which
 * would silently replace the WHOLE row with `defaultFarmSettings()`.
 */
describe('createFarmSettingsStore — a legacy stored defaults.identity key (docs/settings-audit.md #1)', () => {
  test('a pre-upgrade row whose defaults still carries identity boots cleanly, keeping every OTHER field of that row intact — not a fallback to unrelated defaults', () => {
    const db = setUpDb()
    const legacyValue = {
      defaults: {
        engines: { transport: 'adb-tcp', display: 'screencap-loop', input: 'adb-input', inspection: 'uiautomator-dump' },
        autoReconnect: false,
        // The legacy key this test exists for — a farm-wide identity block,
        // as it would have been stored before this change removed the field.
        identity: { timezone: 'Asia/Jakarta', locale: 'id-ID', gps: { lat: -6.2, lng: 106.8, accuracy: 50 } },
      },
      // A distinctive, non-default value elsewhere in the row, proving the
      // whole row was NOT thrown away and replaced by defaultFarmSettings().
      battery: { pollIntervalSec: 77, autoQuarantine: false, tempThresholdC: 41 },
    }
    db.insert(farmSettings).values({ id: 1, value: legacyValue, updatedAt: new Date() }).run()

    const store = createFarmSettingsStore(db)

    // The legacy row's OWN distinctive values survived — this is a real
    // parse of the stored row, not a silent fallback to schema defaults.
    expect(store.get().battery.pollIntervalSec).toBe(77)
    expect(store.get().defaults.autoReconnect).toBe(false)
    expect(store.get().defaults.engines.transport).toBe('adb-tcp')

    // The unknown `identity` key under `defaults` was stripped, never
    // carried through, and never caused a boot failure.
    expect(store.get().defaults).not.toHaveProperty('identity')
  })
})
