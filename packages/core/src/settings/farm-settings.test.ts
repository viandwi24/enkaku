import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
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
