import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { validatePluginSurface, type ActionSpec, type JobInfo, type PluginSurface, type PluginSurfaceInput, type ScriptRef } from '@enkaku/protocol'
import { createPluginRoutes } from '../api/plugins'
import { createAuditLogger, type AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import type { BatchDispatchDeps } from '../clusters/dispatch'
import { openDb, runMigrations, type Db } from '../db'
import { auditLog, devices } from '../db/schema'
import { createKvStore, type KvStore } from '../kv/store'
import { createScriptRegistry, type ScriptEntry, type ScriptRegistry } from '../scripts/registry'
import type { JobService } from '../services/job-service'
import { createWorkspaceStore } from '../workspace/store'
import { actionPermission, createPluginActionExecutor, type PluginActionExecutor } from './action-executor'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime, type PluginRuntime } from './runtime'
import type { VerifyReport } from './verify-child'

/**
 * Plan 108 §4.5, §5 step 108.5, criteria 14 and 15.
 *
 * A REAL `Db`, a REAL `ScriptRegistry`, a REAL `KvStore` and the REAL
 * `createBatch` — because the central claim of this step is about which
 * concrete `scripts.id` reaches the dispatch function, and a mock registry
 * would simply return whatever the test told it to. The one fake is
 * `JobService.enqueue`, which is stubbed to CAPTURE its input: what matters
 * there is what the executor handed it, not that the scheduler ran.
 */

function surfaceOf(input: PluginSurfaceInput): PluginSurface {
  const checked = validatePluginSurface(input)
  if (!checked.ok) throw new Error(`test fixture is not a valid surface: ${checked.errors.join('; ')}`)
  return checked.value
}

const surface = surfaceOf({
  nav: [{ id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' }],
  views: {
    accounts: {
      title: 'TikTok accounts',
      data: { kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts' },
      table: { rowKey: 'username', selectable: true, columns: [{ field: 'username', header: 'Account' }] },
      toolbar: ['sync', 'addNote'],
      rowActions: ['switchTo', 'remember', 'forget'],
    },
  },
  actions: {
    sync: { kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest', target: 'selection' },
    switchTo: {
      kind: 'job',
      label: 'Switch to this account',
      script: 'tiktok/switch-account@latest',
      device: 'row',
      params: { target: { $row: 'username' }, device: { $device: 'stableId' } },
    },
    remember: { kind: 'kv.set', label: 'Remember', scope: 'device', key: { $literal: 'note' }, value: { $row: 'username' } },
    forget: { kind: 'kv.delete', label: 'Forget', scope: 'device', key: { $literal: 'note' } },
    addNote: {
      kind: 'form',
      label: 'Add a farm note',
      schema: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } } },
      then: { kind: 'kv.set', label: 'Save', scope: 'global', key: { $form: 'key' }, value: { $form: 'text' } },
    },
  },
})

function fakeJobInfo(scriptId: string, deviceId: string): JobInfo {
  return {
    jobId: 'job-1',
    deviceId,
    scriptId,
    scriptName: null,
    scriptVersion: null,
    status: 'queued',
    error: null,
    failureClass: null,
    priority: 0,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    batchId: null,
    batchSeq: null,
    expiresAt: null,
    errorPhase: null,
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    peakRssBytes: null,
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    resultStatus: null,
    resultSummary: null,
  }
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugin-action-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

interface EnqueueCall {
  scriptId: string
  deviceId: string
  params: unknown
  actorId: string | null
}

interface Harness {
  db: Db
  kv: KvStore
  audit: AuditLogger
  runtime: PluginRuntime
  registry: ScriptRegistry
  executor: PluginActionExecutor
  /** Every `JobService.enqueue` the executor made. */
  enqueued: EnqueueCall[]
  /** Every `ScriptRegistry.resolve` the executor made, ref verbatim. */
  resolved: { ref: ScriptRef; allowDev: boolean }[]
  /** Every `createBatch` input the executor built. */
  batched: { scriptId: string; deviceIds: string[]; params: unknown }[]
  app: Hono<AuthEnv>
  pluginActionRows(): { target: string | null; meta: unknown; userId: string | null }[]
}

function withRole(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u1@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

async function setUp(role: 'admin' | 'operator' | null = 'operator'): Promise<Harness> {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const devSlots = createDevSlotStore()
  const realRegistry = createScriptRegistry({ db, dataDir, devSlots })
  const audit = createAuditLogger(db)
  const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 10_000_000 }))

  const runtime = createPluginRuntime({
    db,
    dataDir,
    registry: realRegistry,
    kv,
    devSlots,
    verify: async (_bundlePath, opts) => ({
      ok: true,
      version: opts?.expectedVersion ?? '1.0.0',
      scripts: [
        { id: 'list-accounts', paramsSchema: { type: 'object' }, runtime: null },
        { id: 'switch-account', paramsSchema: { type: 'object' }, runtime: null },
      ],
      resetPackages: [],
      surface,
    }),
  })

  const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' })
  await runtime.verify(staged.id)
  runtime.activate(staged.id)

  db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'ser-1', label: 'Pixel 1', status: 'online' }).run()
  db.insert(devices).values({ id: 'd2', stableId: 's2', serial: 'ser-2', label: 'Pixel 2', status: 'online' }).run()

  const enqueued: EnqueueCall[] = []
  const resolved: { ref: ScriptRef; allowDev: boolean }[] = []
  const batched: { scriptId: string; deviceIds: string[]; params: unknown }[] = []

  // A thin recording wrapper over the REAL registry: the resolution itself is
  // genuine (criterion 14 is about the id it produces), and the wrapper only
  // records what reference it was asked for — which is the other half of the
  // same criterion ("a `job` action passes the ref through").
  const registry: ScriptRegistry = {
    ...realRegistry,
    resolve(ref, opts): ScriptEntry {
      resolved.push({ ref, allowDev: opts?.allowDev === true })
      return realRegistry.resolve(ref, opts)
    },
  }

  const jobService: Pick<JobService, 'enqueue'> = {
    enqueue(input) {
      enqueued.push({ scriptId: input.scriptId, deviceId: input.deviceId, params: input.params, actorId: input.actor?.id ?? null })
      return fakeJobInfo(input.scriptId, input.deviceId)
    },
  }

  const batch = (): BatchDispatchDeps => ({
    db,
    scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
    audit,
    onJobStatus: () => {},
    // Records what the executor RESOLVED before `createBatch` ever ran, so the
    // assertion is about the id and not merely about the call happening.
    validateScript: (scriptId, params) => {
      batched.push({ scriptId, deviceIds: [], params })
      return params
    },
  })

  const getDeviceOwner = (deviceId: string): { ownerId: string | null } | null =>
    db.select({ ownerId: devices.ownerId }).from(devices).where(eq(devices.id, deviceId)).get() ?? null

  const actions = { registry, kv, jobService, batch, getDeviceOwner }
  const executor = createPluginActionExecutor({ runtime, audit, ...actions })
  const app = withRole(role, createPluginRoutes({ runtime, audit, workspace, data: { db, kv }, actions }))

  return {
    db,
    kv,
    audit,
    runtime,
    registry,
    executor,
    enqueued,
    resolved,
    batched,
    app,
    pluginActionRows: () =>
      db
        .select()
        .from(auditLog)
        .all()
        .filter((r) => r.action === 'plugin.action')
        .map((r) => ({ target: r.target, meta: r.meta, userId: r.userId })),
  }
}

