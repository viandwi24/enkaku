import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { PluginActionBodySchema } from '@enkaku/protocol'
import { can } from '../auth/acl'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { AuditLogger } from '../auth/audit'
import type { Db } from '../db'
import { deviceNumbers, devices, kvEntries, type KvEntryRow } from '../db/schema'
import type { KvEntry, KvScope, KvStore } from '../kv/store'
import { actionPermission, createPluginActionExecutor, type PluginActionDeps } from '../plugins/action-executor'
import { PLUGIN_UI_CSP } from '../plugins/asset-store'
import { isPluginPackageContentType, readPluginPackage } from '../plugins/package'
import type { PluginRuntime, StagePluginInput } from '../plugins/runtime'
import { createSurfaceRegistry } from '../plugins/surface-registry'
import type { WorkspaceStore } from '../workspace/store'
import { EnkakuError } from '../util/errors'
import { redactEntry } from './kv'
import { decodeStringCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'

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
  // `POST /:name/enable` — a DIFFERENT version of the same name is already
  // active, so enabling would leave two active rows for one plugin. A
  // conflict, exactly like `plugin_activate_conflict` above.
  plugin_enable_conflict: 409,
  // Plan 110 §3.4, §4.3 — a real plugin claiming a name the farm owns
  // (`recordings`), and any lifecycle verb aimed at one of those synthetic
  // owners. Both are conflicts with what the farm already holds, not malformed
  // requests, so they sit with the four conflicts above.
  E_PLUGIN_RESERVED_NAME: 409,
  E_PLUGIN_SYNTHETIC: 409,
  E_BAD_REQUEST: 400,
  // The `/:name/data/*` routes (§4.5) reach the same store `/api/kv` does, so they can raise the
  // same errors — mapped to the same statuses `api/kv.ts`'s own `onError` gives them.
  E_NOT_FOUND: 404,
  E_STALE: 409,
  E_KV_KEY_INVALID: 400,
  E_KV_VALUE_TOO_LARGE: 400,
  E_KV_QUOTA_EXCEEDED: 400,
  E_KV_NOT_NUMBER: 400,
  // A malformed `.enkaku` upload (plan 108 §3.8, step 108.2) — a bad request
  // body, named the same way a bad JSON body is.
  E_PLUGIN_PACKAGE_INVALID: 400,
  // `GET /:name/view/:viewId` (plan 108 §3.5, step 108.6) — a plugin that is
  // live but declares no such screen. Distinct from `plugin_not_found`, which
  // is the INACTIVE-plugin case Studio renders as a named error.
  view_not_found: 404,
  // `GET /:name/ui/*` (plan 108 §4.4, step 108.10) — ONE code for all three
  // misses (not active, no `ui/` at all, no such path), deliberately: telling
  // them apart would tell a prober which of the three it hit.
  ui_asset_not_found: 404,
  // `POST /:name/action/:actionId` (step 108.5). The action id itself, then
  // every coded failure the three dispatch paths it calls can raise — mapped
  // to exactly the statuses `api/jobs.ts` and `api/batches.ts` already give
  // them, because this route reaches the SAME functions those two do and an
  // operator must not get a different answer for the same refusal.
  action_not_found: 404,
  script_not_found: 404,
  script_version_not_found: 404,
  script_ref_unresolved: 409,
  script_disabled: 409,
  script_is_dev: 409,
  unknown_script: 400,
  invalid_job_params: 400,
  device_not_found: 404,
  device_unavailable: 409,
  device_busy: 409,
  cluster_not_found: 404,
  E_NO_TARGETS: 409,
  'auth.forbidden': 403,
  E_RUNTIME_UNSUPPORTED: 400,
  E_RUNTIME_ENVELOPE_INVALID: 400,
  E_RUNTIME_OVER_CEILING: 400,
}

const ScopeKindSchema = z.enum(['global', 'device'])

/** `?scope=&stableId=` → a `KvScope`. The NAMESPACE is deliberately absent: it is never a caller
 * input on these routes, only the `:name` path segment (§3.7). */
