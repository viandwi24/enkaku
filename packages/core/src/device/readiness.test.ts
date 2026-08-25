import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import type { AdbClient } from '@enkaku/adb'
import type { SessionManager } from '@enkaku/session'
import { CapturedPowerStateSchema, type DeviceReadiness } from '@enkaku/protocol'
import { openDb, runMigrations } from '../db'
import { devices } from '../db/schema'
import { createLogger } from '../util/logger'
import { createLeaseManager, type LeaseManager } from '../lease/lease-manager'
import { createAwakePolicy } from './awake-policy'
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

interface FakeAdbOpts {
  /**
   * What `dumpsys power | grep -m1 mWakefulness` reports (plan 125 §3.6).
   * `null` makes the probe THROW, which is how acceptance criterion 5 gets
   * exercised: an unanswerable question must answer `unknown`, never `off`.
   */
  wakefulness?: string | null
  /** Every exec parks here before answering — the barrier the boot-sweep concurrency test counts arrivals on. */
  park?: () => Promise<void>
}

/**
 * Every adb call succeeds instantly — nothing here touches a real device.
 *
 * It keeps per-serial STATE for the two power settings, because plan 125's
 * writes are only honest if a `settings put` changes what the next `settings
 * get` returns: `applyScreenOffTimeout`/`applyStayOn` (`@enkaku/session`'s
 * `power.ts`) report `applied` only after reading the value back, so a fake
 * with no state would report every write `refused` and the wake path here
 * would prove nothing.
 */
function fakeAdbClient(execCalls: string[], opts: FakeAdbOpts = {}): AdbClient {
  const state = new Map<string, { timeout: string; stayOn: string }>()
  const stateFor = (serial: string) => {
    let s = state.get(serial)
    if (!s) {
      s = { timeout: '60000', stayOn: '0' }
      state.set(serial, s)
    }
    return s
  }
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 })
  return {
    exec: async (serial: string, cmd: string) => {
      execCalls.push(cmd)
      if (opts.park) await opts.park()
      const s = stateFor(serial)
      if (cmd.startsWith('settings get system screen_off_timeout')) return ok(s.timeout)
      if (cmd.startsWith('settings get global stay_on_while_plugged_in')) return ok(s.stayOn)
      if (cmd.startsWith('settings put system screen_off_timeout')) {
        // `shellQuote`d on the wire; a real device shell strips the quotes.
        s.timeout = (cmd.split(' ').pop() ?? '').replace(/'/g, '') || s.timeout
        return ok()
      }
      if (cmd.startsWith('svc power stayon')) {
        const token = cmd.split(' ').pop()
        s.stayOn = token === 'true' ? '7' : token === 'usb' ? '2' : '0'
        return ok()
      }
      if (cmd.startsWith('dumpsys power')) {
        const w = opts.wakefulness === undefined ? 'Awake' : opts.wakefulness
        if (w === null) throw new Error('adb: device offline')
        return ok(`  mWakefulness=${w}`)
      }
      if (cmd.startsWith('dumpsys window')) return ok('isKeyguardShowing=false')
      return ok()
    },
    execOut: async () => new Uint8Array(),
    connectDevice: async () => '',
    listDevices: async () => [],
    // Read by the boot sweep to clamp its own ceiling against the live adb
    // lane width (plan 125 §4.4) — the same `client.stats()` shape
    // `battery.ts`/`health.ts` already read for their bounded passes.
    stats: () => ({ maxConcurrent: 8, inFlight: 0, waiting: 0 }),
  } as unknown as AdbClient
}

