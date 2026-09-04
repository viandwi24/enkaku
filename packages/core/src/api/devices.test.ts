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
import { artifacts, auditLog, blockedDevices, groups, deletedDevices, deviceEvents, deviceTags, devices, discoveredDevices, jobs } from '../db/schema'
import type { BatteryMonitor } from '../device/battery'
import { createDeviceLifecycle } from '../device/lifecycle'
import type { LabellingService } from '../device/labelling'
import type { ActivityRegistry } from '../activity/registry'
import type { DeviceActivity } from '@enkaku/protocol'
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

/** A live `job` activity, the shape `checkRemovable`/`runningJobOf` look for (plan 205 §4.9) — used to make a device "busy" for a test without the deleted `devices.status: 'busy'` literal. */
function jobActivity(deviceId: string): DeviceActivity {
  return {
    id: `job:${deviceId}`,
    kind: 'job',
    label: 'running',
    actor: { kind: 'system', id: 'core', label: 'Scheduler' },
    startedAt: 0,
    updatedAt: 0,
  }
}

/**
 * No test in this file needs a live control/command marker on the fake
 * itself — `activitiesOf` (wired separately, per test) is what a route reads
 * to build `DeviceInfo.activities`/`.lastControl`; this is only the registry
 * SLICE `createDeviceLifecycle` and the router's own `runningJobOf`/`endWhere`
 * read (plan 205 §4.9, §4.10). `runningJobDeviceIds` makes `list` report a
 * live `job` activity for exactly the devices a test names, the direct
 * equivalent of the deleted `devices.status: 'busy'` literal.
 *
 * The connection tests (plan 88 §5 step 88.4) need to OBSERVE the disconnect
 * route's ordering ("closes the session and ends every control/command
 * activity FIRST") — `calls`, when passed, is the SAME shared log the
 * session/reconnector fakes below push onto, so a test can assert both that
 * each step ran AND the order they ran in with one array, rather than
 * separate spies that cannot be compared against each other.
 */
function fakeActivities(opts: { runningJobDeviceIds?: Set<string>; calls?: string[] } = {}): Pick<ActivityRegistry, 'list' | 'endWhere'> {
  return {
    list: (deviceId) => (opts.runningJobDeviceIds?.has(deviceId) ? [jobActivity(deviceId)] : []),
    endWhere: () => {
      opts.calls?.push('activity-ended')
      return 0
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
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: 'Test Phone', status: 'online' })
    .run()
  const now = new Date()
  for (const tag of tags) db.insert(deviceTags).values({ deviceId: id, tag, at: now }).run()
}

