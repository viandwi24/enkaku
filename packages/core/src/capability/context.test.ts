import { describe, expect, test } from 'bun:test'
import { DEFAULT_TIMING, type DeviceSession } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices, scripts } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry } from '../scripts/registry'
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

/** A minimal `LeaseManager` fake — only `getLease` is read by `context.ts`. */
function fakeLeases(lease: { holder: string; holderUserId: string | null; type: 'manual' | 'job' } | null) {
  return {
    getLease: () => (lease ? { deviceId: 'd1', acquiredAt: 0, expiresAt: 0, ...lease } : null),
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

function fakeSession(overrides: Partial<DeviceSession> = {}): DeviceSession {
  return {
    deviceId: 'd1',
    transport: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }), execOut: async () => new Uint8Array() },
    input: { tap: async () => {}, swipe: async () => {}, key: async () => {}, text: async () => {} },
    inspector: null,
    frameSize: { width: 1080, height: 1920 },
    clipboard: null,
    ...overrides,
  } as unknown as DeviceSession
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
