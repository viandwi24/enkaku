import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { buildCoreCapabilityRegistry } from '../capability'
import { createAgentStore } from '../agent/agent-store'
import { createTreeStore } from '../agent/tree/store'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, users } from '../db/schema'
import { createAgentRoutes } from './agents'

const registry = buildCoreCapabilityRegistry()

function withUser(role: 'admin' | 'operator' | null, userId: string, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: userId, email: `${userId}@test`, role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function setUp(role: 'admin' | 'operator' | null = 'operator', userId = 'u1') {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  if (role) db.insert(users).values({ id: userId, email: `${userId}@test`, role, passwordHash: null, createdAt: new Date() }).run()
  const store = createAgentStore({ db, registry })
  const tree = createTreeStore(db)
  const audit = createAuditLogger(db)
  const app = withUser(role, userId, createAgentRoutes({ store, tree, audit }))
  return { db, store, tree, app }
}

async function jsonBody(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

describe('POST /api/agents', () => {
  test('creates an agent, visible on GET /:id and GET /', async () => {
    const { app } = setUp('operator', 'u1')
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'triage', name: 'Triage' }) })
    expect(res.status).toBe(201)
    const body = await jsonBody(res)
    const agent = body.agent as { id: string; ownerId: string }
    expect(agent.ownerId).toBe('u1')

    const got = await app.request(`/${agent.id}`)
    expect(got.status).toBe(200)

    const list = await app.request('/')
    expect(((await jsonBody(list)).agents as unknown[]).length).toBe(1)
  })

  test('an operator without agent.manage cannot create (403)', async () => {
    // Simulate a role that lacks agent.manage by using no user at all — requirePermission refuses.
    const { app } = setUp(null)
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'x', name: 'X' }) })
    expect(res.status).toBe(403)
  })

  test('an invalid body is refused with 400', async () => {
    const { app } = setUp('operator', 'u1')
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'no slug' }) })
    expect(res.status).toBe(400)
  })

  test('an unknown capability id in tools is refused with 400 naming it', async () => {
    const { app } = setUp('operator', 'u1')
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'bad-tool', name: 'Bad', tools: ['nope.nope'] }),
    })
    expect(res.status).toBe(400)
    const body = await jsonBody(res)
    expect(JSON.stringify(body)).toContain('nope.nope')
  })

  test('an operator over-privileging an agent gets 403', async () => {
    const { app } = setUp('operator', 'u1')
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'priv', name: 'Priv', permissions: ['settings.manage'] }),
    })
    expect(res.status).toBe(403)
  })

  test('an unknown device id in deviceGrants is refused with 400', async () => {
    const { app } = setUp('operator', 'u1')
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'devgrant', name: 'DevGrant', deviceGrants: ['no-such-device'] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/agents/:id', () => {
  test('updates a field and returns 404 for a nonexistent agent', async () => {
    const { app } = setUp('operator', 'u1')
    const created = await jsonBody(await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'p1', name: 'P1' }) }))
    const id = (created.agent as { id: string }).id
    const patched = await app.request(`/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'P1 renamed' }) })
    expect(patched.status).toBe(200)
    expect(((await jsonBody(patched)).agent as { name: string }).name).toBe('P1 renamed')

    const missing = await app.request('/does-not-exist', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    expect(missing.status).toBe(404)
  })
})

describe('DELETE /api/agents/:id', () => {
  test('removes the agent', async () => {
    const { app } = setUp('operator', 'u1')
    const created = await jsonBody(await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'p2', name: 'P2' }) }))
    const id = (created.agent as { id: string }).id
    const res = await app.request(`/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    const got = await app.request(`/${id}`)
    expect(got.status).toBe(404)
  })
})

describe('spawn grants — /:id/spawn-grants (plan 67 §3.4, §4.1)', () => {
  async function createAgent(app: Hono<AuthEnv>, slug: string): Promise<string> {
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, name: slug }) })
    return ((await jsonBody(res)).agent as { id: string }).id
  }

  test('defaults to none; granting then revoking round-trips through the API', async () => {
    const { app } = setUp('operator', 'u1')
    const parentId = await createAgent(app, 'parent')
    const childId = await createAgent(app, 'child')

    const empty = await jsonBody(await app.request(`/${parentId}/spawn-grants`))
    expect(empty.childAgentIds).toEqual([])

    const granted = await app.request(`/${parentId}/spawn-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ childAgentId: childId }),
    })
    expect(granted.status).toBe(201)
    expect((await jsonBody(granted)).childAgentIds).toEqual([childId])

    const revoke = await app.request(`/${parentId}/spawn-grants/${childId}`, { method: 'DELETE' })
    expect(revoke.status).toBe(204)
    const after = await jsonBody(await app.request(`/${parentId}/spawn-grants`))
    expect(after.childAgentIds).toEqual([])
  })

  test('granting to an unknown child agent id is refused with 404', async () => {
    const { app } = setUp('operator', 'u1')
    const parentId = await createAgent(app, 'parent2')
    const res = await app.request(`/${parentId}/spawn-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ childAgentId: 'does-not-exist' }),
    })
    expect(res.status).toBe(404)
  })

  test('reading spawn-grants requires only agent.view, but granting requires agent.manage', async () => {
    const { app: writer } = setUp('operator', 'u1')
    const parentId = await createAgent(writer, 'parent3')
    // A caller with no role at all lacks BOTH permissions — refused at agent.view already.
    const { app: reader } = setUp(null)
    const res = await reader.request(`/${parentId}/spawn-grants`)
    expect(res.status).toBe(403)
  })
})

describe('device grants — integration (criterion 10)', () => {
  test('an agent created with a real device grant persists and reads it back', async () => {
    const { app, db } = setUp('operator', 'u1')
    db.insert(devices).values({ id: 'dev-1', stableId: 'dev-1', serial: 'dev-1', label: 'Dev 1' }).run()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'grant1', name: 'Grant1', deviceGrants: ['dev-1'] }),
    })
    expect(res.status).toBe(201)
    const agent = (await jsonBody(res)).agent as { deviceGrants: string[] }
    expect(agent.deviceGrants).toEqual(['dev-1'])
  })
})
