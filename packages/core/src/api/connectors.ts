import { Hono } from 'hono'
import {
  ConnectorModelsResponseSchema,
  ConnectorResponseSchema,
  ConnectorUpdateInputSchema,
  ConnectorWriteInputSchema,
  ListConnectorsResponseSchema,
} from '@enkaku/protocol'
import type { ConnectorStore } from '../agent/connector-store'
import type { ModelListCache } from '../agent/provider'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

/**
 * `GET/POST/PATCH/DELETE /api/connectors`, `GET /:id/models`, `POST
 * /:id/test` (plan 65 §4.5). Connectors are farm-level (§3.8) — reading is
 * `settings.view` (which every operator already holds), writing is
 * `settings.manage` (admin-only under the static ACL), the same split the
 * rest of farm Settings already uses.
 */
export function createConnectorRoutes(deps: { store: ConnectorStore; audit: AuditLogger; modelCache: ModelListCache; fetch?: typeof fetch }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { store, audit, modelCache } = deps

  const mustGet = (id: string) => {
    const connector = store.get(id)
    if (!connector) throw new EnkakuError('connector_not_found', `no such connector: ${id}`)
    return connector
  }

  app.get('/', requirePermission('settings.view'), (c) => typedJson(c, ListConnectorsResponseSchema, { connectors: store.list() }))

  app.get('/:id', requirePermission('settings.view'), (c) => typedJson(c, ConnectorResponseSchema, { connector: mustGet(c.req.param('id')) }))

  app.post('/', requirePermission('settings.manage'), async (c) => {
    const body = ConnectorWriteInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const connector = store.create(body.data)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'connector.create', target: connector.id, meta: { name: connector.name, kind: connector.kind } })
    return typedJson(c, ConnectorResponseSchema, { connector }, 201)
  })

  app.patch('/:id', requirePermission('settings.manage'), async (c) => {
    const id = c.req.param('id')
    const body = ConnectorUpdateInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const connector = store.update(id, body.data)
    modelCache.invalidate(id)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'connector.update', target: id, meta: { patch: Object.keys(body.data).filter((k) => k !== 'credential') } })
    return typedJson(c, ConnectorResponseSchema, { connector })
  })

  app.delete('/:id', requirePermission('settings.manage'), (c) => {
    const id = c.req.param('id')
    store.remove(id)
    modelCache.invalidate(id)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'connector.delete', target: id, meta: {} })
    return c.body(null, 204)
  })

  app.post('/:id/test', requirePermission('settings.manage'), async (c) => {
    const id = c.req.param('id')
    mustGet(id)
    const result = await store.test(id)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'connector.test', target: id, meta: { status: result.status } })
    return c.json(result)
  })

  app.get('/:id/models', requirePermission('settings.view'), async (c) => {
    const id = c.req.param('id')
    const connector = mustGet(id)
    const apiKey = store.resolveApiKey(id)
    if (!apiKey) return typedJson(c, ConnectorModelsResponseSchema, { models: [], fallback: true })
    const result = await modelCache.get(id, connector.kind, { apiKey, baseUrl: connector.baseUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
    return typedJson(c, ConnectorModelsResponseSchema, result)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const status = err.code === 'connector_not_found' ? 404 : err.code === 'E_CONNECTOR_NAME_TAKEN' || err.code === 'E_BAD_REQUEST' ? 400 : 500
      return c.json(err.toJSON(), status as 400)
    }
    throw err
  })

  return app
}
