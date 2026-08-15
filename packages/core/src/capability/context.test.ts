import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { InputSink } from '@enkaku/protocol'
import { createInputArbiter, DEFAULT_TIMING, type DeviceSession, type Logger } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices, scripts } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { allocateDeviceNumber } from '../registry/device-number'
import { createScriptRegistry } from '../scripts/registry'
import { createDeviceStateMachine } from '../device/state-machine'
import { createLeaseManager } from '../lease/lease-manager'
import { createCoControlManager } from '../lease/co-control'
import { createLogger } from '../util/logger'
import { createCapabilityContext } from './context'
import { deviceTap } from './device-input'
import { deviceFind, deviceWaitFor } from './device-inspect'
import { invoke } from './invoke'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function insertDevice(db: Db, id: string, ownerId: string | null = null): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, ownerId, status: 'idle' }).run()
}

/**
 * A minimal `LeaseManager` fake — `getLease` is what `controlLeaseBlockedBy`
 * reads; `getHolder` is what `listDevices()`/`getDevice()` read (plan 71
 * §4.4, threaded through `rowToDeviceInfo`'s `heldBy` — plan 88 §5 step
 * 88.5's own tests are the first in this file to exercise either method).
 */
function fakeLeases(lease: { holder: string; holderUserId: string | null; type: 'manual' | 'job' } | null) {
  return {
    getLease: () => (lease ? { deviceId: 'd1', acquiredAt: 0, expiresAt: 0, ...lease } : null),
    getHolder: () => null,
  } as unknown as import('../lease/lease-manager').LeaseManager
}

function fakeStates(status: string | null) {
  return { current: () => status } as unknown as import('../device/state-machine').DeviceStateMachine
}

/** A fake `SessionManager` that hands back one fixed `DeviceSession` whose
 * `input.tap`/`inspector.find` are spies — this is what proves
 * `CapabilityContext.deviceCall` really runs `createDeviceExecutor` (the
 * SAME executor a script's IPC bridge uses) rather than reimplementing tap. */
function fakeSessionManager(session: DeviceSession) {
  const calls: { acquire: number; release: number } = { acquire: 0, release: 0 }
  return {
    manager: {
      async acquire() {
        calls.acquire++
        return session
      },
      release() {
        calls.release++
      },
      get: () => session,
      closeDevice: async () => {},
      closeIfIdle: async () => {},
      idleSessions: () => [],
      closeAll: async () => {},
    } as unknown as import('@enkaku/session').SessionManager,
    calls,
  }
}

/** Same `silentLog` pattern `@enkaku/session`'s own tests use (`orientation.test.ts` etc). */
function silentLog(): Logger {
  const l: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l
}

function fakeSession(overrides: Partial<DeviceSession> = {}): DeviceSession {
  const base = {
    deviceId: 'd1',
    transport: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }), execOut: async () => new Uint8Array() },
    input: { tap: async () => {}, swipe: async () => {}, key: async () => {}, text: async () => {} },
    inspector: null,
    frameSize: { width: 1080, height: 1920 },
    clipboard: null,
    ...overrides,
  }
  // Plan 91 §3.1, §3.3, §4.1 — `createDeviceExecutor` now calls `deps.session.arbiter.for(source)`
  // rather than `deps.session.input` directly (fixes F6/H1). Built from `base.input` — i.e. AFTER
  // `overrides` is merged in — so a test overriding `input` with its own tap spy (several below
  // do) gets that same spy wrapped, not the default no-op.
  const arbiter = createInputArbiter(base.input as unknown as InputSink, {
    queueWaitMs: () => 5_000,
    maxQueueDepth: () => 32,
    log: silentLog(),
  })
  return { ...base, arbiter } as unknown as DeviceSession
}

/** Zero jitter/delay so a tapped point can be asserted exactly (plan 63
 * §6.9: this proves `deviceCall` runs the real executor, jitter included by
 * default — the test only disables it for determinism, not `device-executor.ts`). */
const ZERO_JITTER_TIMING = { ...DEFAULT_TIMING, coordJitterPx: 0, betweenActionMs: [0, 0] as [number, number] }

const noopJobService = {
  enqueue: () => {
    throw new Error('not used')
  },
  cancel: () => {
    throw new Error('not used')
  },
  get: () => null,
  list: () => ({ jobs: [], nextCursor: null, total: 0 }),
} as unknown as import('../services/job-service').JobService

/** Plan 64 §4.2 — none of these tests exercise `fs.*`, so a throwing stub is
 * enough; it just has to satisfy `CapabilityContextDeps.workspace`'s type. */
