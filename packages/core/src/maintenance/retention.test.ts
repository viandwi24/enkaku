import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, runMigrations, type Db } from '../db'
import { deviceEvents, jobEvents } from '../db/schema'
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

/**
 * One trace event plus (unless told otherwise) the frame file it points at.
 * `atMs` is unix MILLISECONDS — the `job_events` carve-out from the seconds
 * convention (plan 128 §3.3) — so this multiplies by 86_400_000 exactly like
 * `seedEvent` above, and the tests below assert that it did.
 */
function seedTraceEvent(
  db: Db,
  dataDir: string,
  opts: { jobId: string; seq: number; ageDays: number; frame?: boolean },
) {
  const atMs = Date.now() - opts.ageDays * 86_400_000
  db.insert(jobEvents)
    .values({
      id: crypto.randomUUID(),
      jobId: opts.jobId,
      seq: opts.seq,
      atMs,
      attempt: 1,
      phase: 'run',
      kind: 'action',
      name: 'tap',
      meta: {},
    })
    .run()
  if (opts.frame !== false) {
    const dir = join(dataDir, 'traces', opts.jobId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${'a'.repeat(64)}.png`), 'png-bytes')
  }
  return atMs
}

function makeGcIn(db: Db, dataDir: string) {
  const settings = createFarmSettingsStore(db)
  const gc = createRetentionGc({
    db,
    dataDir,
    settings,
    log: createLogger('test').child('retention'),
    intervalMinutes: 60,
  })
  return { gc, settings }
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


describe('job trace retention (plan 128 §3.7, §5 step 128.7)', () => {
  test('a trace past traceDays is swept — rows AND directory — and one inside it is untouched', () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-retention-trace-'))
    seedTraceEvent(db, dataDir, { jobId: 'job-old', seq: 1, ageDays: 45 }) // past the 30-day default
    seedTraceEvent(db, dataDir, { jobId: 'job-new', seq: 1, ageDays: 2 })

    const { gc } = makeGcIn(db, dataDir)
    const result = gc.sweepOnce()

    expect(result.tracesDeleted).toBe(1)
    expect(db.select().from(jobEvents).all().map((r) => r.jobId)).toEqual(['job-new'])
    expect(existsSync(join(dataDir, 'traces', 'job-old'))).toBe(false)
    expect(existsSync(join(dataDir, 'traces', 'job-new'))).toBe(true)
  })

  /**
   * `job_events.at_ms` is MILLISECONDS while `deviceEvents.at` is a
   * seconds-backed Drizzle timestamp, so the cutoff arithmetic in
   * `sweepTraces` is the one place in this file where a factor of 1000 can
   * hide. Both directions of that mistake are caught here:
   *
   * - a cutoff of `Date.now() - days * 86_400` (the ms/s multiplier confused)
   *   lands 43 MINUTES ago, so the 1-day-old trace below would be swept;
   * - a cutoff of `Date.now() / 1000 - days * 86_400` (a seconds-epoch cutoff
   *   compared against a milliseconds column) lands ~1.7e9 against values of
   *   ~1.7e12, so NOTHING would ever be swept, including the 31-day-old one.
   *
   * Neither survives both assertions.
   */
  test('the cutoff is milliseconds on both sides — a factor-of-1000 slip fails this', () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-retention-trace-'))
    // Well inside the 30-day window, but far outside a window of 30 * 86_400 ms.
    const freshAtMs = seedTraceEvent(db, dataDir, { jobId: 'job-1d', seq: 1, ageDays: 1 })
    // Just outside it — one day past, not a hundred, so a seconds-epoch cutoff
    // cannot sweep it by accident either.
    seedTraceEvent(db, dataDir, { jobId: 'job-31d', seq: 1, ageDays: 31 })

    // The fixture itself is in milliseconds — otherwise this test proves nothing.
    expect(freshAtMs).toBeGreaterThan(1e12)
    expect(db.select().from(jobEvents).all().every((r) => r.atMs > 1e12)).toBe(true)

    const { gc } = makeGcIn(db, dataDir)
    const result = gc.sweepOnce()

    expect(result.tracesDeleted).toBe(1)
    expect(db.select().from(jobEvents).all().map((r) => r.jobId)).toEqual(['job-1d'])
  })

  test('NOT gated by retention.enabled — the default farm has it off, and the sweep still runs', () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-retention-trace-'))
    seedTraceEvent(db, dataDir, { jobId: 'job-old', seq: 1, ageDays: 45 })

    const { gc } = makeGcIn(db, dataDir)
    const result = gc.sweepOnce()

    expect(result.tracesDeleted).toBe(1)
    expect(result.deleted).toBe(0) // the artifact GC itself stayed off
    expect(db.select().from(jobEvents).all()).toHaveLength(0)
    expect(existsSync(join(dataDir, 'traces', 'job-old'))).toBe(false)
  })

  test('a job whose trace directory is already gone sweeps its rows without throwing', () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-retention-trace-'))
    // A job that never captured a frame (no inspector, or a `none` policy) has
    // no directory at all — the common case, not an edge case.
    seedTraceEvent(db, dataDir, { jobId: 'job-nodir', seq: 1, ageDays: 45, frame: false })
    expect(existsSync(join(dataDir, 'traces', 'job-nodir'))).toBe(false)

    const { gc } = makeGcIn(db, dataDir)
    const result = gc.sweepOnce()

    expect(result.tracesDeleted).toBe(1)
    expect(db.select().from(jobEvents).all()).toHaveLength(0)
  })

  test('a trace is swept whole or not at all — the age of a trace is its LAST event', () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-retention-trace-'))
    // One job straddling the cutoff. Deleting only the old row would leave a
    // torn timeline whose surviving half points at a directory this sweep had
    // just removed.
    seedTraceEvent(db, dataDir, { jobId: 'job-long', seq: 1, ageDays: 45 })
    seedTraceEvent(db, dataDir, { jobId: 'job-long', seq: 2, ageDays: 2 })

    const { gc } = makeGcIn(db, dataDir)
    const result = gc.sweepOnce()

    expect(result.tracesDeleted).toBe(0)
    expect(db.select().from(jobEvents).all()).toHaveLength(2)
    expect(existsSync(join(dataDir, 'traces', 'job-long'))).toBe(true)
  })

  test('the window is configurable via retention.traceDays', () => {
    const db = setUp()
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-retention-trace-'))
    const { gc, settings } = makeGcIn(db, dataDir)
    settings.update({ retention: { traceDays: 5 } })
    seedTraceEvent(db, dataDir, { jobId: 'job-6d', seq: 1, ageDays: 6 }) // now past a 5-day window

    const result = gc.sweepOnce()

    expect(result.tracesDeleted).toBe(1)
    expect(existsSync(join(dataDir, 'traces', 'job-6d'))).toBe(false)
  })
})
