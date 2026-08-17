import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { PLUGIN_HTTP_METHODS, PLUGIN_WEBHOOK_SIGNATURE_HEADER, type PluginHttpMethod, PluginActionBodySchema } from '@enkaku/protocol'
import { can } from '../auth/acl'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { AuditLogger } from '../auth/audit'
import type { Db } from '../db'
import { deviceNumbers, devices, kvEntries, type KvEntryRow } from '../db/schema'
import type { KvEntry, KvScope, KvStore } from '../kv/store'
import { actionPermission, createPluginActionExecutor, type PluginActionDeps } from '../plugins/action-executor'
import { isPluginPackageContentType, readPluginPackage } from '../plugins/package'
import type { PluginRuntime, StagePluginInput } from '../plugins/runtime'
import type { RuntimeHost } from '../plugins/runtime-host'
import { filterRequestHeaders, resolvePluginHandler, runHttpHandler, runQueryHandler } from '../plugins/service-routes'
import { deliverWebhook, type WebhookRateLimiter } from '../plugins/webhook-routes'
import type { PluginWebhookStore } from '../plugins/webhook-secrets'
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
  // The three plugin-service route families (plan 109 §4.6, step 109.6). The
  // order these are raised in is `plugins/service-routes.ts`'s, and the STATUS
  // each carries is the other half of the same honesty: an operator's browser,
  // and anything else that retries on a 5xx, has to be able to tell "not yet"
  // from "broken" from "you asked for something that is not here".
  //
  // 503 for every service-state refusal — the resource exists and the server
  // cannot serve it right now, which is exactly what 503 means. 404 would say
  // the route is wrong (it is not) and 409 would say the request conflicts with
  // state the caller could change (it cannot; only Restart can).
  E_PLUGIN_RUNTIME_STARTING: 503,
  E_PLUGIN_RUNTIME_NOT_RUNNING: 503,
  E_PLUGIN_RUNTIME_NOT_LOADED: 503,
  E_PLUGIN_RUNTIME_DISABLED: 503,
  // A dev slot's service is not loaded at all — a NAMED refusal rather than the
  // 404 this would otherwise read as. See `service-routes.ts` on why the gap is
  // reported instead of worked around.
  E_PLUGIN_DEV_SLOT_NO_SERVICE: 409,
  E_PLUGIN_NO_SERVICE: 409,
  E_PLUGIN_HANDLER_NOT_FOUND: 404,
  E_PLUGIN_HANDLER_METHOD_NOT_ALLOWED: 405,
  // The plugin's own code failed or overran. 502/504 and not 500: the core is
  // fine, and an upstream that misbehaved is precisely what those two mean.
  E_PLUGIN_HANDLER_FAILED: 502,
  E_PLUGIN_HANDLER_TIMEOUT: 504,
  // A query handler answered a shape this farm cannot render. 502 for the same
  // reason — the fault is upstream of the core, in the plugin.
  E_PLUGIN_QUERY_RESULT_INVALID: 502,
  // Inbound webhooks (plan 109 §3.7, step 109.7). Most of these never reach
  // `onError` — `deliverWebhook` answers them itself, so it can write ONE audit
  // row on every path — but they are mapped here so the two agree and so a code
  // that escapes as a throw lands on the same status.
  //
  // `E_PLUGIN_WEBHOOK_UNKNOWN` is 404 and deliberately says nothing: it is the
  // answer for an unknown plugin, an undeclared webhook, and one whose secret
  // has never been generated, because an unauthenticated caller does not get to
  // enumerate this farm's plugins.
  E_PLUGIN_WEBHOOK_UNKNOWN: 404,
  E_PLUGIN_WEBHOOK_SIGNATURE: 401,
  E_PLUGIN_WEBHOOK_RATE_LIMITED: 429,
  E_PLUGIN_WEBHOOK_TOO_LARGE: 413,
  E_PLUGIN_WEBHOOK_BODY_INVALID: 400,
  // `ctx.webhooks` on a host with no store wired, and a handler registered for
  // a webhook the manifest does not declare. Both are authoring/wiring faults,
  // not request faults.
  E_PLUGIN_WEBHOOK_UNAVAILABLE: 503,
  E_PLUGIN_WEBHOOK_UNDECLARED: 409,
}

