import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createFarmSettingsStore } from '../settings/farm-settings'
import { createSettingsRoutes } from './settings'

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/**
 * `requirePermission('settings.manage')` on `PATCH /api/settings` (plan 34
 * §4.4, §4.5, acceptance #7) — `settings.manage` is ADMIN-only in the ACL
 * matrix (`auth/acl.ts`'s OPERATOR set does not include it), so this is the
 * plan's "an operator hitting an admin-only route is refused" case.
 */
describe('PATCH /api/settings requires settings.manage (plan 34 §4.4, §4.5, acceptance #7)', () => {
  test('an operator is refused', async () => {
    const store = createFarmSettingsStore(setUpDb())
    const app = withUser('operator', createSettingsRoutes(store))
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ battery: { pollIntervalSec: 30 } }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
    // A refused request changes nothing.
    expect(store.get().battery.pollIntervalSec).not.toBe(30)
  })

  test('an unauthenticated request is refused', async () => {
    const store = createFarmSettingsStore(setUpDb())
    const app = withUser(null, createSettingsRoutes(store))
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ battery: { pollIntervalSec: 30 } }),
    })
    expect(res.status).toBe(403)
  })

  test('an admin may update settings', async () => {
    const store = createFarmSettingsStore(setUpDb())
    const app = withUser('admin', createSettingsRoutes(store))
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ battery: { pollIntervalSec: 30 } }),
    })
    expect(res.status).toBe(200)
    expect(store.get().battery.pollIntervalSec).toBe(30)
  })

  test('GET / needs no permission at all — read routes stay open', async () => {
    const store = createFarmSettingsStore(setUpDb())
    const app = withUser(null, createSettingsRoutes(store))
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })
})
