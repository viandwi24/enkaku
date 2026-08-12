import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  checkParamsSchema,
  compareSemver,
  JsonSchemaNodeSchema,
  ParamSetDeleteResponseSchema,
  ParamSetListResponseSchema,
  ParamSetResponseSchema,
  ScriptDeleteResponseSchema,
  ScriptGroupsPageResponseSchema,
  ScriptResponseSchema,
  ScriptToggleResponseSchema,
  ScriptVersionsResponseSchema,
  type JsonSchemaNode,
  type SchemaCheckFinding,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { jobs, scripts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from '../api/pagination'
import { typedJson } from '../api/typed-json'
import { createParamSet, deleteParamSet, listParamSets, updateParamSet } from './param-sets'
import { listScriptGroups, publishScript } from './service'

const PublishBody = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
  bundle: z.string().min(1),
  /** The entry file's source, for the readable preview. Optional for older CLIs. */
  source: z.string().optional(),
  // Plan 95 §4.9, §5 step 95.5 (fixes F7): no longer `z.unknown()` — a
  // params schema is a JSON Schema OBJECT (or absent), never an arbitrary
  // value. `checkParamsSchema` (below) is the finer-grained gate this Zod
  // shape cannot express (size, depth, field count, hint validity).
  paramsSchema: JsonSchemaNodeSchema.nullable().optional(),
})

/**
 * `checkParamsSchema` findings split into what blocks a publish and what
 * merely warns (plan 95 §3.5, §4.9): a `'group'` finding is the
 * non-consecutive-group warning, which "warns... so the author can reorder
 * or accept it" — it must never refuse a publish outright the way every
 * other limit does.
 */
function blockingFindings(findings: SchemaCheckFinding[]): SchemaCheckFinding[] {
  return findings.filter((f) => f.limit !== 'group')
}

const PatchBody = z.object({ enabled: z.boolean() })

// Plan 95 §4.7, §4.8, §5 step 95.8 — a set's own `params` is `z.unknown()`,
// same reasoning `ParamSetInfoSchema`'s doc comment gives: it is checked
// against the SCHEMA it meets when applied (`reconcileParams`), not against
// a fixed shape at save time. `name` gets the same ceiling as every other
// author-facing label this plan already caps (`PARAMS_LIMITS.maxLabelChars`).
const ParamSetCreateBody = z.object({ name: z.string().min(1).max(60), params: z.unknown() })
const ParamSetUpdateBody = z.object({ name: z.string().min(1).max(60).optional(), params: z.unknown().optional() })

const ERROR_STATUS: Record<string, number> = {
  script_not_found: 404,
  script_version_exists: 409,
  script_in_use: 409,
  param_set_not_found: 404,
  param_set_name_exists: 409,
  unauthorized: 401,
  E_BAD_REQUEST: 400,
}

/**
 * Script CRUD (plan 05 §4.9). Every publish creates a new row; (name, version)
 * is unique so older jobs stay reproducible.
 *
 * `audit` is optional so the existing caller (`daemon.ts`'s
 * `createScriptRoutes({ db, ... })`) keeps compiling unchanged — wiring the
 * farm's real `AuditLogger` through is a one-line follow-up outside this
 * file's ownership. Before this fix, NONE of publish/toggle/delete recorded
 * anything, despite `script.publish`/`script.delete`/`script.toggle`
 * already existing (and going entirely unused) in `auth/audit.ts` — its
 * sibling `api/plugins.ts`, which reuses these exact two permissions,
 * audits every one of its own mutations (a security-sweep finding).
 */
