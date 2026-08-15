import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { ShellMode } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { TransferService } from '../device/transfer'
import type { LeaseManager } from '../lease/lease-manager'
import { EnkakuError } from '../util/errors'
import { createTransferRoutes, type TransferRoutesDeps } from './transfer'

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
  return { checkInputAllowed: () => result } as unknown as LeaseManager
}

function fakeTransfer(overrides: Partial<TransferService> = {}): TransferService {
  return {
    install: async () => ({ package: 'com.example', durationMs: 1, output: 'Success' }),
    push: async () => ({ mediaScan: { ran: false, method: null, ms: 0 } }),
    pull: async () => ({ artifactId: 'art-1', bytes: 42 }),
    cancel: () => {},
    ...overrides,
  }
}

function makeApp(opts: {
  role: 'admin' | 'operator' | null
  leaseOk?: boolean
  shellMode?: ShellMode
  transferEnabled?: boolean
  transfer?: TransferService
}): Hono<AuthEnv> {
  const leaseResult = opts.leaseOk === false ? ({ ok: false, code: 'no_lease', message: 'take control first' } as const) : ({ ok: true } as const)
  const deps: TransferRoutesDeps = {
    transfer: opts.transfer ?? fakeTransfer(),
    leases: fakeLeases(leaseResult),
    record: () => {},
    shellSettings: () => ({ mode: opts.shellMode ?? 'admin' }),
    transferSettings: () => ({ enabled: opts.transferEnabled ?? true }),
    broadcast: { progress: () => {}, done: () => {} },
  }
  return withUser(opts.role, createTransferRoutes(deps))
}

