import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { DisplaySource, InputSink, Selector, ServerMessage, Transport, UiNode } from '@enkaku/protocol'
import type { DeviceSession, SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type RemoteSessions, type WsHandlerDeps } from './ws-handlers'

/**
 * The Inspect tab's WS wiring (plan 56 §4.2, §5.4, acceptance #6, #8, #9;
 * admission reworked by plan 205 §4.9): the refusal matrix (control conflict
 * / no session / node-owned / no dump capability), ref-counting across two
 * viewers of the same device, and release-on-close. Exercised against the
 * REAL `createWsMessageHandler` and REAL `ActivityRegistry`, with only the
 * session and its inspector faked — mirrors `ws-handlers-shell.test.ts` /
 * `ws-handlers-monitor.test.ts`.
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

function seedDevice(db: Db, id: string, status: 'online' | 'offline' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

interface FakeInspectorCalls {
  dumps: number
  finds: Selector[]
}

/**
 * Mirrors the REAL `session.ts` session-scoped shape (plan 208 §3.2):
 * `inspector` starts `null`, and `whenInspectorReady()` — resolving without
 * throwing, never rejecting — is what sets it, unless `noDump` simulates the
 * session's own silent-fallback path (session.ts's "inspector could not
 * start" catches and warns, but still RESOLVES, leaving `inspector` null).
 * There is no `releaseInspector` any more: the engine lives with the
 * session, and only `close()` gives it back — nothing in this router's
 * `inspect.*` handling touches the session at all besides `whenInspectorReady()`.
 */
function fakeSession(
  deviceId: string,
  opts?: { engineId?: string; noDump?: boolean; startFails?: boolean; startsStarting?: boolean },
): {
  session: DeviceSession
  calls: FakeInspectorCalls
} {
  const calls: FakeInspectorCalls = { dumps: 0, finds: [] }
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
    // Plan 91 §4.1 — `arbiter` is required on `DeviceSession` now; this fixture never sends
    // input.* and never exercises it, so a bare stub keeps the type honest without wiring one up.
    arbiter: {} as unknown as DeviceSession['arbiter'],
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
    prewarmInspector: async () => {},
    // `opts.startsStarting` mirrors the "still starting" window (plan 208
    // §3.8): a real session's `inspectorEngineId` reads 'starting' until the
    // prewarm settles, unrelated to `whenInspectorReady()`, which this
    // fixture deliberately never calls for that case.
    inspectorEngineId: opts?.startsStarting ? 'starting' : engineId,
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
  return { session, calls }
}

function fakeSessionManager(session: DeviceSession | null): SessionManager {
  return {
    async acquire() {
      throw new Error('not used')
    },
    release() {},
    async attachViewer() {
      throw new Error('not used')
    },
    detachViewer() {},
    async build() {},
    async whenReady() {
      throw new Error('not used')
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

function setUpHandler(db: Db, session: DeviceSession | null, remote?: RemoteSessions, overControl: 'allow' | 'warn' | 'forbid' = 'allow') {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const jobStore = createJobStore(db)
  const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
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
      // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these inspect
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
    adb: () => null,
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    db,
    log,
  }
  return { handler: createWsMessageHandler(deps), events, activities }
}

describe('inspect.* refusal matrix (plan 56 §4.2, §6 acceptance #6, #9)', () => {
  test('control.overControl: forbid — a second client is refused, never an empty tree', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler } = setUpHandler(db, session, undefined, 'forbid')
    const holder = fakeConn()
    const bystander = fakeConn()

    handler.handleOpen(holder.ws)
    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'inspect.attach', id: 'i0', payload: { deviceId: 'dev-1' } }))
    handler.handleOpen(bystander.ws)
    await handler.handleMessage(bystander.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    const err = bystander.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_DEVICE_CONFLICT')
    expect(bystander.sent.some((m) => m.type === 'inspect.status')).toBe(false)
  })

  test('no session for the device → E_DEVICE_NOT_READY, not an empty tree', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { handler } = setUpHandler(db, null)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_DEVICE_NOT_READY')
  })

  test('a node-owned device reports inspect.status unavailable, naming the reason — never a fabricated tree', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const remote: RemoteSessions = {
      nodeIdFor: (id) => (id === 'dev-1' ? 'node-1' : null),
      acquire: async () => {
        throw new Error('not used')
      },
      release: () => {},
      get: () => null,
    }
    const { handler } = setUpHandler(db, session, remote)
    const a = fakeConn()

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

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    const status = a.sent.find((m) => m.type === 'inspect.status' && m.payload.state === 'unavailable')
    expect(status).toBeDefined()
    if (status?.type === 'inspect.status') expect(status.payload.reason).toContain('watchdog gave up')
  })
})