export function createScriptRoutes(deps: { db: Db; publishToken?: string; audit?: AuditLogger }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps
  const actorId = (c: { get(k: 'user'): { id: string } | undefined }): string | null => c.get('user')?.id ?? null

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

  // The version list for the detail page's selector (plan 62 §4.4) — newest
  // semver first, so "latest" is always the top of the list without a
  // second client-side sort. Registered before `/:id` so a script literally
  // named `versions` can never shadow it — though in practice the two never
  // collide: this route only matches a two-segment path.
  app.get('/:name/versions', (c) => {
    const name = c.req.param('name')
    const rows = db.select().from(scripts).where(eq(scripts.name, name)).all()
    const items = [...rows]
      .sort((a, b) => compareSemver(b.version, a.version))
      .map((r) => ({
        id: r.id,
        version: r.version,
        enabled: r.enabled ?? true,
        createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : null,
      }))
    return typedJson(c, ScriptVersionsResponseSchema, { items })
  })

  // Named parameter sets (plan 95 §4.7, §4.8, §5 step 95.8) — filed under the
  // script NAME, so `/:name/param-sets` reads the same way `/:name/versions`
  // above does. Registered before `/:id` for the same reason that route is:
  // a literal second segment (`param-sets`) never collides with a one-segment
  // `/:id` match, but keeping the two-segment routes together is easier to
  // audit by eye.
  app.get('/:name/param-sets', requirePermission('script.view'), (c) => {
    const items = listParamSets(db, c.req.param('name'))
    return typedJson(c, ParamSetListResponseSchema, { items })
  })

  // `job.run`, not `script.publish` (plan 95 §4.8's own route table) — a
  // preset is a convenience for someone about to RUN a script, the same
  // reasoning `api/schedules.ts` gives for gating schedule creation on
  // `job.run` rather than a `job.manage` this ACL has never had.
  app.post('/:name/param-sets', requirePermission('job.run'), async (c) => {
    const name = c.req.param('name')
    const body = ParamSetCreateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    }
    const paramSet = createParamSet(db, { scriptName: name, name: body.data.name, params: body.data.params, createdBy: actorId(c) })
    deps.audit?.record({ userId: actorId(c), action: 'script.param_set.create', target: paramSet.id, meta: { scriptName: name, name: paramSet.name } })
    return typedJson(c, ParamSetResponseSchema, { paramSet }, 201)
  })

  app.patch('/:name/param-sets/:id', requirePermission('job.run'), async (c) => {
    const name = c.req.param('name')
    const body = ParamSetUpdateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    }
    const paramSet = updateParamSet(db, name, c.req.param('id'), body.data)
    deps.audit?.record({ userId: actorId(c), action: 'script.param_set.update', target: paramSet.id, meta: { scriptName: name, name: paramSet.name } })
    return typedJson(c, ParamSetResponseSchema, { paramSet })
  })

  app.delete('/:name/param-sets/:id', requirePermission('job.run'), (c) => {
    const name = c.req.param('name')
    const id = c.req.param('id')
    const deleted = deleteParamSet(db, name, id)
    deps.audit?.record({ userId: actorId(c), action: 'script.param_set.delete', target: id, meta: { scriptName: name, name: deleted.name } })
    return typedJson(c, ParamSetDeleteResponseSchema, { ok: true })
  })

  app.get('/', (c) => {
    // `?group=name` (plan 62 §4.4) — one row per script NAME, computed from
    // every version in one pass. The number of distinct script names on a
    // farm is small (unlike the potentially-large `jobs`/`device_events`
    // tables), so this is a plain full scan rather than a keyset page — the
    // ungrouped form below stays keyset-paginated, and callers who need that
    // still get it exactly as before.
    if (c.req.query('group') === 'name') {
      const items = listScriptGroups(db)
      return typedJson(c, ScriptGroupsPageResponseSchema, { items, nextCursor: null, total: items.length })
    }
    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const cursor = decodeCursor(cursorParam)
    const keyset = keysetWhere(
      cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
      scripts.createdAt,
      scripts.id,
    )
    const page = db
      .select({
        id: scripts.id,
        name: scripts.name,
        version: scripts.version,
        paramsSchema: scripts.paramsSchema,
        enabled: scripts.enabled,
        createdBy: scripts.createdBy,
        createdAt: scripts.createdAt,
      })
      .from(scripts)
      .where(keyset)
      .orderBy(desc(scripts.createdAt), desc(scripts.id))
      .limit(limit + 1)
      .all()
    const hasMore = page.length > limit
    const rows = hasMore ? page.slice(0, limit) : page
    const last = rows[rows.length - 1]
    const nextCursor =
      hasMore && last ? encodeCursor(Math.floor((last.createdAt ?? new Date(0)).getTime() / 1000), last.id) : null
    const total = db.select().from(scripts).all().length

    const items = rows.map((r) => ({ ...r, createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : null }))
    return c.json({ items, nextCursor, total, scripts: items })
  })

  app.get('/:id', (c) => {
    const row = db.select().from(scripts).where(eq(scripts.id, c.req.param('id'))).get()
    if (!row) throw new EnkakuError('script_not_found', 'no such script')
    const includeBundle = c.req.query('bundle') === '1'
    const script = {
      id: row.id,
      name: row.name,
      version: row.version,
      // `row.paramsSchema` is the raw `unknown`-typed `params_schema` json
      // column (Drizzle infers a bare `text(..., {mode:'json'})` column as
      // `unknown` with no `.$type<>()` annotation, which this pass
      // deliberately does not add — that would cascade `.$type<>()`
      // requirements through every OTHER insert of this column across the
      // plugin runtime, capability layer, and dev-slot registry, none of
      // which this step touches). The cast below reconciles that raw
      // column type with `ScriptRowSchema`'s
      // `paramsSchema: JsonSchemaNodeSchema.nullable()` for what is, by
      // construction, already-validated data: every row this route can
      // read either came through `POST /`'s `PublishBody.paramsSchema`
      // (now `JsonSchemaNodeSchema.nullable().optional()`, not
      // `z.unknown()` — plan 95 §4.9, §5 step 95.5, closing F7's own
      // admission) or predates that check and is `null`/a plain object
      // either way. Not a bypass of validation — the same reconciliation
      // `packages/studio/src/app/device/page.tsx`'s
      // `setSchema(b.deviceSchema as JsonSchemaNode)` already does for the
      // identical two-parallel-type situation.
      paramsSchema: row.paramsSchema as JsonSchemaNode | null,
      source: row.source,
      enabled: row.enabled ?? true,
      createdBy: row.createdBy,
      createdAt: row.createdAt ? Math.floor(row.createdAt.getTime() / 1000) : null,
      ...(includeBundle ? { bundle: row.bundle } : {}),
    }
    return typedJson(c, ScriptResponseSchema, { script })
  })

  // `script.publish`/`script.delete` (plan 34 §4.4, §4.5) — there is no
  // `script.manage` in the ACL matrix (`auth/acl.ts`), so each verb takes the
  // existing permission that already fits it: publishing a new version or
  // flipping `enabled` is `script.publish` (an OPERATOR permission, matching
  // the mutation-token guard above which never distinguished POST/PATCH
  // either); removing a script outright is the ADMIN-only `script.delete`,
  // exactly as its name and its comment in `acl.ts` already say.
  app.post('/', requirePermission('script.publish'), async (c) => {
    const body = PublishBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    }
    // Publish path 1 of 3 (plan 95 §4.9, §5 step 95.5) — the other two are
    // `verify-child-entry.ts` (plugin members) and `enkaku publish` itself
    // (`packages/sdk/src/cli/publish.ts`, checked locally before this route
    // ever sees the request). A hostile or merely oversized schema is
    // refused here too, so a hand-crafted request bypassing the CLI cannot
    // take a path the CLI would have refused.
    const findings = blockingFindings(checkParamsSchema(body.data.paramsSchema))
    if (findings.length > 0) {
      return c.json(
        {
          error: {
            code: 'E_PARAMS_SCHEMA_INVALID',
            message: findings.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)).join('; '),
            issues: findings.map((f) => ({ path: f.path, message: f.message })),
          },
        },
        400,
      )
    }
    const script = publishScript(db, body.data)
    deps.audit?.record({ userId: actorId(c), action: 'script.publish', target: script.id, meta: { name: script.name, version: script.version } })
    return c.json({ script }, 201)
  })

  app.patch('/:id', requirePermission('script.publish'), async (c) => {
    const body = PatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: 'a body of { enabled } is required' } }, 400)
    const row = db.select().from(scripts).where(eq(scripts.id, c.req.param('id'))).get()
    if (!row) throw new EnkakuError('script_not_found', 'no such script')
    db.update(scripts).set({ enabled: body.data.enabled }).where(eq(scripts.id, row.id)).run()
    deps.audit?.record({ userId: actorId(c), action: 'script.toggle', target: row.id, meta: { name: row.name, version: row.version, enabled: body.data.enabled } })
    return typedJson(c, ScriptToggleResponseSchema, { script: { id: row.id, enabled: body.data.enabled } })
  })

  app.delete('/:id', requirePermission('script.delete'), (c) => {
    const id = c.req.param('id')
    const row = db.select().from(scripts).where(eq(scripts.id, id)).get()
    if (!row) throw new EnkakuError('script_not_found', 'no such script')
    const active = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.scriptId, id), inArray(jobs.status, ['queued', 'running'])))
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