const noopWorkspace = {
  list: () => {
    throw new Error('not used')
  },
  read: () => {
    throw new Error('not used')
  },
  write: () => {
    throw new Error('not used')
  },
  delete: () => {
    throw new Error('not used')
  },
  move: () => {
    throw new Error('not used')
  },
} as unknown as import('../workspace/store').WorkspaceStore

describe('createCapabilityContext (plan 63 §3.2, §4.3)', () => {
  test('canReachDevice: an unowned device is reachable by any actor', () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => null, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.canReachDevice('d1')).toBe(true)
  })

  test('canReachDevice: an owned device is refused to a different operator', () => {
    const db = setUp()
    insertDevice(db, 'd1', 'someone-else')
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => null, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.canReachDevice('d1')).toBe(false)
  })

  test('canReachDevice: an admin reaches any device regardless of ownership', () => {
    const db = setUp()
    insertDevice(db, 'd1', 'someone-else')
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => null, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'admin' },
    )
    expect(ctx.canReachDevice('d1')).toBe(true)
  })

  test('controlLeaseBlockedBy: null when the actor holds the manual lease', () => {
    const db = setUp()
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases({ holder: 'client-1', holderUserId: 'u1', type: 'manual' }), states: fakeStates('manual'), sessions: () => null, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.controlLeaseBlockedBy('d1')).toBeNull()
  })

  test('controlLeaseBlockedBy: names the holder when someone else has it', () => {
    const db = setUp()
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases({ holder: 'client-2', holderUserId: 'u2', type: 'manual' }), states: fakeStates('manual'), sessions: () => null, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.controlLeaseBlockedBy('d1')).toBe('u2')
  })

  test('deviceCall acquires the session, runs the SAME executor a script uses, and releases it', async () => {
    const state: { tapped: { x: number; y: number } | null } = { tapped: null }
    const session = fakeSession({
      input: { id: 'fake', mode: 'sdk', tap: async (p) => { state.tapped = p }, swipe: async () => {}, key: async () => {}, text: async () => {} },
    })
    const { manager, calls } = fakeSessionManager(session)
    const ctx = createCapabilityContext(
      { db: setUp(), leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => manager, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace, timing: ZERO_JITTER_TIMING },
      { id: 'u1', role: 'operator' },
    )
    const result = await ctx.deviceCall('d1', { method: 'tap', args: { target: { point: { x: 10, y: 20 } } } })
    expect(result).toBeUndefined()
    expect(state.tapped).toEqual({ x: 10, y: 20 })
    expect(calls.acquire).toBe(1)
    expect(calls.release).toBe(1)
  })

  test('end-to-end: device.tap through invoke() hits the fake driver, not a reimplementation', async () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    const state: { tapped: { x: number; y: number } | null } = { tapped: null }
    const session = fakeSession({
      input: { id: 'fake', mode: 'sdk', tap: async (p) => { state.tapped = p }, swipe: async () => {}, key: async () => {}, text: async () => {} },
    })
    const { manager } = fakeSessionManager(session)
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases({ holder: 'c1', holderUserId: 'u1', type: 'manual' }), states: fakeStates('manual'), sessions: () => manager, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace, timing: ZERO_JITTER_TIMING },
      { id: 'u1', role: 'operator' },
    )
    const result = await invoke(deviceTap, ctx, { deviceId: 'd1', target: { point: { x: 5, y: 6 } } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.output).toEqual({ ok: true })
    expect(state.tapped).toEqual({ x: 5, y: 6 })
  })

  test('end-to-end: device.find returns { ok:false, reason:"not-found" } — never a bare null', async () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    const session = fakeSession({ inspector: { id: 'fake', find: async () => null, dump: async () => { throw new Error('unused') }, screenshot: async () => new Uint8Array() } })
    const { manager } = fakeSessionManager(session)
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => manager, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'operator' },
    )
    const result = await invoke(deviceFind, ctx, { deviceId: 'd1', sel: { text: 'OK' } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.output).toEqual({ ok: false, reason: 'not-found', matches: 0 })
  })

  test('plan 74 criterion 8: device.find reports "rejected-oversized" distinctly from "not-found" through the capability', async () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    const session = fakeSession({
      inspector: {
        id: 'fake',
        find: async () => {
          throw new Error('unused — findDetailed is what device-executor calls')
        },
        findDetailed: async () => ({ ok: false, reason: 'rejected-oversized', matches: 1 }),
        dump: async () => {
          throw new Error('unused')
        },
        screenshot: async () => new Uint8Array(),
      },
    })
    const { manager } = fakeSessionManager(session)
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => manager, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'operator' },
    )
    const result = await invoke(deviceFind, ctx, { deviceId: 'd1', sel: { id: 'url_bar' } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.output).toEqual({ ok: false, reason: 'rejected-oversized', matches: 1 })
  })

  test('plan 74 criterion 8: device.find reports "ambiguous" distinctly, with the match count', async () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    const session = fakeSession({
      inspector: {
        id: 'fake',
        find: async () => {
          throw new Error('unused')
        },
        findDetailed: async () => ({ ok: false, reason: 'ambiguous', matches: 3 }),
        dump: async () => {
          throw new Error('unused')
        },
        screenshot: async () => new Uint8Array(),
      },
    })
    const { manager } = fakeSessionManager(session)
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => manager, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'operator' },
    )
    const result = await invoke(deviceFind, ctx, { deviceId: 'd1', sel: { text: 'Next' } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.output).toEqual({ ok: false, reason: 'ambiguous', matches: 3 })
  })

  test('plan 74 criterion 9: device.waitFor timing out because every match was refused says so, not a bare timeout', async () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    const session = fakeSession({
      inspector: {
        id: 'fake',
        find: async () => null,
        findDetailed: async () => ({ ok: false, reason: 'rejected-oversized', matches: 1 }),
        dump: async () => {
          throw new Error('unused')
        },
        screenshot: async () => new Uint8Array(),
      },
      inspectorPollIntervalMs: 5,
    })
    const { manager } = fakeSessionManager(session)
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => manager, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'operator' },
    )
    const result = await invoke(deviceWaitFor, ctx, { deviceId: 'd1', sel: { id: 'url_bar' }, timeout: 20, intervalMs: 5 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output).toEqual({ ok: false, reason: 'timeout', lastReason: 'rejected-oversized', matches: 1 })
    }
  })

  test('acceptance #6: E_DEADLINE returns immediately, and the underlying call still frees the session slot once it settles', async () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    // A driver call that takes 150ms to settle — the capability's deadline
    // is overridden far below that (via a throwaway copy) so `invoke`
    // returns long before the fake "adb call" underneath finishes.
    const session = fakeSession({
      input: {
        id: 'fake',
        mode: 'sdk',
        tap: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150))
        },
        swipe: async () => {},
        key: async () => {},
        text: async () => {},
      },
    })
    const { manager, calls } = fakeSessionManager(session)
    const ctx = createCapabilityContext(
      {
        db,
        leases: fakeLeases({ holder: 'c1', holderUserId: 'u1', type: 'manual' }),
        states: fakeStates('manual'),
        sessions: () => manager,
        readiness: () => null,
        transfer: null,
        jobService: noopJobService, workspace: noopWorkspace,
        timing: ZERO_JITTER_TIMING,
      },
      { id: 'u1', role: 'operator' },
    )
    const fastDeadlineTap = { ...deviceTap, deadline: 20 }

    const startedAt = Date.now()
    const result = await invoke(fastDeadlineTap, ctx, { deviceId: 'd1', target: { point: { x: 1, y: 1 } } })
    const elapsed = Date.now() - startedAt

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_DEADLINE')
    expect(elapsed).toBeLessThan(100)
    // Immediately after the refusal the slot is still held — the queue
    // depth has NOT yet returned to its prior value.
    expect(calls.acquire).toBe(1)
    expect(calls.release).toBe(0)

    // Once the background call itself settles (well within its own 150ms),
    // the SAME `finally` block every other `deviceCall` uses releases it —
    // nothing here is abandoned forever, it is bounded by the underlying
    // call's own duration, exactly as `invoke.ts`'s comment describes.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(calls.release).toBe(1)
  })
})

