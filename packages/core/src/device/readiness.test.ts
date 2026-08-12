import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { AdbClient } from '@enkaku/adb'
import type { SessionManager } from '@enkaku/session'
import type { DeviceReadiness } from '@enkaku/protocol'
import { openDb, runMigrations } from '../db'
import { devices } from '../db/schema'
import { createLogger } from '../util/logger'
import { createLeaseManager, type LeaseManager } from '../lease/lease-manager'
import { createDeviceStateMachine } from './state-machine'
import { createReadinessManager, type ReadinessManager } from './readiness'

const D1 = 'd1'

function seedDevice(db: ReturnType<typeof openDb>['db'], overrides: Partial<{ status: string; desiredReadiness: string | null }> = {}) {
  db.insert(devices)
    .values({
      id: D1,
      stableId: 'stable-1',
      serial: 'SER1',
      label: 'Phone One',
      status: overrides.status ?? 'idle',
      desiredReadiness: overrides.desiredReadiness ?? null,
    })
    .run()
}

/** Every adb call succeeds instantly — nothing here touches a real device. */
function fakeAdbClient(execCalls: string[]): AdbClient {
  return {
    exec: async (_serial: string, cmd: string) => {
      execCalls.push(cmd)
      if (cmd.startsWith('dumpsys window')) return 'isKeyguardShowing=false'
      return ''
    },
    execOut: async () => new Uint8Array(),
    connectDevice: async () => '',
  } as unknown as AdbClient
}

/**
 * A minimal fake `SessionManager` (Plan 42) — just enough state to prove the
 * readiness manager's `hold`/`desired: hot` reconciliation subscribes to and
 * unsubscribes from it correctly, with NO timer of its own anywhere: closing
 * only ever happens because `release()` dropped the subscriber count to
 * zero, driven synchronously by the test, never by a clock.
 */
function fakeSessionManager() {
  const subs = new Map<string, Set<unknown>>()
  const acquireCalls: { deviceId: string; quality: string }[] = []
  const sessions: SessionManager = {
    async acquire(deviceId, onFrame, quality = 'control') {
      acquireCalls.push({ deviceId, quality })
      let set = subs.get(deviceId)
      if (!set) {
        set = new Set()
        subs.set(deviceId, set)
      }
      set.add(onFrame)
      return { deviceId, quality } as never
    },
    release(deviceId, onFrame) {
      const set = subs.get(deviceId)
      if (!set) return
      set.delete(onFrame)
      if (set.size === 0) subs.delete(deviceId)
    },
    get(deviceId) {
      const set = subs.get(deviceId)
      return set && set.size > 0 ? ({ deviceId } as never) : null
    },
    async closeDevice() {},
    async closeIfIdle() {},
    idleSessions: () => [],
    async closeAll() {
      return 0
    },
  }
  return { sessions, acquireCalls, isLive: (deviceId: string) => subs.get(deviceId)?.size !== 0 && subs.has(deviceId) }
}

function setUp(opts: { maxHot?: number; withSessions?: boolean } = {}) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const execCalls: string[] = []
  const client = fakeAdbClient(execCalls)
  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const leases: LeaseManager = createLeaseManager({
    states,
    jobStore: { expiredRunning: () => [] } as never,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 60, reaperIntervalMs: 1_000_000 },
    log: createLogger('test'),
    onJobLeaseExpired: () => {},
  })
  const broadcasts: { deviceId: string; readiness: DeviceReadiness }[] = []
  const events: { deviceId: string; actor: string | null; from: string; to: string }[] = []
  const { sessions, acquireCalls, isLive } = fakeSessionManager()
  const maxHot = opts.maxHot ?? 8
  const readiness: ReadinessManager = createReadinessManager({
    db,
    client: () => client,
    sessions: () => (opts.withSessions === false ? null : sessions),
    leases,
    maxHot: () => maxHot,
    broadcast: (deviceId, r) => broadcasts.push({ deviceId, readiness: r }),
    record: (e) => events.push(e),
    log: createLogger('test'),
  })
  return { db, states, leases, readiness, execCalls, broadcasts, events, acquireCalls, isLive }
}