const actor = { id: 'u1', role: 'operator' as const }
const row = { username: 'alice', $device: { id: 'd1', stableId: 's1', label: 'Pixel 1', status: 'online', clusterId: null } }

describe('a `job` action', () => {
  test('passes the declared REF through to the registry and enqueues the concrete id it resolved', async () => {
    const h = await setUp()
    const result = h.executor.execute({ plugin: 'tiktok', actionId: 'switchTo', row, actor })

    expect(h.resolved).toEqual([{ ref: 'tiktok/switch-account@latest', allowDev: true }])
    const concrete = h.registry.resolve('tiktok/switch-account@1.0.0').id
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]?.scriptId).toBe(concrete)
    expect(h.enqueued[0]?.deviceId).toBe('d1')
    expect(h.enqueued[0]?.actorId).toBe('u1')
    expect(result).toEqual({ kind: 'job', jobId: 'job-1', deviceId: 'd1', scriptId: concrete })
  })

  test('its params come from the evaluated bindings, not from anything the caller sent', async () => {
    const h = await setUp()
    h.executor.execute({ plugin: 'tiktok', actionId: 'switchTo', row, actor })
    expect(h.enqueued[0]?.params).toEqual({ target: 'alice', device: 's1' })
  })

  test('`device: "row"` with no device on the row is a coded bad request, not a crash', async () => {
    const h = await setUp()
    expect(() => h.executor.execute({ plugin: 'tiktok', actionId: 'switchTo', row: { username: 'alice' }, actor })).toThrow(/\$device\.id/)
    expect(h.enqueued).toHaveLength(0)
  })

  /**
   * The shipped bug this pair exists to stop coming back. `$device`/`$entry`
   * used to be parsed as ONE envelope whose halves were both `.optional()` but
   * neither `.nullable()`. A device that has never been synced has no kv entry,
   * so `kv.scan`'s `includeMissing` row carries `$entry: null` — which an
   * optional object refuses. The single failure dropped `$device` too, and the
   * action reported "the row carries no `$device.id`" about a row that carried
   * it perfectly well.
   *
   * It was invisible because every fixture above omits `$entry` entirely
   * rather than sending it null, and it bit the ONLY row a fresh farm renders.
   */
  test('a row whose device has never been synced carries `$entry: null`, and that must not blind `$device`', async () => {
    const h = await setUp()
    const neverSynced = { ...row, $entry: null }
    const result = h.executor.execute({ plugin: 'tiktok', actionId: 'switchTo', row: neverSynced, actor })
    expect(result).toMatchObject({ kind: 'job', deviceId: 'd1' })
    expect(h.enqueued[0]?.deviceId).toBe('d1')
  })

  test('a malformed half never blinds the other — they are parsed apart', async () => {
    const h = await setUp()
    // `$entry` is nonsense; `$device` is intact, so the action still runs.
    h.executor.execute({ plugin: 'tiktok', actionId: 'switchTo', row: { ...row, $entry: 42 }, actor })
    expect(h.enqueued[0]?.deviceId).toBe('d1')
    // And the reverse: a nonsense `$device` is reported as the missing id it
    // actually is, rather than being masked by a healthy `$entry`.
    expect(() =>
      h.executor.execute({ plugin: 'tiktok', actionId: 'switchTo', row: { username: 'alice', $device: 42, $entry: { key: 'accounts' } }, actor }),
    ).toThrow(/\$device\.id/)
  })
})

