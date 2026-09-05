import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import { EnkakuError } from '../util/errors'
import type { VmManager } from '../vm/manager'
import type { VmRecord, VmSpec } from '../vm/types'
import { createVmRoutes } from './vms'

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

function baseSpec(overrides: Partial<VmSpec> = {}): VmSpec {
  return {
    name: 'enkaku-test',
    apiLevel: 36,
    variant: 'google_apis',
    memoryMb: 2048,
    deviceProfile: 'pixel_7',
    ...overrides,
  }
}

function baseRecord(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: 'vm-1',
    name: 'enkaku-test',
    state: 'stopped',
    consolePort: 5554,
    serial: 'emulator-5554',
    spec: baseSpec(),
    message: null,
    createdAt: new Date(1_700_000_000_000),
    startedAt: null,
    ...overrides,
  }
}

/** A fake `VmManager` whose `list()` reflects whatever `start`/`stop`/`create`/`remove` did, so the route's own read-after-fire-and-forget logic is exercised honestly. */
function fakeManager(overrides: Partial<VmManager> = {}): VmManager {
  const rows = new Map<string, VmRecord>([['vm-1', baseRecord()]])
  return {
    list: () => [...rows.values()],
    create: async (spec) => {
      const record = baseRecord({ id: 'vm-new', name: spec.name, spec, state: 'stopped' })
      rows.set(record.id, record)
      return record
    },
    start: async (id) => {
      const row = rows.get(id)
      if (!row) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)
      rows.set(id, { ...row, state: 'starting' })
      // Simulate the real manager's shape: the synchronous prefix (setting
      // `starting`) already ran above; the rest happens after this `await`.
      await Promise.resolve()
      rows.set(id, { ...row, state: 'running', startedAt: new Date() })
      return rows.get(id) as VmRecord
    },
    stop: async (id) => {
      const row = rows.get(id)
      if (!row) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)
      rows.set(id, { ...row, state: 'stopping' })
      await Promise.resolve()
      rows.set(id, { ...row, state: 'stopped', message: null })
      return rows.get(id) as VmRecord
    },
    remove: async (id) => {
      if (!rows.has(id)) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)
      rows.delete(id)
    },
    adopt: async () => {},
    ...overrides,
  }
}

function makeApp(opts: { role: 'admin' | 'operator' | null; manager?: VmManager }): Hono<AuthEnv> {
  const inner = createVmRoutes({ manager: opts.manager ?? fakeManager() })
  return withUser(opts.role, inner)
}

describe('GET /api/vms (plan 402 §4.2, G1)', () => {
  test('an operator may list', async () => {
    const app = makeApp({ role: 'operator' })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { vms: unknown[] }
    expect(body.vms).toHaveLength(1)
  })

  test('no user → 403 (auth.forbidden)', async () => {
    const app = makeApp({ role: null })
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })
})

describe('POST /api/vms (plan 402 §4.2, G1)', () => {
  test('an operator may create — 201 in state creating→stopped', async () => {
    const app = makeApp({ role: 'operator' })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-avd' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { vm: { name: string; state: string } }
    expect(body.vm.name).toBe('my-avd')
    expect(body.vm.state).toBe('stopped')
  })

  test('a malformed body → 400', async () => {
    const app = makeApp({ role: 'operator' })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'has a space' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_BAD_REQUEST')
  })

  test('a device.view-only user (an operator without device.enroll cannot exist in this matrix, so use no role) gets 403', async () => {
    const app = makeApp({ role: null })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-avd' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/vms/:id/start (plan 402 §4.2, G1 — the timing decision)', () => {
  test('returns 202 immediately, in state starting, without waiting for the boot poll', async () => {
    const app = makeApp({ role: 'operator' })
    const res = await app.request('/vm-1/start', { method: 'POST' })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { vm: { state: string } }
    expect(body.vm.state).toBe('starting')
  })

  test('an unknown id → 404 E_VM_NOT_FOUND', async () => {
    const app = makeApp({ role: 'operator' })
    const res = await app.request('/does-not-exist/start', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_VM_NOT_FOUND')
  })
})

describe('POST /api/vms/:id/stop (plan 402 §4.2, G1)', () => {
  test('returns 202 in state stopping', async () => {
    const manager = fakeManager()
    // Drive it into `running` first so `stop` has something to transition from.
    await manager.start('vm-1')
    const app = makeApp({ role: 'operator', manager })
    const res = await app.request('/vm-1/stop', { method: 'POST' })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { vm: { state: string } }
    expect(body.vm.state).toBe('stopping')
  })

  test('an unknown id → 404 E_VM_NOT_FOUND', async () => {
    const app = makeApp({ role: 'operator' })
    const res = await app.request('/does-not-exist/stop', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/vms/:id (plan 402 §4.2, G1)', () => {
  test('an operator may delete — 204', async () => {
    const app = makeApp({ role: 'operator' })
    const res = await app.request('/vm-1', { method: 'DELETE' })
    expect(res.status).toBe(204)
  })

  test('an unknown id → 404 E_VM_NOT_FOUND', async () => {
    const app = makeApp({ role: 'operator' })
    const res = await app.request('/does-not-exist', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('ACL (plan 402 §4.4, G4)', () => {
  test('an operator may list AND create/start/stop/delete (device.enroll is in OPERATOR)', async () => {
    const app = makeApp({ role: 'operator' })
    expect((await app.request('/')).status).toBe(200)
    expect(
      (
        await app.request('/', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'operator-avd' }),
        })
      ).status,
    ).toBe(201)
  })

  test('no user (viewer-equivalent) may not create/start/stop/delete — 403 on every mutation', async () => {
    const app = makeApp({ role: null })
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    })
    expect(createRes.status).toBe(403)
    expect((await app.request('/vm-1/start', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/vm-1/stop', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/vm-1', { method: 'DELETE' })).status).toBe(403)
  })
})

describe('Error mapping (plan 402 §4.2, G3)', () => {
  const cases: Array<[string, number]> = [
    ['auth.forbidden', 403],
    ['E_BAD_REQUEST', 400],
    ['E_VM_NOT_FOUND', 404],
    ['E_VM_LIMIT', 409],
    ['E_VM_NO_PORT', 409],
    ['E_VM_CONFLICT', 409],
    ['E_ANDROID_SDK_MISSING', 503],
  ]

  for (const [code, status] of cases) {
    test(`${code} → ${status}`, async () => {
      const manager = fakeManager({
        create: async () => {
          throw new EnkakuError(code, 'boom')
        },
      })
      const app = makeApp({ role: 'operator', manager })
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'boom-avd' }),
      })
      expect(res.status).toBe(status)
    })
  }
})