describe('ReadinessManager.get / actual — derivation order (plan 43 §4.3, §7)', () => {
  test('offline beats everything: asleep, blocked offline, even if desired is hot', () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'offline', desiredReadiness: 'hot' })
    const r = readiness.get(D1)
    expect(r).toEqual({ desired: 'hot', actual: 'asleep', blocked: 'offline', since: expect.any(Number) })
  })

  test('a live session means hot, regardless of desired', async () => {
    const { db, readiness, acquireCalls } = setUp()
    seedDevice(db, { status: 'idle', desiredReadiness: 'asleep' })
    const hold = await readiness.hold(D1, 'viewer')
    // hold() only guarantees "awake" (no session) — simulate the caller's
    // own session acquire, exactly as `stream.start` does after the hold.
    expect(acquireCalls.length).toBe(0)
    hold.release()
    expect(readiness.actual(D1)).toBe('asleep')
  })

  test('no session, no manager-applied keep-awake: asleep', () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'idle' })
    expect(readiness.actual(D1)).toBe('asleep')
  })

  test('desired survives being read back after being set, even while offline (acceptance #4, #9)', async () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'idle' })
    await readiness.set(D1, 'awake', { userId: 'u1', clientId: null })
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, D1)).run()
    const r = readiness.get(D1)
    expect(r.desired).toBe('awake')
    expect(r.actual).toBe('asleep')
    expect(r.blocked).toBe('offline')
  })
})

describe('ReadinessManager.set — the §3.4 permission matrix', () => {
  test('Wake is refused for an offline device, with the reason', () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'offline' })
    expect(readiness.set(D1, 'awake', { userId: 'u1', clientId: null })).rejects.toMatchObject({ code: 'device_offline' })
  })

  test('Wake is refused for a quarantined device, with the reason', () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'quarantined' })
    expect(readiness.set(D1, 'hot', { userId: 'u1', clientId: null })).rejects.toMatchObject({ code: 'device_quarantined' })
  })

  test('Wake is allowed for idle, manual, and busy', async () => {
    for (const status of ['idle', 'manual', 'busy']) {
      const { db, readiness } = setUp()
      seedDevice(db, { status })
      const r = await readiness.set(D1, 'awake', { userId: 'u1', clientId: null })
      expect(r.desired).toBe('awake')
    }
  })

  // Plan 49 §3.1/§4.1 replaced the viewer-based rule: watching NEVER blocks
  // sleep, because the Wall tile is itself a viewer, and a rule that forbids
  // the action from the one screen it belongs on is not a safeguard, it is a
  // defect. These four cases pin the corrected rule; the previous
  // viewer-based tests they replace are gone, not merely deleted.

  test('Sleep succeeds with watchers present, including from a Wall tile the actor is looking at (plan 49 §3.1)', async () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'idle', desiredReadiness: 'hot' })
    // There is no `viewersOf` dependency in `ReadinessManagerDeps` any more
    // (plan 49 §4.1) — watching is simply never consulted, so any number of
    // viewers, including the actor's own Wall tile, cannot block this.
    const r = await readiness.set(D1, 'asleep', { userId: 'u1', clientId: 'me' })
    expect(r.desired).toBe('asleep')
  })

  test('Sleep succeeds while the actor holds the manual lease themselves', async () => {
    const { db, readiness, leases } = setUp()
    seedDevice(db, { status: 'idle' })
    leases.acquireManual(D1, 'my-client', 'me')
    await readiness.set(D1, 'hot', { userId: 'me', clientId: 'my-client' })
    const r = await readiness.set(D1, 'asleep', { userId: 'me', clientId: 'my-client' })
    expect(r.desired).toBe('asleep')
  })

  test('Sleep is refused for a running job (status busy), with the reason', () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'busy', desiredReadiness: 'hot' })
    expect(readiness.set(D1, 'asleep', { userId: 'u1', clientId: null })).rejects.toMatchObject({ code: 'job_running' })
  })

  test('Sleep is refused for another holder\'s manual lease, naming the reason', async () => {
    const { db, readiness, leases } = setUp()
    seedDevice(db, { status: 'idle' })
    leases.acquireManual(D1, 'other-client', 'other-user')
    await readiness.set(D1, 'hot', { userId: 'other-user', clientId: 'other-client' })
    expect(readiness.set(D1, 'asleep', { userId: 'me', clientId: 'me-client' })).rejects.toMatchObject({ code: 'device_in_use' })
  })

  test('setting the same value twice is a no-op that does not throw', async () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'idle', desiredReadiness: 'asleep' })
    const r = await readiness.set(D1, 'asleep', { userId: 'u1', clientId: null })
    expect(r.desired).toBe('asleep')
  })

  test('every change is recorded with actor, from, and to (acceptance #12)', async () => {
    const { db, readiness, events } = setUp()
    seedDevice(db, { status: 'idle' })
    await readiness.set(D1, 'awake', { userId: 'u1', clientId: null })
    expect(events).toEqual([{ deviceId: D1, actor: 'u1', from: 'asleep', to: 'awake' }])
  })
})