/**
 * Plan 88 §3.6, §4.1, §5 step 88.5 — `ctx.listDevices()`/`ctx.getDevice()`
 * are an agent script's own view of the fleet (`capability/device-state.ts`).
 * Without `networks`/`declaredMedia` threaded through, a script would see a
 * device badged `TCP` while `GET /api/devices` right next to it badges the
 * SAME device `OTG` — the exact "three steps, each tested, nothing together"
 * gap the coordinator's note described.
 */
describe('createCapabilityContext — connection.medium reaches listDevices/getDevice too (plan 88 §5 step 88.5)', () => {
  test('listDevices() badges a tcp device from a configured farm network', () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    db.update(devices).set({ serial: '10.0.0.5:5555' }).where(eq(devices.id, 'd1')).run()
    const ctx = createCapabilityContext(
      {
        db,
        leases: fakeLeases(null),
        states: fakeStates('idle'),
        sessions: () => null,
        readiness: () => null,
        transfer: null,
        jobService: noopJobService,
        workspace: noopWorkspace,
        networks: () => [{ cidr: '10.0.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }],
      },
      { id: 'u1', role: 'operator' },
    )
    const info = ctx.listDevices().find((d) => d.id === 'd1')
    expect(info?.connection).toMatchObject({ medium: 'wired', mediumSource: 'network' })
  })

  test('getDevice() reads a declared medium back, same as GET /api/devices does', () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    db.update(devices).set({ serial: '10.0.0.5:5555' }).where(eq(devices.id, 'd1')).run()
    const ctx = createCapabilityContext(
      {
        db,
        leases: fakeLeases(null),
        states: fakeStates('idle'),
        sessions: () => null,
        readiness: () => null,
        transfer: null,
        jobService: noopJobService,
        workspace: noopWorkspace,
        declaredMedia: () => new Map([['stable-d1 10.0.0.5:5555', 'wireless' as const]]),
      },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.getDevice('d1')?.connection).toMatchObject({ medium: 'wireless', mediumSource: 'declared' })
  })
})

