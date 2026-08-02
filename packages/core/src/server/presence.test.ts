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
 * Presence (plan 31 §4.2, §31.5) exercised against the REAL lease manager and
 * the REAL `createWsMessageHandler` — not a re-implementation of either — so
 * a regression here is a regression in the actual message-handling code.
 * Only the device session (video) and the DB-agnostic services around the
 * edges (pairing, jobs, recorder, audit) are faked, since presence has
 * nothing to do with any of them.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'idle' }).run()
}

function fakeSession(deviceId: string): DeviceSession {
  return {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: {} as unknown as InputSink,
    displayEngineId: 'screencap-loop',
    inputEngineId: 'adb-input',
    videoConfig: () => null,
    videoKeyframe: () => null,
    inspector: null,
    whenInspectorReady: async () => {},
    inspectorEngineId: 'ui-server',
    inspectorPollIntervalMs: 200,
    frameSize: { width: 1080, height: 2400 },
    close: async () => {},
  }
}

function fakeSessionManager(): SessionManager {
  const sessions = new Map<string, DeviceSession>()
  return {
    async acquire(deviceId) {
      let s = sessions.get(deviceId)
      if (!s) {
        s = fakeSession(deviceId)
        sessions.set(deviceId, s)
      }
      return s
    },
    release() {},
    get(deviceId) {
      return sessions.get(deviceId) ?? null
    },
    async closeDevice() {},
    async closeAll() {},
  }
}

/** A fake WS connection: captures every message the handler sends it. */
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

function setUpHandler(db: Db) {
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
  const deps: WsHandlerDeps = {
    sessions: fakeSessionManager(),
    pairing: {
      request: async () => {
        throw new Error('not used in this test')
      },
      submitCode: async () => {
        throw new Error('not used in this test')
      },
    },
    leases,
    jobs: {
      enqueue: () => {
        throw new Error('not used in this test')
      },
      cancel: () => {
        throw new Error('not used in this test')
      },
      get: () => null,
      list: () => ({ jobs: [], nextCursor: null, total: 0 }),
    },
    broadcast: () => {},
    recorder: { record: () => {}, stop: async () => {} },
    audit: { record: () => {}, list: () => [] },
    isLogInputTextEnabled: () => false,
    // Presence has nothing to do with the terminal (plan 26) either; admin
    // and 'admin' mode are simply the least-surprising fixture defaults.
    roleOf: () => 'admin',
    shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    // Presence has nothing to do with the adb endpoint (plan 27) either — a
    // fake that never actually opens anything is enough for these tests.
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
    // Presence has nothing to do with the Monitor tab (plan 24); a null adb
    // accessor is exactly what the orchestrator/no-adb-yet state looks like.
    adb: () => null,
    db,
    log,
  }
  return { handler: createWsMessageHandler(deps), leases }
}

/** `sessionId` from the `hello` message `handleOpen` sends right away. */
function sessionIdOf(sent: ServerMessage[]): string {
  const hello = sent.find((m) => m.type === 'hello')
  if (!hello || hello.type !== 'hello') throw new Error('no hello message was sent')
  return hello.payload.sessionId
}

async function startStream(handler: ReturnType<typeof setUpHandler>['handler'], ws: ServerWebSocket<unknown>, deviceId: string, id: string) {
  await handler.handleMessage(ws, JSON.stringify({ type: 'stream.start', id, payload: { deviceId } }))
}

