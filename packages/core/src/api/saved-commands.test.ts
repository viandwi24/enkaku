import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { defaultFarmSettings, type FarmSettings } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { Role } from '../auth/service'
import { openDb, runMigrations, type Db } from '../db'
import { createSavedCommandRoutes, type SavedCommandRoutesDeps } from './saved-commands'

/**
 * `GET/POST/PATCH/DELETE /api/saved-commands` (plan 93 §3.10, §4.4, step
 * 93.6) — the step's own verifiable result, verbatim: the name collision is
 * a coded 409, the cap refuses the 201st (well, the (limit+1)th — the test
 * pins a small limit so it does not have to create 200 real rows), an
 * operator cannot edit an admin's entry, and creating one requires
 * `canUseShell`.
 *
 * Built the same way `api/command-runs.test.ts` (step 93.4) is: a REAL db,
 * a REAL store (`command-console/saved.ts`), only the Hono app wrapped with
 * a fake `user` so `requirePermission`/`canUseShell` see a real actor.
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

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db as Db
}

const shellSettings = (overrides: Partial<FarmSettings['shell']> = {}): FarmSettings['shell'] => ({
  ...defaultFarmSettings().shell,
  mode: 'admin',
  ...overrides,
})

interface Harness {
  db: Db
  app: Hono<AuthEnv>
}

function buildHarness(opts: {
  role?: Role | null
  userId?: string
  settings?: Partial<FarmSettings['shell']>
  db?: Db
}): Harness {
  const db = opts.db ?? setUp()
  const role = opts.role === undefined ? 'admin' : opts.role
  const userId = opts.userId ?? 'u1'
  const deps: SavedCommandRoutesDeps = {
    db,
    settings: () => shellSettings(opts.settings),
    roleOf: () => role ?? 'operator',
    audit: { record: () => {}, list: () => [] },
  }
  const app = withUser(role, userId, createSavedCommandRoutes(deps))
  return { db, app }
}

const jsonReq = (method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

describe('POST /api/saved-commands (plan 93 §3.10, §4.4)', () => {
  test('creating one requires canUseShell — refused when shell.mode is off, even for an admin', async () => {
    const { app } = buildHarness({ role: 'admin', settings: { mode: 'off' } })
    const res = await app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery | grep level' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
  })

  test('creating one requires canUseShell — refused for an operator when shell.mode is admin-only', async () => {
    const { app } = buildHarness({ role: 'operator', settings: { mode: 'admin' } })
    const res = await app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery | grep level' }))
    expect(res.status).toBe(403)
  })

  test('an admin (or an operator once shell.mode allows it) may create one — 201', async () => {
    const { app } = buildHarness({ role: 'admin' })
    const res = await app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery | grep level', description: 'quick battery check' }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { savedCommand: { id: string; name: string; description: string | null } }
    expect(body.savedCommand.name).toBe('battery')
    expect(body.savedCommand.description).toBe('quick battery check')
  })

  test('a duplicate name is refused with a coded 409, not a silent overwrite', async () => {
    const db = setUp()
    const { app } = buildHarness({ role: 'admin', db })
    const first = await app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery' }))
    expect(first.status).toBe(201)

    const second = await app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery | grep level' }))
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe('saved_command_name_exists')

    // The original is untouched — the whole point of a coded refusal
    // instead of a silent overwrite.
    const list = await app.request('/')
    const listBody = (await list.json()) as { items: { name: string; cmd: string }[] }
    expect(listBody.items).toHaveLength(1)
    expect(listBody.items[0]?.cmd).toBe('dumpsys battery')
  })

  test('the cap refuses the (limit+1)th saved command', async () => {
    const db = setUp()
    const { app } = buildHarness({ role: 'admin', db, settings: { savedCommandLimit: 10 } })
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/', jsonReq('POST', { name: `cmd-${i}`, cmd: `echo ${i}` }))
      expect(res.status).toBe(201)
    }
    const overCap = await app.request('/', jsonReq('POST', { name: 'cmd-10', cmd: 'echo 10' }))
    expect(overCap.status).toBe(409)
    const body = (await overCap.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_SAVED_COMMAND_LIMIT')

    const list = await app.request('/')
    const listBody = (await list.json()) as { items: unknown[] }
    expect(listBody.items).toHaveLength(10)
  })

  test('a malformed body is rejected with 400', async () => {
    const { app } = buildHarness({ role: 'admin' })
    const res = await app.request('/', jsonReq('POST', { name: '', cmd: 'echo hi' }))
    expect(res.status).toBe(400)
  })
})

describe('GET /api/saved-commands (plan 93 §4.4) — device.view', () => {
  test('an unauthenticated caller is refused', async () => {
    const { app } = buildHarness({ role: null })
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })

  test('an operator with only device.view may list them', async () => {
    const db = setUp()
    const admin = buildHarness({ role: 'admin', db })
    const created = await admin.app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery' }))
    expect(created.status).toBe(201)

    const { app } = buildHarness({ role: 'operator', db })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { name: string }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.name).toBe('battery')
  })
})

describe('PATCH/DELETE /api/saved-commands/:id — owner or admin (plan 93 §3.10, §4.4)', () => {
  test('an operator cannot edit an admin’s entry', async () => {
    const db = setUp()
    const admin = buildHarness({ role: 'admin', userId: 'admin-1', db, settings: { mode: 'operator' } })
    const created = await admin.app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery' }))
    const createdBody = (await created.json()) as { savedCommand: { id: string } }

    const operator = buildHarness({ role: 'operator', userId: 'op-1', db, settings: { mode: 'operator' } })
    const res = await operator.app.request(`/${createdBody.savedCommand.id}`, jsonReq('PATCH', { cmd: 'dumpsys battery | grep level' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')

    // Untouched.
    const get = await admin.app.request('/')
    const getBody = (await get.json()) as { items: { cmd: string }[] }
    expect(getBody.items[0]?.cmd).toBe('dumpsys battery')
  })

  test('an operator cannot delete an admin’s entry either', async () => {
    const db = setUp()
    const admin = buildHarness({ role: 'admin', userId: 'admin-1', db, settings: { mode: 'operator' } })
    const created = await admin.app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery' }))
    const createdBody = (await created.json()) as { savedCommand: { id: string } }

    const operator = buildHarness({ role: 'operator', userId: 'op-1', db, settings: { mode: 'operator' } })
    const res = await operator.app.request(`/${createdBody.savedCommand.id}`, jsonReq('DELETE'))
    expect(res.status).toBe(403)
  })

  test('the owning operator MAY edit their own entry', async () => {
    const db = setUp()
    const owner = buildHarness({ role: 'operator', userId: 'op-1', db, settings: { mode: 'operator' } })
    const created = await owner.app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery' }))
    const createdBody = (await created.json()) as { savedCommand: { id: string } }

    const res = await owner.app.request(`/${createdBody.savedCommand.id}`, jsonReq('PATCH', { cmd: 'dumpsys battery | grep level' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { savedCommand: { cmd: string } }
    expect(body.savedCommand.cmd).toBe('dumpsys battery | grep level')
  })

  test('an admin MAY edit an operator’s entry', async () => {
    const db = setUp()
    const owner = buildHarness({ role: 'operator', userId: 'op-1', db, settings: { mode: 'operator' } })
    const created = await owner.app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery' }))
    const createdBody = (await created.json()) as { savedCommand: { id: string } }

    const admin = buildHarness({ role: 'admin', userId: 'admin-1', db, settings: { mode: 'operator' } })
    const res = await admin.app.request(`/${createdBody.savedCommand.id}`, jsonReq('DELETE'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: boolean }
    expect(body.deleted).toBe(true)
  })

  test('editing to a name already taken by another saved command is refused with a coded 409', async () => {
    const db = setUp()
    const admin = buildHarness({ role: 'admin', db })
    await admin.app.request('/', jsonReq('POST', { name: 'battery', cmd: 'dumpsys battery' }))
    const second = await admin.app.request('/', jsonReq('POST', { name: 'uptime', cmd: 'uptime' }))
    const secondBody = (await second.json()) as { savedCommand: { id: string } }

    const res = await admin.app.request(`/${secondBody.savedCommand.id}`, jsonReq('PATCH', { name: 'battery' }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('saved_command_name_exists')
  })

  test('editing/deleting an unknown id is a 404', async () => {
    const { app } = buildHarness({ role: 'admin' })
    const patchRes = await app.request('/does-not-exist', jsonReq('PATCH', { cmd: 'echo hi' }))
    expect(patchRes.status).toBe(404)
    const deleteRes = await app.request('/does-not-exist', jsonReq('DELETE'))
    expect(deleteRes.status).toBe(404)
  })
})
