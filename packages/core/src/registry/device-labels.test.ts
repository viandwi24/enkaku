import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import {
  applyDeviceLabels,
  assertLabelsExist,
  createLabel,
  deleteDeviceLabels,
  deleteLabel,
  labelsForDevice,
  listLabels,
  updateLabel,
} from './device-labels'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string) {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'online' })
    .run()
}

describe('label CRUD', () => {
  test('a label exists with no devices on it — the whole point of retiring free-form tags', () => {
    const db = setUp()
    const label = createLabel(db, { name: 'Smoke Pool' })
    expect(label.deviceCount).toBe(0)
    expect(listLabels(db).map((l) => l.name)).toEqual(['Smoke Pool'])
  })

  test('the name is normalised on write, and the default colour comes from the palette', () => {
    const db = setUp()
    const label = createLabel(db, { name: '  Smoke   Pool ' })
    expect(label.name).toBe('Smoke Pool')
    expect(label.color).toBe('slate')
  })

  test('a duplicate name is refused case-insensitively, naming the label that already exists', () => {
    const db = setUp()
    createLabel(db, { name: 'Smoke Pool' })
    expect(() => createLabel(db, { name: 'smoke pool' })).toThrow(/already exists/)
  })

  test('a rename may keep the label its own name — the clash check exempts itself', () => {
    const db = setUp()
    const label = createLabel(db, { name: 'Smoke Pool', color: 'blue' })
    const renamed = updateLabel(db, label.id, { name: 'Smoke Pool', color: 'red' })
    expect(renamed.color).toBe('red')
    expect(renamed.name).toBe('Smoke Pool')
  })

  test('a colour outside the palette is refused rather than stored', () => {
    const db = setUp()
    const label = createLabel(db, { name: 'Smoke Pool' })
    expect(() => updateLabel(db, label.id, { color: '#ff0000' })).toThrow()
  })

  test('deleting a label leaves its devices standing, exactly as deleting a group does', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const label = createLabel(db, { name: 'Smoke Pool' })
    applyDeviceLabels(db, 'd1', 'add', [label.id])

    const { deviceIds } = deleteLabel(db, label.id)
    expect(deviceIds).toEqual(['d1'])
    expect(db.select().from(devices).all()).toHaveLength(1)
    expect(labelsForDevice(db, 'd1')).toEqual([])
  })

  test('deviceCount is a live read, and a label nobody carries reports 0 rather than going missing', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const carried = createLabel(db, { name: 'Carried' })
    createLabel(db, { name: 'Unused' })
    applyDeviceLabels(db, 'd1', 'add', [carried.id])

    const byName = new Map(listLabels(db).map((l) => [l.name, l.deviceCount]))
    expect(byName.get('Carried')).toBe(1)
    expect(byName.get('Unused')).toBe(0)
  })
})

describe('applyDeviceLabels', () => {
  test('add is a union — it never erases what the device already carries', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const a = createLabel(db, { name: 'Alpha' })
    const b = createLabel(db, { name: 'Bravo' })
    applyDeviceLabels(db, 'd1', 'add', [a.id])

    const { labels, diff } = applyDeviceLabels(db, 'd1', 'add', [b.id])
    expect(labels.map((l) => l.name)).toEqual(['Alpha', 'Bravo'])
    expect(diff).toEqual({ added: ['Bravo'], removed: [] })
  })

  test('adding a label the device already carries is a no-op, not a duplicate row', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const a = createLabel(db, { name: 'Alpha' })
    applyDeviceLabels(db, 'd1', 'add', [a.id])

    const { labels, diff } = applyDeviceLabels(db, 'd1', 'add', [a.id])
    expect(labels).toHaveLength(1)
    expect(diff).toEqual({ added: [], removed: [] })
  })

  test('remove takes only the named labels off', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const a = createLabel(db, { name: 'Alpha' })
    const b = createLabel(db, { name: 'Bravo' })
    applyDeviceLabels(db, 'd1', 'add', [a.id, b.id])

    const { labels, diff } = applyDeviceLabels(db, 'd1', 'remove', [a.id])
    expect(labels.map((l) => l.name)).toEqual(['Bravo'])
    expect(diff).toEqual({ added: [], removed: ['Alpha'] })
  })

  test('replace is the whole set — what the single-device editor sends', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const a = createLabel(db, { name: 'Alpha' })
    const b = createLabel(db, { name: 'Bravo' })
    applyDeviceLabels(db, 'd1', 'add', [a.id])

    const { labels, diff } = applyDeviceLabels(db, 'd1', 'replace', [b.id])
    expect(labels.map((l) => l.name)).toEqual(['Bravo'])
    expect(diff).toEqual({ added: ['Bravo'], removed: ['Alpha'] })
  })

  test('labels come back sorted by name, so a row of chips never reorders itself', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const c = createLabel(db, { name: 'Charlie' })
    const a = createLabel(db, { name: 'Alpha' })
    const b = createLabel(db, { name: 'Bravo' })
    applyDeviceLabels(db, 'd1', 'add', [c.id, a.id, b.id])
    expect(labelsForDevice(db, 'd1').map((l) => l.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  test('one query for a whole list, and a device with none needs no guard', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const a = createLabel(db, { name: 'Alpha' })
    applyDeviceLabels(db, 'd1', 'add', [a.id])
    expect(labelsForDevice(db, 'd2')).toEqual([])
  })
})

describe('assertLabelsExist', () => {
  test('an unknown id is refused before any device is touched', () => {
    const db = setUp()
    const a = createLabel(db, { name: 'Alpha' })
    expect(() => assertLabelsExist(db, [a.id, 'ghost'])).toThrow(/no such label: ghost/)
    expect(() => assertLabelsExist(db, [a.id])).not.toThrow()
  })
})

describe('deleteDeviceLabels', () => {
  test('drops one device’s memberships without touching the labels themselves', () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const a = createLabel(db, { name: 'Alpha' })
    applyDeviceLabels(db, 'd1', 'add', [a.id])

    deleteDeviceLabels(db, 'd1')
    expect(labelsForDevice(db, 'd1')).toEqual([])
    expect(listLabels(db).map((l) => l.name)).toEqual(['Alpha'])
  })
})