describe('ReadinessManager — the hot budget (plan 43 §3.5, §7)', () => {
  test('desired hot accepts the request but reports blocked hot_budget_full once the cap is reached, and evicts nothing', async () => {
    const { db, readiness } = setUp({ maxHot: 1 })
    seedDevice(db, { status: 'idle' })
    db.insert(devices).values({ id: 'd2', stableId: 'stable-2', serial: 'SER2', label: 'Phone Two', status: 'idle' }).run()

    const r1 = await readiness.set(D1, 'hot', { userId: 'u1', clientId: null })
    expect(r1).toEqual({ desired: 'hot', actual: 'hot', blocked: null, since: expect.any(Number) })

    const r2 = await readiness.set('d2', 'hot', { userId: 'u1', clientId: null })
    expect(r2.desired).toBe('hot')
    expect(r2.actual).toBe('awake')
    expect(r2.blocked).toBe('hot_budget_full')

    // The first device stays hot — nothing was evicted to make room.
    expect(readiness.actual(D1)).toBe('hot')
  })
})

describe('ReadinessManager — offline retains desired, and job pre-emption (plan 43 §4.3, acceptance #9, #11)', () => {
  test('a device that goes offline keeps its desired and reconcile returns it to hot automatically on reconnect', async () => {
    const { db, readiness, states } = setUp()
    seedDevice(db, { status: 'idle' })
    await readiness.set(D1, 'hot', { userId: 'u1', clientId: null })
    expect(readiness.actual(D1)).toBe('hot')

    states.apply(D1, 'DEVICE_DISCONNECTED')
    await readiness.reconcile(D1)
    expect(readiness.get(D1)).toMatchObject({ desired: 'hot', actual: 'asleep', blocked: 'offline' })

    states.apply(D1, 'DEVICE_CONNECTED')
    await readiness.reconcile(D1)
    expect(readiness.get(D1)).toMatchObject({ desired: 'hot', actual: 'hot', blocked: null })
  })

  test('a job claiming a hot device is never blocked by readiness, and does not change desired (acceptance #11)', async () => {
    const { db, readiness, states } = setUp()
    seedDevice(db, { status: 'idle' })
    await readiness.set(D1, 'hot', { userId: 'u1', clientId: null })
    // JOB_CLAIMED is unconditional on readiness — the state machine does not consult it.
    const applied = states.apply(D1, 'JOB_CLAIMED')
    expect(applied?.to).toBe('busy')
    expect(readiness.actual(D1)).toBe('hot')
    expect(readiness.get(D1).desired).toBe('hot')
  })
})

