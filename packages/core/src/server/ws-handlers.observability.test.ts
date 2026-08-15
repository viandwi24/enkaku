import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { DisplaySource, InputSink, Point, ServerMessage, Transport } from '@enkaku/protocol'
import { createInputArbiter, type DeviceSession, type SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createLeaseManager, type LeaseManager } from '../lease/lease-manager'
import { createCoControlManager, type CoControlGrant, type CoControlManager } from '../lease/co-control'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * Step 91.10's own observability: `handler.inputStats()` (`GET /api/adb/stats`'s
 * `input` block) and the rate-limited `E_INPUT_BUSY` warn. Reuses
 * `ws-handlers.assist.test.ts`'s harness shape (real `LeaseManager`/
 * `CoControlManager`/`DeviceStateMachine`, wired the same way `daemon.ts`
 * does) so this proves the real production code path, not a hand-shaped
 * stand-in for it.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/** A `tap` that never resolves on its own — `resolve()` is exposed so a test can control exactly when it finishes, the only way to deterministically fill an arbiter lane's single "running" slot. */
function hangingInputSink(): { sink: InputSink; resolve: () => void } {
  let resolveFn: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    resolveFn = resolve
  })
  return {
    resolve: resolveFn,
    sink: {
      id: 'fake-input',
      mode: 'uhid',
      tap: async () => pending,
      swipe: async () => {},
      key: async () => {},
      text: async () => {},
    },
  }
}

function fakeInputSink(): { sink: InputSink; tapCalls: Point[] } {
  const tapCalls: Point[] = []
  return {
    tapCalls,
    sink: {
      id: 'fake-input',
      mode: 'uhid',
      tap: async (p) => {
        tapCalls.push(p)
      },
      swipe: async () => {},
      key: async () => {},
      text: async () => {},
    },
  }
}

/** Mirrors `ws-handlers.assist.test.ts`'s own `fakeSession` — a REAL arbiter (plan 91 §4.1) wrapping the given sink, `queueWaitMs`/`maxQueueDepth` overridable per test so the depth-cap refusal is reachable without waiting out a real timeout. */
function fakeSession(deviceId: string, sink: InputSink, opts: { queueWaitMs?: number; maxQueueDepth?: number } = {}): DeviceSession {
  const log = createLogger('test')
  return {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: sink,
    arbiter: createInputArbiter(sink, {
      queueWaitMs: () => opts.queueWaitMs ?? 5_000,
      maxQueueDepth: () => opts.maxQueueDepth ?? 10,
      log,
    }),
    displayEngineId: 'scrcpy',
    quality: 'control',
    inputEngineId: 'scrcpy-uhid',
    videoConfig: () => null,
    videoKeyframe: () => null,
    inspector: null,
    whenInspectorReady: async () => {},
    releaseInspector: async () => {},
    inspectorEngineId: 'ui-server',
    inspectorPollIntervalMs: 200,
    frameSize: { width: 1080, height: 2400 },
    clipboard: null,
    textInput: {
      mode: 'device',
      agentCapabilities: null,
      imeCurrent: false,
      commitViaAgent: async () => {
        throw new Error('not used')
      },
    },
    close: async () => {},
  }
}

function fakeSessionManager(sessionsByDevice: Map<string, DeviceSession>): SessionManager {
  return {
    async acquire(deviceId: string) {
      const s = sessionsByDevice.get(deviceId)
      if (!s) throw new Error(`no fake session for ${deviceId}`)
      return s
    },
    release() {},
    get: (deviceId: string) => sessionsByDevice.get(deviceId) ?? null,
    async closeDevice() {},
    async closeIfIdle() {},
    idleSessions: () => [],
    async closeAll() {
      return 0
    },
    activeDeviceIds: () => [...sessionsByDevice.keys()],
  }
}

