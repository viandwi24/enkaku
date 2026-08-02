import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { ShellMode } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { LeaseManager } from '../lease/lease-manager'
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

function fakeLeases(result: { ok: true } | { ok: false; code: string; message: string }): LeaseManager {
  return {
    checkInputAllowed: () => result,
  } as unknown as LeaseManager
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
  leaseOk?: boolean
  shellMode?: ShellMode
  endpointEnabled?: boolean
  manager?: AdbEndpointManager
}): Hono<AuthEnv> {
  const leaseResult = opts.leaseOk === false ? ({ ok: false, code: 'no_lease', message: 'take control first' } as const) : ({ ok: true } as const)
  const inner = createAdbEndpointRoutes({
    manager: opts.manager ?? fakeManager(),
    leases: fakeLeases(leaseResult),
    shellSettings: () => ({ mode: opts.shellMode ?? 'admin', endpointEnabled: opts.endpointEnabled ?? true }),
  })
  return withUser(opts.role, inner)
}

describe('POST /api/devices/:id/adb-endpoint (plan 27 §4.3, acceptance #7)', () => {
  test('admin, holding the lease, feature enabled → 200 with host/port/expiresAt/command', async () => {
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

  test('endpointEnabled: false refuses even an admin holding the lease', async () => {
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

  test('no lease held → the leases.checkInputAllowed code/message pass through', async () => {
    const app = makeApp({ role: 'admin', leaseOk: false })
    const res = await app.request('/dev-1/adb-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-a' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('no_lease')
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
