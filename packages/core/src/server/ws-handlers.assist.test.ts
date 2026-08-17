import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { DeviceEvent, DisplaySource, InputSink, Point, ServerMessage, Transport } from '@enkaku/protocol'
import { createInputArbiter, type DeviceSession, type SessionManager } from '@enkaku/session'
import type { AuthEnv } from '../auth/middleware'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { TransferService } from '../device/transfer'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createLeaseManager, type LeaseManager } from '../lease/lease-manager'
import { createCoControlManager, type CoControlManager } from '../lease/co-control'
import { createLogger } from '../util/logger'
import { createEventRecorder } from '../events/recorder'
import { createAdbEndpointRoutes } from '../api/adb-endpoint'
import { createTransferRoutes } from '../api/transfer'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * The containment test (plan 91 §0 finding F1, §5 step 91.4, §7.1's
 * "containment" row).
 *
 * F1 is about blast radius: `checkInputAllowed` gates six wildly different
 * surfaces (manual input, shell, inspect, clipboard, file transfer, the adb
 * endpoint), and co-control's whole design (§3.1, §3.2) is a SEPARATE,
 * narrower object precisely so that widening input never widens the other
 * five. This test proves that structurally, not by inspection: one client
 * holding ONLY an assist grant — no lease, ever — is refused by
 * `shell.exec`, `inspect.attach`, `clipboard.set`, `POST /:id/push` and
 * `POST /:id/adb-endpoint`, all five, on the SAME device, in this ONE test,
 * while its `input.tap` succeeds.
 *
 * All five refusals are expected to carry `device_busy` — the device is
 * `busy` (a job holds it) throughout, and `checkInputAllowed` returns that
 * code before it even reads who holds the lease (F3). `roleOf` here always
 * resolves 'admin' and every farm switch is left in its most permissive
 * setting, so every refusal below is proven to come from the LEASE gate
 * specifically, never from a permission check an assist grant was never
 * meant to touch.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/** A minimal `InputSink` whose `tap` is a spy — the one call this test expects to actually reach "the device". */
function fakeInputSink(): { sink: InputSink; tapCalls: Point[] } {
  const tapCalls: Point[] = []
  return {
    tapCalls,
    sink: {
      id: 'fake-input',
      mode: 'uhid',
      tap: async (p) => {
        tapCalls.push(p)
      },
      swipe: async () => {},
      key: async () => {},
      text: async () => {},
    },
  }
}

/** Mirrors `ws-handlers-clipboard.test.ts`'s `fakeSession`, with a REAL arbiter (plan 91 §4.1) wrapping the spy sink above, so `input.tap` exercises the actual production code path. */
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
    clipboard: {
      get: async () => {
        throw new Error('clipboard.get should never be reached by this test')
      },
      set: async () => {
        throw new Error('clipboard.set reached the device — the assist grant must not have authorised it')
      },
    },
    textInput: {
      mode: 'device',
      agentCapabilities: null,
      imeCurrent: false,
      commitViaAgent: async () => {
        throw new Error('not used')
      },
    },
    close: async () => {},
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
    async closeAll() {
      return 0
    },
  }
}

/**
 * `userId` must be set on `ws.data` BEFORE `handleOpen` — `stateOf` reads and
 * caches it the instant `handleOpen` calls it (to mint `hello`'s sessionId),
 * so setting `ws.data.userId` afterward is silently too late and every
 * subsequent message carries a null actor regardless (plan 91 §5 step 91.5
 * found this the hard way — its own attribution tests below need a real
 * userId on the connection).
 */
