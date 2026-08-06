import { z } from 'zod'

/** `GET /api/auth/users`. */
export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'operator']),
})
export const UsersResponseSchema = z.object({ users: z.array(UserSchema) })

/** `GET /api/auth/audit`. */
export const AuditEntrySchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  at: z.number().nullable(),
})
export const AuditResponseSchema = z.object({ entries: z.array(AuditEntrySchema) })
