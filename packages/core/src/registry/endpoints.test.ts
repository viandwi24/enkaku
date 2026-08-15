import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { deviceEndpoints } from '../db/schema'
import { createEndpointStore, type EndpointStore } from './endpoints'

/**
 * The address book (plan 88 §3.2, §4.3) — the fix for F10: adb has no memory
 * of a TCP device's address once it disconnects, and until this table,
 * neither did this repo.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function setUpStore(db: Db, cfg?: { endpointsPerDevice?: number; endpointRetireAfter?: number }): EndpointStore {
  return createEndpointStore({
    db,
    settings: () => ({ endpointsPerDevice: cfg?.endpointsPerDevice ?? 4, endpointRetireAfter: cfg?.endpointRetireAfter ?? 10 }),
  })
}

describe('EndpointStore.observe (plan 88 §3.2)', () => {
  test('a host:port serial is remembered, source "observed", zero extra bookkeeping needed by the caller', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.observe('STABLE-1', '10.20.0.37:5555')
    const [candidate] = store.candidates('STABLE-1')
    expect(candidate).toBeTruthy()
    expect(candidate!.address).toBe('10.20.0.37:5555')
    expect(candidate!.source).toBe('observed')
    expect(candidate!.consecutiveFailures).toBe(0)
    expect(candidate!.lastConnectedAt).not.toBeNull()
  })

  test('a USB serial (no colon) is silently ignored — nothing for the address book to remember', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.observe('STABLE-1', 'ZP2222RMBS')
    expect(store.candidates('STABLE-1')).toEqual([])
  })

  test('observing the same address again refreshes lastConnectedAt and resets consecutiveFailures', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.observe('STABLE-1', '10.20.0.37:5555')
    store.noteAttempt('STABLE-1', '10.20.0.37:5555', 'failed')
    store.noteAttempt('STABLE-1', '10.20.0.37:5555', 'failed')
    expect(store.candidates('STABLE-1')[0]!.consecutiveFailures).toBe(2)
    store.observe('STABLE-1', '10.20.0.37:5555')
    expect(store.candidates('STABLE-1')[0]!.consecutiveFailures).toBe(0)
  })

  test('observe never downgrades a declared address back to "observed" — a human said so and that sticks', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.declare('STABLE-1', '10.20.0.37:5555', 'wired')
    store.observe('STABLE-1', '10.20.0.37:5555')
    const [candidate] = store.candidates('STABLE-1')
    expect(candidate!.source).toBe('declared')
    expect(candidate!.medium).toBe('wired')
  })
})

describe('EndpointStore.declare (plan 88 §3.1, §3.2)', () => {
  test('a declared address is remembered with no connection yet — lastConnectedAt stays null', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.declare('STABLE-1', '10.20.0.40:5555', 'wired')
    const [candidate] = store.candidates('STABLE-1')
    expect(candidate!.source).toBe('declared')
    expect(candidate!.medium).toBe('wired')
    expect(candidate!.lastConnectedAt).toBeNull()
  })
})

describe('EndpointStore.candidates ordering (plan 88 §3.3, §4.3)', () => {
  test('ordered lastConnectedAt DESC, consecutiveFailures ASC', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    // Insert in an order that would be wrong if candidates() did not sort.
    store.observe('STABLE-1', '10.0.0.1:5555')
    store.observe('STABLE-1', '10.0.0.2:5555')
    store.observe('STABLE-1', '10.0.0.3:5555')
    // .3 is the newest observe (highest lastConnectedAt); tie-break within
    // the same call order is not guaranteed by wall-clock alone, so drive
    // the order explicitly through noteAttempt/observe sequencing instead.
    store.noteAttempt('STABLE-1', '10.0.0.1:5555', 'failed')
    const addresses = store.candidates('STABLE-1').map((c) => c.address)
    // .1 now has a failure and is no longer the most-recently-connected —
    // .2 and .3 (zero failures, more recently connected) must sort ahead of it.
    expect(addresses.indexOf('10.0.0.1:5555')).toBeGreaterThan(addresses.indexOf('10.0.0.2:5555'))
    expect(addresses.indexOf('10.0.0.1:5555')).toBeGreaterThan(addresses.indexOf('10.0.0.3:5555'))
  })

  test('a retired address (consecutiveFailures >= endpointRetireAfter) is excluded by default', () => {
    const db = setUpDb()
    const store = setUpStore(db, { endpointRetireAfter: 2 })
    store.observe('STABLE-1', '10.0.0.1:5555')
    store.noteAttempt('STABLE-1', '10.0.0.1:5555', 'failed')
    store.noteAttempt('STABLE-1', '10.0.0.1:5555', 'failed')
    expect(store.candidates('STABLE-1')).toEqual([])
  })

  test('includeRetired appends retired addresses after every active one, in the same order otherwise', () => {
    const db = setUpDb()
    const store = setUpStore(db, { endpointRetireAfter: 2 })
    store.observe('STABLE-1', '10.0.0.1:5555') // will be retired
    store.noteAttempt('STABLE-1', '10.0.0.1:5555', 'failed')
    store.noteAttempt('STABLE-1', '10.0.0.1:5555', 'failed')
    store.observe('STABLE-1', '10.0.0.2:5555') // stays active
    const withRetired = store.candidates('STABLE-1', { includeRetired: true })
    expect(withRetired.map((c) => c.address)).toEqual(['10.0.0.2:5555', '10.0.0.1:5555'])
  })
})

describe('EndpointStore.noteAttempt (plan 88 §3.3, §4.3)', () => {
  test('"connected" zeroes consecutiveFailures and clears any prior conflict', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.observe('STABLE-1', '10.0.0.1:5555')
    store.noteAttempt('STABLE-1', '10.0.0.1:5555', 'conflict', 'SOME-OTHER-PHONE')
    expect(store.candidates('STABLE-1')[0]!.conflictStableId).toBe('SOME-OTHER-PHONE')
    store.noteAttempt('STABLE-1', '10.0.0.1:5555', 'connected')
    const [candidate] = store.candidates('STABLE-1')
    expect(candidate!.consecutiveFailures).toBe(0)
    expect(candidate!.conflictStableId).toBeNull()
  })

  test('"conflict" records which OTHER stableId answered, without adopting it (plan 88 §3.3 step 3, F14)', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.observe('STABLE-1', '10.0.0.1:5555')
    store.noteAttempt('STABLE-1', '10.0.0.1:5555', 'conflict', 'SOME-OTHER-PHONE')
    const [candidate] = store.candidates('STABLE-1')
    expect(candidate!.conflictStableId).toBe('SOME-OTHER-PHONE')
    expect(candidate!.consecutiveFailures).toBe(1)
  })

  test('an address noteAttempt has never seen (never returned by candidates()) is a silent no-op', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    expect(() => store.noteAttempt('STABLE-1', '10.0.0.9:5555', 'failed')).not.toThrow()
    expect(store.candidates('STABLE-1')).toEqual([])
  })
})

describe('EndpointStore eviction (plan 88 §3.2, §4.3 — the bound)', () => {
  test('observing past endpointsPerDevice evicts the effectively-oldest, keeping the cap', () => {
    const db = setUpDb()
    const store = setUpStore(db, { endpointsPerDevice: 2 })
    store.observe('STABLE-1', '10.0.0.1:5555')
    store.observe('STABLE-1', '10.0.0.2:5555')
    store.observe('STABLE-1', '10.0.0.3:5555')
    const addresses = store.candidates('STABLE-1').map((c) => c.address)
    expect(addresses.length).toBe(2)
    // The two most recently connected survive; .1 (connected first, never
    // refreshed again) is the one evicted.
    expect(addresses).not.toContain('10.0.0.1:5555')
    expect(addresses).toContain('10.0.0.2:5555')
    expect(addresses).toContain('10.0.0.3:5555')
  })

  test('a freshly declared address is never evicted on the SAME call that created it, even over the cap', () => {
    const db = setUpDb()
    const store = setUpStore(db, { endpointsPerDevice: 1 })
    store.observe('STABLE-1', '10.0.0.1:5555')
    // A never-connected declare would rank as "infinitely old" under a naive
    // lastConnectedAt-only eviction ordering and evict ITSELF immediately —
    // exactly the bug this store's ranking (COALESCE onto firstSeen) avoids.
    store.declare('STABLE-1', '10.0.0.2:5555', 'wired')
    const addresses = store.candidates('STABLE-1', { includeRetired: true }).map((c) => c.address)
    expect(addresses).toContain('10.0.0.2:5555')
  })

  test('re-enrolling a device that walks through many addresses never grows past the cap (a farm that re-enrols often does not leak)', () => {
    const db = setUpDb()
    const store = setUpStore(db, { endpointsPerDevice: 4 })
    for (let i = 0; i < 50; i++) {
      store.observe('STABLE-1', `10.0.0.${i}:5555`)
    }
    const rows = db.select().from(deviceEndpoints).where(eq(deviceEndpoints.stableId, 'STABLE-1')).all()
    expect(rows.length).toBe(4)
  })
})

describe('EndpointStore.forget', () => {
  test('forgets one address, leaving the rest', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.observe('STABLE-1', '10.0.0.1:5555')
    store.observe('STABLE-1', '10.0.0.2:5555')
    store.forget('STABLE-1', '10.0.0.1:5555')
    expect(store.candidates('STABLE-1').map((c) => c.address)).toEqual(['10.0.0.2:5555'])
  })

  test('forgets every address for a stableId when address is omitted', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.observe('STABLE-1', '10.0.0.1:5555')
    store.observe('STABLE-1', '10.0.0.2:5555')
    store.forget('STABLE-1')
    expect(store.candidates('STABLE-1')).toEqual([])
  })
})

describe('EndpointStore.allWithEndpoints (plan 88 §3.10 — the restart flow reattach list)', () => {
  test('lists every stableId that has at least one remembered address, each ordered like candidates()', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.observe('STABLE-1', '10.0.0.1:5555')
    store.observe('STABLE-2', '10.0.0.2:5555')
    const all = store.allWithEndpoints()
    expect(all.map((e) => e.stableId).sort()).toEqual(['STABLE-1', 'STABLE-2'])
    for (const entry of all) expect(entry.candidates.length).toBe(1)
  })

  test('a device with no remembered address never appears', () => {
    const db = setUpDb()
    const store = setUpStore(db)
    store.observe('STABLE-1', '10.0.0.1:5555')
    expect(store.allWithEndpoints().map((e) => e.stableId)).toEqual(['STABLE-1'])
  })
})