const jsonReq = (body: unknown) => ({ method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('POST /api/devices/:id/install (plan 39 §4.4, acceptance #7)', () => {
  test('admin, holding the lease, transfer enabled → 200 with the parsed result', async () => {
    const app = makeApp({ role: 'admin' })
    const res = await app.request('/dev-1/install', jsonReq({ artifactId: 'art-1', clientId: 'client-a' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { package: string | null } }
    expect(body.result.package).toBe('com.example')
  })

  test('transfer.enabled: false refuses even an admin holding the lease', async () => {
    const app = makeApp({ role: 'admin', transferEnabled: false })
    const res = await app.request('/dev-1/install', jsonReq({ artifactId: 'art-1', clientId: 'client-a' }))
    expect(res.status).toBe(403)
  })

  test('an operator is refused when shell.mode is "admin"', async () => {
    const app = makeApp({ role: 'operator', shellMode: 'admin' })
    const res = await app.request('/dev-1/install', jsonReq({ artifactId: 'art-1', clientId: 'client-a' }))
    expect(res.status).toBe(403)
  })

  test('an operator is admitted when shell.mode is "operator"', async () => {
    const app = makeApp({ role: 'operator', shellMode: 'operator' })
    const res = await app.request('/dev-1/install', jsonReq({ artifactId: 'art-1', clientId: 'client-a' }))
    expect(res.status).toBe(200)
  })

  test('no lease held → the leases.checkInputAllowed code/message pass through', async () => {
    const app = makeApp({ role: 'admin', leaseOk: false })
    const res = await app.request('/dev-1/install', jsonReq({ artifactId: 'art-1', clientId: 'client-a' }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('no_lease')
  })

  test('an unauthenticated request is refused', async () => {
    const app = makeApp({ role: null })
    const res = await app.request('/dev-1/install', jsonReq({ artifactId: 'art-1', clientId: 'client-a' }))
    expect(res.status).toBe(403)
  })

  test('a body without artifactId is rejected with 400', async () => {
    const app = makeApp({ role: 'admin' })
    const res = await app.request('/dev-1/install', jsonReq({ clientId: 'client-a' }))
    expect(res.status).toBe(400)
  })

  test('a failed install surfaces the parsed reason and status (acceptance #3)', async () => {
    const app = makeApp({
      role: 'admin',
      transfer: fakeTransfer({
        install: async () => {
          throw new EnkakuError('E_INSTALL_FAILED', 'INSTALL_FAILED_VERSION_DOWNGRADE')
        },
      }),
    })
    const res = await app.request('/dev-1/install', jsonReq({ artifactId: 'art-1', clientId: 'client-a' }))
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.message).toBe('INSTALL_FAILED_VERSION_DOWNGRADE')
  })
})

describe('POST /api/devices/:id/push', () => {
  test('never accepts a URL or filesystem path — only artifactId (acceptance #8)', async () => {
    // The route's Zod body has no `url` or `path` field at all; a caller
    // that tries one is simply ignored by the schema, not forwarded anywhere.
    const app = makeApp({ role: 'admin' })
    const res = await app.request(
      '/dev-1/push',
      jsonReq({ url: 'http://internal.example/secret', artifactId: 'art-1', remotePath: '/data/local/tmp/x', clientId: 'c1' }),
    )
    expect(res.status).toBe(200)
  })

  test('a body without remotePath is rejected with 400', async () => {
    const app = makeApp({ role: 'admin' })
    const res = await app.request('/dev-1/push', jsonReq({ artifactId: 'art-1', clientId: 'c1' }))
    expect(res.status).toBe(400)
  })

  test('the response carries the extended result, including mediaScan (plan 90 §4.6)', async () => {
    const app = makeApp({
      role: 'admin',
      transfer: fakeTransfer({
        push: async () => ({ mediaScan: { ran: true, method: 'scan_file', ms: 12 } }),
      }),
    })
    const res = await app.request(
      '/dev-1/push',
      jsonReq({ artifactId: 'art-1', remotePath: '/sdcard/Pictures/x.jpg', clientId: 'c1' }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { mediaScan: { ran: boolean; method: string | null; ms: number } } }
    expect(body.result.mediaScan).toEqual({ ran: true, method: 'scan_file', ms: 12 })
  })

  test('mediaScan defaults to "auto" and is forwarded to TransferService.push', async () => {
    let seenMediaScan: unknown
    const app = makeApp({
      role: 'admin',
      transfer: fakeTransfer({
        push: async (_deviceId, _artifactId, _remotePath, opts) => {
          seenMediaScan = opts.mediaScan
          return { mediaScan: { ran: false, method: null, ms: 0 } }
        },
      }),
    })
    const res = await app.request('/dev-1/push', jsonReq({ artifactId: 'art-1', remotePath: '/sdcard/x', clientId: 'c1' }))
    expect(res.status).toBe(200)
    expect(seenMediaScan).toBe('auto')
  })

  test('an explicit mediaScan value is forwarded unchanged', async () => {
    let seenMediaScan: unknown
    const app = makeApp({
      role: 'admin',
      transfer: fakeTransfer({
        push: async (_deviceId, _artifactId, _remotePath, opts) => {
          seenMediaScan = opts.mediaScan
          return { mediaScan: { ran: false, method: null, ms: 0 } }
        },
      }),
    })
    const res = await app.request(
      '/dev-1/push',
      jsonReq({ artifactId: 'art-1', remotePath: '/sdcard/x', clientId: 'c1', mediaScan: 'never' }),
    )
    expect(res.status).toBe(200)
    expect(seenMediaScan).toBe('never')
  })
})

describe('POST /api/devices/:id/pull', () => {
  test('admin, holding the lease → 200 with { artifactId, bytes }', async () => {
    const app = makeApp({ role: 'admin' })
    const res = await app.request('/dev-1/pull', jsonReq({ remotePath: '/sdcard/x', clientId: 'c1' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { artifactId: string; bytes: number } }
    expect(body.result).toEqual({ artifactId: 'art-1', bytes: 42 })
  })

  test('a pull above the cap is refused with 413', async () => {
    const app = makeApp({
      role: 'admin',
      transfer: fakeTransfer({
        pull: async () => {
          throw new EnkakuError('E_TRANSFER_TOO_LARGE', 'too large')
        },
      }),
    })
    const res = await app.request('/dev-1/pull', jsonReq({ remotePath: '/sdcard/huge', clientId: 'c1' }))
    expect(res.status).toBe(413)
  })
})
