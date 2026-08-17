import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { parsePluginWebhookPath } from '@enkaku/protocol'
import type { AuthMode } from '../config'
import { can, type Permission } from './acl'
import type { AuthService, AuthUser } from './service'

export const SESSION_COOKIE = 'enkaku_session'

export type AuthEnv = { Variables: { user: AuthUser } }

/** Routes reachable without logging in (the login page needs them). */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/setup',
  // The single-use enrollment token in the body IS the authentication.
  '/api/nodes/enroll',
])

/**
 * Whether a path is reachable with no session.
 *
 * A `Set` was enough until plan 109 step 109.7: a plugin's inbound webhook
 * lives at `/api/plugins/<plugin>/webhook/<id>`, which is two variables and
 * cannot be a literal. It is public for exactly the reason `/api/nodes/enroll`
 * above is — **the credential is in the request rather than in a session**: an
 * inbound webhook's caller is a third-party system with no farm account, and
 * its per-webhook HMAC signature over the body is the authorisation, verified
 * in constant time before any plugin code runs (`plugins/webhook-routes.ts`).
 * A route that demanded a session here would make the feature impossible, and
 * one that accepted a session INSTEAD of a signature would be a hole.
 *
 * The matcher comes from `@enkaku/protocol`, never a regex written twice: this
 * function and the router must agree about which paths those are, and the way
 * they come to disagree is two people typing the same pattern.
 */
export function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true
  return parsePluginWebhookPath(path) !== null
}

export function authMiddleware(deps: {
  auth: AuthService
  mode: AuthMode
}): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    // Local mode (loopback bind): one implicit admin, no login.
    if (deps.mode === 'local') {
      c.set('user', deps.auth.ensureLocalAdmin())
      return next()
    }

    const path = new URL(c.req.url).pathname
    if (isPublicPath(path)) return next()

    const token = getCookie(c, SESSION_COOKIE) ?? c.req.header('authorization')?.replace(/^Bearer /, '')
    const user = token ? deps.auth.validateSession(token) : null
    if (!user) {
      return c.json(
        {
          error: { code: 'auth.required', message: 'login required' },
          setupNeeded: !deps.auth.hasAnyAdmin(),
        },
        401,
      )
    }
    c.set('user', user)
    await next()
  }
}

/** Per-permission guard (attached to routes needing specific rights). */
export function requirePermission(permission: Permission): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = c.get('user')
    if (!user || !can(user.role, permission)) {
      return c.json({ error: { code: 'auth.forbidden', message: `requires the ${permission} permission` } }, 403)
    }
    await next()
  }
}
