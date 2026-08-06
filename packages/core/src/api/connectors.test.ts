import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { createConnectorStore } from '../agent/connector-store'
import { createModelListCache } from '../agent/provider'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createConnectorRoutes } from './connectors'

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

function setUp(role: 'admin' | 'operator' | null = 'admin', fetchOverride?: typeof fetch) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-connectors-api-test-'))
  const store = createConnectorStore({ db, dataDir, ...(fetchOverride ? { fetch: fetchOverride } : {}) })
  const audit = createAuditLogger(db)
  const modelCache = createModelListCache()
  const app = withUser(role, createConnectorRoutes({ store, audit, modelCache, ...(fetchOverride ? { fetch: fetchOverride } : {}) }))
  return { db, store, app }
}

async function jsonBody(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

describe('connector routes — the credential never crosses the API (criterion 4)', () => {
  test('POST then GET never returns the credential in the response body', async () => {
    const { app } = setUp('admin')
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'anthropic-main', kind: 'anthropic', credential: 'sk-ant-api03-secretvalue1234' }),
    })
    expect(res.status).toBe(201)
    const body = await jsonBody(res)
    expect(JSON.stringify(body)).not.toContain('secretvalue')
    const connector = body.connector as { id: string; configured: boolean; hint: string }
    expect(connector.configured).toBe(true)
    expect(connector.hint).toBe('sk-ant-…1234')

    const got = await app.request(`/${connector.id}`)
    expect(JSON.stringify(await jsonBody(got))).not.toContain('secretvalue')
  })

  test('an operator (settings.view only) can list and read but not create', async () => {
    const { app } = setUp('operator')
    const list = await app.request('/')
    expect(list.status).toBe(200)
    const create = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', kind: 'anthropic' }) })
    expect(create.status).toBe(403)
  })

  test('no logged-in user is refused on every route', async () => {
    const { app } = setUp(null)
    expect((await app.request('/')).status).toBe(403)
  })
})

describe('POST /:id/test — stubbed transport, no real network calls (criterion 6)', () => {
  test('reports and persists ok on a stubbed success', async () => {
    const { app } = setUp('admin', fakeFetch(200, { data: [], has_more: false, first_id: null, last_id: null }))
    const created = await jsonBody(
      await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ok-conn', kind: 'anthropic', credential: 'sk-ant-ok' }) }),
    )
    const id = (created.connector as { id: string }).id
    const res = await app.request(`/${id}/test`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await jsonBody(res)).status).toBe('ok')
    const after = await jsonBody(await app.request(`/${id}`))
    expect((after.connector as { status: string }).status).toBe('ok')
  })

  test('reports unauthenticated on a stubbed 401', async () => {
    const { app } = setUp('admin', fakeFetch(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }))
    const created = await jsonBody(
      await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bad-conn', kind: 'anthropic', credential: 'sk-ant-bad' }) }),
    )
    const id = (created.connector as { id: string }).id
    const res = await app.request(`/${id}/test`, { method: 'POST' })
    expect((await jsonBody(res)).status).toBe('unauthenticated')
  })
})

describe('GET /:id/models (criterion 7)', () => {
  test('a populated list from the (stubbed) provider is not marked fallback', async () => {
    const { app } = setUp(
      'admin',
      fakeFetch(200, {
        data: [{ id: 'claude-opus-5', type: 'model', display_name: 'Opus 5', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 300_000, max_tokens: 64_000, capabilities: null }],
        has_more: false,
        first_id: 'claude-opus-5',
        last_id: 'claude-opus-5',
      }),
    )
    const created = await jsonBody(
      await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'models-conn', kind: 'anthropic', credential: 'sk-ant-good' }) }),
    )
    const id = (created.connector as { id: string }).id
    const res = await app.request(`/${id}/models`)
    expect(res.status).toBe(200)
    const body = (await jsonBody(res)) as { models: Array<{ id: string }>; fallback: boolean }
    expect(body.fallback).toBe(false)
    expect(body.models.map((m) => m.id)).toContain('claude-opus-5')
  })

  test('a failed provider call serves the pinned fallback list, labelled', async () => {
    const { app } = setUp('admin', fakeFetch(500, { type: 'error', error: { type: 'api_error', message: 'down' } }))
    const created = await jsonBody(
      await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'down-conn', kind: 'anthropic', credential: 'sk-ant-down' }) }),
    )
    const id = (created.connector as { id: string }).id
    const res = await app.request(`/${id}/models`)
    const body = (await jsonBody(res)) as { models: Array<{ id: string }>; fallback: boolean }
    expect(body.fallback).toBe(true)
    expect(body.models.length).toBeGreaterThan(0)
  })

  test('with no credential configured at all, returns an empty, fallback-labelled list rather than erroring', async () => {
    const { app } = setUp('admin')
    const created = await jsonBody(await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'no-cred', kind: 'anthropic' }) }))
    const id = (created.connector as { id: string }).id
    const res = await app.request(`/${id}/models`)
    expect(res.status).toBe(200)
    expect((await jsonBody(res)).fallback).toBe(true)
  })
})

describe('DELETE /:id', () => {
  test('removes the connector', async () => {
    const { app } = setUp('admin')
    const created = await jsonBody(await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'gone', kind: 'anthropic' }) }))
    const id = (created.connector as { id: string }).id
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await app.request(`/${id}`)).status).toBe(404)
  })
})
