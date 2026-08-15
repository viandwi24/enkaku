import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceLabelState, ReconcileReport, RegistryResponse, SweepReport } from '@enkaku/protocol'
import type { SessionManager } from '@enkaku/session'
import { eq } from 'drizzle-orm'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, auditLog, blockedDevices, clusters, deletedDevices, deviceEvents, deviceTags, devices, discoveredDevices, jobs } from '../db/schema'
import type { BatteryMonitor } from '../device/battery'
import { createDeviceLifecycle } from '../device/lifecycle'
import type { LabellingService } from '../device/labelling'
import type { Lease, LeaseManager, ManualReleaseReason } from '../lease/lease-manager'
import { createJobStore, type JobStore } from '../queue/job-store'
import type { CutoverManager } from '../registry/cutover'
import { allocateDeviceNumber, lookupDeviceNumber, setDeviceNumber } from '../registry/device-number'
import { deleteDeviceTags } from '../registry/device-tags'
import type { FarmNetwork } from '../registry/device-registry'
import type { EndpointStore } from '../registry/endpoints'
import type { DeviceReconnector } from '../registry/reconnect'
import { EnkakuError } from '../util/errors'
import { createLogger } from '../util/logger'
import { createDeviceRoutes } from './devices'

function emptyRegistry(): RegistryResponse {
  return { transports: [], displays: [], inputs: [], inspectors: [], networks: [], tools: [] }
}

/** No test in this file exercises a live manual lease — `getLease` always answers "none held". */
function fakeLeases(): LeaseManager {
  return {
    acquireManual: (): Lease => {
      throw new Error('not used in this test')
    },
    touchManual: () => {},
    releaseManual: () => false,
    releaseAllForClient: () => {},
    noteJobLease: () => {},
    clearJobLease: () => {},
    getLease: () => null,
    getHolder: () => null,
    lastManualReleaseAt: () => null,
    lastManualHolder: () => null,
    checkInputAllowed: () => ({ ok: true }),
    startReaper: () => {},
    stopReaper: () => {},
  }
}

/**
 * The connection tests (plan 88 §5 step 88.4) need to OBSERVE the disconnect
 * route's ordering ("closes the session and releases the manual lease
 * FIRST") — `calls` is a single shared log every one of the three fakes
 * below pushes onto, so a test can assert both that each step ran AND the
 * order they ran in with one array, rather than three separate spies that
 * cannot be compared against each other.
 */
function fakeLeasesRecording(calls: string[]): LeaseManager & { released: Array<{ deviceId: string; reason?: ManualReleaseReason }> } {
  const released: Array<{ deviceId: string; reason?: ManualReleaseReason }> = []
  return {
    ...fakeLeases(),
    released,
    releaseDevice: (deviceId, reason) => {
      calls.push('lease-released')
      released.push({ deviceId, reason })
      return true
    },
  }
}

function fakeSessions(calls: string[]): Pick<SessionManager, 'closeDevice' | 'restartAt' | 'get'> & { closed: string[]; restarted: Array<{ deviceId: string; quality: string; detail?: string }> } {
  const closed: string[] = []
  // plan 92 §3.8, §4.4, §5 step 92.2 — `restartAt`/`get` were added to the
  // `connection.sessions` accessor's Pick so `PATCH /:id` can restart a
  // device's OPEN session when `changedKeys` includes `video`. This fixture
  // has no open session by default (`get` returns `null`), so every
  // pre-existing connect/disconnect test above stays exactly as it was: `PATCH
  // /:id` never restarts what it cannot find. `devices-video-reprofile.test.ts`
  // is the one that actually exercises the restart path, with its own richer
  // fixture.
  const restarted: Array<{ deviceId: string; quality: string; detail?: string }> = []
  return {
    closed,
    restarted,
    closeDevice: async (deviceId) => {
      calls.push('session-closed')
      closed.push(deviceId)
    },
    get: () => null,
    restartAt: async (deviceId, quality, detail) => {
      restarted.push({ deviceId, quality, ...(detail ? { detail } : {}) })
    },
  }
}

function fakeReconnector(
  calls: string[],
  overrides?: Partial<Pick<DeviceReconnector, 'reconnect' | 'disconnect'>>,
): DeviceReconnector & {
  reconnectCalls: Array<{ stableId: string; opts?: { allowSweep?: boolean; force?: boolean } }>
  disconnectCalls: string[]
} {
  const reconnectCalls: Array<{ stableId: string; opts?: { allowSweep?: boolean; force?: boolean } }> = []
  const disconnectCalls: string[] = []
  return {
    reconnectCalls,
    disconnectCalls,
    reconnect:
      overrides?.reconnect ??
      (async (stableId, opts) => {
        reconnectCalls.push({ stableId, opts })
        return { result: 'already-connected', serial: 'serial-a' }
      }),
    disconnect:
      overrides?.disconnect ??
      (async (stableId) => {
        calls.push('transport-disconnected')
        disconnectCalls.push(stableId)
        return { result: 'disconnected' }
      }),
  }
}

/**
 * `declare` records every call (as before); `allWithEndpoints` now ALSO
 * reflects those same declarations (plan 88 §5 step 88.5) — the fake this
 * file's PATCH-then-GET read-back tests need, since `deriveConnection` reads
 * declared media back through exactly that method (`loadDeclaredMedia`).
 */
function fakeEndpoints(): Pick<EndpointStore, 'declare' | 'allWithEndpoints'> & {
  declared: Array<{ stableId: string; address: string; medium: string | null }>
} {
  const declared: Array<{ stableId: string; address: string; medium: string | null }> = []
  return {
    declared,
    declare: (stableId, address, medium) => {
      declared.push({ stableId, address, medium })
    },
    allWithEndpoints: () => {
      const byStableId = new Map<string, Array<{ stableId: string; address: string; medium: string | null }>>()
      for (const d of declared) {
        const list = byStableId.get(d.stableId) ?? []
        list.push(d)
        byStableId.set(d.stableId, list)
      }
      return Array.from(byStableId.entries()).map(([stableId, rows]) => ({
        stableId,
        candidates: rows.map((r) => ({
          stableId: r.stableId,
          address: r.address,
          medium: r.medium as 'wired' | 'wireless' | null,
          source: 'declared' as const,
          firstSeen: 0,
          lastConnectedAt: null,
          lastAttemptAt: null,
          consecutiveFailures: 0,
          conflictStableId: null,
        })),
      }))
    },
  }
}

/** A minimal `CutoverManager` fake (plan 88 §5 step 88.5) — `start` returns a fixed `armed` state by default; a test overrides it to prove the route's own guards run BEFORE this is ever reached. */
function fakeCutoverManager(overrides: { startState?: Partial<Parameters<CutoverManager['start']>[1]> & Record<string, unknown> } = {}): CutoverManager & {
  startCalls: Array<{ device: { id: string; stableId: string; serial: string; label: string }; opts: { port?: number; medium: string; address?: string } }>
  cancelCalls: string[]
} {
  const startCalls: Array<{ device: { id: string; stableId: string; serial: string; label: string }; opts: { port?: number; medium: string; address?: string } }> = []
  const cancelCalls: string[] = []
  return {
    startCalls,
    cancelCalls,
    start: async (device, opts) => {
      startCalls.push({ device, opts })
      return {
        deviceId: device.id,
        stableId: device.stableId,
        step: 'armed',
        detail: 'flip the port now',
        port: opts.port ?? 5555,
        medium: opts.medium,
        persistSurvivesReboot: true,
        triedAddresses: 0,
        answered: 0,
        startedAt: Date.now(),
        expiresAt: Date.now() + 180_000,
        connectedAddress: null,
        ...overrides.startState,
      }
    },
    cancel: (stableId) => {
      cancelCalls.push(stableId)
      return null
    },
    get: () => null,
    stopAll: () => {},
  }
}

function seedDevice(db: Db, id: string, tags: string[] = []): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: 'Test Phone', status: 'idle' })
    .run()
  const now = new Date()
  for (const tag of tags) db.insert(deviceTags).values({ deviceId: id, tag, at: now }).run()
}

/**
 * `PUT /:id/tags` and `PUT /:id/cluster` now require `device.settings` (plan
 * 34 §4.4, §4.5) — an admin user by default, matching what these
 * pre-existing tests already assumed implicitly. The wiring itself is
 * covered by the dedicated describe block at the end of this file.
 */
function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function makeApp(
  role: 'admin' | 'operator' | null = 'admin',
  opts: {
    rescan?: () => Promise<ReconcileReport> | null
    battery?: () => BatteryMonitor | null
    registry?: () => Promise<RegistryResponse>
    sweeper?: { sweep(opts?: { expect?: string[] }): Promise<SweepReport> }
    leases?: LeaseManager
    jobStore?: Pick<JobStore, 'list'>
    connection?: { reconnector: () => DeviceReconnector | null; sessions: () => Pick<SessionManager, 'closeDevice' | 'restartAt' | 'get'> | null }
    endpoints?: Pick<EndpointStore, 'declare' | 'allWithEndpoints'>
    /** Farm networks (plan 88 §3.6, §4.1, §5 step 88.5) — omitted matches no network, same as the dep's own default. */
    networks?: FarmNetwork[]
    cutover?: CutoverManager
    /** Physical labelling (plan 89 §4.3, §4.6, §5 step 89.4/89.9) — omitted matches every route's own `E_NOT_SUPPORTED` fallback, same optionality as `readiness`/`connection` above. */
    labelling?: LabellingService
  } = {},
) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const audit = createAuditLogger(db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
  const broadcast: Array<{ type: string; payload: unknown }> = []
  /** Every `deps.record?.(...)` call this router makes (plan 18 §4.2's device-event log) — collected the same way `broadcast` above is. */
  const records: Array<{ deviceId: string; stream: string; kind: string; actor?: string | null; meta?: Record<string, unknown> }> = []
  const leases = opts.leases ?? fakeLeases()
  const lifecycle = createDeviceLifecycle({ db, leases, log: createLogger('test') })
  const app = withUser(
    role,
    createDeviceRoutes({
      db,
      registry: opts.registry ?? (async () => emptyRegistry()),
      battery: opts.battery ?? (() => null),
      audit,
      dataDir,
      lifecycle,
      heldByOf: () => null,
      broadcast: (msg) => broadcast.push(msg),
      record: (e) => records.push(e),
      // Every mode this router is mounted in has a real lease manager and job
      // store (plan 88 §4.6, §5 step 88.4's own comment on why these two are
      // required, not optional) — `createJobStore(db)` is the real thing, not
      // a fake, since `jobStore.list` is plain SQL over the SAME in-memory db
      // every other assertion in this file already reads.
      leases,
      jobStore: opts.jobStore ?? createJobStore(db),
      ...(opts.connection ? { connection: opts.connection } : {}),
      ...(opts.endpoints ? { endpoints: opts.endpoints } : {}),
      ...(opts.rescan ? { rescan: opts.rescan } : {}),
      ...(opts.sweeper ? { sweeper: opts.sweeper } : {}),
      ...(opts.networks ? { networks: () => opts.networks! } : {}),
      ...(opts.cutover ? { cutover: () => opts.cutover! } : {}),
      ...(opts.labelling ? { labelling: opts.labelling } : {}),
    }),
  )
  return { db, app, dataDir, broadcast, records }
}