/** An admin user by default, matching what these pre-existing tests already assumed implicitly. */
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
    /** Makes `list`/`runningJobOf` report a live `job` activity for exactly these device ids (plan 205 §4.9) — the equivalent of the deleted `devices.status: 'busy'` literal. */
    runningJobDeviceIds?: Set<string>
    /** Shared call-order log for the disconnect-ordering test — see `fakeActivities`'s own comment. */
    activityCalls?: string[]
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
  const activities = fakeActivities({ runningJobDeviceIds: opts.runningJobDeviceIds, calls: opts.activityCalls })
  const controlSettings = () => ({ overControl: 'allow' as const, idleSec: 30 })
  const lifecycle = createDeviceLifecycle({ db, activities, controlSettings, log: createLogger('test') })
  const app = withUser(
    role,
    createDeviceRoutes({
      db,
      registry: opts.registry ?? (async () => emptyRegistry()),
      battery: opts.battery ?? (() => null),
      audit,
      dataDir,
      lifecycle,
      activitiesOf: () => ({ activities: [], lastControl: null }),
      broadcast: (msg) => broadcast.push(msg),
      record: (e) => records.push(e),
      // Every mode this router is mounted in has a real activity registry and
      // job store (plan 88 §4.6, §5 step 88.4's own comment on why these two
      // are required, not optional) — `createJobStore(db)` is the real
      // thing, not a fake, since `jobStore.list` is plain SQL over the SAME
      // in-memory db every other assertion in this file already reads.
      activities,
      runningJobOf: (deviceId) => opts.runningJobDeviceIds?.has(deviceId) ?? false,
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

/** Plan 89 §4.3, §4.6, §5 step 89.4/89.9 — a controllable fake `LabellingService`, mirroring `fakeActivities`' shape above: every call is recorded, so a test can assert both WHICH method ran and with what arguments. */
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
    const activities = fakeActivities()
    const controlSettings = () => ({ overControl: 'allow' as const, idleSec: 30 })
    const lifecycle = createDeviceLifecycle({ db, activities, controlSettings, log: createLogger('test') })
    const app = createDeviceRoutes({
      db,
      registry: async () => emptyRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      activitiesOf: () => ({ activities: [], lastControl: null }),
      broadcast: () => {},
      activities,
      runningJobOf: () => false,
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
 * Plan 205 §4.10, criterion 1 — `activities`/`lastControl` on every
 * `DeviceInfo` this router builds: the list endpoint, the single-device
 * endpoint, and everywhere else `rowToDeviceInfo`/`listDevicesWithTags` are
 * called from here. Replaces the old single-holder field and the old
 * secondary-operators field from the two prototype-era plans that added
 * them — both collapsed into the one `activitiesOf` accessor and the plain
 * `DeviceActivity[]` it returns (MVP 04 §1.1, §1.2).
 */
describe('GET /api/devices — activities/lastControl (plan 205 §4.10, criterion 1)', () => {
  const controlActivity: DeviceActivity = {
    id: 'control:client-1',
    kind: 'control',
    label: 'Controlled by Rani',
    actor: { kind: 'user', id: 'u-1', label: 'Rani' },
    startedAt: 100,
    updatedAt: 100,
  }
  const commandActivity: DeviceActivity = {
    id: 'command:run-1',
    kind: 'command',
    label: 'Running a shell command',
    actor: { kind: 'user', id: 'u-2', label: 'operator@enkaku' },
    startedAt: 100,
    updatedAt: 100,
  }

  function appWithActivities(db: Db, activitiesOf: (deviceId: string) => { activities: DeviceActivity[]; lastControl: null }) {
    const audit = createAuditLogger(db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-test-'))
    const activities = fakeActivities()
    const controlSettings = () => ({ overControl: 'allow' as const, idleSec: 30 })
    const lifecycle = createDeviceLifecycle({ db, activities, controlSettings, log: createLogger('test') })
    return createDeviceRoutes({
      db,
      registry: async () => emptyRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      activitiesOf,
      broadcast: () => {},
      activities,
      runningJobOf: () => false,
      jobStore: createJobStore(db),
    })
  }

  test('a device with a live activity carries it on the list endpoint; one with none carries []', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    const app = appWithActivities(db, (deviceId) => (deviceId === 'a' ? { activities: [controlActivity], lastControl: null } : { activities: [], lastControl: null }))

    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ id: string; activities: unknown }> }
    const a = body.items.find((d) => d.id === 'a')!
    const b = body.items.find((d) => d.id === 'b')!
    expect(a.activities).toEqual([controlActivity])
    expect(b.activities).toEqual([])
  })

  test('the single-device endpoint carries the same activities', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    const app = appWithActivities(db, () => ({ activities: [controlActivity], lastControl: null }))

    const res = await app.request('/a')
    const body = (await res.json()) as { device: { activities: unknown } }
    expect(body.device.activities).toEqual([controlActivity])
  })

  test('several concurrent activities on one device (a control marker AND a command run) all carry through, on both endpoints', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'a')
    const app = appWithActivities(db, () => ({ activities: [controlActivity, commandActivity], lastControl: null }))

    const listRes = await app.request('/')
    const listBody = (await listRes.json()) as { items: Array<{ id: string; activities: unknown }> }
    expect(listBody.items.find((d) => d.id === 'a')?.activities).toEqual([controlActivity, commandActivity])

    const oneRes = await app.request('/a')
    const oneBody = (await oneRes.json()) as { device: { activities: unknown } }
    expect(oneBody.device.activities).toEqual([controlActivity, commandActivity])
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

// `PUT /:id/tags` and `PUT /:id/group` are removed by plan 207 (MVP 07):
// `set-tags` and `set-group` are actions API verbs now, tested in
// `packages/core/src/api/actions.test.ts`.

/**
 * Security fix (plan 09 §4.4's `device.owner.set`, never carried into the
 * ACL until now): `PATCH /:id` let any authenticated operator set a
 * device's `ownerId` to themselves or anyone else, with no permission check
 * and no audit trail — defeating the ownership model `canUseDevice`
 * otherwise enforces for control acquisition, job enqueue, and the adb
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

describe('GET /api/devices?groupId= (plan 22.0 §4.4, acceptance #4)', () => {
  test('groupId=<id> returns only that group\'s members; groupId=none returns exactly the devices with no group', async () => {
    const { db, app } = makeApp()
    db.insert(groups).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    seedDevice(db, 'c')
    db.update(devices).set({ groupId: 'c1' }).where(eq(devices.id, 'a')).run()
    db.update(devices).set({ groupId: 'c1' }).where(eq(devices.id, 'b')).run()

    const grouped = await app.request('/?groupId=c1')
    const groupedBody = (await grouped.json()) as { items: Array<{ id: string }> }
    expect(groupedBody.items.map((d) => d.id).sort()).toEqual(['a', 'b'])

    const none = await app.request('/?groupId=none')
    const noneBody = (await none.json()) as { items: Array<{ id: string }> }
    expect(noneBody.items.map((d) => d.id)).toEqual(['c'])
  })
})

describe('GET /api/devices keyset pagination (label ASC, id ASC)', () => {
  function seedLabelled(db: Db, id: string, label: string): void {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label, status: 'online' }).run()
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

describe('requirePermission("device.settings") on read routes (plan 34 §4.4, §4.5, acceptance #7)', () => {
  test('GET /:id needs no permission at all — read routes stay open', async () => {
    const { db, app } = makeApp(null)
    seedDevice(db, 'a')
    const res = await app.request('/a')
    expect(res.status).toBe(200)
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
 * permission the actions API's `set-tags`/`set-group` verbs already use —
 * and audited as `device.drivers`.
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
// `POST /:id/unquarantine` is removed by plan 207 (MVP 07): `unquarantine`
// is an actions API verb now, tested in `packages/core/src/api/actions.test.ts`.

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
    networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', addresses: 256, port: 5555 }],
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

// 'POST /:id/connection/disconnect' and 'POST /:id/connection/reconnect'
// are removed by plan 207 (MVP 07): disconnect and reconnect are actions
// API verbs now, tested in actions.test.ts.

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

// 'POST /:id/connection/cutover' and 'DELETE /:id/connection/cutover' are
// removed by plan 207 (MVP 07): cutover is an actions API verb now
// ({ op: 'start' | 'cancel' }), tested in actions.test.ts.


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

// The "connection.medium is correct on the FIRST render" admit tests used
// `DELETE /:id` (Forget) to put a device back in the Discovered tray before
// re-admitting it. `DELETE /:id` is removed by plan 207 (MVP 07): `forget`
// is an actions API verb now, and this forget/re-admit round trip is no
// longer reachable through this router (see the note below).

// 'DELETE /:id' (Forget) and 'POST /:id/block' are removed by plan 207
// (MVP 07): forget and block are actions API verbs now, tested in
// actions.test.ts. The discovered-tray admit/dismiss round trip these
// tests exercised via DELETE is no longer reachable through this router.


describe('GET /api/devices/refs — dangling-reference resolution (plan 47 §4.5)', () => {
  test('resolves a live device and a deleted one in the same call, and omits an id neither table has', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    db.insert(deletedDevices).values({ id: 'gone-1', stableId: 'stable-gone-1', label: 'Old Phone', deletedAt: new Date() }).run()

    const res = await app.request('/refs?ids=a,gone-1,never-existed')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      refs: Record<string, { id: string; label: string | null; stableId: string; deleted: boolean; number: number | null }>
    }
    // `number: null` for both — neither seeded device holds a `device_numbers`
    // reservation (plan 89 §3.3: a missing number is a real state, never an
    // error, and never `0` or `undefined` on the wire).
    expect(body.refs.a).toEqual({ id: 'a', label: 'Test Phone', stableId: 'stable-a', deleted: false, number: null })
    expect(body.refs['gone-1']).toEqual({ id: 'gone-1', label: 'Old Phone', stableId: 'stable-gone-1', deleted: true, number: null })
    expect(body.refs['never-existed']).toBeUndefined()
  })

  /**
   * Plan 124 §3.7, §3.1 — the highest-value of that section's five payloads.
   * Studio's `deviceRefLabel` (`packages/studio/src/lib/api.ts`) calls itself
   * "the one place this formatting rule lives", and it could not obey the
   * rule while `DeviceRef` carried no number at all: a jobs list naming three
   * phones all labelled `SM-F721U1` was unreadable.
   *
   * The number rides as its own field, NOT composed into `label` — plan 124
   * §3.1's rule that the number composes at render time and never enters the
   * stored label, so nothing downstream has to parse `#7` back out.
   */
  test('a live ref carries its allocated number as its own field, leaving label untouched (plan 124 §3.7)', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    allocateDeviceNumber(db, 'stable-a')

    const res = await app.request('/refs?ids=a')
    const body = (await res.json()) as { refs: Record<string, { label: string | null; number: number | null }> }
    expect(body.refs.a?.number).toBe(1)
    expect(body.refs.a?.label).toBe('Test Phone')
  })

  /**
   * `forget()` deliberately leaves the `device_numbers` row standing (plan 89
   * §3.2's sticky-reservation guarantee), and `device_numbers` is keyed on
   * `stableId` — which `deleted_devices` also carries. So a forgotten device
   * keeps its number in every historical reference to it, rather than losing
   * half the identity that made a job row findable in the first place. This
   * asserts the deleted half of the route reads the SAME map as the live half.
   */
  test('a deleted ref keeps the number its stableId still reserves (plan 89 §3.2 + plan 124 §3.7)', async () => {
    const { db, app } = makeApp()
    db.insert(deletedDevices).values({ id: 'gone-1', stableId: 'stable-gone-1', label: 'Old Phone', deletedAt: new Date() }).run()
    allocateDeviceNumber(db, 'stable-gone-1')

    const res = await app.request('/refs?ids=gone-1')
    const body = (await res.json()) as {
      refs: Record<string, { id: string; label: string | null; stableId: string; deleted: boolean; number: number | null }>
    }
    expect(body.refs['gone-1']).toEqual({ id: 'gone-1', label: 'Old Phone', stableId: 'stable-gone-1', deleted: true, number: 1 })
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
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label, status: 'online' }).run()
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

  test('POST /numbers/compact does not crash on an orphaned reservation left by a forgotten device, and reports it released (plan 96 §96.42)', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    setDeviceNumber(db, 'stable-a', 1, { userId: null })
    // A forgotten device: it once held #2 (the very number `stable-a` would
    // otherwise be moved into by the dense reassignment below), and its
    // `devices` row was removed the way `forget()` removes it — leaving its
    // `device_numbers` reservation behind, per §3.2. Before the fix, this
    // reproduced the owner's live `UNIQUE constraint failed:
    // device_numbers.number` crash.
    seedDevice(db, 'ghost')
    setDeviceNumber(db, 'stable-ghost', 2, { userId: null })
    db.delete(devices).where(eq(devices.stableId, 'stable-ghost')).run()

    const res = await app.request('/numbers/compact', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      changed: Array<{ stableId: string; from: number; to: number }>
      released: Array<{ stableId: string; number: number }>
    }
    expect(body.released).toEqual([{ stableId: 'stable-ghost', number: 2 }])
    expect(lookupDeviceNumber(db, 'stable-ghost')).toBeNull()
    expect(lookupDeviceNumber(db, 'stable-a')).toBe(1)
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

  // `POST /:id/label/apply`, `POST /:id/label/clear` and `POST /labels/apply`
  // are removed by plan 207 (MVP 07): `set-label` and `clear-label` are
  // actions API verbs now, tested in `packages/core/src/api/actions.test.ts`.

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
