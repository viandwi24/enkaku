import { z } from 'zod'

/**
 * `/api/kv` (plan 79 §4.3). A secret entry's `value` is ALWAYS redacted to
 * `null` by the core (`redactEntry`, `packages/core/src/api/kv.ts`) — this
 * schema's `value: z.unknown()` reflects the wire shape, not a promise that
 * a secret's plaintext ever arrives here. Studio must render `hint` plus a
 * `secret: true` marker for a secret row, never `value` (plan 79 §3.4).
 */
export const KvEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  secret: z.boolean(),
  hint: z.string().nullable(),
  version: z.number(),
  expiresAt: z.number().nullable(),
  updatedAt: z.number(),
})
export type KvEntry = z.infer<typeof KvEntrySchema>

/** `GET /api/kv?scope=&namespace=&...`. */
export const KvListResponseSchema = z.object({
  items: z.array(KvEntrySchema),
  nextCursor: z.string().nullable(),
})

/** `GET/PUT /api/kv/entry`. */
export const KvEntryResponseSchema = KvEntrySchema

/** `DELETE /api/kv/entry`. */
export const KvDeleteResponseSchema = z.object({ ok: z.boolean() })