/** Plan 89 §4.3, §4.6, §5 step 89.4/89.9 — a controllable fake `LabellingService`, mirroring `fakeLeases`' shape above: every call is recorded, so a test can assert both WHICH method ran and with what arguments. */
type FakeLabellingCall =
  | { method: 'reconcile'; deviceId: string }
  | { method: 'apply'; deviceId: string; actor: { userId: string | null } }
  | { method: 'clear'; deviceId: string; opts: { restoreOriginal: boolean; actor: { userId: string | null } } }
  | { method: 'status'; deviceId: string }
function fakeLabelling(
  overrides: Partial<{
    reconcile: (deviceId: string) => Promise<DeviceLabelState>
    apply: (deviceId: string) => Promise<DeviceLabelState>
    clear: (deviceId: string) => Promise<DeviceLabelState>
    status: (deviceId: string) => Promise<DeviceLabelState>
  }> = {},
): { service: LabellingService; calls: FakeLabellingCall[] } {
  const calls: FakeLabellingCall[] = []
  const defaultState: DeviceLabelState = {
    mode: 'wallpaper',
    state: 'applied',
    reason: null,
    fingerprint: 'fp1',
    appliedAt: 1_700_000_000,
    originalCaptured: true,
    capturedLockScreen: null,
  }
  const service: LabellingService = {
    reconcile: async (deviceId) => {
      calls.push({ method: 'reconcile', deviceId })
      return overrides.reconcile ? overrides.reconcile(deviceId) : defaultState
    },
    apply: async (deviceId, actor) => {
      calls.push({ method: 'apply', deviceId, actor })
      return overrides.apply ? overrides.apply(deviceId) : defaultState
    },
    clear: async (deviceId, opts) => {
      calls.push({ method: 'clear', deviceId, opts })
      return overrides.clear ? overrides.clear(deviceId) : { ...defaultState, mode: 'off', state: 'off' }
    },
    status: async (deviceId) => {
      calls.push({ method: 'status', deviceId })
      return overrides.status ? overrides.status(deviceId) : defaultState
    },
  }
  return { service, calls }
}

const json = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('GET /api/devices tag filtering', () => {
  test('?tag=a&tag=b returns only devices carrying BOTH tags', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a', ['pool:smoke', 'android:15'])
    seedDevice(db, 'b', ['pool:smoke'])
    seedDevice(db, 'c', ['android:15'])

    const both = await app.request('/?tag=pool:smoke&tag=android:15')
    expect(both.status).toBe(200)
    const bothBody = (await both.json()) as { items: Array<{ id: string }> }
    expect(bothBody.items.map((d) => d.id)).toEqual(['a'])

    const one = await app.request('/?tag=pool:smoke')
    const oneBody = (await one.json()) as { items: Array<{ id: string }> }
    expect(oneBody.items.map((d) => d.id).sort()).toEqual(['a', 'b'])

    const none = await app.request('/')
    const noneBody = (await none.json()) as { items: Array<{ id: string }> }
    expect(noneBody.items).toHaveLength(3)
  })

  test('a single GET /api/devices?tag=... issues exactly one device_tags query, not one per device', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    for (let i = 0; i < 50; i++) seedDevice(db, `dev-${i}`, ['pool:smoke'])
    const audit = createAuditLogger(db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
    const lifecycle = createDeviceLifecycle({ db, leases: fakeLeases(), log: createLogger('test') })
    const app = createDeviceRoutes({
      db,
      registry: async () => emptyRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      heldByOf: () => null,
      broadcast: () => {},
      leases: fakeLeases(),
      jobStore: createJobStore(db),
    })

    // Every drizzle bun-sqlite query goes through `client.prepare(sql)` — count
    // how many of those touch device_tags (acceptance #7: one query, not N+1).
    let tagQueries = 0
    const originalPrepare = opened.sqlite.prepare.bind(opened.sqlite) as (sql: string, params?: unknown) => unknown
    opened.sqlite.prepare = ((sql: string, params?: unknown) => {
      if (sql.includes('device_tags')) tagQueries++
      return originalPrepare(sql, params)
    }) as typeof opened.sqlite.prepare

    const res = await app.request('/?tag=pool:smoke')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toHaveLength(50)
    expect(tagQueries).toBe(1)
  })
})

/**
 * Plan 71 §4.4, criterion 1 — `heldBy` on every `DeviceInfo` this router
 * builds: the list endpoint, the single-device endpoint, and everywhere else
 * `rowToDeviceInfo`/`listDevicesWithTags` are called from here.
 */
describe('GET /api/devices — heldBy (plan 71 §3.2, §4.4, criterion 1)', () => {
  const holder = {
    kind: 'agent' as const,
    id: 'agent-7',
    label: 'checkout-bot',
    runId: 'run-1',
    takeable: true,
    acquiredAt: 100,
    expiresAt: 200,
  }

  function appWithHeldBy(db: Db, heldByOf: (deviceId: string) => typeof holder | null) {
    const audit = createAuditLogger(db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
    const lifecycle = createDeviceLifecycle({ db, leases: fakeLeases(), log: createLogger('test') })
    return createDeviceRoutes({
      db,
      registry: async () => emptyRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      heldByOf,
      broadcast: () => {},
      leases: fakeLeases(),
      jobStore: createJobStore(db),
    })
  }

  test('a held device carries heldBy on the list endpoint; an unheld one carries null', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    const app = appWithHeldBy(db, (deviceId) => (deviceId === 'a' ? holder : null))

    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ id: string; heldBy: unknown }> }
    const a = body.items.find((d) => d.id === 'a')!
    const b = body.items.find((d) => d.id === 'b')!
    expect(a.heldBy).toEqual(holder)
    expect(b.heldBy).toBeNull()
  })

  test('the single-device endpoint carries the same heldBy', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    const app = appWithHeldBy(db, () => holder)

    const res = await app.request('/a')
    const body = (await res.json()) as { device: { heldBy: unknown } }
    expect(body.device.heldBy).toEqual(holder)
  })
})

/**
 * Plan 91 §3.4 item 4, §4.4, §5 step 91.4 — `assistedBy` alongside `heldBy`:
 * a device with an active assist grant must report it on both the list and
 * the single-device endpoint, and an unassisted device must report `[]`,
 * never a guess. Proven through the real HTTP routes, the same discipline
 * the `heldBy` describe block just above already established for the
 * sibling field.
 */
describe('GET /api/devices — assistedBy (plan 91 §3.4 item 4, §4.4, §5 step 91.4)', () => {
  const assistHolder = {
    kind: 'user' as const,
    id: 'u-assist',
    label: 'operator@enkaku',
    runId: null,
    takeable: false,
    acquiredAt: 100,
    expiresAt: 200,
  }

  function appWithAssistedBy(db: Db, assistedByOf: (deviceId: string) => (typeof assistHolder)[]) {
    const audit = createAuditLogger(db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
    const lifecycle = createDeviceLifecycle({ db, leases: fakeLeases(), log: createLogger('test') })
    return createDeviceRoutes({
      db,
      registry: async () => emptyRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      heldByOf: () => null,
      assistedByOf,
      broadcast: () => {},
      leases: fakeLeases(),
      jobStore: createJobStore(db),
    })
  }

  test('an assisted device carries assistedBy on the list endpoint; an unassisted one carries []', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    const app = appWithAssistedBy(db, (deviceId) => (deviceId === 'a' ? [assistHolder] : []))

    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ id: string; assistedBy: unknown }> }
    const a = body.items.find((d) => d.id === 'a')!
    const b = body.items.find((d) => d.id === 'b')!
    expect(a.assistedBy).toEqual([assistHolder])
    expect(b.assistedBy).toEqual([])
  })

  test('the single-device endpoint carries the same assistedBy', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    const app = appWithAssistedBy(db, () => [assistHolder])

    const res = await app.request('/a')
    const body = (await res.json()) as { device: { assistedBy: unknown } }
    expect(body.device.assistedBy).toEqual([assistHolder])
  })

  test('an omitted assistedByOf dep falls back to [] rather than throwing or guessing', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    const audit = createAuditLogger(db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
    const lifecycle = createDeviceLifecycle({ db, leases: fakeLeases(), log: createLogger('test') })
    const app = createDeviceRoutes({
      db,
      registry: async () => emptyRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      heldByOf: () => null,
      // assistedByOf deliberately omitted.
      broadcast: () => {},
      leases: fakeLeases(),
      jobStore: createJobStore(db),
    })

    const res = await app.request('/a')
    const body = (await res.json()) as { device: { assistedBy: unknown } }
    expect(body.device.assistedBy).toEqual([])
  })
})

/**
 * Plan 90 §3.8, §4.3, §4.7 — `DeviceInfoSchema.agent`'s producer
 * (docs/plans/96-m61-hotfixes.md's Gap 1 fix). Proven from the real HTTP
 * routes, never from `rowToDeviceInfo` in isolation: step 90.6 shipped the
 * whole operator-facing surface (the fleet chip, the wall tile, the device
 * header alert) reading `device.agent` correctly, and it stayed dark on every
 * real device because `rowToDeviceInfo` never read `row.agent` back off the
 * `devices.agent` column `AgentProvisioner` writes to — a unit test on the
 * helper alone would have passed the whole time this was broken.
 */
describe('GET /api/devices — agent (plan 90 §3.8, §4.3, §4.7, docs/plans/96-m61-hotfixes.md Gap 1 fix)', () => {
  test('a device whose devices.agent column says ready carries agent: "ready" on the list endpoint', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.update(devices)
      .set({
        agent: {
          state: 'ready',
          appVersion: '1.2.0',
          versionCode: 7,
          androidSdkInt: 34,
          capabilities: ['socks5-route', 'vpn-status'],
          reason: null,
          checkedAt: 1_700_000_000,
          attempts: 0,
          nextAttemptAt: null,
        },
      })
      .where(eq(devices.id, 'a'))
      .run()

    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ id: string; agent: string }> }
    expect(body.items.find((d) => d.id === 'a')?.agent).toBe('ready')
  })

  test('the single-device endpoint carries the same agent state', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.update(devices)
      .set({ agent: { state: 'outdated', appVersion: '1.0.0', versionCode: 3, androidSdkInt: 30, capabilities: [], reason: 'signature_mismatch', checkedAt: 1_700_000_001, attempts: 0, nextAttemptAt: null } })
      .where(eq(devices.id, 'a'))
      .run()

    const res = await app.request('/a')
    const body = (await res.json()) as { device: { agent: string } }
    expect(body.device.agent).toBe('outdated')
  })

  test('a device that has never been provisioned (devices.agent is NULL) reads "absent", never a crash', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    // seedDevice never sets .agent — the column is NULL, exactly like a
    // pre-plan-90 row or a device the provisioner has never touched.

    const listRes = await app.request('/')
    const listBody = (await listRes.json()) as { items: Array<{ id: string; agent: string }> }
    expect(listBody.items.find((d) => d.id === 'a')?.agent).toBe('absent')

    const oneRes = await app.request('/a')
    const oneBody = (await oneRes.json()) as { device: { agent: string } }
    expect(oneBody.device.agent).toBe('absent')
  })

  test('a corrupt devices.agent value (fails AgentStatusSchema) reads "absent" rather than 500ing the request', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    // Not a valid AgentStatus at all — the shape a pre-migration row or a
    // hand-edited DB could carry. CLAUDE.md: a corrupt JSON DB column must
    // never 500 every caller.
    db.update(devices)
      .set({ agent: { totally: 'not-an-agent-status' } })
      .where(eq(devices.id, 'a'))
      .run()

    const res = await app.request('/a')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { agent: string } }
    expect(body.device.agent).toBe('absent')
  })
})

