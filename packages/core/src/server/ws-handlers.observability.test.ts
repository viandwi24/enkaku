import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { DisplaySource, InputSink, Point, ServerMessage, Transport } from '@enkaku/protocol'
import { createInputArbiter, type DeviceSession, type SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine, type DeviceStateMachine } from '../device/state-machine'
import { createActivityRegistry, type ActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * Step 91.10's own observability: `handler.inputStats()` (`GET /api/adb/stats`'s
 * `input` block) and the rate-limited `E_INPUT_BUSY` warn. Reworked by plan
 * 205 §4.7, §4.9: `InputStatsBlock` now carries only `{ lanes }` — every
 * other field this file used to assert on (the live-grant count, the
 * device-tile-group counts, the leaked-grant count, the group-queue-wait
 * setting) had no producer once the activity model replaced their source
 * subsystems entirely (plan 200 §2.4). Exercised against the REAL
 * `createWsMessageHandler` and REAL `ActivityRegistry`/`DeviceStateMachine`,
 * wired the same way `daemon.ts` does.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, serial: string): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial, label: 'Phone One', status: 'online' }).run()
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

/** A REAL arbiter (plan 91 §4.1) wrapping the given sink, `queueWaitMs`/`maxQueueDepth` overridable per test so the depth-cap refusal is reachable without waiting out a real timeout. */
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

/** The subset of `WsHandlerDeps` every test below shares — factored here since every test in this file needs it. */
function baseDeps(opts: { db: Db; sessions: SessionManager; activities: ActivityRegistry; states: DeviceStateMachine }): WsHandlerDeps {
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
    activities: opts.activities,
    controlSettings: () => ({ overControl: 'allow', idleSec: 30 }),
    states: opts.states,
    jobs: {
      enqueue: () => {
        throw new Error('not used')
      },
      cancel: () => {
        throw new Error('not used')
      },
      get: () => null,
      list: () => ({ jobs: [], nextCursor: null, total: 0 }),
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
    log: createLogger('test'),
  }
}

describe('inputStats() — GET /api/adb/stats\' `input` block (plan 91 §4.10, §5 step 91.10, tests H2/H4; reworked by plan 205 §4.7)', () => {
  test('zero-shaped when nothing has happened — three lanes present, everything zero', () => {
    const db = setUpDb()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
    const sessions = fakeSessionManager(new Map())
    const handler = createWsMessageHandler(baseDeps({ db, sessions, activities, states }))

    const stats = handler.inputStats()
    expect(stats.lanes.pointer).toEqual({ depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 })
    expect(stats.lanes.keys).toEqual({ depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 })
    expect(stats.lanes.text).toEqual({ depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 })
  })

  test('a real tap is reflected: the pointer lane records a completed action (depth back to 0 once it finishes)', async () => {
    const db = setUpDb()
    seedDevice(db, 'd1', 'SER1')
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })

    const { sink } = fakeInputSink()
    const session = fakeSession('d1', sink)
    const sessions = fakeSessionManager(new Map([['d1', session]]))
    const handler = createWsMessageHandler(baseDeps({ db, sessions, activities, states }))

    const { ws } = fakeConn()
    handler.handleOpen(ws)
    await handler.handleMessage(ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }))

    const stats = handler.inputStats()
    expect(stats.lanes.pointer.depth).toBe(0)
    expect(stats.lanes.pointer.refusals).toBe(0)
  })
})

describe('E_INPUT_BUSY rate-limited warn (plan 91 §5 step 91.10)', () => {
  test('a busy pointer lane logs exactly one warn across several refused taps, naming the device and the lane', async () => {
    const db = setUpDb()
    seedDevice(db, 'd1', 'SER1')
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })

    // maxQueueDepth 0: the SECOND concurrent pointer action refuses
    // immediately (E_INPUT_BUSY, depth-cap branch), no real timeout wait needed.
    const { sink, resolve } = hangingInputSink()
    const session = fakeSession('d1', sink, { maxQueueDepth: 0 })
    const sessions = fakeSessionManager(new Map([['d1', session]]))

    const warnings: string[] = []
    const deps = baseDeps({ db, sessions, activities, states })
    deps.log = {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (msg: string) => warnings.push(msg),
      child: () => deps.log,
    }
    const handler = createWsMessageHandler(deps)

    const { ws } = fakeConn()
    handler.handleOpen(ws)

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
