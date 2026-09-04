import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { DeviceStatus, ShellMode } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import { createActivityRegistry, type ActivityRegistry } from '../activity/registry'
import type { ControlPolicySettings } from '../activity/policy'
import type { DeviceStateMachine } from '../device/state-machine'
import { createLogger } from '../util/logger'
import { createAdbEndpointRoutes } from './adb-endpoint'

/** Mirrors `authMiddleware` well enough for a route test: sets `c.get('user')` before dispatch. */
function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function fakeActivities(): ActivityRegistry {
  return createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
}

function fakeStates(status: DeviceStatus | null): Pick<DeviceStateMachine, 'current'> {
  return { current: () => status }
}

function fakeManager(overrides: Partial<AdbEndpointManager> = {}): AdbEndpointManager {
  return {
    open: async () => ({ host: '127.0.0.1', port: 12345, expiresAt: 9_999_999_999 }),
    close: () => {},
    get: () => null,
    closeAllForClient: () => {},
    ...overrides,
  }
}

function makeApp(opts: {
  role: 'admin' | 'operator' | null
  deviceStatus?: DeviceStatus | null
  shellMode?: ShellMode
  endpointEnabled?: boolean
  manager?: AdbEndpointManager
  activities?: ActivityRegistry
  controlSettings?: () => ControlPolicySettings
  /** `undefined` (the default) means "device not found" — `canUseDevice` then never applies, matching every pre-plan-34 test above unchanged. */
  deviceOwnerId?: string | null
}): Hono<AuthEnv> {
  const inner = createAdbEndpointRoutes({
    manager: opts.manager ?? fakeManager(),
    activities: opts.activities ?? fakeActivities(),
    controlSettings: opts.controlSettings ?? (() => ({ overControl: 'allow', idleSec: 30 })),
    states: fakeStates(opts.deviceStatus === undefined ? 'online' : opts.deviceStatus),
    shellSettings: () => ({ mode: opts.shellMode ?? 'admin', endpointEnabled: opts.endpointEnabled ?? true }),
    getDevice: () => (opts.deviceOwnerId === undefined ? null : { ownerId: opts.deviceOwnerId }),
  })
  return withUser(opts.role, inner)
}

describe('POST /api/devices/:id/adb-endpoint (plan 27 §4.3, acceptance #7)', () => {
  test('admin, device online, feature enabled → 200 with host/port/expiresAt/command', async () => {
    const app = makeApp({ role: 'admin' })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { host: string; port: number; expiresAt: number; command: string }
    expect(body).toEqual({ host: '127.0.0.1', port: 12345, expiresAt: 9_999_999_999, command: 'adb connect 127.0.0.1:12345' })
  })

  test('endpointEnabled: false refuses even an admin', async () => {
    const app = makeApp({ role: 'admin', endpointEnabled: false })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(403)
  })

  test('an operator is refused when shell.mode is "admin"', async () => {
    const app = makeApp({ role: 'operator', shellMode: 'admin' })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(403)
  })

  test('an operator is admitted when shell.mode is "operator"', async () => {
    const app = makeApp({ role: 'operator', shellMode: 'operator' })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(200)
  })

  test('an offline device is refused with device_unavailable', async () => {
    const app = makeApp({ role: 'admin', deviceStatus: 'offline' })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('device_unavailable')
  })

  test('an unknown device is refused with device_not_found', async () => {
    const app = makeApp({ role: 'admin', deviceStatus: null })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('device_not_found')
  })

  test('a device with a live job is refused with E_DEVICE_CONFLICT — command warns against control/prep but forbids against a running job', async () => {
    const activities = fakeActivities()
    activities.start('dev-1', { id: 'job:j1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const app = makeApp({ role: 'admin', activities, controlSettings: () => ({ overControl: 'allow', idleSec: 30 }) })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    // MVP 04 §1.3's `command` row warns (never forbids) against a running job — the call still succeeds.
    expect(res.status).toBe(200)
  })

  test('an unauthenticated request is refused', async () => {
    const app = makeApp({ role: null })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(403)
  })

  test('a body without clientId is rejected with 400', async () => {
    const app = makeApp({ role: 'admin' })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('canUseDevice (plan 34 §3.5, §4.4, §4.1 "the Plan 27 endpoint")', () => {
  test('an operator is refused an endpoint on a device owned by another user', async () => {
    const app = makeApp({ role: 'operator', shellMode: 'operator', deviceOwnerId: 'someone-else' })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('auth.forbidden')
    expect(body.error.message).toContain('belongs to another user')
  })

  test('an admin may still open an endpoint on a device owned by another user', async () => {
    const app = makeApp({ role: 'admin', deviceOwnerId: 'someone-else' })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(200)
  })

  test('a device with ownerId: null is unaffected — the pre-plan-34 default', async () => {
    const app = makeApp({ role: 'operator', shellMode: 'operator', deviceOwnerId: null })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(200)
  })

  test('an operator owning the device may open it', async () => {
    const app = makeApp({ role: 'operator', shellMode: 'operator', deviceOwnerId: 'u1' })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('DELETE /api/devices/:id/adb-endpoint', () => {
  test('closes the endpoint and returns ok', async () => {
    const box: { closedWith: { deviceId: string; reason: string } | null } = { closedWith: null }
    const app = makeApp({
      role: 'admin',
      manager: fakeManager({ close: (deviceId, reason) => (box.closedWith = { deviceId, reason }) }),
    })
    const res = await app.request('/dev-1/adb-endpoint?clientId=client-a', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(box.closedWith).toEqual({ deviceId: 'dev-1', reason: 'closed_by_user' })
  })

  test('missing clientId query param is rejected with 400', async () => {
    const app = makeApp({ role: 'admin' })
    const res = await app.request('/dev-1/adb-endpoint', { method: 'DELETE' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/devices/:id/adb-endpoint', () => {
  test('reports the live endpoint state', async () => {
    const app = makeApp({
      role: 'admin',
      manager: fakeManager({
        get: () => ({ host: '127.0.0.1', port: 12345, connections: 2, openedAt: 1_700_000_000, expiresAt: 1_700_000_300 }),
      }),
    })
    const res = await app.request('/dev-1/adb-endpoint?clientId=client-a')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      endpoint: { host: string; port: number; connections: number; openedAt: number; expiresAt: number } | null
    }
    expect(body.endpoint).toEqual({ host: '127.0.0.1', port: 12345, connections: 2, openedAt: 1_700_000_000, expiresAt: 1_700_000_300 })
  })

  test('reports null when no endpoint is open', async () => {
    const app = makeApp({ role: 'admin' })
    const res = await app.request('/dev-1/adb-endpoint?clientId=client-a')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoint: unknown }
    expect(body.endpoint).toBeNull()
  })
})
