import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { DeviceLabelState, DevicePreparation, PreparationComponentStatus } from '@enkaku/protocol'
import { DEFAULT_DEVICE_LABEL_STATE, DEFAULT_DEVICE_PREPARATION } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createActivityRegistry } from '../activity/registry'
import { createOperationRegistry } from '../actions/operations'
import { runAction, type ActionActor, type ActionsDeps } from '../actions/run'
import type { BlockedDevice, DeviceLifecycle, ForgetResult, HistoryCounts } from '../device/lifecycle'
import type { LabellingService } from '../device/labelling'
import type { PreparationRunner } from '../device/preparation/runner'
import type { TransferService } from '../device/transfer'
import type { TransferBroadcast } from '../device/transfer-dispatch'
import type { DeviceReconnector } from '../registry/reconnect'
import type { CutoverManager } from '../registry/cutover'
import type { NetworkActionsDoor } from '../actions/impl/network'
import type { ShellPort } from '../device/shell-port'
import { createLogger } from '../util/logger'
import { createActionRoutes } from './actions'

/**
 * The actions router's dispatch mechanics (plan 207 §4.2, §4.3), exercised
 * against a REAL `ActivityRegistry`/`evaluate()` and a REAL device row (so
 * `resolveActionTarget`'s own DB query is exercised too) — only each verb's
 * OWN leaf implementation (the reconnector, the transfer service, the
 * labelling service, ...) is a fake. G2 (per-device 202, unknown verb 404)
 * and G4 (policy warn/force, forbid ignores force) go through the real Hono
 * app; G3 (one test per verb, of the 25 in `ACTION_VERBS`) calls `runAction`
 * directly and asserts the fake at the boundary it should have reached.
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, opts: { tcp?: boolean } = {}): void {
  db.insert(devices)
    .values({
      id,
      stableId: `stable-${id}`,
      serial: opts.tcp ? '10.0.0.5:5555' : `serial-${id}`,
      label: `device ${id}`,
      status: 'online',
    })
    .run()
}

/** Records every call an impl-boundary fake receives, keyed by name. */
function makeCalls(): { record: (name: string, ...args: unknown[]) => void; get: (name: string) => unknown[][] } {
  const calls = new Map<string, unknown[][]>()
  return {
    record: (name, ...args) => {
      const list = calls.get(name) ?? []
      list.push(args)
      calls.set(name, list)
    },
    get: (name) => calls.get(name) ?? [],
  }
}

