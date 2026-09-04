import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { DisplaySource, InputSink, ServerMessage, Transport } from '@enkaku/protocol'
import { createInputArbiter, type DeviceSession, type SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * `device.activity.warning` (MVP 04 §3, plan 205 §4.8, G6) — `input.tap` on a
 * device that already carries a conflicting activity (a running job, here)
 * still reaches the driver: a `warn` decision proceeds and tells, it never
 * blocks. Named `ws-handlers-activity.test.ts` per this plan's own §7.1 —
 * exercised against the REAL `createWsMessageHandler` and REAL
 * `ActivityRegistry`, mirroring `ws-handlers-tap-hold.test.ts`'s harness,
 * with only the session's input sink faked.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

function fakeInputSink(): { sink: InputSink; taps: { count: number } } {
  const taps = { count: 0 }
  return {
    taps,
    sink: {
      id: 'fake-input',
      mode: 'uhid',
      tap: async () => {
        taps.count++
      },
      swipe: async () => {},
      key: async () => {},
      text: async () => {},
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

function setUpHandler(db: Db, session: DeviceSession | null): { handler: ReturnType<typeof createWsMessageHandler>; activities: ReturnType<typeof createActivityRegistry> } {
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
  }
  return { handler: createWsMessageHandler(deps), activities }
}

describe('device.activity.warning — tapping a device a job is running on (G6, plan 205 §4.8)', () => {
  test('the server never refuses for lack of a control marker: the tap lands AND one warning is sent', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink, taps } = fakeInputSink()
    const { handler, activities } = setUpHandler(db, fakeSession('dev-1', sink))
    activities.start('dev-1', { id: 'job:job-1', kind: 'job', label: 'Running tiktok/login (job #1)', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const a = fakeConn()
    handler.handleOpen(a.ws)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))

    expect(a.sent.some((m) => m.type === 'error')).toBe(false)
    expect(taps.count).toBe(1)
    const warning = a.sent.find((m) => m.type === 'device.activity.warning')
    expect(warning).toBeDefined()
    if (warning?.type === 'device.activity.warning') {
      expect(warning.payload.deviceId).toBe('dev-1')
      expect(warning.payload.conflicting?.kind).toBe('job')
    }
  })

  test('five more taps within the same minute deliver five more times but send no further warning', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink, taps } = fakeInputSink()
    const { handler, activities } = setUpHandler(db, fakeSession('dev-1', sink))
    activities.start('dev-1', { id: 'job:job-1', kind: 'job', label: 'Running tiktok/login (job #1)', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const a = fakeConn()
    handler.handleOpen(a.ws)

    for (let i = 0; i < 6; i++) {
      await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))
    }

    expect(taps.count).toBe(6)
    const warnings = a.sent.filter((m) => m.type === 'device.activity.warning')
    expect(warnings).toHaveLength(1)
  })

  test('a bystander connection gets its own warning — the throttle is per connection, not farm-wide', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { sink } = fakeInputSink()
    const { handler, activities } = setUpHandler(db, fakeSession('dev-1', sink))
    activities.start('dev-1', { id: 'job:job-1', kind: 'job', label: 'Running tiktok/login (job #1)', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const a = fakeConn()
    const b = fakeConn()
    handler.handleOpen(a.ws)
    handler.handleOpen(b.ws)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))
    await handler.handleMessage(b.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } } }))

    expect(a.sent.filter((m) => m.type === 'device.activity.warning')).toHaveLength(1)
    expect(b.sent.filter((m) => m.type === 'device.activity.warning')).toHaveLength(1)
  })
})
