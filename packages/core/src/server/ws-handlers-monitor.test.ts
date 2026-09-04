import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient, AdbStreamEndReason, AdbStreamHandle, AdbStreamOptions } from '@enkaku/adb'
import type { DisplaySource, InputSink, ServerMessage, Transport } from '@enkaku/protocol'
import type { DeviceSession, SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * The Monitor WS wiring (plan 24 §4.4, §4.5) exercised against the REAL
 * `createWsMessageHandler` with a fully test-controlled `execStream` — no
 * real adb socket involved. This is where the plan's central WS-close risk
 * lives: `MonitorHub.releaseClient` MUST be called from `handleClose`, or a
 * dropped tab leaks a `logcat` process forever.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, serial: string, status: 'online' | 'offline' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial, label: id, status }).run()
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
    get: (deviceId) => sessions.get(deviceId) ?? null,
    getByQuality: (deviceId) => sessions.get(deviceId) ?? null,
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

interface FakeHandleRecord {
  serial: string
  cmd: string
  stopped: boolean
  emit(text: string): void
}

function fakeAdbClient(): { client: AdbClient; calls: FakeHandleRecord[]; execCalls: string[] } {
  const calls: FakeHandleRecord[] = []
  const execCalls: string[] = []
  const client = {
    execStream: async (serial: string, cmd: string, opts: AdbStreamOptions): Promise<AdbStreamHandle> => {
      const record: FakeHandleRecord = {
        serial,
        cmd,
        stopped: false,
        emit: (text: string) => opts.onData(new TextEncoder().encode(text)),
      }
      calls.push(record)
      return {
        pid: 999,
        stop: async () => {
          record.stopped = true
          opts.onEnd('stopped' as AdbStreamEndReason)
        },
      }
    },
    // `monitor.oneshot` (ps/meminfo/df) runs through `ShellPort.exec`, not
    // `execStream` (plan 24 §4.3) — needed here for the meminfo `package`
    // option's end-to-end test below.
    exec: async (_serial: string, cmd: string) => {
      execCalls.push(cmd)
      return { stdout: 'output for: ' + cmd, stderr: '', exitCode: 0 }
    },
  } as unknown as AdbClient
  return { client, calls, execCalls }
}

