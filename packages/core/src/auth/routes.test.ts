import { describe, expect, test } from 'bun:test'
import { createAuthRoutes } from './routes'
import type { AuthService, AuthUser } from './service'
import type { AuditLogger } from './audit'

/**
 * Login rate limiting used to key on `X-Forwarded-For` unconditionally
 * (docs/plans/87-m52-mvp-release-readiness.md §4.9, finding S7): a caller
 * reaching the core directly could set that header to a fresh value on
 * every request and never trip the lockout. It now defaults to the verified
 * socket peer address (via Bun's `server.requestIP`, threaded in as Hono's
 * `env`) and only trusts the header when `trustProxy` is explicitly on —
 * exercised below for both configurations.
 */

function fakeAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    hasAnyAdmin: () => true,
    createUser: () => {
      throw new Error('not used in this test')
    },
    listUsers: () => [],
    deleteUser: () => {},
    verifyLogin: async () => null,
    changePassword: async () => {},
    createSession: () => ({ token: 'session-token', expiresAt: new Date(Date.now() + 3600_000) }),
    validateSession: () => null,
    revokeSession: () => {},
    revokeAllForUser: () => {},
    sweepExpired: () => 0,
    ensureLocalAdmin: (): AuthUser => ({ id: 'local-admin', email: 'admin@localhost', role: 'admin' }),
    issueWsTicket: () => 'ticket',
    consumeWsTicket: () => null,
    ...overrides,
  }
}

function fakeAudit(): AuditLogger {
  return { record: () => {}, list: () => [] }
}

/** A minimal stand-in for the `Bun.Server` `daemon.ts` hands to `app.fetch` as Hono's `env`. */
function bunServer(address: string): { requestIP: (req: Request) => { address: string } | null } {
  return { requestIP: () => ({ address }) }
}

function buildApp(opts: { trustProxy?: boolean; maxAttempts?: number; lockoutSeconds?: number } = {}) {
  return createAuthRoutes({
    auth: fakeAuth(),
    audit: fakeAudit(),
    mode: 'server',
    secureCookie: false,
    maxAttempts: opts.maxAttempts ?? 3,
    lockoutSeconds: opts.lockoutSeconds ?? 300,
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
  })
}

function loginInit(email: string, xForwardedFor?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(xForwardedFor ? { 'x-forwarded-for': xForwardedFor } : {}),
    },
    body: JSON.stringify({ email, password: 'wrong-password' }),
  }
}

async function statusOf(res: Response): Promise<{ status: number; code: unknown }> {
  const body = (await res.json()) as { error?: { code?: string } }
  return { status: res.status, code: body.error?.code }
}

describe('POST /login rate limiting (trustProxy: false, the default)', () => {
  test('a spoofed X-Forwarded-For cannot evade the lockout — the real peer is what counts', async () => {
    const app = buildApp({ trustProxy: false, maxAttempts: 3 })
    const peer = bunServer('203.0.113.9')

    // Three failed attempts, each with a DIFFERENT spoofed X-Forwarded-For —
    // if the header were still trusted, none of these would ever compound.
    for (const spoofedIp of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      const res = await app.request('/login', loginInit('a@b.com', spoofedIp), peer)
      expect((await statusOf(res)).status).toBe(401)
    }

    // A fourth attempt, with yet another fresh spoofed value, is still locked
    // out: the counter tracked the real (unspoofable) peer address.
    const locked = await statusOf(await app.request('/login', loginInit('a@b.com', '10.0.0.99'), peer))
    expect(locked.status).toBe(429)
    expect(locked.code).toBe('auth.rate_limited')
  })

  test('X-Forwarded-For is ignored entirely — no header at all still locks out the same peer', async () => {
    const app = buildApp({ trustProxy: false, maxAttempts: 2 })
    const peer = bunServer('203.0.113.10')

    await app.request('/login', loginInit('a@b.com'), peer)
    await app.request('/login', loginInit('a@b.com'), peer)
    const locked = await statusOf(await app.request('/login', loginInit('a@b.com'), peer))
    expect(locked.status).toBe(429)
  })

  test('a different real peer is unaffected by another peer being locked out', async () => {
    const app = buildApp({ trustProxy: false, maxAttempts: 1 })
    const peerA = bunServer('203.0.113.1')
    const peerB = bunServer('203.0.113.2')

    await app.request('/login', loginInit('a@b.com'), peerA)
    const aLocked = await statusOf(await app.request('/login', loginInit('a@b.com'), peerA))
    expect(aLocked.status).toBe(429)

    // Same email, genuinely different socket peer — must not share the bucket.
    const bStillTrying = await statusOf(await app.request('/login', loginInit('a@b.com'), peerB))
    expect(bStillTrying.status).toBe(401)
  })
})

