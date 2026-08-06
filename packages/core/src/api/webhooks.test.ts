import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createWebhookStore } from '../notify/webhook-store'
import { createWebhookRoutes } from './webhooks'

/**
 * `GET/POST/PATCH/DELETE /api/webhooks` (plan 68 §3.4, §4.1, §4.5) — the
 * secret is write-only (criterion 10: "the secret is never returned by any
 * API"), farm-level and admin-managed (gated by `settings.manage`).
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

function setUp(role: 'admin' | 'operator' | null = 'admin') {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-webhooks-api-test-'))
  const store = createWebhookStore({ db, dataDir })
  const audit = createAuditLogger(db)
  const app = withUser(role, createWebhookRoutes({ store, audit }))
  return { db, store, audit, app }
}

async function jsonBody(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

describe('webhook routes — the secret never crosses the API (criterion 10)', () => {
  test('POST then GET never returns the secret in the response body', async () => {
    const { app } = setUp('admin')
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'on-call', url: 'https://hooks.example.com/x', secret: 'super-secret-value' }),
    })
    expect(res.status).toBe(201)
    const body = await jsonBody(res)
    expect(JSON.stringify(body)).not.toContain('super-secret-value')
    const endpoint = body.endpoint as { id: string; configured: boolean }
    expect(endpoint.configured).toBe(true)

    const got = await app.request('/')
    expect(JSON.stringify(await jsonBody(got))).not.toContain('super-secret-value')
  })

  test('a POST with an invalid body (missing name/url) is a 400', async () => {
    const { app } = setUp('admin')
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    expect(res.status).toBe(400)
  })

  test('a duplicate name is a 409', async () => {
    const { app } = setUp('admin')
    await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'dup', url: 'https://a.example.com' }) })
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'dup', url: 'https://b.example.com' }) })
    expect(res.status).toBe(409)
  })

  test('PATCH can disable an endpoint without touching its secret', async () => {
    const { app, store } = setUp('admin')
    const created = store.create({ name: 'toggle-me', url: 'https://example.com', secret: 'keep-me' })
    const res = await app.request(`/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    expect(res.status).toBe(200)
    const body = await jsonBody(res)
    expect((body.endpoint as { enabled: boolean }).enabled).toBe(false)
    expect(store.resolveSecret(created.id)).toBe('keep-me')
  })

  test('DELETE removes the endpoint', async () => {
    const { app, store } = setUp('admin')
    const created = store.create({ name: 'gone', url: 'https://example.com' })
    const res = await app.request(`/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(store.get(created.id)).toBeNull()
  })

  test('DELETE on an unknown id is a 404', async () => {
    const { app } = setUp('admin')
    const res = await app.request('/no-such-id', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('every mutation is audited', async () => {
    const { app, audit } = setUp('admin')
    const createdRes = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'audited', url: 'https://example.com' }) })
    const created = await jsonBody(createdRes)
    const id = (created.endpoint as { id: string }).id
    await app.request(`/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    await app.request(`/${id}`, { method: 'DELETE' })
    const actions = audit.list(20).map((e) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['webhook.create', 'webhook.update', 'webhook.delete']))
  })

  test('an operator (no settings.manage) is refused write access, but can still read', async () => {
    const { app } = setUp('operator')
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', url: 'https://example.com' }) })
    expect(res.status).toBe(403)
  })
})
