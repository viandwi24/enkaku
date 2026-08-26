import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { apiTokens, users, type ApiTokenRow, type UserRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { AuthUser, Role } from './service'

export interface ApiTokenSummary {
  id: string
  userId: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

export interface ApiTokenService {
  /** Mint a token for `userId`, shown in the clear only once. */
  create(userId: string, label: string, expiresAt?: Date | null): { id: string; token: string } & ApiTokenSummary
  /** Every (revoked and unrevoked) token belonging to `userId`. */
  list(userId: string): ApiTokenSummary[]
  /** Revoke one of `userId`'s own tokens. Refuses `api_token.not_found` on anyone else's row or a missing id. */
  revoke(userId: string, id: string): void
  /**
   * Resolve `Bearer <token>` to the user it was minted for — `null` when the
   * token does not exist, is revoked, or has expired. Never throws.
   */
  validate(token: string): AuthUser | null
}

const sha256 = (s: string): string => new Bun.CryptoHasher('sha256').update(s).digest('hex')

const toSummary = (row: ApiTokenRow): ApiTokenSummary => ({
  id: row.id,
  userId: row.userId,
  label: row.label,
  createdAt: Math.floor((row.createdAt ?? new Date(0)).getTime() / 1000),
  lastUsedAt: row.lastUsedAt ? Math.floor(row.lastUsedAt.getTime() / 1000) : null,
  expiresAt: row.expiresAt ? Math.floor(row.expiresAt.getTime() / 1000) : null,
  revokedAt: row.revokedAt ? Math.floor(row.revokedAt.getTime() / 1000) : null,
})

const toAuthUser = (row: UserRow): AuthUser => ({
  id: row.id,
  email: row.email,
  role: (row.role ?? 'operator') as Role,
})

/**
 * Durable API tokens (plan 130 §3.5, §4.2) — a hashed, named, revocable
 * credential an external agent (or MCP client) can authenticate with,
 * instead of borrowing a human's session cookie.
 *
 * Hashing follows `sessions.tokenHash`'s precedent (`auth/service.ts`'s
 * `createSession`/`validateSession`), not the enrollment token's
 * (`tunnel/node-auth.ts`, `Bun.password`/argon2id): both mint a
 * high-entropy random secret and store only its hash, shown in the clear
 * exactly once — that "plaintext once, hash forever" shape is what this
 * follows. The HASH ALGORITHM differs deliberately: an enrollment token is
 * redeemed once against a small set of `pending` rows, so a slow,
 * salted hash checked in a loop is cheap; an API token is looked up on
 * EVERY authenticated request against a table that can hold many rows, so
 * it needs the same O(1)-by-indexed-hash lookup sessions already use.
 * sha256 is safe here for the same reason it is safe for sessions: the
 * secret being hashed is 256 bits of `crypto.getRandomValues` output, never
 * a human-chosen password, so there is nothing for a fast hash to make
 * brute-forceable.
 */
export function createApiTokenService(db: Db): ApiTokenService {
  const findUser = (id: string): UserRow | null => db.select().from(users).where(eq(users.id, id)).get() ?? null

  return {
    create(userId, label, expiresAt) {
      const raw = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
      const createdAt = new Date()
      const row = {
        id: crypto.randomUUID(),
        userId,
        label,
        tokenHash: sha256(raw),
        createdAt,
        lastUsedAt: null,
        expiresAt: expiresAt ?? null,
        revokedAt: null,
      }
      db.insert(apiTokens).values(row).run()
      return { ...toSummary(row as ApiTokenRow), id: row.id, token: raw }
    },

    list(userId) {
      return db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.userId, userId))
        .all()
        .map(toSummary)
        .sort((a, b) => b.createdAt - a.createdAt)
    },

    revoke(userId, id) {
      const row = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get()
      if (!row || row.userId !== userId) throw new EnkakuError('api_token.not_found', 'no such token')
      if (row.revokedAt) return // already revoked — idempotent
      db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id)).run()
    },

    validate(token) {
      const row = db.select().from(apiTokens).where(eq(apiTokens.tokenHash, sha256(token))).get()
      if (!row) return null
      if (row.revokedAt) return null
      if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null
      const user = findUser(row.userId)
      if (!user) return null
      // Throttle the lastUsedAt update: once a minute is enough (mirrors validateSession).
      if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
        db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)).run()
      }
      return toAuthUser(user)
    },
  }
}
