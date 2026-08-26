import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { apiTokens, users } from '../db/schema'
import { createApiTokenService } from './api-tokens'

function setUp(): { db: Db; userId: string; otherUserId: string } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const userId = crypto.randomUUID()
  const otherUserId = crypto.randomUUID()
  opened.db
    .insert(users)
    .values([
      { id: userId, email: 'agent-owner@example.com', role: 'admin', createdAt: new Date() },
      { id: otherUserId, email: 'someone-else@example.com', role: 'admin', createdAt: new Date() },
    ])
    .run()
  return { db: opened.db, userId, otherUserId }
}

describe('ApiTokenService', () => {
  test('a valid token resolves to the user it was minted for', () => {
    const { db, userId } = setUp()
    const svc = createApiTokenService(db)
    const created = svc.create(userId, 'ci runner')

    const resolved = svc.validate(created.token)
    expect(resolved).not.toBeNull()
    expect(resolved?.id).toBe(userId)
    expect(resolved?.email).toBe('agent-owner@example.com')
    expect(resolved?.role).toBe('admin')
  })

  test('only a hash is stored — the plaintext is never written to the row', () => {
    const { db, userId } = setUp()
    const svc = createApiTokenService(db)
    const created = svc.create(userId, 'ci runner')

    const row = db.select().from(apiTokens).where(eq(apiTokens.id, created.id)).get()
    expect(row).toBeTruthy()
    expect(row?.tokenHash).not.toBe(created.token)
    // The plaintext must not appear anywhere in the stored row, hash included.
    expect(JSON.stringify(row)).not.toContain(created.token)
  })

  test('the plaintext is returned exactly once — list() never carries it', () => {
    const { db, userId } = setUp()
    const svc = createApiTokenService(db)
    svc.create(userId, 'ci runner')

    const listed = svc.list(userId)
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('token')
    expect(listed[0]).not.toHaveProperty('tokenHash')
  })

  test('a revoked token is refused — broken, confirmed, then the guard is proven by restoring an unrevoked one', () => {
    const { db, userId } = setUp()
    const svc = createApiTokenService(db)
    const created = svc.create(userId, 'to be revoked')

    // Sanity: works before revocation.
    expect(svc.validate(created.token)).not.toBeNull()

    svc.revoke(userId, created.id)
    expect(svc.validate(created.token)).toBeNull()

    // Restore: an unrevoked sibling token for the same user still works,
    // proving the refusal above was the revocation and not something broader
    // (e.g. the user itself, or hashing) breaking.
    const other = svc.create(userId, 'still good')
    expect(svc.validate(other.token)).not.toBeNull()
  })

  test('revoking is idempotent and revoking a nonexistent id refuses', () => {
    const { db, userId } = setUp()
    const svc = createApiTokenService(db)
    const created = svc.create(userId, 'x')
    svc.revoke(userId, created.id)
    // Second revoke of the same (already-revoked) token does not throw.
    expect(() => svc.revoke(userId, created.id)).not.toThrow()
    expect(() => svc.revoke(userId, 'does-not-exist')).toThrow()
  })

  test("revoking someone else's token refuses rather than silently succeeding", () => {
    const { db, userId, otherUserId } = setUp()
    const svc = createApiTokenService(db)
    const created = svc.create(userId, 'mine')
    expect(() => svc.revoke(otherUserId, created.id)).toThrow()
    // Still valid — the other user's attempt did not revoke it.
    expect(svc.validate(created.token)).not.toBeNull()
  })

  test('an expired token is refused — broken, confirmed, then restored with a future expiry', () => {
    const { db, userId } = setUp()
    const svc = createApiTokenService(db)
    const expired = svc.create(userId, 'expired', new Date(Date.now() - 1000))
    expect(svc.validate(expired.token)).toBeNull()

    // Restore: the same shape with a future expiry works, proving the
    // refusal above was specifically the expiry check.
    const notExpired = svc.create(userId, 'not expired', new Date(Date.now() + 3600_000))
    expect(svc.validate(notExpired.token)).not.toBeNull()
  })

  test('a token with no expiry never expires', () => {
    const { db, userId } = setUp()
    const svc = createApiTokenService(db)
    const created = svc.create(userId, 'forever', null)
    expect(svc.validate(created.token)).not.toBeNull()
    const row = db.select().from(apiTokens).where(eq(apiTokens.id, created.id)).get()
    expect(row?.expiresAt).toBeNull()
  })

  test('an unknown token resolves to null', () => {
    const { db } = setUp()
    const svc = createApiTokenService(db)
    expect(svc.validate('not-a-real-token')).toBeNull()
  })

  test('list() is scoped to the caller — another user’s tokens are invisible', () => {
    const { db, userId, otherUserId } = setUp()
    const svc = createApiTokenService(db)
    svc.create(userId, 'mine')
    svc.create(otherUserId, 'theirs')
    expect(svc.list(userId)).toHaveLength(1)
    expect(svc.list(otherUserId)).toHaveLength(1)
  })
})
