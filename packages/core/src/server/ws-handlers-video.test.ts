import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { DisplaySource, FrameMeta, InputSink, Quality, ServerMessage, Transport } from '@enkaku/protocol'
import { SessionError, buildSentence, type AlwaysOn, type DeviceSession, type FrameSink, type SessionManager, type ViewerHooks } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, MAX_BUFFERED, type WsHandlerDeps } from './ws-handlers'

/**
 * The one rule protecting video start-up: **RESET_VIDEO is never sent to an
 * encoder that has not produced output yet.**
 *
 * Measured on a moto g06 power (Android 15): the control message issued
 * against a session created milliseconds earlier kills the scrcpy server
 * outright — 0 packets and a closed socket, against 143 packets in five
 * seconds without it. The same message 3.8 s later is harmless, which is what
 * makes this so easy to reintroduce: it looks fine on a warm session and
 * fails only on the cold one nobody tests by hand.
 *
 * `stream.start` therefore asks for a fresh IDR only after a cached keyframe
 * proves the encoder is already running (`ws-handlers.ts`, the `stream.start`
 * case). The cost of losing that gate is not a wrong pixel — it is a device
 * whose video never starts, and the symptom appears far from the cause.
 *
 * This exercises the REAL `createWsMessageHandler`; only the session, the
 * `SessionManager` and the socket are faked.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

/**
 * `cached` decides whether this session looks like one whose encoder has
 * already emitted a keyframe — the exact condition the gate reads.
 */
function fakeSession(
  deviceId: string,
  cached: { config: Uint8Array | null; keyframe: Uint8Array | null },
): {
  session: DeviceSession
  keyframeRequests: number
} {
  const counter = { n: 0 }
  const session: DeviceSession = {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: {} as unknown as InputSink,
    // Plan 91 §4.1 — `arbiter` is required on `DeviceSession` now; this fixture never sends
    // input.* and never exercises it, so a bare stub keeps the type honest without wiring one up.
    arbiter: {} as unknown as DeviceSession['arbiter'],
    displayEngineId: 'scrcpy',
    quality: 'control',
    inputEngineId: 'adb-input',
    videoConfig: () => cached.config,
    videoKeyframe: () => cached.keyframe,
    forwardPort: null,
    scrcpyScid: null,
    requestKeyframe: () => {
      counter.n += 1
    },
    inspector: null,
    whenInspectorReady: async () => {},
    prewarmInspector: async () => {},
    inspectorEngineId: 'ui-server',
    inspectorPollIntervalMs: 200,
    frameSize: { width: 1080, height: 2400 },
    clipboard: null,
    textInput: {
      mode: 'device',
      agentCapabilities: null,
      imeCurrent: false,
      commitViaAgent: async () => {
        throw new Error('no guest agent client wired in this fixture')
      },
    },
    onClipboardChanged: () => () => {},
    close: async () => {},
  }
  return {
    session,
    get keyframeRequests() {
      return counter.n
    },
  }
}

/** A single-slot `SessionManager` — `attachViewer` always resolves with `session` at whatever quality it echoes. */
function fakeSessionManager(session: DeviceSession, echoQuality: Quality = 'control'): SessionManager {
  return {
    async acquire() {
      return session
    },
    release() {},
    async attachViewer() {
      return { session, quality: echoQuality }
    },
    detachViewer() {},
    async build() {},
    async whenReady() {
      return session
    },
    state: () => 'ready',
    get: () => session,
    getByQuality: () => session,
    async closeDevice() {},
    async closeAll() {
      return 0
    },
    encoders: () => [],
    forwards: () => [],
  }
}

/** Captures the `onFrame` sink `attachViewer` was given, so a test can simulate a frame arriving. */
function fakeSessionManagerCapturing(session: DeviceSession): { manager: SessionManager; emit: (chunk: Uint8Array, meta: FrameMeta) => void; detachCalls: number } {
  let sink: FrameSink | null = null
  let detachCalls = 0
  const manager: SessionManager = {
    async acquire() {
      return session
    },
    release() {},
    async attachViewer(_deviceId, quality, onFrame) {
      sink = onFrame
      return { session, quality }
    },
    detachViewer() {
      detachCalls++
    },
    async build() {},
    async whenReady() {
      return session
    },
    state: () => 'ready',
    get: () => session,
    getByQuality: () => session,
    async closeDevice() {},
    async closeAll() {
      return 0
    },
    encoders: () => [],
    forwards: () => [],
  }
  return {
    manager,
    emit: (chunk, meta) => sink?.(chunk, meta),
    get detachCalls() {
      return detachCalls
    },
  }
}