/**
 * The status one of this router's coded errors answers with — exported so the
 * plugin WebSocket handshake refuses the SAME code with the SAME status.
 *
 * A WS upgrade happens in `Bun.serve`'s own `fetch`, before Hono is reached, so
 * `daemon.ts` cannot reuse `app.onError` and would otherwise have to restate
 * the map. Two maps is how a handshake comes to answer 500 for the refusal a
 * REST call answers 503 for, and a browser retries one of those and gives up on
 * the other.
 */
export function pluginRouteErrorStatus(code: string): number {
  return ERROR_STATUS[code] ?? 500
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
  /**
   * Backs the three plugin-SERVICE route families (plan 109 §4.6, step 109.6):
   * `ctx.onRequest` under `/:name/http/*`, `ctx.onQuery` under
   * `/:name/query/:queryId`, and the Restart the failed-service error state
   * offers. Optional for exactly the reason `data` and `actions` above are —
   * a host that has not built a runtime host does not get routes that would
   * fail at request time.
   *
   * The WebSocket family (`ctx.onSocket`) is deliberately NOT here: a WS
   * upgrade happens in `Bun.serve`'s own `fetch`, before Hono is reached, so it
   * is wired in `daemon.ts` against `plugins/service-socket.ts`. The path it
   * answers comes from `@enkaku/protocol`'s `pluginSocketPath`, so the two
   * halves cannot drift.
   */
  service?: {
    host: RuntimeHost
    /**
     * The inbound webhook family (plan 109 §3.7, step 109.7). Optional for the
     * same reason the bags above are: a host that has not built a webhook store
     * does not get a route that would fail at request time.
     *
     * `limiter` is passed in rather than created here so its window survives a
     * router rebuild and so a test can drive it deterministically. `daemon.ts`
     * makes exactly one.
     */
    webhooks?: { store: PluginWebhookStore; limiter: WebhookRateLimiter }
  }
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
   * `GET /:name/ui/*` (plan 108 §4.4, §4.5, step 108.10) — the `ui/` assets of
   * `:name`, and the one place a plugin's own bytes are served to a browser.
   * `runtime.uiAsset` resolves a DEV SLOT ahead of the active row (plan 111
   * §4.4, step 111.6), so `enkaku dev` iterates a React view; this route does
   * not know or care which of the two answered.
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
   * Three response headers, and deliberately no `Content-Security-Policy`.
   * `nosniff` so a module whose content type is not a JavaScript MIME is
   * refused rather than sniffed into running; `no-referrer`; and `no-store`,
   * which does double duty — the gate is a permission check, so a cached asset
   * is one an operator who has since lost `script.view` could still be served
   * by their own browser, and it is also what makes an `enkaku dev` rebuild
   * serve the new component rather than the browser's copy of the old one
   * (plan 111 criterion 8). Plan 108's strict CSP was removed by step 111.4;
   * `plugins/asset-store.ts` keeps the full reasoning where the constant used
   * to be.
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

  /**
   * The plugin-SERVICE route families (plan 109 §4.6, step 109.6).
   *
   * Registered here rather than in their own router, and that is not an
   * accident of taste: `plugins-route-parity.test.ts` reads THIS FILE's source
   * to find every route a plugin can be reached at, and a family that lived in
   * another file would be invisible to the one guard whose whole job is
   * noticing a route with no way in. The logic is in
   * `plugins/service-routes.ts`; the registrations are here so they can be
   * counted.
   *
   * Registered BEFORE `/:name/:version` for the same reason `/dev` and the
   * `/:name/data/*` group are — Hono matches in registration order — even
   * though all three of these have three or more segments and a two-segment
   * pattern could not swallow them anyway.
   */
  if (deps.service) {
    const service = { plugins: runtime, host: deps.service.host }

    /**
     * `GET /:name/query/:queryId` — a `ctx.onQuery` handler, and what plan
     * 108's `{ kind: 'handler' }` data source calls.
     *
     * `plugin.data`, fixed by the route and not by the handler: this is the
     * read half of a plugin's own data surface, sitting beside
     * `GET /:name/data` and `GET /:name/data/scan`, which are gated on exactly
     * that. It is the one family whose permission a plugin does not choose.
     *
     * **Not audited, and the reason is worth writing down rather than being an
     * omission.** `GET /:name/data` and `/data/scan` are not audited either;
     * this is the same read path with the rows assembled by the plugin instead
     * of by a `LEFT JOIN`, and auditing it would make one table's own refresh
     * loop the loudest thing in the log while its `kv.scan` twin stayed silent.
     * The honest residual: a query handler is still plugin code and could
     * mutate. What makes that visible is not a row here — it is that everything
     * it reaches through `ctx.farm` is audited under `plugin:<name>` regardless
     * of which handler was running (step 109.3).
     */
    app.get('/:name/query/:queryId', requirePermission('plugin.data'), async (c) => {
      const name = requireLivePlugin(c)
      const queryId = c.req.param('queryId')
      const user = c.get('user')
      const { registration } = resolvePluginHandler(service, { plugin: name, kind: 'query', id: queryId, caller: user })
      if (registration.kind !== 'query') throw new EnkakuError('E_PLUGIN_HANDLER_NOT_FOUND', `"${queryId}" is not a query handler`)
      const query = c.req.query()
      const { cursor, ...rest } = query
      const result = await runQueryHandler(service.host, registration, {
        query: rest,
        cursor: typeof cursor === 'string' && cursor.length > 0 ? cursor : null,
        caller: { id: user!.id, role: user!.role },
      })
      return c.json({ plugin: name, queryId, items: result.items, nextCursor: result.nextCursor })
    })

    /**
     * `/:name/http/*` — a `ctx.onRequest` handler. One registration for all
     * five methods (`app.on`), because the METHODS a handler answers are the
     * handler's own declaration and are checked after the lookup, not by which
     * route matched.
     *
     * No `requirePermission(...)` middleware, for the reason
     * `POST /:name/action/:actionId` has none: the gate is the HANDLER's, and a
     * handler does not exist when the route is registered at boot. It is
     * applied inside `resolvePluginHandler`, after the service is known to be
     * running and before a byte of plugin code runs.
     *
     * **Audited, on every method including GET.** The farm cannot know whether
     * a plugin's handler mutates — `GET /http/wipe` is a perfectly legal thing
     * for a plugin to write — so filtering by method would be a guess dressed
     * as a policy. The row names the human; the `plugin.capability` /
     * `capability.invoke` rows the handler then causes name `plugin:<name>`,
     * and joining the two is the only way to answer "who set this off".
     */
    app.on([...PLUGIN_HTTP_METHODS], '/:name/http/:path{.+}', async (c) => {
      const name = requireLivePlugin(c)
      const raw = c.req.param('path')
      const slash = raw.indexOf('/')
      const handlerId = slash >= 0 ? raw.slice(0, slash) : raw
      const subPath = slash >= 0 ? raw.slice(slash) : '/'
      const method = c.req.method.toUpperCase() as PluginHttpMethod
      const user = c.get('user')
      const { registration, caller } = resolvePluginHandler(service, { plugin: name, kind: 'http', id: handlerId, caller: user, method })
      if (registration.kind !== 'http') throw new EnkakuError('E_PLUGIN_HANDLER_NOT_FOUND', `"${handlerId}" is not an HTTP handler`)

      // JSON or nothing. A plugin route is a JSON route: a body that is absent,
      // empty, or not JSON arrives as `null` rather than as a parse failure the
      // plugin never asked to handle.
      const body = method === 'GET' ? null : ((await c.req.json().catch(() => null)) as unknown)
      const outcome = await runHttpHandler(service.host, registration, {
        method,
        path: subPath,
        query: c.req.query(),
        headers: filterRequestHeaders((h) => c.req.header(h)),
        body,
        caller,
      })

      audit.record({
        userId: caller.id,
        action: 'plugin.http',
        target: `${name}/${handlerId}`,
        // Never the body and never the query: either can carry a secret, the
        // same rule `kv.set`, `command.run` and `plugin.capability` state.
        meta: { plugin: name, handler: handlerId, method, status: outcome.status, permission: registration.permission },
      })

      if (outcome.status === 204) return c.body(null, 204, outcome.headers)
      return c.json(outcome.body, outcome.status as 200, outcome.headers)
    })

    /**
     * `POST /:name/webhook/:webhookId` — an inbound webhook (plan 109 §3.7 row
     * 2, §4.6, step 109.7). **The only route in this file that runs with no
     * session**, exempted in `auth/middleware.ts` against the protocol's own
     * matcher, for the reason `/api/nodes/enroll` is: the credential is in the
     * request. The per-webhook HMAC signature over the exact bytes below is the
     * authorisation, compared in constant time by the helper this farm's
     * outbound deliveries already sign with.
     *
     * No `requireLivePlugin`, and that is not an omission. That helper answers
     * `plugin_not_found` for an unknown name, which is a fine answer for an
     * operator and a plugin-name oracle for a stranger.
     * `plugins/webhook-routes.ts` asks the same six questions
     * `service-routes.ts` orders — through the same two functions, so a webhook
     * to a stopped service says so rather than 404ing — but it asks them AFTER
     * the signature, and collapses everything before it into one indistinguishable
     * refusal.
     *
     * **One audit row on every path**, including the ones where no plugin code
     * ran: a stranger probing this URL with a wrong signature is precisely the
     * event an operator wants in the log, and it is bounded by the same rate
     * limiter that gates the crypto. `userId` is `webhook:<plugin>/<id>` — a
     * named absence, because there is no operator and `null` would say less
     * (see `auth/audit.ts`).
     */
    if (deps.service.webhooks) {
      const { store: webhookStore, limiter } = deps.service.webhooks
      const webhookDeps = { ...service, webhooks: webhookStore, limiter }

      app.post('/:name/webhook/:webhookId', async (c) => {
        const name = c.req.param('name')
        const webhookId = c.req.param('webhookId')
        const principal = `webhook:${name}/${webhookId}`

        // `content-length` first, when the sender offered one: the declared cap
        // is re-checked on the real bytes below, but refusing an announced
        // 50 MiB before buffering it is the difference between a 413 and a
        // memory spike anyone can cause.
        const announced = Number.parseInt(c.req.header('content-length') ?? '', 10)
        const declaredCap = runtime.service(name)?.webhooks.find((w) => w.id === webhookId)?.maxBodyBytes
        if (declaredCap !== undefined && Number.isFinite(announced) && announced > declaredCap) {
          audit.record({
            userId: principal,
            action: 'plugin.webhook',
            target: `${name}/${webhookId}`,
            meta: { plugin: name, webhook: webhookId, outcome: 'too-large', status: 413, bytes: announced },
          })
          throw new EnkakuError('E_PLUGIN_WEBHOOK_TOO_LARGE', `this webhook accepts at most ${declaredCap} bytes`)
        }

        // The RAW text, never `c.req.json()`: the signature covers the bytes the
        // sender sent, and `JSON.parse` then `JSON.stringify` is a different
        // string and a different MAC.
        const rawBody = await c.req.text().catch(() => '')
        const bytes = Buffer.byteLength(rawBody, 'utf8')
        let outcome
        try {
          outcome = await deliverWebhook(webhookDeps, {
            plugin: name,
            webhookId,
            rawBody,
            signature: c.req.header(PLUGIN_WEBHOOK_SIGNATURE_HEADER),
            query: c.req.query(),
            header: (h) => c.req.header(h),
          })
        } catch (err) {
          // "One row on every path" has to mean every path, and the thrown ones
          // are the interesting half: a validly signed delivery arriving at a
          // service that is down, or at a handler the running service never
          // registered. Without this the log would record only the requests the
          // plugin actually saw, which is the opposite of what an operator
          // debugging a silent integration needs.
          const code = err instanceof EnkakuError ? err.code : 'E_PLUGIN_HANDLER_FAILED'
          audit.record({
            userId: principal,
            action: 'plugin.webhook',
            target: `${name}/${webhookId}`,
            meta: { plugin: name, webhook: webhookId, outcome: 'refused', code, status: pluginRouteErrorStatus(code), bytes },
          })
          throw err
        }

        audit.record({
          userId: principal,
          action: 'plugin.webhook',
          target: `${name}/${webhookId}`,
          // Never the body, never the signature, never the secret — the same
          // rule `plugin.http` states, and here the body is the one thing a
          // third party controls entirely.
          meta: {
            plugin: name,
            webhook: webhookId,
            outcome: outcome.outcome,
            status: outcome.status,
            bytes,
            secret: outcome.acceptedKey,
          },
        })

        if (outcome.status === 204) return c.body(null, 204, outcome.headers)
        return c.json(outcome.body, outcome.status as 200, outcome.headers)
      })
    }

    /**
     * `POST /:name/runtime/restart` — the Restart a failed-service error state
     * offers (criterion 21), and the only lifecycle verb this step ships.
     *
     * `plugin.runtime`, the new operator permission §4.6 names. Not
     * `script.publish`: restarting a service changes nothing about which
     * version is live, and an operator who may run a plugin should be able to
     * bring its service back without being able to publish one.
     *
     * `GET /:name/runtime` and `start`/`stop` are step 109.12's, with the panel
     * that reads them — a route with no way in is what the parity guard exists
     * to fail on, and "nobody has built the UI yet" is not an admissible reason
     * for one.
     *
     * The response carries the STATUS, never a bare `{ ok: true }`: a restart
     * that lands on `starting` has not started, and an operator reading
     * "restarted" would believe otherwise.
     */
    app.post('/:name/runtime/restart', requirePermission('plugin.runtime'), async (c) => {
      const name = requireLivePlugin(c)
      if (!runtime.active(name)) {
        throw new EnkakuError(
          'E_PLUGIN_DEV_SLOT_NO_SERVICE',
          `"${name}" is running from a dev slot, and a dev slot's service is not loaded — there is nothing to restart. ` +
            `Publish and activate the plugin to run its service (docs/plans/109-m74-plugin-runtime.md §9).`,
        )
      }
      if (!runtime.service(name)) {
        throw new EnkakuError('E_PLUGIN_NO_SERVICE', `plugin "${name}" declares no service — there is nothing to restart.`)
      }
      let status: string
      try {
        status = (await service.host.reload(name)).status
      } catch (err) {
        // A service that fails to START is a real answer, not a 500: the host
        // has already recorded `failed` with the error verbatim, and that is
        // what the operator needs to see. Re-read rather than invented.
        status = service.host.get(name)?.status ?? 'failed'
        audit.record({ userId: actorId(c), action: 'plugin.runtime', target: name, meta: { verb: 'restart', status, ok: false } })
        throw err instanceof EnkakuError ? err : new EnkakuError('E_PLUGIN_HANDLER_FAILED', String(err))
      }
      audit.record({ userId: actorId(c), action: 'plugin.runtime', target: name, meta: { verb: 'restart', status, ok: true } })
      return c.json({ plugin: name, status })
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
  //
  // THREE REQUEST SHAPES, ONE ROUTE (plan 111 §4.4, step 111.6). The two JSON
  // ones are plan 82's and are untouched — `{ name, entryPath }` (front-end A,
  // a workspace path the farm bundles itself) and `{ name, bundle }`
  // (front-end B, `enkaku dev`'s local build). The third is a raw `.enkaku`
  // package, read exactly the way `POST /` above reads one, and it exists
  // because plan 108 §9 Q3 left a React view impossible to iterate: a slot
  // built from a bare bundle structurally carries no `ui/`, so every asset the
  // view asked for answered 404 until it was published.
  //
  // The package's manifest NAMES the slot — there is no `?name=` override — so
  // both transports carry the name in exactly one place. The version in the
  // manifest is ignored here: a dev slot's `declaredVersion` comes from the
  // verify report, as it always has.
  app.post('/dev', requirePermission('script.publish'), async (c) => {
    if (isPluginPackageContentType(c.req.header('content-type'))) {
      const pkg = readPluginPackage(new Uint8Array(await c.req.arrayBuffer()))
      const owner = deps.devOwnerFromRequest?.(c) ?? { kind: 'cli' as const, label: actorId(c) ?? 'an unknown session' }
      const report = await runtime.putDevSlot({
        name: pkg.manifest.name,
        owner,
        source: { kind: 'bundle', bundle: pkg.scripts },
        ui: pkg.ui,
      })
      audit.record({ userId: actorId(c), action: 'plugin.dev', target: pkg.manifest.name, meta: { ok: report.ok, ui: pkg.ui.length } })
      return c.json(report)
    }

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
    // Plan 109 step 109.7 — the last version of a plugin taking its webhook
    // secrets with it. Not on every removal, and not on `deleteKv` alone: a
    // secret has to survive a rollback (that is criterion 13's whole point), so
    // it is only dropped when nothing named `name` is left. What is left behind
    // otherwise would be a live credential for a URL that answers 404, which is
    // worse than useless — it is a credential nobody is watching.
    let webhooksDeleted = 0
    if (runtime.list({ name }).length === 0) webhooksDeleted = deps.service?.webhooks?.store.forget(name) ?? 0
    audit.record({ userId: actorId(c), action: 'plugin.delete', target: `${name}@${version}`, meta: { ...result, webhooksDeleted } })
    return c.json(result)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
