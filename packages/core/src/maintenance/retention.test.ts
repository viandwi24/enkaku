import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { deviceEvents } from '../db/schema'
import { createFarmSettingsStore } from '../settings/farm-settings'
import { createRetentionGc } from './retention'
import { createLogger } from '../util/logger'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedEvent(db: Db, opts: { deviceId: string; stream: 'main' | 'input'; ageDays: number }) {
  db.insert(deviceEvents)
    .values({
      id: crypto.randomUUID(),
      deviceId: opts.deviceId,
      stream: opts.stream,
      kind: opts.stream === 'main' ? 'device.online' : 'input.tap',
      actor: null,
      meta: {},
      at: new Date(Date.now() - opts.ageDays * 86_400_000),
    })
    .run()
}

function makeGc(db: Db) {
  const settings = createFarmSettingsStore(db)
  return createRetentionGc({
    db,
    dataDir: '/tmp/enkaku-retention-test',
    settings,
    log: createLogger('test').child('retention'),
    intervalMinutes: 60,
  })
}

describe('device event retention (plan 18 §4.4)', () => {
  test('age budget: input rows past eventInputDays are deleted, main rows are not', () => {
    const db = setUp()
    seedEvent(db, { deviceId: 'dev-1', stream: 'input', ageDays: 10 }) // past the 3-day default
    seedEvent(db, { deviceId: 'dev-1', stream: 'input', ageDays: 1 }) // within budget
    seedEvent(db, { deviceId: 'dev-1', stream: 'main', ageDays: 10 }) // within the 30-day default

    const gc = makeGc(db)
    const result = gc.sweepOnce()

    expect(result.eventsDeleted).toBe(1)
    const remaining = db.select().from(deviceEvents).all()
    expect(remaining).toHaveLength(2)
    expect(remaining.filter((r) => r.stream === 'input')).toHaveLength(1)
    expect(remaining.filter((r) => r.stream === 'main')).toHaveLength(1)
  })

  test('row ceiling: a device over its cap is trimmed back under it, oldest first', () => {
    const db = setUp()
    const settings = createFarmSettingsStore(db)
    settings.update({ retention: { eventMaxRowsPerDevice: 1000 } })
    for (let i = 0; i < 1200; i++) {
      seedEvent(db, { deviceId: 'dev-1', stream: 'input', ageDays: i / 1000 }) // all within the age budget
    }

    const gc = createRetentionGc({
      db,
      dataDir: '/tmp/enkaku-retention-test',
      settings,
      log: createLogger('test').child('retention'),
      intervalMinutes: 60,
    })
    const result = gc.sweepOnce()

    expect(result.eventsDeleted).toBe(200)
    expect(db.select().from(deviceEvents).all()).toHaveLength(1000)
  })

  test('a device under its budgets is left untouched, and the sweep says so in one line', () => {
    const db = setUp()
    seedEvent(db, { deviceId: 'dev-1', stream: 'main', ageDays: 1 })
    seedEvent(db, { deviceId: 'dev-1', stream: 'input', ageDays: 1 })

    const gc = makeGc(db)
    const result = gc.sweepOnce()

    expect(result.eventsDeleted).toBe(0)
    expect(db.select().from(deviceEvents).all()).toHaveLength(2)
  })

  test('event retention runs even when the artifact policy is disabled', () => {
    const db = setUp()
    // Default farm settings: retention.enabled === false.
    seedEvent(db, { deviceId: 'dev-1', stream: 'input', ageDays: 10 })

    const gc = makeGc(db)
    const result = gc.sweepOnce()

    expect(result.eventsDeleted).toBe(1)
    expect(result.deleted).toBe(0) // the artifact GC itself stayed off
  })
})
