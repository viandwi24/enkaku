import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import { createPreparationRunner } from '../device/preparation/runner'
import type { PreparationComponent, PreparationRunResult } from '../device/preparation/types'
import { createLogger } from '../util/logger'
import { createDevicePreparationRoutes } from './device-preparation'

/** Same shape `agent-provisioner.test.ts` already uses for a route test. */
function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function makeDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, overrides: Partial<DeviceRow> = {}): void {
  db.insert(devices)
    .values({ id: 'dev-1', stableId: 'stable-dev-1', serial: 'serial-dev-1', label: 'Test Phone', status: 'idle', apiLevel: 34, ...overrides })
    .run()
}

function fakeComponent(id: string, queue: Array<PreparationRunResult>): PreparationComponent {
  const remaining = [...queue]
  return {
    id,
    label: id,
    applicable: () => true,
    unsupportedReason: () => `${id} not applicable`,
    async run() {
      const next = remaining.shift()
      if (!next) throw new Error(`no queued result for ${id}`)
      return next
    },
  }
}

describe('createDevicePreparationRoutes (plan 106 §3.3, §4)', () => {
  test('GET /:id/preparation reads the persisted record without running anything', async () => {
    const db = makeDb()
    seedDevice(db)
    const runner = createPreparationRunner({ db, registry: [fakeComponent('ui-server', [{ state: 'ready', version: '1', reason: null }])], log: createLogger('t') })
    await runner.ensure('dev-1')
    const { routes } = createDevicePreparationRoutes({ db, runner })

    const res = await withUser('admin', routes).request('/dev-1/preparation')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, { state: string }>
    expect(body['ui-server']?.state).toBe('ready')
  })

  test('GET /:id/preparation 404s for an unknown device', async () => {
    const db = makeDb()
    const runner = createPreparationRunner({ db, registry: [], log: createLogger('t') })
    const { routes } = createDevicePreparationRoutes({ db, runner })
    const res = await withUser('admin', routes).request('/missing/preparation')
    expect(res.status).toBe(404)
  })

  // `POST /:id/preparation` and `POST /:id/preparation/:componentId/retry`
  // (including the guest-agent bridge) are removed by plan 207 (MVP 07):
  // `prepare` and `retry-prepare` are actions API verbs now, tested in
  // `packages/core/src/actions/impl/preparation` call sites and
  // `packages/core/src/api/actions.test.ts`.

  describe('GET /:id/preparation overlays a live pass in flight (plan 106 §5 step 106.7)', () => {
    test('a component whose run() is still pending reads provisioning, with checkedAt as its start time — never persisted', async () => {
      const db = makeDb()
      seedDevice(db)
      let release: (() => void) | null = null
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const component: PreparationComponent = {
        id: 'ui-server',
        label: 'ui-server',
        applicable: () => true,
        unsupportedReason: () => 'n/a',
        async run() {
          await gate
          return { state: 'ready', version: '1', reason: null }
        },
      }
      const runner = createPreparationRunner({ db, registry: [component], log: createLogger('t'), now: () => 1_700_000_000_000 })
      const { routes } = createDevicePreparationRoutes({ db, runner })

      const pass = runner.ensure('dev-1')
      await Promise.resolve()
      await Promise.resolve()

      const res = await withUser('admin', routes).request('/dev-1/preparation')
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, { state: string; checkedAt: number | null }>
      expect(body['ui-server']).toMatchObject({ state: 'provisioning', checkedAt: 1_700_000_000 })
      // The overlay is read-time only — the DB itself never saw 'provisioning'.
      const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
      expect(row?.preparation ?? null).toBeNull()

      release!()
      await pass
      const after = await withUser('admin', routes).request('/dev-1/preparation')
      const afterBody = (await after.json()) as Record<string, { state: string }>
      expect(afterBody['ui-server']?.state).toBe('ready') // reverts the instant the real pass settles
    })

    test('the bridged guest agent overlays provisioning too, via agentProvisioner.runningSince', async () => {
      const db = makeDb()
      seedDevice(db)
      const runner = createPreparationRunner({ db, registry: [], log: createLogger('t') })
      const agentProvisioner = {
        ensure: async () => undefined,
        runningSince: (deviceId: string) => (deviceId === 'dev-1' ? 1_700_000_123 : null),
      }
      const { routes } = createDevicePreparationRoutes({ db, runner, agentProvisioner })

      const res = await withUser('admin', routes).request('/dev-1/preparation')
      const body = (await res.json()) as Record<string, { state: string; checkedAt: number | null }>
      expect(body['guest-agent']).toMatchObject({ state: 'provisioning', checkedAt: 1_700_000_123 })
    })
  })
})