describe('inspect.attach attaches to the session\'s engine (plan 208 §3.2)', () => {
  /**
   * Attach is control-grade (§3.7): it takes the SAME `control` activity
   * policy row `input.*` uses (plan 205 §4.9). A bare online device admits
   * any number of attaches by default (`control.overControl: 'allow'`) — the
   * refusal this test proves is the farm dialing `overControl` to `'forbid'`,
   * not an inherent "only one viewer" rule.
   */
  test('with control.overControl: forbid, a second client is refused, not silently ignored — the holder\'s own attachment is unaffected', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler, events } = setUpHandler(db, session, undefined, 'forbid')
    const holder = fakeConn()
    const bystander = fakeConn()

    handler.handleOpen(holder.ws)
    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))
    handler.handleOpen(bystander.ws)
    await handler.handleMessage(bystander.ws, JSON.stringify({ type: 'inspect.attach', id: 'i2', payload: { deviceId: 'dev-1' } }))

    const bystanderErr = bystander.sent.find((m) => m.type === 'error')
    expect(bystanderErr).toBeDefined()
    if (bystanderErr?.type === 'error') expect(bystanderErr.payload.code).toBe('E_DEVICE_CONFLICT')
    expect(events.filter((e) => e.kind === 'inspect.attached')).toHaveLength(1) // only the holder's attach counted

    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'inspect.detach', payload: { deviceId: 'dev-1' } }))
    expect(session.inspector).not.toBeNull() // detach never touches the session's engine
  })

  test('attach records inspect.attached once per connection with engineId and tookMs', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler, events } = setUpHandler(db, session)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))

    const attached = events.filter((e) => e.kind === 'inspect.attached')
    expect(attached).toHaveLength(1)
    expect(attached[0]?.meta?.engineId).toBe('ui-server')
    expect(typeof attached[0]?.meta?.tookMs).toBe('number')
    expect(session.inspector).not.toBeNull()
  })

  test('inspect.detach records the event and never touches the session', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler, events } = setUpHandler(db, session)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.detach', payload: { deviceId: 'dev-1' } }))

    expect(events.filter((e) => e.kind === 'inspect.detached')).toHaveLength(1)
    // The fake session's own type has no `releaseInspector` at all any more
    // (plan 208 §3.2) — this asserts the behaviour, not merely the absent
    // method: the engine the attach reached is still set afterwards.
    expect(session.inspector).not.toBeNull()
  })

  test('a second attach from the same connection records nothing new', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler, events } = setUpHandler(db, session)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i2', payload: { deviceId: 'dev-1' } }))
    expect(events.filter((e) => e.kind === 'inspect.attached')).toHaveLength(1)

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.detach', payload: { deviceId: 'dev-1' } }))
    expect(events.filter((e) => e.kind === 'inspect.detached')).toHaveLength(1)
  })

  test('closing the WS records inspect.detached and never touches the session', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler, events } = setUpHandler(db, session)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'dev-1' } }))
    expect(events.filter((e) => e.kind === 'inspect.detached')).toHaveLength(0)

    handler.handleClose(a.ws)
    expect(events.filter((e) => e.kind === 'inspect.detached')).toHaveLength(1)
    expect(session.inspector).not.toBeNull() // the engine lives with the session, not the connection
  })
})

