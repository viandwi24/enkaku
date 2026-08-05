import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { blockedDevices, devices, discoveredDevices } from '../db/schema'
import { admitDevice, classify, recordSighting } from './admission'

/**
 * The admission decision (plan 56 §4.2). Every branch the registry can take
 * hangs off `classify`, so its precedence has to be total and tested — an
 * ordering mistake here is the difference between a phone waiting in a tray
 * and a phone being handed to a job.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedMember(db: Db, stableId: string): void {
  db.insert(devices)
    .values({ id: `id-${stableId}`, stableId, serial: `serial-${stableId}`, label: stableId, status: 'idle' })
    .run()
}

function seedBlocked(db: Db, stableId: string): void {
  db.insert(blockedDevices).values({ stableId, label: null, reason: null, blockedAt: new Date(), blockedBy: 'test' }).run()
}

describe('classify (plan 56 §4.2)', () => {
  test('an unknown phone is discovered, not admitted — the whole point of the plan', () => {
    const db = setUpDb()
    expect(classify(db, 'NEVER-SEEN')).toBe('discovered')
  })

  test('a device that already has a row is admitted, which is how pre-plan devices are grandfathered', () => {
    const db = setUpDb()
    seedMember(db, 'OLD-DEVICE')
    expect(classify(db, 'OLD-DEVICE')).toBe('admitted')
  })

  test('blocked beats an existing device row, so a block always takes effect on the next connection', () => {
    const db = setUpDb()
    seedMember(db, 'ZP2222RMBS')
    seedBlocked(db, 'ZP2222RMBS')
    expect(classify(db, 'ZP2222RMBS')).toBe('blocked')
  })

  test('blocked beats a pending discovery too — a blocked phone never reaches the tray', () => {
    const db = setUpDb()
    recordSighting(db, { stableId: 'ZP2222RMBS', serial: 'ZP2222RMBS', label: 'moto g06 power', androidVersion: '15' })
    seedBlocked(db, 'ZP2222RMBS')
    expect(classify(db, 'ZP2222RMBS')).toBe('blocked')
  })

  test('a recorded sighting alone does NOT make a device admitted', () => {
    const db = setUpDb()
    recordSighting(db, { stableId: 'PENDING', serial: 's', label: null, androidVersion: null })
    expect(classify(db, 'PENDING')).toBe('discovered')
  })
})

describe('admitDevice (plan 56 §4.3)', () => {
  test('promotes a sighting into a farm member and clears it from the tray', () => {
    const db = setUpDb()
    recordSighting(db, { stableId: 'PENDING', serial: 'serial-1', label: 'Pixel 7', androidVersion: '14' })

    const row = admitDevice(db, 'PENDING')

    expect(row?.stableId).toBe('PENDING')
    expect(row?.label).toBe('Pixel 7')
    expect(db.select().from(discoveredDevices).all()).toHaveLength(0)
    expect(classify(db, 'PENDING')).toBe('admitted')
  })

  test('an operator-supplied label wins over the probed model', () => {
    const db = setUpDb()
    recordSighting(db, { stableId: 'PENDING', serial: 'serial-1', label: 'Pixel 7', androidVersion: '14' })
    expect(admitDevice(db, 'PENDING', { label: '  Rack 3 slot 2  ' })?.label).toBe('Rack 3 slot 2')
  })

  test('is idempotent — two operators pressing Add at the same moment is not a failure', () => {
    const db = setUpDb()
    recordSighting(db, { stableId: 'PENDING', serial: 'serial-1', label: 'Pixel 7', androidVersion: '14' })

    const first = admitDevice(db, 'PENDING')
    const second = admitDevice(db, 'PENDING')

    expect(second?.id).toBe(first!.id)
    expect(db.select().from(devices).all()).toHaveLength(1)
  })

  test('refuses a blocked device — admission can never overrule a block', () => {
    const db = setUpDb()
    recordSighting(db, { stableId: 'ZP2222RMBS', serial: 's', label: 'moto g06 power', androidVersion: '15' })
    seedBlocked(db, 'ZP2222RMBS')

    expect(admitDevice(db, 'ZP2222RMBS')).toBeNull()
    expect(db.select().from(devices).all()).toHaveLength(0)
  })

  test('admitting something never seen returns null rather than inventing a device', () => {
    const db = setUpDb()
    expect(admitDevice(db, 'NEVER-SEEN')).toBeNull()
    expect(db.select().from(devices).all()).toHaveLength(0)
  })

  test('starts offline, not idle — the row exists but the device has not been seen since', () => {
    // A phone can be admitted long after it was unplugged. Enrolling it as
    // `idle` would advertise it as ready to take a job it cannot receive.
    const db = setUpDb()
    recordSighting(db, { stableId: 'PENDING', serial: 's', label: null, androidVersion: null })
    expect(admitDevice(db, 'PENDING')?.status).toBe('offline')
  })
})

describe('recordSighting (plan 56 §4.2)', () => {
  test('writes no devices row — a sighting is not a farm member', () => {
    const db = setUpDb()
    recordSighting(db, { stableId: 'PENDING', serial: 'serial-1', label: 'Pixel 7', androidVersion: '14' })

    expect(db.select().from(devices).all()).toHaveLength(0)
    const rows = db.select().from(discoveredDevices).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.label).toBe('Pixel 7')
  })

  test('re-sighting keeps firstSeen and moves lastSeen — how long it has waited is the tray’s one useful fact', () => {
    const db = setUpDb()
    const first = new Date(1_700_000_000_000)
    const later = new Date(1_700_000_600_000)

    recordSighting(db, { stableId: 'PENDING', serial: 'serial-1', label: 'Pixel 7', androidVersion: '14' }, first)
    recordSighting(db, { stableId: 'PENDING', serial: 'serial-2', label: 'Pixel 7', androidVersion: '14' }, later)

    const rows = db.select().from(discoveredDevices).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.firstSeen?.getTime()).toBe(first.getTime())
    expect(rows[0]?.lastSeen?.getTime()).toBe(later.getTime())
    // The transport address moved (a different USB port); identity did not.
    expect(rows[0]?.serial).toBe('serial-2')
  })
})