describe('POST /login rate limiting (trustProxy: true, behind a documented reverse proxy)', () => {
  test('rate limits per real client (the rightmost X-Forwarded-For hop), not lumped together by the shared proxy peer', async () => {
    const app = buildApp({ trustProxy: true, maxAttempts: 1 })
    // Every request in this test arrives from the SAME socket peer — the
    // reverse proxy itself — the way it would for every real user in a
    // proxied deployment. If the limiter fell back to the peer address here,
    // one bad actor would lock out every other user sharing the proxy.
    const proxyPeer = bunServer('10.0.0.1')
    const clientA = '198.51.100.10'
    const clientB = '198.51.100.20'

    await app.request('/login', loginInit('a@b.com', clientA), proxyPeer)
    const aLocked = await statusOf(await app.request('/login', loginInit('a@b.com', clientA), proxyPeer))
    expect(aLocked.status).toBe(429)

    // A different real client behind the very same proxy is untouched.
    const bStillTrying = await statusOf(await app.request('/login', loginInit('a@b.com', clientB), proxyPeer))
    expect(bStillTrying.status).toBe(401)
  })

  test('takes the rightmost hop of a multi-hop chain, not the leftmost client-controlled one', async () => {
    const app = buildApp({ trustProxy: true, maxAttempts: 1 })
    const proxyPeer = bunServer('10.0.0.1')

    // The leftmost entry is whatever the client sent before ever reaching
    // the proxy — attacker-controlled, changed on every request below — but
    // the proxy always appends the same real address as the last hop.
    await app.request('/login', loginInit('a@b.com', 'evil-spoof-one, 203.0.113.50'), proxyPeer)
    const stillLocked = await statusOf(
      await app.request('/login', loginInit('a@b.com', 'totally-different-spoof-two, 203.0.113.50'), proxyPeer),
    )
    expect(stillLocked.status).toBe(429)
  })

  test('falls back to the verified peer when X-Forwarded-For is absent, even with trustProxy on', async () => {
    const app = buildApp({ trustProxy: true, maxAttempts: 1 })
    const peer = bunServer('203.0.113.77')

    await app.request('/login', loginInit('a@b.com'), peer)
    const locked = await statusOf(await app.request('/login', loginInit('a@b.com'), peer))
    expect(locked.status).toBe(429)
  })
})

describe('POST /login success clears the counter', () => {
  test('a correct login resets the failure count for that peer+email', async () => {
    const auth = fakeAuth({
      verifyLogin: async (email, password) => (password === 'right' ? { id: 'u1', email, role: 'operator' } : null),
    })
    const app = createAuthRoutes({
      auth,
      audit: fakeAudit(),
      mode: 'server',
      secureCookie: false,
      maxAttempts: 2,
      lockoutSeconds: 300,
      trustProxy: false,
    })
    const peer = bunServer('203.0.113.30')

    await app.request('/login', loginInit('a@b.com'), peer) // 1 failure
    const ok = await app.request(
      '/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', password: 'right' }),
      },
      peer,
    )
    expect(ok.status).toBe(200)

    // Back to a clean slate — one more failure should not lock out yet
    // (maxAttempts is 2), proving the successful login reset the counter.
    const afterSuccess = await statusOf(await app.request('/login', loginInit('a@b.com'), peer))
    expect(afterSuccess.status).toBe(401)
  })
})
