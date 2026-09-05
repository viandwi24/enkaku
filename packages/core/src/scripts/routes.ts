import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  ParamPresetDeleteResponseSchema,
  ParamPresetListResponseSchema,
  ParamPresetResponseSchema,
  ScriptDeleteResponseSchema,
  ScriptResponseSchema,
  ScriptsListResponseSchema,
  type JsonSchemaNode,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { jobRuns, jobs, plugins, scripts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createLogger, type Logger } from '../util/logger'
import { typedJson } from '../api/typed-json'
import { createParamPreset, deleteParamPreset, listParamPresets, updateParamPreset } from './param-sets'
import { getScriptDetail, isUnownedScriptRow, listActiveScripts, parseScriptRuntime } from './service'

// Plan 95 §4.7, §4.8, §5 step 95.8 — a preset's own `params` is
// `z.unknown()`, same reasoning `ParamPresetInfoSchema`'s doc comment gives:
// it is checked against the SCHEMA it meets when applied
// (`reconcileParams`), not against a fixed shape at save time. `name` gets
// the same ceiling as every other author-facing label this plan already
// caps (`SCHEMA_LIMITS.maxLabelChars`).
const ParamSetCreateBody = z.object({ name: z.string().min(1).max(60), params: z.unknown() })
const ParamSetUpdateBody = z.object({ name: z.string().min(1).max(60).optional(), params: z.unknown().optional() })

const ERROR_STATUS: Record<string, number> = {
  script_not_found: 404,
  script_in_use: 409,
  E_SCRIPT_OWNED: 409,
  param_set_not_found: 404,
  param_set_name_exists: 409,
  unauthorized: 401,
  E_BAD_REQUEST: 400,
}

/**
 * Script list/detail/delete and named parameter sets (plan 210 §4.3, §4.5).
 * A script exists only as a member of a plugin (plan 210, MVP 03 §2): the
 * only writer of a `scripts` row is `plugins/runtime.ts`'s `writeScriptRows`.
 * There is no publish route here any more — publishing goes through
 * `POST /api/plugins` (or `plugin.stage`).
 *
 * `audit` and `log` are optional so the existing caller (`daemon.ts`'s
 * `createScriptRoutes({ db, ... })`) keeps compiling unchanged.
 */
