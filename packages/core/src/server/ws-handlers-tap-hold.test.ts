import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { DisplaySource, InputSink, Point, ServerMessage, Transport } from '@enkaku/protocol'
import { createInputArbiter, DEFAULT_TIMING, type DeviceSession, type SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * `input.tap`'s `holdMs` (plan 94 §4.4, closes F4/F5, step 94.2) — exercised
 * against the REAL `createWsMessageHandler` and REAL `ActivityRegistry`, with
 * only the session's input sink faked (mirrors `ws-handlers-clipboard.test.ts`'s
 * own harness shape), so this proves the production `input.tap` branch, not a
 * hand-shaped stand-in for it.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

interface TapCall {
  p: Point
  opts: { holdMs?: [number, number]; rng?: () => number } | undefined
}

/** A spy `InputSink` whose `tap` records the opts it was called with — the one thing the pre-plan-94 fixtures in this directory never needed to check. */
function fakeInputSink(): { sink: InputSink; tapCalls: TapCall[] } {
  const tapCalls: TapCall[] = []
  return {
    tapCalls,
    sink: {
      id: 'fake-input',
      mode: 'uhid',
      tap: async (p, opts) => {
        tapCalls.push({ p, opts })
      },
      swipe: async () => {},
      key: async () => {},
      text: async () => {},
    },
  }
}

/** A REAL arbiter (plan 91 §4.1) wrapping the spy sink above, so `input.tap` exercises the actual production code path. */
function fakeSession(deviceId: string, sink: InputSink): DeviceSession {
  const log = createLogger('test')
  return {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: sink,
    arbiter: createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 10, log }),
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
  } as unknown as DeviceSession
}

function fakeSessionManager(session: DeviceSession | null): SessionManager {
  return {
    async acquire() {
      if (!session) throw new Error('not used')
      return session
    },
    release() {},
    async attachViewer() {
      if (!session) throw new Error('not used')
      return { session, quality: 'wall' as const }
    },
    detachViewer() {},
    async build() {},
    async whenReady() {
      if (!session) throw new Error('not used')
      return session
    },
    state: () => 'ready' as const,
    get: () => session,
    getByQuality: () => session,
    async closeDevice() {},
    async closeAll() {
      return 0
    },
    encoders: () => [],
  }
}

function fakeConn(): { ws: ServerWebSocket<unknown>; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const ws = {
    readyState: 1,
    data: { userId: null },
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
    getBufferedAmount: () => 0,
  } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

function setUpHandler(db: Db, session: DeviceSession | null, tapJitterMs?: WsHandlerDeps['tapJitterMs']): ReturnType<typeof createWsMessageHandler> {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const jobStore = createJobStore(db)
  const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
  const deps: WsHandlerDeps = {
    sessions: fakeSessionManager(session),
    pairing: {
      request: async () => {
        throw new Error('not used')
      },
      submitCode: async () => {
        throw new Error('not used')
      },
    },
    activities,
    controlSettings: () => ({ overControl: 'allow' as const, idleSec: 30 }),
    states,
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
    db,
    log,
    ...(tapJitterMs ? { tapJitterMs } : {}),
  }
  return createWsMessageHandler(deps)
}

describe('input.tap — holdMs (plan 94 §4.4, closes F4/F5, step 94.2)', () => {
  test('a client-measured holdMs reaches sink.tap as an EXACT [holdMs, holdMs] range', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink, tapCalls } = fakeInputSink()
    const handler = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 }, holdMs: 650 } }))

    expect(tapCalls).toHaveLength(1)
    expect(tapCalls[0]!.opts?.holdMs).toEqual([650, 650])
  })

  test('with no holdMs and no tapJitterMs dep wired, falls back to DEFAULT_TIMING.tapJitterMs (closes F5)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink, tapCalls } = fakeInputSink()
    const handler = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))

    expect(tapCalls).toHaveLength(1)
    expect(tapCalls[0]!.opts?.holdMs).toEqual(DEFAULT_TIMING.tapJitterMs)
  })

  test('with no holdMs, a wired tapJitterMs dep is used INSTEAD of DEFAULT_TIMING — read per device id', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink, tapCalls } = fakeInputSink()
    const handler = setUpHandler(db, fakeSession('dev-1', sink), (deviceId) => (deviceId === 'dev-1' ? [777, 888] : [1, 1]))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))

    expect(tapCalls[0]!.opts?.holdMs).toEqual([777, 888])
  })

  test('an explicit holdMs still wins over a wired tapJitterMs dep — the client\'s measured duration is authoritative', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink, tapCalls } = fakeInputSink()
    const handler = setUpHandler(db, fakeSession('dev-1', sink), () => [1, 1])
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 }, holdMs: 42 } }))

    expect(tapCalls[0]!.opts?.holdMs).toEqual([42, 42])
  })
})