describe('PUT /api/devices/:id/tags', () => {
  test('normalises, replaces the whole set atomically, and records an audit entry', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a', ['stale:tag'])

    const res = await app.request('/a/tags', json({ tags: [' Pool: Smoke ', 'android:15', 'android:15'] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tags: string[] }
    expect(body.tags).toEqual(['android:15', 'pool:smoke'])

    const rows = db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'a')).all()
    expect(rows.map((r) => r.tag).sort()).toEqual(['android:15', 'pool:smoke'])

    const entries = db.select().from(auditLog).all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('device.settings')
    expect(entries[0]!.target).toBe('a')
  })

  test('an invalid tag rejects the whole request and leaves existing tags untouched', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a', ['pool:smoke'])

    const res = await app.request('/a/tags', json({ tags: ['pool:smoke', 'bad tag!'] }))
    expect(res.status).toBe(400)

    const rows = db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'a')).all()
    expect(rows.map((r) => r.tag)).toEqual(['pool:smoke'])
  })

  test('an empty array clears all tags', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a', ['pool:smoke', 'android:15'])

    const res = await app.request('/a/tags', json({ tags: [] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tags: string[] }
    expect(body.tags).toEqual([])

    const rows = db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'a')).all()
    expect(rows).toHaveLength(0)
  })

  test('404s for an unknown device', async () => {
    const { app } = makeApp()
    const res = await app.request('/does-not-exist/tags', json({ tags: [] }))
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/devices/:id/cluster (plan 22.0 §4.4, acceptance #1, #2)', () => {
  const put = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('assigns an unclustered device and reports movedFrom: null', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(clusters).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()

    const res = await app.request('/a/cluster', put({ clusterId: 'c1' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { cluster: { id: string; name: string } | null }; movedFrom: string | null }
    expect(body.device.cluster).toEqual({ id: 'c1', name: 'Jakarta' })
    expect(body.movedFrom).toBeNull()

    const entries = db.select().from(auditLog).all()
    expect(entries.find((e) => e.action === 'cluster.assign')).toBeTruthy()
  })

  test('assigning a device already in another cluster moves it and reports what it moved from', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(clusters).values({ id: 'jakarta', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    db.insert(clusters).values({ id: 'bandung', name: 'Bandung', description: null, createdAt: new Date() }).run()
    await app.request('/a/cluster', put({ clusterId: 'jakarta' }))

    const res = await app.request('/a/cluster', put({ clusterId: 'bandung' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { cluster: { id: string } | null }; movedFrom: string | null }
    expect(body.device.cluster?.id).toBe('bandung')
    expect(body.movedFrom).toBe('jakarta')
  })

  test('clusterId: null unassigns and records cluster.unassign', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(clusters).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    await app.request('/a/cluster', put({ clusterId: 'c1' }))

    const res = await app.request('/a/cluster', put({ clusterId: null }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { cluster: unknown } }
    expect(body.device.cluster).toBeNull()
    const entries = db.select().from(auditLog).all()
    expect(entries.find((e) => e.action === 'cluster.unassign')).toBeTruthy()
  })

  test('an unknown cluster id 404s', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    const res = await app.request('/a/cluster', put({ clusterId: 'ghost' }))
    expect(res.status).toBe(404)
  })
})

/**
 * Security fix (plan 09 §4.4's `device.owner.set`, never carried into the
 * ACL until now): `PATCH /:id` let any authenticated operator set a
 * device's `ownerId` to themselves or anyone else, with no permission check
 * and no audit trail — defeating the ownership model `canUseDevice`
 * otherwise enforces for lease acquisition, job enqueue, and the adb
 * endpoint. Only the `ownerId` transition is gated; `label`/`settings`
 * stay ordinary operator work.
 */
describe('PATCH /api/devices/:id — ownerId reassignment (security fix, plan 09 §4.4)', () => {
  const patchReq = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('an operator cannot reassign ownerId — 403 auth.forbidden, the row is untouched, and nothing is audited', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ ownerId: 'operator-self' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')

    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.ownerId).toBeNull()
    expect(db.select().from(auditLog).all()).toHaveLength(0)
  })

  test('an operator cannot CLEAR an existing owner\'s ownerId either', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')
    db.update(devices).set({ ownerId: 'owner-1' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a', patchReq({ ownerId: null }))
    expect(res.status).toBe(403)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.ownerId).toBe('owner-1')
  })

  test('an admin CAN reassign ownerId, and it is audited with both the old and the new owner', async () => {
    const { db, app } = makeApp('admin')
    seedDevice(db, 'a')
    db.update(devices).set({ ownerId: 'owner-1' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a', patchReq({ ownerId: 'owner-2' }))
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.ownerId).toBe('owner-2')

    const entries = db.select().from(auditLog).all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('device.owner')
    expect(entries[0]!.target).toBe('a')
    expect(entries[0]!.meta).toEqual({ from: 'owner-1', to: 'owner-2' })
  })

  test('no authenticated user is refused (403), same as every other admin-shaped mutation on this router', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a', patchReq({ ownerId: 'someone' }))
    expect(res.status).toBe(403)
  })

  test('a PATCH that repeats the CURRENT ownerId is a no-op — not gated, not audited (idempotent)', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')
    db.update(devices).set({ ownerId: 'owner-1' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a', patchReq({ ownerId: 'owner-1' }))
    expect(res.status).toBe(200)
    expect(db.select().from(auditLog).all()).toHaveLength(0)
  })

  test('an operator CAN still patch label/settings on the SAME request when ownerId is left out entirely', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ label: 'Renamed' }))
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.label).toBe('Renamed')
  })
})

/**
 * `PATCH /:id` had NO blanket `requirePermission` at all before this fix —
 * only the targeted `device.owner.set` check on the `ownerId` transition
 * (the describe block above). A caller with no `ownerId` in the body could
 * reach `label`/`settings` with no permission check whatsoever. Now gated on
 * `device.settings`, the same permission every sibling mutation on this
 * router already declares (`PUT /:id/tags`, `PATCH /:id/drivers`, …) — a
 * no-op for who gets in today (both `admin` and `operator` already hold
 * `device.settings`) but not for what the router says it requires.
 */
describe('PATCH /api/devices/:id — blanket device.settings gate (plan 87, mvp-3 Finding 3)', () => {
  const patchReq = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('no authenticated user is refused (403) for a label-only patch — no ownerId in the body at all', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a', patchReq({ label: 'Renamed' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.label).toBe('Test Phone')
  })

  test('an admin may still patch label — no lockout', async () => {
    const { db, app } = makeApp('admin')
    seedDevice(db, 'a')
    const res = await app.request('/a', patchReq({ label: 'Renamed' }))
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.label).toBe('Renamed')
  })

  test('an operator (device.settings is an OPERATOR permission) may still patch label — no lockout', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')
    const res = await app.request('/a', patchReq({ label: 'Renamed' }))
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.label).toBe('Renamed')
  })
})

describe('GET /api/devices?clusterId= (plan 22.0 §4.4, acceptance #4)', () => {
  test('clusterId=<id> returns only that cluster\'s members; clusterId=none returns exactly the unclustered devices', async () => {
    const { db, app } = makeApp()
    db.insert(clusters).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    seedDevice(db, 'c')
    db.update(devices).set({ clusterId: 'c1' }).where(eq(devices.id, 'a')).run()
    db.update(devices).set({ clusterId: 'c1' }).where(eq(devices.id, 'b')).run()

    const clustered = await app.request('/?clusterId=c1')
    const clusteredBody = (await clustered.json()) as { items: Array<{ id: string }> }
    expect(clusteredBody.items.map((d) => d.id).sort()).toEqual(['a', 'b'])

    const none = await app.request('/?clusterId=none')
    const noneBody = (await none.json()) as { items: Array<{ id: string }> }
    expect(noneBody.items.map((d) => d.id)).toEqual(['c'])
  })
})

describe('GET /api/devices keyset pagination (label ASC, id ASC)', () => {
  function seedLabelled(db: Db, id: string, label: string): void {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label, status: 'idle' }).run()
  }

  test('pages through 5 devices with limit=2: the union is exactly the 5, no duplicates', async () => {
    const { db, app } = makeApp()
    const ids = ['e', 'a', 'd', 'c', 'b']
    for (const id of ids) seedLabelled(db, id, `label-${id}`)

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const url = cursor ? `/?limit=2&cursor=${encodeURIComponent(cursor)}` : '/?limit=2'
      const res = await app.request(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null; total: number | null }
      for (const item of body.items) {
        expect(seen.has(item.id)).toBe(false)
        seen.add(item.id)
      }
      pages++
      if (body.nextCursor === null) break
      cursor = body.nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(5)
    expect([...seen].sort()).toEqual(ids.sort())
  })

  test('is sorted by label ascending, not insertion order', async () => {
    const { db, app } = makeApp()
    seedLabelled(db, 'x', 'zzz-last')
    seedLabelled(db, 'y', 'aaa-first')
    // Plan 89 §4.3 changed the default sort to `number` (the rack's own
    // order) — `?sort=label` is what this test is actually about.
    const res = await app.request('/?limit=10&sort=label')
    const body = (await res.json()) as { items: Array<{ id: string; label: string }> }
    expect(body.items.map((d) => d.label)).toEqual(['aaa-first', 'zzz-last'])
  })

  test('a malformed cursor returns 400, not a silently-ignored one', async () => {
    const { app } = makeApp()
    const res = await app.request('/?cursor=not-valid-base64!!!')
    expect(res.status).toBe(400)
  })

  test('a limit above the cap is clamped, not honoured', async () => {
    const { db, app } = makeApp()
    for (let i = 0; i < 5; i++) seedLabelled(db, `d${i}`, `label-${i}`)
    const res = await app.request('/?limit=99999')
    const body = (await res.json()) as { items: unknown[]; total: number | null }
    expect(body.items).toHaveLength(5) // fewer than the cap anyway, but the request itself must not 400 or hang
    expect(body.total).toBe(5)
  })
})