describe('viewersOf / device.viewers (plan 31 §31.5)', () => {
  test('two stream bindings on one device → two viewers, neither holding control', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { handler } = setUpHandler(db)
    const a = fakeConn()
    const b = fakeConn()

    await startStream(handler, a.ws, 'dev-1', 's1')
    await startStream(handler, b.ws, 'dev-1', 's2')

    const viewers = handler.viewersOf('dev-1')
    expect(viewers).toHaveLength(2)
    expect(viewers.every((v) => !v.holdsControl)).toBe(true)
  })

  test('a binding on another device is excluded', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    seedDevice(db, 'dev-2')
    const { handler } = setUpHandler(db)
    const a = fakeConn()
    const b = fakeConn()

    await startStream(handler, a.ws, 'dev-1', 's1')
    await startStream(handler, b.ws, 'dev-2', 's2')

    expect(handler.viewersOf('dev-1')).toHaveLength(1)
    expect(handler.viewersOf('dev-2')).toHaveLength(1)
  })

  test('exactly one viewer ever has holdsControl, sourced from the lease manager — acceptance #6', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { handler } = setUpHandler(db)
    const a = fakeConn()
    const b = fakeConn()

    // `hello` identifies each tab's own sessionId (plan 31 §4.1) — captured
    // here so the assertion below can confirm the RIGHT viewer is marked,
    // not merely that some count is right.
    handler.handleOpen(a.ws)
    handler.handleOpen(b.ws)
    const aSessionId = sessionIdOf(a.sent)
    const bSessionId = sessionIdOf(b.sent)

    await startStream(handler, a.ws, 'dev-1', 's1')
    await startStream(handler, b.ws, 'dev-1', 's2')

    // Nobody holds control yet.
    let viewers = handler.viewersOf('dev-1')
    expect(viewers.filter((v) => v.holdsControl)).toHaveLength(0)

    // A takes control.
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'lease.acquire', id: 'l1', payload: { deviceId: 'dev-1' } }))
    viewers = handler.viewersOf('dev-1')
    expect(viewers).toHaveLength(2)
    const holders = viewers.filter((v) => v.holdsControl)
    expect(holders).toHaveLength(1)
    expect(holders[0]?.sessionId).toBe(aSessionId)
    expect(holders[0]?.sessionId).not.toBe(bSessionId)

    // A releases — the invariant holds at zero, not just at one.
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'lease.release', payload: { deviceId: 'dev-1' } }))
    viewers = handler.viewersOf('dev-1')
    expect(viewers).toHaveLength(2)
    expect(viewers.filter((v) => v.holdsControl)).toHaveLength(0)
  })

  test('a disconnect removes the viewer (acceptance #4)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { handler } = setUpHandler(db)
    const a = fakeConn()
    const b = fakeConn()

    await startStream(handler, a.ws, 'dev-1', 's1')
    await startStream(handler, b.ws, 'dev-1', 's2')
    expect(handler.viewersOf('dev-1')).toHaveLength(2)

    handler.handleClose(b.ws)
    expect(handler.viewersOf('dev-1')).toHaveLength(1)
  })

  test('broadcastViewers only reaches connections watching that device (plan 31 §3.5)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    seedDevice(db, 'dev-2')
    const { handler } = setUpHandler(db)
    const a = fakeConn()
    const bystander = fakeConn()

    await startStream(handler, a.ws, 'dev-1', 's1')
    await startStream(handler, bystander.ws, 'dev-2', 's2')
    a.sent.length = 0
    bystander.sent.length = 0

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'lease.acquire', id: 'l1', payload: { deviceId: 'dev-1' } }))

    expect(a.sent.some((m) => m.type === 'device.viewers')).toBe(true)
    expect(bystander.sent.some((m) => m.type === 'device.viewers')).toBe(false)
  })

  test('an idle-timeout revoke clears the marker everywhere (acceptance #7)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const jobStore = createJobStore(db)
    // A plain variable assigned only inside a callback narrows to its
    // initializer's type under TS's control-flow analysis (the write is
    // invisible to the surrounding function) — a property on an object does
    // not, so the revoked id is tracked that way instead of fighting the checker.
    const revoked: { deviceId: string | null } = { deviceId: null }
    // Mirrors daemon.ts's forward-ref wiring: the lease manager is built
    // before the WS handler exists, but its revoke callback must reach the
    // SAME handler's `broadcastViewers` once it does (plan 31 §4.2's sixth
    // trigger, "lease revoke").
    let broadcastDeviceViewers: ((deviceId: string) => void) | null = null
    const leases = createLeaseManager({
      states,
      jobStore,
      // A zero idle timeout so the lease is already overdue the instant the
      // reaper's clock crosses into the next whole second (expiresAt and
      // `now` are both computed in unix SECONDS, so a real sub-second wait is
      // not reliably "less than" — the sleep below crosses a full second).
      config: { jobTtlSec: 60, manualIdleTimeoutSec: 0, reaperIntervalMs: 100 },
      log,
      onJobLeaseExpired: () => {},
      onManualRevoked: (deviceId) => {
        revoked.deviceId = deviceId
        broadcastDeviceViewers?.(deviceId)
      },
    })
    const deps: WsHandlerDeps = {
      sessions: fakeSessionManager(),
      pairing: {
        request: async () => {
          throw new Error('not used')
        },
        submitCode: async () => {
          throw new Error('not used')
        },
      },
      leases,
      jobs: {
        enqueue: () => {
          throw new Error('not used')
        },
        cancel: () => {
          throw new Error('not used')
        },
        get: () => null,
        list: () => ({ jobs: [], nextCursor: null, total: 0 }),
      },
      broadcast: () => {},
      recorder: { record: () => {}, stop: async () => {} },
      audit: { record: () => {}, list: () => [] },
      isLogInputTextEnabled: () => false,
      roleOf: () => 'admin',
      shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    // Presence has nothing to do with the adb endpoint (plan 27) either — a
    // fake that never actually opens anything is enough for these tests.
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
      adb: () => null,
      db,
      log,
    }
    const handler = createWsMessageHandler(deps)
    broadcastDeviceViewers = handler.broadcastViewers
    const a = fakeConn()
    await startStream(handler, a.ws, 'dev-1', 's1')
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'lease.acquire', id: 'l1', payload: { deviceId: 'dev-1' } }))
    expect(handler.viewersOf('dev-1').some((v) => v.holdsControl)).toBe(true)
    a.sent.length = 0

    // The reaper's manual idle-timeout sweep — the real path acceptance #7
    // exercises, not a simulation of it.
    leases.startReaper()
    await Bun.sleep(1200)
    leases.stopReaper()
    expect(revoked.deviceId).toBe('dev-1')
    expect(handler.viewersOf('dev-1').some((v) => v.holdsControl)).toBe(false)
    // And the viewer actually received the cleared list, not just the fact
    // being true when polled after the fact.
    const lastViewersMsg = [...a.sent].reverse().find((m) => m.type === 'device.viewers')
    expect(lastViewersMsg && lastViewersMsg.type === 'device.viewers' && lastViewersMsg.payload.viewers.some((v) => v.holdsControl)).toBe(false)
  })
})
