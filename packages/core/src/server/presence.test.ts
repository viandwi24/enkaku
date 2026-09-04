import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { DisplaySource, InputSink, ServerMessage, Transport } from '@enkaku/protocol'
import type { DeviceSession, SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * Presence (plan 31 §4.2, §31.5) exercised against the REAL activity registry
 * and the REAL `createWsMessageHandler` — not a re-implementation of either
 * — so a regression here is a regression in the actual message-handling
 * code. Only the device session (video) and the DB-agnostic services around
 * the edges (pairing, jobs, recorder, audit) are faked, since presence has
 * nothing to do with any of them.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'online' }).run()
}

function fakeSession(deviceId: string): DeviceSession {
  return {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: {} as unknown as InputSink,
    // Plan 91 §4.1 — `arbiter` is required on `DeviceSession` now; this fixture never sends
    // input.* and never exercises it, so a bare stub keeps the type honest without wiring one up.
    arbiter: {} as unknown as DeviceSession['arbiter'],
    displayEngineId: 'screencap-loop',
    quality: 'control',
    inputEngineId: 'adb-input',
    videoConfig: () => null,
    videoKeyframe: () => null,
    forwardPort: null,
    scrcpyScid: null,
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
    async attachViewer(deviceId) {
      let s = sessions.get(deviceId)
      if (!s) {
        s = fakeSession(deviceId)
        sessions.set(deviceId, s)
      }
      return { session: s, quality: 'wall' as const }
    },
    detachViewer() {},
    async build() {},
    async whenReady(deviceId) {
      let s = sessions.get(deviceId)
      if (!s) {
        s = fakeSession(deviceId)
        sessions.set(deviceId, s)
      }
      return s
    },
    state: () => 'ready' as const,
    get(deviceId) {
      return sessions.get(deviceId) ?? null
    },
    getByQuality(deviceId) {
      return sessions.get(deviceId) ?? null
    },
    async closeDevice() {},
    async closeAll() {
      return 0
    },
    encoders: () => [],
    forwards: () => [],
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
  const activities = createActivityRegistry({ log, controlIdleSec: () => 300, onChange: () => {} })
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
    activities,
    controlSettings: () => ({ overControl: 'allow', idleSec: 300 }),
    states,
    jobs: {
      enqueue: () => {
        throw new Error('not used in this test')
      },
      cancel: () => {
        throw new Error('not used in this test')
      },
      get: () => null,
      list: () => ({ jobs: [], nextCursor: null, total: 0 }),
      // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these presence
      // tests; present only so this fixture keeps satisfying `JobService`.
      nodes: () => ({ items: [], finalized: false }),
      resume: () => {
        throw new Error('not used in this test')
      },
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
    // Nor the crash watcher (plan 37) — exercised in its own suite.
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    db,
    log,
  }
  return { handler: createWsMessageHandler(deps), activities }
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

  test('exactly one viewer ever has holdsControl, sourced from the activity registry — acceptance #6', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { handler, activities } = setUpHandler(db)
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

    // A takes control — the same `control:<clientId>` marker any input.* message touches.
    activities.touchControl('dev-1', aSessionId, { kind: 'user', id: aSessionId, label: 'a' })
    viewers = handler.viewersOf('dev-1')
    expect(viewers).toHaveLength(2)
    const holders = viewers.filter((v) => v.holdsControl)
    expect(holders).toHaveLength(1)
    expect(holders[0]?.sessionId).toBe(aSessionId)
    expect(holders[0]?.sessionId).not.toBe(bSessionId)

    // A's marker ends — the invariant holds at zero, not just at one.
    activities.end('dev-1', `control:${aSessionId}`)
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

    // The same push a control change now drives (plan 205 §4.2's `daemon.ts` wiring calls this
    // exact method from the activity registry's own `onChange`) — exercised directly here, since
    // this test is about the fan-out being scoped to `dev-1`'s viewers, not about what triggers it.
    handler.broadcastViewers('dev-1')

    expect(a.sent.some((m) => m.type === 'device.viewers')).toBe(true)
    expect(bystander.sent.some((m) => m.type === 'device.viewers')).toBe(false)
  })

  test('an idle-timeout sweep clears the marker everywhere (acceptance #7)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    // A plain variable assigned only inside a callback narrows to its
    // initializer's type under TS's control-flow analysis (the write is
    // invisible to the surrounding function) — a property on an object does
    // not, so the swept id is tracked that way instead of fighting the checker.
    const swept: { deviceId: string | null } = { deviceId: null }
    // Mirrors daemon.ts's forward-ref wiring: the activity registry is built
    // before the WS handler exists, but its `onChange` callback must reach
    // the SAME handler's `broadcastViewers` once it does (plan 31 §4.2's
    // sixth trigger, "control marker ends").
    let broadcastDeviceViewers: ((deviceId: string) => void) | null = null
    const activities = createActivityRegistry({
      log,
      // A zero idle timeout so the marker is already overdue the instant the
      // sweep's clock crosses into the next whole second (`updatedAt` and
      // `now` are both computed in unix SECONDS, so a real sub-second wait is
      // not reliably "less than" — the sleep below crosses a full second).
      controlIdleSec: () => 0,
      onChange: (deviceId, change, activity) => {
        if (change === 'ended' && activity.kind === 'control') {
          swept.deviceId = deviceId
          broadcastDeviceViewers?.(deviceId)
        }
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
      activities,
      controlSettings: () => ({ overControl: 'allow', idleSec: 0 }),
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
        // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these presence
        // tests; present only so this fixture keeps satisfying `JobService`.
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
      // Presence has nothing to do with the adb endpoint (plan 27) either — a
      // fake that never actually opens anything is enough for these tests.
      adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
      adb: () => null,
      crashPolicy: () => 'declared',
      targetPackagesForJob: () => [],
      saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
      db,
      log,
    }
    const handler = createWsMessageHandler(deps)
    broadcastDeviceViewers = handler.broadcastViewers
    const a = fakeConn()
    handler.handleOpen(a.ws)
    const aSessionId = sessionIdOf(a.sent)
    await startStream(handler, a.ws, 'dev-1', 's1')
    activities.touchControl('dev-1', aSessionId, { kind: 'user', id: aSessionId, label: 'a' })
    expect(handler.viewersOf('dev-1').some((v) => v.holdsControl)).toBe(true)
    a.sent.length = 0

    // The registry's own idle-timeout sweep — the real path acceptance #7
    // exercises, not a simulation of it.
    activities.startSweep()
    await Bun.sleep(1200)
    activities.stopSweep()
    expect(swept.deviceId).toBe('dev-1')
    expect(handler.viewersOf('dev-1').some((v) => v.holdsControl)).toBe(false)
    // And the viewer actually received the cleared list, not just the fact
    // being true when polled after the fact.
    const lastViewersMsg = [...a.sent].reverse().find((m) => m.type === 'device.viewers')
    expect(lastViewersMsg && lastViewersMsg.type === 'device.viewers' && lastViewersMsg.payload.viewers.some((v) => v.holdsControl)).toBe(false)
  })
})
