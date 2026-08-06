import { Hono } from 'hono'
import { z } from 'zod'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { AuditLogger } from '../auth/audit'
import type { PluginRuntime } from '../plugins/runtime'
import type { WorkspaceStore } from '../workspace/store'
import { EnkakuError } from '../util/errors'

/**
 * `/api/plugins` (plan 82 §4.6, step 11) — stage/verify (one publish call),
 * activate, rollback, disable, remove, reload, restart, and the dev slot
 * lifecycle. Reuses `script.publish`/`script.delete` (plan 82 §3.5: "dev
 * slots require the same permission as publishing") rather than inventing
 * a `plugin.*` permission the ACL matrix (`auth/acl.ts`) was never asked
 * for.
 */

const StageBody = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
  bundle: z.string().min(1),
  source: z.string().optional(),
  /** Skips the verify step this route otherwise runs synchronously (mainly for tests/debugging — §5 step 12). */
  stageOnly: z.boolean().optional(),
})

const RollbackBody = z.object({ toVersion: z.string().min(1) })

const DevBody = z.object({
  name: z.string().min(1),
  /** A workspace path (front-end A, §3.5) OR a pre-built bundle (front-end B, `enkaku dev`). Exactly one. */
  entryPath: z.string().optional(),
  bundle: z.string().optional(),
})

const ERROR_STATUS: Record<string, number> = {
  plugin_not_found: 404,
  plugin_version_exists: 409,
  plugin_not_verified: 409,
  plugin_activate_conflict: 409,
  plugin_not_rollbackable: 409,
  E_BAD_REQUEST: 400,
}

function actorId(c: { get(k: 'user'): { id: string } | undefined }): string | null {
  return c.get('user')?.id ?? null
}

export interface PluginRoutesDeps {
  runtime: PluginRuntime
  audit: AuditLogger
  workspace: WorkspaceStore
  /** `{ kind: 'cli'; label: string }` for `enkaku dev`, derived from the request; a workspace-driven dev slot is always `{ kind: 'workspace', label: entryPath }`. */
  devOwnerFromRequest?: (c: { req: { header(name: string): string | undefined } }) => { kind: 'cli'; label: string } | null
}

export function createPluginRoutes(deps: PluginRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { runtime, audit, workspace } = deps

  app.get('/', (c) => {
    const name = c.req.query('name') ?? undefined
    const items = runtime.list({ name })
    const dev = runtime.devSlots()
    return c.json({ items, dev })
  })

  app.get('/dev', (c) => c.json({ items: runtime.devSlots() }))

  app.get('/:name/:version', (c) => {
    const row = runtime.get(c.req.param('name'), c.req.param('version'))
    if (!row) throw new EnkakuError('plugin_not_found', 'no such plugin version')
    return c.json({ plugin: row })
  })

  // Stage + verify in one call (§3.7 steps 1-2) — activation stays a separate, explicit call
  // (§3.9's own reasoning: nothing about publishing should ever change what is currently live).
  app.post('/', requirePermission('script.publish'), async (c) => {
    const body = StageBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    }
    const staged = await runtime.stage({ ...body.data, createdBy: actorId(c) })
    audit.record({ userId: actorId(c), action: 'plugin.publish', target: staged.id, meta: { name: staged.name, version: staged.version } })
    if (body.data.stageOnly) return c.json({ plugin: staged }, 201)
    const report = await runtime.verify(staged.id)
    const row = runtime.get(staged.name, staged.version)
    return c.json({ plugin: row, verify: report }, 201)
  })

  app.post('/:id/verify', requirePermission('script.publish'), async (c) => {
    const report = await runtime.verify(c.req.param('id'))
    return c.json({ verify: report })
  })

  app.post('/:id/activate', requirePermission('script.publish'), (c) => {
    const row = runtime.activate(c.req.param('id'))
    audit.record({ userId: actorId(c), action: 'plugin.activate', target: row.id, meta: { name: row.name, version: row.version } })
    return c.json({ plugin: row })
  })

  app.post('/:name/rollback', requirePermission('script.publish'), async (c) => {
    const body = RollbackBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: 'toVersion is required' } }, 400)
    const row = runtime.rollback(c.req.param('name'), body.data.toVersion)
    audit.record({ userId: actorId(c), action: 'plugin.rollback', target: row.id, meta: { name: row.name, toVersion: body.data.toVersion } })
    return c.json({ plugin: row })
  })

  app.post('/:name/disable', requirePermission('script.publish'), (c) => {
    const name = c.req.param('name')
    runtime.disable(name)
    audit.record({ userId: actorId(c), action: 'plugin.disable', target: name })
    return c.json({ ok: true })
  })

  app.post('/:name/reload', requirePermission('script.publish'), async (c) => {
    const name = c.req.param('name')
    const report = await runtime.reload(name)
    audit.record({ userId: actorId(c), action: 'plugin.reload', target: name, meta: { ok: report.ok } })
    return c.json({ verify: report })
  })

  app.post('/restart', requirePermission('script.publish'), async (c) => {
    const result = await runtime.restart()
    audit.record({ userId: actorId(c), action: 'plugin.restart', meta: result })
    return c.json(result)
  })

  // `/dev/...` is registered BEFORE `/:name/:version` below — both are
  // two-segment patterns, and `DELETE /dev/tiktok` would otherwise be
  // swallowed by `DELETE /:name/:version` (`name='dev'`, `version='tiktok'`),
  // exactly the shadowing `scripts/routes.ts` already guards against for
  // `/:name/versions`. Hono matches in registration order, so this one
  // ordering choice is what keeps the two apart.
  app.post('/dev', requirePermission('script.publish'), async (c) => {
    const body = DevBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    }
    if ((body.data.entryPath ? 1 : 0) + (body.data.bundle ? 1 : 0) !== 1) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: 'exactly one of entryPath or bundle is required' } }, 400)
    }
    const owner = body.data.entryPath
      ? { kind: 'workspace' as const, label: body.data.entryPath }
      : (deps.devOwnerFromRequest?.(c) ?? { kind: 'cli' as const, label: actorId(c) ?? 'an unknown session' })
    const report = await runtime.putDevSlot({
      name: body.data.name,
      owner,
      source: body.data.entryPath ? { kind: 'workspace', entryPath: body.data.entryPath, workspace } : { kind: 'bundle', bundle: body.data.bundle as string },
    })
    audit.record({ userId: actorId(c), action: 'plugin.dev', target: body.data.name, meta: { ok: report.ok } })
    return c.json(report)
  })

  app.delete('/dev/:name', requirePermission('script.publish'), (c) => {
    const name = c.req.param('name')
    runtime.dropDevSlot(name)
    audit.record({ userId: actorId(c), action: 'plugin.dev', target: name, meta: { dropped: true } })
    return c.json({ ok: true })
  })

  app.delete('/:name/:version', requirePermission('script.delete'), (c) => {
    const name = c.req.param('name')
    const version = c.req.param('version')
    const deleteKv = c.req.query('deleteKv') === '1' || c.req.query('deleteKv') === 'true'
    const result = runtime.remove(name, version, { deleteKv })
    if (!result.removed) throw new EnkakuError('plugin_not_found', `no such plugin version: ${name}@${version}`)
    audit.record({ userId: actorId(c), action: 'plugin.delete', target: `${name}@${version}`, meta: result })
    return c.json(result)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
