import { Hono, type Context } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AuthMode } from '../config'
import { EnkakuError } from '../util/errors'
import { can } from './acl'
import type { AuditLogger } from './audit'
import { SESSION_COOKIE, type AuthEnv } from './middleware'
import type { AuthService } from './service'

const Credentials = z.object({ email: z.string().email(), password: z.string().min(1) })
const PasswordChange = z.object({ current: z.string().min(1), next: z.string().min(8) })
const NewUser = z.object({ email: z.string().email(), password: z.string().min(8), role: z.enum(['admin', 'operator']) })

const ERROR_STATUS: Record<string, number> = {
  'auth.invalid_credentials': 401,
  'auth.forbidden': 403,
  'auth.email_taken': 409,
  'auth.weak_password': 400,
  'auth.user_not_found': 404,
  'auth.last_admin': 409,
  'auth.setup_done': 409,
  'auth.rate_limited': 429,
}

export function createAuthRoutes(deps: {
  auth: AuthService
  audit: AuditLogger
  mode: AuthMode
  secureCookie: boolean
  maxAttempts: number
  lockoutSeconds: number
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  /** Rate limit login in-memory per ip+email (cukup untuk LAN). */
  const attempts = new Map<string, { count: number; until: number }>()

  const setSessionCookie = (c: Context, token: string, expiresAt: Date) => {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: deps.secureCookie,
      expires: expiresAt,
    })
  }

  app.get('/setup', (c) => c.json({ needed: deps.mode === 'server' && !deps.auth.hasAnyAdmin() }))

  app.post('/setup', async (c) => {
    if (deps.auth.hasAnyAdmin()) throw new EnkakuError('auth.setup_done', 'admin sudah ada')
    const body = Credentials.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('auth.weak_password', 'email & password (min 8) wajib')
    const user = deps.auth.createUser({ ...body.data, role: 'admin' })
    deps.audit.record({ userId: user.id, action: 'user.setup', target: user.email })
    const { token, expiresAt } = deps.auth.createSession(user.id, {})
    setSessionCookie(c, token, expiresAt)
    return c.json({ user }, 201)
  })

  app.post('/login', async (c) => {
    const body = Credentials.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('auth.invalid_credentials', 'email/password tidak valid')
    const ip = c.req.header('x-forwarded-for') ?? 'local'
    const key = `${ip}|${body.data.email}`
    const entry = attempts.get(key)
    if (entry && entry.until > Date.now()) {
      throw new EnkakuError('auth.rate_limited', 'terlalu banyak percobaan — coba lagi nanti')
    }

    const user = await deps.auth.verifyLogin(body.data.email, body.data.password)
    if (!user) {
      const count = (entry?.count ?? 0) + 1
      attempts.set(key, {
        count,
        until: count >= deps.maxAttempts ? Date.now() + deps.lockoutSeconds * 1000 : 0,
      })
      throw new EnkakuError('auth.invalid_credentials', 'email atau password salah')
    }
    attempts.delete(key)
    const { token, expiresAt } = deps.auth.createSession(user.id, {
      ...(c.req.header('user-agent') ? { userAgent: c.req.header('user-agent')! } : {}),
      ip,
    })
    setSessionCookie(c, token, expiresAt)
    deps.audit.record({ userId: user.id, action: 'user.login', target: user.email })
    return c.json({ user })
  })

  app.post('/logout', (c) => {
    const user = c.get('user')
    const token = c.req.header('cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]
    if (token) deps.auth.revokeSession(token)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    if (user) deps.audit.record({ userId: user.id, action: 'user.logout' })
    return c.json({ ok: true })
  })

  app.get('/me', (c) => c.json({ user: c.get('user'), authMode: deps.mode }))

  /** Ticket sekali-pakai untuk upgrade WS. */
  app.post('/ws-ticket', (c) => c.json({ ticket: deps.auth.issueWsTicket(c.get('user').id) }))

  app.post('/password', async (c) => {
    const body = PasswordChange.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('auth.weak_password', 'password baru minimal 8 karakter')
    const user = c.get('user')
    await deps.auth.changePassword(user.id, body.data.current, body.data.next)
    deps.audit.record({ userId: user.id, action: 'user.password_change' })
    return c.json({ ok: true })
  })

  app.get('/users', (c) => {
    if (!can(c.get('user').role, 'user.manage')) throw new EnkakuError('auth.forbidden', 'butuh role admin')
    return c.json({ users: deps.auth.listUsers() })
  })

  app.post('/users', async (c) => {
    if (!can(c.get('user').role, 'user.manage')) throw new EnkakuError('auth.forbidden', 'butuh role admin')
    const body = NewUser.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('auth.weak_password', 'email, password (min 8), role wajib')
    const created = deps.auth.createUser(body.data)
    deps.audit.record({ userId: c.get('user').id, action: 'user.create', target: created.email })
    return c.json({ user: created }, 201)
  })

  app.delete('/users/:id', (c) => {
    if (!can(c.get('user').role, 'user.manage')) throw new EnkakuError('auth.forbidden', 'butuh role admin')
    deps.auth.deleteUser(c.req.param('id'))
    deps.audit.record({ userId: c.get('user').id, action: 'user.delete', target: c.req.param('id') })
    return c.json({ ok: true })
  })

  app.get('/audit', (c) => {
    if (!can(c.get('user').role, 'audit.view')) throw new EnkakuError('auth.forbidden', 'butuh role admin')
    const limit = Number.parseInt(c.req.query('limit') ?? '100', 10) || 100
    return c.json({ entries: deps.audit.list(Math.min(limit, 500)) })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    throw err
  })

  return app
}
