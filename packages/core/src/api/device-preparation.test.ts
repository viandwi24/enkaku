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

  test('POST /:id/preparation runs every registered component for that device', async () => {
    const db = makeDb()
    seedDevice(db)
    const runner = createPreparationRunner({
      db,
      registry: [fakeComponent('a', [{ state: 'ready', version: '1', reason: null }]), fakeComponent('b', [{ state: 'failed', version: null, reason: 'nope' }])],
      log: createLogger('t'),
    })
    const { routes } = createDevicePreparationRoutes({ db, runner })

    const res = await withUser('admin', routes).request('/dev-1/preparation', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, { state: string }>
    expect(body.a?.state).toBe('ready')
    expect(body.b?.state).toBe('failed')
  })

  test('POST /:id/preparation/:componentId/retry clears exactly that component’s exhausted bound, forced', async () => {
    const db = makeDb()
    seedDevice(db)
    // Exhaust ui-server's bound first, through the runner directly.
    const failure = (): PreparationRunResult => ({ state: 'failed', version: null, reason: 'bad artifact' })
    const exhausting = createPreparationRunner({ db, registry: [fakeComponent('ui-server', [failure(), failure(), failure()])], log: createLogger('t'), retryBackoffS: [0, 0, 0] })
    await exhausting.ensureComponent('dev-1', 'ui-server')
    await exhausting.ensureComponent('dev-1', 'ui-server')
    let status = await exhausting.ensureComponent('dev-1', 'ui-server')
    expect(status.attempts).toBe(3)

    // The retry route, wired to a runner whose component now succeeds.
    const recovered = createPreparationRunner({ db, registry: [fakeComponent('ui-server', [{ state: 'ready', version: '2', reason: null }])], log: createLogger('t') })
    const { routes } = createDevicePreparationRoutes({ db, runner: recovered })
    const res = await withUser('admin', routes).request('/dev-1/preparation/ui-server/retry', { method: 'POST' })
    expect(res.status).toBe(200)
    status = (await res.json()) as typeof status
    expect(status.state).toBe('ready')
    expect(status.attempts).toBe(0)
  })

  test('an unauthenticated caller is refused on the mutating routes', async () => {
    const db = makeDb()
    seedDevice(db)
    const runner = createPreparationRunner({ db, registry: [], log: createLogger('t') })
    const { routes } = createDevicePreparationRoutes({ db, runner })
    const res = await withUser(null, routes).request('/dev-1/preparation', { method: 'POST' })
    expect(res.status).not.toBe(200)
  })

  describe('the guest-agent bridge (plan 106 §5 step 106.5)', () => {
    test('POST /:id/preparation/guest-agent/retry with no bridge wired 404s — it is not a registered component', async () => {
      const db = makeDb()
      seedDevice(db)
      const runner = createPreparationRunner({ db, registry: [], log: createLogger('t') })
      const { routes } = createDevicePreparationRoutes({ db, runner })
      const res = await withUser('admin', routes).request('/dev-1/preparation/guest-agent/retry', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    test('POST /:id/preparation/guest-agent/retry, bridged, runs the guest agent\'s own engine and reads the result back off devices.preparation', async () => {
      const db = makeDb()
      seedDevice(db)
      const runner = createPreparationRunner({ db, registry: [], log: createLogger('t') })
      const calledWith: { current: { deviceId: string; opts: { force?: boolean } | undefined } | null } = { current: null }
      const agentProvisioner = {
        ensure: async (deviceId: string, opts?: { force?: boolean }) => {
          calledWith.current = { deviceId, opts }
          // Mirrors what `agent-provisioner.ts`'s real `writeCached` does — writes
          // straight into `devices.preparation['guest-agent']`, not through `runner`.
          db.update(devices)
            .set({ preparation: { 'guest-agent': { state: 'ready', version: '1.0.0', reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null } } })
            .where(eq(devices.id, deviceId))
            .run()
          return undefined
        },
      }
      const { routes } = createDevicePreparationRoutes({ db, runner, agentProvisioner })
      const res = await withUser('admin', routes).request('/dev-1/preparation/guest-agent/retry', { method: 'POST' })
      expect(res.status).toBe(200)
      const status = (await res.json()) as { state: string }
      expect(status.state).toBe('ready')
      expect(calledWith.current).toEqual({ deviceId: 'dev-1', opts: { force: true } })
    })

    test('POST /:id/preparation (whole-device pass), bridged, includes guest-agent alongside the registered components', async () => {
      const db = makeDb()
      seedDevice(db)
      const runner = createPreparationRunner({ db, registry: [fakeComponent('ui-server', [{ state: 'ready', version: '1', reason: null }])], log: createLogger('t') })
      // Mirrors the real `agent-provisioner.ts`'s `writeCached`: re-reads the
      // row fresh and merges its own key in, so this is robust regardless of
      // which of the two engines happens to run first.
      const agentProvisioner = {
        ensure: async (deviceId: string) => {
          const current = db.select().from(devices).where(eq(devices.id, deviceId)).get()
          const currentPrep = (current?.preparation as Record<string, unknown>) ?? {}
          db.update(devices)
            .set({ preparation: { ...currentPrep, 'guest-agent': { state: 'failed', version: null, reason: 'bad artifact', checkedAt: 1, attempts: 1, nextAttemptAt: null } } })
            .where(eq(devices.id, deviceId))
            .run()
          return undefined
        },
      }
      const { routes } = createDevicePreparationRoutes({ db, runner, agentProvisioner })
      const res = await withUser('admin', routes).request('/dev-1/preparation', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, { state: string }>
      // `runner.ensure()` ran too (its own `ui-server` write), then the response
      // is re-read fresh — the guest-agent write from `agentProvisioner.ensure()`
      // must still be present, not clobbered by `runner`'s own write.
      expect(body['ui-server']?.state).toBe('ready')
      expect(body['guest-agent']?.state).toBe('failed')
    })
  })

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