/** A complete `ActionsDeps` fixture: real db/audit/activities/operations, faked leaves. */
function makeDeps(db: Db, overrides: Partial<ActionsDeps> = {}): { deps: ActionsDeps; calls: ReturnType<typeof makeCalls> } {
  const calls = makeCalls()
  const audit = createAuditLogger(db)
  const activities = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
  const operations = createOperationRegistry({})

  const fakeReconnector: DeviceReconnector = {
    reconnect: async (stableId, opts) => {
      calls.record('reconnect', stableId, opts)
      return { result: 'connected', address: '10.0.0.5:5555', viaSweep: false }
    },
    disconnect: async (stableId) => {
      calls.record('disconnect', stableId)
      return { result: 'disconnected' }
    },
  }

  const fakeCutover: CutoverManager = {
    start: async (device, opts) => {
      calls.record('cutover.start', device.id, opts)
      return {
        deviceId: device.id,
        stableId: device.stableId,
        step: 'armed',
        detail: 'watching',
        port: opts.port ?? 5555,
        medium: opts.medium,
        persistSurvivesReboot: null,
        triedAddresses: 0,
        answered: 0,
        startedAt: Date.now(),
        expiresAt: null,
        connectedAddress: null,
      }
    },
    cancel: (stableId) => {
      calls.record('cutover.cancel', stableId)
      return null
    },
    get: () => null,
    stopAll: () => {},
  }

  const fakeLifecycle: DeviceLifecycle = {
    forget: async (deviceId, opts): Promise<ForgetResult> => {
      calls.record('forget', deviceId, opts)
      return { deviceId, stableId: `stable-${deviceId}`, historyDeleted: opts.deleteHistory, counts: null, kvDeleted: 0 }
    },
    historyCounts: async (): Promise<HistoryCounts> => ({ jobs: 0, artifacts: 0, events: 0 }),
    block: async (deviceId, opts): Promise<BlockedDevice> => {
      calls.record('block', deviceId, opts)
      return { stableId: `stable-${deviceId}`, label: deviceId, reason: opts.reason ?? null, blockedAt: 0, blockedBy: opts.actor.userId }
    },
    unblock: async () => {},
    listBlocked: async () => [],
  }

  const fakeLabelling: LabellingService = {
    apply: async (deviceId): Promise<DeviceLabelState> => {
      calls.record('set-label', deviceId)
      return { ...DEFAULT_DEVICE_LABEL_STATE, mode: 'wallpaper', state: 'applied' }
    },
    clear: async (deviceId, opts): Promise<DeviceLabelState> => {
      calls.record('clear-label', deviceId, opts)
      return { ...DEFAULT_DEVICE_LABEL_STATE }
    },
    reconcile: async (): Promise<DeviceLabelState> => ({ ...DEFAULT_DEVICE_LABEL_STATE }),
    status: async (): Promise<DeviceLabelState> => ({ ...DEFAULT_DEVICE_LABEL_STATE }),
  }

  const fakeRunner: PreparationRunner = {
    ensure: async (deviceId, opts): Promise<DevicePreparation> => {
      calls.record('prepare', deviceId, opts)
      return { ...DEFAULT_DEVICE_PREPARATION }
    },
    ensureComponent: async (deviceId, componentId, opts): Promise<PreparationComponentStatus> => {
      calls.record('retry-prepare', deviceId, componentId, opts)
      return { state: 'ready', version: '1', reason: null, checkedAt: 0, attempts: 0, nextAttemptAt: null }
    },
    status: async (): Promise<DevicePreparation> => ({ ...DEFAULT_DEVICE_PREPARATION }),
    ensureAll: async () => ({ total: 0, results: [] }),
    runningSince: () => ({}),
  }

  const fakeTransfer: TransferService = {
    install: async (deviceId, artifactId, opts) => {
      calls.record('install', deviceId, artifactId, opts)
      return { package: 'com.example', durationMs: 1, output: 'Success' }
    },
    push: async (deviceId, artifactId, remotePath, opts) => {
      calls.record('push', deviceId, artifactId, remotePath, opts)
      return { mediaScan: { ran: false, method: null, ms: 0 } }
    },
    pull: async (deviceId, remotePath, opts) => {
      calls.record('pull', deviceId, remotePath, opts)
      return { artifactId: 'art-1', bytes: 10 }
    },
    installFromLocalApk: async () => ({ package: null, durationMs: 0, output: '' }),
    cancel: () => {},
  }
  const fakeTransferBroadcast: TransferBroadcast = { progress: () => {}, done: () => {} }

  const fakeRouteService: NetworkActionsDoor = {
    set: async (deviceId, route, actor) => {
      calls.record('set-network', deviceId, 'set', route, actor)
      return { engine: 'none', health: 'unverified' } as unknown as Awaited<ReturnType<NetworkActionsDoor['set']>>
    },
    clear: async (deviceId, actor) => {
      calls.record('set-network', deviceId, 'clear', actor)
      return { engine: 'none', health: 'unverified' } as unknown as Awaited<ReturnType<NetworkActionsDoor['clear']>>
    },
    enable: async (deviceId, actor) => {
      calls.record('set-network', deviceId, 'enable', actor)
      return { engine: 'none', health: 'unverified' } as unknown as Awaited<ReturnType<NetworkActionsDoor['enable']>>
    },
    disable: async (deviceId, actor) => {
      calls.record('set-network', deviceId, 'disable', actor)
      return { engine: 'none', health: 'unverified' } as unknown as Awaited<ReturnType<NetworkActionsDoor['disable']>>
    },
    retry: async (deviceId, actor) => {
      calls.record('set-network', deviceId, 'retry', actor)
      return { engine: 'none', health: 'unverified' } as unknown as Awaited<ReturnType<NetworkActionsDoor['retry']>>
    },
  }

  const fakeShellPort = (deviceId: string): ShellPort => ({
    exec: async (cmd) => {
      calls.record('adb', deviceId, cmd)
      return { stdout: 'ok', stderr: '', exitCode: 0, truncated: false }
    },
    stream: async () => {
      throw new Error('not used in this fixture')
    },
  })

  const deps: ActionsDeps = {
    db,
    audit,
    record: () => {},
    broadcast: () => {},
    activities,
    controlSettings: () => ({ overControl: 'allow', idleSec: 30 }),
    states: { current: () => 'online' },
    operations,
    userLabel: (userId) => userId,
    shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    transferSettings: () => ({ enabled: true }),
    batchesFor: () => {
      throw new Error('run-script is exercised in its own fixture, not this one')
    },
    resolveScriptRef: (ref) => ({ id: ref }),
    transfer: { transfer: fakeTransfer, broadcast: fakeTransferBroadcast },
    shellPortFor: fakeShellPort,
    readiness: {
      set: async (deviceId, desired) => {
        calls.record('readiness.set', deviceId, desired)
        return { desired, actual: desired, blocked: null, since: 0 }
      },
    },
    reconnector: () => fakeReconnector,
    sessions: () => null,
    cutover: () => fakeCutover,
    lifecycle: fakeLifecycle,
    battery: () => ({
      unquarantine: (deviceId) => {
        calls.record('unquarantine', deviceId)
        return true
      },
    }),
    routeService: () => fakeRouteService,
    labelling: fakeLabelling,
    preparation: { runner: fakeRunner },
    screenshot: async (deviceId) => {
      calls.record('screenshot', deviceId)
      return new Uint8Array([1, 2, 3])
    },
    dataDir: '/tmp',
    networks: () => [],
    infoWithTags: () => ({ ownerId: null }),
    ...overrides,
  }
  return { deps, calls }
}