function parseScope(scope: unknown, stableId: unknown): KvScope {
  const kind = ScopeKindSchema.safeParse(scope)
  if (!kind.success) throw new EnkakuError('E_BAD_REQUEST', 'scope must be "global" or "device"')
  if (kind.data === 'global') return { kind: 'global' }
  if (typeof stableId !== 'string' || stableId.length === 0) {
    throw new EnkakuError('E_BAD_REQUEST', 'stableId is required when scope is "device"')
  }
  return { kind: 'device', stableId }
}

/** `PUT /:name/data/entry`. There is NO `namespace` member, and that is the point (§3.7): the
 * body structurally cannot name a namespace, so a stray one is dropped by Zod before any store
 * call, not merely ignored by a later line that a future edit could forget. */
const DataWriteBody = z.object({
  scope: ScopeKindSchema,
  stableId: z.string().optional(),
  key: z.string().min(1),
  value: z.unknown(),
  secret: z.boolean().optional(),
  ttlSec: z.number().int().positive().optional(),
  ifVersion: z.number().int().optional(),
})

const DataDeleteBody = z.object({
  scope: ScopeKindSchema,
  stableId: z.string().optional(),
  key: z.string().min(1),
  ifVersion: z.number().int().optional(),
})

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** A joined `kv_entries` row → the wire entry, ALREADY redacted. Never decrypts: this is a
 * scan/list path, and `list()`'s own rule (`kv/store.ts`, criterion 10) is that browsing never
 * discovers a secret's plaintext. A secret's `value` is `null` before `redactEntry` even sees it. */
