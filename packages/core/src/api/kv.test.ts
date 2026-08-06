import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createKvStore, type KvStore } from '../kv/store'
import { createKvRoutes } from './kv'

function withUser(role: 'admin' | 'operator' | null, userId: string, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: userId, email: `${userId}@test`, role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-kv-api-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function setUp(role: 'admin' | 'operator' | null = 'admin') {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const store: KvStore = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const audit = createAuditLogger(db)
  const app = withUser(role, 'u1', createKvRoutes({ store, audit }))
  return { db, store, audit, app }
}

async function jsonBody(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

describe('kv.manage permission gating (admin-scoped)', () => {
  test('an operator (not admin) is refused with 403 on every verb', async () => {
    const { app } = setUp('operator')
    expect((await app.request('/?scope=global&namespace=ns')).status).toBe(403)
    expect(
      (
        await app.request('/entry', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'k', value: 'v' }),
        })
      ).status,
    ).toBe(403)
    expect((await app.request('/entry?scope=global&namespace=ns&key=k', { method: 'DELETE' })).status).toBe(403)
  })

  test('an anonymous caller is refused with 403', async () => {
    const { app } = setUp(null)
    expect((await app.request('/?scope=global&namespace=ns')).status).toBe(403)
  })

  test('an admin may use every verb', async () => {
    const { app } = setUp('admin')
    const put = await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'k', value: 'v' }),
    })
    expect(put.status).toBe(200)
    expect((await app.request('/?scope=global&namespace=ns')).status).toBe(200)
  })
})

describe('PUT /entry', () => {
  test('creates then overwrites via ifVersion', async () => {
    const { app } = setUp()
    const created = await jsonBody(
      await app.request('/entry', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'k', value: { a: 1 } }),
      }),
    )
    expect(created.value).toEqual({ a: 1 })
    expect(created.version).toBe(1)

    const overwritten = await jsonBody(
      await app.request('/entry', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'k', value: { a: 2 }, ifVersion: 1 }),
      }),
    )
    expect(overwritten.version).toBe(2)
  })

  test('a stale ifVersion is refused with 409', async () => {
    const { app } = setUp()
    await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'k', value: 'v1' }),
    })
    const res = await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'k', value: 'v2', ifVersion: 99 }),
    })
    expect(res.status).toBe(409)
  })

  test('device scope without stableId is refused with 400', async () => {
    const { app } = setUp()
    const res = await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'device', namespace: 'ns', key: 'k', value: 'v' }),
    })
    expect(res.status).toBe(400)
  })
})

// Criterion 4/10: a secret's plaintext appears nowhere in GET /api/kv (list or single entry).
describe('secrets are redacted to a hint everywhere this route responds', () => {
  test('GET /entry never returns a secret\'s plaintext', async () => {
    const { app } = setUp()
    const SECRET = 'sk-ant-real-secret-value-abcdef'
    await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'token', value: SECRET, secret: true }),
    })
    const res = await app.request('/entry?scope=global&namespace=ns&key=token')
    const body = await jsonBody(res)
    expect(body.value).toBeNull()
    expect(body.secret).toBe(true)
    expect(body.hint).not.toBeNull()
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  test('GET / (list) never returns a secret\'s plaintext', async () => {
    const { app } = setUp()
    const SECRET = 'sk-ant-another-real-secret-xyz'
    await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'token', value: SECRET, secret: true }),
    })
    const res = await app.request('/?scope=global&namespace=ns')
    const body = await jsonBody(res)
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  test('the PUT response itself never echoes a secret\'s plaintext back', async () => {
    const { app } = setUp()
    const SECRET = 'sk-ant-yet-another-secret-value'
    const res = await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'token', value: SECRET, secret: true }),
    })
    const body = await jsonBody(res)
    expect(body.value).toBeNull()
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  test('kv.set / kv.delete audit entries never carry a secret\'s plaintext', async () => {
    const { app, audit } = setUp()
    const SECRET = 'sk-ant-audited-secret-value-999'
    await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'token', value: SECRET, secret: true }),
    })
    await app.request('/entry?scope=global&namespace=ns&key=token', { method: 'DELETE' })
    const entries = audit.list(10)
    expect(entries.some((e) => e.action === 'kv.set')).toBe(true)
    expect(entries.some((e) => e.action === 'kv.delete')).toBe(true)
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })
})

describe('DELETE /entry', () => {
  test('deletes an existing key and reports ok:true; a second delete reports ok:false', async () => {
    const { app } = setUp()
    await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'k', value: 'v' }),
    })
    const first = await jsonBody(await app.request('/entry?scope=global&namespace=ns&key=k', { method: 'DELETE' }))
    expect(first.ok).toBe(true)
    const second = await jsonBody(await app.request('/entry?scope=global&namespace=ns&key=k', { method: 'DELETE' }))
    expect(second.ok).toBe(false)
  })
})

describe('GET / (list)', () => {
  test('a missing namespace is refused with 400', async () => {
    const { app } = setUp()
    const res = await app.request('/?scope=global')
    expect(res.status).toBe(400)
  })

  test('paginates via nextCursor', async () => {
    const { app } = setUp()
    for (const k of ['a', 'b', 'c']) {
      await app.request('/entry', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global', namespace: 'ns', key: k, value: k }),
      })
    }
    const page1 = await jsonBody(await app.request('/?scope=global&namespace=ns&limit=2'))
    expect((page1.items as unknown[]).length).toBe(2)
    expect(page1.nextCursor).toBe('b')
    const page2 = await jsonBody(await app.request(`/?scope=global&namespace=ns&limit=2&cursor=${page1.nextCursor}`))
    expect((page2.items as unknown[]).length).toBe(1)
    expect(page2.nextCursor).toBeNull()
  })
})
