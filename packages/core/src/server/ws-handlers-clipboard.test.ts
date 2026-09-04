import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
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
 * `clipboard.get`/`clipboard.set` WS wiring (plan 38 §4.5, §6, reworked by
 * plan 205 §4.9): `get` needs no admission at all; `set` takes the `control`
 * activity policy row (the same "touch" op `input.*` gets) — a bare online
 * device always passes, and a second controller only ever WARNS or FORBIDS
 * depending on the farm's `control.overControl` setting, never on whether a
 * job happens to be running (`control` warns, never forbids, against a live
 * job). The reply is unicast to the requesting connection only, never
 * broadcast to every viewer (acceptance #6); and the audit event for a `set`
 * records only the text LENGTH, never the text itself (acceptance #7).
 * Exercised against the REAL `createWsMessageHandler` and REAL
 * `ActivityRegistry`, with only the session and its clipboard faked —
 * mirrors `ws-handlers-shell.test.ts`.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

/** A scriptable in-memory clipboard: `get`/`set` are both spies with configurable behaviour. */
function fakeClipboard(opts?: { value?: string; getFails?: unknown; setFails?: unknown }) {
  const setCalls: Array<{ text: string; paste?: boolean }> = []
  return {
    setCalls,
    clipboard: {
      async get() {
        if (opts?.getFails) throw opts.getFails
        return opts?.value ?? ''
      },
      async set(text: string, setOpts?: { paste?: boolean }) {
        if (opts?.setFails) throw opts.setFails
        setCalls.push({ text, ...(setOpts ? { paste: setOpts.paste } : {}) })
      },
    },
  }
}

function fakeSession(deviceId: string, clipboard: DeviceSession['clipboard']): DeviceSession {
  return {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: {} as unknown as InputSink,
    // Plan 91 §4.1 — `arbiter` is required on `DeviceSession` now; this fixture never sends
    // input.* and never exercises it, so a bare stub keeps the type honest without wiring one up.
    arbiter: {} as unknown as DeviceSession['arbiter'],
    displayEngineId: 'scrcpy',
    quality: 'control',
    inputEngineId: 'scrcpy-uhid',
    videoConfig: () => null,
    videoKeyframe: () => null,
    inspector: null,
    whenInspectorReady: async () => {},
    prewarmInspector: async () => {},
    inspectorEngineId: 'ui-server',
    inspectorPollIntervalMs: 200,
    frameSize: { width: 1080, height: 2400 },
    clipboard,
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

interface RecordedEvent {
  deviceId: string
  stream: string
  kind: string
  actor?: string | null
  meta?: Record<string, unknown>
}

function setUpHandler(
  db: Db,
  session: DeviceSession | null,
  overControl: 'allow' | 'warn' | 'forbid' = 'allow',
): { handler: ReturnType<typeof createWsMessageHandler>; events: RecordedEvent[]; activities: ReturnType<typeof createActivityRegistry> } {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const jobStore = createJobStore(db)
  const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
  const events: RecordedEvent[] = []
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
      // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these clipboard
      // tests; present only so this fixture keeps satisfying `JobService`.
      nodes: () => ({ items: [], finalized: false }),
      resume: () => {
        throw new Error('not used')
      },
    },
    broadcast: () => {},
    recorder: { record: (e) => void events.push(e), stop: async () => {} },
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
  return { handler: createWsMessageHandler(deps), events, activities }
}

describe('clipboard.get (plan 38 §4.5, acceptance #5)', () => {
  test('works with no admission at all', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { clipboard } = fakeClipboard({ value: 'on the device' })
    const { handler } = setUpHandler(db, fakeSession('dev-1', clipboard))
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'clipboard.get', id: 'g1', payload: { deviceId: 'dev-1' } }))

    expect(a.sent.some((m) => m.type === 'error')).toBe(false)
    const value = a.sent.find((m) => m.type === 'clipboard.value')
    expect(value).toBeDefined()
    if (value?.type === 'clipboard.value') expect(value.payload.text).toBe('on the device')
  })

  test('no active session → E_DEVICE_NOT_READY, not an admission error', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { handler } = setUpHandler(db, null)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'clipboard.get', id: 'g1', payload: { deviceId: 'dev-1' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_DEVICE_NOT_READY')
  })

  test('the screencap-loop fallback (session.clipboard null) refuses reads with E_CLIPBOARD_UNAVAILABLE, never an empty string (plan 38 §3.5, acceptance #8)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { handler } = setUpHandler(db, fakeSession('dev-1', null))
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'clipboard.get', id: 'g1', payload: { deviceId: 'dev-1' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_CLIPBOARD_UNAVAILABLE')
    expect(a.sent.some((m) => m.type === 'clipboard.value')).toBe(false)
  })

  test('the request id correlates the reply (clipboard.value carries the same id)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { clipboard } = fakeClipboard({ value: 'x' })
    const { handler } = setUpHandler(db, fakeSession('dev-1', clipboard))
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'clipboard.get', id: 'my-id-42', payload: { deviceId: 'dev-1' } }))

    const value = a.sent.find((m) => m.type === 'clipboard.value')
    if (value?.type === 'clipboard.value') expect(value.id).toBe('my-id-42')
    else throw new Error('no clipboard.value received')
  })
})

