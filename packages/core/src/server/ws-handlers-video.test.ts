import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { DisplaySource, InputSink, ServerMessage, Transport } from '@enkaku/protocol'
import type { DeviceSession, SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createLeaseManager } from '../lease/lease-manager'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

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
 * This exercises the REAL `createWsMessageHandler`; only the session and the
 * socket are faked.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'idle' }).run()
}

/**
 * `cached` decides whether this session looks like one whose encoder has
 * already emitted a keyframe — the exact condition the gate reads.
 */
function fakeSession(deviceId: string, cached: { config: Uint8Array | null; keyframe: Uint8Array | null }): {
  session: DeviceSession
  keyframeRequests: number
} {
  const counter = { n: 0 }
  const session: DeviceSession = {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: {} as unknown as InputSink,
    displayEngineId: 'scrcpy',
    quality: 'control',
    inputEngineId: 'adb-input',
    videoConfig: () => cached.config,
    videoKeyframe: () => cached.keyframe,
    requestKeyframe: () => {
      counter.n += 1
    },
    inspector: null,
    whenInspectorReady: async () => {},
    releaseInspector: async () => {},
    inspectorEngineId: 'ui-server',
    inspectorPollIntervalMs: 200,
    frameSize: { width: 1080, height: 2400 },
    clipboard: null,
    close: async () => {},
  }
  return {
    session,
    get keyframeRequests() {
      return counter.n
    },
  }
}

function fakeSessionManager(session: DeviceSession): SessionManager {
  return {
    async acquire() {
      return session
    },
    release() {},
    get: () => session,
    async closeDevice() {},
    async closeIfIdle() {},
    idleSessions: () => [],
    async closeAll() {},
  }
}

function fakeConn(): { ws: ServerWebSocket<unknown>; sent: ServerMessage[]; binary: number } {
  const sent: ServerMessage[] = []
  const state = { binary: 0 }
  const ws = {
    readyState: 1,
    data: { userId: null },
    send: (raw: string | Uint8Array) => {
      if (typeof raw === 'string') sent.push(JSON.parse(raw) as ServerMessage)
      else state.binary += 1
    },
    getBufferedAmount: () => 0,
  } as unknown as ServerWebSocket<unknown>
  return {
    ws,
    sent,
    get binary() {
      return state.binary
    },
  }
}

function setUpHandler(db: Db, session: DeviceSession): ReturnType<typeof createWsMessageHandler> {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const jobStore = createJobStore(db)
  const leases = createLeaseManager({
    states,
    jobStore,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 300, reaperIntervalMs: 5000 },
    log,
    onJobLeaseExpired: () => {},
  })
  const deps = {
    sessions: fakeSessionManager(session),
    db,
    log,
    leases,
    states,
    recorder: { record: () => {} },
    auth: null,
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