function makeApp(deps: ActionsDeps) {
  const { actions, operations } = createActionRoutes(deps)
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u@test', role: 'admin' })
    await next()
  })
  app.route('/api/actions', actions)
  app.route('/api/operations', operations)
  return app
}

describe('POST /api/actions/:verb (plan 207 §4.2)', () => {
  test('wake: answers 202 with one result per targeted device', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const { deps } = makeDeps(db)
    const app = makeApp(deps)
    const res = await app.request('/api/actions/wake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { deviceIds: ['d1', 'd2'] } }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { results: Array<{ deviceId: string; status: string }> }
    expect(body.results).toHaveLength(2)
    expect(body.results.map((r) => r.status)).toEqual(['done', 'done'])
  })

  test('unknown verb answers 404 E_UNKNOWN_VERB', async () => {
    const db = setUp()
    const { deps } = makeDeps(db)
    const app = makeApp(deps)
    const res = await app.request('/api/actions/not-a-real-verb', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_UNKNOWN_VERB')
  })

  test('GET /api/operations/:id reads back the settled operation', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const { deps } = makeDeps(db)
    const app = makeApp(deps)
    const post = await app.request('/api/actions/wake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { deviceIds: ['d1'] } }),
    })
    const { operationId } = (await post.json()) as { operationId: string }
    const res = await app.request(`/api/operations/${operationId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { operation: { results: Array<{ status: string }> } }
    expect(body.operation.results[0]?.status).toBe('done')
  })
})

describe('policy (plan 207 §4.2, §4.4 — MVP 04 §1.3)', () => {
  test('warn then force: a live job on the device warns for adb, force proceeds', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const { deps, calls } = makeDeps(db)
    deps.activities.start('d1', { id: 'job:1', kind: 'job', label: 'a job', actor: { kind: 'user', id: 'u1', label: 'u1' } })
    const app = makeApp(deps)

    const warned = await app.request('/api/actions/adb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { deviceIds: ['d1'] }, cmd: 'echo hi' }),
    })
    const warnedBody = (await warned.json()) as { results: Array<{ status: string }> }
    expect(warnedBody.results[0]?.status).toBe('warned')
    expect(calls.get('adb')).toHaveLength(0)

    const forced = await app.request('/api/actions/adb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { deviceIds: ['d1'] }, cmd: 'echo hi', force: true }),
    })
    const forcedBody = (await forced.json()) as { operationId: string; results: Array<{ status: string }> }
    let settled = forcedBody.results
    for (let i = 0; i < 40 && settled[0]?.status === 'accepted'; i++) {
      await new Promise((r) => setTimeout(r, 5))
      const opRes = await app.request(`/api/operations/${forcedBody.operationId}`)
      settled = ((await opRes.json()) as { operation: { results: typeof settled } }).operation.results
    }
    expect(settled[0]?.status).toBe('done')
    expect(calls.get('adb')).toHaveLength(1)
  })

  test('forbid ignores force: a live install on the device forbids install, with or without force', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const { deps } = makeDeps(db)
    deps.activities.start('d1', { id: 'install:1', kind: 'install', label: 'installing', actor: { kind: 'user', id: 'u1', label: 'u1' } })
    const app = makeApp(deps)

    for (const force of [false, true]) {
      const res = await app.request('/api/actions/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: { deviceIds: ['d1'] }, artifactId: 'art-1', force }),
      })
      const body = (await res.json()) as { results: Array<{ status: string }> }
      expect(body.results[0]?.status).toBe('forbidden')
    }
  })
})

describe('verbs — each dispatches to its own injected implementation (plan 207 §4.3)', () => {
  const actor: ActionActor = { id: 'u1', role: 'admin' }

  /** Sync verbs settle synchronously inside `runAction`'s own return. */
  async function run(verb: string, params: Record<string, unknown>, overrides: Partial<ActionsDeps> = {}) {
    const db = setUp()
    seedDevice(db, 'd1', { tcp: true })
    const { deps, calls } = makeDeps(db, overrides)
    const response = await runAction(deps, { verb, target: { deviceIds: ['d1'] }, force: false, ...params } as never, actor)
    return { response, calls }
  }

  /** Async verbs settle on `deps.operations` after `dispatchBounded`'s fire-and-forget resolves. */
  async function runAsync(verb: string, params: Record<string, unknown>, overrides: Partial<ActionsDeps> = {}) {
    const db = setUp()
    seedDevice(db, 'd1', { tcp: true })
    const { deps, calls } = makeDeps(db, overrides)
    const response = await runAction(deps, { verb, target: { deviceIds: ['d1'] }, force: false, ...params } as never, actor)
    let results = response.results
    for (let i = 0; i < 40 && results[0]?.status === 'accepted'; i++) {
      await new Promise((r) => setTimeout(r, 5))
      const settled = deps.operations.get(response.operationId)
      results = settled?.results ?? results
    }
    return { response: { ...response, results }, calls }
  }

  test('wake', async () => {
    const { response, calls } = await run('wake', {})
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('readiness.set')[0]).toEqual(['d1', 'awake'])
  })

  test('sleep', async () => {
    const { response, calls } = await run('sleep', {})
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('readiness.set')[0]).toEqual(['d1', 'asleep'])
  })

  test('reconnect', async () => {
    const { response, calls } = await run('reconnect', {})
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('reconnect')).toHaveLength(1)
  })

  test('disconnect', async () => {
    const { response, calls } = await run('disconnect', {})
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('disconnect')).toHaveLength(1)
  })

  test('cutover', async () => {
    // `cutoverStart` only accepts a device presently on USB — a `tcp:true`
    // seed (every other verb's fixture) fails its own `conn.kind !== 'usb'`
    // guard, so this one test seeds a plain USB-shaped device instead.
    const db = setUp()
    seedDevice(db, 'd1')
    const { deps, calls } = makeDeps(db)
    const response = await runAction(
      deps,
      { verb: 'cutover', target: { deviceIds: ['d1'] }, force: false, op: 'start', medium: 'wired' } as never,
      actor,
    )
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('cutover.start')).toHaveLength(1)
  })

  test('forget', async () => {
    const { response, calls } = await run('forget', { deleteHistory: false })
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('forget')[0]?.[0]).toBe('d1')
  })

  test('block', async () => {
    const { response, calls } = await run('block', {})
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('block')[0]?.[0]).toBe('d1')
  })

  test('unquarantine', async () => {
    const { response, calls } = await run('unquarantine', {})
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('unquarantine')).toHaveLength(1)
  })

  test('set-label', async () => {
    const { response, calls } = await run('set-label', {})
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('set-label')).toHaveLength(1)
  })

  test('clear-label', async () => {
    const { response, calls } = await run('clear-label', { restoreOriginal: false })
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('clear-label')).toHaveLength(1)
  })

  test('set-group', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const { deps } = makeDeps(db)
    const response = await runAction(deps, { verb: 'set-group', target: { deviceIds: ['d1'] }, force: false, groupId: null } as never, actor)
    expect(response.results[0]?.status).toBe('done')
  })

  test('set-tags', async () => {
    const { response } = await run('set-tags', { tags: ['a', 'b'] })
    expect(response.results[0]?.status).toBe('done')
  })

  test('settings', async () => {
    const { response } = await run('settings', { settings: {} })
    expect(response.results[0]?.status).toBe('done')
  })

  test('adb', async () => {
    const { response, calls } = await runAsync('adb', { cmd: 'echo hi' })
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('adb')).toHaveLength(1)
  })

  test('clear-cache', async () => {
    const { response } = await runAsync('clear-cache', { package: 'com.example' })
    expect(response.results[0]?.status).toBe('done')
  })

  test('install', async () => {
    const { response, calls } = await runAsync('install', { artifactId: 'art-1' })
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('install')).toHaveLength(1)
  })

  test('push', async () => {
    const { response, calls } = await runAsync('push', { artifactId: 'art-1', remotePath: '/sdcard/x', mediaScan: 'auto' })
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('push')).toHaveLength(1)
  })

  test('pull', async () => {
    const { response, calls } = await runAsync('pull', { remotePath: '/sdcard/x' })
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('pull')).toHaveLength(1)
  })

  test('set-network', async () => {
    const { response, calls } = await runAsync('set-network', { op: 'set', route: { engine: 'adb-proxy', host: 'h', port: 8080 } })
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('set-network')).toHaveLength(1)
  })

  test('prepare', async () => {
    const { response, calls } = await runAsync('prepare', { forceRecheck: false })
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('prepare')).toHaveLength(1)
  })

  test('retry-prepare', async () => {
    const { response, calls } = await runAsync('retry-prepare', { component: 'ui-server' })
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('retry-prepare')).toHaveLength(1)
  })

  test('screenshot', async () => {
    const { response, calls } = await runAsync('screenshot', {})
    expect(response.results[0]?.status).toBe('done')
    expect(calls.get('screenshot')).toHaveLength(1)
  })

  test('reprofile', async () => {
    const { response } = await run('reprofile', {})
    expect(response.results[0]?.status).toBe('done')
  })

  test('run-workflow answers E_NOT_SUPPORTED (plan 211 owns it)', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const { deps } = makeDeps(db)
    await expect(
      runAction(deps, { verb: 'run-workflow', target: { deviceIds: ['d1'] }, force: false, workflowName: 'w' } as never, actor),
    ).rejects.toThrow('run-workflow')
  })
})
