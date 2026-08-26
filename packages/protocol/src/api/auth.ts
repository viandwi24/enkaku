import { z } from 'zod'

/** `GET /api/auth/users`. */
export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'operator']),
})
export const UsersResponseSchema = z.object({ users: z.array(UserSchema) })

/**
 * `GET /api/auth/audit`.
 *
 * `meta` (plan 91 §3.5 layer 3, F24) — `audit.record({ ..., meta })` has
 * always written this to `audit_log`, and `AuditLogger.list()`
 * (`packages/core/src/auth/audit.ts`) has always read it back; the core's own
 * `typedJson` never re-validates its output, so the core's raw HTTP response
 * already carried it. The gap this field closes is on the READING side: any
 * caller that parses the response through this schema (Studio's `api()`,
 * plan 72) had `meta` silently stripped by Zod's default unknown-key
 * behaviour, structurally preventing the audit table from ever rendering it.
 * `unknown` because a row's `meta` is script/caller-authored JSON with no
 * single shape across every `AuditAction` — the same reasoning `JobDetail`
 * uses for `result`/`params` (`./messages/job.ts`).
 */
export const AuditEntrySchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  meta: z.unknown().nullable(),
  at: z.number().nullable(),
})
export const AuditResponseSchema = z.object({ entries: z.array(AuditEntrySchema) })

/**
 * Durable API tokens (plan 130 §3.5, §4.2) — `GET/POST /api/tokens`,
 * `DELETE /api/tokens/:id`. Never carries `tokenHash`: the summary is what
 * every response returns, including the list right after creation: only
 * `ApiTokenCreateResponseSchema`'s own `token` field ever carries the
 * plaintext, and only once.
 */
export const ApiTokenSchema = z.object({
  id: z.string(),
  userId: z.string(),
  label: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
})
export const ApiTokensResponseSchema = z.object({ tokens: z.array(ApiTokenSchema) })

/** `POST /api/tokens` — `token` is the plaintext, shown exactly once. */
export const ApiTokenCreateResponseSchema = ApiTokenSchema.extend({ token: z.string() })