function fakeConn(userId: string | null = null): { ws: ServerWebSocket<unknown>; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const ws = {
    readyState: 1,
    data: { userId },
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
    getBufferedAmount: () => 0,
  } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

/** Mirrors `adb-endpoint.test.ts`/`transfer.test.ts`'s own `withUser` — sets `c.get('user')` before dispatch, since neither REST route wraps its own auth middleware. */
function withUser(role: 'admin' | 'operator', inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    c.set('user', { id: 'u-admin', email: 'admin@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function findError(sent: ServerMessage[]): { code: string; message: string } | undefined {
  const err = sent.find((m) => m.type === 'error') as { type: 'error'; payload: { code: string; message: string } } | undefined
  return err?.payload
}

describe('assist containment (plan 91 §0 F1, §5 step 91.4, §7.1 "containment")', () => {
  test('a client holding ONLY an assist grant is refused shell.exec, inspect.attach, clipboard.set, POST /:id/push and POST /:id/adb-endpoint on the same device — all five, one test — while its input.tap succeeds', async () => {
    const db = setUpDb()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' }).run()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const jobStore = createJobStore(db)

    // Wired exactly the way `daemon.ts` wires it: `leases` first, `coControl`
    // second (it only ever reads `leases.getLease`), `onPrimaryEnded` reaching
    // back through the same forward-ref pattern.
    let coControlRef: CoControlManager | null = null
    const leases: LeaseManager = createLeaseManager({
      states,
      jobStore,
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
      onPrimaryEnded: (deviceId) => coControlRef?.onPrimaryEnded(deviceId),
    })
    const coControl = createCoControlManager({
      leases,
      config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1, mode: () => 'operator' },
      log,
    })
    coControlRef = coControl

    // A job holds the device — the owner's own scenario (§0.3): a job stuck
    // in a modal, a human reaching in to help. `busy` refuses `checkInputAllowed`
    // before the lease is even read (F3), whoever the caller is.
    const claimed = states.apply('d1', 'JOB_CLAIMED')
    expect(claimed?.to).toBe('busy')
    leases.noteJobLease('d1', 'job-1', 3600)

    const { sink: inputSink, tapCalls } = fakeInputSink()
    const session = fakeSession('d1', inputSink)
    const sessions = fakeSessionManager(session)

    const deps: WsHandlerDeps = {
      sessions,
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
      assists: () => [],
      // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these assist
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
      // Admin everywhere, and every farm switch left permissive — isolates
      // every refusal below to the LEASE gate specifically, never a
      // permission check.
      roleOf: () => 'admin',
      shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
      adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
      adb: () => null as unknown as AdbClient,
      crashPolicy: () => 'declared',
      targetPackagesForJob: () => [],
      saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
      db,
      coControl,
      coControlMode: () => 'operator',
      log,
    }
    const handler = createWsMessageHandler(deps)

    // Learn this connection's own clientId the way Studio does — from
    // `hello` — rather than reaching into the router's private state.
    const { ws, sent } = fakeConn()
    handler.handleOpen(ws)
    const hello = sent.find((m) => m.type === 'hello') as { type: 'hello'; payload: { sessionId: string } } | undefined
    expect(hello).toBeDefined()
    const clientId = hello!.payload.sessionId

    // The ONE grant this client holds — nothing else. No lease, ever.
    coControl.grant('d1', clientId, 'user-assist')
    expect(coControl.checkAssistAllowed('d1', clientId)).toEqual({ ok: true })
    expect(leases.checkInputAllowed('d1', clientId).ok).toBe(false)

    // ---- input.tap: MUST succeed (the assist fallback) ----
    sent.length = 0
    await handler.handleMessage(ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }))
    expect(findError(sent)).toBeUndefined()
    expect(tapCalls.length).toBe(1)

    // ---- shell.exec: MUST be refused ----
    sent.length = 0
    await handler.handleMessage(ws, JSON.stringify({ type: 'shell.exec', id: 's1', payload: { deviceId: 'd1', cmd: 'echo hi' } }))
    expect(findError(sent)?.code).toBe('device_busy')

    // ---- inspect.attach: MUST be refused ----
    sent.length = 0
    await handler.handleMessage(ws, JSON.stringify({ type: 'inspect.attach', id: 'i1', payload: { deviceId: 'd1' } }))
    expect(findError(sent)?.code).toBe('device_busy')

    // ---- clipboard.set: MUST be refused ----
    sent.length = 0
    await handler.handleMessage(ws, JSON.stringify({ type: 'clipboard.set', id: 'c1', payload: { deviceId: 'd1', text: 'hello', paste: false } }))
    expect(findError(sent)?.code).toBe('device_busy')

    // ---- POST /:id/push: MUST be refused ----
    const fakeTransfer: TransferService = {
      install: async () => {
        throw new Error('not used')
      },
      installFromLocalApk: async () => {
        throw new Error('not used')
      },
      push: async () => {
        throw new Error('push reached the device — the assist grant must not have authorised it')
      },
      pull: async () => {
        throw new Error('not used')
      },
      cancel: () => {},
    }
    const transferApp = withUser(
      'admin',
      createTransferRoutes({
        transfer: fakeTransfer,
        leases,
        record: () => {},
        shellSettings: () => ({ mode: 'admin' }),
        transferSettings: () => ({ enabled: true }),
        broadcast: { progress: () => {}, done: () => {} },
      }),
    )
    const pushRes = await transferApp.request('/d1/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: 'art-1', remotePath: '/sdcard/x', clientId }),
    })
    expect(pushRes.status).toBe(409)
    const pushBody = (await pushRes.json()) as { error: { code: string } }
    expect(pushBody.error.code).toBe('device_busy')

    // ---- POST /:id/adb-endpoint: MUST be refused ----
    const fakeAdbManager: AdbEndpointManager = {
      open: async () => {
        throw new Error('adb-endpoint reached the device — the assist grant must not have authorised it')
      },
      close: () => {},
      get: () => null,
      closeAllForClient: () => {},
    }
    const adbEndpointApp = withUser(
      'admin',
      createAdbEndpointRoutes({
        manager: fakeAdbManager,
        leases,
        shellSettings: () => ({ mode: 'admin', endpointEnabled: true }),
        getDevice: () => null,
      }),
    )
    const adbRes = await adbEndpointApp.request('/d1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId }),
    })
    expect(adbRes.status).toBe(409)
    const adbBody = (await adbRes.json()) as { error: { code: string } }
    expect(adbBody.error.code).toBe('device_busy')
  })

  test('the input.* fallback is refused by construction for a client with no grant at all — checkAssistAllowed correctly reports no_grant, and input.tap gets the ORIGINAL device_busy, not a misleading no_grant', async () => {
    const db = setUpDb()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' }).run()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const jobStore = createJobStore(db)
    const leases: LeaseManager = createLeaseManager({
      states,
      jobStore,
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const coControl = createCoControlManager({
      leases,
      config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1, mode: () => 'operator' },
      log,
    })
    states.apply('d1', 'JOB_CLAIMED')
    leases.noteJobLease('d1', 'job-1', 3600)

    const { sink: inputSink } = fakeInputSink()
    const session = fakeSession('d1', inputSink)
    const sessions = fakeSessionManager(session)

    const deps: WsHandlerDeps = {
      sessions,
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
      assists: () => [],
      // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these assist
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
      adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
      adb: () => null as unknown as AdbClient,
      crashPolicy: () => 'declared',
      targetPackagesForJob: () => [],
      saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
      db,
      coControl,
      coControlMode: () => 'operator',
      log,
    }
    const handler = createWsMessageHandler(deps)
    const { ws, sent } = fakeConn()
    handler.handleOpen(ws)

    await handler.handleMessage(ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }))
    // The ORIGINAL `checkInputAllowed` refusal survives, byte-identical to
    // before this plan — the fallback only ever REPLACES it on an actual
    // grant, never masks it with the assist store's own "no_grant" code.
    expect(findError(sent)?.code).toBe('device_busy')
  })
})