function fakeConn(opts?: { sendReturn?: () => number; bufferedAmount?: () => number }): { ws: ServerWebSocket<unknown>; sent: ServerMessage[]; binary: number } {
  const sent: ServerMessage[] = []
  const state = { binary: 0 }
  const ws = {
    readyState: 1,
    data: { userId: null },
    send: (raw: string | Uint8Array): number => {
      if (typeof raw === 'string') {
        sent.push(JSON.parse(raw) as ServerMessage)
        return raw.length
      }
      state.binary += 1
      return opts?.sendReturn ? opts.sendReturn() : raw.byteLength
    },
    getBufferedAmount: () => opts?.bufferedAmount?.() ?? 0,
  } as unknown as ServerWebSocket<unknown>
  return {
    ws,
    sent,
    get binary() {
      return state.binary
    },
  }
}

/** `sessions` lets a caller substitute a scripted fake `SessionManager` instead of the plain single-session one below. `alwaysOn` defaults to a state-less stub. */
function setUpHandler(
  db: Db,
  session: DeviceSession,
  sessions: SessionManager = fakeSessionManager(session),
  extra: Partial<WsHandlerDeps> = {},
): ReturnType<typeof createWsMessageHandler> {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
  const deps = {
    sessions,
    db,
    log,
    activities,
    controlSettings: () => ({ overControl: 'allow' as const, idleSec: 30 }),
    states,
    recorder: { record: () => {} },
    auth: null,
    ...extra,
  } as unknown as WsHandlerDeps
  return createWsMessageHandler(deps)
}

describe('stream.start never resets a cold encoder (plan 17 §3.6)', () => {
  test('no cached keyframe: the fresh-IDR request is withheld — this is the gate that keeps video alive', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const fake = fakeSession('dev-1', { config: null, keyframe: null })
    const handler = setUpHandler(db, fake.session)
    const a = fakeConn()

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'control' } }),
    )

    expect(fake.keyframeRequests).toBe(0)
  })

  test('a cached keyframe proves the encoder is running, so the request goes out', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const fake = fakeSession('dev-1', {
      config: new Uint8Array([0, 0, 0, 1, 0x67]), // SPS
      keyframe: new Uint8Array([0, 0, 0, 1, 0x65]), // IDR
    })
    const handler = setUpHandler(db, fake.session)
    const a = fakeConn()

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'control' } }),
    )

    expect(fake.keyframeRequests).toBe(1)
  })

  test('config alone is not enough — a keyframe is the proof, not SPS/PPS', async () => {
    // SPS/PPS are written when the encoder is configured, which happens
    // before it has encoded anything. Treating config as proof would put the
    // reset back into exactly the cold window that kills the server.
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const fake = fakeSession('dev-1', { config: new Uint8Array([0, 0, 0, 1, 0x67]), keyframe: null })
    const handler = setUpHandler(db, fake.session)
    const a = fakeConn()

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'control' } }),
    )

    expect(fake.keyframeRequests).toBe(0)
  })
})

/**
 * Plan 206 §3.4, §4.3, §4.8 — `stream.start`'s response to `SessionManager.attachViewer`:
 * a `control` request served by the wall entry while the control entry
 * builds (`substitute: 'wall'`), the switch once the control entry's first
 * keyframe arrives (`onSwitched` → `stream.meta` with `quality: 'control'`),
 * and a failed control build (`onControlFailed` → `stream.meta` with
 * `quality: 'wall'` and a `detail`). Drives the REAL `createWsMessageHandler`;
 * only the `SessionManager` and the socket are faked.
 */