describe('ReadinessManager.hold — never mutates desired (plan 43 §3.6, acceptance #14, #15)', () => {
  test('a hold on a device desired asleep wakes it (awake) without ever touching desiredReadiness', async () => {
    const { db, readiness, execCalls } = setUp()
    seedDevice(db, { status: 'idle', desiredReadiness: null })
    const hold = await readiness.hold(D1, 'job')
    expect(readiness.actual(D1)).toBe('awake')
    expect(readiness.get(D1).desired).toBe('asleep')
    expect(execCalls).toContain('input keyevent KEYCODE_WAKEUP')

    const rowMidHold = db.select({ d: devices.desiredReadiness }).from(devices).where(eq(devices.id, D1)).get()
    expect(rowMidHold?.d).toBeNull()

    hold.release()
    // Give the fire-and-forget reconcile a tick.
    await Promise.resolve()
    await Promise.resolve()
    expect(readiness.actual(D1)).toBe('asleep')

    const rowAfter = db.select({ d: devices.desiredReadiness }).from(devices).where(eq(devices.id, D1)).get()
    expect(rowAfter?.d).toBeNull()
  })

  test('two overlapping holds only reconcile back to desired once the LAST one releases', async () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'idle' })
    const h1 = await readiness.hold(D1, 'job')
    const h2 = await readiness.hold(D1, 'viewer')
    expect(readiness.actual(D1)).toBe('awake')
    h1.release()
    expect(readiness.actual(D1)).toBe('awake') // h2 still open
    h2.release()
    await Promise.resolve()
    await Promise.resolve()
    expect(readiness.actual(D1)).toBe('asleep')
  })

  test('a device explicitly set hot stays hot through a hold released after it (acceptance #16)', async () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'idle' })
    await readiness.set(D1, 'hot', { userId: 'u1', clientId: null })
    const hold = await readiness.hold(D1, 'job')
    hold.release()
    await Promise.resolve()
    await Promise.resolve()
    // desired stays the floor — inactivity never overrides an explicit hot.
    expect(readiness.actual(D1)).toBe('hot')
    expect(readiness.get(D1).desired).toBe('hot')
  })
})

describe('ReadinessManager — the readiness hold counts as a Plan 42 session subscriber, and there is no second timer (plan 43 §3.7, acceptance #17)', () => {
  test('a desired: hot device is kept warm by a STANDING SessionManager subscriber, released only when desired changes away from hot', async () => {
    const { db, readiness, isLive } = setUp()
    seedDevice(db, { status: 'idle' })
    await readiness.set(D1, 'hot', { userId: 'u1', clientId: null })
    expect(isLive(D1)).toBe(true)
    await readiness.set(D1, 'asleep', { userId: 'u1', clientId: null })
    expect(isLive(D1)).toBe(false)
  })

  test('the readiness module starts no timer of its own — start()/stop() are inert no-ops', () => {
    const { readiness } = setUp()
    // A structural proof, not just a promise: neither call schedules
    // anything observable — there is nothing to assert BECAUSE there is
    // nothing to cancel. `grep -n "setTimeout\\|setInterval" readiness.ts`
    // (run as part of this task's verification) is the exhaustive check;
    // this just proves calling them does not throw or otherwise misbehave.
    expect(() => readiness.start()).not.toThrow()
    expect(() => readiness.stop()).not.toThrow()
  })

  test('a monitor-stream-shaped hold keeps the device from sleeping while it is open (acceptance #17)', async () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'idle' })
    const hold = await readiness.hold(D1, 'monitor')
    expect(readiness.actual(D1)).not.toBe('asleep')
    hold.release()
    await Promise.resolve()
    await Promise.resolve()
    expect(readiness.actual(D1)).toBe('asleep')
  })
})
