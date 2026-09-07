import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { DeviceInfo } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { applyDeviceLabels, createLabel } from '../registry/device-labels'
import { listDevicesWithLabels } from '../registry/device-registry'
import { createLabelRoutes } from './labels'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `device ${id}`, status: 'online' })
    .run()
}

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function makeApp(db: Db, role: 'admin' | 'operator' | null = 'admin') {
  const broadcasts: DeviceInfo[] = []
  const app = withUser(
    role,
    createLabelRoutes({
      db,
      audit: createAuditLogger(db),
      broadcast: (msg) => broadcasts.push(msg.payload),
      listDevices: () => listDevicesWithLabels(db),
    }),
  )
  return { app, broadcasts }
}

describe('GET /api/labels', () => {
  test('returns every label with its live device count', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const carried = createLabel(db, { name: 'Smoke Pool', color: 'blue' })
    createLabel(db, { name: 'Unused' })
    applyDeviceLabels(db, 'd1', 'add', [carried.id])

    const { app } = makeApp(db)
    const body = (await (await app.request('/')).json()) as {
      labels: Array<{ id: string; name: string; color: string; description: string | null; createdAt: number; deviceCount: number }>
    }
    expect(body.labels).toEqual([
      { id: expect.any(String), name: 'Smoke Pool', color: 'blue', description: null, createdAt: expect.any(Number), deviceCount: 1 },
      { id: expect.any(String), name: 'Unused', color: 'slate', description: null, createdAt: expect.any(Number), deviceCount: 0 },
    ])
  })
})

describe('POST /api/labels', () => {
  test('creates a label with no devices on it, normalising the name', async () => {
    const db = setUp()
    const { app } = makeApp(db)
    const res = await app.request('/', { method: 'POST', body: JSON.stringify({ name: '  Smoke   Pool ' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { label: { name: string; deviceCount: number } }
    expect(body.label.name).toBe('Smoke Pool')
    expect(body.label.deviceCount).toBe(0)
  })

  test('a duplicate name answers 409, naming the label that already exists', async () => {
    const db = setUp()
    createLabel(db, { name: 'Smoke Pool' })
    const { app } = makeApp(db)
    const res = await app.request('/', { method: 'POST', body: JSON.stringify({ name: 'smoke pool' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('Smoke Pool')
  })

  test('a colour outside the palette answers 400 rather than being stored', async () => {
    const db = setUp()
    const { app } = makeApp(db)
    const res = await app.request('/', { method: 'POST', body: JSON.stringify({ name: 'x', color: '#ff0000' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
  })

  test('an operator without device.settings is refused', async () => {
    const db = setUp()
    const { app } = makeApp(db, null)
    const res = await app.request('/', { method: 'POST', body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/labels/:id', () => {
  test('a rename broadcasts device.updated for every device carrying it — a chip must not go stale in an open browser', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    seedDevice(db, 'd2')
    const label = createLabel(db, { name: 'Old' })
    applyDeviceLabels(db, 'd1', 'add', [label.id])

    const { app, broadcasts } = makeApp(db)
    const res = await app.request(`/${label.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'New', color: 'red' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)

    expect(broadcasts.map((d) => d.id)).toEqual(['d1'])
    expect(broadcasts[0]?.labels).toEqual([{ id: label.id, name: 'New', color: 'red' }])
  })

  test('an unknown id answers 404', async () => {
    const db = setUp()
    const { app } = makeApp(db)
    const res = await app.request('/ghost', { method: 'PATCH', body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/labels/:id', () => {
  test('the devices stay and are re-broadcast without the label', async () => {
    const db = setUp()
    seedDevice(db, 'd1')
    const label = createLabel(db, { name: 'Smoke Pool' })
    applyDeviceLabels(db, 'd1', 'add', [label.id])

    const { app, broadcasts } = makeApp(db)
    expect((await app.request(`/${label.id}`, { method: 'DELETE' })).status).toBe(204)

    expect(db.select().from(devices).all()).toHaveLength(1)
    expect(broadcasts.map((d) => d.id)).toEqual(['d1'])
    expect(broadcasts[0]?.labels).toEqual([])

    const body = (await (await app.request('/')).json()) as { labels: unknown[] }
    expect(body.labels).toEqual([])
  })
})