describe('stream.start — the encoder split (plan 206 §3.4, §4.3, §4.8)', () => {
  function fakeSwitchingSessionManager(deps: {
    wallSession: DeviceSession
    controlSession?: DeviceSession
    /** Resolves the control build after `attachViewer` returns, simulating the async build/switch. */
    afterAttach?: (hooks: ViewerHooks | undefined, controlSession?: DeviceSession) => void
  }): SessionManager {
    return {
      async acquire() {
        return deps.wallSession
      },
      release() {},
      async attachViewer(_deviceId, quality, _onFrame, hooks) {
        if (quality === 'wall') return { session: deps.wallSession, quality: 'wall' }
        if (deps.afterAttach) {
          queueMicrotask(() => deps.afterAttach!(hooks, deps.controlSession))
        }
        return { session: deps.wallSession, quality: 'wall', substitute: 'wall' }
      },
      detachViewer() {},
      async build() {},
      async whenReady() {
        return deps.wallSession
      },
      state: () => 'ready',
      getByQuality: (_deviceId, quality) => (quality === 'wall' ? deps.wallSession : (deps.controlSession ?? null)),
      get: () => deps.controlSession ?? deps.wallSession,
      async closeDevice() {},
      async closeAll() {
        return 0
      },
      encoders: () => [],
      forwards: () => [],
    }
  }

  test('control attach: started carries substitute wall and primes from the wall entry', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const wall = fakeSession('dev-1', {
      config: new Uint8Array([0, 0, 0, 1, 0x67]),
      keyframe: new Uint8Array([0, 0, 0, 1, 0x65]),
    })
    const manager = fakeSwitchingSessionManager({ wallSession: wall.session })
    const handler = setUpHandler(db, wall.session, manager)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'control' } }))

    const started = a.sent.find((m) => m.type === 'stream.started') as { type: 'stream.started'; payload: { quality: string; substitute?: string } }
    expect(started).toBeDefined()
    expect(started.payload.quality).toBe('wall')
    expect(started.payload.substitute).toBe('wall')
    // Primed from the wall entry's own cached config/keyframe.
    expect(wall.keyframeRequests).toBe(1)
    expect(a.binary).toBeGreaterThan(0)
  })

  test("control attach: the binding switches on the control entry's first keyframe and sends stream.meta", async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const wall = fakeSession('dev-1', { config: null, keyframe: null })
    const control = fakeSession('dev-1', {
      config: new Uint8Array([0, 0, 0, 1, 0x67]),
      keyframe: new Uint8Array([0, 0, 0, 1, 0x65]),
    })
    control.session.frameSize = { width: 1600, height: 720 }
    const manager = fakeSwitchingSessionManager({
      wallSession: wall.session,
      controlSession: control.session,
      afterAttach: (hooks, controlSession) => hooks?.onSwitched?.(controlSession!),
    })
    const handler = setUpHandler(db, wall.session, manager)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'control' } }))
    await Bun.sleep(5) // the switch is announced asynchronously (queueMicrotask above)

    const meta = a.sent.find((m) => m.type === 'stream.meta' && 'quality' in m.payload && m.payload.quality === 'control') as
      | { type: 'stream.meta'; payload: { width: number; height: number; quality?: string } }
      | undefined
    expect(meta).toBeDefined()
    expect(meta?.payload).toMatchObject({ width: 1600, height: 720, quality: 'control' })
    // The control entry's own cached keyframe was primed on the switch.
    expect(control.keyframeRequests).toBe(0) // no extra RESET_VIDEO on switch — the triggering keyframe IS the fresh one
  })

  test('control attach: a failed control build sends stream.meta with quality wall and a detail', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const wall = fakeSession('dev-1', { config: null, keyframe: null })
    const manager = fakeSwitchingSessionManager({
      wallSession: wall.session,
      afterAttach: (hooks) => hooks?.onControlFailed?.('E_SCRCPY_UNAVAILABLE: scrcpy-server could not be started on this device'),
    })
    const handler = setUpHandler(db, wall.session, manager)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'control' } }))
    await Bun.sleep(5)

    const meta = a.sent.find((m) => m.type === 'stream.meta' && 'detail' in m.payload) as
      | { type: 'stream.meta'; payload: { quality?: string; detail?: string } }
      | undefined
    expect(meta).toBeDefined()
    expect(meta?.payload.quality).toBe('wall')
    expect(meta?.payload.detail).toContain('E_SCRCPY_UNAVAILABLE')
  })

  test('stream.start on a device with no base entry answers E_SESSION_PREPARING with the activity sentence', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const wall = fakeSession('dev-1', { config: null, keyframe: null })
    const manager: SessionManager = {
      async acquire() {
        return wall.session
      },
      release() {},
      async attachViewer() {
        throw new SessionError('device_not_ready', 'no base session', { state: 'preparing' })
      },
      detachViewer() {},
      async build() {},
      async whenReady() {
        throw new SessionError('device_not_ready', 'no base session')
      },
      state: () => 'building',
      get: () => null,
      getByQuality: () => null,
      async closeDevice() {},
      async closeAll() {
        return 0
      },
      encoders: () => [],
      forwards: () => [],
    }
    const alwaysOn: Pick<AlwaysOn, 'stateOf'> = { stateOf: () => ({ state: 'preparing', step: 3, attempt: 0, usbRoot: '3' }) }
    const handler = setUpHandler(db, wall.session, manager, { alwaysOn })
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'wall' } }))

    const error = a.sent.find((m) => m.type === 'error') as { type: 'error'; payload: { code: string; message: string } }
    expect(error).toBeDefined()
    expect(error.payload.code).toBe('E_SESSION_PREPARING')
    expect(error.payload.message).toBe(buildSentence({ state: 'preparing', step: 3, attempt: 0 }))
  })

  test('stream.start on an offline row answers device_offline', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'offline')
    const wall = fakeSession('dev-1', { config: null, keyframe: null })
    const manager: SessionManager = {
      async acquire() {
        return wall.session
      },
      release() {},
      async attachViewer() {
        throw new SessionError('device_not_ready', 'the device is offline', { state: 'none' })
      },
      detachViewer() {},
      async build() {},
      async whenReady() {
        throw new SessionError('device_not_ready', 'no base session')
      },
      state: () => 'none',
      get: () => null,
      getByQuality: () => null,
      async closeDevice() {},
      async closeAll() {
        return 0
      },
      encoders: () => [],
      forwards: () => [],
    }
    const handler = setUpHandler(db, wall.session, manager)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'wall' } }))

    const error = a.sent.find((m) => m.type === 'error') as { type: 'error'; payload: { code: string } }
    expect(error).toBeDefined()
    expect(error.payload.code).toBe('device_offline')
  })

  test('stream.stop detaches the viewer; no readiness hold exists', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const wall = fakeSession('dev-1', { config: null, keyframe: null })
    const fake = fakeSessionManagerCapturing(wall.session)
    const handler = setUpHandler(db, wall.session, fake.manager)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'wall' } }))
    const started = a.sent.find((m) => m.type === 'stream.started') as { type: 'stream.started'; payload: { streamId: number } }
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.stop', payload: { streamId: started.payload.streamId } }))

    expect(fake.detachCalls).toBe(1)
  })
})