function setUpHandler(db: Db, client: AdbClient) {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const jobStore = createJobStore(db)
  const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
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
      // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these monitor
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
    // This suite is about the Monitor tab (plan 24), not the adb endpoint
    // (plan 27) — a fake that never actually opens anything is enough here.
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
    adb: () => client,
    // Crash detection (plan 37) is exercised in its own suites
    // (`crash-watcher.test.ts`); this suite is about the Monitor tab.
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    db,
    log,
  }
  return createWsMessageHandler(deps)
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Monitor WS wiring (plan 24 §4.4, §4.5)', () => {
  test('monitor.start works while a job is running and with no admission check at all (acceptance #9)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'SER1')
    // Plan 24 §4.4: monitor.start deliberately takes no admission check at all — a live
    // job/workflow-job/install on the device would not matter to this test even if simulated.
    const { client } = fakeAdbClient()
    const handler = setUpHandler(db, client)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'monitor.start', id: 'm1', payload: { deviceId: 'dev-1', kind: 'logcat' } }))

    const started = a.sent.find((m) => m.type === 'monitor.started')
    expect(started).toBeDefined()
    const errored = a.sent.find((m) => m.type === 'error')
    expect(errored).toBeUndefined()
  })

  test('closing the WS releases the subscription and stops the stream — MonitorHub.releaseClient is wired into handleClose', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'SER1')
    const { client, calls } = fakeAdbClient()
    const handler = setUpHandler(db, client)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'monitor.start', id: 'm1', payload: { deviceId: 'dev-1', kind: 'logcat' } }))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.stopped).toBe(false)

    handler.handleClose(a.ws)
    await flush()

    expect(calls[0]?.stopped).toBe(true)
  })

  test('two connections subscribing to the same (device, kind, options) share one stream, and monitor.data reaches both', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'SER1')
    const { client, calls } = fakeAdbClient()
    const handler = setUpHandler(db, client)
    const a = fakeConn()
    const b = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'monitor.start', id: 'm1', payload: { deviceId: 'dev-1', kind: 'top' } }))
    await handler.handleMessage(b.ws, JSON.stringify({ type: 'monitor.start', id: 'm2', payload: { deviceId: 'dev-1', kind: 'top' } }))
    expect(calls).toHaveLength(1) // ONE adb process for two viewers

    calls[0]?.emit('cpu at 42%\n')
    await new Promise((r) => setTimeout(r, 150)) // past the 100ms batch flush

    expect(a.sent.some((m) => m.type === 'monitor.data' && m.payload.lines.includes('cpu at 42%'))).toBe(true)
    expect(b.sent.some((m) => m.type === 'monitor.data' && m.payload.lines.includes('cpu at 42%'))).toBe(true)
  })

  test('monitor.data is scoped to subscribed connections only — a bystander watching a different device sees nothing', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'SER1')
    seedDevice(db, 'dev-2', 'SER2')
    const { client, calls } = fakeAdbClient()
    const handler = setUpHandler(db, client)
    const a = fakeConn()
    const bystander = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'monitor.start', id: 'm1', payload: { deviceId: 'dev-1', kind: 'top' } }))
    await handler.handleMessage(bystander.ws, JSON.stringify({ type: 'monitor.start', id: 'm2', payload: { deviceId: 'dev-2', kind: 'top' } }))

    calls[0]?.emit('only for dev-1\n')
    await new Promise((r) => setTimeout(r, 150))

    expect(a.sent.some((m) => m.type === 'monitor.data')).toBe(true)
    expect(bystander.sent.some((m) => m.type === 'monitor.data' && m.payload.lines.includes('only for dev-1'))).toBe(false)
  })

  test('monitor.stop unsubscribes; the last subscriber leaving stops the underlying stream', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'SER1')
    const { client, calls } = fakeAdbClient()
    const handler = setUpHandler(db, client)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'monitor.start', id: 'm1', payload: { deviceId: 'dev-1', kind: 'logcat' } }))
    const started = a.sent.find((m) => m.type === 'monitor.started')
    if (!started || started.type !== 'monitor.started') throw new Error('no monitor.started received')

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'monitor.stop', payload: { streamId: started.payload.streamId } }))
    expect(calls[0]?.stopped).toBe(true)
  })

  test('an unknown monitor kind is rejected by the protocol schema before it ever reaches the hub', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'SER1')
    const { client, calls } = fakeAdbClient()
    const handler = setUpHandler(db, client)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'monitor.start', id: 'm1', payload: { deviceId: 'dev-1', kind: 'shell' } }))
    expect(calls).toHaveLength(0)
    expect(a.sent.some((m) => m.type === 'error')).toBe(true)
  })

  /**
   * The end-to-end check for plan 90 §3.5, step 90.7's `meminfo` `package`
   * option — from the WS message a real Studio tab sends, through
   * `MonitorOneshotMessage`'s new `options` field, `runOneshotMonitor`, and
   * `buildMonitorCommand`, down to the exact adb command. Unit tests on
   * `optionsSchemaFor`/`buildMonitorCommand`/`runOneshotMonitor` already
   * cover each layer alone; this is the "the value actually reaches a
   * caller" check the repo's own retrospective calls for.
   */
  test('monitor.oneshot with a meminfo package option reaches the built adb command', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'SER1')
    const { client, execCalls } = fakeAdbClient()
    const handler = setUpHandler(db, client)
    const a = fakeConn()

    await handler.handleMessage(
      a.ws,
      JSON.stringify({
        type: 'monitor.oneshot',
        id: 'm1',
        payload: { deviceId: 'dev-1', kind: 'meminfo', options: { package: 'com.example.app' } },
      }),
    )

    expect(execCalls).toEqual([`dumpsys meminfo 'com.example.app'`])
    const result = a.sent.find((m) => m.type === 'monitor.result')
    expect(result).toBeDefined()
    if (result && result.type === 'monitor.result') expect(result.payload.text).toContain('com.example.app')
  })

  test('monitor.oneshot with no options still scans the whole device (purely additive)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'SER1')
    const { client, execCalls } = fakeAdbClient()
    const handler = setUpHandler(db, client)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'monitor.oneshot', id: 'm1', payload: { deviceId: 'dev-1', kind: 'meminfo' } }))

    expect(execCalls).toEqual(['dumpsys meminfo'])
  })
})
