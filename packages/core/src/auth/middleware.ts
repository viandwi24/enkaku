import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { AuthMode } from '../config'
import { can, type Permission } from './acl'
import type { AuthService, AuthUser } from './service'

export const SESSION_COOKIE = 'enkaku_session'

export type AuthEnv = { Variables: { user: AuthUser } }

/** Route yang boleh diakses tanpa login (halaman login butuh ini). */
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/setup'])

export function authMiddleware(deps: {
  auth: AuthService
  mode: AuthMode
}): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    // Mode local (bind loopback): satu admin implisit, tanpa login.
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
          error: { code: 'auth.required', message: 'login dibutuhkan' },
          setupNeeded: !deps.auth.hasAnyAdmin(),
        },
        401,
      )
    }
    c.set('user', user)
    await next()
  }
}

/** Guard per-permission (dipasang di route yang butuh hak khusus). */
export function requirePermission(permission: Permission): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = c.get('user')
    if (!user || !can(user.role, permission)) {
      return c.json({ error: { code: 'auth.forbidden', message: `butuh izin ${permission}` } }, 403)
    }
    await next()
  }
}