/**
 * Plan 206 §3.8, §4.8 (R8) — a `ws.send()` returning `0` means Bun dropped
 * the message under backpressure; treated exactly like the buffered-amount
 * congestion check, and `handleDrain` re-asks the instant the socket is
 * writable again rather than waiting for the encoder's next scheduled IDR.
 */
describe('backpressure (plan 206 §3.8, §4.8, R8)', () => {
  function frameMeta(overrides: Partial<FrameMeta> = {}): FrameMeta {
    return { width: 1080, height: 2400, codec: 'h264', seq: 1, ptsUs: 1_000n, hostReceivedAt: Date.now(), keyframe: false, ...overrides }
  }

  test('a send that returns 0 marks the binding awaiting a keyframe', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const fake = fakeSession('dev-1', { config: null, keyframe: null })
    const { manager, emit } = fakeSessionManagerCapturing(fake.session)
    let dropNext = false
    const handler = setUpHandler(db, fake.session, manager)
    const a = fakeConn({ sendReturn: () => (dropNext ? 0 : 100) })

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'wall' } }))
    const requestsBeforeDrop = fake.keyframeRequests

    dropNext = true
    emit(new Uint8Array([1, 2, 3]), frameMeta())

    expect(fake.keyframeRequests).toBe(requestsBeforeDrop + 1)
  })

  test('drain requests a keyframe for every binding that was waiting', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const fake = fakeSession('dev-1', { config: null, keyframe: null })
    const { manager, emit } = fakeSessionManagerCapturing(fake.session)
    let dropNext = true
    const handler = setUpHandler(db, fake.session, manager)
    const a = fakeConn({ sendReturn: () => (dropNext ? 0 : 100) })

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'wall' } }))
    emit(new Uint8Array([1, 2, 3]), frameMeta())
    const requestsAfterDrop = fake.keyframeRequests
    expect(requestsAfterDrop).toBeGreaterThan(0)

    dropNext = false
    handler.handleDrain(a.ws)

    expect(fake.keyframeRequests).toBe(requestsAfterDrop + 1)
  })

  test('backpressure: a dropped send increments framesDroppedTotal (plan 223 §4.7)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const fake = fakeSession('dev-1', { config: null, keyframe: null })
    const { manager, emit } = fakeSessionManagerCapturing(fake.session)
    const handler = setUpHandler(db, fake.session, manager)
    const a = fakeConn({ sendReturn: () => 0 })

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'wall' } }))
    const before = handler.transportStats().framesDroppedTotal
    emit(new Uint8Array([1, 2, 3]), frameMeta())
    expect(handler.transportStats().framesDroppedTotal).toBe(before + 1)
  })

  test('backpressure: a drop-to-keyframe under congestion increments framesDroppedTotal (plan 223 §4.7)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const fake = fakeSession('dev-1', { config: null, keyframe: null })
    const { manager, emit } = fakeSessionManagerCapturing(fake.session)
    const handler = setUpHandler(db, fake.session, manager)
    const a = fakeConn({ bufferedAmount: () => MAX_BUFFERED + 1 })

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1', quality: 'wall' } }))
    const before = handler.transportStats().framesDroppedTotal
    emit(new Uint8Array([1, 2, 3]), frameMeta())
    expect(handler.transportStats().framesDroppedTotal).toBe(before + 1)
  })
})
