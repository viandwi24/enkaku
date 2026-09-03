import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { DisplaySource, InputSink, Point, RecordingSettings, ServerMessage, Transport } from '@enkaku/protocol'
import { createInputArbiter, type DeviceSession, type SessionManager } from '@enkaku/session'
import { createBlobStore } from '../agent/blob/store'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createRecordingService, type RecordingService } from '../recording/service'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * The recorder's WS surface (plan 94 §4.6, §4.9, step 94.3) — exercised
 * against the REAL `createWsMessageHandler`, the REAL `ActivityRegistry`, and
 * the REAL `RecordingService`, with only the session's input sink faked
 * (mirrors `ws-handlers-tap-hold.test.ts`'s own harness). This is what proves
 * the step's own verifiable result end to end, with no device: on a
 * controlled device, `recording.start` then thirty taps and two drags
 * produces a `RecordingDoc` with thirty-two steps, real `gapMs` values,
 * sampled gesture traces; `recording.start` on a device that already has one
 * open returns `E_RECORDING_ACTIVE`.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `Label ${id}`, status }).run()
}

interface TapCall {
  p: Point
  opts: { holdMs?: [number, number]; rng?: () => number } | undefined
}

function fakeInputSink(): { sink: InputSink; tapCalls: TapCall[]; gestureCalls: unknown[][] } {
  const tapCalls: TapCall[] = []
  const gestureCalls: unknown[][] = []
  return {
    tapCalls,
    gestureCalls,
    sink: {
      id: 'fake-input',
      mode: 'uhid',
      tap: async (p, opts) => {
        tapCalls.push({ p, opts })
      },
      swipe: async () => {},
      key: async () => {},
      text: async () => {},
      gesture: async (samples) => {
        gestureCalls.push(samples)
      },
    },
  }
}

/** Mirrors `ws-handlers-tap-hold.test.ts`'s own `fakeSession` — a REAL arbiter wrapping the spy sink, no inspector (recording degrades to no anchors/no screenshots, exactly as production does when nothing has attached one). */
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
    get: () => session,
    async closeDevice() {},
    async closeIfIdle() {},
    idleSessions: () => [],
    async closeAll() {
      return 0
    },
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

function makeRecordingService(overrides: Partial<RecordingSettings> = {}): RecordingService {
  return createRecordingService({
    settings: () => ({
      anchorQuietMs: 400,
      anchorMinIntervalMs: 1_500,
      longPressMs: 400,
      maxSteps: 500,
      maxDurationSec: 900,
      captureScreenshots: false,
      ...overrides,
    }),
    blobs: createBlobStore(setUpDb()),
    log: createLogger('test'),
  })
}

function setUpHandler(
  db: Db,
  session: DeviceSession | null,
  recording?: RecordingService,
  overControl: 'allow' | 'warn' | 'forbid' = 'allow',
): ReturnType<typeof createWsMessageHandler> {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
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
    controlSettings: () => ({ overControl, idleSec: 30 }),
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
    ...(recording ? { recording } : {}),
  }
  return createWsMessageHandler(deps)
}