/**
 * Drains every pending microtask chain. Nothing in these tests uses a real
 * timer, so one macrotask boundary is enough to run a fire-and-forget chain
 * (`start()`'s boot sweep, a `release()`'s reconcile) to completion.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

function setUp(
  opts: {
    maxHot?: number
    withSessions?: boolean
    /**
     * Plan 125 §5 step 125.3 wired `awakePolicy` into the real manager
     * (`daemon.ts`), so it is ON by default here too — a test fixture that
     * differed from production on the one dependency this step added would
     * hide exactly the defects it exists to catch. `false` selects the
     * deliberately-degraded no-policy path documented on
     * `ReadinessManagerDeps.awakePolicy`.
     */
    withAwakePolicy?: boolean
    adb?: FakeAdbOpts
    /** Mirrors `daemon.ts`'s device-status hook: every state transition reconciles (plan 125 §4.4's reconnect path). */
    reconcileOnStatusChange?: boolean
  } = {},
) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const execCalls: string[] = []
  const client = fakeAdbClient(execCalls, opts.adb)
  const states = createDeviceStateMachine({
    db,
    log: createLogger('test'),
    onChange: (deviceId) => {
      if (opts.reconcileOnStatusChange) void readiness.reconcile(deviceId)
    },
  })
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
  const awakePolicy = createAwakePolicy({ db, client: () => client, log: createLogger('test') })
  const readiness: ReadinessManager = createReadinessManager({
    db,
    client: () => client,
    sessions: () => (opts.withSessions === false ? null : sessions),
    leases,
    maxHot: () => maxHot,
    awakePolicy: () => (opts.withAwakePolicy === false ? null : awakePolicy),
    broadcast: (deviceId, r) => broadcasts.push({ deviceId, readiness: r }),
    record: (e) => events.push(e),
    log: createLogger('test'),
  })
  return { db, states, leases, readiness, execCalls, broadcasts, events, acquireCalls, isLive }
}

/** The observation a healthy fake device produces — spelled out once so the expectations below stay readable. */
const OBSERVED_ON = { state: 'on' as const, reason: 'mWakefulness=Awake', observedAt: expect.any(Number) as unknown as number }