/**
 * Plan 89 §3.1, §3.2, §4.2, §4.3 — `ctx.getDevice()` is a direct
 * `rowToDeviceInfo` call site (unlike `listDevices()`, which goes through
 * `listDevicesWithTags` and picks up the number automatically). Without this
 * threaded through, a script's own view of a device would read `number:
 * null` for a device `GET /api/devices` shows numbered — the exact "field
 * exists, one call site never threaded it" defect class this plan is
 * against.
 */
describe('createCapabilityContext — the device number reaches getDevice() too (plan 89 §4.2, §4.3)', () => {
  test('getDevice() carries the same number GET /api/devices would', () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    allocateDeviceNumber(db, 'stable-d1')
    const ctx = createCapabilityContext(
      {
        db,
        leases: fakeLeases(null),
        states: fakeStates('idle'),
        sessions: () => null,
        readiness: () => null,
        transfer: null,
        jobService: noopJobService,
        workspace: noopWorkspace,
      },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.getDevice('d1')?.number).toBe(1)
  })
})

/**
 * Plan 91 §3.4 item 4, §4.4 — the producer gap step 91.4 flagged and left
 * open: `ctx.listDevices()`/`ctx.getDevice()` (an agent script's own view of
 * the fleet, `capability/device-state.ts`) never threaded `assistedByOf`, so
 * a script would see `assistedBy: []` even while a human was genuinely
 * assisting the device it runs on. Proven through the real
 * `createCapabilityContext` surface, the same discipline the
 * `connection.medium` describe block just above already established.
 */