describe('recording.* — the recorder\'s WS surface (plan 94 §4.6, §4.9, step 94.3)', () => {
  test('the verifiable result: 30 taps and 2 drags produce a 32-step RecordingDoc with real gaps and sampled gesture traces', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink } = fakeInputSink()
    const recording = makeRecordingService()
    const handler = setUpHandler(db, fakeSession('dev-1', sink), recording)
    const a = fakeConn()
    handler.handleOpen(a.ws)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'recording.start', id: 'r1', payload: { deviceId: 'dev-1' } }))
    const startReply = a.sent.find((m) => m.type === 'recording.state' && m.id === 'r1')
    expect(startReply?.type === 'recording.state' ? startReply.payload : undefined).toMatchObject({ active: true, stepCount: 0 })

    for (let i = 0; i < 30; i++) {
      await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))
    }
    for (let i = 0; i < 2; i++) {
      await handler.handleMessage(
        a.ws,
        JSON.stringify({
          type: 'input.gesture',
          payload: {
            deviceId: 'dev-1',
            samples: [
              { x: 0.2, y: 0.8, atMs: 0 },
              { x: 0.4, y: 0.5, atMs: 80 },
              { x: 0.6, y: 0.2, atMs: 180 },
            ],
          },
        }),
      )
    }

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'recording.stop', id: 'r2', payload: { deviceId: 'dev-1' } }))
    const stopReply = a.sent.find((m) => m.type === 'recording.state' && m.id === 'r2')
    expect(stopReply?.type === 'recording.state' ? stopReply.payload : undefined).toMatchObject({ active: false, stepCount: 32 })

    const doc = recording.lastFinished('dev-1')
    expect(doc).not.toBeNull()
    expect(doc?.steps).toHaveLength(32)
    expect(doc?.steps.filter((s) => s.kind === 'tap')).toHaveLength(30)
    const gestures = doc?.steps.filter((s) => s.kind === 'gesture') ?? []
    expect(gestures).toHaveLength(2)
    for (const g of gestures) {
      if (g.kind !== 'gesture') continue
      expect(g.samples).toEqual([
        { x: 0.2, y: 0.8, atMs: 0 },
        { x: 0.4, y: 0.5, atMs: 80 },
        { x: 0.6, y: 0.2, atMs: 180 },
      ])
    }
    // Real gaps: every step after the first carries a genuine (non-negative) elapsed time — never a placeholder.
    expect(doc?.steps.every((s) => typeof s.gapMs === 'number' && s.gapMs >= 0)).toBe(true)
  })

  test('recording.start on a device that already has one open returns E_RECORDING_ACTIVE', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink } = fakeInputSink()
    const recording = makeRecordingService()
    const handler = setUpHandler(db, fakeSession('dev-1', sink), recording)
    const a = fakeConn()
    handler.handleOpen(a.ws)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'recording.start', id: 'r1', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'recording.start', id: 'r2', payload: { deviceId: 'dev-1' } }))

    const err = a.sent.find((m) => m.type === 'error' && m.id === 'r2')
    expect(err).toMatchObject({ type: 'error', payload: { code: 'E_RECORDING_ACTIVE' } })
  })

  test('with control.overControl: forbid, recording.start for a second client is refused by the SAME `control` activity gate input.* uses — never a parallel check', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink } = fakeInputSink()
    const recording = makeRecordingService()
    const handler = setUpHandler(db, fakeSession('dev-1', sink), recording, 'forbid')
    const holder = fakeConn()
    const bystander = fakeConn()
    handler.handleOpen(holder.ws)
    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))
    handler.handleOpen(bystander.ws)

    await handler.handleMessage(bystander.ws, JSON.stringify({ type: 'recording.start', id: 'r1', payload: { deviceId: 'dev-1' } }))
    const reply = bystander.sent.find((m) => m.type === 'error' && m.id === 'r1')
    expect(reply).toMatchObject({ type: 'error', payload: { code: 'E_DEVICE_CONFLICT' } })
    expect(recording.get('dev-1')).toBeNull()
  })

  test('recording.cancel discards — no document, the device is free again', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink } = fakeInputSink()
    const recording = makeRecordingService()
    const handler = setUpHandler(db, fakeSession('dev-1', sink), recording)
    const a = fakeConn()
    handler.handleOpen(a.ws)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'recording.start', id: 'r1', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'recording.cancel', id: 'r2', payload: { deviceId: 'dev-1' } }))

    expect(recording.get('dev-1')).toBeNull()
    expect(recording.lastFinished('dev-1')).toBeNull()
    // The device is free again — a fresh recording.start succeeds.
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'recording.start', id: 'r3', payload: { deviceId: 'dev-1' } }))
    const reply = a.sent.find((m) => m.type === 'recording.state' && m.id === 'r3')
    expect(reply).toMatchObject({ type: 'recording.state', payload: { active: true } })
  })

  test('recording.stop with nothing open returns E_NO_RECORDING', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink } = fakeInputSink()
    const recording = makeRecordingService()
    const handler = setUpHandler(db, fakeSession('dev-1', sink), recording)
    const a = fakeConn()
    handler.handleOpen(a.ws)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'recording.stop', id: 'r1', payload: { deviceId: 'dev-1' } }))
    const reply = a.sent.find((m) => m.type === 'error' && m.id === 'r1')
    expect(reply).toMatchObject({ type: 'error', payload: { code: 'E_NO_RECORDING' } })
  })

  test('recording.* refuses E_NOT_SUPPORTED when the host has not wired plan 94 at all', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink } = fakeInputSink()
    const handler = setUpHandler(db, fakeSession('dev-1', sink)) // no `recording` dep
    const a = fakeConn()
    handler.handleOpen(a.ws)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'recording.start', id: 'r1', payload: { deviceId: 'dev-1' } }))
    const reply = a.sent.find((m) => m.type === 'error' && m.id === 'r1')
    expect(reply).toMatchObject({ type: 'error', payload: { code: 'E_NOT_SUPPORTED' } })
  })

  test('property 1 — the tee observes, never alters: sink.tap receives byte-identical args whether recording is wired or not', async () => {
    const db1 = setUpDb()
    seedDevice(db1, 'dev-1', 'online')
    const { sink: sinkOff, tapCalls: callsOff } = fakeInputSink()
    const handlerOff = setUpHandler(db1, fakeSession('dev-1', sinkOff)) // no recording dep at all
    const a1 = fakeConn()
    handlerOff.handleOpen(a1.ws)
    await handlerOff.handleMessage(a1.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.37, y: 0.81 }, holdMs: 123 } }))

    const db2 = setUpDb()
    seedDevice(db2, 'dev-1', 'online')
    const { sink: sinkOn, tapCalls: callsOn } = fakeInputSink()
    const handlerOn = setUpHandler(db2, fakeSession('dev-1', sinkOn), makeRecordingService())
    const a2 = fakeConn()
    handlerOn.handleOpen(a2.ws)
    // Recording is not even started here — the tee is `deps.recording?.get(deviceId)?.observe(...)`,
    // a no-op with no active session, proving the CALL SITE itself adds nothing when idle.
    await handlerOn.handleMessage(a2.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.37, y: 0.81 }, holdMs: 123 } }))

    expect(callsOn).toEqual(callsOff)

    // And WITH an active recording, still byte-identical — observe() never mutates what is sent.
    const recording = makeRecordingService()
    const db3 = setUpDb()
    seedDevice(db3, 'dev-1', 'online')
    const { sink: sinkRec, tapCalls: callsRec } = fakeInputSink()
    const handlerRec = setUpHandler(db3, fakeSession('dev-1', sinkRec), recording)
    const a3 = fakeConn()
    handlerRec.handleOpen(a3.ws)
    await handlerRec.handleMessage(a3.ws, JSON.stringify({ type: 'recording.start', payload: { deviceId: 'dev-1' } }))
    await handlerRec.handleMessage(a3.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.37, y: 0.81 }, holdMs: 123 } }))

    expect(callsRec).toEqual(callsOff)
  })

  test('maxSteps ends a recording cleanly, with a recording.state push naming the reason — never a silent truncation', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink } = fakeInputSink()
    const recording = makeRecordingService({ maxSteps: 3 })
    const handler = setUpHandler(db, fakeSession('dev-1', sink), recording)
    const a = fakeConn()
    const broadcasts: ServerMessage[] = []
    // Rewire broadcast to capture the bound-triggered push (the reply channel above only captures unicast `send`s).
    const handlerWithBroadcast = (() => {
      const log = createLogger('test')
      const states = createDeviceStateMachine({ db, log })
      const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
      const deps: WsHandlerDeps = {
        sessions: fakeSessionManager(fakeSession('dev-1', sink)),
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
        broadcast: (msg) => broadcasts.push(msg),
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
        recording,
      }
      return createWsMessageHandler(deps)
    })()
    handlerWithBroadcast.handleOpen(a.ws)
    await handlerWithBroadcast.handleMessage(a.ws, JSON.stringify({ type: 'recording.start', payload: { deviceId: 'dev-1' } }))
    for (let i = 0; i < 5; i++) {
      await handlerWithBroadcast.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))
    }
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const bound = broadcasts.find((m) => m.type === 'recording.state') as Extract<ServerMessage, { type: 'recording.state' }> | undefined
    expect(bound?.payload).toMatchObject({ deviceId: 'dev-1', active: false, stepCount: 3, stoppedReason: 'max-steps' })
    expect(recording.get('dev-1')).toBeNull()
    expect(recording.lastFinished('dev-1')?.steps).toHaveLength(3)
  })
})
