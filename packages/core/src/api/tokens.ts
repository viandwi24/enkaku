import { Hono } from 'hono'
import { z } from 'zod'
import { ApiTokenCreateResponseSchema, ApiTokensResponseSchema } from '@enkaku/protocol'
import type { ApiTokenService } from '../auth/api-tokens'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const CreateBody = z.object({
  label: z.string().min(1),
  /** Unix seconds. Omitted or `null` means the token never expires. */
  expiresAt: z.number().int().positive().nullable().optional(),
})

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  'api_token.not_found': 404,
}

/**
 * Durable API tokens (plan 130 §3.5, §4.2, step 130.4) — `GET/POST
 * /api/tokens`, `DELETE /api/tokens/:id`. Gated on `user.manage`, same as
 * `/api/auth/users` (`auth/routes.ts`) and `/api/nodes` (`./nodes.ts`): a
 * token is a credential that authenticates as a farm user, so minting one
 * is exactly as sensitive as creating a user.
 *
 * A token is always the CALLER's own — there is no `userId` in the request
 * body, so `user.manage` cannot be used to mint a credential for someone
 * else. `list`/`revoke` are likewise scoped to the caller's own tokens
 * (`ApiTokenService.list`/`revoke` both take `userId`).
 */
export function createTokenRoutes(deps: { apiTokens: ApiTokenService }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  app.use('*', requirePermission('user.manage'))

  app.get('/', (c) => {
    return typedJson(c, ApiTokensResponseSchema, { tokens: deps.apiTokens.list(c.get('user').id) })
  })

  app.post('/', async (c) => {
    const body = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { label, expiresAt? } is required')
    const expiresAt = body.data.expiresAt ? new Date(body.data.expiresAt * 1000) : null
    // The plaintext is returned exactly once, here — the DB stores only its hash.
    const created = deps.apiTokens.create(c.get('user').id, body.data.label, expiresAt)
    return typedJson(c, ApiTokenCreateResponseSchema, created, 201)
  })

  app.delete('/:id', (c) => {
    deps.apiTokens.revoke(c.get('user').id, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    throw err
  })

  return app
}
