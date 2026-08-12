import { and, eq, isNotNull, lt } from 'drizzle-orm'
import type { Db } from '../db'
import { sessions, users, type UserRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

export type Role = 'admin' | 'operator'

export interface AuthUser {
  id: string
  email: string
  role: Role
}

export const LOCAL_ADMIN_ID = 'local-admin'

const sha256 = (s: string): string => new Bun.CryptoHasher('sha256').update(s).digest('hex')

const toAuthUser = (row: UserRow): AuthUser => ({
  id: row.id,
  email: row.email,
  role: (row.role ?? 'operator') as Role,
})

export interface AuthService {
  hasAnyAdmin(): boolean
  createUser(input: { email: string; password: string; role: Role }): AuthUser
  listUsers(): AuthUser[]
  deleteUser(userId: string): void
  verifyLogin(email: string, password: string): Promise<AuthUser | null>
  changePassword(userId: string, current: string, next: string): Promise<void>
  createSession(userId: string, meta: { userAgent?: string; ip?: string }): { token: string; expiresAt: Date }
  validateSession(token: string): AuthUser | null
  revokeSession(token: string): void
  revokeAllForUser(userId: string): void
  sweepExpired(): number
  /** Local mode: one implicit admin, no password (loopback bind only). */
  ensureLocalAdmin(): AuthUser
  /** Single-use ticket for the WS upgrade (cookies are not always sent). */
  issueWsTicket(userId: string): string
  consumeWsTicket(ticket: string): AuthUser | null
}

export function createAuthService(deps: { db: Db; sessionTtlHours: number }): AuthService {
  const { db } = deps
  const wsTickets = new Map<string, { userId: string; expiresAt: number }>()

  const findUser = (id: string): UserRow | null => db.select().from(users).where(eq(users.id, id)).get() ?? null

  return {
    hasAnyAdmin() {
      return (
        db
          .select()
          .from(users)
          .where(and(eq(users.role, 'admin'), isNotNull(users.passwordHash)))
          .all().length > 0
      )
    },

    createUser({ email, password, role }) {
      if (password.length < 8) throw new EnkakuError('auth.weak_password', 'password must be at least 8 characters')
      const existing = db.select().from(users).where(eq(users.email, email)).get()
      if (existing) throw new EnkakuError('auth.email_taken', `the email ${email} is already taken`)
      const row = {
        id: crypto.randomUUID(),
        email,
        role,
        passwordHash: Bun.password.hashSync(password, { algorithm: 'argon2id' }),
        createdAt: new Date(),
      }
      db.insert(users).values(row).run()
      return { id: row.id, email, role }
    },

    listUsers() {
      return db.select().from(users).all().map(toAuthUser)
    },

    deleteUser(userId) {
      const row = findUser(userId)
      if (!row) throw new EnkakuError('auth.user_not_found', 'no such user')
      const admins = db.select().from(users).where(eq(users.role, 'admin')).all()
      if (row.role === 'admin' && admins.length <= 1) {
        throw new EnkakuError('auth.last_admin', 'cannot delete the last admin')
      }
      db.delete(sessions).where(eq(sessions.userId, userId)).run()
      db.delete(users).where(eq(users.id, userId)).run()
    },

    async verifyLogin(email, password) {
      const row = db.select().from(users).where(eq(users.email, email)).get()
      if (!row?.passwordHash) return null
      const ok = await Bun.password.verify(password, row.passwordHash)
      return ok ? toAuthUser(row) : null
    },

    async changePassword(userId, current, next) {
      if (next.length < 8) throw new EnkakuError('auth.weak_password', 'password must be at least 8 characters')
      const row = findUser(userId)
      if (!row?.passwordHash) throw new EnkakuError('auth.user_not_found', 'this user has no password')
      if (!(await Bun.password.verify(current, row.passwordHash))) {
        throw new EnkakuError('auth.invalid_credentials', 'the current password is wrong')
      }
      db.update(users)
        .set({ passwordHash: Bun.password.hashSync(next, { algorithm: 'argon2id' }) })
        .where(eq(users.id, userId))
        .run()
      // Changing the password revokes every other session.
      db.delete(sessions).where(eq(sessions.userId, userId)).run()
    },

    createSession(userId, meta) {
      const raw = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
      const expiresAt = new Date(Date.now() + deps.sessionTtlHours * 3600_000)
      db.insert(sessions)
        .values({
          id: crypto.randomUUID(),
          tokenHash: sha256(raw),
          userId,
          createdAt: new Date(),
          expiresAt,
          lastUsedAt: new Date(),
          ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
          ...(meta.ip ? { ip: meta.ip } : {}),
        })
        .run()
      return { token: raw, expiresAt }
    },

    validateSession(token) {
      const row = db.select().from(sessions).where(eq(sessions.tokenHash, sha256(token))).get()
      if (!row) return null
      if (row.expiresAt.getTime() < Date.now()) {
        db.delete(sessions).where(eq(sessions.id, row.id)).run()
        return null
      }
      const user = findUser(row.userId)
      if (!user) return null
      // Throttle the lastUsedAt update: once a minute is enough.
      if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
        db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, row.id)).run()
      }
      return toAuthUser(user)
    },

    revokeSession(token) {
      db.delete(sessions).where(eq(sessions.tokenHash, sha256(token))).run()
    },

    revokeAllForUser(userId) {
      db.delete(sessions).where(eq(sessions.userId, userId)).run()
    },

    sweepExpired() {
      const before = db.select().from(sessions).all().length
      db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run()
      return before - db.select().from(sessions).all().length
    },

    ensureLocalAdmin() {
      const existing = findUser(LOCAL_ADMIN_ID)
      if (existing) return toAuthUser(existing)
      const row = {
        id: LOCAL_ADMIN_ID,
        email: 'admin@localhost',
        role: 'admin' as const,
        passwordHash: null,
        createdAt: new Date(),
      }
      db.insert(users).values(row).run()
      return { id: row.id, email: row.email, role: row.role }
    },

    issueWsTicket(userId) {
      const ticket = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')
      wsTickets.set(sha256(ticket), { userId, expiresAt: Date.now() + 60_000 })
      return ticket
    },

    consumeWsTicket(ticket) {
      const key = sha256(ticket)
      const entry = wsTickets.get(key)
      if (!entry) return null
      wsTickets.delete(key) // single use
      if (entry.expiresAt < Date.now()) return null
      const user = findUser(entry.userId)
      return user ? toAuthUser(user) : null
    },
  }
}