describe('a `batch` action', () => {
  test('resolves `name@latest` to a concrete scripts.id BEFORE createBatch — the id, not merely the call', async () => {
    const h = await setUp()
    const concrete = h.registry.resolve('tiktok/list-accounts@1.0.0').id
    h.resolved.length = 0

    const result = h.executor.execute({ plugin: 'tiktok', actionId: 'sync', deviceIds: ['d1', 'd2'], actor })

    // `validateScript` runs inside `createBatch`, before a single row is
    // written — so this records exactly what the executor resolved.
    expect(h.batched).toHaveLength(1)
    expect(h.batched[0]?.scriptId).toBe(concrete)
    expect(h.resolved).toEqual([{ ref: 'tiktok/list-accounts@latest', allowDev: false }])
    expect(result.kind).toBe('batch')
    if (result.kind === 'batch') {
      expect(result.scriptId).toBe(concrete)
      expect(result.jobCount).toBe(2)
    }
  })

  test('a target with no devices is E_NO_TARGETS rather than an empty batch', async () => {
    const h = await setUp()
    expect(() => h.executor.execute({ plugin: 'tiktok', actionId: 'sync', deviceIds: [], actor })).toThrow(/at least one device/)
  })

  test('a device owned by someone else refuses the WHOLE batch, not a smaller one', async () => {
    const h = await setUp()
    h.db.update(devices).set({ ownerId: 'someone-else' }).where(eq(devices.id, 'd2')).run()
    expect(() => h.executor.execute({ plugin: 'tiktok', actionId: 'sync', deviceIds: ['d1', 'd2'], actor })).toThrow(/belongs to another user/)
    expect(h.pluginActionRows()).toHaveLength(0)
  })
})

describe('`kv.set` / `kv.delete` force the namespace', () => {
  test('a device-scoped write lands in the PLUGIN\'s namespace, under the row\'s own stableId', async () => {
    const h = await setUp()
    const result = h.executor.execute({ plugin: 'tiktok', actionId: 'remember', row, actor })

    expect(result).toEqual({ kind: 'kv.set', scope: 'device', stableId: 's1', key: 'note' })
    expect(h.kv.get({ kind: 'device', stableId: 's1' }, 'tiktok', 'note')?.value).toBe('alice')
    // Nothing reached any other namespace, and nothing reached global.
    expect(h.kv.get({ kind: 'global' }, 'tiktok', 'note')).toBeNull()
    expect(h.kv.get({ kind: 'device', stableId: 's1' }, 'other', 'note')).toBeNull()
  })

  test('a delete is scoped the same way and reports whether anything was there', async () => {
    const h = await setUp()
    h.executor.execute({ plugin: 'tiktok', actionId: 'remember', row, actor })
    const first = h.executor.execute({ plugin: 'tiktok', actionId: 'forget', row, actor })
    const second = h.executor.execute({ plugin: 'tiktok', actionId: 'forget', row, actor })

    expect(first).toEqual({ kind: 'kv.delete', scope: 'device', stableId: 's1', key: 'note', deleted: true })
    expect(second).toEqual({ kind: 'kv.delete', scope: 'device', stableId: 's1', key: 'note', deleted: false })
    expect(h.kv.get({ kind: 'device', stableId: 's1' }, 'tiktok', 'note')).toBeNull()
  })

  test('a device-scoped write with no device on the row is refused, never silently written globally', async () => {
    const h = await setUp()
    expect(() => h.executor.execute({ plugin: 'tiktok', actionId: 'remember', row: { username: 'alice' }, actor })).toThrow(/\$device\.stableId/)
    expect(h.kv.list({ kind: 'global' }, 'tiktok', { limit: 10 }).items).toHaveLength(0)
  })
})

