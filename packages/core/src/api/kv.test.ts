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

/**
 * `POST /entry/reveal` — the one route in this file that answers with a
 * plaintext, and the reason `kv.reveal` exists in the audit action list.
 */
describe('POST /entry/reveal — the audited door onto one secret', () => {
  const SECRET = 'socks5://user-9f:s0ax-p4ssw0rd@proxy.example:1080'

  async function reveal(app: Hono<AuthEnv>, body: unknown) {
    return app.request('/entry/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  test('returns the plaintext for a secret row, uncacheable, and records exactly one audit row that does NOT carry it', async () => {
    const { app, store, audit } = setUp()
    store.set({ kind: 'global' }, 'proxy-manager', 'proxy-secret:1', SECRET, { secret: true, hint: false })

    const res = await reveal(app, { scope: 'global', namespace: 'proxy-manager', key: 'proxy-secret:1' })
    expect(res.status).toBe(200)
    const body = await jsonBody(res)
    expect(body.value).toBe(SECRET)
    expect(body.key).toBe('proxy-secret:1')
    expect(body.namespace).toBe('proxy-manager')
    expect(typeof body.revealedAt).toBe('number')
    // A password written to a disk cache by an intermediary is the failure mode `no-cache` would
    // still permit (it allows storing and revalidating) — `no-store` is the one that does not.
    expect(res.headers.get('cache-control')).toBe('no-store')

    const rows = audit.list(10).filter((e) => e.action === 'kv.reveal')
    expect(rows.length).toBe(1)
    expect(rows[0]?.userId).toBe('u1')
    expect(rows[0]?.target).toBe('proxy-secret:1')
    expect(rows[0]?.meta).toMatchObject({ outcome: 'revealed', namespace: 'proxy-manager', scope: 'global' })
    expect(JSON.stringify(rows)).not.toContain(SECRET)
  })

  test('a device-scoped secret is revealed under its own stableId, and not under another device', async () => {
    const { app, store } = setUp()
    store.set({ kind: 'device', stableId: 'stable-a' }, 'proxy-manager', 'session', SECRET, { secret: true })

    const mine = await reveal(app, { scope: 'device', stableId: 'stable-a', namespace: 'proxy-manager', key: 'session' })
    expect((await jsonBody(mine)).value).toBe(SECRET)
    const other = await reveal(app, { scope: 'device', stableId: 'stable-b', namespace: 'proxy-manager', key: 'session' })
    expect(other.status).toBe(404)
  })

  test('a NON-secret row is refused by name — reveal is not a second way to read an ordinary value', async () => {
    const { app, store, audit } = setUp()
    store.set({ kind: 'global' }, 'tiktok', 'plain', { a: 1 })

    const res = await reveal(app, { scope: 'global', namespace: 'tiktok', key: 'plain' })
    expect(res.status).toBe(400)
    const err = (await jsonBody(res)).error as { message: string }
    expect(err.message).toContain('is not a secret')
    expect(audit.list(10).filter((e) => e.action === 'kv.reveal')[0]?.meta).toMatchObject({ outcome: 'not-secret' })
  })

  test('a key that does not exist is a 404, and the attempt is still recorded', async () => {
    const { app, audit } = setUp()
    const res = await reveal(app, { scope: 'global', namespace: 'tiktok', key: 'nope' })
    expect(res.status).toBe(404)
    expect(audit.list(10).filter((e) => e.action === 'kv.reveal')[0]?.meta).toMatchObject({ outcome: 'not-found' })
  })

  test('an operator is refused with 403 — and the REFUSAL is audited, which a requirePermission middleware could not do', async () => {
    const { app, store, audit } = setUp('operator')
    store.set({ kind: 'global' }, 'proxy-manager', 'proxy-secret:1', SECRET, { secret: true })

    const res = await reveal(app, { scope: 'global', namespace: 'proxy-manager', key: 'proxy-secret:1' })
    expect(res.status).toBe(403)
    const rows = audit.list(10).filter((e) => e.action === 'kv.reveal')
    expect(rows.length).toBe(1)
    expect(rows[0]?.meta).toMatchObject({ outcome: 'forbidden', role: 'operator' })
    // The refused response says nothing about the value, not even whether the key exists.
    expect(JSON.stringify(await jsonBody(res))).not.toContain(SECRET)
  })

  test('an anonymous caller is refused with 403', async () => {
    const { app } = setUp(null)
    expect((await reveal(app, { scope: 'global', namespace: 'ns', key: 'k' })).status).toBe(403)
  })

  test('scope=device with no stableId is a 400, and still leaves a row', async () => {
    const { app, audit } = setUp()
    expect((await reveal(app, { scope: 'device', namespace: 'ns', key: 'k' })).status).toBe(400)
    expect(audit.list(10).filter((e) => e.action === 'kv.reveal')[0]?.meta).toMatchObject({ outcome: 'bad-request' })
  })

  test('revealing does NOT change what any listing returns — list() still never decrypts', async () => {
    const { app, store } = setUp()
    store.set({ kind: 'global' }, 'proxy-manager', 'proxy-secret:1', SECRET, { secret: true })
    await reveal(app, { scope: 'global', namespace: 'proxy-manager', key: 'proxy-secret:1' })

    const list = await jsonBody(await app.request('/?scope=global&namespace=proxy-manager'))
    expect(JSON.stringify(list)).not.toContain(SECRET)
    const single = await jsonBody(await app.request('/entry?scope=global&namespace=proxy-manager&key=proxy-secret:1'))
    expect(single.value).toBeNull()
    const index = await jsonBody(await app.request('/namespaces?scope=global'))
    expect(JSON.stringify(index)).not.toContain(SECRET)
  })
})

