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
      body: JSON.stringify({ devices: { tempThresholdC: 30 } }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth.forbidden')
    // A refused request changes nothing.
    expect(store.get().devices.tempThresholdC).not.toBe(30)
  })

  test('an unauthenticated request is refused', async () => {
    const store = createFarmSettingsStore(setUpDb())
    const app = withUser(null, createSettingsRoutes(store))
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ devices: { tempThresholdC: 30 } }),
    })
    expect(res.status).toBe(403)
  })

  test('an admin may update settings', async () => {
    const store = createFarmSettingsStore(setUpDb())
    const app = withUser('admin', createSettingsRoutes(store))
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ devices: { tempThresholdC: 30 } }),
    })
    expect(res.status).toBe(200)
    expect(store.get().devices.tempThresholdC).toBe(30)
  })

  test('GET / needs no permission at all — read routes stay open', async () => {
    const store = createFarmSettingsStore(setUpDb())
    const app = withUser(null, createSettingsRoutes(store))
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })
})

/**
 * `POST /api/settings/reset` — the same admin-only gate as `PATCH`, plus the
 * two properties that make a button labelled "reset" safe to put in front of
 * a farm operator: it names what it touches, and it cannot reach anything
 * else.
 */
describe('POST /api/settings/reset', () => {
  const post = (app: Hono<AuthEnv>, body: unknown) =>
    app.request('/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('an operator is refused, and nothing is reset', async () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' } })
    const res = await post(withUser('operator', createSettingsRoutes(store)), { sections: ['general'] })

    expect(res.status).toBe(403)
    expect(store.get().general.name).toBe('Rack B')
  })

  test('an unauthenticated request is refused', async () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' } })
    const res = await post(withUser(null, createSettingsRoutes(store)), { sections: ['general'] })

    expect(res.status).toBe(403)
    expect(store.get().general.name).toBe('Rack B')
  })

  test('an admin resets the named section and gets the new settings back', async () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' }, privacy: { overControl: 'forbid' } })
    const res = await post(withUser('admin', createSettingsRoutes(store)), { sections: ['general'] })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { general: { name: string } }; reset: string[] }
    expect(body.settings.general.name).toBe('Enkaku farm')
    expect(body.reset).toEqual(['general'])
    // Untouched sections stay as the operator left them.
    expect(store.get().privacy.overControl).toBe('forbid')
  })

  test('an unknown section is a 400 that names it, and writes nothing', async () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' } })
    const res = await post(withUser('admin', createSettingsRoutes(store)), { sections: ['devices', 'nope'] })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('nope')
    expect(store.get().general.name).toBe('Rack B')
  })

  test('an empty or malformed body is a 400, never a silent whole-row reset', async () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' } })
    const app = withUser('admin', createSettingsRoutes(store))

    expect((await post(app, { sections: [] })).status).toBe(400)
    expect((await post(app, {})).status).toBe(400)
    expect((await post(app, { sections: 'general' })).status).toBe(400)
    expect(store.get().general.name).toBe('Rack B')
  })

  test('the reset is audited with the sections it applied', async () => {
    const store = createFarmSettingsStore(setUpDb())
    const recorded: Array<{ action: string; meta?: unknown }> = []
    const audit = { record: (input: { action: string; meta?: unknown }) => void recorded.push(input), list: () => [] }
    const app = withUser('admin', createSettingsRoutes(store, { audit: audit as never }))

    await post(app, { sections: ['general', 'privacy'] })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.action).toBe('settings.reset')
    expect(recorded[0]!.meta).toEqual({ sections: ['general', 'privacy'] })
  })

  test('a refused reset is not audited', async () => {
    const store = createFarmSettingsStore(setUpDb())
    const recorded: unknown[] = []
    const audit = { record: (input: unknown) => void recorded.push(input), list: () => [] }
    const app = withUser('admin', createSettingsRoutes(store, { audit: audit as never }))

    await post(app, { sections: ['nope'] })
    expect(recorded).toHaveLength(0)
  })
})

/** The defaults a reset would apply, sent so a client can preview one before committing. */
describe('GET /api/settings carries this build’s defaults', () => {
  test('defaults are the schema defaults, and are not the stored values once those differ', async () => {
    const store = createFarmSettingsStore(setUpDb())
    store.update({ general: { name: 'Rack B' } })
    const res = await withUser('admin', createSettingsRoutes(store)).request('/')

    const body = (await res.json()) as { settings: { general: { name: string } }; defaults: { general: { name: string } } }
    expect(body.settings.general.name).toBe('Rack B')
    expect(body.defaults.general.name).toBe('Enkaku farm')
  })
})