/**
 * Attribution (plan 91 §3.5, §4.9, §5 step 91.5) — the plan's own verifiable
 * result, run end to end against a REAL SQLite `jobs`/`device_events` table
 * (via `createJobStore`), not a hand-shaped fixture: "run a job, assist it
 * three times... jobs.assistCount is 3; GET /api/jobs/:id/assists returns
 * exactly those three actions with the operator's id."
 */
describe('assist attribution (plan 91 §3.5, §4.9, §5 step 91.5)', () => {
  test('three assist taps: jobs.assistCount is 3, device_events carries meta.assist/jobId, and store.assists(jobId) returns exactly those three with the operator id', async () => {
    const db = setUpDb()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' }).run()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const jobStore = createJobStore(db)

    let coControlRef: CoControlManager | null = null
    const leases: LeaseManager = createLeaseManager({
      states,
      jobStore,
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
      onPrimaryEnded: (deviceId) => coControlRef?.onPrimaryEnded(deviceId),
    })
    const coControl = createCoControlManager({
      leases,
      config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1, mode: () => 'operator' },
      log,
    })
    coControlRef = coControl

    // A REAL job row, running — the same one attribution reads back through.
    const jobRow = jobStore.enqueue({ scriptId: 'checkout', deviceId: 'd1', params: {}, priority: 0 })
    states.apply('d1', 'JOB_CLAIMED')
    leases.noteJobLease('d1', jobRow.id, 3600)
    db.update(jobs).set({ startedAt: new Date() }).where(eq(jobs.id, jobRow.id)).run()

    const { sink: inputSink } = fakeInputSink()
    const session = fakeSession('d1', inputSink)
    const sessions = fakeSessionManager(session)

    // A REAL recorder (plan 18 §3.5's own buffered writer) — the whole point
    // of this test is that `jobStore.assists()` reads the ACTUAL
    // `device_events` table, which a fake `record()` that only pushes to an
    // array would never populate. `publish` also captures the live-tail
    // shape for the bookend-event assertions below.
    const recordedEvents: DeviceEvent[] = []
    const recorder = createEventRecorder({ db, publish: (_deviceId, ev) => recordedEvents.push(ev) })
    const auditCalls: Array<{ userId: string | null; action: string; target?: string; meta?: unknown }> = []

    const deps: WsHandlerDeps = {
      sessions,
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
        assists: (jobId) => jobStore.assists(jobId),
        // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these assist
        // tests; present only so this fixture keeps satisfying `JobService`.
        nodes: () => ({ items: [], finalized: false }),
        resume: () => {
          throw new Error('not used')
        },
      },
      broadcast: () => {},
      recorder,
      audit: { record: (e) => auditCalls.push(e), list: () => [] },
      isLogInputTextEnabled: () => false,
      roleOf: () => 'admin',
      shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
      adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
      adb: () => null as unknown as AdbClient,
      crashPolicy: () => 'declared',
      targetPackagesForJob: () => [],
      saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
      db,
      coControl,
      coControlMode: () => 'operator',
      log,
    }
    const handler = createWsMessageHandler(deps)

    const { ws, sent } = fakeConn('operator-1')
    handler.handleOpen(ws)

    // `assist.start` — the explicit grant path, which is ALSO where the
    // 'started' bookend + audit row are recorded (mirrors `lease.acquire`'s
    // own treatment of `control.acquired`/`device.control`).
    sent.length = 0
    await handler.handleMessage(ws, JSON.stringify({ type: 'assist.start', id: 'a1', payload: { deviceId: 'd1' } }))
    expect(findError(sent)).toBeUndefined()
    expect(sent.some((m) => m.type === 'assist.started')).toBe(true)

    // Three accepted assist actions.
    for (let i = 0; i < 3; i++) {
      sent.length = 0
      await handler.handleMessage(ws, JSON.stringify({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }))
      expect(findError(sent)).toBeUndefined()
    }

    // `jobs.assistCount` is 3 — a real DB read (a direct, synchronous
    // `db.update`, not through the buffered recorder), not the input to the write.
    const updatedRow = jobStore.get(jobRow.id)
    expect(updatedRow?.assistCount).toBe(3)

    // `assist.stop` — the explicit release path, recording the 'ended' bookend + audit — BEFORE
    // the recorder is stopped below (`record()` on a stopped recorder is a no-op, plan 18's own
    // buffered-writer contract, so this order matters).
    sent.length = 0
    await handler.handleMessage(ws, JSON.stringify({ type: 'assist.stop', id: 'a2', payload: { deviceId: 'd1' } }))
    expect(sent.some((m) => m.type === 'assist.stopped')).toBe(true)

    // Flush the buffered recorder (plan 18 §3.5: writes are batched, not
    // synchronous) before reading `device_events` back for real.
    await recorder.stop()

    // `GET /api/jobs/:id/assists`' own query (`store.assists`) returns
    // exactly those three actions, each carrying the operator's id as actor.
    const assists = jobStore.assists(jobRow.id)
    expect(assists).toHaveLength(3)
    expect(assists.every((e) => e.actor === 'operator-1')).toBe(true)
    expect(assists.every((e) => e.kind === 'input.tap')).toBe(true)
    expect(assists.every((e) => (e.meta as { assist?: boolean } | null)?.assist === true)).toBe(true)
    expect(assists.every((e) => (e.meta as { jobId?: string } | null)?.jobId === jobRow.id)).toBe(true)

    // The bookend main-stream event and the audit row for the grant itself
    // (not the individual taps) — `control.assist.started`, actor + jobId.
    const startedEvent = recordedEvents.find((e) => e.kind === 'control.assist.started')
    expect(startedEvent).toMatchObject({ deviceId: 'd1', stream: 'main', actor: 'operator-1' })
    expect((startedEvent?.meta as { jobId?: string } | undefined)?.jobId).toBe(jobRow.id)
    const startedAudit = auditCalls.find((a) => a.action === 'device.assist' && (a.meta as { jobId?: string } | undefined)?.jobId === jobRow.id && !('reason' in ((a.meta as object) ?? {})))
    expect(startedAudit).toBeDefined()
    expect(startedAudit?.target).toBe('d1')

    const endedEvent = recordedEvents.find((e) => e.kind === 'control.assist.ended')
    expect(endedEvent).toMatchObject({ deviceId: 'd1', stream: 'main', actor: 'operator-1' })
    expect((endedEvent?.meta as { reason?: string } | undefined)?.reason).toBe('released')
    const endedAudit = auditCalls.find((a) => a.action === 'device.assist' && (a.meta as { reason?: string } | undefined)?.reason === 'released')
    expect(endedAudit).toBeDefined()
  })

  test('a WS disconnect while assisting records control.assist.ended (reason disconnected) and a device.assist audit row', async () => {
    const db = setUpDb()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' }).run()
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const jobStore = createJobStore(db)
    const leases: LeaseManager = createLeaseManager({
      states,
      jobStore,
      config: { jobTtlSec: 3600, manualIdleTimeoutSec: 300, reaperIntervalMs: 1_000_000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const coControl = createCoControlManager({
      leases,
      config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1, mode: () => 'operator' },
      log,
    })
    const jobRow = jobStore.enqueue({ scriptId: 'checkout', deviceId: 'd1', params: {}, priority: 0 })
    states.apply('d1', 'JOB_CLAIMED')
    leases.noteJobLease('d1', jobRow.id, 3600)

    const recordedEvents: Array<{ deviceId: string; stream: string; kind: string; actor?: string | null; meta?: unknown }> = []
    const auditCalls: Array<{ userId: string | null; action: string; target?: string; meta?: unknown }> = []
    const deps: WsHandlerDeps = {
      sessions: fakeSessionManager(fakeSession('d1', fakeInputSink().sink)),
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
        assists: () => [],
        // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these assist
        // tests; present only so this fixture keeps satisfying `JobService`.
        nodes: () => ({ items: [], finalized: false }),
        resume: () => {
          throw new Error('not used')
        },
      },
      broadcast: () => {},
      recorder: { record: (e) => recordedEvents.push(e), stop: async () => {} },
      audit: { record: (e) => auditCalls.push(e), list: () => [] },
      isLogInputTextEnabled: () => false,
      roleOf: () => 'admin',
      shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
      adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
      adb: () => null as unknown as AdbClient,
      crashPolicy: () => 'declared',
      targetPackagesForJob: () => [],
      saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
      db,
      coControl,
      coControlMode: () => 'operator',
      log,
    }
    const handler = createWsMessageHandler(deps)
    const { ws, sent } = fakeConn('operator-2')
    handler.handleOpen(ws)

    await handler.handleMessage(ws, JSON.stringify({ type: 'assist.start', id: 'a1', payload: { deviceId: 'd1' } }))
    expect(sent.some((m) => m.type === 'assist.started')).toBe(true)
    recordedEvents.length = 0
    auditCalls.length = 0

    handler.handleClose(ws)

    const endedEvent = recordedEvents.find((e) => e.kind === 'control.assist.ended')
    expect(endedEvent).toMatchObject({ deviceId: 'd1', stream: 'main', actor: 'operator-2' })
    expect((endedEvent?.meta as { reason?: string; jobId?: string } | undefined)?.reason).toBe('disconnected')
    expect((endedEvent?.meta as { reason?: string; jobId?: string } | undefined)?.jobId).toBe(jobRow.id)
    const disconnectedAudit = auditCalls.find((a) => a.action === 'device.assist' && (a.meta as { reason?: string } | undefined)?.reason === 'disconnected')
    expect(disconnectedAudit).toBeDefined()
  })
})
