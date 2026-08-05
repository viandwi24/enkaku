import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { DisplaySource, InputSink, Selector, ServerMessage, Transport, UiNode } from '@enkaku/protocol'
import type { DeviceSession, SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createLeaseManager } from '../lease/lease-manager'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type RemoteSessions, type WsHandlerDeps } from './ws-handlers'

/**
 * The Inspect tab's WS wiring (plan 56 §4.2, §5.4, acceptance #6, #8, #9):
 * the refusal matrix (no lease / no session / agent-owned / no dump
 * capability), ref-counting across two viewers of the same device, and
 * release-on-close. Exercised against the REAL `createWsMessageHandler` and
 * REAL `LeaseManager`, with only the session and its inspector faked —
 * mirrors `ws-handlers-shell.test.ts` / `ws-handlers-monitor.test.ts`.
 */

const NODE: UiNode = {
  resourceId: 'com.app:id/target',
  text: 'Follow',
  desc: '',
  className: 'android.widget.Button',
  packageName: 'com.app',
  bounds: { left: 0, top: 0, right: 10, bottom: 10 },
  clickable: true,
  enabled: true,
  focused: false,
  index: 0,
  children: [],
}

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'idle' | 'busy' | 'offline' = 'idle'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

interface FakeInspectorCalls {
  dumps: number
  finds: Selector[]
  released: number
}

/**
 * Mirrors the REAL `session.ts` lazily-populated shape: `inspector` starts
 * `null`, and `whenInspectorReady()` — resolving without throwing — is what
 * sets it, unless `noDump` simulates the session's own silent-fallback path
 * (session.ts §"inspector could not start" catches and warns, but still
 * RESOLVES, leaving `inspector` null). This is what makes "attach before
 * dump" and "no dump capability" actually exercise the handler's real gates,
 * rather than the fake pre-populating state the real session only builds
 * lazily.
 */
function fakeSession(deviceId: string, opts?: { engineId?: string; noDump?: boolean; startFails?: boolean }): {
  session: DeviceSession
  calls: FakeInspectorCalls
} {
  const calls: FakeInspectorCalls = { dumps: 0, finds: [], released: 0 }
  const engineId = opts?.engineId ?? 'ui-server'
  const inspectorImpl = {
    id: engineId,
    dump: async () => {
      calls.dumps++
      return NODE
    },
    find: async (sel: Selector) => {
      calls.finds.push(sel)
      return NODE
    },
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
  }
  const session: DeviceSession = {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: {} as unknown as InputSink,
    displayEngineId: 'screencap-loop',
    quality: 'control',
    inputEngineId: 'adb-input',
    videoConfig: () => null,
    videoKeyframe: () => null,
    inspector: null,
    whenInspectorReady: async () => {
      if (opts?.startFails) throw new Error('watchdog gave up')
      if (!opts?.noDump) session.inspector = inspectorImpl
    },
    releaseInspector: async () => {
      calls.released++
      session.inspector = null
    },
    inspectorEngineId: engineId,
    inspectorPollIntervalMs: 200,
    frameSize: { width: 1080, height: 2400 },
    clipboard: null,
    close: async () => {},
  }
  return { session, calls }
}

function fakeSessionManager(session: DeviceSession | null): SessionManager {
  return {
    async acquire() {
      throw new Error('not used')
    },
    release() {},
    get: () => session,
    async closeDevice() {},
    async closeIfIdle() {},
    idleSessions: () => [],
    async closeAll() {},
  }
}

