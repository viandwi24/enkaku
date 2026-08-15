import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { defaultFarmSettings, type FarmSettings } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { Role } from '../auth/service'
import { createCommandRunner, resolveCommandTarget } from '../command-console/runner'
import { createCommandRunStore, type CommandRunStore } from '../command-console/store'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import type { ShellExecResult, ShellPort } from '../device/shell-port'
import { createLeaseManager, type LeaseManager } from '../lease/lease-manager'
import { createLogger } from '../util/logger'
import { createCommandRunRoutes, type CommandRunRoutesDeps } from './command-runs'

/**
 * `POST/GET/DELETE /api/command-runs` and friends (plan 93 §3.8, §3.14,
 * §4.4, step 93.4) — the step's own verifiable result, verbatim: five
 * refusals, each proven. Built the same way `command-console/runner.test.ts`
 * (step 93.3) is: a REAL `CommandRunStore`, a REAL `LeaseManager` (backed by
 * a REAL `DeviceStateMachine` over an in-memory db), and a REAL
 * `CommandRunner` — only `ShellPort` is faked.
 */

function withUser(role: Role | null, userId: string, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: userId, email: `${userId}@test`, role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function setUp(): { db: Db; store: CommandRunStore; leases: LeaseManager } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const leases = createLeaseManager({
    states,
    jobStore: { expiredRunning: () => [] } as never,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 60, reaperIntervalMs: 1_000_000 },
    log: createLogger('test'),
    onJobLeaseExpired: () => {},
  })
  return { db, store: createCommandRunStore(db), leases }
}

function insertDevice(db: Db, id: string, status: 'idle' | 'busy' | 'manual' | 'offline' | 'quarantined' = 'idle'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `SER-${id}`, label: `Phone ${id}`, status }).run()
}

const shellSettings = (overrides: Partial<FarmSettings['shell']> = {}): FarmSettings['shell'] => ({
  ...defaultFarmSettings().shell,
  mode: 'admin',
  fanoutEnabled: true,
  fanoutMaxDevices: 0,
  fanoutConcurrency: 0,
  ...overrides,
})

function fakeShellPort(behavior: (deviceId: string, cmd: string) => Promise<ShellExecResult> = () => Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0, truncated: false })): (
  deviceId: string,
) => ShellPort {
  return (deviceId) => ({
    async exec(cmd) {
      return behavior(deviceId, cmd)
    },
    async stream() {
      throw new Error('not used by these tests')
    },
  })
}

interface Harness {
  db: Db
  store: CommandRunStore
  app: Hono<AuthEnv>
}

function buildHarness(opts: {
  role?: Role
  userId?: string
  settings?: Partial<FarmSettings['shell']>
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
  execBehavior?: (deviceId: string, cmd: string) => Promise<ShellExecResult>
}): Harness {
  const { db, store, leases } = setUp()
  const role = opts.role ?? 'admin'
  const userId = opts.userId ?? 'u1'
  const getDeviceOwner = opts.getDeviceOwner ?? (() => null)
  const runner = createCommandRunner({
    db,
    store,
    leases,
    shellPortFor: fakeShellPort(opts.execBehavior),
    resolve: (target) => resolveCommandTarget(db, target),
    settings: () => shellSettings(opts.settings),
    recorder: () => {},
    audit: { record: () => {}, list: () => [] },
    broadcast: () => {},
    roleOf: () => role,
    getDevice: getDeviceOwner,
    log: createLogger('test'),
  })
  const routesDeps: CommandRunRoutesDeps = {
    db,
    store,
    runner,
    settings: () => shellSettings(opts.settings),
    roleOf: () => role,
    getDeviceOwner,
  }
  const app = withUser(role, userId, createCommandRunRoutes(routesDeps))
  return { db, store, app }
}

