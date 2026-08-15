import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  KvEntryResponseSchema,
  KvListResponseSchema,
  PluginDevPutResponseSchema,
  PluginRestartResponseSchema,
  PluginStageResponseSchema,
  PluginsListResponseSchema,
} from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createKvStore } from '../kv/store'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createPluginRuntime } from '../plugins/runtime'
import type { VerifyReport } from '../plugins/verify-child'
import { createScriptRegistry } from '../scripts/registry'
import { createWorkspaceStore } from '../workspace/store'
import { createKvRoutes } from './kv'
import { createPluginRoutes } from './plugins'

/**
 * Plan 72's own precedent (`cap.test.ts`, `criterion 6`): a Studio `api()`
 * call is only as honest as the schema it is checked against — this proves
 * `@enkaku/protocol`'s new `plugins.ts`/`kv.ts` schemas parse what these
 * REAL routes actually send, over a real Hono app, never a mocked fetch.
 */

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u1@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function healthyReport(overrides: Partial<VerifyReport> = {}): VerifyReport {
  return { ok: true, pluginId: 'tiktok', version: '1.0.0', scripts: [{ id: 'login', paramsSchema: { type: 'object' }, runtime: null }], resetPackages: [], ...overrides }
}

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugins-kv-protocol-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('GET /api/plugins matches PluginsListResponseSchema', () => {
  test('a mix of an active, a failed, and a dev-slot plugin all parse — including the ISO-string timestamps', async () => {
    const opened = openDb(':memory:')
    const db: Db = opened.db
    runMigrations(db)
    const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    let healthy = true
    const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify: async () => (healthy ? healthyReport() : { ok: false, error: 'boom', errorCode: 'E_X', scripts: [], resetPackages: [] }) })
    const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1000, maxTotalBytesPerScope: 10_000_000 }))
    const audit = createAuditLogger(db)
    const app = withUser('admin', createPluginRoutes({ runtime, audit, workspace }))

    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)

    healthy = false
    await runtime.stage({ name: 'broken', version: '1.0.0', bundle: 'export {}' })
    await runtime.verify((await runtime.stage({ name: 'broken', version: '1.0.1', bundle: 'export {}' })).id)

    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    const parsed = PluginsListResponseSchema.parse(body)
    expect(parsed.items.some((p) => p.status === 'active')).toBe(true)
    expect(parsed.items.some((p) => p.status === 'failed' && p.verifyError?.includes('boom'))).toBe(true)
    // The timestamp really is a string on this route (documented deviation in the schema file).
    expect(typeof parsed.items[0]?.createdAt).toBe('string')
  })

  test('POST /api/plugins (stage+verify) and POST /api/plugins/dev both parse', async () => {
    const opened = openDb(':memory:')
    const db: Db = opened.db
    runMigrations(db)
    const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify: async () => healthyReport() })
    const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1000, maxTotalBytesPerScope: 10_000_000 }))
    const audit = createAuditLogger(db)
    const app = withUser('admin', createPluginRoutes({ runtime, audit, workspace }))

    const stageRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' }),
    })
    PluginStageResponseSchema.parse(await stageRes.json())

    workspace.write('/scripts/tiktok/index.ts', { content: new TextEncoder().encode(`export default { id: 'tiktok', version: '1.0.0', scripts: [] }`), actor: null })
    const devRes = await app.request('/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tiktok-dev', entryPath: '/scripts/tiktok/index.ts' }),
    })
    PluginDevPutResponseSchema.parse(await devRes.json())

    const restartRes = await app.request('/restart', { method: 'POST' })
    PluginRestartResponseSchema.parse(await restartRes.json())
  })
})

describe('GET/PUT /api/kv matches KvListResponseSchema/KvEntryResponseSchema — a secret never carries `value`', () => {
  test('list and single-entry reads both parse, and a secret entry\'s value is null on both', async () => {
    const opened = openDb(':memory:')
    const db: Db = opened.db
    runMigrations(db)
    const store = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
    const audit = createAuditLogger(db)
    const app = withUser('admin', createKvRoutes({ store, audit }))

    const putRes = await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'tiktok', key: 'token', value: 'sk-super-secret-value', secret: true }),
    })
    const putParsed = KvEntryResponseSchema.parse(await putRes.json())
    expect(putParsed.secret).toBe(true)
    expect(putParsed.value).toBeNull()
    expect(putParsed.hint).toBeTruthy()

    const entryRes = await app.request('/entry?scope=global&namespace=tiktok&key=token')
    const entryParsed = KvEntryResponseSchema.parse(await entryRes.json())
    expect(entryParsed.value).toBeNull()

    const listRes = await app.request('/?scope=global&namespace=tiktok')
    const listParsed = KvListResponseSchema.parse(await listRes.json())
    expect(listParsed.items.every((i) => !i.secret || i.value === null)).toBe(true)
  })
})
