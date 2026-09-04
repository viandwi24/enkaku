import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { DisplaySource, InputSink, KeyDescriptor, KeyMeta, Point, ServerMessage, Transport } from '@enkaku/protocol'
import { createInputArbiter, type DeviceSession, type SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * Plan 209 §4.10, §5 step 209.6: the four new input branches (`input.touch`,
 * `input.scroll`, `input.keyEvent`, `input.pinch`), exercised against the
 * REAL `createWsMessageHandler` with a REAL arbiter (modelled on
 * `ws-handlers-tap-hold.test.ts`), so this proves the production coalescing
 * and recording logic, not a hand-shaped stand-in for it.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

interface SinkCall {
  fn: string
  args: unknown[]
}

/** A spy `InputSink` recording every call, with a `resolveNext` gate so a test can block one `touch()` call and release it on demand. */
function fakeInputSink(opts: { touch?: boolean; scroll?: boolean; pinch?: boolean; keyDown?: boolean; keyUp?: boolean } = {}): {
  sink: InputSink
  calls: SinkCall[]
  blockNextTouch(): () => void
} {
  const calls: SinkCall[] = []
  let blocker: Promise<void> | null = null
  const sink: InputSink = {
    id: 'fake-input',
    mode: 'uhid',
    tap: async () => {},
    swipe: async (from: Point, to: Point, ms: number) => {
      calls.push({ fn: 'swipe', args: [from, to, ms] })
    },
    key: async (code: number) => {
      calls.push({ fn: 'key', args: [code] })
    },
    text: async () => {},
    ...(opts.touch !== false
      ? {
          touch: async (action: 'down' | 'move' | 'up', p: Point, pointerId: number) => {
            calls.push({ fn: 'touch', args: [action, p, pointerId] })
            if (blocker) await blocker
          },
        }
      : {}),
    ...(opts.scroll !== false
      ? {
          scroll: async (p: Point, h: number, v: number) => {
            calls.push({ fn: 'scroll', args: [p, h, v] })
          },
        }
      : {}),
    ...(opts.pinch !== false
      ? {
          pinch: async (o: { center: Point; radiusFromPx: number; radiusToPx: number; durationMs: number }) => {
            calls.push({ fn: 'pinch', args: [o] })
          },
        }
      : {}),
    ...(opts.keyDown !== false
      ? {
          keyDown: async (key: KeyDescriptor, meta: KeyMeta) => {
            calls.push({ fn: 'keyDown', args: [key, meta] })
          },
        }
      : {}),
    ...(opts.keyUp !== false
      ? {
          keyUp: async (key: KeyDescriptor, meta: KeyMeta) => {
            calls.push({ fn: 'keyUp', args: [key, meta] })
          },
        }
      : {}),
    releaseKeys: async () => {
      calls.push({ fn: 'releaseKeys', args: [] })
    },
  }
  return {
    sink,
    calls,
    blockNextTouch: () => {
      let release: () => void = () => {}
      blocker = new Promise((resolve) => {
        release = () => {
          blocker = null
          resolve()
        }
      })
      return release
    },
  }
}

function fakeSession(deviceId: string, sink: InputSink): DeviceSession {
  const log = createLogger('test')
  return {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: sink,
    arbiter: createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 32, log }),
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
    frameSize: { width: 1000, height: 2000 },
    clipboard: null,
    textInput: {
      mode: 'device',
      agentCapabilities: null,
      imeCurrent: false,
      commitViaAgent: async () => {
        throw new Error('not used')
      },
    },
    onClipboardChanged: () => () => {},
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

interface RecordCall {
  deviceId: string
  kind: string
  meta: Record<string, unknown> | null
}

function setUpHandler(
  db: Db,
  session: DeviceSession | null,
  opts: { logInputText?: boolean; remote?: boolean } = {},
): { handler: ReturnType<typeof createWsMessageHandler>; records: RecordCall[]; observed: unknown[] } {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const jobStore = createJobStore(db)
  const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
  const records: RecordCall[] = []
  const observed: unknown[] = []
  const deps: WsHandlerDeps = {
    sessions: fakeSessionManager(session),
    ...(opts.remote
      ? { remote: { nodeIdFor: () => 'node-1', acquire: async () => { throw new Error('not used') }, release: () => {}, get: () => null } }
      : {}),
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
    recorder: {
      record: (row: { deviceId: string; kind: string; meta?: Record<string, unknown> | null }) =>
        void records.push({ deviceId: row.deviceId, kind: row.kind, meta: row.meta ?? null }),
      stop: async () => {},
    },
    recording: {
      start: () => {
        throw new Error('not used')
      },
      get: () => ({ observe: (o: unknown) => observed.push(o) }) as unknown as ReturnType<NonNullable<WsHandlerDeps['recording']>['get']>,
      stop: async () => {
        throw new Error('not used')
      },
      cancel: () => {},
      onStep: () => {},
      onBoundStopped: () => {},
    } as unknown as WsHandlerDeps['recording'],
    audit: { record: () => {}, list: () => [] },
    isLogInputTextEnabled: () => opts.logInputText ?? false,
    roleOf: () => 'admin',
    shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
    adb: () => null as unknown as AdbClient,
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    db,
    log,
  }
  return { handler: createWsMessageHandler(deps), records, observed }
}

const touchMsg = (action: 'down' | 'move' | 'up', x: number, y: number, pointerId = 0) => JSON.stringify({
  type: 'input.touch',
  payload: { deviceId: 'dev-1', action, pos: { x, y }, pointerId },
})

describe('input.touch / input.scroll / input.keyEvent / input.pinch (plan 209 §4.10, §5 step 209.6)', () => {
  test('N touch messages reach the sink as N move injections', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink, calls } = fakeInputSink()
    const { handler } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, touchMsg('down', 0.1, 0.1))
    for (let i = 0; i < 40; i++) await handler.handleMessage(a.ws, touchMsg('move', 0.1 + i * 0.001, 0.1))
    await handler.handleMessage(a.ws, touchMsg('up', 0.5, 0.5))

    const touches = calls.filter((c) => c.fn === 'touch')
    expect(touches.filter((c) => c.args[0] === 'down')).toHaveLength(1)
    expect(touches.filter((c) => c.args[0] === 'move')).toHaveLength(40)
    expect(touches.filter((c) => c.args[0] === 'up')).toHaveLength(1)
    // In order: down first, up last.
    expect(touches[0]!.args[0]).toBe('down')
    expect(touches[touches.length - 1]!.args[0]).toBe('up')
  })

  test('moves behind a blocked sink collapse to the newest; up always arrives', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink, calls, blockNextTouch } = fakeInputSink()
    const { handler } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, touchMsg('down', 0.1, 0.1))

    const release = blockNextTouch()
    // Fire 20 moves and an up without awaiting each — the arbiter serialises them.
    const sends: Promise<void>[] = []
    for (let i = 0; i < 20; i++) sends.push(handler.handleMessage(a.ws, touchMsg('move', 0.1 + i * 0.01, 0.1)))
    sends.push(handler.handleMessage(a.ws, touchMsg('up', 0.9, 0.9)))
    // Give the event loop a chance to enqueue everything behind the blocked move.
    await new Promise((r) => setTimeout(r, 20))
    release()
    await Promise.all(sends)

    const touchCalls = calls.filter((c) => c.fn === 'touch')
    const moves = touchCalls.filter((c) => c.args[0] === 'move')
    // The first move (now blocked) plus at most one more collapsed move.
    expect(moves.length).toBeLessThanOrEqual(2)
    expect(touchCalls[touchCalls.length - 1]!.args[0]).toBe('up')
  })

  test('a down, moves, up stream is observed as one gesture', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink } = fakeInputSink()
    const { handler, records, observed } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, touchMsg('down', 0.1, 0.1))
    for (let i = 0; i < 11; i++) await handler.handleMessage(a.ws, touchMsg('move', 0.1 + i * 0.02, 0.1 + i * 0.02))
    await handler.handleMessage(a.ws, touchMsg('up', 0.9, 0.9))

    const gestureRecords = records.filter((r) => r.kind === 'input.gesture')
    expect(gestureRecords).toHaveLength(1)
    expect(gestureRecords[0]!.meta?.samples).toBe(13)
    const gestureObserved = observed.filter((o) => (o as { kind: string }).kind === 'gesture')
    expect(gestureObserved).toHaveLength(1)
    expect((gestureObserved[0] as { samples: Array<{ atMs: number }> }).samples[0]!.atMs).toBe(0)
  })

  test('a down then up with no travel is observed as one tap with holdMs', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink } = fakeInputSink()
    const { handler, records, observed } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, touchMsg('down', 0.5, 0.5))
    await handler.handleMessage(a.ws, touchMsg('up', 0.5, 0.5))

    const tapRecords = records.filter((r) => r.kind === 'input.tap')
    expect(tapRecords).toHaveLength(1)
    expect(typeof tapRecords[0]!.meta?.holdMs).toBe('number')
    expect((tapRecords[0]!.meta!.holdMs as number)).toBeGreaterThanOrEqual(0)
    const tapObserved = observed.filter((o) => (o as { kind: string }).kind === 'tap')
    expect(tapObserved).toHaveLength(1)
  })

  test('a second down on the same pointer closes the first stream with an up', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink, calls } = fakeInputSink()
    const { handler } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, touchMsg('down', 0.1, 0.1))
    await handler.handleMessage(a.ws, touchMsg('down', 0.2, 0.2)) // a lost `up`

    const touches = calls.filter((c) => c.fn === 'touch')
    expect(touches.map((c) => c.args[0])).toEqual(['down', 'up', 'down'])
  })

  test('stream.stop sends up for an open stream and releaseKeys', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink, calls } = fakeInputSink()
    const { handler } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.start', id: 'req-1', payload: { deviceId: 'dev-1', quality: 'control' } }))
    await handler.handleMessage(a.ws, touchMsg('down', 0.1, 0.1))
    const streamId = 1
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'stream.stop', payload: { streamId } }))
    await new Promise((r) => setTimeout(r, 10))

    const touches = calls.filter((c) => c.fn === 'touch')
    expect(touches[touches.length - 1]?.args[0]).toBe('up')
    expect(calls.some((c) => c.fn === 'releaseKeys')).toBe(true)
  })

  test('an input.keyEvent up on a printable key is logged as printable-only when logInputText is off, and with its code when on', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink } = fakeInputSink()
    const off = setUpHandler(db, fakeSession('dev-1', sink), { logInputText: false })
    const a = fakeConn()
    off.handler.handleOpen(a.ws)
    const meta = { shift: false, ctrl: false, alt: false, meta: false }
    await off.handler.handleMessage(a.ws, JSON.stringify({ type: 'input.keyEvent', payload: { deviceId: 'dev-1', action: 'down', code: 'KeyH', meta } }))
    await off.handler.handleMessage(a.ws, JSON.stringify({ type: 'input.keyEvent', payload: { deviceId: 'dev-1', action: 'up', code: 'KeyH', meta } }))
    const offRecord = off.records.find((r) => r.kind === 'input.keyEvent')
    expect(offRecord?.meta).toEqual({ printable: true })

    const { sink: sink2 } = fakeInputSink()
    const on = setUpHandler(db, fakeSession('dev-1', sink2), { logInputText: true })
    const b = fakeConn()
    on.handler.handleOpen(b.ws)
    await on.handler.handleMessage(b.ws, JSON.stringify({ type: 'input.keyEvent', payload: { deviceId: 'dev-1', action: 'down', code: 'KeyH', meta } }))
    await on.handler.handleMessage(b.ws, JSON.stringify({ type: 'input.keyEvent', payload: { deviceId: 'dev-1', action: 'up', code: 'KeyH', meta } }))
    const onRecord = on.records.find((r) => r.kind === 'input.keyEvent')
    expect(onRecord?.meta?.code).toBe('KeyH')
  })

  test('a sink without touch replays the stream as one swipe on up', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink, calls } = fakeInputSink({ touch: false })
    const { handler } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, touchMsg('down', 0.1, 0.1))
    await handler.handleMessage(a.ws, touchMsg('move', 0.5, 0.5))
    await handler.handleMessage(a.ws, touchMsg('up', 0.9, 0.9))

    const swipes = calls.filter((c) => c.fn === 'swipe')
    expect(swipes).toHaveLength(1)
  })

  test('input.scroll and input.pinch answer E_INPUT_UNSUPPORTED on a sink without them', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink } = fakeInputSink({ scroll: false, pinch: false })
    const { handler } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'input.scroll', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 }, hDelta: 0, vDelta: 1 } }),
    )
    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'input.pinch', payload: { deviceId: 'dev-1', center: { x: 0.5, y: 0.5 }, scaleFrom: 0.1, scaleTo: 0.2 } }),
    )
    const errors = a.sent.filter((m) => m.type === 'error')
    expect(errors).toHaveLength(2)
    expect(errors.every((e) => (e as unknown as { payload: { code: string } }).payload.code === 'E_INPUT_UNSUPPORTED')).toBe(true)
  })

  test('a keyEvent on a sink without keyDown presses the Android keycode on up only', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink, calls } = fakeInputSink({ keyDown: false, keyUp: false })
    const { handler } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    const meta = { shift: false, ctrl: false, alt: false, meta: false }
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.keyEvent', payload: { deviceId: 'dev-1', action: 'down', code: 'KeyA', meta } }))
    expect(calls.filter((c) => c.fn === 'key')).toHaveLength(0)
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.keyEvent', payload: { deviceId: 'dev-1', action: 'up', code: 'KeyA', meta } }))
    expect(calls.filter((c) => c.fn === 'key')).toHaveLength(1)
    expect(calls.find((c) => c.fn === 'key')!.args[0]).toBe(29)
  })

  test('a node-owned device answers E_NOT_SUPPORTED for input.touch', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink } = fakeInputSink()
    const { handler } = setUpHandler(db, fakeSession('dev-1', sink), { remote: true })
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, touchMsg('down', 0.1, 0.1))
    const errors = a.sent.filter((m) => m.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0] as unknown as { payload: { code: string } }).payload.code).toBe('E_NOT_SUPPORTED')
  })

  test('inputDispatchStats reports p50/p95 after touch messages', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { sink } = fakeInputSink()
    const { handler } = setUpHandler(db, fakeSession('dev-1', sink))
    const a = fakeConn()
    handler.handleOpen(a.ws)
    await handler.handleMessage(a.ws, touchMsg('down', 0.1, 0.1))
    await handler.handleMessage(a.ws, touchMsg('up', 0.5, 0.5))
    const stats = handler.inputDispatchStats('dev-1')
    expect(stats).not.toBeNull()
    expect(stats!.samples).toBeGreaterThanOrEqual(2)
    expect(stats!.dispatchMsP50).toBeGreaterThanOrEqual(0)
    expect(stats!.dispatchMsP95).toBeGreaterThanOrEqual(0)
  })
})