describe('createCapabilityContext — assistedBy reaches listDevices/getDevice too (plan 91 §3.4 item 4, §4.4)', () => {
  const assistHolder = { kind: 'user' as const, id: 'u-assist', label: 'operator@enkaku', runId: null, takeable: false, acquiredAt: 100, expiresAt: 200 }

  test('listDevices() reports the assisting holder for an assisted device, and [] for an unassisted one', () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    insertDevice(db, 'd2', null)
    const ctx = createCapabilityContext(
      {
        db,
        leases: fakeLeases(null),
        states: fakeStates('idle'),
        sessions: () => null,
        readiness: () => null,
        transfer: null,
        jobService: noopJobService,
        workspace: noopWorkspace,
        assistedByOf: (deviceId) => (deviceId === 'd1' ? [assistHolder] : []),
      },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.listDevices().find((d) => d.id === 'd1')?.assistedBy).toEqual([assistHolder])
    expect(ctx.listDevices().find((d) => d.id === 'd2')?.assistedBy).toEqual([])
  })

  test('getDevice() reports the same assistedBy as listDevices()', () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    const ctx = createCapabilityContext(
      {
        db,
        leases: fakeLeases(null),
        states: fakeStates('idle'),
        sessions: () => null,
        readiness: () => null,
        transfer: null,
        jobService: noopJobService,
        workspace: noopWorkspace,
        assistedByOf: () => [assistHolder],
      },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.getDevice('d1')?.assistedBy).toEqual([assistHolder])
  })

  test('an omitted assistedByOf dep falls back to [] rather than throwing or guessing', () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    const ctx = createCapabilityContext(
      {
        db,
        leases: fakeLeases(null),
        states: fakeStates('idle'),
        sessions: () => null,
        readiness: () => null,
        transfer: null,
        jobService: noopJobService,
        workspace: noopWorkspace,
      },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.getDevice('d1')?.assistedBy).toEqual([])
    expect(ctx.listDevices().find((d) => d.id === 'd1')?.assistedBy).toEqual([])
  })

  /**
   * docs/plans/96-m61-hotfixes.md §96.10, daemon.ts's own residual — the
   * three tests above prove `createCapabilityContext` correctly THREADS
   * whatever `assistedByOf` it is handed; they do not prove the real
   * production expression (`(deviceId) => coControl.assistedBy(deviceId)`,
   * wired into `daemon.ts`'s `capContextDeps` object literal) behaves
   * correctly end to end. This test builds a REAL `CoControlManager` and a
   * REAL `LeaseManager` — the same `leases`-then-`coControl` construction
   * order `daemon.ts` uses — grants a real assist through it, and passes the
   * identical accessor expression `daemon.ts` now contains, so the mechanism
   * under test is the production wiring itself, not a hand-rolled fake array.
   */
  test('a REAL CoControlManager, wired with `assistedByOf: (deviceId) => coControl.assistedBy(deviceId)` — the exact daemon.ts expression — reports the granted assist through ctx.listDevices()/ctx.getDevice()', () => {
    const db = setUp()
    insertDevice(db, 'd1', null)
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    let coControlRef: ReturnType<typeof createCoControlManager> | null = null
    const leases = createLeaseManager({
      states,
      jobStore: { expiredRunning: () => [] } as never,
      config: { jobTtlSec: 60, manualIdleTimeoutSec: 60, reaperIntervalMs: 1_000_000 },
      log: createLogger('test'),
      onJobLeaseExpired: () => {},
      onPrimaryEnded: (deviceId) => coControlRef?.onPrimaryEnded(deviceId),
      onManualTakenOver: ({ deviceId }) => coControlRef?.onPrimaryEnded(deviceId),
    })
    const coControl = createCoControlManager({
      leases,
      config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1 },
      log: createLogger('test'),
    })
    coControlRef = coControl

    leases.acquireManual('d1', 'primary-client', 'primary-user')
    coControl.grant('d1', 'assist-client', 'assisting-user')

    const ctx = createCapabilityContext(
      {
        db,
        leases,
        states: fakeStates('idle'),
        sessions: () => null,
        readiness: () => null,
        transfer: null,
        jobService: noopJobService,
        workspace: noopWorkspace,
        assistedByOf: (deviceId) => coControl.assistedBy(deviceId),
      },
      { id: 'u1', role: 'operator' },
    )
    const fromList = ctx.listDevices().find((d) => d.id === 'd1')?.assistedBy
    expect(fromList).toHaveLength(1)
    expect(fromList?.[0]).toMatchObject({ kind: 'user', id: 'assisting-user' })
    expect(ctx.getDevice('d1')?.assistedBy).toEqual(fromList)
  })
})

describe('createCapabilityContext — resolveScriptRef through the registry (plan 82 §3.3, criterion 14)', () => {
  test('with no registry wired, falls back to the pre-plan-82 direct resolveScriptRef (unchanged behaviour)', () => {
    const db = setUp()
    db.insert(scripts).values({ id: 's1', name: 'checkout', version: '1.0.0', bundle: 'x', enabled: true, createdAt: new Date() }).run()
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => null, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.resolveScriptRef('checkout@1.0.0').id).toBe('s1')
  })

  test('with a registry wired, resolves a PLUGIN member the same way a standalone script resolves — one of the 8 call sites plan 82 §3.3 names', () => {
    const db = setUp()
    db.insert(scripts)
      .values({ id: 's1', name: 'tiktok/login', version: '1.0.0', bundle: 'x', enabled: true, createdAt: new Date(), pluginId: 'p1', exportId: 'login' })
      .run()
    const registry = createScriptRegistry({ db, dataDir: '/tmp/enkaku-context-test', devSlots: createDevSlotStore() })
    const ctx = createCapabilityContext(
      { db, leases: fakeLeases(null), states: fakeStates('idle'), sessions: () => null, readiness: () => null, transfer: null, jobService: noopJobService, workspace: noopWorkspace, registry },
      { id: 'u1', role: 'operator' },
    )
    expect(ctx.resolveScriptRef('tiktok/login@1.0.0').id).toBe('s1')
  })
})
