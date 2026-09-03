import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createNotificationStore } from '../notify/store'
import { createNotificationRoutes } from './notifications'

/** `GET/POST /api/notifications` (plan 68 §4.5) — the bell's REST surface. */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const store = createNotificationStore(db)
  const app = createNotificationRoutes({ store })
  return { store, app }
}

async function jsonBody(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

describe('notification routes', () => {
  test('GET / lists notifications newest-first-ish, with an accurate unreadCount', async () => {
    const { store, app } = setUp()
    store.create({ level: 'info', title: 'a', source: 'system' })
    store.create({ level: 'warn', title: 'b', source: 'system' })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await jsonBody(res)
    expect((body.items as unknown[]).length).toBe(2)
    expect(body.unreadCount).toBe(2)
  })

  test('GET /?unreadOnly=true excludes read notifications', async () => {
    const { store, app } = setUp()
    const a = store.create({ level: 'info', title: 'a', source: 'system' })
    store.create({ level: 'info', title: 'b', source: 'system' })
    store.markRead(a.id)
    const res = await app.request('/?unreadOnly=true')
    const body = await jsonBody(res)
    expect((body.items as { title: string }[]).map((i) => i.title)).toEqual(['b'])
  })

  test('GET /?limit=1 caps the page size', async () => {
    const { store, app } = setUp()
    store.create({ level: 'info', title: 'a', source: 'system' })
    store.create({ level: 'info', title: 'b', source: 'system' })
    const res = await app.request('/?limit=1')
    const body = await jsonBody(res)
    expect((body.items as unknown[]).length).toBe(1)
  })

  test('POST /:id/read marks one notification read and is reflected in unreadCount', async () => {
    const { store, app } = setUp()
    const a = store.create({ level: 'info', title: 'a', source: 'system' })
    const res = await app.request(`/${a.id}/read`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await jsonBody(res)
    expect((body.notification as { readAt: number | null }).readAt).not.toBeNull()
    expect(store.unreadCount()).toBe(0)
  })

  test('POST /:id/read on an unknown id is a 404', async () => {
    const { app } = setUp()
    const res = await app.request('/no-such-id/read', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('POST /read-all marks every unread notification and returns the count', async () => {
    const { store, app } = setUp()
    store.create({ level: 'info', title: 'a', source: 'system' })
    store.create({ level: 'info', title: 'b', source: 'system' })
    const res = await app.request('/read-all', { method: 'POST' })
    expect(await jsonBody(res)).toEqual({ count: 2 })
    expect(store.unreadCount()).toBe(0)
  })

  test('a notification\'s context links back to the run that produced it (criterion 14)', async () => {
    const { store, app } = setUp()
    store.create({ level: 'warn', title: 'found a bug', source: 'agent:a1', context: { runId: 'r1', threadId: 't1', agentId: 'a1' } })
    const res = await app.request('/')
    const body = await jsonBody(res)
    const item = (body.items as { context: unknown }[])[0]
    expect(item?.context).toEqual({ runId: 'r1', threadId: 't1', agentId: 'a1' })
  })
})