describe('device deletion cleans up its tags', () => {
  // There is no device-delete endpoint in this codebase yet (plan 19 §4.1
  // notes this as an assumption); this exercises the cleanup helper that
  // whichever plan adds deletion must call in the same transaction.
  test('deleteDeviceTags leaves no orphan rows once the device row is gone', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a', ['pool:smoke', 'android:15'])
    seedDevice(db, 'b', ['pool:smoke'])

    db.transaction((tx) => {
      deleteDeviceTags(tx as unknown as Db, 'a')
      tx.delete(devices).where(eq(devices.id, 'a')).run()
    })

    expect(db.select().from(devices).where(eq(devices.id, 'a')).all()).toHaveLength(0)
    expect(db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'a')).all()).toHaveLength(0)
    // The other device's tags are untouched.
    expect(db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'b')).all()).toHaveLength(1)
  })
})

describe('POST /:id/monitor/save (plan 24 §4.6) — "save last N lines" writes a device-scoped artifact', () => {
  test('writes a .log artifact tied to the device (not a job) and returns it', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'dev-1')
    const res = await app.request('/dev-1/monitor/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'logcat', lines: ['line one', 'line two', 'line three'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { artifact: { id: string; jobId: string | null; deviceId: string | null; kind: string } }
    expect(body.artifact.jobId).toBeNull()
    expect(body.artifact.deviceId).toBe('dev-1')
    expect(body.artifact.kind).toBe('log')

    const row = db.select().from(artifacts).where(eq(artifacts.id, body.artifact.id)).get()
    expect(row?.deviceId).toBe('dev-1')
    expect(row?.jobId).toBeNull()
  })

  test('rejects more than 5000 lines', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'dev-1')
    const res = await app.request('/dev-1/monitor/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'logcat', lines: Array.from({ length: 5001 }, (_, i) => String(i)) }),
    })
    expect(res.status).toBe(400)
  })

  test('rejects an unknown device', async () => {
    const { app } = makeApp()
    const res = await app.request('/ghost/monitor/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'top', lines: ['x'] }),
    })
    expect(res.status).toBe(404)
  })
})

/**
 * `POST /:id/monitor/save` had NO permission check at all before this fix
 * (plan 87, mvp-3 Finding 3 — the same "everyone has it anyway" gap `PATCH
 * /:id` had): any authenticated caller could reach it. Now gated on
 * `device.settings`, the same permission its siblings on this router
 * already use.
 */
describe('POST /:id/monitor/save — device.settings gate (plan 87, mvp-3 Finding 3)', () => {
  const saveReq = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('no authenticated user is refused (403)', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'dev-1')
    const res = await app.request('/dev-1/monitor/save', saveReq({ kind: 'logcat', lines: ['x'] }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an operator (device.settings is an OPERATOR permission) may still save — no lockout', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'dev-1')
    const res = await app.request('/dev-1/monitor/save', saveReq({ kind: 'logcat', lines: ['x'] }))
    expect(res.status).toBe(200)
  })
})

describe('requirePermission("device.settings") on tags/cluster (plan 34 §4.4, §4.5, acceptance #7)', () => {
  test('PUT /:id/tags is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a/tags', json({ tags: ['pool:smoke'] }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('an operator (device.settings is an OPERATOR permission) may still set tags — no lockout', async () => {
    const { db, app } = makeApp('operator')
    seedDevice(db, 'a')
    const res = await app.request('/a/tags', json({ tags: ['pool:smoke'] }))
    expect(res.status).toBe(200)
  })

  test('PUT /:id/cluster is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    db.insert(clusters).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    const res = await app.request('/a/cluster', json({ clusterId: 'c1' }))
    expect(res.status).toBe(403)
  })

  test('GET /:id needs no permission at all — read routes stay open', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a')
    expect(res.status).toBe(200)
  })

  // Plan 47 §4.4 — the same permission tags/cluster already use (§9 of the
  // plan says so explicitly), calling directly is refused exactly as the UI
  // would be (acceptance #12).
  test('DELETE /:id (Forget) is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  test('POST /:id/block is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a/block', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('GET /:id/history-counts is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a/history-counts')
    expect(res.status).toBe(403)
  })

  test('GET /blocked and DELETE /blocked/:stableId are refused with no authenticated user', async () => {
    const { app } = makeApp(null)
    expect((await app.request('/blocked')).status).toBe(403)
    expect((await app.request('/blocked/stable-a', { method: 'DELETE' })).status).toBe(403)
  })
})

/**
 * `PATCH /:id/drivers` had NO `requirePermission` at all before this fix (a
 * security-sweep finding, `packages/core/src/api/devices.ts:549`): any
 * authenticated operator could change a device's transport/display/input/
 * inspector engines. Now gated on `device.settings` — the same OPERATOR
 * permission `PUT /:id/tags`/`PUT /:id/cluster` already use — and audited as
 * `device.drivers`.
 */
describe('PATCH /api/devices/:id/drivers (security fix)', () => {
  function driversRegistry(): RegistryResponse {
    const engine = (id: string, kind: 'transport' | 'display' | 'input' | 'inspector' | 'network') => ({
      id,
      displayName: id,
      kind,
      capabilities: [],
      locks: [],
      requires: [],
      configSchema: {},
      available: true,
    })
    return {
      transports: [engine('adb', 'transport')],
      displays: [engine('scrcpy', 'display')],
      inputs: [engine('adb', 'input')],
      inspectors: [engine('ui-server', 'inspector')],
      networks: [engine('none', 'network')],
      tools: [],
    }
  }
  const driversBody = { transport: 'adb', display: 'scrcpy', input: 'adb', inspection: 'ui-server' }
  const req = () => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(driversBody) })

  test('no authenticated user is refused (403), and the row is untouched', async () => {
    const { db, app } = makeApp(null, { registry: async () => driversRegistry() })
    seedDevice(db, 'a')
    const res = await app.request('/a/drivers', req())
    expect(res.status).toBe(403)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    // The schema default (`db/schema.ts`) — `driversBody.transport` ('adb') never lands.
    expect(row?.transport).toBe('adb-usb')
  })

  test('an operator (device.settings is an OPERATOR permission) may still change drivers — no lockout', async () => {
    const { db, app } = makeApp('operator', { registry: async () => driversRegistry() })
    seedDevice(db, 'a')
    const res = await app.request('/a/drivers', req())
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'a')).get()
    expect(row?.transport).toBe('adb')
    expect(row?.display).toBe('scrcpy')
  })

  test('a successful change is audited as device.drivers with the before/after engines', async () => {
    const { db, app } = makeApp('admin', { registry: async () => driversRegistry() })
    seedDevice(db, 'a')
    const res = await app.request('/a/drivers', req())
    expect(res.status).toBe(200)
    const entries = db.select().from(auditLog).all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('device.drivers')
    expect(entries[0]!.target).toBe('a')
    // `seedDevice` never sets these columns explicitly, so the schema's own defaults apply
    // (`db/schema.ts`) — asserted here rather than re-derived, so this test breaks loudly if
    // those defaults ever change.
    expect(entries[0]!.meta).toEqual({ from: { transport: 'adb-usb', display: 'scrcpy', input: 'scrcpy-uhid', inspection: 'ui-server' }, to: driversBody })
  })

  test('an unauthenticated request never even reaches engine-selection validation', async () => {
    // A bogus engine combination would 400 (UNKNOWN_ENGINE) if the request got past auth —
    // asserting 403 here proves the permission check runs FIRST, not merely that some check does.
    const { db, app } = makeApp(null, { registry: async () => driversRegistry() })
    seedDevice(db, 'a')
    const res = await app.request(
      '/a/drivers',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transport: 'does-not-exist', display: 'x', input: 'x', inspection: 'x' }) },
    )
    expect(res.status).toBe(403)
  })
})

/**
 * `POST /:id/unquarantine` had NO permission check at all before this fix (a
 * security-sweep finding, `packages/core/src/api/devices.ts:561`), while
 * `device.quarantine` is admin-only in `auth/acl.ts`: any authenticated
 * operator could clear a thermal/safety quarantine. Now gated on
 * `device.quarantine` and audited as `device.unquarantine`.
 */
