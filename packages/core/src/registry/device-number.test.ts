import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, sequences } from '../db/schema'
import { admitDevice, recordSighting } from './admission'
import { allocateDeviceNumber, compactDeviceNumbers, loadDeviceNumbers, lookupDeviceNumber, releaseDeviceNumber, setDeviceNumber } from './device-number'

/**
 * The device-number allocator (plan 89 §3.1, §3.2, §4.2, step 89.1).
 *
 * The properties under test are exactly the ones the plan's own design
 * argument rests on: a number is assigned once, on admission (F2); it is
 * a reservation on `stableId` that survives Forget/re-admit (F7, §3.2);
 * concurrent admissions can never collide, because SQLite AUTOINCREMENT is
 * unavailable on a text primary key (F3) and the allocator has to prove its
 * own correctness instead; and a restored backup with a stale or missing
 * watermark cannot hand out a number that is already reserved.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function discover(db: Db, stableId: string, label = stableId): void {
  recordSighting(db, { stableId, serial: `serial-${stableId}`, label, androidVersion: '15' })
}

describe('allocateDeviceNumber (plan 89 §4.2)', () => {
  test('increments from 1 for successive brand-new stableIds', () => {
    const db = setUpDb()
    const a = db.transaction((tx) => allocateDeviceNumber(tx, 'A'))
    const b = db.transaction((tx) => allocateDeviceNumber(tx, 'B'))
    const c = db.transaction((tx) => allocateDeviceNumber(tx, 'C'))
    expect([a.number, b.number, c.number]).toEqual([1, 2, 3])
    expect([a.fresh, b.fresh, c.fresh]).toEqual([true, true, true])
  })

  test('a stableId that already has a reservation gets the SAME number back, and fresh is false', () => {
    const db = setUpDb()
    const first = db.transaction((tx) => allocateDeviceNumber(tx, 'A'))
    const second = db.transaction((tx) => allocateDeviceNumber(tx, 'A'))
    expect(second.number).toBe(first.number)
    expect(second.fresh).toBe(false)
    // And no number was burned for it — the next fresh stableId still gets #2.
    const b = db.transaction((tx) => allocateDeviceNumber(tx, 'B'))
    expect(b.number).toBe(2)
  })

  test('concurrent admission never duplicates a number: N devices admitted through admitDevice all land on distinct, contiguous numbers', () => {
    const db = setUpDb()
    const stableIds = Array.from({ length: 12 }, (_, i) => `DEV-${i}`)
    for (const id of stableIds) discover(db, id)

    // bun:sqlite is synchronous on one connection (plan 89 §0.1 F28), so this
    // loop is the honest way to exercise "many admissions racing for a
    // number" in this runtime — there is no way to truly interleave two
    // writers against one file-backed connection, which is exactly the
    // property the allocator's correctness argument leans on.
    const numbers = stableIds.map((id) => admitDevice(db, id)?.stableId && lookupDeviceNumber(db, id))
    expect(numbers.every((n) => n !== null)).toBe(true)
    const sorted = [...(numbers as number[])].sort((a, b) => a - b)
    expect(sorted).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    // The UNIQUE index is the actual guarantee (§4.2 point 1) — assert there
    // really is no duplicate, not just that the count matches.
    expect(new Set(sorted).size).toBe(12)
  })

  test('forget then re-admit returns the SAME number — the sticky reservation (§3.2, F7)', () => {
    const db = setUpDb()
    discover(db, 'STABLE-1')
    discover(db, 'STABLE-2')
    const first = admitDevice(db, 'STABLE-1')
    admitDevice(db, 'STABLE-2')
    expect(first).not.toBeNull()
    const numberBefore = lookupDeviceNumber(db, 'STABLE-1')
    expect(numberBefore).toBe(1)

    // Forget: delete the devices row and drop it back into discovered_devices
    // — the same shape `lifecycle.ts`'s `forget()` produces, without pulling
    // in the whole lifecycle module's dependencies for this unit test.
    db.delete(devices).where(eq(devices.stableId, 'STABLE-1')).run()
    discover(db, 'STABLE-1', 'moto g06 power') // re-sighted, as it would be on replug

    // The reservation itself must NOT have been touched by the forget.
    expect(lookupDeviceNumber(db, 'STABLE-1')).toBe(numberBefore)

    // Re-admit: admitDevice's insert branch runs again (it's a fresh row),
    // but allocateDeviceNumber must find the existing reservation.
    const readmitted = admitDevice(db, 'STABLE-1')
    expect(readmitted).not.toBeNull()
    expect(lookupDeviceNumber(db, 'STABLE-1')).toBe(numberBefore)

    // And the sequence was never advanced for the re-admit: the next
    // genuinely new device still gets #3, not #4.
    discover(db, 'STABLE-3')
    const third = admitDevice(db, 'STABLE-3')
    expect(third && lookupDeviceNumber(db, 'STABLE-3')).toBe(3)
  })

  test('a missing sequences row is covered by max(number)+1', () => {
    const db = setUpDb()
    db.transaction((tx) => allocateDeviceNumber(tx, 'A'))
    db.transaction((tx) => allocateDeviceNumber(tx, 'B'))
    db.delete(sequences).run()
    const c = db.transaction((tx) => allocateDeviceNumber(tx, 'C'))
    expect(c.number).toBe(3)
  })

  test('a watermark restored ahead of a stale backup cannot re-issue a still-reserved number', () => {
    const db = setUpDb()
    db.transaction((tx) => allocateDeviceNumber(tx, 'A')) // #1
    db.transaction((tx) => allocateDeviceNumber(tx, 'B')) // #2
    // Simulate a backup restored from BEFORE B was ever admitted: the
    // watermark goes backwards, but the reservation for B is still there.
    db.update(sequences).set({ next: 1 }).run()
    const c = db.transaction((tx) => allocateDeviceNumber(tx, 'C'))
    expect(c.number).toBe(3) // not 2 — max(number)+1 defends the stale watermark
  })

  test('the sequence survives a restart: a fresh Db handle on the same file continues where it left off', () => {
    const dir = `${import.meta.dir}/../../../../.tmp-device-number-restart-test`
    const path = `${dir}/test.db`
    Bun.spawnSync(['mkdir', '-p', dir])
    try {
      const first = openDb(path)
      runMigrations(first.db)
      first.db.transaction((tx) => allocateDeviceNumber(tx, 'A'))
      first.db.transaction((tx) => allocateDeviceNumber(tx, 'B'))
      first.sqlite.close()

      const second = openDb(path)
      const c = second.db.transaction((tx) => allocateDeviceNumber(tx, 'C'))
      expect(c.number).toBe(3)
      second.sqlite.close()
    } finally {
      Bun.spawnSync(['rm', '-rf', dir])
    }
  })
})

describe('setDeviceNumber (plan 89 §4.2, §4.3)', () => {
  test('a collision is refused loudly, naming the current holder', () => {
    const db = setUpDb()
    db.transaction((tx) => allocateDeviceNumber(tx, 'A')) // #1
    db.transaction((tx) => allocateDeviceNumber(tx, 'B')) // #2
    expect(() => setDeviceNumber(db, 'B', 1, { userId: 'op' })).toThrow(/already assigned to A/)
    // Refused, not resolved — B still has its original number.
    expect(lookupDeviceNumber(db, 'B')).toBe(2)
  })

  test('setting a device to its own current number is a no-op, not a collision', () => {
    const db = setUpDb()
    db.transaction((tx) => allocateDeviceNumber(tx, 'A'))
    expect(() => setDeviceNumber(db, 'A', 1, { userId: 'op' })).not.toThrow()
  })

  test('a manual override advances the watermark past it', () => {
    const db = setUpDb()
    setDeviceNumber(db, 'A', 100, { userId: 'op' })
    const b = db.transaction((tx) => allocateDeviceNumber(tx, 'B'))
    expect(b.number).toBe(101)
  })

  test('rejects a non-positive or non-integer number', () => {
    const db = setUpDb()
    expect(() => setDeviceNumber(db, 'A', 0, { userId: 'op' })).toThrow()
    expect(() => setDeviceNumber(db, 'A', -3, { userId: 'op' })).toThrow()
    expect(() => setDeviceNumber(db, 'A', 1.5, { userId: 'op' })).toThrow()
  })
})

describe('releaseDeviceNumber (plan 89 §3.2, §4.2)', () => {
  test('an explicit release removes the reservation, and a later re-admit gets a NEW number', () => {
    const db = setUpDb()
    db.transaction((tx) => allocateDeviceNumber(tx, 'A'))
    releaseDeviceNumber(db, 'A', { userId: 'op' })
    expect(lookupDeviceNumber(db, 'A')).toBeNull()

    const fresh = db.transaction((tx) => allocateDeviceNumber(tx, 'A'))
    expect(fresh.fresh).toBe(true)
  })
})

describe('loadDeviceNumbers (plan 89 §4.2)', () => {
  test('returns every reservation in one map', () => {
    const db = setUpDb()
    db.transaction((tx) => allocateDeviceNumber(tx, 'A'))
    db.transaction((tx) => allocateDeviceNumber(tx, 'B'))
    const map = loadDeviceNumbers(db)
    expect(map.get('A')).toBe(1)
    expect(map.get('B')).toBe(2)
    expect(map.size).toBe(2)
  })
})

describe('compactDeviceNumbers (plan 89 §3.2, §4.2)', () => {
  function seedMember(db: Db, stableId: string, label: string): void {
    db.insert(devices)
      .values({ id: `id-${stableId}`, stableId, serial: `serial-${stableId}`, label, status: 'idle' })
      .run()
  }

  test('reassigns 1..n in label ASC, id ASC order and reports every change', () => {
    const db = setUpDb()
    seedMember(db, 'S3', 'Charlie')
    seedMember(db, 'S7', 'Alpha')
    seedMember(db, 'S8', 'Bravo')
    setDeviceNumber(db, 'S3', 3, { userId: null })
    setDeviceNumber(db, 'S7', 7, { userId: null })
    setDeviceNumber(db, 'S8', 8, { userId: null })

    const changes = compactDeviceNumbers(db)
    // label order: Alpha(S7) < Bravo(S8) < Charlie(S3) -> #1, #2, #3.
    // S3/Charlie already happened to sit at #3 (its target position), so it
    // is correctly NOT reported as a change — only S7 and S8 actually moved.
    expect(lookupDeviceNumber(db, 'S7')).toBe(1)
    expect(lookupDeviceNumber(db, 'S8')).toBe(2)
    expect(lookupDeviceNumber(db, 'S3')).toBe(3)
    expect(changes.length).toBe(2)
    expect(changes.find((c) => c.stableId === 'S7')).toEqual({ stableId: 'S7', from: 7, to: 1 })

    // Numbers stay UNIQUE throughout — re-loading confirms no duplicate survived.
    const numbers = [...loadDeviceNumbers(db).values()].sort((a, b) => a - b)
    expect(numbers).toEqual([1, 2, 3])
  })

  test('a device that already sits at its target number is not reported as changed', () => {
    const db = setUpDb()
    seedMember(db, 'S1', 'Alpha')
    setDeviceNumber(db, 'S1', 1, { userId: null })
    const changes = compactDeviceNumbers(db)
    expect(changes).toEqual([])
  })

  test('is idempotent: running it twice in a row produces no further changes', () => {
    const db = setUpDb()
    seedMember(db, 'S3', 'Charlie')
    seedMember(db, 'S7', 'Alpha')
    setDeviceNumber(db, 'S3', 3, { userId: null })
    setDeviceNumber(db, 'S7', 7, { userId: null })
    compactDeviceNumbers(db)
    const second = compactDeviceNumbers(db)
    expect(second).toEqual([])
  })

  test('advances the watermark so a subsequent fresh allocation continues past the compacted count', () => {
    const db = setUpDb()
    seedMember(db, 'S1', 'Alpha')
    seedMember(db, 'S2', 'Bravo')
    setDeviceNumber(db, 'S1', 5, { userId: null })
    setDeviceNumber(db, 'S2', 9, { userId: null })
    compactDeviceNumbers(db) // -> #1, #2
    const fresh = db.transaction((tx) => allocateDeviceNumber(tx, 'S3'))
    expect(fresh.number).toBe(3)
  })

  test('a released device (no prior reservation) is given a fresh number, reported with from: 0', () => {
    const db = setUpDb()
    seedMember(db, 'S1', 'Alpha')
    seedMember(db, 'S2', 'Bravo')
    setDeviceNumber(db, 'S1', 1, { userId: null })
    // S2 has no reservation at all — as if it had been explicitly released.
    const changes = compactDeviceNumbers(db)
    const s2 = changes.find((c) => c.stableId === 'S2')
    expect(s2).toEqual({ stableId: 'S2', from: 0, to: 2 })
    expect(lookupDeviceNumber(db, 'S2')).toBe(2)
  })
})
