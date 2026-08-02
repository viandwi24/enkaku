import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
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
  '/api/agents/enroll',
])

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
    if (PUBLIC_PATHS.has(path)) return next()

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