describe('POST /api/devices/:id/unquarantine (security fix)', () => {
  function quarantinedBattery(unquarantined: string[]): () => BatteryMonitor {
    return () => ({
      start: () => {},
      stop: () => {},
      pollOnce: async () => {},
      unquarantine: (deviceId: string) => {
        unquarantined.push(deviceId)
        return true
      },
    })
  }

  test('an operator is refused (403) — device.quarantine is admin-only — and unquarantine is never called', async () => {
    const calls: string[] = []
    const { db, app } = makeApp('operator', { battery: quarantinedBattery(calls) })
    seedDevice(db, 'a')
    const res = await app.request('/a/unquarantine', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(calls).toEqual([])
    expect(db.select().from(auditLog).all()).toHaveLength(0)
  })

  test('no authenticated user is refused (403)', async () => {
    const calls: string[] = []
    const { db, app } = makeApp(null, { battery: quarantinedBattery(calls) })
    seedDevice(db, 'a')
    const res = await app.request('/a/unquarantine', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('an admin CAN unquarantine, and it is audited', async () => {
    const calls: string[] = []
    const { db, app } = makeApp('admin', { battery: quarantinedBattery(calls) })
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'quarantined', quarantineReason: 'overheating' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a/unquarantine', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['a'])

    const entries = db.select().from(auditLog).all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('device.unquarantine')
    expect(entries[0]!.target).toBe('a')
    expect(entries[0]!.meta).toEqual({ reason: 'overheating' })
  })
})

describe('POST /rescan (plan 85 §3.3, §4.4, §4.6, §5 step 85.2)', () => {
  const sampleReport: ReconcileReport = {
    seen: 5,
    adopted: ['SER1'],
    dropped: [],
    offline: [],
    unauthorized: [],
    reconnectIssued: false,
    retriesPending: 0,
  }

  test('returns the reconciler\'s report and audits the action', async () => {
    const { app, db } = makeApp('admin', { rescan: async () => sampleReport })
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(sampleReport)
    const entries = db.select().from(auditLog).all()
    expect(entries.some((e) => e.action === 'device.rescan')).toBe(true)
  })

  test('is refused with no authenticated user, same as every other admin-style device mutation here', async () => {
    const { app } = makeApp(null, { rescan: async () => sampleReport })
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('an operator (device.settings is an OPERATOR permission) may still rescan', async () => {
    const { app } = makeApp('operator', { rescan: async () => sampleReport })
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('refuses E_NOT_SUPPORTED when no reconciler is wired (orchestrator mode, or adb never came up)', async () => {
    const { app } = makeApp('admin')
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('also refuses E_NOT_SUPPORTED when the accessor itself resolves to null (the forward-ref default before boot assigns it)', async () => {
    const { app } = makeApp('admin', { rescan: () => null })
    const res = await app.request('/rescan', { method: 'POST' })
    expect(res.status).toBe(501)
  })
})

describe('POST /scan (plan 88 §3.5, §4.5, §4.6, §5 step 88.3)', () => {
  const sampleReport: SweepReport = {
    networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', addresses: 256 }],
    scanned: 251,
    skipped: 3,
    answered: 2,
    connected: 2,
    identified: 2,
    adopted: ['SER1'],
    discovered: ['SER2'],
    conflicts: [],
    durationMs: 1234,
  }

  test('returns the sweeper\'s report and audits it as its own device.scan action (plan 88 §5 step 88.4)', async () => {
    const { app, db } = makeApp('admin', { sweeper: { sweep: async () => sampleReport } })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(sampleReport)
    const entries = db.select().from(auditLog).all()
    const entry = entries.find((e) => e.action === 'device.scan')
    expect(entry).toBeDefined()
    expect((entry?.meta as { scanned?: number } | null)?.scanned).toBe(sampleReport.scanned)
  })

  test('is refused with no authenticated user, same as every other admin-style device mutation here', async () => {
    const { app } = makeApp(null, { sweeper: { sweep: async () => sampleReport } })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('an operator (device.settings is an OPERATOR permission) may still trigger a scan', async () => {
    const { app } = makeApp('operator', { sweeper: { sweep: async () => sampleReport } })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('refuses E_NOT_SUPPORTED when no sweeper is wired (orchestrator mode, or the adb subsystem is not ready)', async () => {
    const { app } = makeApp('admin')
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('a sweeper that rejects E_SCAN_BUSY surfaces as 409, not a 500', async () => {
    const { app } = makeApp('admin', {
      sweeper: {
        sweep: async () => {
          throw new EnkakuError('E_SCAN_BUSY', 'a sweep is already running')
        },
      },
    })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_SCAN_BUSY')
  })

  test('a sweeper that rejects E_SCAN_UNAVAILABLE surfaces as 409, not a 500', async () => {
    const { app } = makeApp('admin', {
      sweeper: {
        sweep: async () => {
          throw new EnkakuError('E_SCAN_UNAVAILABLE', 'no scannable network is configured')
        },
      },
    })
    const res = await app.request('/scan', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_SCAN_UNAVAILABLE')
  })
})

/** Seeds a device whose serial is already `host:port`-shaped — `deriveConnection`'s ONLY signal for `kind: 'tcp'` (plan 88 §3.1). `seedDevice` alone always seeds a USB-shaped serial. */
function seedTcpDevice(db: Db, id = 'a', address = '10.0.0.5:5555'): void {
  seedDevice(db, id)
  db.update(devices).set({ serial: address }).where(eq(devices.id, id)).run()
}

describe('POST /:id/connection/disconnect (plan 88 §3.7, §3.8, §4.6, §5 step 88.4, fixes F11)', () => {
  test('a USB device refuses with a coded, explaining E_TRANSPORT_NOT_DETACHABLE — no reconnector needed', async () => {
    const { db, app } = makeApp('admin')
    seedDevice(db, 'a') // USB-shaped serial by default.
    const res = await app.request('/a/connection/disconnect', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_TRANSPORT_NOT_DETACHABLE')
    expect(body.error.message).toMatch(/usb/i)
  })

  test('refuses E_NOT_SUPPORTED for a tcp device when no reconnector is wired (orchestrator mode, or the adb subsystem is not ready)', async () => {
    const { db, app } = makeApp('admin')
    seedTcpDevice(db)
    const res = await app.request('/a/connection/disconnect', { method: 'POST' })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
  })

  test('a running job refuses (coded job_running) and LISTS the job, unless force — nothing is torn down first', async () => {
    const calls: string[] = []
    const { db, app } = makeApp('admin', { connection: { reconnector: () => fakeReconnector(calls), sessions: () => fakeSessions(calls) } })
    seedTcpDevice(db)
    db.insert(jobs).values({ id: 'job-1', scriptId: 'internal:sleep', scriptName: 'sleep-and-tap', deviceId: 'a', status: 'running', createdAt: new Date() }).run()

    const res = await app.request('/a/connection/disconnect', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string }; jobs: Array<{ id: string; scriptName: string }> }
    expect(body.error.code).toBe('job_running')
    expect(body.jobs).toEqual([{ id: 'job-1', scriptName: 'sleep-and-tap' }])
    expect(calls).toEqual([])
  })

  test('force overrides the running-job refusal', async () => {
    const calls: string[] = []
    const { db, app } = makeApp('admin', { connection: { reconnector: () => fakeReconnector(calls), sessions: () => fakeSessions(calls) } })
    seedTcpDevice(db)
    db.insert(jobs).values({ id: 'job-1', scriptId: 'internal:sleep', deviceId: 'a', status: 'running', createdAt: new Date() }).run()

    const res = await app.request(
      '/a/connection/disconnect',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) },
    )
    expect(res.status).toBe(200)
    expect(calls).toContain('transport-disconnected')
  })

  test('closes the session and releases the manual lease BEFORE the transport disconnects (plan 88 §4.6\'s ordering)', async () => {
    const calls: string[] = []
    const leases = fakeLeasesRecording(calls)
    const sessions = fakeSessions(calls)
    const reconnector = fakeReconnector(calls)
    const { db, app } = makeApp('admin', { leases, connection: { reconnector: () => reconnector, sessions: () => sessions } })
    seedTcpDevice(db)

    const res = await app.request('/a/connection/disconnect', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['session-closed', 'lease-released', 'transport-disconnected'])
    expect(sessions.closed).toEqual(['a'])
    expect(leases.released).toEqual([{ deviceId: 'a', reason: 'disconnected' }])
    expect(reconnector.disconnectCalls).toEqual(['stable-a'])
  })

  test('returns the ladder\'s outcome, audits device.disconnect, and records device.disconnected on the main stream', async () => {
    const calls: string[] = []
    const { db, app, records } = makeApp('admin', { connection: { reconnector: () => fakeReconnector(calls), sessions: () => fakeSessions(calls) } })
    seedTcpDevice(db)

    const res = await app.request('/a/connection/disconnect', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ result: 'disconnected' })

    const auditEntry = db.select().from(auditLog).where(eq(auditLog.action, 'device.disconnect')).get()
    expect(auditEntry?.target).toBe('a')
    expect((auditEntry?.meta as { result?: string } | null)?.result).toBe('disconnected')

    const event = records.find((r) => r.kind === 'device.disconnected')
    expect(event).toBeDefined()
    expect(event?.deviceId).toBe('a')
    expect(event?.stream).toBe('main')
  })

  test('is refused with no authenticated user, same as every other device.settings mutation here', async () => {
    const { db, app } = makeApp(null)
    seedTcpDevice(db)
    const res = await app.request('/a/connection/disconnect', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('404s for an unknown device', async () => {
    const { app } = makeApp('admin')
    const res = await app.request('/does-not-exist/connection/disconnect', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('POST /:id/connection/reconnect (plan 88 §3.3, §3.8, §4.4, §4.6, §5 step 88.4, fixes F13, tests H2)', () => {
  test('reuses the SAME DeviceReconnector — passes stableId/opts through and returns its outcome verbatim', async () => {
    const calls: string[] = []
    const reconnector = fakeReconnector(calls, {
      reconnect: async (stableId, opts) => {
        reconnector.reconnectCalls.push({ stableId, opts })
        return { result: 'connected', address: '10.0.0.5:5555', viaSweep: false }
      },
    })
    const { db, app } = makeApp('admin', { connection: { reconnector: () => reconnector, sessions: () => fakeSessions(calls) } })
    seedTcpDevice(db)

    const res = await app.request(
      '/a/connection/reconnect',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowSweep: true, force: true }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ result: 'connected', address: '10.0.0.5:5555', viaSweep: false })
    expect(reconnector.reconnectCalls).toEqual([{ stableId: 'stable-a', opts: { allowSweep: true, force: true } }])
  })

  test('audits device.reconnect and records device.reconnected on the main stream', async () => {
    const calls: string[] = []
    const { db, app, records } = makeApp('admin', { connection: { reconnector: () => fakeReconnector(calls), sessions: () => fakeSessions(calls) } })
    seedTcpDevice(db)

    await app.request('/a/connection/reconnect', { method: 'POST' })
    const auditEntry = db.select().from(auditLog).where(eq(auditLog.action, 'device.reconnect')).get()
    expect(auditEntry?.target).toBe('a')
    const event = records.find((r) => r.kind === 'device.reconnected')
    expect(event?.deviceId).toBe('a')
  })

  test('a not-found outcome is still a 200 — the ladder reports failure as data, not an HTTP error', async () => {
    const calls: string[] = []
    const reconnector = fakeReconnector(calls, {
      reconnect: async () => ({ result: 'not-found', tried: [{ address: '10.0.0.5:5555', preProbe: 'timeout', ms: 300 }], sweep: null }),
    })
    const { db, app } = makeApp('admin', { connection: { reconnector: () => reconnector, sessions: () => fakeSessions(calls) } })
    seedTcpDevice(db)

    const res = await app.request('/a/connection/reconnect', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: string; tried: unknown[] }
    expect(body.result).toBe('not-found')
    expect(body.tried).toHaveLength(1)
  })

  test('refuses E_NOT_SUPPORTED when no reconnector is wired', async () => {
    const { db, app } = makeApp('admin')
    seedTcpDevice(db)
    const res = await app.request('/a/connection/reconnect', { method: 'POST' })
    expect(res.status).toBe(501)
  })

  test('is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null)
    seedTcpDevice(db)
    const res = await app.request('/a/connection/reconnect', { method: 'POST' })
    expect(res.status).toBe(403)
  })
})

describe('PATCH /:id/connection (plan 88 §3.1, §4.6, §5 step 88.4)', () => {
  test('declares a medium for a tcp device, persists it via EndpointStore.declare, and returns the updated connection', async () => {
    const { db, app } = makeApp('admin', { endpoints: fakeEndpoints() })
    seedTcpDevice(db)

    const res = await app.request(
      '/a/connection',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ medium: 'wired' }) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connection: { medium: string | null; mediumSource: string; address: string | null } }
    expect(body.connection.medium).toBe('wired')
    expect(body.connection.mediumSource).toBe('declared')
    expect(body.connection.address).toBe('10.0.0.5')

    const auditEntry = db.select().from(auditLog).where(eq(auditLog.action, 'device.medium')).get()
    expect(auditEntry?.target).toBe('a')
  })

  test('medium: null still declares (an explicit "unknown"), not a clear-and-forget', async () => {
    const endpoints = fakeEndpoints()
    const { db, app } = makeApp('admin', { endpoints })
    seedTcpDevice(db)

    const res = await app.request(
      '/a/connection',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ medium: null }) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connection: { medium: string | null; mediumSource: string } }
    expect(body.connection.medium).toBeNull()
    expect(body.connection.mediumSource).toBe('declared')
    expect(endpoints.declared).toEqual([{ stableId: 'stable-a', address: '10.0.0.5:5555', medium: null }])
  })

  test('refuses E_NOT_ON_NETWORK for a USB device', async () => {
    const { db, app } = makeApp('admin', { endpoints: fakeEndpoints() })
    seedDevice(db, 'a')

    const res = await app.request(
      '/a/connection',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ medium: 'wired' }) },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_ON_NETWORK')
  })

  test('refuses E_NOT_SUPPORTED when no endpoint store is wired', async () => {
    const { db, app } = makeApp('admin')
    seedTcpDevice(db)
    const res = await app.request(
      '/a/connection',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ medium: 'wired' }) },
    )
    expect(res.status).toBe(501)
  })

  test('is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null, { endpoints: fakeEndpoints() })
    seedTcpDevice(db)
    const res = await app.request(
      '/a/connection',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ medium: 'wired' }) },
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /:id/connection/cutover (plan 88 §3.4, §4.6, §5 step 88.5)', () => {
  test('starts the wizard for a USB device, forwards { port, medium, address } to the manager, and returns its state', async () => {
    const cutover = fakeCutoverManager()
    const { db, app } = makeApp('admin', { cutover })
    seedDevice(db, 'a') // USB-shaped serial by default

    const res = await app.request('/a/connection/cutover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 5599, medium: 'wired', address: '10.20.0.9:5555' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cutover: { step: string; port: number; medium: string } }
    expect(body.cutover).toMatchObject({ step: 'armed', port: 5599, medium: 'wired' })
    expect(cutover.startCalls).toEqual([
      { device: { id: 'a', stableId: 'stable-a', serial: 'serial-a', label: 'Test Phone' }, opts: { port: 5599, medium: 'wired', address: '10.20.0.9:5555' } },
    ])

    const auditEntry = db.select().from(auditLog).where(eq(auditLog.action, 'device.cutover.start')).get()
    expect(auditEntry?.target).toBe('a')
  })

  test('refuses E_ALREADY_ON_NETWORK for a device already on tcp — this wizard is for the USB→network move itself', async () => {
    const cutover = fakeCutoverManager()
    const { db, app } = makeApp('admin', { cutover })
    seedTcpDevice(db)

    const res = await app.request('/a/connection/cutover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ medium: 'wired' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_ALREADY_ON_NETWORK')
    expect(cutover.startCalls).toEqual([])
  })

  test('refuses device_offline for an offline device — there is no USB transport to enable TCP mode on', async () => {
    const cutover = fakeCutoverManager()
    const { db, app } = makeApp('admin', { cutover })
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a/connection/cutover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ medium: 'wired' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('device_offline')
    expect(cutover.startCalls).toEqual([])
  })

  test('a running job refuses (coded job_running) and lists it — no force override for a physical port flip', async () => {
    const cutover = fakeCutoverManager()
    const { db, app } = makeApp('admin', { cutover })
    seedDevice(db, 'a')
    db.insert(jobs).values({ id: 'job-1', scriptId: 'internal:sleep', scriptName: 'sleep-and-tap', deviceId: 'a', status: 'running', createdAt: new Date() }).run()

    const res = await app.request('/a/connection/cutover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ medium: 'wired' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string }; jobs: Array<{ id: string; scriptName: string }> }
    expect(body.error.code).toBe('job_running')
    expect(body.jobs).toEqual([{ id: 'job-1', scriptName: 'sleep-and-tap' }])
    expect(cutover.startCalls).toEqual([])
  })

  test('refuses E_NOT_SUPPORTED when no cutover manager is wired', async () => {
    const { db, app } = makeApp('admin')
    seedDevice(db, 'a')
    const res = await app.request('/a/connection/cutover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ medium: 'wired' }),
    })
    expect(res.status).toBe(501)
  })

  test('a malformed body is rejected E_BAD_REQUEST', async () => {
    const { db, app } = makeApp('admin', { cutover: fakeCutoverManager() })
    seedDevice(db, 'a')
    const res = await app.request('/a/connection/cutover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), // medium is required
    })
    expect(res.status).toBe(400)
  })

  test('is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null, { cutover: fakeCutoverManager() })
    seedDevice(db, 'a')
    const res = await app.request('/a/connection/cutover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ medium: 'wired' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('DELETE /:id/connection/cutover (plan 88 §3.4, §4.6, §5 step 88.5) — cancel reverts nothing', () => {
  test('cancels the armed window by stableId, is idempotent, and audits', async () => {
    const cutover = fakeCutoverManager()
    const { db, app } = makeApp('admin', { cutover })
    seedDevice(db, 'a')

    const res = await app.request('/a/connection/cutover', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(cutover.cancelCalls).toEqual(['stable-a'])

    const res2 = await app.request('/a/connection/cutover', { method: 'DELETE' })
    expect(res2.status).toBe(200) // idempotent — cancelling twice is a no-op, not an error
    expect(cutover.cancelCalls).toEqual(['stable-a', 'stable-a'])

    const auditEntry = db.select().from(auditLog).where(eq(auditLog.action, 'device.cutover.cancel')).get()
    expect(auditEntry?.target).toBe('a')
  })

  test('refuses E_NOT_SUPPORTED when no cutover manager is wired', async () => {
    const { db, app } = makeApp('admin')
    seedDevice(db, 'a')
    const res = await app.request('/a/connection/cutover', { method: 'DELETE' })
    expect(res.status).toBe(501)
  })

  test('is refused with no authenticated user', async () => {
    const { db, app } = makeApp(null, { cutover: fakeCutoverManager() })
    seedDevice(db, 'a')
    const res = await app.request('/a/connection/cutover', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

/**
 * The read-back gap step 88.4 flagged and step 88.5 closed (plan 88 §5 step
 * 88.5's own carried-over acceptance criterion): `PATCH /:id/connection`
 * used to persist a declared medium that ONLY that route's own response ever
 * showed — `deriveConnection` never read the endpoint store back, so the
 * VERY NEXT `GET` disagreed with what was just declared. Proven end to end
 * here (through the real HTTP routes, not `deriveConnection` in isolation)
 * for BOTH sources §3.1 defines: an operator's declaration (PATCH, then a
 * later GET) and a farm network match (GET alone, no PATCH involved) — and
 * that a declaration wins when both could apply.
 */
describe('connection.medium read-back on GET (plan 88 §3.1, §5 step 88.5) — not just the PATCH response’s own echo', () => {
  test('a medium declared via PATCH is read back on the NEXT GET /:id, badged OTG', async () => {
    const endpoints = fakeEndpoints()
    const { db, app } = makeApp('admin', { endpoints })
    seedTcpDevice(db)

    const patchRes = await app.request(
      '/a/connection',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ medium: 'wired' }) },
    )
    expect(patchRes.status).toBe(200)

    const getRes = await app.request('/a')
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as { device: { connection: { medium: string | null; mediumSource: string; kind: string } } }
    expect(body.device.connection).toMatchObject({ kind: 'tcp', medium: 'wired', mediumSource: 'declared' })
  })

  test('a medium declared via PATCH is read back on GET /api/devices (the list), not only GET /:id', async () => {
    const endpoints = fakeEndpoints()
    const { db, app } = makeApp('admin', { endpoints })
    seedTcpDevice(db)

    await app.request(
      '/a/connection',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ medium: 'wireless' }) },
    )

    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ id: string; connection: { medium: string | null; mediumSource: string } }> }
    const item = body.items.find((d) => d.id === 'a')
    expect(item?.connection).toMatchObject({ medium: 'wireless', mediumSource: 'declared' })
  })

  test('a farm network match badges a device OTG from GET /api/devices with NO declaration involved', async () => {
    const { db, app } = makeApp('admin', {
      networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }],
    })
    seedTcpDevice(db) // 10.0.0.5:5555 — inside the configured /24

    const res = await app.request('/')
    const body = (await res.json()) as {
      items: Array<{ id: string; connection: { medium: string | null; mediumSource: string; networkLabel: string | null } }>
    }
    const item = body.items.find((d) => d.id === 'a')
    expect(item?.connection).toMatchObject({ medium: 'wired', mediumSource: 'network', networkLabel: 'Chassis A' })
  })

  test('a declaration wins over a network match that would otherwise say wireless', async () => {
    const endpoints = fakeEndpoints()
    const { db, app } = makeApp('admin', {
      endpoints,
      networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', medium: 'wireless', scan: true }],
    })
    seedTcpDevice(db)

    await app.request(
      '/a/connection',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ medium: 'wired' }) },
    )

    const res = await app.request('/a')
    const body = (await res.json()) as { device: { connection: { medium: string | null; mediumSource: string } } }
    expect(body.device.connection).toMatchObject({ medium: 'wired', mediumSource: 'declared' })
  })

  test('with no declaration and no matching network, a tcp device reads TCP — never a guessed WI-FI', async () => {
    const { db, app } = makeApp('admin')
    seedTcpDevice(db)

    const res = await app.request('/a')
    const body = (await res.json()) as { device: { connection: { medium: string | null; mediumSource: string } } }
    expect(body.device.connection).toMatchObject({ medium: null, mediumSource: 'unknown' })
  })
})

/**
 * Residual gap left by plan 88 step 88.5's own pass (fixed here): the admit
 * route (`POST /discovered/:stableId/admit`) called bare `rowToDeviceInfo(row)`
 * for BOTH the `device.added` broadcast and its own response body — the two
 * defaulted params (`networks: []`, `declaredMedia: new Map()`) meant a
 * device admitted on a configured wired network badged `TCP` at the exact
 * moment an operator is most likely watching (right after clicking "Add to
 * farm"), then silently flipped to `OTG` on the next ordinary `GET
 * /api/devices` refetch — which already went through `infoWithTags` and so
 * already read the network/declaration correctly. Proven end to end through
 * the real HTTP route and the real broadcast payload, not `deriveConnection`
 * in isolation, mirroring the "connection.medium read-back on GET" block
 * above.
 */
describe('POST /discovered/:stableId/admit — connection.medium is correct on the FIRST render, not just on a later GET', () => {
  test('admitting a device whose address falls inside a configured wired network broadcasts device.added with medium: wired', async () => {
    const { db, app, broadcast } = makeApp('admin', {
      networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }],
    })
    seedTcpDevice(db) // stable-a, serial 10.0.0.5:5555 — inside the configured /24
    expect((await app.request('/a', { method: 'DELETE' })).status).toBe(200) // forget → lands in Discovered, same serial

    const res = await app.request('/discovered/stable-a/admit', { method: 'POST' })
    expect(res.status).toBe(200)

    // The response body itself — an operator's UI often renders THIS directly.
    const body = (await res.json()) as { device: { connection: { medium: string | null; mediumSource: string; networkLabel: string | null } } }
    expect(body.device.connection).toMatchObject({ medium: 'wired', mediumSource: 'network', networkLabel: 'Chassis A' })

    // The broadcast every OTHER connected Studio tab renders from — must agree.
    const added = broadcast.find((m) => m.type === 'device.added') as { type: string; payload: { connection: { medium: string | null; mediumSource: string } } } | undefined
    expect(added?.payload.connection).toMatchObject({ medium: 'wired', mediumSource: 'network' })
  })

  test('a declared medium (from a prior forget/re-admit cycle, F15) wins over a network match on admit', async () => {
    const endpoints = fakeEndpoints()
    const { db, app } = makeApp('admin', {
      endpoints,
      networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', medium: 'wireless', scan: true }],
    })
    seedTcpDevice(db)
    expect((await app.request('/a', { method: 'DELETE' })).status).toBe(200)
    // The address book survives Forget (F15) — an operator declared this one wired earlier.
    endpoints.declare('stable-a', '10.0.0.5:5555', 'wired')

    const res = await app.request('/discovered/stable-a/admit', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { connection: { medium: string | null; mediumSource: string } } }
    expect(body.device.connection).toMatchObject({ medium: 'wired', mediumSource: 'declared' })
  })

  test('with no network and no declaration, admit still reads the honest TCP — never a guessed WI-FI', async () => {
    const { db, app } = makeApp('admin')
    seedTcpDevice(db)
    expect((await app.request('/a', { method: 'DELETE' })).status).toBe(200)

    const res = await app.request('/discovered/stable-a/admit', { method: 'POST' })
    const body = (await res.json()) as { device: { connection: { medium: string | null; mediumSource: string } } }
    expect(body.device.connection).toMatchObject({ medium: null, mediumSource: 'unknown' })
  })
})

describe('DELETE /api/devices/:id — Forget (plan 47 §4.4, §6)', () => {
  test('an offline device is forgotten: 200, gone from the list, a device.removed broadcast, an audit entry', async () => {
    const { db, app, broadcast } = makeApp()
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, 'a')).run()

    const res = await app.request('/a', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      forgotten: { deviceId: string; stableId: string; historyDeleted: boolean; counts: unknown; kvDeleted: number }
    }
    // `kvDeleted: 0` — this test's `makeApp()` wires no `kv` dependency into `createDeviceLifecycle`
    // (plan 79 §3.3, §4.6); the kv store's own lifecycle integration is covered directly in
    // `device/lifecycle.test.ts`.
    expect(body.forgotten).toEqual({ deviceId: 'a', stableId: 'stable-a', historyDeleted: false, counts: null, kvDeleted: 0 })

    expect(db.select().from(devices).where(eq(devices.id, 'a')).all()).toHaveLength(0)
    expect(db.select().from(deletedDevices).where(eq(deletedDevices.id, 'a')).get()?.stableId).toBe('stable-a')
    expect(broadcast).toContainEqual({ type: 'device.removed', payload: { id: 'a', stableId: 'stable-a' } })
    const auditRows = db.select().from(auditLog).where(eq(auditLog.action, 'device.forget')).all()
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]?.target).toBe('a')
  })

  test('the round trip: forget a connected device, then admit it again — the loop the old refusal made impossible', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')

    expect((await app.request('/a', { method: 'DELETE' })).status).toBe(200)

    const tray = (await (await app.request('/discovered')).json()) as { discovered: Array<{ stableId: string }> }
    expect(tray.discovered.map((d) => d.stableId)).toEqual(['stable-a'])

    const admitted = await app.request('/discovered/stable-a/admit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Rack 3 slot 2' }),
    })
    expect(admitted.status).toBe(200)

    const rows = db.select().from(devices).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.label).toBe('Rack 3 slot 2')
    // The device kept its identity across the whole loop, which is the promise
    // `stableId` makes (spec §7.5) — only the row id is new.
    expect(rows[0]?.stableId).toBe('stable-a')
    expect(db.select().from(discoveredDevices).all()).toHaveLength(0)
  })

  test('admitting something that is not in the tray is a 404, not a server error', async () => {
    const { app } = makeApp()
    const res = await app.request('/discovered/never-seen/admit', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NOT_DISCOVERED')
  })

  test('dismiss removes the entry without blocking anything (plan 56 §3.5)', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    await app.request('/a', { method: 'DELETE' })
    expect(db.select().from(discoveredDevices).all()).toHaveLength(1)

    expect((await app.request('/discovered/stable-a', { method: 'DELETE' })).status).toBe(200)

    expect(db.select().from(discoveredDevices).all()).toHaveLength(0)
    // Dismissal is not a quiet block — nothing was added to the block list, so
    // the phone is free to reappear the next time it connects.
    expect(db.select().from(blockedDevices).all()).toHaveLength(0)
  })

  test('forgetting an online device succeeds and lands it in the Discovered tray (plan 56 §3.2)', async () => {
    // Until plan 56 this was a 409 `device_online` with an offer to block
    // instead — the trap that made an operator declare a phone permanently
    // unwelcome just to take it out of the farm.
    const { db, app } = makeApp()
    seedDevice(db, 'a') // seedDevice leaves status: 'idle'

    const res = await app.request('/a', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(db.select().from(devices).where(eq(devices.id, 'a')).all()).toHaveLength(0)
    expect(db.select().from(discoveredDevices).all()).toHaveLength(1)
    expect(db.select().from(blockedDevices).all()).toHaveLength(0)
  })

  test('?deleteHistory=true deletes exactly the counts GET /:id/history-counts promised', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, 'a')).run()
    db.insert(deviceEvents).values({ id: 'e1', deviceId: 'a', stream: 'main', kind: 'device.online', at: new Date() }).run()

    const before = await app.request('/a/history-counts')
    const beforeBody = (await before.json()) as { counts: { jobs: number; artifacts: number; events: number } }
    expect(beforeBody.counts.events).toBe(1)

    const res = await app.request('/a?deleteHistory=true', { method: 'DELETE' })
    const body = (await res.json()) as { forgotten: { historyDeleted: boolean; counts: unknown } }
    expect(body.forgotten.historyDeleted).toBe(true)
    expect(body.forgotten.counts).toEqual(beforeBody.counts)
    expect(db.select().from(deviceEvents).where(eq(deviceEvents.deviceId, 'a')).all()).toHaveLength(0)
  })

  test('an unknown device is refused with 404', async () => {
    const { app } = makeApp()
    const res = await app.request('/ghost', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/devices/:id/block (plan 47 §4.4, §6)', () => {
  test('blocks a connected device: it disappears from the fleet, is listed under GET /blocked, and can be unblocked', async () => {
    const { db, app, broadcast } = makeApp()
    seedDevice(db, 'a') // idle — the connected case this verb exists for.

    const res = await app.request('/a/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'retired' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blocked: { stableId: string; reason: string | null } }
    expect(body.blocked).toMatchObject({ stableId: 'stable-a', reason: 'retired' })

    expect(db.select().from(devices).where(eq(devices.id, 'a')).all()).toHaveLength(0)
    expect(broadcast).toContainEqual({ type: 'device.removed', payload: { id: 'a', stableId: 'stable-a' } })

    const list = await app.request('/blocked')
    const listBody = (await list.json()) as { blocked: Array<{ stableId: string }> }
    expect(listBody.blocked.map((b) => b.stableId)).toEqual(['stable-a'])

    const unblock = await app.request('/blocked/stable-a', { method: 'DELETE' })
    expect(unblock.status).toBe(200)
    const listAfter = await app.request('/blocked')
    const listAfterBody = (await listAfter.json()) as { blocked: unknown[] }
    expect(listAfterBody.blocked).toEqual([])
    const auditRows = db.select().from(auditLog).where(eq(auditLog.action, 'device.unblock')).all()
    expect(auditRows).toHaveLength(1)
  })

  test('block is refused for a busy device, exactly like forget', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.update(devices).set({ status: 'busy' }).where(eq(devices.id, 'a')).run()
    const res = await app.request('/a/block', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('device_busy')
  })

  test('a blocked stableId never comes back through GET /api/devices — it is not in the live list', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(blockedDevices).values({ stableId: 'blocked-elsewhere', label: null, reason: null, blockedAt: new Date(), blockedBy: null }).run()
    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ stableId: string }> }
    expect(body.items.map((d) => d.stableId)).toEqual(['stable-a'])
  })
})