export function createScriptRoutes(deps: { db: Db; publishToken?: string; audit?: AuditLogger; log?: Logger }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps
  const log = deps.log ?? createLogger('scripts')
  const actorId = (c: { get(k: 'user'): { id: string } | undefined }): string | null => c.get('user')?.id ?? null
  void log

  // Mutation guard: a token when one is configured (full auth arrives in Plan 09).
  app.use('*', async (c, next) => {
    const mutating = c.req.method !== 'GET'
    if (mutating && deps.publishToken) {
      const auth = c.req.header('authorization')
      if (auth !== `Bearer ${deps.publishToken}`) {
        throw new EnkakuError('unauthorized', 'invalid publish token')
      }
    }
    await next()
  })

  // Named parameter sets (plan 95 §4.7, §4.8, §5 step 95.8) — filed under the
  // script NAME. Registered before `/:id` for the same reason as always: a
  // literal second segment (`param-sets`) never collides with a one-segment
  // `/:id` match.
  app.get('/:name/param-sets', requirePermission('script.view'), (c) => {
    const items = listParamPresets(db, 'script', c.req.param('name'))
    return typedJson(c, ParamPresetListResponseSchema, { items })
  })

  // `job.run`, not `script.publish` (plan 95 §4.8's own route table) — a
  // preset is a convenience for someone about to RUN a script.
  app.post('/:name/param-sets', requirePermission('job.run'), async (c) => {
    const name = c.req.param('name')
    const body = ParamSetCreateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    }
    const preset = createParamPreset(db, { kind: 'script', ownerName: name, name: body.data.name, params: body.data.params, createdBy: actorId(c) })
    deps.audit?.record({ userId: actorId(c), action: 'script.param_set.create', target: preset.id, meta: { scriptName: name, name: preset.name } })
    return typedJson(c, ParamPresetResponseSchema, { preset }, 201)
  })

  app.patch('/:name/param-sets/:id', requirePermission('job.run'), async (c) => {
    const name = c.req.param('name')
    const body = ParamSetUpdateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    }
    const preset = updateParamPreset(db, 'script', name, c.req.param('id'), body.data)
    deps.audit?.record({ userId: actorId(c), action: 'script.param_set.update', target: preset.id, meta: { scriptName: name, name: preset.name } })
    return typedJson(c, ParamPresetResponseSchema, { preset })
  })

  app.delete('/:name/param-sets/:id', requirePermission('job.run'), (c) => {
    const name = c.req.param('name')
    const id = c.req.param('id')
    const deleted = deleteParamPreset(db, 'script', name, id)
    deps.audit?.record({ userId: actorId(c), action: 'script.param_set.delete', target: id, meta: { scriptName: name, name: deleted.name } })
    return typedJson(c, ParamPresetDeleteResponseSchema, { ok: true })
  })

  // `GET /api/scripts` (plan 210 §4.2, §4.5) — one row per member of an
  // ACTIVE plugin. The set is small (plan 210 §3.2 item 2), so `nextCursor`
  // is always null; `?group`, `?kind`, `?cursor`, `?limit` are ignored.
  app.get('/', (c) => {
    const items = listActiveScripts(db)
    return typedJson(c, ScriptsListResponseSchema, { items, nextCursor: null, total: items.length })
  })

  app.get('/:id', (c) => {
    const detail = getScriptDetail(db, c.req.param('id'))
    if (!detail) throw new EnkakuError('script_not_found', 'no such script')
    const includeBundle = c.req.query('bundle') === '1'
    const script = {
      id: detail.id,
      name: detail.name,
      exportId: detail.exportId,
      plugin: detail.plugin,
      paramsSchema: detail.paramsSchema as JsonSchemaNode | null,
      resultSchema: detail.resultSchema as JsonSchemaNode | null,
      createdBy: detail.createdBy,
      source: detail.source,
      createdAt: detail.createdAt,
      runtime: parseScriptRuntime(detail.runtime),
      ...(includeBundle ? { bundle: db.select({ bundle: scripts.bundle }).from(scripts).where(eq(scripts.id, detail.id)).get()?.bundle } : {}),
    }
    return typedJson(c, ScriptResponseSchema, { script })
  })

  // `DELETE /api/scripts/:id` — the only cleanup door for a row the boot
  // warning names (an unowned row, plan 210 §3.2 item 4). A row owned by a
  // plugin is refused: remove that plugin version instead.
  app.delete('/:id', requirePermission('script.delete'), (c) => {
    const id = c.req.param('id')
    const row = db.select().from(scripts).where(eq(scripts.id, id)).get()
    if (!row) throw new EnkakuError('script_not_found', 'no such script')
    if (!isUnownedScriptRow(row)) {
      const owner = db.select().from(plugins).where(eq(plugins.id, row.pluginId as string)).get()
      const ownerRef = owner ? `${owner.name}@${owner.version}` : row.pluginId
      throw new EnkakuError(
        'E_SCRIPT_OWNED',
        `${row.name} is a member of plugin ${ownerRef}; remove that plugin version instead: DELETE /api/plugins/${owner?.name ?? row.pluginId}/${owner?.version ?? ''}`,
      )
    }
    // Plan 211 §3.2 decision 9 — `jobs.status` moved to `job_runs.status` (via `latestRunId`).
    const active = db
      .select()
      .from(jobs)
      .innerJoin(jobRuns, eq(jobs.latestRunId, jobRuns.id))
      .where(and(eq(jobs.scriptId, id), inArray(jobRuns.status, ['queued', 'running'])))
      .all()
    if (active.length > 0) {
      throw new EnkakuError('script_in_use', `${active.length} queued or running job(s) still use this script`)
    }
    db.delete(scripts).where(eq(scripts.id, id)).run()
    deps.audit?.record({ userId: actorId(c), action: 'script.delete', target: id, meta: { name: row.name, version: row.version } })
    return typedJson(c, ScriptDeleteResponseSchema, { ok: true })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
