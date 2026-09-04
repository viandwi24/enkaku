import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { DisplaySource, GuestAgentCapability, InputSink, ServerMessage, TextInputMode, Transport } from '@enkaku/protocol'
import { createInputArbiter, type DeviceSession, type SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * `input.text`'s WS wiring through the text ladder (plan 90 §3.3, §4.5, §5 step 90.5) —
 * `text-input.test.ts` (`@enkaku/session`) covers `resolveTextRoute`/`applyTextInput` themselves
 * in isolation; this proves `ws-handlers.ts` actually calls the resolver with the right facts,
 * dispatches to the rung it picked, and replies `input.text.result` (or refuses with a NAMED
 * precondition, plan 59) — against the REAL `createWsMessageHandler` and REAL `ActivityRegistry`,
 * mirroring `ws-handlers-clipboard.test.ts`'s harness.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

/** A scriptable `InputSink.text()` spy — throws when told to, mirroring `AdbInput`'s real refusal shape. */
function fakeInput(opts?: { textFails?: unknown }) {
  const textCalls: string[] = []
  const input = {
    tap: async () => {},
    swipe: async () => {},
    key: async () => {},
    text: async (t: string) => {
      if (opts?.textFails) throw opts.textFails
      textCalls.push(t)
    },
  } as unknown as InputSink
  return { input, textCalls }
}

function fakeSession(opts: {
  deviceId: string
  inputEngineId: string
  textInputMode?: TextInputMode
  agentCapabilities?: GuestAgentCapability[] | null
  imeCurrent?: boolean
  inputFails?: unknown
}): { session: DeviceSession; textCalls: string[]; commitCalls: Array<{ text: string; perCharMs?: [number, number] }> } {
  const { input, textCalls } = fakeInput({ textFails: opts.inputFails })
  const commitCalls: Array<{ text: string; perCharMs?: [number, number] }> = []
  // Plan 91 §3.1, §3.3, §4.1 — `ws-handlers.ts`'s `input.*` branch now routes a local session's
  // writes through `session.arbiter.for(source)` rather than `session.input` directly (fixes
  // F6/H1). Wrapping the SAME `input` spy here keeps `textCalls` recording exactly what it did
  // before this plan, while proving the arbiter is actually wired, not bypassed.
  const arbiter = createInputArbiter(input, { queueWaitMs: () => 5_000, maxQueueDepth: () => 32, log: createLogger('test') })
  const session: DeviceSession = {
    deviceId: opts.deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input,
    arbiter,
    displayEngineId: opts.inputEngineId === 'adb-input' ? 'screencap-loop' : 'scrcpy',
    quality: 'control',
    inputEngineId: opts.inputEngineId,
    videoConfig: () => null,
    videoKeyframe: () => null,
    inspector: null,
    whenInspectorReady: async () => {},
    prewarmInspector: async () => {},
    releaseInspector: async () => {},
    inspectorEngineId: 'ui-server',
    inspectorPollIntervalMs: 200,
    frameSize: { width: 1080, height: 2400 },
    clipboard: {
      get: async () => '',
      set: async () => {},
    },
    textInput: {
      mode: opts.textInputMode ?? 'auto',
      agentCapabilities: opts.agentCapabilities ?? null,
      imeCurrent: opts.imeCurrent ?? false,
      commitViaAgent: async (text, perCharMs) => {
        commitCalls.push({ text, ...(perCharMs ? { perCharMs } : {}) })
        return { committed: [...text].length, imeCurrent: true }
      },
    },
    onClipboardChanged: () => () => {},
    close: async () => {},
  }
  return { session, textCalls, commitCalls }
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
      // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these text-input
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

describe('input.text — the text ladder over WS (plan 90 §3.3, §4.5, §5 step 90.5)', () => {
  test('rung 1 (agent-ime): a usable agent commits through the agent, not the driver, and via reads agent-ime', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { session, textCalls, commitCalls } = fakeSession({
      deviceId: 'dev-1',
      inputEngineId: 'scrcpy-uhid',
      agentCapabilities: ['text-input'],
      imeCurrent: true,
    })
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    a.sent.length = 0

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.text', id: 't1', payload: { deviceId: 'dev-1', text: 'こんにちは 👋' } }))

    expect(a.sent.some((m) => m.type === 'error')).toBe(false)
    expect(commitCalls).toEqual([{ text: 'こんにちは 👋' }])
    expect(textCalls).toHaveLength(0) // never touched the raw driver
    const result = a.sent.find((m) => m.type === 'input.text.result')
    if (result?.type === 'input.text.result') {
      expect(result.id).toBe('t1')
      expect(result.payload.via).toBe('agent-ime')
      expect(result.payload.clobberedClipboard).toBe(false)
    } else throw new Error('no input.text.result received')
  })

  test('rung 2 (scrcpy-text): no usable agent, but a scrcpy input engine — unicode text still lands via the driver', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { session, textCalls, commitCalls } = fakeSession({ deviceId: 'dev-1', inputEngineId: 'scrcpy-uhid' })
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    a.sent.length = 0

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.text', id: 't1', payload: { deviceId: 'dev-1', text: 'こんにちは' } }))

    expect(a.sent.some((m) => m.type === 'error')).toBe(false)
    expect(textCalls).toEqual(['こんにちは'])
    expect(commitCalls).toHaveLength(0)
    const result = a.sent.find((m) => m.type === 'input.text.result')
    if (result?.type === 'input.text.result') expect(result.payload.via).toBe('scrcpy-text')
    else throw new Error('no input.text.result received')
  })

  test('rung 3 (adb-ascii): no agent, adb-input engine, plain ASCII text goes through unchanged', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { session, textCalls } = fakeSession({ deviceId: 'dev-1', inputEngineId: 'adb-input' })
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    a.sent.length = 0

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.text', id: 't1', payload: { deviceId: 'dev-1', text: 'hello world' } }))

    expect(a.sent.some((m) => m.type === 'error')).toBe(false)
    expect(textCalls).toEqual(['hello world'])
    const result = a.sent.find((m) => m.type === 'input.text.result')
    if (result?.type === 'input.text.result') expect(result.payload.via).toBe('adb-ascii')
    else throw new Error('no input.text.result received')
  })

  test('the named precondition (fixes F25): forcing adb-input on non-ASCII text refuses with E_TEXT_UNICODE_UNSUPPORTED and never reaches the driver', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { session, textCalls } = fakeSession({ deviceId: 'dev-1', inputEngineId: 'adb-input' })
    const { handler, events } = setUpHandler(db, session)
    const a = fakeConn()
    a.sent.length = 0
    events.length = 0

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.text', id: 't1', payload: { deviceId: 'dev-1', text: 'こんにちは' } }))

    expect(textCalls).toHaveLength(0) // never reached AdbInput.text() to die inside it (F25's bug)
    expect(a.sent.some((m) => m.type === 'input.text.result')).toBe(false)
    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') {
      expect(err.id).toBe('t1')
      expect(err.payload.code).toBe('E_TEXT_UNICODE_UNSUPPORTED')
      expect(err.payload.action).toBe('install-agent')
    }
    // A refusal is still an input action the operator attempted — the redacted `input.text` event
    // records that it happened, but nothing about it looks like a successful commit: it is the
    // ONLY event recorded, never a second one for a side effect that did not occur (there is no
    // longer even a rung that could have caused one — docs/plans/96-m61-hotfixes.md §96.7, §96.8).
    expect(events.map((e) => e.kind)).toEqual(['input.text'])
  })

  test('control.overControl: forbid — a second client is refused before the resolver ever runs, and the driver is never touched', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { session, textCalls } = fakeSession({ deviceId: 'dev-1', inputEngineId: 'scrcpy-uhid' })
    const { handler } = setUpHandler(db, session, 'forbid')
    const holder = fakeConn()
    const bystander = fakeConn()

    handler.handleOpen(holder.ws)
    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'input.text', id: 't0', payload: { deviceId: 'dev-1', text: 'mine' } }))
    handler.handleOpen(bystander.ws)
    await handler.handleMessage(bystander.ws, JSON.stringify({ type: 'input.text', id: 't1', payload: { deviceId: 'dev-1', text: 'hello' } }))

    const err = bystander.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_DEVICE_CONFLICT')
    expect(textCalls).toEqual(['mine'])
  })

  test('prefer: "device" never routes through a usable agent, even when one is wired', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'online')
    const { session, textCalls, commitCalls } = fakeSession({
      deviceId: 'dev-1',
      inputEngineId: 'scrcpy-uhid',
      textInputMode: 'device',
      agentCapabilities: ['text-input'],
      imeCurrent: true,
    })
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    a.sent.length = 0

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'input.text', id: 't1', payload: { deviceId: 'dev-1', text: 'hello' } }))

    expect(commitCalls).toHaveLength(0)
    expect(textCalls).toEqual(['hello'])
    const result = a.sent.find((m) => m.type === 'input.text.result')
    if (result?.type === 'input.text.result') expect(result.payload.via).toBe('scrcpy-text')
    else throw new Error('no input.text.result received')
  })
})
