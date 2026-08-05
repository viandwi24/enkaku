import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations } from '../db'
import { devices } from '../db/schema'
import { createDbDeviceSource } from './adapters'

/**
 * Plan 58 §5.2 — the read seam: `DeviceSnapshot.identity` must be projected
 * from `devices.settings.identity` at the same seam every other settings
 * field (`keepAwake`, `standbyScreenOff`) is read, so it cannot go the way
 * `timing` once did (saved, never read).
 */
describe('createDbDeviceSource — identity projection (plan 58 §4.2, §5.2)', () => {
  test('a device with identity settings carries them onto the snapshot', () => {
    const { db } = openDb(':memory:')
    runMigrations(db)
    db.insert(devices)
      .values({
        id: 'dev-1',
        stableId: 'stable-dev-1',
        serial: 'serial-dev-1',
        label: 'Test Phone',
        status: 'idle',
        settings: {
          identity: {
            timezone: 'America/New_York',
            locale: 'en-US',
            gps: { lat: 40.7128, lng: -74.006, accuracy: 50 },
          },
        },
      })
      .run()

    const source = createDbDeviceSource(db)
    const snapshot = source.get('dev-1')

    expect(snapshot).not.toBeNull()
    expect(snapshot?.identity).toEqual({
      timezone: 'America/New_York',
      locale: 'en-US',
      gps: { lat: 40.7128, lng: -74.006, accuracy: 50 },
    })
  })

  test('a device with no settings at all still gets a well-formed (empty) identity, never undefined or a throw', () => {
    const { db } = openDb(':memory:')
    runMigrations(db)
    db.insert(devices)
      .values({
        id: 'dev-2',
        stableId: 'stable-dev-2',
        serial: 'serial-dev-2',
        label: 'Bare Phone',
        status: 'idle',
      })
      .run()

    const source = createDbDeviceSource(db)
    const snapshot = source.get('dev-2')

    expect(snapshot).not.toBeNull()
    expect(snapshot?.identity).toEqual({})
  })

  test('a legacy row whose settings blob has no identity block still yields the default (empty) identity, never a throw', () => {
    const { db } = openDb(':memory:')
    runMigrations(db)
    db.insert(devices)
      .values({
        id: 'dev-3',
        stableId: 'stable-dev-3',
        serial: 'serial-dev-3',
        label: 'Legacy Phone',
        status: 'idle',
        // A settings blob written before this plan — no `identity` key at all.
        settings: { autoReconnect: true },
      })
      .run()

    const source = createDbDeviceSource(db)
    const snapshot = source.get('dev-3')

    expect(snapshot).not.toBeNull()
    expect(snapshot?.identity).toEqual({})
  })
})
