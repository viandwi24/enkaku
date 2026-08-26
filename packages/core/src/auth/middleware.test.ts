import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { authMiddleware, type AuthEnv } from './middleware'
import type { ApiTokenService } from './api-tokens'
import type { AuthService, AuthUser } from './service'

/**
 * Durable API tokens (plan 130 §3.5, §3.6) — the new lookup must be
 * strictly additive: it only runs after both the session cookie and the
 * session-bearer lookup miss, and session auth must be byte-for-byte
 * unchanged when no `apiTokens` dep (or no matching token) is present.
 */

const SESSION_USER: AuthUser = { id: 'user-session', email: 'session@example.com', role: 'operator' }
const TOKEN_USER: AuthUser = { id: 'user-token', email: 'token@example.com', role: 'admin' }

function fakeAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    hasAnyAdmin: () => true,
    createUser: () => {
      throw new Error('not used')
    },
    listUsers: () => [],
    deleteUser: () => {},
    verifyLogin: async () => null,
    changePassword: async () => {},
    createSession: () => ({ token: 'irrelevant', expiresAt: new Date() }),
    validateSession: (token) => (token === 'valid-session' ? SESSION_USER : null),
    revokeSession: () => {},
    revokeAllForUser: () => {},
    sweepExpired: () => 0,
    ensureLocalAdmin: (): AuthUser => ({ id: 'local-admin', email: 'admin@localhost', role: 'admin' }),
    issueWsTicket: () => 'ticket',
    consumeWsTicket: () => null,
    ...overrides,
  }
}

function fakeApiTokens(overrides: Partial<ApiTokenService> = {}): ApiTokenService & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    create: () => {
      throw new Error('not used')
    },
    list: () => [],
    revoke: () => {},
    validate: (token) => {
      calls.push(token)
      return token === 'valid-api-token' ? TOKEN_USER : null
    },
    ...overrides,
  }
}

function buildApp(deps: Parameters<typeof authMiddleware>[0]) {
  const app = new Hono<AuthEnv>()
  app.use('*', authMiddleware(deps))
  app.get('/whoami', (c) => c.json({ user: c.get('user') }))
  return app
}

async function whoami(app: Hono<AuthEnv>, headers: Record<string, string> = {}) {
  const res = await app.request('/whoami', { headers })
  return { status: res.status, body: (await res.json()) as { user?: AuthUser; error?: { code: string } } }
}

describe('authMiddleware — session auth is unchanged with no api token present', () => {
  test('a valid session bearer authenticates, with no apiTokens dep at all', async () => {
    const app = buildApp({ auth: fakeAuth(), mode: 'server' })
    const { status, body } = await whoami(app, { authorization: 'Bearer valid-session' })
    expect(status).toBe(200)
    expect(body.user).toEqual(SESSION_USER)
  })

  test('an invalid bearer is refused exactly as before, with no apiTokens dep', async () => {
    const app = buildApp({ auth: fakeAuth(), mode: 'server' })
    const { status, body } = await whoami(app, { authorization: 'Bearer garbage' })
    expect(status).toBe(401)
    expect(body.error?.code).toBe('auth.required')
  })

  test('a valid session bearer authenticates even when apiTokens IS configured — and the token lookup is never reached', async () => {
    const apiTokens = fakeApiTokens()
    const app = buildApp({ auth: fakeAuth(), mode: 'server', apiTokens })
    const { status, body } = await whoami(app, { authorization: 'Bearer valid-session' })
    expect(status).toBe(200)
    expect(body.user).toEqual(SESSION_USER)
    // The session lookup already succeeded — apiTokens.validate must not be consulted.
    expect(apiTokens.calls).toHaveLength(0)
  })

  test('local mode bypasses both lookups regardless of apiTokens', async () => {
    const app = buildApp({ auth: fakeAuth(), mode: 'local', apiTokens: fakeApiTokens() })
    const { status, body } = await whoami(app)
    expect(status).toBe(200)
    expect(body.user?.id).toBe('local-admin')
  })
})

describe('authMiddleware — the api-token lookup runs only after the session lookup misses', () => {
  test('a valid API token authenticates as its user when there is no session', async () => {
    const app = buildApp({ auth: fakeAuth(), mode: 'server', apiTokens: fakeApiTokens() })
    const { status, body } = await whoami(app, { authorization: 'Bearer valid-api-token' })
    expect(status).toBe(200)
    expect(body.user).toEqual(TOKEN_USER)
  })

  test('a revoked/unknown token (validate() -> null) is refused, same 401 shape as a bad session', async () => {
    const app = buildApp({ auth: fakeAuth(), mode: 'server', apiTokens: fakeApiTokens() })
    const { status, body } = await whoami(app, { authorization: 'Bearer not-a-real-token' })
    expect(status).toBe(401)
    expect(body.error?.code).toBe('auth.required')
  })

  test('the token path really is wired in — proven by breaking apiTokens.validate, confirming the failure, then restoring it', async () => {
    // Break it: apiTokens.validate always throws.
    const brokenApiTokens = fakeApiTokens({
      validate: () => {
        throw new Error('boom')
      },
    })
    const app = buildApp({ auth: fakeAuth(), mode: 'server', apiTokens: brokenApiTokens })
    // Hono's default error handling turns the thrown error into a plain-text
    // 500 (not JSON) rather than rejecting `fetch` — confirming the token
    // lookup really executes, so `whoami`'s `.json()` parse is skipped here.
    const brokenRes = await app.request('/whoami', { headers: { authorization: 'Bearer whatever' } })
    expect(brokenRes.status).toBe(500)

    // Restore: the same request with a working apiTokens still resolves via the token path.
    const workingApp = buildApp({ auth: fakeAuth(), mode: 'server', apiTokens: fakeApiTokens() })
    const { status } = await whoami(workingApp, { authorization: 'Bearer valid-api-token' })
    expect(status).toBe(200)
  })
})