describe('inspect.dump / inspect.find (plan 56 §4.2 steps 5-6, acceptance #1, #4)', () => {
  test('inspect.dump returns the tree plus frameSize/timing, and a screenshot flag when requested', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    const { session } = fakeSession('dev-1')
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()
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
    // `engineId: 'ui-server'`, `noDump: true`: the fixture's inspector never
    // gets set (attach is never called here anyway), and the engine id is
    // NOT 'starting' — so the refusal is E_INSPECT_UNAVAILABLE, not the
    // "still starting" code the next test covers.
    const { session } = fakeSession('dev-1', { engineId: 'ui-server', noDump: true })
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'inspect.dump', id: 'd1', payload: { deviceId: 'dev-1', requestId: 1, screenshot: false } }),
    )

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_INSPECT_UNAVAILABLE')
    expect(a.sent.some((m) => m.type === 'inspect.tree')).toBe(false)
  })

  test('a dump while the engine is still starting answers E_INSPECTOR_STARTING, not unavailable (plan 208 §3.8)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1')
    // `inspector: null`, `inspectorEngineId: 'starting'`: the session's
    // prewarm has not settled yet. `whenInspectorReady()` is deliberately
    // never called before the dump — this is the window between the
    // session opening and the prewarm (or the first job/attach) resolving.
    const { session } = fakeSession('dev-1', { startsStarting: true })
    const { handler } = setUpHandler(db, session)
    const a = fakeConn()

    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'inspect.dump', id: 'd1', payload: { deviceId: 'dev-1', requestId: 1, screenshot: false } }),
    )

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('E_INSPECTOR_STARTING')
    expect(a.sent.some((m) => m.type === 'inspect.tree')).toBe(false)
  })
})

/**
 * The attach deadline (field report, 2026-08-26). `inspect.attach` awaited
 * `session.whenInspectorReady()` with NO bound while `dump` and `find` were
 * both wrapped in `withDeadline` — so a slow engine start hung the request
 * until the BROWSER gave up, and the page showed a bare timeout with no
 * reason while the core went on to attach successfully moments later.
 * Measured on a 20-device farm: 32 s to attach, against Studio's 25 s
 * request budget.
 *
 * Asserted by reading the source rather than by hanging a fake session for
 * 45 real seconds. That is the same guard shape `tools/adb-server-control.test.ts`
 * already uses for `adb kill-server`, and it catches the thing that actually
 * went wrong here: not a wrong number, but a missing bound.
 */
describe('inspect.attach is bounded (field report 2026-08-26)', () => {
  const source = readFileSync(new URL('./ws-handlers.ts', import.meta.url), 'utf8')

  test('whenInspectorReady() is awaited through withDeadline, never bare', () => {
    // A bare `await session.whenInspectorReady()` is the regression. It must
    // not come back: an unbounded await here is invisible in every test that
    // resolves it immediately, and only shows up on real hardware.
    expect(source).not.toMatch(/await\s+session\.whenInspectorReady\(\)/)
    expect(source).toMatch(/withDeadline\(\s*\n?\s*session\.whenInspectorReady\(\)/)
  })

  test('the attach budget is larger than a dump budget — starting an engine is slower than using it', () => {
    const attach = /const INSPECT_ATTACH_DEADLINE_MS = ([\d_]+)/.exec(source)
    const perOp = /const INSPECT_DEADLINE_MS = ([\d_]+)/.exec(source)
    expect(attach).not.toBeNull()
    expect(perOp).not.toBeNull()
    const attachMs = Number(attach![1]!.replace(/_/g, ''))
    const perOpMs = Number(perOp![1]!.replace(/_/g, ''))
    expect(attachMs).toBeGreaterThan(perOpMs)
    // The measured cold start was 32 s. A budget under that would turn a slow
    // farm's working inspector into a deterministic failure.
    expect(attachMs).toBeGreaterThanOrEqual(40_000)
  })

  test("Studio waits LONGER than the core's own attach deadline, so the reason always arrives", () => {
    // The whole point of the fix: the client must outlive the server's bound,
    // or it invents a blank timeout instead of rendering the real reason the
    // core is about to send. Cross-package on purpose — this invariant spans
    // the two files and is wrong the moment either drifts alone.
    const panel = readFileSync(new URL('../../../studio/src/components/InspectorPanel.tsx', import.meta.url), 'utf8')
    const clientMs = /inspect\.attach[\s\S]{0,200}?\},\s*([\d_]+)\)/.exec(panel)
    expect(clientMs).not.toBeNull()
    const attachMs = Number(/const INSPECT_ATTACH_DEADLINE_MS = ([\d_]+)/.exec(source)![1]!.replace(/_/g, ''))
    expect(Number(clientMs![1]!.replace(/_/g, ''))).toBeGreaterThan(attachMs)
  })
})