describe('a `form` action runs its `then`', () => {
  test('with `$form.*` bound to the submitted values', async () => {
    const h = await setUp()
    const result = h.executor.execute({ plugin: 'tiktok', actionId: 'addNote', form: { key: 'note', text: 'check the proxy' }, actor })

    expect(result).toEqual({ kind: 'kv.set', scope: 'global', stableId: null, key: 'note' })
    expect(h.kv.get({ kind: 'global' }, 'tiktok', 'note')?.value).toBe('check the proxy')
  })

  test('its derived permission is its `then`\'s, not the form\'s own', async () => {
    const h = await setUp()
    expect(actionPermission(h.executor.lookup('tiktok', 'addNote'))).toBe('plugin.data')
    expect(actionPermission(h.executor.lookup('tiktok', 'switchTo'))).toBe('job.run')
    expect(actionPermission(h.executor.lookup('tiktok', 'sync'))).toBe('job.run')
    expect(actionPermission(h.executor.lookup('tiktok', 'remember'))).toBe('plugin.data')
    expect(actionPermission(h.executor.lookup('tiktok', 'forget'))).toBe('plugin.data')
  })

  test('a nested form-of-a-form derives through to the leaf', () => {
    const nested: ActionSpec = {
      kind: 'form',
      label: 'Outer',
      schema: { type: 'object' },
      submitLabel: 'Save',
      then: { kind: 'form', label: 'Inner', schema: { type: 'object' }, submitLabel: 'Save', then: { kind: 'job', label: 'Run', script: 'a/b@latest', device: 'row' } },
    }
    expect(actionPermission(nested)).toBe('job.run')
  })
})

describe('an unknown action id is refused', () => {
  test('a plugin that is live but declares no such action', async () => {
    const h = await setUp()
    expect(() => h.executor.lookup('tiktok', 'nope')).toThrow(/declares no action "nope"/)
  })

  test('a plugin that is not live at all', async () => {
    const h = await setUp()
    h.runtime.disable('tiktok')
    expect(() => h.executor.lookup('tiktok', 'sync')).toThrow(/no active plugin or dev slot/)
  })
})

describe('every execution writes exactly one `plugin.action` audit row (criterion 15)', () => {
  test('naming the plugin, the action id, and the resolved target — for each kind', async () => {
    const h = await setUp()
    h.executor.execute({ plugin: 'tiktok', actionId: 'switchTo', row, actor })
    h.executor.execute({ plugin: 'tiktok', actionId: 'sync', deviceIds: ['d1', 'd2'], actor })
    h.executor.execute({ plugin: 'tiktok', actionId: 'remember', row, actor })
    h.executor.execute({ plugin: 'tiktok', actionId: 'addNote', form: { key: 'k', text: 'v' }, actor })

    const rows = h.pluginActionRows()
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.target)).toEqual(['tiktok/switchTo', 'tiktok/sync', 'tiktok/remember', 'tiktok/addNote'])
    expect(rows.every((r) => r.userId === 'u1')).toBe(true)

    const metas = rows.map((r) => r.meta)
    expect(metas[0]).toMatchObject({ plugin: 'tiktok', actionId: 'switchTo', kind: 'job', target: 'd1' })
    expect(metas[1]).toMatchObject({ plugin: 'tiktok', actionId: 'sync', kind: 'batch' })
    expect(metas[2]).toMatchObject({ plugin: 'tiktok', actionId: 'remember', kind: 'kv.set', target: 'tiktok:note' })
    // A `form` reports whatever its `then` did — the audit says what happened,
    // not that a dialog opened.
    expect(metas[3]).toMatchObject({ plugin: 'tiktok', actionId: 'addNote', kind: 'kv.set', target: 'tiktok:k' })
  })

  test('a refused execution writes NO audit row', async () => {
    const h = await setUp()
    expect(() => h.executor.execute({ plugin: 'tiktok', actionId: 'switchTo', row: {}, actor })).toThrow()
    expect(h.pluginActionRows()).toHaveLength(0)
  })
})

describe('a caller lacking the action\'s derived permission is refused', () => {
  test('an anonymous caller gets 403 and nothing is dispatched', async () => {
    const h = await setUp(null)
    const res = await h.app.request('/tiktok/action/switchTo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ row }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('auth.forbidden')
    expect(body.error.message).toContain('job.run')
    expect(h.enqueued).toHaveLength(0)
    expect(h.pluginActionRows()).toHaveLength(0)
  })

  test('the message names the permission the ACTION needs, not the route\'s', async () => {
    const h = await setUp(null)
    const res = await h.app.request('/tiktok/action/remember', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ row }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('plugin.data')
  })
})