// Hotfix 96.38: the admin route could not decline a secret's hint, so an admin editing a
// credential through Studio's own panel silently restored the `${first 7}…${last 4}` leak that
// plan 112 step 112.2 had closed on the plugin route. Asserted here the way
// `plugins-data.test.ts` already asserts it through the plugin door.
describe('PUT /entry — hint (96.38)', () => {
  const CREDENTIAL = 'p4ssw0rd-with-a-long-tail-9999'

  test('hint:false stores no hint at all, and the fragment appears on no read path', async () => {
    const { app } = setUp()
    const put = await jsonBody(
      await app.request('/entry', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global', namespace: 'proxy-manager', key: 'proxy-secret:1', value: CREDENTIAL, secret: true, hint: false }),
      }),
    )
    expect(put.secret).toBe(true)
    expect(put.hint).toBeNull()

    const single = await jsonBody(await app.request('/entry?scope=global&namespace=proxy-manager&key=proxy-secret:1'))
    expect(single.hint).toBeNull()
    const list = await jsonBody(await app.request('/?scope=global&namespace=proxy-manager'))
    expect(JSON.stringify(list)).not.toContain('p4ssw0r')
  })

  test('an omitted hint is unchanged behaviour — the store default (true) still applies', async () => {
    const { app } = setUp()
    const put = await jsonBody(
      await app.request('/entry', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global', namespace: 'ns', key: 'api-key', value: CREDENTIAL, secret: true }),
      }),
    )
    expect(put.hint).toBe('p4ssw0r…9999')
  })

  test('a hint:false row stays hint-free when it is rewritten with hint:false — the flag is per write, and the admin door can now send it', async () => {
    const { app, store } = setUp()
    store.set({ kind: 'global' }, 'proxy-manager', 'proxy-secret:1', CREDENTIAL, { secret: true, hint: false })
    const rewritten = await jsonBody(
      await app.request('/entry', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global', namespace: 'proxy-manager', key: 'proxy-secret:1', value: 'a-new-password-0000', secret: true, hint: false }),
      }),
    )
    expect(rewritten.hint).toBeNull()
  })

  test('the kv.set audit row records WHETHER a hint was stored, never the hint itself', async () => {
    const { app, audit } = setUp()
    await app.request('/entry', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', namespace: 'proxy-manager', key: 'proxy-secret:1', value: CREDENTIAL, secret: true, hint: false }),
    })
    const row = audit.list(10).find((e) => e.action === 'kv.set')
    expect(row?.meta).toMatchObject({ secret: true, hint: false })
    expect(JSON.stringify(row)).not.toContain('p4ssw0r')
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

describe('GET /namespaces (the index)', () => {
  test('an operator (not admin) is refused — the index sits behind the same kv.manage gate as the rest of this file', async () => {
    const { app } = setUp('operator')
    expect((await app.request('/namespaces?scope=global')).status).toBe(403)
  })

  test('answers { items: [{namespace, entries, secrets}] } per scope, and nothing else', async () => {
    const { app, store } = setUp()
    store.set({ kind: 'global' }, 'tiktok', 'a', 1)
    store.set({ kind: 'global' }, 'tiktok', 'token', 'sk-ant-api03-abcdefgh7Xq2', { secret: true })
    store.set({ kind: 'global' }, 'proxy-manager', 'a', 1)
    store.set({ kind: 'device', stableId: 'stable-a' }, 'tiktok', 'a', 1)

    const body = await jsonBody(await app.request('/namespaces?scope=global'))
    expect(body).toEqual({
      items: [
        { namespace: 'proxy-manager', entries: 1, secrets: 0 },
        { namespace: 'tiktok', entries: 2, secrets: 1 },
      ],
    })
    // No key, no value, no hint — the secret's plaintext and its hint are both absent from an
    // enumeration response by construction, not by redaction.
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('sk-ant')
    expect(raw).not.toContain('token')
  })

  test('scope=device is scoped to that one stableId', async () => {
    const { app, store } = setUp()
    store.set({ kind: 'global' }, 'proxy-manager', 'a', 1)
    store.set({ kind: 'device', stableId: 'stable-a' }, 'tiktok', 'a', 1)

    const mine = await jsonBody(await app.request('/namespaces?scope=device&stableId=stable-a'))
    expect(mine).toEqual({ items: [{ namespace: 'tiktok', entries: 1, secrets: 0 }] })
    const other = await jsonBody(await app.request('/namespaces?scope=device&stableId=stable-b'))
    expect(other).toEqual({ items: [] })
  })

  test('scope=device without a stableId is refused with 400', async () => {
    const { app } = setUp()
    expect((await app.request('/namespaces?scope=device')).status).toBe(400)
  })
})