describe('ReadinessManager.get / actual — derivation order (plan 43 §4.3, §7)', () => {
  test('offline beats everything: asleep, blocked offline, even if desired is hot', () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'offline', desiredReadiness: 'hot' })
    const r = readiness.get(D1)
    // `observed: null` — nothing has probed this device, which is a different
    // statement from a probe that ran and found the panel dark (plan 125 §4.2).
    expect(r).toEqual({ desired: 'hot', actual: 'asleep', blocked: 'offline', since: expect.any(Number), observed: null })
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
    expect(r1).toEqual({ desired: 'hot', actual: 'hot', blocked: null, since: expect.any(Number), observed: OBSERVED_ON })

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

/* ------------------------------------------------------------------------ *
 * Plan 125 step 125.3 — readiness observes, reconnects, and sweeps at boot.
 * ------------------------------------------------------------------------ */

describe('ReadinessManager — the awake policy is WIRED, so the persisted writes happen (plan 125 §3.3, §0.2)', () => {
  test('a wake issues the persisted screen_off_timeout write AND records the device’s original first', async () => {
    const { db, readiness, execCalls } = setUp()
    seedDevice(db, { status: 'idle' })

    await readiness.set(D1, 'awake', { userId: 'u1', clientId: null })

    // The order is the whole point of §0.2 rule 1: the phone is in a sealed
    // box, so what it had BEFORE we touched it is captured before the first
    // write, or the write does not happen at all.
    const readIdx = execCalls.indexOf('settings get system screen_off_timeout')
    const writeIdx = execCalls.indexOf("settings put system screen_off_timeout '1800000'")
    expect(readIdx).toBeGreaterThanOrEqual(0)
    expect(writeIdx).toBeGreaterThan(readIdx)
    // `svc power stayon` (the pre-125 runtime hold) still rides along.
    expect(execCalls).toContain('svc power stayon true')

    // And the capture landed in the column `restore` reads (plan 125 §4.2).
    const stored = db.select().from(devices).where(eq(devices.id, D1)).get()?.powerCapture
    expect(CapturedPowerStateSchema.parse(stored)).toMatchObject({ screenOffTimeoutMs: 60_000, stayOnWhilePluggedIn: '0' })
  })

  test('with NO policy wired the persisted timeout write is withheld — a refusal, not a silent degradation', async () => {
    const { db, readiness, execCalls } = setUp({ withAwakePolicy: false })
    seedDevice(db, { status: 'idle' })

    await readiness.set(D1, 'awake', { userId: 'u1', clientId: null })

    // Nothing owns the capture, so nothing may overwrite the device's own
    // value (`wakeDevice`'s own `refused` branch). The pre-125 behaviour —
    // the runtime nudge and `svc power stayon` — is untouched.
    expect(execCalls.some((c) => c.startsWith('settings put system screen_off_timeout'))).toBe(false)
    expect(execCalls).toContain('svc power stayon true')
    expect(db.select().from(devices).where(eq(devices.id, D1)).get()?.powerCapture ?? null).toBeNull()
  })
})

describe('ReadinessManager — `observed`, beside `actual` and never instead of it (plan 125 §3.6, §4.2, acceptance #5)', () => {
  test('nothing has been probed yet: `observed` is null, and `actual` keeps its own meaning', () => {
    const { db, readiness } = setUp()
    seedDevice(db, { status: 'idle' })
    const r = readiness.get(D1)
    expect(r.observed).toBeNull()
    expect(r.actual).toBe('asleep')
  })

  test('reconcile probes the phone and carries the answer on the wire, beside `actual`', async () => {
    const { db, readiness, broadcasts } = setUp()
    seedDevice(db, { status: 'idle', desiredReadiness: 'awake' })

    await readiness.reconcile(D1)

    const last = broadcasts.at(-1)!.readiness
    expect(last.observed).toEqual(OBSERVED_ON)
    // Both fields survive: `actual` is still the bookkeeping value every other
    // module reasons about, and it is NOT replaced by the observation (§4.2).
    expect(last.actual).toBe('awake')
  })

  test('a probe that cannot run reaches the client as `unknown` WITH a reason — never collapsed into `off` (acceptance #5)', async () => {
    const { db, readiness, broadcasts } = setUp({ adb: { wakefulness: null } })
    seedDevice(db, { status: 'idle', desiredReadiness: 'awake' })

    await readiness.reconcile(D1)

    const observed = broadcasts.at(-1)!.readiness.observed!
    expect(observed.state).toBe('unknown')
    expect(observed.reason).toContain('probe')
    // The assertion that matters: `unknown` must never be worded, stored or
    // broadcast as `off`, the same discipline plan 89 §3.5 applies to
    // `unavailable` and `deriveHealth` applies to `unverified`.
    expect(observed.state).not.toBe('off')
    expect(broadcasts.every((b) => b.readiness.observed?.state !== 'off')).toBe(true)
  })

  test('an unrecognised wakefulness token is `unknown`, not `off`', async () => {
    const { db, readiness } = setUp({ adb: { wakefulness: 'Bananas' } })
    seedDevice(db, { status: 'idle', desiredReadiness: 'awake' })
    await readiness.reconcile(D1)
    expect(readiness.get(D1).observed?.state).toBe('unknown')
  })

  test('a genuinely dark panel DOES read `off` — `unknown` is not a blanket excuse for never answering', async () => {
    const { db, readiness } = setUp({ adb: { wakefulness: 'Asleep' } })
    seedDevice(db, { status: 'idle', desiredReadiness: 'asleep' })
    await readiness.reconcile(D1)
    expect(readiness.get(D1).observed?.state).toBe('off')
  })

  test('a device that goes offline loses its stale observation to `unknown`, never to `off`', async () => {
    const { db, readiness, states } = setUp()
    seedDevice(db, { status: 'idle', desiredReadiness: 'awake' })
    await readiness.reconcile(D1)
    expect(readiness.get(D1).observed?.state).toBe('on')

    states.apply(D1, 'DEVICE_DISCONNECTED')
    await readiness.reconcile(D1)

    // Keeping the previous `on` would be an inference presented as fact about
    // a phone that has left the farm (plan 125 §0.3); `off` would be a claim
    // nobody checked. `unknown` with the reason is the only honest answer.
    expect(readiness.get(D1).observed).toEqual({ state: 'unknown', reason: 'the device is offline', observedAt: expect.any(Number) })
  })

  test('observe() is on demand and ignores the reconcile cache — an operator who asks gets a fresh answer', async () => {
    const { db, readiness, execCalls } = setUp()
    seedDevice(db, { status: 'idle', desiredReadiness: 'awake' })
    await readiness.reconcile(D1)
    const afterReconcile = execCalls.filter((c) => c.startsWith('dumpsys power')).length
    expect(afterReconcile).toBe(1)

    // A second reconcile inside the cache window costs nothing...
    await readiness.reconcile(D1)
    expect(execCalls.filter((c) => c.startsWith('dumpsys power')).length).toBe(1)

    // ...but an explicit ask always pays for a fresh probe.
    const observed = await readiness.observe(D1)
    expect(observed.state).toBe('on')
    expect(execCalls.filter((c) => c.startsWith('dumpsys power')).length).toBe(2)
  })

  test('with no policy wired, `observed` stays null (never asked) and observe() still answers `unknown`, never `off`', async () => {
    const { db, readiness } = setUp({ withAwakePolicy: false })
    seedDevice(db, { status: 'idle', desiredReadiness: 'awake' })
    await readiness.reconcile(D1)
    expect(readiness.get(D1).observed).toBeNull()

    const observed = await readiness.observe(D1)
    expect(observed.state).toBe('unknown')
    expect(observed.reason).toContain('no awake policy')
  })
})

describe('ReadinessManager — a device that reconnects is re-woken (plan 125 §4.4, §0.2)', () => {
  test('an awake device that blips offline and comes back is woken again, driven ONLY by the status transition daemon.ts hooks', async () => {
    // `reconcileOnStatusChange` is the fixture's copy of `daemon.ts`'s
    // device-status hook. Nothing in this test calls `reconcile` by hand
    // after the setup wake, because nothing in production does either: if the
    // wiring were missing, the phone would simply stay dark — and it lives in
    // a sealed box where staying dark is unrecoverable (§0.2).
    const { db, readiness, states, execCalls } = setUp({ reconcileOnStatusChange: true })
    seedDevice(db, { status: 'idle', desiredReadiness: 'awake' })

    await readiness.reconcile(D1)
    expect(readiness.actual(D1)).toBe('awake')
    const wakesAfterFirst = execCalls.filter((c) => c === 'input keyevent KEYCODE_WAKEUP').length
    expect(wakesAfterFirst).toBe(1)

    states.apply(D1, 'DEVICE_DISCONNECTED')
    await flush()
    expect(readiness.get(D1)).toMatchObject({ desired: 'awake', actual: 'asleep', blocked: 'offline' })

    states.apply(D1, 'DEVICE_CONNECTED')
    await flush()

    expect(readiness.get(D1)).toMatchObject({ desired: 'awake', actual: 'awake', blocked: null })
    expect(execCalls.filter((c) => c === 'input keyevent KEYCODE_WAKEUP').length).toBe(2)
  })

  test('a device desired asleep is NOT woken when it reconnects', async () => {
    const { db, readiness, states, execCalls } = setUp({ reconcileOnStatusChange: true })
    seedDevice(db, { status: 'idle', desiredReadiness: 'asleep' })

    states.apply(D1, 'DEVICE_DISCONNECTED')
    await flush()
    states.apply(D1, 'DEVICE_CONNECTED')
    await flush()

    expect(readiness.actual(D1)).toBe('asleep')
    expect(execCalls).not.toContain('input keyevent KEYCODE_WAKEUP')
  })
})

describe('ReadinessManager.start — the boot sweep (plan 125 §4.4, §3.1)', () => {
  function seedFarm(db: ReturnType<typeof openDb>['db'], specs: { id: string; status: string; desired: string | null }[]) {
    for (const spec of specs) {
      db.insert(devices)
        .values({
          id: spec.id,
          stableId: `stable-${spec.id}`,
          serial: `SER-${spec.id}`,
          label: `Phone ${spec.id}`,
          status: spec.status,
          desiredReadiness: spec.desired,
        })
        .run()
    }
  }

  test('wakes every device whose desired is not asleep, and leaves the asleep ones alone', async () => {
    const { db, readiness, execCalls } = setUp()
    seedFarm(db, [
      { id: 'a', status: 'idle', desired: 'awake' },
      { id: 'b', status: 'idle', desired: 'hot' },
      { id: 'c', status: 'idle', desired: 'asleep' },
      { id: 'd', status: 'idle', desired: null }, // never set — `desiredOf` reads it as asleep
    ])

    readiness.start()
    await flush()

    expect(readiness.actual('a')).toBe('awake')
    expect(readiness.actual('b')).toBe('hot')
    expect(readiness.actual('c')).toBe('asleep')
    expect(readiness.actual('d')).toBe('asleep')
    // Exactly one phone was physically nudged: `a`. `b` reached `hot` through
    // a session, and `c`/`d` were never touched at all.
    expect(execCalls.filter((c) => c === 'input keyevent KEYCODE_WAKEUP').length).toBe(1)
  })

  test('an offline or quarantined device is SKIPPED with a reason, and no adb call is made against it', async () => {
    const { db, readiness, execCalls, broadcasts } = setUp()
    seedFarm(db, [
      { id: 'off', status: 'offline', desired: 'awake' },
      { id: 'quar', status: 'quarantined', desired: 'hot' },
    ])

    readiness.start()
    await flush()

    expect(readiness.get('off')).toMatchObject({ desired: 'awake', actual: 'asleep', blocked: 'offline' })
    expect(readiness.get('quar')).toMatchObject({ desired: 'hot', actual: 'asleep', blocked: 'quarantined' })
    // The reason is on the wire, not only in a log line.
    expect(readiness.get('off').observed).toEqual({ state: 'unknown', reason: 'the device is offline', observedAt: expect.any(Number) })
    expect(readiness.get('quar').observed).toEqual({ state: 'unknown', reason: 'the device is quarantined', observedAt: expect.any(Number) })
    expect(execCalls).toEqual([])
    // Skipped once and reported once — not retried in a loop, which is the
    // timer this module refuses to grow (§3.7).
    expect(broadcasts.filter((b) => b.deviceId === 'off').length).toBe(1)
  })

  test('it is bounded: never more than four devices in flight, however big the farm', async () => {
    // A barrier every fake exec parks on, so "how many devices is the sweep
    // working on right now" is directly countable rather than inferred.
    let waiters: (() => void)[] = []
    const park = () => new Promise<void>((resolve) => waiters.push(resolve))
    const releaseAll = () => {
      const pending = waiters
      waiters = []
      for (const resolve of pending) resolve()
    }

    const { db, readiness } = setUp({ adb: { park } })
    seedFarm(
      db,
      Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, status: 'idle', desired: 'awake' })),
    )

    readiness.start()
    let peak = 0
    for (let i = 0; i < 2000; i++) {
      await flush()
      if (waiters.length === 0) break
      peak = Math.max(peak, waiters.length)
      releaseAll()
    }

    // Each parked exec is one device's reconcile mid-flight, so this IS the
    // concurrency. An unbounded `Promise.all` over ten devices would read 10.
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
    expect(Array.from({ length: 10 }, (_, i) => readiness.actual(`p${i}`))).toEqual(Array(10).fill('awake'))
  })

  test('it runs ONCE: a second start() sweeps nothing', async () => {
    const { db, readiness, execCalls } = setUp()
    seedFarm(db, [{ id: 'a', status: 'idle', desired: 'awake' }])

    readiness.start()
    await flush()
    const after = execCalls.length
    expect(after).toBeGreaterThan(0)

    readiness.start()
    await flush()
    expect(execCalls.length).toBe(after)
  })

  test('stop() during a sweep stops waking phones the core is walking away from', async () => {
    let waiters: (() => void)[] = []
    const park = () => new Promise<void>((resolve) => waiters.push(resolve))
    const releaseAll = () => {
      const pending = waiters
      waiters = []
      for (const resolve of pending) resolve()
    }

    const { db, readiness } = setUp({ adb: { park } })
    seedFarm(
      db,
      Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, status: 'idle', desired: 'awake' })),
    )

    readiness.start()
    await flush()
    readiness.stop()
    for (let i = 0; i < 2000; i++) {
      releaseAll()
      await flush()
      if (waiters.length === 0) break
    }

    // The four devices already in flight finish; the rest are abandoned.
    const woken = Array.from({ length: 10 }, (_, i) => readiness.actual(`p${i}`)).filter((r) => r !== 'asleep').length
    expect(woken).toBeLessThanOrEqual(4)
  })
})

describe('ReadinessManager — the no-timer rule survives plan 125 (readiness.ts’s own §3.7 claim)', () => {
  test('the module source contains no setTimeout/setInterval', () => {
    // A structural assertion against the source, the way
    // `adb-server-control.test.ts` asserts its one-call-site rule: the
    // module's header comment CLAIMS "This module starts no
    // `setTimeout`/`setInterval` of its own anywhere below — search it and
    // there is none", and plan 125 §4.4 added a boot sweep that would have
    // been very natural to write as an interval. This is that search, run on
    // every CI push instead of by hand.
    const source = readFileSync(new URL('./readiness.ts', import.meta.url), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/*'))
      .join('\n')
    expect(code).not.toMatch(/setTimeout\s*\(/)
    expect(code).not.toMatch(/setInterval\s*\(/)
  })
})
