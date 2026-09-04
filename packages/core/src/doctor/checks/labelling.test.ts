import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { DEVICE_LABEL_SURFACE } from '../../config/constants'
import { defaultDeviceSettings } from '@enkaku/protocol'
import { openDb, runMigrations } from '../../db'
import { deviceNumbers, devices } from '../../db/schema'
import { fakeDoctorContext } from '../test-helpers'
import { labellingCheck } from './labelling'

function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'enkaku-doctor-labelling-'))
}

describe('labelling doctor check (plan 89 §4.7, §5 step 89.4/89.9)', () => {
  test('skips when there is no local database yet', async () => {
    const result = await labellingCheck.run(fakeDoctorContext({ dataDir: '/does/not/exist' }))
    expect(result.status).toBe('skip')
  })

  test('skips when no device has labelling enabled — never a false ok', async () => {
    const dataDir = makeDataDir()
    try {
      const { db, sqlite } = openDb(join(dataDir, 'enkaku.db'))
      runMigrations(db, sqlite)
      db.insert(devices)
        .values({ id: 'd1', stableId: 's1', serial: 'ser1', label: 'Pixel 5', status: 'online', settings: defaultDeviceSettings() })
        .run()
      sqlite.close()

      const result = await labellingCheck.run(fakeDoctorContext({ dataDir }))
      expect(result.status).toBe('skip')
      expect(result.observed).toContain('no device')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('ok, no remedy, when every enabled device reads applied', async () => {
    const dataDir = makeDataDir()
    try {
      const { db, sqlite } = openDb(join(dataDir, 'enkaku.db'))
      runMigrations(db, sqlite)
      const settings = { ...defaultDeviceSettings(), overrides: { ...defaultDeviceSettings().overrides, deviceLabel: 'number-and-name' as const } }
      db.insert(devices)
        .values({
          id: 'd1',
          stableId: 's1',
          serial: 'ser1',
          label: 'Pixel 5',
          status: 'online',
          settings,
          labelState: { mode: DEVICE_LABEL_SURFACE, state: 'applied', reason: null, fingerprint: 'fp', appliedAt: 1, originalCaptured: true, capturedLockScreen: null },
        })
        .run()
      db.insert(deviceNumbers).values({ stableId: 's1', number: 7, assignedAt: new Date(), assignedBy: null }).run()
      sqlite.close()

      const result = await labellingCheck.run(fakeDoctorContext({ dataDir }))
      expect(result.status).toBe('ok')
      expect(result.remedy).toBeUndefined()
      expect(result.observed).toContain('1 of 1 labelled')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('warn, with a remedy naming the affected device, when one reads unavailable — never flattened to ok', async () => {
    const dataDir = makeDataDir()
    try {
      const { db, sqlite } = openDb(join(dataDir, 'enkaku.db'))
      runMigrations(db, sqlite)
      const settings = { ...defaultDeviceSettings(), overrides: { ...defaultDeviceSettings().overrides, deviceLabel: 'number-and-name' as const } }
      db.insert(devices)
        .values({
          id: 'd1',
          stableId: 's1',
          serial: 'ser1',
          label: 'Pixel 5',
          status: 'online',
          settings,
          labelState: {
            mode: 'wallpaper',
            state: 'unavailable',
            reason: 'no guest agent',
            fingerprint: null,
            appliedAt: null,
            originalCaptured: false,
            capturedLockScreen: null,
          },
        })
        .run()
      db.insert(deviceNumbers).values({ stableId: 's1', number: 14, assignedAt: new Date(), assignedBy: null }).run()
      sqlite.close()

      const result = await labellingCheck.run(fakeDoctorContext({ dataDir }))
      expect(result.status).toBe('warn')
      expect(result.observed).toContain('0 of 1 labelled')
      expect(result.observed).toContain('unavailable')
      expect(result.observed).toContain('#14 Pixel 5')
      expect(result.remedy).toBeDefined()
      expect(result.remedy).toContain('#14 Pixel 5')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a device with no number reads by its bare label — a missing number is a real state, never an error', async () => {
    const dataDir = makeDataDir()
    try {
      const { db, sqlite } = openDb(join(dataDir, 'enkaku.db'))
      runMigrations(db, sqlite)
      const settings = { ...defaultDeviceSettings(), overrides: { ...defaultDeviceSettings().overrides, deviceLabel: 'number-and-name' as const } }
      db.insert(devices)
        .values({
          id: 'd1',
          stableId: 's1',
          serial: 'ser1',
          label: 'Pixel 5',
          status: 'online',
          settings,
          labelState: {
            mode: DEVICE_LABEL_SURFACE,
            state: 'unavailable',
            reason: 'read-back mismatch',
            fingerprint: null,
            appliedAt: null,
            originalCaptured: true,
            capturedLockScreen: null,
          },
        })
        .run()
      // No `device_numbers` row for 's1' — an explicit release.
      sqlite.close()

      const result = await labellingCheck.run(fakeDoctorContext({ dataDir }))
      expect(result.status).toBe('warn')
      expect(result.observed).toContain('Pixel 5')
      expect(result.observed).not.toContain('#Pixel 5')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