describe('GET /api/devices/refs — dangling-reference resolution (plan 47 §4.5)', () => {
  test('resolves a live device and a deleted one in the same call, and omits an id neither table has', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(deletedDevices).values({ id: 'gone-1', stableId: 'stable-gone-1', label: 'Old Phone', deletedAt: new Date() }).run()

    const res = await app.request('/refs?ids=a,gone-1,never-existed')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      refs: Record<string, { id: string; label: string | null; stableId: string; deleted: boolean }>
    }
    expect(body.refs.a).toEqual({ id: 'a', label: 'Test Phone', stableId: 'stable-a', deleted: false })
    expect(body.refs['gone-1']).toEqual({ id: 'gone-1', label: 'Old Phone', stableId: 'stable-gone-1', deleted: true })
    expect(body.refs['never-existed']).toBeUndefined()
  })

  test('no permission required — the same "reads stay open" rule as GET /:id', async () => {
    const { app } = makeApp(null)
    const res = await app.request('/refs?ids=x')
    expect(res.status).toBe(200)
  })
})

/**
 * The device number reaching the protocol and the API (plan 89 §3.1, §3.2,
 * §4.2, §4.3, step 89.2). `seedDevice` creates a bare `devices` row with no
 * `device_numbers` reservation (the same "not through admitDevice" shape
 * every other test in this file already uses) — `allocateDeviceNumber` is
 * called explicitly wherever a test needs a real number, exactly the way
 * `admitDevice` itself would.
 */
