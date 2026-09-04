import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { buildCoreCapabilityRegistry } from '../capability'
import { createAgentStore } from '../agent/agent-store'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createAgentSettingsStore } from '../settings/agent-settings'
import { createAgentRoutes } from './agents'

const registry = buildCoreCapabilityRegistry()

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u1@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function setUp(role: 'admin' | 'operator' | null = 'admin'): { app: Hono<AuthEnv>; db: Db } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const store = createAgentStore({ db, registry })
  const audit = createAuditLogger(db)
  const settings = createAgentSettingsStore(db)
  const app = withUser(role, createAgentRoutes({ store, audit, settings }))
  return { app, db }
}

async function jsonBody(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

describe('GET /api/agents/settings (plan 212 §4.7)', () => {
  test('returns defaults on a fresh database', async () => {
    const { app } = setUp()
    const res = await app.request('/settings')
    expect(res.status).toBe(200)
    const body = await jsonBody(res)
    expect(body.settings).toBeTruthy()
    const settings = body.settings as { defaults: unknown; scheduled: { maxConcurrentScheduledRuns: number } }
    expect(settings.scheduled.maxConcurrentScheduledRuns).toBe(3)
  })

  test('does not resolve as GET /api/agents/:id — route order matters', async () => {
    const { app } = setUp()
    const res = await app.request('/settings')
    expect(res.status).toBe(200)
    const body = await jsonBody(res)
    expect(body).not.toHaveProperty('agent')
    expect(body).toHaveProperty('settings')
  })
})

describe('PATCH /api/agents/settings (plan 212 §4.7)', () => {
  test('a valid patch returns 200 and a later GET reads it back', async () => {
    const { app } = setUp()
    const patchRes = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled: { maxConcurrentScheduledRuns: 5 } }),
    })
    expect(patchRes.status).toBe(200)
    const patched = (await jsonBody(patchRes)).settings as { scheduled: { maxConcurrentScheduledRuns: number } }
    expect(patched.scheduled.maxConcurrentScheduledRuns).toBe(5)

    const getRes = await app.request('/settings')
    const got = (await jsonBody(getRes)).settings as { scheduled: { maxConcurrentScheduledRuns: number } }
    expect(got.scheduled.maxConcurrentScheduledRuns).toBe(5)
  })

  test('an invalid patch returns 400 naming the field', async () => {
    const { app } = setUp()
    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled: { maxConcurrentScheduledRuns: 0 } }),
    })
    expect(res.status).toBe(400)
    const body = await jsonBody(res)
    const message = (body as { error?: { message?: string } }).error?.message ?? ''
    expect(message).toContain('maxConcurrentScheduledRuns')
  })
})