function rowToRedactedEntry(row: KvEntryRow): ReturnType<typeof redactEntry> {
  const entry: KvEntry = {
    key: row.key,
    value: row.secret ? null : (JSON.parse(row.value) as unknown),
    secret: row.secret,
    hint: row.hint,
    version: row.version,
    expiresAt: row.expiresAt ?? null,
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  }
  return redactEntry(entry)
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
  /**
   * Backs the five `/:name/data/*` routes (plan 108 §4.5, step 108.4). Optional so a caller that
   * only needs the lifecycle routes can construct this router unchanged; when it is absent the
   * data routes are not registered at all, rather than registered and failing at request time.
   */
  data?: { db: Db; kv: KvStore }
  /**
   * Backs `POST /:name/action/:actionId` (plan 108 §4.5, step 108.5). Optional for exactly the
   * same reason `data` above is — and it is the reason this step needs no `daemon.ts` edit to
   * keep the workspace typechecking: the action executor needs a `ScriptRegistry`, a `KvStore`,
   * a `JobService` and `createBatch`'s own dependency bag, none of which this router received
   * before, so they arrive as one optional key and the route exists only when a host supplies it.
   *
   * `runtime` and `audit` are omitted here because this router already HAS both — passing a
   * second of either would let a host wire an executor that audits somewhere else, or that
   * resolves a surface from a different runtime than the one `GET /:name/view/:viewId` reads.
   */
  actions?: Omit<PluginActionDeps, 'runtime' | 'audit'>
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

  /**
   * "Is a plugin of this name LIVE right now" — `active`, or holding a dev slot. Shared by the
   * five `/:name/data/*` routes (step 108.4) and by the surface routes below (steps 108.5/108.6),
   * so all of them answer the inactive-plugin case identically: 404 `plugin_not_found`, which
   * plan §3.5 requires Studio to render as a NAMED error rather than an empty table.
   *
   * Hoisted out of the `if (deps.data)` block it was written in so there is exactly one
   * definition of "live" in this file — a second copy is how the data routes and the view route
   * would come to disagree about whether a disabled plugin still has a screen.
   */
  const requireLivePlugin = (c: { req: { param(k: 'name'): string } }): string => {
    const name = c.req.param('name')
    if (!name) throw new EnkakuError('plugin_not_found', 'no plugin name given')
    if (runtime.active(name)) return name
    if (runtime.devSlots().some((s) => s.pluginName === name)) return name
    throw new EnkakuError('plugin_not_found', `no active plugin or dev slot named "${name}" — its data is not reachable`)
  }

  /**
   * The surface read routes (plan 108 §4.5, step 108.6), both `script.view` — an OPERATOR opens a
   * plugin's screen; nothing here mutates and nothing here reads a plugin's stored data (that is
   * `plugin.data`, on the `/data/*` routes above).
   *
   * `GET /ui` is a one-segment path and cannot be shadowed by `/:name/:version` (two), but it is
   * registered here beside `/dev` anyway — the same "keep the fixed paths together, before the
   * parameterised ones" discipline the `/dev` comment further down explains.
   */
  const surfaces = createSurfaceRegistry({ runtime })

  app.get('/ui', requirePermission('script.view'), (c) => c.json({ items: surfaces.ui() }))

  app.get('/:name/view/:viewId', requirePermission('script.view'), (c) => {
    const name = requireLivePlugin(c)
    const viewId = c.req.param('viewId')
    const resolved = surfaces.resolveView(name, viewId)
    if (!resolved) {
      // Live but contributes no screen at all, or no view by this id. Both are
      // `view_not_found` — the plugin itself is fine, and saying
      // `plugin_not_found` here would send Studio's error state to the wrong
      // explanation.
      throw new EnkakuError('view_not_found', `plugin "${name}" declares no view "${viewId}"`)
    }
    return c.json(resolved)
  })

  /**
   * `GET /:name/ui/*` (plan 108 §4.4, §4.5, step 108.10) — the tier-B assets
   * of the ACTIVE version of `:name`, and the one place a plugin's own bytes
   * are served to a browser.
   *
   * Registered here, beside the other surface reads: the pattern has three or
   * more segments, so `/:name/:version` (two) can never shadow it, and Hono
   * matches in registration order anyway.
   *
   * **Path traversal is closed by construction, not by sanitising.**
   * `:path{.+}` is handed straight to `runtime.uiAsset`, which looks it up by
   * EXACT match in the archive's own already-validated entry list and joins
   * only the sha256 it finds there onto a filesystem path
   * (`plugins/asset-store.ts`). `../`, `/etc/passwd`, a backslash, and a
   * percent-encoded `%2e%2e` that Hono has already decoded are all just keys
   * the index does not hold, and answer 404 for the same reason `nope.html`
   * does. Nothing here normalises, strips, or repairs a path — a repaired path
   * is a path whose safety depends on the repair being right.
   *
   * Every response carries `PLUGIN_UI_CSP` (see its doc comment for the
   * directive-by-directive reasoning) plus `nosniff`. `no-store` because the
   * gate is a permission check: a cached asset is one an operator who has since
   * lost `script.view` could still be served by their own browser.
   */
  app.get('/:name/ui/:path{.+}', requirePermission('script.view'), async (c) => {
    const name = c.req.param('name')
    const path = c.req.param('path')
    const asset = await runtime.uiAsset(name, path)
    if (!asset) {
      throw new EnkakuError('ui_asset_not_found', `no active plugin named "${name}" serves an asset at "ui/${path}"`)
    }
    return new Response(asset.data, {
      status: 200,
      headers: {
        'content-type': asset.contentType,
        'content-length': String(asset.bytes),
        'content-security-policy': PLUGIN_UI_CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      },
    })
  })

  /**
   * `POST /:name/action/:actionId` (plan 108 §4.5, step 108.5) — executes one DECLARED action
   * server-side. See `plugins/action-executor.ts` for the three reasons this cannot happen in the
   * browser.
   *
   * The permission is derived from the ACTION, not from the route (§3.7): `job`/`batch` need
   * `job.run`, `kv.set`/`kv.delete` need `plugin.data`, and a `form` takes whatever its `then`
   * resolves to. That is why there is no `requirePermission(...)` middleware on this line — the
   * gate cannot be known until the surface has been read, so it is applied inside, after the
   * lookup and before anything is dispatched.
   */
  if (deps.actions) {
    const executor = createPluginActionExecutor({ runtime, audit, ...deps.actions })

    app.post('/:name/action/:actionId', async (c) => {
      const name = requireLivePlugin(c)
      const actionId = c.req.param('actionId')
      const action = executor.lookup(name, actionId)

      const permission = actionPermission(action)
      const user = c.get('user')
      if (!user || !can(user.role, permission)) {
        return c.json({ error: { code: 'auth.forbidden', message: `requires the ${permission} permission` } }, 403)
      }

      // An empty body is legitimate: a toolbar action with no row, no form and
      // an `all` target sends nothing at all.
      const raw = await c.req.json().catch(() => ({}))
      const body = PluginActionBodySchema.safeParse(raw ?? {})
      if (!body.success) {
        throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
      }

      const result = executor.execute({
        plugin: name,
        actionId,
        row: body.data.row,
        form: body.data.form,
        deviceIds: body.data.deviceIds,
        actor: { id: user.id, role: user.role },
      })
      return c.json({ plugin: name, actionId, result })
    })
  }

  /**
   * `/:name/data/*` (plan 108 §3.7, §4.5, step 108.4) — one plugin's own KV namespace, for an
   * OPERATOR (`plugin.data`), where `/api/kv` needs an admin (`kv.manage`, untouched by this).
   *
   * Two invariants hold on every one of the five, and they are what make the narrower permission
   * defensible rather than a loophole:
   *
   * 1. **The namespace is forced.** It is `:name`, never a query parameter and never a body
   *    member — `DataWriteBody`/`DataDeleteBody` above have no `namespace` field to supply, and
   *    every `store`/SQL call below passes `name` positionally. There is no request shape that
   *    reaches a namespace other than the path's.
   * 2. **`:name` must be live.** `requireLivePlugin` refuses with 404 unless a plugin of that
   *    name is `active` or holds a dev slot, so `:name` cannot be used to conjure or read an
   *    arbitrary namespace (a traversal-looking value like `../other` simply is not a live
   *    plugin, which is why nothing here sanitises the string — it is checked, not cleaned).
   *
   * Registered BEFORE `/:name/:version` for the same reason `/dev` is (see the comment further
   * down): `GET /:name/data` is a two-segment pattern that `/:name/:version` would otherwise
   * swallow as `version='data'`. Hono matches in registration order.
   */
  if (deps.data) {
    const { db, kv } = deps.data

    /** Non-expired rows only: an entry past its TTL reads as absent everywhere else in the KV
     * surface (`kv/store.ts` §4.5), so counting or joining one here would contradict the very
     * list the same operator is looking at. */
    const liveEntry = (now: number) => or(isNull(kvEntries.expiresAt), gt(kvEntries.expiresAt, now))

    app.get('/:name/data', requirePermission('plugin.data'), (c) => {
      const name = requireLivePlugin(c)
      const q = c.req.query()
      const scope = parseScope(q.scope, q.stableId)
      const limitParam = q.limit ? Number.parseInt(q.limit, 10) : 50
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50
      // `cursor` is the last key of the previous page, plain — `KvStore.list`'s own envelope, not
      // `api/pagination.ts`'s base64 one (that store documents the deviation; `/api/kv` matches).
      const page = kv.list(scope, name, { prefix: q.prefix, limit, cursor: q.cursor ?? null })
      return c.json({ items: page.items.map(redactEntry), nextCursor: page.nextCursor })
    })

    app.put('/:name/data/entry', requirePermission('plugin.data'), async (c) => {
      const name = requireLivePlugin(c)
      const parsed = DataWriteBody.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) {
        throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
      }
      const body = parsed.data
      const scope = parseScope(body.scope, body.stableId)
      const opts = { secret: body.secret, ttlSec: body.ttlSec }

      let entry: KvEntry | null
      if (body.ifVersion !== undefined) {
        entry = kv.setIfVersion(scope, name, body.key, body.value, body.ifVersion, opts)
        if (!entry) throw new EnkakuError('E_STALE', `"${body.key}" changed since the given version (${body.ifVersion})`)
      } else {
        entry = kv.set(scope, name, body.key, body.value, opts)
      }

      audit.record({
        userId: actorId(c),
        action: 'plugin.data.set',
        target: body.key,
        // Never the value — the same rule `api/kv.ts`'s own audit line states.
        meta: { plugin: name, scope: body.scope, stableId: body.stableId ?? null, secret: !!body.secret },
      })
      return c.json(redactEntry(entry), 200)
    })

    app.delete('/:name/data/entry', requirePermission('plugin.data'), async (c) => {
      const name = requireLivePlugin(c)
      // Body OR query (§4.5) — a DELETE with a body is awkward for some clients, so both are
      // accepted; the body wins when it parses, and the query is the fallback.
      const raw = await c.req.json().catch(() => null)
      const fromBody = DataDeleteBody.safeParse(raw)
      const q = c.req.query()
      const input = fromBody.success
        ? fromBody.data
        : (() => {
            const fromQuery = DataDeleteBody.safeParse({
              scope: q.scope,
              stableId: q.stableId,
              key: q.key,
              ifVersion: q.ifVersion === undefined ? undefined : Number.parseInt(q.ifVersion, 10),
            })
            if (!fromQuery.success) {
              throw new EnkakuError('E_BAD_REQUEST', fromQuery.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
            }
            return fromQuery.data
          })()
      const scope = parseScope(input.scope, input.stableId)
      const deleted = kv.delete(scope, name, input.key, { ifVersion: input.ifVersion })
      audit.record({
        userId: actorId(c),
        action: 'plugin.data.delete',
        target: input.key,
        meta: { plugin: name, scope: input.scope, stableId: input.stableId ?? null, deleted },
      })
      return c.json({ ok: deleted })
    })

    app.get('/:name/data/count', requirePermission('plugin.data'), (c) => {
      const name = requireLivePlugin(c)
      const now = nowSeconds()
      const countIn = (kind: 'global' | 'device'): number => {
        const row = db
          .select({ n: sql<number>`count(*)` })
          .from(kvEntries)
          .where(and(eq(kvEntries.scope, kind), eq(kvEntries.namespace, name), liveEntry(now)))
          .get()
        return row?.n ?? 0
      }
      return c.json({ global: countIn('global'), device: countIn('device') })
    })

    app.get('/:name/data/scan', requirePermission('plugin.data'), (c) => {
      const name = requireLivePlugin(c)
      const key = c.req.query('key')
      if (typeof key !== 'string' || key.length === 0) throw new EnkakuError('E_BAD_REQUEST', 'key is required')
      const { cursor: rawCursor, limit } = parsePageQuery(c)
      const cursor = decodeStringCursor(rawCursor)
      const now = nowSeconds()

      // ONE statement (§4.5). The LEFT JOIN is what makes "every device, whether or not it holds
      // the key" free: a device with no row simply joins to nulls and reports `entry: null`. The
      // alternative — list devices, then one `kv.get` each — is the N+1 this shape exists to
      // prevent, and `plugins-data.test.ts` times 200 devices to keep it that way.
      //
      // `device_numbers` rides the SAME statement, as a second LEFT JOIN on `stableId` — the key
      // that table is deliberately reserved against (plan 89 §3.1), never `devices.id`. It is a
      // LEFT join for the same reason the entry one is: a device with no allocated number is
      // normal, and reports `number: null` rather than dropping out of the page. A per-device
      // `lookupDeviceNumber` would reintroduce exactly the N+1 the tripwire above guards.
      const rows = db
        .select({
          // The §3.6 allowlist, and nothing else. Selected narrowly rather than filtered later,
          // so a seventh field cannot arrive by accident.
          device: { id: devices.id, stableId: devices.stableId, label: devices.label, status: devices.status, clusterId: devices.clusterId },
          number: deviceNumbers.number,
          entry: kvEntries,
        })
        .from(devices)
        .leftJoin(kvEntries, and(eq(kvEntries.scope, 'device'), eq(kvEntries.scopeId, devices.stableId), eq(kvEntries.namespace, name), eq(kvEntries.key, key), liveEntry(now)))
        .leftJoin(deviceNumbers, eq(deviceNumbers.stableId, devices.stableId))
        .where(keysetWhere(cursor ? { value: cursor.sortValue, id: cursor.id } : null, devices.stableId, devices.id, 'asc'))
        .orderBy(asc(devices.stableId), asc(devices.id))
        .limit(limit + 1)
        .all()

      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      const nextCursor = rows.length > limit && last ? encodeCursor(last.device.stableId, last.device.id) : null
      return c.json({
        items: page.map((r) => ({
          deviceId: r.device.id,
          stableId: r.device.stableId,
          label: r.device.label,
          status: r.device.status,
          clusterId: r.device.clusterId,
          number: r.number ?? null,
          entry: r.entry ? rowToRedactedEntry(r.entry) : null,
        })),
        nextCursor,
      })
    })
  }

  app.get('/:name/:version', (c) => {
    const row = runtime.get(c.req.param('name'), c.req.param('version'))
    if (!row) throw new EnkakuError('plugin_not_found', 'no such plugin version')
    return c.json({ plugin: row })
  })

  // Stage + verify in one call (§3.7 steps 1-2) — activation stays a separate, explicit call
  // (§3.9's own reasoning: nothing about publishing should ever change what is currently live).
  //
  // TWO REQUEST SHAPES, ONE ROUTE (plan 108 §3.8, step 108.2):
  //
  //   - `application/json` — the original `{ name, version, bundle, source?, stageOnly? }`,
  //     unchanged. `StageBody` still parses the same body, and the same three runtime calls
  //     run in the same order with the same values.
  //   - `application/octet-stream` (or `application/gzip`) — a `.enkaku` package, sent RAW.
  //     `?stageOnly=1` replaces the body flag, since an archive has no room for one.
  //
  // Why raw bytes rather than a base64 member on the JSON body. Base64 costs +33% on a
  // payload that may carry up to 8 MiB of `ui/` assets — the exact overhead §3.8 chose a real
  // archive to avoid — and it would force `StageBody` into a union, changing the code path
  // every existing publish takes. Branching on `content-type` BEFORE the body is read leaves
  // the JSON path literally untouched, which is what this step is required to keep.
  //
  // The package's `ui/` payload is validated here (the entry allowlist and `maxUiBytes`, in
  // `plugins/package.ts`) and — since step 108.10 — PERSISTED: it rides into `runtime.stage`
  // as `ui`, which materialises it under `<dataDir>/plugins/` keyed by the new row's id
  // before the row is inserted (`plugins/asset-store.ts`). `GET /:name/ui/*` above reads it
  // back off the active row. The JSON transport carries no assets and is unchanged.
  app.post('/', requirePermission('script.publish'), async (c) => {
    let input: StagePluginInput
    let stageOnly: boolean

    if (isPluginPackageContentType(c.req.header('content-type'))) {
      const pkg = readPluginPackage(new Uint8Array(await c.req.arrayBuffer()))
      input = { name: pkg.manifest.name, version: pkg.manifest.version, bundle: pkg.scripts, source: pkg.manifest.source, ui: pkg.ui }
      stageOnly = c.req.query('stageOnly') === '1' || c.req.query('stageOnly') === 'true'
    } else {
      const body = StageBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) {
        return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
      }
      const { stageOnly: bodyStageOnly, ...rest } = body.data
      input = rest
      stageOnly = bodyStageOnly === true
    }

    const staged = await runtime.stage({ ...input, createdBy: actorId(c) })
    audit.record({ userId: actorId(c), action: 'plugin.publish', target: staged.id, meta: { name: staged.name, version: staged.version } })
    if (stageOnly) return c.json({ plugin: staged }, 201)
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

  /**
   * The way back from `POST /:name/disable` — a `disabled` plugin is otherwise
   * unreachable by every other transition (`activate` CASes on `staged`,
   * `rollback` needs `superseded`/`active`, `reload` needs `failed`/`active`).
   *
   * Same permission as `disable` (`script.publish`), same two-segment shape,
   * and no route registered before this one can swallow it: `/:id/verify`,
   * `/:id/activate`, `/:name/rollback`, `/:name/disable` all fix their SECOND
   * segment to a different literal, and `GET /:name/:version` is a GET.
   *
   * Answers `{ plugin }` — the same shape `activate`/`rollback` do, since it
   * ends the same way they do (a row that is now `active`), where `disable`
   * has no row to report and answers `{ ok: true }`.
   */
  app.post('/:name/enable', requirePermission('script.publish'), (c) => {
    const row = runtime.enable(c.req.param('name'))
    audit.record({ userId: actorId(c), action: 'plugin.enable', target: row.id, meta: { name: row.name, version: row.version } })
    return c.json({ plugin: row })
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