function fakeConn(): { ws: ServerWebSocket<unknown>; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const ws = {
    readyState: 1,
    data: { userId: null },
    send: (raw: string | Uint8Array) => {
      if (typeof raw === 'string') sent.push(JSON.parse(raw) as ServerMessage)
    },
    getBufferedAmount: () => 0,
  } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

interface RecordedEvent {
  deviceId: string
  stream: string
  kind: string
  actor?: string | null
  meta?: Record<string, unknown> | null
}

function setUpHandler(db: Db, session: DeviceSession | null, remote?: RemoteSessions) {
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
  const events: RecordedEvent[] = []
  const deps: WsHandlerDeps = {
    sessions: fakeSessionManager(session),
    ...(remote ? { remote } : {}),
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
    recorder: { record: (e) => void events.push(e), stop: async () => {} },
    audit: { record: () => {}, list: () => [] },
    isLogInputTextEnabled: () => false,
    roleOf: () => 'admin',
    shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
    adb: () => null,
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    db,
    log,
  }
  return { handler: createWsMessageHandler(deps), events }
}

async function acquireLease(handler: ReturnType<typeof createWsMessageHandler>, ws: ServerWebSocket<unknown>, deviceId: string): Promise<void> {
  await handler.handleMessage(ws, JSON.stringify({ type: 'lease.acquire', id: 'l1', payload: { deviceId } }))
}

describe('inspect.* refusal matrix (plan 56 §4.2, §6 acceptance #6, #9)', () => {
  test('no lease → refused, never an empty tree', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    expect(a.sent.some((m) => m.type === 'inspect.status')).toBe(false)
  })

  test('no session for the device → E_DEVICE_NOT_READY, not an empty tree', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { handler } = setUpHandler(db, null)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_DEVICE_NOT_READY')
  })

  test('an agent-owned device reports inspect.status unavailable, naming the reason — never a fabricated tree', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const remote: RemoteSessions = {
      agentIdFor: (id) => (id === 'dev-1' ? 'agent-1' : null),
      acquire: async () => {
        throw new Error('not used')
      },
      release: () => {},
      get: () => null,
    }
    const { handler } = setUpHandler(db, session, remote)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    const status = a.sent.find((m) => m.type === 'inspect.status')
    expect(status).toBeDefined()
    if (status?.type === 'inspect.status') {
      expect(status.payload.state).toBe('unavailable')
      expect(status.payload.reason).toBeTruthy()
    }
    expect(a.sent.some((m) => m.type === 'error')).toBe(false)
  })

  test('an engine with no dump capability reports unavailable, naming the engine', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1', { noDump: true })
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    const status = a.sent.find((m) => m.type === 'inspect.status' && m.payload.state === 'unavailable')
    expect(status).toBeDefined()
    if (status?.type === 'inspect.status') expect(status.payload.reason).toContain(session.inspectorEngineId)
  })

  test('the inspector failing to start reports unavailable with the failure reason', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1', { startFails: true })
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    const status = a.sent.find((m) => m.type === 'inspect.status' && m.payload.state === 'unavailable')
    expect(status).toBeDefined()
    if (status?.type === 'inspect.status') expect(status.payload.reason).toContain('watchdog gave up')
  })
})