const jsonReq = (method: 'POST' | 'DELETE', body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

describe('POST /api/command-runs (plan 93 §3.8, §3.14, §4.4) — the five refusals', () => {
  test('shell.fanoutEnabled: false → 403, and nothing is written', async () => {
    const { app, store } = buildHarness({ settings: { fanoutEnabled: false } })
    const res = await app.request('/', jsonReq('POST', { cmd: 'getprop', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_FANOUT_DISABLED')
    expect(store.listPage({ createdBy: null, deviceId: null, q: null, status: null, cursor: null, limit: 50 }).items).toHaveLength(0)
  })

  test('shell.mode: "off" → 403, for an admin too', async () => {
    const { app, store } = buildHarness({ role: 'admin', settings: { mode: 'off' } })
    const res = await app.request('/', jsonReq('POST', { cmd: 'getprop', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
    expect(store.listPage({ createdBy: null, deviceId: null, q: null, status: null, cursor: null, limit: 50 }).items).toHaveLength(0)
  })

  test('over shell.fanoutMaxDevices → 400, and nothing is written', async () => {
    const { db, app, store } = buildHarness({ settings: { fanoutMaxDevices: 1 } })
    insertDevice(db, 'dev-1')
    insertDevice(db, 'dev-2')
    const res = await app.request('/', jsonReq('POST', { cmd: 'getprop', target: { deviceIds: ['dev-1', 'dev-2'] }, clientId: 'c1' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_TOO_MANY_TARGETS')
    expect(store.listPage({ createdBy: null, deviceId: null, q: null, status: null, cursor: null, limit: 50 }).items).toHaveLength(0)
  })

  test('a high-consequence command at N > 1 without acknowledge → 409 naming the pattern; the SAME request with it → 201', async () => {
    const { db, app, store } = buildHarness({})
    insertDevice(db, 'dev-1')
    insertDevice(db, 'dev-2')
    const unacked = await app.request(
      '/',
      jsonReq('POST', { cmd: 'pm uninstall com.example', target: { deviceIds: ['dev-1', 'dev-2'] }, clientId: 'c1' }),
    )
    expect(unacked.status).toBe(409)
    const unackedBody = (await unacked.json()) as { error: { code: string; message: string } }
    expect(unackedBody.error.code).toBe('E_ACK_REQUIRED')
    expect(unackedBody.error.message).toContain('pm')
    expect(store.listPage({ createdBy: null, deviceId: null, q: null, status: null, cursor: null, limit: 50 }).items).toHaveLength(0)

    const acked = await app.request(
      '/',
      jsonReq('POST', {
        cmd: 'pm uninstall com.example',
        target: { deviceIds: ['dev-1', 'dev-2'] },
        clientId: 'c1',
        acknowledge: { highConsequence: true },
      }),
    )
    expect(acked.status).toBe(201)
    const ackedBody = (await acked.json()) as { run: { acknowledged: boolean } }
    expect(ackedBody.run.acknowledged).toBe(true)
  })

  test('a high-consequence command at N = 1 needs no acknowledgement — matching the terminal, which never fires its dialog for one device', async () => {
    const { db, app } = buildHarness({})
    insertDevice(db, 'dev-1')
    const res = await app.request('/', jsonReq('POST', { cmd: 'pm uninstall com.example', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    expect(res.status).toBe(201)
  })

  test('a device owned by another user refuses the whole run before any member exists', async () => {
    const { db, app, store } = buildHarness({
      role: 'operator',
      userId: 'u1',
      // Widened past the (default 'admin') `shell.mode` gate on purpose —
      // this test is about the OWNERSHIP gate specifically, not a second
      // proof of the `shell.mode`/`canUseShell` refusal already covered
      // above.
      settings: { mode: 'operator' },
      getDeviceOwner: (deviceId) => (deviceId === 'dev-2' ? { ownerId: 'someone-else' } : { ownerId: null }),
    })
    insertDevice(db, 'dev-1')
    insertDevice(db, 'dev-2')
    const res = await app.request('/', jsonReq('POST', { cmd: 'getprop', target: { deviceIds: ['dev-1', 'dev-2'] }, clientId: 'c1' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
    // Nothing written — not even a run naming ONLY the device the operator
    // DOES own (§3.8: "refuses the whole run before any member exists").
    expect(store.listPage({ createdBy: null, deviceId: null, q: null, status: null, cursor: null, limit: 50 }).items).toHaveLength(0)
  })

  test('an ordinary one-device run succeeds and returns the created run with its one pending member', async () => {
    const { db, app } = buildHarness({})
    insertDevice(db, 'dev-1')
    const res = await app.request('/', jsonReq('POST', { cmd: 'getprop ro.build.version.release', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { run: { id: string; status: string }; members: { deviceId: string }[]; skipped: unknown[] }
    expect(body.run.id).toBeTruthy()
    expect(body.members).toHaveLength(1)
    expect(body.members[0]?.deviceId).toBe('dev-1')
    expect(body.skipped).toHaveLength(0)
  })

  test('a malformed body is rejected with 400', async () => {
    const { app } = buildHarness({})
    const res = await app.request('/', jsonReq('POST', { cmd: '', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    expect(res.status).toBe(400)
  })
})

describe('GET /api/command-runs and /:id — visibility (plan 93 §3.9)', () => {
  test('an operator sees their own run; a different operator does not see it by default', async () => {
    const { db, store, app } = buildHarness({ role: 'operator', userId: 'alice', settings: { mode: 'operator' } })
    insertDevice(db, 'dev-1')
    const create = await app.request('/', jsonReq('POST', { cmd: 'getprop', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    expect(create.status).toBe(201)

    const ownList = await app.request('/?mine=1')
    expect(ownList.status).toBe(200)
    const ownBody = (await ownList.json()) as { items: unknown[] }
    expect(ownBody.items).toHaveLength(1)

    // A second operator's own routes, same store, different identity.
    const otherRoutesDeps: CommandRunRoutesDeps = {
      db,
      store,
      runner: { start: async () => { throw new Error('not used') }, cancel: () => {}, continueRun: () => {} },
      settings: () => shellSettings(),
      roleOf: () => 'operator',
      getDeviceOwner: () => null,
    }
    const bobApp = withUser('operator', 'bob', createCommandRunRoutes(otherRoutesDeps))
    const bobList = await bobApp.request('/')
    expect(bobList.status).toBe(200)
    const bobBody = (await bobList.json()) as { items: unknown[] }
    expect(bobBody.items).toHaveLength(0)
  })

  test('GET /:id returns members and distinct outputs, never stdout/stderr on the member itself', async () => {
    const { db, app } = buildHarness({})
    insertDevice(db, 'dev-1')
    const create = await app.request('/', jsonReq('POST', { cmd: 'getprop', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    const createBody = (await create.json()) as { run: { id: string } }
    const runId = createBody.run.id

    // Give the async dispatch a moment to settle the one member.
    type RunDetail = { run: { members: { status: string }[] } }
    const deadline = Date.now() + 2000
    let detail: RunDetail | null = null
    while (Date.now() < deadline) {
      const res = await app.request(`/${runId}`)
      detail = (await res.json()) as RunDetail
      if (detail.run.members[0]?.status !== 'pending' && detail.run.members[0]?.status !== 'running') break
      await Bun.sleep(10)
    }
    expect(detail).not.toBeNull()
    const member = detail?.run.members[0] as unknown as Record<string, unknown>
    expect('stdout' in member).toBe(false)
    expect('stderr' in member).toBe(false)
  })

  test('GET /:id/members/:deviceId/output returns the full retained stdout as text/plain', async () => {
    const { db, app } = buildHarness({ execBehavior: async () => ({ stdout: 'full output here', stderr: '', exitCode: 0, truncated: false }) })
    insertDevice(db, 'dev-1')
    const create = await app.request('/', jsonReq('POST', { cmd: 'getprop', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    const createBody = (await create.json()) as { run: { id: string } }
    const runId = createBody.run.id

    const deadline = Date.now() + 2000
    let text = ''
    while (Date.now() < deadline) {
      const res = await app.request(`/${runId}/members/dev-1/output`)
      text = await res.text()
      if (text.length > 0) break
      await Bun.sleep(10)
    }
    expect(text).toBe('full output here')
  })
})

describe('DELETE /api/command-runs/:id — owner or admin (plan 93 §4.4)', () => {
  test('the creator may delete their own run', async () => {
    const { db, app } = buildHarness({ role: 'operator', userId: 'alice', settings: { mode: 'operator' } })
    insertDevice(db, 'dev-1')
    const create = await app.request('/', jsonReq('POST', { cmd: 'getprop', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    const createBody = (await create.json()) as { run: { id: string } }
    const res = await app.request(`/${createBody.run.id}`, jsonReq('DELETE'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: boolean }
    expect(body.deleted).toBe(true)
  })

  test('another operator may not delete it', async () => {
    const { db, store, app } = buildHarness({ role: 'operator', userId: 'alice', settings: { mode: 'operator' } })
    insertDevice(db, 'dev-1')
    const create = await app.request('/', jsonReq('POST', { cmd: 'getprop', target: { deviceIds: ['dev-1'] }, clientId: 'c1' }))
    const createBody = (await create.json()) as { run: { id: string } }

    const bobRoutesDeps: CommandRunRoutesDeps = {
      db,
      store,
      runner: { start: async () => { throw new Error('not used') }, cancel: () => {}, continueRun: () => {} },
      settings: () => shellSettings(),
      roleOf: () => 'operator',
      getDeviceOwner: () => null,
    }
    const bobApp = withUser('operator', 'bob', createCommandRunRoutes(bobRoutesDeps))
    const res = await bobApp.request(`/${createBody.run.id}`, jsonReq('DELETE'))
    expect(res.status).toBe(403)
  })
})