function fakeConn(userId: string | null = null): { ws: ServerWebSocket<unknown>; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const ws = {
    readyState: 1,
    data: { userId },
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
    getBufferedAmount: () => 0,
  } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

/** The subset of `WsHandlerDeps` every test below shares — mirrors the boilerplate `ws-handlers.assist.test.ts` already establishes for this exact fixture shape, factored here since every test in this file needs it. */
function baseDeps(opts: {
  db: Db
  sessions: SessionManager
  leases: LeaseManager
  coControl: CoControlManager
  states?: WsHandlerDeps['states']
  mirrorSettings?: WsHandlerDeps['mirrorSettings']
  coControlQueueWaitMs?: () => number
}): WsHandlerDeps {
  return {
    sessions: opts.sessions,
    pairing: {
      request: async () => {
        throw new Error('not used')
      },
      submitCode: async () => {
        throw new Error('not used')
      },
    },
    leases: opts.leases,
    jobs: {
      enqueue: () => {
        throw new Error('not used')
      },
      cancel: () => {
        throw new Error('not used')
      },
      get: () => null,
      list: () => ({ jobs: [], nextCursor: null, total: 0 }),
      assists: () => [],
      nodes: () => ({ items: [], finalized: false }),
      resume: () => {
        throw new Error('not used')
      },
    },
    broadcast: () => {},
    recorder: { record: () => {}, stop: async () => {} },
    audit: { record: () => {}, list: () => [] },
    isLogInputTextEnabled: () => false,
    roleOf: () => 'admin',
    shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
    adb: () => null as unknown as AdbClient,
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    db: opts.db,
    coControl: opts.coControl,
    coControlMode: () => 'operator',
    ...(opts.coControlQueueWaitMs ? { coControlQueueWaitMs: opts.coControlQueueWaitMs } : {}),
    ...(opts.states ? { states: opts.states } : {}),
    ...(opts.mirrorSettings ? { mirrorSettings: opts.mirrorSettings } : {}),
    log: createLogger('test'),
  }
}

describe('inputStats() — GET /api/adb/stats\' `input` block (plan 91 §4.10, §5 step 91.10, tests H2/H4)', () => {
  test('zero-shaped when nothing has happened — three lanes present, everything zero', () => {
    const db = setUpDb()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const leases = createLeaseManager({
      states,
      jobStore: createJobStore(db),
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const coControl = createCoControlManager({ leases, config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1 }, log })
    const sessions = fakeSessionManager(new Map())
    const handler = createWsMessageHandler(baseDeps({ db, sessions, leases, coControl }))

    const stats = handler.inputStats()
    expect(stats.lanes.pointer).toEqual({ depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 })
    expect(stats.lanes.keys).toEqual({ depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 })
    expect(stats.lanes.text).toEqual({ depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 })
    expect(stats.assistsActive).toBe(0)
    expect(stats.mirrorGroups).toBe(0)
    expect(stats.mirrorMembers).toBe(0)
    expect(stats.uncollectedGrants).toBe(0)
    expect(stats.orphanedMirrorGroups).toBe(0)
    expect(stats.queueWaitMs).toBe(5_000)
  })

  test('reports the configured queueWaitMs when coControlQueueWaitMs is wired', () => {
    const db = setUpDb()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const leases = createLeaseManager({
      states,
      jobStore: createJobStore(db),
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const coControl = createCoControlManager({ leases, config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1 }, log })
    const sessions = fakeSessionManager(new Map())
    const handler = createWsMessageHandler(baseDeps({ db, sessions, leases, coControl, coControlQueueWaitMs: () => 9_000 }))
    expect(handler.inputStats().queueWaitMs).toBe(9_000)
  })

  test('a real assist tap is reflected: assistsActive counts the live grant, and the pointer lane records a completed action (depth back to 0 once it finishes)', async () => {
    const db = setUpDb()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' }).run()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const jobStore = createJobStore(db)
    const leases = createLeaseManager({
      states,
      jobStore,
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const coControl = createCoControlManager({ leases, config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1, mode: () => 'operator' }, log })

    states.apply('d1', 'JOB_CLAIMED')
    leases.noteJobLease('d1', 'job-1', 3600)

    const { sink } = fakeInputSink()
    const session = fakeSession('d1', sink)
    const sessions = fakeSessionManager(new Map([['d1', session]]))
    const handler = createWsMessageHandler(baseDeps({ db, sessions, leases, coControl }))

    const { ws, sent } = fakeConn()
    handler.handleOpen(ws)
    const hello = sent.find((m) => m.type === 'hello') as { type: 'hello'; payload: { sessionId: string } } | undefined
    const clientId = hello!.payload.sessionId

    coControl.grant('d1', clientId, 'user-assist')
    await handler.handleMessage(ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }))

    const stats = handler.inputStats()
    expect(stats.assistsActive).toBe(1)
    expect(stats.lanes.pointer.depth).toBe(0)
    expect(stats.lanes.pointer.refusals).toBe(0)
  })

  test('a mirror group is counted in mirrorGroups/mirrorMembers, and flagged orphaned once its owner\'s connection is no longer open (readyState changed without handleClose running)', async () => {
    const db = setUpDb()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' }).run()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const leases = createLeaseManager({
      states,
      jobStore: createJobStore(db),
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const coControl = createCoControlManager({ leases, config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1, mode: () => 'operator' }, log })
    const sessions = fakeSessionManager(new Map([['d1', fakeSession('d1', fakeInputSink().sink)]]))
    const handler = createWsMessageHandler(
      baseDeps({ db, sessions, leases, coControl, states, mirrorSettings: () => ({ maxDevices: 20, requireSameOrientation: true, aspectTolerance: 0.05, dropAfterConsecutiveFailures: 3 }) }),
    )

    const { ws, sent } = fakeConn()
    handler.handleOpen(ws)
    await handler.handleMessage(ws, JSON.stringify({ type: 'mirror.start', payload: { focusDeviceId: 'd1', deviceIds: ['d1'] } }))
    expect(sent.some((m) => m.type === 'mirror.started')).toBe(true)

    const before = handler.inputStats()
    expect(before.mirrorGroups).toBe(1)
    expect(before.mirrorMembers).toBe(1)
    expect(before.orphanedMirrorGroups).toBe(0)

    // Simulate an abrupt disconnect that never reached `handleClose` (a
    // dropped TCP connection, a laptop sleeping mid-session) — the socket's
    // own `readyState` is no longer OPEN, but the group is still live.
    ;(ws as unknown as { readyState: number }).readyState = 3

    const after = handler.inputStats()
    expect(after.mirrorGroups).toBe(1)
    expect(after.orphanedMirrorGroups).toBe(1)
  })

  test('uncollectedGrants counts a grant well past its own expiry (a fake CoControlManager stands in so the 30s grace does not require a real wait)', () => {
    const db = setUpDb()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const leases = createLeaseManager({
      states,
      jobStore: createJobStore(db),
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const staleGrant: CoControlGrant = {
      deviceId: 'd1',
      clientId: 'c1',
      userId: null,
      primaryHolderId: 'job-1',
      primaryKind: 'job',
      jobId: 'job-1',
      grantedAt: Math.floor(Date.now() / 1000) - 400,
      expiresAt: Math.floor(Date.now() / 1000) - 100, // 100s overdue — well past the 30s grace
    }
    const fakeCoControl: CoControlManager = {
      grant: () => {
        throw new Error('not used')
      },
      release: () => false,
      releaseAllForClient: () => {},
      grantsForClient: () => [],
      onPrimaryEnded: () => {},
      touch: () => {},
      checkAssistAllowed: () => ({ ok: false, code: 'no_grant', message: 'no grant' }),
      assistedBy: () => [],
      activeGrantCount: () => 0,
      rawGrantSnapshot: () => [staleGrant],
      startReaper: () => {},
      stopReaper: () => {},
    }
    const sessions = fakeSessionManager(new Map())
    const handler = createWsMessageHandler(baseDeps({ db, sessions, leases, coControl: fakeCoControl }))

    expect(handler.inputStats().uncollectedGrants).toBe(1)
    // activeGrantCount still reports 0 for this farm — the two numbers
    // measure different things (live vs. leaked) and must not be conflated.
    expect(handler.inputStats().assistsActive).toBe(0)
  })
})

describe('E_INPUT_BUSY rate-limited warn (plan 91 §5 step 91.10)', () => {
  test('a busy pointer lane logs exactly one warn across several refused taps, naming the device and the lane', async () => {
    const db = setUpDb()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' }).run()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const jobStore = createJobStore(db)
    const leases = createLeaseManager({
      states,
      jobStore,
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const coControl = createCoControlManager({ leases, config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 2, mode: () => 'operator' }, log })

    states.apply('d1', 'JOB_CLAIMED')
    leases.noteJobLease('d1', 'job-1', 3600)

    // maxQueueDepth 0: the SECOND concurrent pointer action refuses
    // immediately (E_INPUT_BUSY, depth-cap branch), no real timeout wait needed.
    const { sink, resolve } = hangingInputSink()
    const session = fakeSession('d1', sink, { maxQueueDepth: 0 })
    const sessions = fakeSessionManager(new Map([['d1', session]]))

    const warnings: string[] = []
    const deps = baseDeps({ db, sessions, leases, coControl })
    deps.log = {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (msg: string) => warnings.push(msg),
      child: () => deps.log,
    }
    const handler = createWsMessageHandler(deps)

    const { ws, sent } = fakeConn()
    handler.handleOpen(ws)
    const hello = sent.find((m) => m.type === 'hello') as { type: 'hello'; payload: { sessionId: string } } | undefined
    const clientId = hello!.payload.sessionId
    coControl.grant('d1', clientId, 'user-assist')

    // Occupy the pointer lane's one running slot — this promise never resolves on its own.
    const occupying = handler.handleMessage(ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }))

    // Three more taps while the lane is busy — the depth cap (0) refuses each one immediately.
    await handler.handleMessage(ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }))
    await handler.handleMessage(ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }))
    await handler.handleMessage(ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }))

    resolve()
    await occupying

    const busyWarnings = warnings.filter((w) => w.includes('E_INPUT_BUSY'))
    expect(busyWarnings).toHaveLength(1)
    expect(busyWarnings[0]).toContain('d1')
    expect(busyWarnings[0]).toContain('pointer')
  })
})