describe('inspect.attach/detach ref-counting (plan 56 §3.2, §5.4, acceptance #8)', () => {
  /**
   * Attach is control-grade (§3.7): it is gated by the SAME `checkInputAllowed`
   * lease check `input.*` uses, so — unlike video, which any viewer can watch —
   * only the current manual lease holder's connection can ever attach. A
   * second connection therefore cannot become a second concurrent "viewer" of
   * the inspector; it is refused outright, the ref count untouched.
   */
  test('a connection that does not hold the lease is refused, not silently ignored — the holder\'s own attachment is unaffected', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session, calls } = fakeSession('dev-1')
    const { handler, events } = setUpHandler(db, session)
    const holder = fakeConn()
    const bystander = fakeConn()
    await acquireLease(handler, holder.ws, 'dev-1')

    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(bystander.ws, JSON.stringify({ type: 'inspect.attach', id: 'i2', payload: { deviceId: 'dev-1' } }))

    const bystanderErr = bystander.sent.find((m) => m.type === 'error')
    expect(bystanderErr).toBeDefined()
    if (bystanderErr?.type === 'error') expect(bystanderErr.payload.code).toBe('not_lease_holder')
    expect(events.filter((e) => e.kind === 'inspect.attached')).toHaveLength(1) // only the holder's attach counted

    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'inspect.detach', payload: { deviceId: 'dev-1' } }))
    expect(calls.released).toBe(1) // the holder was the only real attachment — one attach, one release
  })

  /** Plan 56 §7 test plan: "ref-count reaching zero releases exactly once" — exercised across two independent attach/detach cycles from the same connection, never over- or under-released. */
  test('ref-count reaching zero releases exactly once, and a fresh attach afterwards starts cleanly', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session, calls } = fakeSession('dev-1')
    const { handler, events } = setUpHandler(db, session)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.detach', payload: { deviceId: 'dev-1' } }))
    expect(calls.released).toBe(1)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i2', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.detach', payload: { deviceId: 'dev-1' } }))
    expect(calls.released).toBe(2) // exactly one release per independent attach/detach cycle

    expect(events.filter((e) => e.kind === 'inspect.attached')).toHaveLength(2)
    expect(events.filter((e) => e.kind === 'inspect.detached')).toHaveLength(2)
  })

  test('a second attach from the SAME connection is idempotent — it does not inflate the ref count', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session, calls } = fakeSession('dev-1')
    const { handler, events } = setUpHandler(db, session)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i2', payload: { deviceId: 'dev-1' } }))
    expect(events.filter((e) => e.kind === 'inspect.attached')).toHaveLength(1)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.detach', payload: { deviceId: 'dev-1' } }))
    expect(calls.released).toBe(1) // one attach's worth released, not stuck at "still 1 more to go"
  })

  test('closing the WS releases this connection\'s attachment — a dropped tab does not leak the engine', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session, calls } = fakeSession('dev-1')
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))
    expect(calls.released).toBe(0)

    handler.handleClose(a.ws)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.released).toBe(1)
  })
})

describe('inspect.dump / inspect.find (plan 56 §4.2 steps 5-6, acceptance #1, #4)', () => {
  test('inspect.dump returns the tree plus frameSize/timing, and a screenshot flag when requested', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'inspect.dump', id: 'd1', payload: { deviceId: 'dev-1', requestId: 5, screenshot: true } }),
    )

    const tree = a.sent.find((m) => m.type === 'inspect.tree')
    expect(tree).toBeDefined()
    if (tree?.type === 'inspect.tree') {
      expect(tree.payload.root.resourceId).toBe('com.app:id/target')
      expect(tree.payload.frameSize).toEqual({ width: 1080, height: 2400 })
      expect(tree.payload.snapshot).toBe(true)
      expect(tree.payload.requestId).toBe(5)
    }
  })

  test('inspect.find runs a real find and reports the match', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session, calls } = fakeSession('dev-1')
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'inspect.find', id: 'f1', payload: { deviceId: 'dev-1', requestId: 2, selector: { id: 'target' } } }),
    )

    expect(calls.finds).toEqual([{ id: 'target' }])
    const match = a.sent.find((m) => m.type === 'inspect.match')
    expect(match).toBeDefined()
    if (match?.type === 'inspect.match') expect(match.payload.node?.resourceId).toBe('com.app:id/target')
  })

  test('inspect.find reports node: null honestly when nothing matches', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))
    // Attach populated `session.inspector` (the lazy real-session shape,
    // above) — now override `find` on the live instance for this one case.
    session.inspector = { ...session.inspector!, find: async () => null }

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'inspect.find', id: 'f1', payload: { deviceId: 'dev-1', requestId: 2, selector: { text: 'nope' } } }),
    )

    const match = a.sent.find((m) => m.type === 'inspect.match')
    if (match?.type === 'inspect.match') expect(match.payload.node).toBeNull()
  })

  test('a dump attempted without attaching first is refused, not a fabricated tree', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
    await acquireLease(handler, a.ws, 'dev-1')

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'inspect.dump', id: 'd1', payload: { deviceId: 'dev-1', requestId: 1, screenshot: false } }),
    )

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    expect(a.sent.some((m) => m.type === 'inspect.tree')).toBe(false)
  })
})
