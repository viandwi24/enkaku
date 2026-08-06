import { Hono } from 'hono'
import { WebhookEndpointUpdateInputSchema, WebhookEndpointWriteInputSchema, WebhooksResponseSchema } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { WebhookStore } from '../notify/webhook-store'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

/**
 * `GET/POST/PATCH/DELETE /api/webhooks` (plan 68 §3.4, §4.1, §4.5) —
 * farm-level, admin-managed: endpoints are configured here and an agent
 * only ever chooses among their NAMES via `notify.send` (never a raw URL),
 * which is what keeps a webhook from leaking farm information to an
 * arbitrary address (§8's risk table). Gated by `settings.manage`, the
 * same permission the rest of Settings already uses.
 */
export interface WebhookRoutesDeps {
  store: WebhookStore
  audit: AuditLogger
}

const ERROR_STATUS: Record<string, number> = {
  webhook_not_found: 404,
  E_WEBHOOK_NAME_TAKEN: 409,
  E_BAD_REQUEST: 400,
}

export function createWebhookRoutes(deps: WebhookRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { store, audit } = deps

  app.get('/', requirePermission('settings.view'), (c) => typedJson(c, WebhooksResponseSchema, { endpoints: store.list() }))

  app.post('/', requirePermission('settings.manage'), async (c) => {
    const body = WebhookEndpointWriteInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const endpoint = store.create(body.data)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'webhook.create', target: endpoint.id, meta: { name: endpoint.name, url: endpoint.url } })
    return c.json({ endpoint }, 201)
  })

  app.patch('/:id', requirePermission('settings.manage'), async (c) => {
    const id = c.req.param('id')
    const body = WebhookEndpointUpdateInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const endpoint = store.update(id, body.data)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'webhook.update', target: id, meta: { patch: Object.keys(body.data) } })
    return c.json({ endpoint })
  })

  app.delete('/:id', requirePermission('settings.manage'), (c) => {
    const id = c.req.param('id')
    store.remove(id)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'webhook.delete', target: id, meta: {} })
    return c.body(null, 204)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
