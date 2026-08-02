import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { agents } from '../db/schema'
import { EnkakuError } from '../util/errors'

export interface AgentAuth {
  /** An admin creates the record and a single-use token (shown in the clear only once). */
  createEnrollment(name: string, tenantId?: string): { agentId: string; token: string }
  /** The agent exchanges the token for a long-lived credential. */
  redeem(token: string, meta: { name: string; platform: string }): { agentId: string; credential: string }
  /** Verify the `Bearer <agentId>.<credential>` header. */
  verify(authHeader: string | null): Promise<string | null>
  list(): Array<{ id: string; name: string; status: string; platform: string | null; lastSeen: number | null }>
  disable(agentId: string): void
}

const randomToken = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const hash = (s: string): string => Bun.password.hashSync(s, { algorithm: 'argon2id' })

export function createAgentAuth(db: Db): AgentAuth {
  return {
    createEnrollment(name, tenantId) {
      const agentId = crypto.randomUUID()
      const token = randomToken()
      db.insert(agents)
        .values({
          id: agentId,
          name,
          tenantId: tenantId ?? null,
          tokenHash: hash(token),
          status: 'pending',
          createdAt: new Date(),
        })
        .run()
      return { agentId, token }
    },

    redeem(token, meta) {
      // The token carries no agentId, so search the pending enrollments.
      const pending = db.select().from(agents).where(eq(agents.status, 'pending')).all()
      const match = pending.find((row) => row.tokenHash && Bun.password.verifySync(token, row.tokenHash))
      if (!match) throw new EnkakuError('agent.invalid_token', 'the enrollment token is invalid or already used')
      const credential = randomToken()
      db.update(agents)
        .set({
          // Single-use token: cleared once exchanged.
          tokenHash: null,
          credentialHash: hash(credential),
          status: 'offline',
          name: meta.name,
          platform: meta.platform,
          createdAt: match.createdAt ?? new Date(),
        })
        .where(eq(agents.id, match.id))
        .run()
      return { agentId: match.id, credential }
    },

    async verify(authHeader) {
      const raw = authHeader?.replace(/^Bearer /, '')
      if (!raw) return null
      const sep = raw.indexOf('.')
      if (sep <= 0) return null
      const agentId = raw.slice(0, sep)
      const credential = raw.slice(sep + 1)
      const row = db.select().from(agents).where(eq(agents.id, agentId)).get()
      if (!row?.credentialHash || row.status === 'disabled') return null
      const ok = await Bun.password.verify(credential, row.credentialHash)
      return ok ? agentId : null
    },

    list() {
      return db
        .select()
        .from(agents)
        .all()
        .map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status ?? 'pending',
          platform: r.platform,
          lastSeen: r.lastSeen ? Math.floor(r.lastSeen.getTime() / 1000) : null,
        }))
    },

    disable(agentId) {
      db.update(agents).set({ status: 'disabled', credentialHash: null }).where(eq(agents.id, agentId)).run()
    },
  }
}