describe('the device number reaches the protocol and the API (plan 89 §4.2, §4.3, step 89.2)', () => {
  function seedLabelledNumber(db: Db, id: string, label: string): void {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label, status: 'idle' }).run()
  }

  test('GET /:id carries the allocated number', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    allocateDeviceNumber(db, 'stable-a')
    const res = await app.request('/a')
    const body = (await res.json()) as { device: { number: number | null } }
    expect(body.device.number).toBe(1)
  })

  test('a device with no reservation reads number: null, never 0 or undefined', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    const res = await app.request('/a')
    const body = (await res.json()) as { device: { number: number | null } }
    expect(body.device.number).toBeNull()
  })

  test('GET / (the list) carries every device\'s number, one query for the fleet', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    allocateDeviceNumber(db, 'stable-a')
    allocateDeviceNumber(db, 'stable-b')
    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ id: string; number: number | null }> }
    const byId = Object.fromEntries(body.items.map((d) => [d.id, d.number]))
    expect(byId).toEqual({ a: 1, b: 2 })
  })

  test('POST /discovered/:stableId/admit — the broadcast and the response both carry the freshly allocated number (the class of bug this plan is against: a field that only the DB knows)', async () => {
    const { db, app, broadcast } = makeApp()
    db.insert(discoveredDevices).values({ stableId: 'sid-new', serial: 'serial-new', label: 'New Phone', firstSeen: new Date(), lastSeen: new Date() }).run()
    const res = await app.request('/discovered/sid-new/admit', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { number: number | null } }
    expect(body.device.number).toBe(1)
    const added = broadcast.find((m) => m.type === 'device.added') as { payload: { number: number | null } } | undefined
    expect(added?.payload.number).toBe(1)
  })

  test('?sort=number is the default order — a device admitted later, with a higher number, sorts after an earlier one regardless of label', async () => {
    const { db, app } = makeApp()
    seedLabelledNumber(db, 'a', 'zzz-last-alphabetically')
    seedLabelledNumber(db, 'b', 'aaa-first-alphabetically')
    allocateDeviceNumber(db, 'stable-a')
    allocateDeviceNumber(db, 'stable-b')
    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ id: string }> }
    expect(body.items.map((d) => d.id)).toEqual(['a', 'b'])
  })

  test('?sort=label still paginates as it did before this plan (regression watch §7.4)', async () => {
    const { db, app } = makeApp()
    seedLabelledNumber(db, 'a', 'zzz-last')
    seedLabelledNumber(db, 'b', 'aaa-first')
    const res = await app.request('/?sort=label')
    const body = (await res.json()) as { items: Array<{ id: string }> }
    expect(body.items.map((d) => d.id)).toEqual(['b', 'a'])
  })

  test('an unrecognised ?sort= value is a 400, not a silent fallback', async () => {
    const { app } = makeApp()
    const res = await app.request('/?sort=bogus')
    expect(res.status).toBe(400)
  })

  test('PATCH /:id with a free number sets it', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    const res = await app.request('/a', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number: 7 }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { number: number | null } }
    expect(body.device.number).toBe(7)
    expect(lookupDeviceNumber(db, 'stable-a')).toBe(7)
  })

  test('PATCH /:id with a number already held by another device is refused with 409 E_NUMBER_TAKEN, naming the holder — never a 500, never a silent swap', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    setDeviceNumber(db, 'stable-a', 3, { userId: null })
    const res = await app.request('/b', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number: 3 }) })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_NUMBER_TAKEN')
    expect(body.error.message).toContain('stable-a')
    // Refused, not resolved: device b's number is untouched.
    expect(lookupDeviceNumber(db, 'stable-b')).toBeNull()
  })

  test('POST /numbers/compact renumbers 1..n in list order and reports exactly the devices that moved', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    seedDevice(db, 'c')
    setDeviceNumber(db, 'stable-a', 3, { userId: null })
    setDeviceNumber(db, 'stable-b', 7, { userId: null })
    setDeviceNumber(db, 'stable-c', 8, { userId: null })
    const res = await app.request('/numbers/compact', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { changed: Array<{ stableId: string; from: number; to: number }> }
    expect(body.changed).toHaveLength(3)
    expect(lookupDeviceNumber(db, 'stable-a')).toBe(1)
    expect(lookupDeviceNumber(db, 'stable-b')).toBe(2)
    expect(lookupDeviceNumber(db, 'stable-c')).toBe(3)
  })

  test('DELETE /numbers/:stableId releases the reservation — freed for compaction, never reused by the next automatic allocation', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    allocateDeviceNumber(db, 'stable-a')
    const res = await app.request('/numbers/stable-a', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(lookupDeviceNumber(db, 'stable-a')).toBeNull()
    // The next automatic allocation never reissues the released number (§3.2).
    seedDevice(db, 'z')
    const allocated = allocateDeviceNumber(db, 'stable-z')
    expect(allocated.number).toBe(2)
  })

  test('DELETE /numbers/:stableId is idempotent — releasing an already-numberless stableId is a no-op, not a 404', async () => {
    const { app } = makeApp()
    const res = await app.request('/numbers/never-reserved', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  test('POST /numbers/compact re-applies the label of every device whose number moved, in the same request', async () => {
    const { service, calls } = fakeLabelling()
    const { db, app } = makeApp('admin', { labelling: service })
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    setDeviceNumber(db, 'stable-a', 3, { userId: null })
    setDeviceNumber(db, 'stable-b', 7, { userId: null })
    const res = await app.request('/numbers/compact', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { changed: unknown[]; relabelled: number; failed: unknown[] }
    expect(body.changed).toHaveLength(2)
    expect(body.relabelled).toBe(2)
    expect(body.failed).toEqual([])
    expect(calls.filter((c) => c.method === 'apply')).toHaveLength(2)
  })

  test('POST /numbers/compact reports a per-device failure without failing the whole request', async () => {
    const { service } = fakeLabelling({
      apply: async (deviceId) => {
        throw new Error(`boom for ${deviceId}`)
      },
    })
    const { db, app } = makeApp('admin', { labelling: service })
    seedDevice(db, 'a')
    setDeviceNumber(db, 'stable-a', 3, { userId: null })
    const res = await app.request('/numbers/compact', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { relabelled: number; failed: Array<{ stableId: string; reason: string }> }
    expect(body.relabelled).toBe(0)
    expect(body.failed).toHaveLength(1)
    expect(body.failed[0]!.stableId).toBe('stable-a')
    expect(body.failed[0]!.reason).toContain('boom')
  })
})

/**
 * Plan 100 §4.3, step 100.6 (closes G11/96.22) — `liveDisplay`, sourced live
 * from `SessionManager.get`, distinct from `display` (the stored, configured
 * column). The whole point of this field is that the two are ALLOWED to
 * disagree — this is the fixture that proves it.
 */
describe('GET /:id — liveDisplay (plan 100 §4.3, step 100.6)', () => {
  test('with no session open, liveDisplay is null — nothing live to report', async () => {
    const calls: string[] = []
    const { db, app } = makeApp('admin', { connection: { reconnector: () => fakeReconnector(calls), sessions: () => fakeSessions(calls) } })
    seedDevice(db, 'a')
    const res = await app.request('/a')
    const body = (await res.json()) as { device: { display: string; liveDisplay: string | null } }
    expect(body.device.display).toBe('scrcpy') // the configured column (seedDevice's default)
    expect(body.device.liveDisplay).toBeNull()
  })

  test('a session on the screencap-loop fallback reports liveDisplay: "screencap-loop" while display (configured) still reads "scrcpy" — the two are allowed to disagree', async () => {
    const calls: string[] = []
    const sessions: Pick<SessionManager, 'closeDevice' | 'restartAt' | 'get'> = {
      closeDevice: async () => {},
      restartAt: async () => {},
      get: () => ({ displayEngineId: 'screencap-loop' }) as unknown as ReturnType<SessionManager['get']>,
    }
    const { db, app } = makeApp('admin', { connection: { reconnector: () => fakeReconnector(calls), sessions: () => sessions } })
    seedDevice(db, 'a')
    const res = await app.request('/a')
    const body = (await res.json()) as { device: { display: string; liveDisplay: string | null } }
    expect(body.device.display).toBe('scrcpy')
    expect(body.device.liveDisplay).toBe('screencap-loop')
  })

  test('a healthy session reports liveDisplay: "scrcpy", agreeing with the configured display', async () => {
    const calls: string[] = []
    const sessions: Pick<SessionManager, 'closeDevice' | 'restartAt' | 'get'> = {
      closeDevice: async () => {},
      restartAt: async () => {},
      get: () => ({ displayEngineId: 'scrcpy' }) as unknown as ReturnType<SessionManager['get']>,
    }
    const { db, app } = makeApp('admin', { connection: { reconnector: () => fakeReconnector(calls), sessions: () => sessions } })
    seedDevice(db, 'a')
    const res = await app.request('/a')
    const body = (await res.json()) as { device: { display: string; liveDisplay: string | null } }
    expect(body.device.display).toBe('scrcpy')
    expect(body.device.liveDisplay).toBe('scrcpy')
  })
})

describe('Physical labelling endpoints (plan 89 §4.3, §4.6, §5 step 89.4/89.9)', () => {
  test('GET /:id/label refuses with E_NOT_SUPPORTED when no labelling service is wired', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    const res = await app.request('/a/label')
    expect(res.status).toBe(501)
  })

  test('GET /:id/label returns the service state VERBATIM — partial is never rounded up to applied', async () => {
    const { service } = fakeLabelling({
      status: async () => ({
        mode: 'wallpaper',
        state: 'partial',
        reason: 'only the home screen accepted the label',
        fingerprint: 'fp2',
        appliedAt: 1,
        originalCaptured: true,
        capturedLockScreen: null,
      }),
    })
    const { db, app } = makeApp('admin', { labelling: service })
    seedDevice(db, 'a')
    const res = await app.request('/a/label')
    expect(res.status).toBe(200)
    const body = (await res.json()) as DeviceLabelState
    expect(body.state).toBe('partial')
    expect(body.state).not.toBe('applied')
  })

  test('POST /:id/label/apply calls the service, audits, and returns its state', async () => {
    const { service, calls } = fakeLabelling()
    const { db, app } = makeApp('admin', { labelling: service })
    seedDevice(db, 'a')
    const res = await app.request('/a/label/apply', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as DeviceLabelState
    expect(body.state).toBe('applied')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'apply', deviceId: 'a' })
  })

  test('POST /:id/label/clear defaults restoreOriginal to false and forwards it to the service', async () => {
    const { service, calls } = fakeLabelling()
    const { db, app } = makeApp('admin', { labelling: service })
    seedDevice(db, 'a')
    const res = await app.request('/a/label/clear', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'clear', deviceId: 'a', opts: { restoreOriginal: false } })
  })

  test('POST /:id/label/clear honours an explicit restoreOriginal: true', async () => {
    const { service, calls } = fakeLabelling()
    const { db, app } = makeApp('admin', { labelling: service })
    seedDevice(db, 'a')
    await app.request('/a/label/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ restoreOriginal: true }) })
    expect(calls[0]).toMatchObject({ opts: { restoreOriginal: true } })
  })

  test('POST /labels/apply applies every requested device and reports a per-device error without failing the whole request', async () => {
    const { service } = fakeLabelling({
      apply: async (deviceId) => {
        if (deviceId === 'bad') throw new Error('agent unreachable')
        return {
          mode: 'wallpaper',
          state: 'applied',
          reason: null,
          fingerprint: 'fp3',
          appliedAt: 1,
          originalCaptured: true,
          capturedLockScreen: null,
        }
      },
    })
    const { db, app } = makeApp('admin', { labelling: service })
    seedDevice(db, 'good')
    seedDevice(db, 'bad')
    const res = await app.request('/labels/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceIds: ['good', 'bad'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { total: number; results: Array<{ deviceId: string; state: DeviceLabelState | null; error: string | null }> }
    expect(body.total).toBe(2)
    const good = body.results.find((r) => r.deviceId === 'good')!
    const bad = body.results.find((r) => r.deviceId === 'bad')!
    expect(good.state?.state).toBe('applied')
    expect(good.error).toBeNull()
    expect(bad.state).toBeNull()
    expect(bad.error).toContain('agent unreachable')
  })

  test('PATCH /:id renaming a device schedules a debounced label reconcile, not an immediate one', async () => {
    const { service, calls } = fakeLabelling()
    const { db, app } = makeApp('admin', { labelling: service })
    seedDevice(db, 'a')
    await app.request('/a', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'New Name' }) })
    // Not fired synchronously with the response — that is the whole point of debouncing.
    expect(calls).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'reconcile', deviceId: 'a' })
  })

  test('PATCH /:id changing settings but NOT label/number never schedules a label reconcile (not a poll loop in disguise)', async () => {
    const { service, calls } = fakeLabelling()
    const { db, app } = makeApp('admin', { labelling: service })
    seedDevice(db, 'a')
    await app.request('/a', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerId: 'someone' }) })
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(calls).toHaveLength(0)
  })
})
