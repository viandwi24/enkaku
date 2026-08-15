import { afterEach, describe, expect, mock, test } from 'bun:test'
import { AuthApiError, describeAuthError, fetchMe, isAdmin, login, logout, setupAdmin } from './auth'

/**
 * The Studio login/setup screens (plan 09 §4.14, the "Studio has no login
 * page" gap) need `/api/auth/*` translated into shapes a form can act on:
 * `fetchMe()` tells the auth gate which of `/login`/`/setup` to show at all,
 * and `login`/`setupAdmin` need their failures to carry the backend's own
 * error CODE (not just a message) so `describeAuthError` can render copy a
 * human can act on regardless of what the wire happened to say.
 */
describe('auth.ts — the /api/auth/* client', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(body: unknown, status = 200): { calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { calls }
  }

  describe('fetchMe()', () => {
    test('200 → authenticated, carrying the user and authMode', async () => {
      stubFetch({ user: { id: 'u1', email: 'a@b.com', role: 'admin' }, authMode: 'server' })
      const result = await fetchMe()
      expect(result).toEqual({
        status: 'authenticated',
        user: { id: 'u1', email: 'a@b.com', role: 'admin' },
        authMode: 'server',
      })
    })

    test('401 with setupNeeded:true → unauthenticated, setupNeeded true (no admin exists yet)', async () => {
      stubFetch({ error: { code: 'auth.required', message: 'login required' }, setupNeeded: true }, 401)
      const result = await fetchMe()
      expect(result).toEqual({ status: 'unauthenticated', setupNeeded: true })
    })

    test('401 with setupNeeded:false → unauthenticated, setupNeeded false (an admin exists, just not signed in)', async () => {
      stubFetch({ error: { code: 'auth.required', message: 'login required' }, setupNeeded: false }, 401)
      const result = await fetchMe()
      expect(result).toEqual({ status: 'unauthenticated', setupNeeded: false })
    })

    test('sends credentials so the session cookie is included even cross-port in dev', async () => {
      const { calls } = stubFetch({ user: { id: 'u1', email: 'a@b.com', role: 'operator' }, authMode: 'server' })
      await fetchMe()
      expect(calls[0]?.init.credentials).toBe('include')
    })
  })

  describe('login() and setupAdmin()', () => {
    test('login(): a 200 resolves with the user', async () => {
      stubFetch({ user: { id: 'u1', email: 'a@b.com', role: 'admin' } })
      const user = await login('a@b.com', 'hunter22')
      expect(user).toEqual({ id: 'u1', email: 'a@b.com', role: 'admin' })
    })

    test('login(): a non-ok response throws AuthApiError carrying the backend CODE', async () => {
      stubFetch({ error: { code: 'auth.invalid_credentials', message: 'wrong email or password' } }, 401)
      let thrown: unknown
      try {
        await login('a@b.com', 'wrong')
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(AuthApiError)
      expect((thrown as AuthApiError).code).toBe('auth.invalid_credentials')
    })

    test('login(): rate limiting surfaces as auth.rate_limited', async () => {
      stubFetch({ error: { code: 'auth.rate_limited', message: 'too many attempts — try again later' } }, 429)
      await expect(login('a@b.com', 'x')).rejects.toMatchObject({ code: 'auth.rate_limited' })
    })

    test('setupAdmin(): posts to /api/auth/setup, not /login', async () => {
      const { calls } = stubFetch({ user: { id: 'u1', email: 'a@b.com', role: 'admin' } }, 201)
      await setupAdmin('a@b.com', 'longenough1')
      expect(calls[0]?.url).toContain('/api/auth/setup')
    })

    test('setupAdmin(): a second call (admin already exists) throws auth.setup_done', async () => {
      stubFetch({ error: { code: 'auth.setup_done', message: 'an admin already exists' } }, 409)
      await expect(setupAdmin('a@b.com', 'longenough1')).rejects.toMatchObject({ code: 'auth.setup_done' })
    })

    test('a non-JSON / network-shaped failure still throws, with the generic "unknown" code', async () => {
      globalThis.fetch = mock(async () => new Response('not json', { status: 500 })) as unknown as typeof fetch
      await expect(login('a@b.com', 'x')).rejects.toMatchObject({ code: 'unknown' })
    })
  })

  describe('logout()', () => {
    test('posts to /api/auth/logout', async () => {
      const { calls } = stubFetch({ ok: true })
      await logout()
      expect(calls[0]?.url).toContain('/api/auth/logout')
      expect(calls[0]?.init.method).toBe('POST')
    })

    test('never throws, even when the request fails outright — the caller re-checks /me either way', async () => {
      globalThis.fetch = mock(async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch
      await expect(logout()).resolves.toBeUndefined()
    })
  })

  describe('describeAuthError()', () => {
    test('maps every code the backend actually sends to actionable English copy', () => {
      expect(describeAuthError('auth.invalid_credentials', 'raw')).not.toBe('raw')
      expect(describeAuthError('auth.rate_limited', 'raw')).not.toBe('raw')
      expect(describeAuthError('auth.weak_password', 'raw')).not.toBe('raw')
      expect(describeAuthError('auth.setup_done', 'raw')).not.toBe('raw')
      expect(describeAuthError('auth.email_taken', 'raw')).not.toBe('raw')
    })

    // The concrete regression this exists for: `POST /api/auth/setup`'s
    // weak-password rejection can come back in Indonesian from the service
    // layer (`packages/core/src/auth/service.ts`'s `createUser`, "password
    // minimal 8 karakter") even though the route's OWN validation message for
    // the same code, on a different path, is in English. Studio must never
    // surface that raw string — it always substitutes its own copy for this code.
    test('auth.weak_password never falls through to the raw backend message', () => {
      expect(describeAuthError('auth.weak_password', 'password minimal 8 karakter')).toBe(
        'Password must be at least 8 characters.',
      )
    })

    test('an unrecognized code falls back to the message the server actually sent', () => {
      expect(describeAuthError('auth.user_not_found', 'no such user')).toBe('no such user')
    })
  })

  /**
   * `isAdmin` is the one role check the admin-only UI gates (Tools,
   * unquarantine) built on this plan use — see its own doc comment in
   * `auth.ts` for why this does not reimplement the full `can()` matrix
   * from `packages/core/src/auth/acl.ts`.
   */
  describe('isAdmin()', () => {
    test('admin: true', () => {
      expect(isAdmin({ id: 'u1', email: 'a@b.com', role: 'admin' })).toBe(true)
    })

    test('operator: false', () => {
      expect(isAdmin({ id: 'u1', email: 'a@b.com', role: 'operator' })).toBe(false)
    })

    test('no user (not yet authenticated): false — the safe default', () => {
      expect(isAdmin(null)).toBe(false)
    })

    // Local mode's implicit admin (`ensureLocalAdmin`, `packages/core/src/auth/service.ts`)
    // always has `role: 'admin'` — this is the fact every admin-only UI gate
    // in Studio relies on to stay unaffected in local mode.
    test("local mode's implicit admin: true", () => {
      expect(isAdmin({ id: 'local-admin', email: 'admin@localhost', role: 'admin' })).toBe(true)
    })
  })
})
