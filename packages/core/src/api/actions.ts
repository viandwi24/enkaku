import { Hono } from 'hono'
import { ACTION_ERROR_CODES, ActionRequestSchema, ActionResponseSchema, ActionVerbSchema, OperationResponseSchema } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { runAction, type ActionsDeps } from '../actions/run'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = { ...ACTION_ERROR_CODES }

/** `POST /api/actions/:verb` and `GET /api/operations/:id`, one Hono app mounted twice (plan 207 §4.8). */
export function createActionRoutes(deps: ActionsDeps): { actions: Hono<AuthEnv>; operations: Hono<AuthEnv> } {
  const actions = new Hono<AuthEnv>()
  const operations = new Hono<AuthEnv>()

  actions.post('/:verb', async (c) => {
    const verb = ActionVerbSchema.safeParse(c.req.param('verb'))
    if (!verb.success) throw new EnkakuError('E_UNKNOWN_VERB', `no such action: ${c.req.param('verb')}`)
    const raw = await c.req.json().catch(() => null)
    const body = ActionRequestSchema.safeParse({ ...(raw && typeof raw === 'object' ? raw : {}), verb: verb.data })
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    }
    const user = c.get('user')
    if (!user) throw new EnkakuError('auth.forbidden', 'authentication is required')
    const response = await runAction(deps, body.data, { id: user.id, role: user.role })
    return typedJson(c, ActionResponseSchema, response, 202)
  })

  operations.get('/:id', (c) => {
    const operation = deps.operations.get(c.req.param('id'))
    if (!operation) throw new EnkakuError('operation_not_found', `no such operation: ${c.req.param('id')}`)
    return typedJson(c, OperationResponseSchema, { operation })
  })

  actions.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })
  operations.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return { actions, operations }
}
