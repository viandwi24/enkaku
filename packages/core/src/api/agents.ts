import { Hono } from 'hono'
import { z } from 'zod'
import {
  AgentResponseSchema,
  AgentUpdateInputSchema,
  AgentWriteInputSchema,
  FarmAgentSettingsResponseSchema,
  FarmAgentSettingsSchema,
  ListAgentsResponseSchema,
  UpdateFarmAgentSettingsResponseSchema,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { AgentStore } from '../agent/agent-store'
import type { AgentSettingsStore } from '../settings/agent-settings'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

/**
 * `GET/POST/PATCH/DELETE /api/agents` (plan 65 §4.5, §5.5). Reading is
 * `agent.view`; every write is `agent.manage` — that permission gates
 * whether a caller may create/edit/delete an AGENT RECORD, which is
 * different from what the agent itself is permitted to DO once it runs
 * (`agent.permissions`, capped at the owner's own set by the store).
 *
 * The sub-agent spawn-grant routes (plan 67 §3.4, §4.1) are deleted by plan
 * 220 §3.5: no MVP document surfaces sub-agent spawn permissioning on the
 * compacted Agents page, and no Studio caller ever reached these routes. The
 * runtime capability is unaffected — `canSpawn`'s default-deny
 * (`packages/core/src/agent/tree/store.ts`) is checked by `agent.spawn`
 * directly, and `grantSpawn`/`revokeSpawn` are untouched, ready to be wired
 * to a new route the moment a screen exists for it.
 */
export function createAgentRoutes(deps: { store: AgentStore; audit: AuditLogger; settings: AgentSettingsStore }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { store, audit, settings } = deps

  // Plan 212 §4.7 — registered BEFORE `/:id` below, or `GET /api/agents/settings`
  // resolves as an agent lookup for id `"settings"` and answers `agent_not_found`.
  app.get('/settings', requirePermission('agent.view'), (c) =>
    typedJson(c, FarmAgentSettingsResponseSchema, { settings: settings.get(), schema: z.toJSONSchema(FarmAgentSettingsSchema) }),
  )
  app.patch('/settings', requirePermission('agent.manage'), async (c) => {
    const body = await c.req.json().catch(() => null)
    const updated = settings.update(body)
    return typedJson(c, UpdateFarmAgentSettingsResponseSchema, { settings: updated })
  })

  app.get('/', requirePermission('agent.view'), (c) => typedJson(c, ListAgentsResponseSchema, { agents: store.list() }))

  app.get('/:id', requirePermission('agent.view'), (c) => {
    const agent = store.get(c.req.param('id'))
    if (!agent) throw new EnkakuError('agent_not_found', `no such agent: ${c.req.param('id')}`)
    return typedJson(c, AgentResponseSchema, { agent })
  })

  app.post('/', requirePermission('agent.manage'), async (c) => {
    const body = AgentWriteInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const user = c.get('user')
    const agent = store.create(body.data, user?.id ?? null)
    audit.record({ userId: user?.id ?? null, action: 'agent.create', target: agent.id, meta: { slug: agent.slug } })
    return typedJson(c, AgentResponseSchema, { agent }, 201)
  })

  app.patch('/:id', requirePermission('agent.manage'), async (c) => {
    const id = c.req.param('id')
    const body = AgentUpdateInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const agent = store.update(id, body.data)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'agent.update', target: id, meta: { patch: Object.keys(body.data) } })
    return typedJson(c, AgentResponseSchema, { agent })
  })

  app.delete('/:id', requirePermission('agent.manage'), (c) => {
    const id = c.req.param('id')
    store.remove(id)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'agent.delete', target: id, meta: {} })
    return c.body(null, 204)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const status =
        err.code === 'agent_not_found'
          ? 404
          : err.code === 'E_OVER_PRIVILEGED'
            ? 403
            : ['E_BAD_REQUEST', 'E_SLUG_TAKEN', 'E_UNKNOWN_CAPABILITY', 'E_UNKNOWN_DEVICE', 'E_UNKNOWN_PERMISSION', 'E_BAD_PATH'].includes(err.code)
              ? 400
              : 500
      return c.json(err.toJSON(), status as 400)
    }
    throw err
  })

  return app
}