describe('clipboard.set (plan 38 §4.5, acceptance #5, #7; admission reworked by plan 205 §4.9)', () => {
  test('a running job only warns, never forbids — clipboard.set still succeeds', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { clipboard, setCalls } = fakeClipboard()
    const { handler, events, activities } = setUpHandler(db, fakeSession('dev-1', clipboard))
    activities.start('dev-1', { id: 'job:j1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'clipboard.set', id: 's1', payload: { deviceId: 'dev-1', text: 'x' } }))

    expect(a.sent.some((m) => m.type === 'error')).toBe(false)
    expect(setCalls).toHaveLength(1)
    expect(events).toHaveLength(1)
  })

  test('control.overControl: forbid — a second client is refused, named E_DEVICE_CONFLICT, and nothing is written or recorded', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { clipboard, setCalls } = fakeClipboard()
    const { handler, events } = setUpHandler(db, fakeSession('dev-1', clipboard), 'forbid')
    const holder = fakeConn()
    const bystander = fakeConn()

    handler.handleOpen(holder.ws)
    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'clipboard.set', id: 's0', payload: { deviceId: 'dev-1', text: 'mine' } }))
    events.length = 0
    handler.handleOpen(bystander.ws)
    await handler.handleMessage(bystander.ws, JSON.stringify({ type: 'clipboard.set', id: 's1', payload: { deviceId: 'dev-1', text: 'x' } }))

    const err = bystander.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_DEVICE_CONFLICT')
    expect(setCalls).toHaveLength(1)
    expect(events).toHaveLength(0)
  })

  test('the device receives the text, paste defaults to false, and clipboard.ok replies with the matching id', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { clipboard, setCalls } = fakeClipboard()
    const { handler } = setUpHandler(db, fakeSession('dev-1', clipboard))
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'clipboard.set', id: 's1', payload: { deviceId: 'dev-1', text: 'hello clipboard' } }))

    expect(a.sent.some((m) => m.type === 'error')).toBe(false)
    expect(setCalls).toEqual([{ text: 'hello clipboard', paste: false }])
    const ok = a.sent.find((m) => m.type === 'clipboard.ok')
    if (ok?.type === 'clipboard.ok') expect(ok.id).toBe('s1')
    else throw new Error('no clipboard.ok received')
  })

  test('paste: true reaches the device unchanged', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { clipboard, setCalls } = fakeClipboard()
    const { handler } = setUpHandler(db, fakeSession('dev-1', clipboard))
    const a = fakeConn()

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'clipboard.set', id: 's1', payload: { deviceId: 'dev-1', text: 'paste me', paste: true } }),
    )

    expect(setCalls).toEqual([{ text: 'paste me', paste: true }])
  })

  test('the audit event records the LENGTH, never the text (plan 38 §3.6, §4.5, acceptance #7)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { clipboard } = fakeClipboard()
    const { handler, events } = setUpHandler(db, fakeSession('dev-1', clipboard))
    const a = fakeConn()

    events.length = 0
    const secret = 'hunter2-the-password'
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'clipboard.set', id: 's1', payload: { deviceId: 'dev-1', text: secret } }))

    const rec = events.find((e) => e.kind === 'clipboard.set')
    expect(rec).toBeDefined()
    expect(rec?.stream).toBe('input')
    expect(rec?.meta?.length).toBe(secret.length)
    expect(JSON.stringify(rec?.meta)).not.toContain(secret)
    expect(JSON.stringify(rec?.meta)).not.toContain('hunter2')
  })

  test('the screencap-loop fallback (session.clipboard null) still refuses even with nothing else going on', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { handler } = setUpHandler(db, fakeSession('dev-1', null))
    const a = fakeConn()

    a.sent.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'clipboard.set', id: 's1', payload: { deviceId: 'dev-1', text: 'x' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_CLIPBOARD_UNAVAILABLE')
  })
})

describe('clipboard.value is unicast — a second viewer of the same device receives nothing (plan 38 §4.5, acceptance #6)', () => {
  test('a bystander watching the same device via stream.start never sees clipboard.value or clipboard.ok', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { clipboard, setCalls } = fakeClipboard({ value: 'a private token' })
    const { handler } = setUpHandler(db, fakeSession('dev-1', clipboard))
    const holder = fakeConn()
    const viewer = fakeConn()

    // The viewer watches the SAME device the way the Control tab does —
    // exactly the presence signal `shell.result` broadcasts to (plan 26
    // §3.8). Clipboard must NOT reuse that broadcast.
    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'stream.start', id: 'st1', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(viewer.ws, JSON.stringify({ type: 'stream.start', id: 'st2', payload: { deviceId: 'dev-1' } }))
    viewer.sent.length = 0
    holder.sent.length = 0

    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'clipboard.get', id: 'g1', payload: { deviceId: 'dev-1' } }))
    expect(holder.sent.some((m) => m.type === 'clipboard.value')).toBe(true)
    expect(viewer.sent.some((m) => m.type === 'clipboard.value' || m.type === 'clipboard.ok')).toBe(false)

    holder.sent.length = 0
    viewer.sent.length = 0
    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'clipboard.set', id: 's1', payload: { deviceId: 'dev-1', text: 'x' } }))
    expect(holder.sent.some((m) => m.type === 'clipboard.ok')).toBe(true)
    expect(viewer.sent.some((m) => m.type === 'clipboard.value' || m.type === 'clipboard.ok')).toBe(false)
    expect(setCalls).toHaveLength(1)
  })
})
