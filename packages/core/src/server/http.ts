import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import type { AuthMode } from '../config'
import { authMiddleware, type AuthEnv } from '../auth/middleware'
import type { ApiTokenService } from '../auth/api-tokens'
import type { AuthService } from '../auth/service'
import type { AuditLogger } from '../auth/audit'
import type { DeviceInfo } from '@enkaku/protocol'
import { HealthResponseSchema } from '@enkaku/protocol'
import { ToolchainError, type ToolchainManager } from '@enkaku/toolchain'
import { buildRegistryResponse } from '../registry/engines'
import { createToolsRoutes, type AdbControlRouteDeps, type AppRestartRouteDeps } from '../tools/routes'
import { createStudioServer } from './studio'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { createSlowLogger } from '../util/slow-log'
import { typedJson } from '../api/typed-json'

export interface HttpDeps {
  listDevices: () => DeviceInfo[]
  deviceCount: () => number
  log: Logger
  version: string
  adbServerVersion: () => Promise<string | null>
  /** The adb subsystem's status: 'provisioning' | 'ready' | 'error'. */
  adbState: () => string
  /**
   * How many plugin rows sit in `failed` — `GET /api/health`'s
   * `failedPlugins` (plan 126 §3.5, step 126.5). Studio's sidebar reads it
   * off the health poll it already makes, instead of downloading the entire
   * plugin list on every page to filter one status (plan 126 §0.4).
   *
   * **Optional for the same reason `audit`/`adbControl` below are**: several
   * tests build a minimal `HttpDeps` with no database behind it. When it is
   * absent the field is OMITTED from the response rather than sent as `0` —
   * "nobody counted" and "counted, none failed" are different answers, and a
   * confident zero here would silently hide a farm-health warning.
   *
   * **It must be a `COUNT(*)`, never a list-and-length.** Health is polled,
   * and `db/schema.ts:1865`'s `bundle` column holds the plugin's full built
   * JavaScript (~1 MB per version row) — the exact mistake plan 126 §0.5
   * found in `runtime.ts`'s `scriptCountFor` and fixed in step 126.1. See
   * `daemon.ts`'s wiring for the query and why it never touches a bundle.
   */
  failedPluginCount?: () => number
  /**
   * The audit logger, threaded through so the Toolchain routes can record
   * install/activate/delete/repair. Optional because several tests build a
   * minimal `HttpDeps`; when absent those routes simply do not audit.
   */
  audit?: AuditLogger
  toolchain: ToolchainManager
  /**
   * The "Restart adb server" button's deps (plan 88 §3.10, §4.8, §5 step
   * 88.8) — optional for the same reason `audit` is: several tests build a
   * minimal `HttpDeps`, and a host with no adb subsystem (orchestrator mode,
   * or before boot finishes provisioning) genuinely has nothing to restart.
   * `createToolsRoutes` reports `E_ADB_UNAVAILABLE` on `/adb/restart` when
   * this is absent, rather than the route not existing at all.
   */
  adbControl?: AdbControlRouteDeps
  /**
   * "Restart Enkaku" (plan 120 §4) — optional for the same reasons
   * `adbControl` above is: several tests build a minimal `HttpDeps`, and
   * this is genuinely unavailable before `daemon.ts`'s `start()` finishes
   * constructing it.
   */
  appRestart?: AppRestartRouteDeps
  jobRoutes: Hono<AuthEnv>
  scriptRoutes: Hono<AuthEnv>
  /**
   * `POST /`, `POST /validate`, `GET /:name/versions` (plan 99 §4.5, §4.9,
   * §5 step 99.6) — mounted at `/api/workflows`. Optional, the same way
   * `audit`/`adbControl` above already are: `daemon.ts` is held by a
   * concurrent worker as of this step, so it cannot be edited here to
   * construct and pass a real value yet. Until it is wired, `/api/workflows`
   * 404s through the catch-all below rather than the app failing to boot —
   * see `packages/core/src/api/workflows-wiring.test.ts`, which fails with
   * the exact lines to add for as long as this gap is open.
   */
  workflowRoutes?: Hono<AuthEnv>
  /** `GET :id/runs/:runId/steps` and `POST :id/resume` (plan 211 §7.1) — mounted at `/api/workflow-jobs`. Optional on the same terms as `workflowRoutes` above. */
  workflowJobRoutes?: Hono<AuthEnv>
  /**
   * `GET`/`GET :slug`/`POST`/`PATCH :slug`/`DELETE :slug`/`POST :slug/publish`/
   * `POST :slug/detach` (plan 94 §4.9, §5 step 94.5) — mounted at
   * `/api/recordings`. Optional for the SAME reason `workflowRoutes` above
   * is: a build where `daemon.ts` has not been wired to construct one simply
   * never mounts this route rather than failing to boot — see
   * `packages/core/src/api/recordings-wiring.test.ts`, which fails with the
   * exact lines to add for as long as this gap is open.
   */
  recordingRoutes?: Hono<AuthEnv>
  /**
   * `POST /file` (plan 115 §4.3, §5 step 115.3) — mounted at
   * `/api/workspace`. Optional for the SAME reason `recordingRoutes` above
   * is: a build where `daemon.ts` has not been wired to construct one
   * simply never mounts this route rather than failing to boot.
   */
  workspaceFileRoutes?: Hono<AuthEnv>
  /** Stage/verify/activate/rollback/disable/remove/reload/restart, and the dev slot lifecycle (plan 82 §4.6, step 11). */
  pluginRoutes: Hono<AuthEnv>
  /** `GET /` — the flow editor's node catalog: six core control kinds plus every activated plugin's node members (plan 303 §4.3). Mounted at `/api/node-types`. */
  nodeTypeRoutes: Hono<AuthEnv>
  /** `POST /api/v1/cap/:id` and `GET /api/v1/cap` (plan 63 §3.6, §4.5). */
  capRoutes: Hono<AuthEnv>
  /** Generated once at boot from the same registry `capRoutes` reads
   * (plan 63 §4.5) — served verbatim at `GET /api/openapi.json`. */
  openApiDocument: unknown
  /** MCP's `tools/list`/`tools/call` over `/mcp` (plan 63 §4.4) — mounted
   * OUTSIDE `/api/*`, so it gets its OWN `authMiddleware` application
   * below rather than inheriting the `/api/*` one. */
  mcpRoutes: Hono<AuthEnv>
  /** `GET/POST/PATCH/DELETE /api/agents` (plan 65 §4.5). */
  agentRoutes: Hono<AuthEnv>
  /** `GET/POST/PATCH/DELETE /api/connectors`, `GET /:id/models`, `POST /:id/test` (plan 65 §4.5). */
  connectorRoutes: Hono<AuthEnv>
  /** `GET/PUT/DELETE /api/kv` — admin-scoped (`kv.manage`), secrets rendered as a hint only (plan 79 §4.3, step 4). */
  kvRoutes: Hono<AuthEnv>
  /** `POST /api/v1/threads`, `GET /threads/:id/messages`, `POST /threads/:id/messages`, `GET /runs/:id`, `POST /runs/:id/cancel`, `POST /approvals/:id` (plan 66 §4.4). */
  threadRoutes: Hono<AuthEnv>
  /** `POST /api/v1/blobs`, `GET /api/v1/blobs/:id` (plan 70 §4.6) — content-addressed image storage; the only way base64 ever reaches Studio. */
  blobRoutes: Hono<AuthEnv>
  /** `GET /api/notifications`, `.../:id/read`, `.../read-all` (plan 68 §4.5). */
  notificationRoutes: Hono<AuthEnv>
  /** `GET/POST/PATCH/DELETE /api/webhooks` (plan 68 §4.1, §4.5). */
  webhookRoutes: Hono<AuthEnv>
  deviceRoutes: Hono<AuthEnv>
  /** `GET/POST /api/vms`, `POST /:id/start`, `POST /:id/stop`, `DELETE /:id` (plan 402 §4.2) — a virtual device (plan 400). Mounted at its OWN `/api/vms` prefix, never `/api/devices`: a VM row is not a device row (plan 400 D6). */
  vmRoutes: Hono<AuthEnv>
  /**
   * `GET /api/transfers` (plan 107 §3.1, §3.4, §4, step 107.2) — its own
   * top-level prefix, NOT `/api/devices` (this list is farm-wide, not
   * scoped to one device's path). Reads the in-memory registry
   * `daemon.ts`'s single `transferBroadcast` object keeps current; see
   * `packages/core/src/device/transfer-registry.ts` and
   * `packages/protocol/src/api/transfers.ts` for what that registry loses
   * on a core restart and why the response shape is built to survive a
   * later swap to a durable row unchanged.
   */
  transferRegistryRoutes: Hono<AuthEnv>
  /** `GET/POST/DELETE /:id/guest-agent` and `GET/PUT/DELETE /:id/network` (plan 44 §5.8) — mounted at the same `/api/devices` prefix as `deviceRoutes`, from its own Hono app so `packages/core/src/api/devices.ts` stays untouched beyond the registry fallout fix. */
  guestAgentRoutes: Hono<AuthEnv>
  /** `POST /api/guest-agent/provision`, `GET /api/guest-agent/summary` (plan 90 §3.8, §4.7) — the fleet-wide provisioning surface, at its OWN `/api/guest-agent` prefix (never `/api/devices` — this is not device-scoped). */
  agentProvisionerRoutes: Hono<AuthEnv>
  /** `GET/PUT/DELETE /:id/identity` and `POST /:id/identity/sync` (plan 58 §4.3, §5.3) — a third Hono app at the same `/api/devices` prefix, same reasoning as `guestAgentRoutes`. */
  deviceIdentityRoutes: Hono<AuthEnv>
  /** `GET /:id/preparation`, `POST /:id/preparation`, `POST /:id/preparation/:componentId/retry` (plan 106 §3.3, §4) — a fourth Hono app at the same `/api/devices` prefix, same reasoning as `guestAgentRoutes`/`deviceIdentityRoutes`. */
  devicePreparationRoutes: Hono<AuthEnv>
  tagRoutes: Hono
  /** `GET/POST /api/groups`, `PATCH/DELETE /api/groups/:id`, `GET /api/groups/:id/devices` (plan 22.0 §4.4, renamed by plan 207 §4.6 — MVP 15 §0.1 item 3). Membership is now the `set-group` actions verb, never a route on this router. */
  groupRoutes: Hono<AuthEnv>
  batchRoutes: Hono<AuthEnv>
  /** `POST /api/actions/:verb` (plan 207 §4.2, §4.8) — one endpoint per verb, taking a target; answers `202` with one result per device. */
  actionRoutes: Hono<AuthEnv>
  /** `GET /api/operations/:id` (plan 207 §4.2, §4.8) — an async verb's dispatch result, readable for one hour off the in-memory operation registry. */
  operationRoutes: Hono<AuthEnv>
  scheduleRoutes: Hono<AuthEnv>
  settingsRoutes: Hono<AuthEnv>
  /** `GET /api/storage/usage` (plan 224) — a cache read maintained by the retention sweeper. */
  storageRoutes: Hono<AuthEnv>
  artifactRoutes: Hono<AuthEnv>
  adbStatsRoutes: Hono<AuthEnv>
  /** `POST /api/video/reprofile` (plan 92 §3.8, §4.5, §5 step 92.2). */
  videoRoutes: Hono<AuthEnv>
  /** `enkaku doctor`'s checks, rendered as JSON for the Tools page's diagnostics view (plan 41 §4.5). */
  doctorRoutes: Hono<AuthEnv>
  authRoutes: Hono<AuthEnv>
  nodeRoutes: Hono<AuthEnv>
  /** `GET/POST /api/tokens`, `DELETE /api/tokens/:id` — durable API credentials (plan 130 §3.5). */
  tokenRoutes: Hono<AuthEnv>
  /**
   * Resolves an `Authorization: Bearer <api token>` when no session matched
   * (plan 130 §3.5). Threaded through to BOTH `authMiddleware` call sites
   * below — `/api/*` and `/mcp` — because an external agent reaching the MCP
   * surface is the case this credential exists for, and wiring only the first
   * would leave exactly that caller still borrowing a human's session.
   */
  apiTokens: ApiTokenService
  auth: AuthService
  authMode: AuthMode
  startedAt: number
}

const ERROR_STATUS: Record<string, number> = {
  E_BAD_REQUEST: 400,
  E_TOOL_NOT_FOUND: 500,
  E_ADB_UNAVAILABLE: 503,
  E_ADB_FAIL: 502,
  E_DB: 500,
}

/**
 * Any loopback origin counts as "the Studio dev server on this machine".
 *
 * Only `localhost` used to be accepted, which broke the moment anyone opened
 * `127.0.0.1:3001` — a different origin to the browser even though it is the
 * same machine. Next's own dev output advertises a `127.0.x.x` address, so
 * this was easy to hit and the error it produced (a CORS block) said nothing
 * about the real cause.
 *
 * This stays local-mode-only (see the call site below): in server mode the
 * check never runs, and the core is single-origin.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    )
  } catch {
    return false
  }
}

export function createApp(deps: HttpDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  // The slow-request logger (plan 85 §3.6, §4.6, §5 85.7a) — registered
  // FIRST so it wraps every other middleware and route below: Hono runs
  // `app.use` callbacks in registration order up to `next()`, then unwinds
  // in reverse, so starting the clock here and resuming after `next()`
  // times the whole request regardless of which route eventually served it.
  const logSlowRequest = createSlowLogger(deps.log, { thresholdMs: 1000, label: 'request' })
  app.use('*', async (c, next) => {
    const startedAt = Date.now()
    await next()
    logSlowRequest(new URL(c.req.url).pathname, Date.now() - startedAt)
  })

  /**
   * Compression, farm-wide (plan 127 §3.4, step 127.3). Registered at the
   * SERVER rather than on the routes that happen to be large today, because
   * a per-route compressor is one more thing the next route forgets — the
   * same rule plan 126 §3.1 applies to column projections.
   *
   * Why it matters here: this core had no compression at all, and the owner's
   * farm is reached over the internet. Their report — *"every refresh is very
   * heavy … on local it looks fine, because local is not limited by internet
   * speed and bandwidth"* — is what opened plan 127. JavaScript and CSS are
   * the most compressible content there is (typically 3-5x), and the plugin
   * UI assets alone are ~159 KB per cold load.
   *
   * Hono's own middleware is used rather than a hand-rolled one, and three of
   * its behaviours are the reason it is safe to mount globally:
   *
   * 1. It **deletes `Content-Length`** after compressing. `GET /api/plugins/
   *    :name/ui/:path` sets that header explicitly, and compressing a
   *    response while leaving a byte count from before would corrupt it.
   * 2. Its content-type filter **excludes `text/event-stream` by name**, so
   *    the agent chat's SSE stream is untouched — buffering an event stream
   *    through a compressor is how "streaming" quietly stops streaming.
   * 3. It skips anything already encoded, any `HEAD`, any `206`, any
   *    `no-transform`, and every non-compressible type — so binary blobs
   *    (screenshots, artifacts) pass through byte-for-byte.
   *
   * Below the 1 KB default threshold nothing is compressed, which is correct:
   * a gzip header on a 200-byte JSON answer costs more than it saves.
   *
   * Deliberately registered AFTER the slow-request logger so the timing still
   * covers the compression work rather than reporting a number that excludes
   * it, and BEFORE auth so a 401 body is compressed like any other.
   */
  app.use('*', compress())

  // Studio dev mode (next dev on another port) — local-mode only.
  //
  // This used to gate on `process.env.NODE_ENV !== 'production'`. Nothing in
  // this codebase's release binary, Docker image, or systemd unit ever sets
  // `NODE_ENV=production`, so that check was always true and the "dev-only"
  // grant was actually live in every documented production deployment —
  // bounded (see the `credentials` note below), but still a gap worth
  // closing outright rather than papering over.
  //
  // `authMode` is the correct replacement signal: it is already derived from
  // the bind address (`resolveAuthMode` in ../config), it is 'local' if and
  // only if the core is bound to loopback with auth not forced to 'server',
  // and — unlike `NODE_ENV`, a Node convention a compiled Bun binary has no
  // particular reason to carry — it is a value this process always computes
  // for itself regardless of how it was started. `bun run dev` (and Studio's
  // `dev` on :3001 against it) binds loopback by default, so `authMode` is
  // 'local' and this keeps working unchanged; any real server-mode
  // deployment — which by definition is not on loopback, or has server mode
  // forced — never grants it, closing the gap for exactly the deployments
  // that were actually exposed.
  // `credentials: true` is required, not optional, and it grants nothing.
  //
  // Studio's own calls use `fetch(..., { credentials: 'include' })`
  // (`packages/studio/src/lib/auth.ts`, `lib/ws.ts`) because server mode
  // needs the session cookie. The CORS spec then requires the response to
  // carry `Access-Control-Allow-Credentials: true` or the BROWSER discards
  // it — the request reaches the core and returns 200, and the tab still
  // sees a rejected promise. `AuthGate` cannot tell that apart from "no
  // session" and sends the operator to `/login`, which in local mode has no
  // credentials to offer. So without this flag `bun run dev:studio` — the
  // workflow this whole block exists to support — is not merely degraded,
  // it is unusable, and the symptom points at auth rather than at CORS.
  //
  // It cannot widen anything, and the reason is specific to the condition
  // this block already runs under. `authMiddleware` in local mode sets an
  // implicit admin for EVERY request before it ever looks at a cookie
  // (`../auth/middleware.ts` — the `mode === 'local'` branch returns early),
  // so there is no session cookie here for a cross-origin page to ride: any
  // loopback origin this block admits is already fully authorised without
  // sending one. The real gate is, and stays, `isLoopbackOrigin` plus local
  // mode. Server mode never reaches this line at all, so its cookie keeps
  // exactly the protection it has today.
  if (deps.authMode === 'local') {
    app.use(
      '/api/*',
      cors({
        origin: (origin) => (isLoopbackOrigin(origin) ? origin : null),
        credentials: true,
        // `GET`/`HEAD /api/workspace/file` (plan 116 §4.2, step 116.6) carry the
        // file's metadata in response headers rather than a JSON body, so a
        // cross-origin `fetch()` (Studio dev on :3001 against the core on
        // :7700) needs these EXPOSED, not merely sent — without this list, only
        // the CORS-safelisted headers (`Content-Type`, `Content-Length`, ...)
        // are readable from `response.headers.get(...)` in the browser, and
        // `ETag`/the `X-Enkaku-*` ones return `null` even though the response
        // carried them, which is indistinguishable from the file having no
        // hash or attribution at all.
        exposeHeaders: ['ETag', 'X-Enkaku-Created-By', 'X-Enkaku-Updated-By', 'X-Enkaku-Created-At', 'X-Enkaku-Updated-At'],
      }),
    )
  }

  // Auth: local mode (loopback) injects an implicit admin; server mode requires login.
  app.use('/api/*', authMiddleware({ auth: deps.auth, mode: deps.authMode, apiTokens: deps.apiTokens }))

  app.route('/api/auth', deps.authRoutes)

  app.route('/api/nodes', deps.nodeRoutes)
  app.route('/api/tokens', deps.tokenRoutes)

  // `deps.adbServerVersion()` resolves `string | null` — `HealthResponseSchema`'s
  // `adb.serverVersion` was widened to `z.string().nullable().optional()` (plan 72.5) so this
  // structurally matches rather than needing a silent `?? undefined`.
  //
  // `ok` is intentionally a LIVENESS signal, not a readiness one, and stays
  // `true` unconditionally: this handler running at all already proves the
  // HTTP layer is alive, and that is genuinely all `ok` has ever meant. It is
  // deliberately NOT derived from `adb.state` — `packages/core/src/doctor/checks/port.ts`
  // and `doctor/context.ts`'s `probeCore` both read `ok` to decide "is this
  // port held by a legitimate enkaku core", a question that must stay `true`
  // even while adb is still provisioning, or (per daemon.ts's own comment
  // next to `adbState = 'error'`) after adb provisioning has failed — "the
  // core stays up: the tools API can still be used to retry the install".
  // Making `ok` false in either state would make `enkaku doctor` misreport a
  // live, recoverable core as "port held by an unknown process". Readiness
  // already has its own, real signal: `adb.state` (`'provisioning' |
  // 'ready' | 'error' | 'orchestrator'`), which is exactly what a caller that
  // wants to know "did the binary actually finish booting" should poll to a
  // terminal value — see the release smoke test in `.github/workflows/release.yml`.
  app.get('/api/health', async (c) => {
    return typedJson(c, HealthResponseSchema, {
      ok: true,
      version: deps.version,
      adb: { state: deps.adbState(), serverVersion: await deps.adbServerVersion() },
      // Studio hides cloud-only screens (Nodes) outside orchestrator mode.
      mode: process.env.ENKAKU_MODE === 'orchestrator' ? 'orchestrator' : 'local',
      deviceCount: deps.deviceCount(),
      uptimeMs: Date.now() - deps.startedAt,
      // Plan 126 §3.5, step 126.5 — the sidebar's farm-health badge, so
      // Studio stops fetching the whole plugin list on every page to derive
      // one integer (§0.4). `undefined` when the host has no plugin store to
      // count, which `HealthResponseSchema` declares optional precisely so
      // this can be omitted rather than reported as a false `0`; see the
      // dep's own doc comment above.
      failedPlugins: deps.failedPluginCount?.(),
    })
  })

  app.route('/api/devices', deps.deviceRoutes)

  // Plan 44 §5.8 — a second Hono app mounted at the same base path, the same
  // pattern `deviceRoutes` itself uses internally for the adb-endpoint and
  // transfer routes (`api/devices.ts`'s `app.route('/', ...)` calls).
  app.route('/api/devices', deps.guestAgentRoutes)

  // Plan 90 §3.8, §4.7 — the fleet-wide provisioning surface. A DIFFERENT
  // prefix on purpose: this is not device-scoped, unlike every route above.
  app.route('/api/guest-agent', deps.agentProvisionerRoutes)

  // Plan 58 §4.3, §5.3 — a third Hono app at the same base path, same reasoning as
  // `guestAgentRoutes` above: identity is a device-settings extension living beside the network
  // route, not part of it (plan 58 §3.1), so it gets its own route file rather than growing
  // `guest-agent.ts` or `devices.ts` further.
  app.route('/api/devices', deps.deviceIdentityRoutes)

  // Plan 106 §3.3, §4 — a fourth Hono app at the same base path, same
  // reasoning as `guestAgentRoutes`/`deviceIdentityRoutes` above.
  app.route('/api/devices', deps.devicePreparationRoutes)

  // A virtual device (plan 400) is not a device row (plan 400 D6): its own
  // `/api/vms` prefix, never `/api/devices` (plan 402 §4.3).
  app.route('/api/vms', deps.vmRoutes)

  // Plan 107 §3.1, §3.4, §4, step 107.2 — its OWN top-level prefix, not
  // `/api/devices`: `GET /api/transfers` is farm-wide (every in-flight or
  // recently-finished install/push/pull, across every device), not scoped
  // to one device's path the way the four mounts above are.
  app.route('/api/transfers', deps.transferRegistryRoutes)

  app.route('/api/tags', deps.tagRoutes)

  app.route('/api/groups', deps.groupRoutes)

  app.route('/api/batches', deps.batchRoutes)

  // One endpoint per verb, taking a target (plan 207 §4.2, §4.8) — replaces
  // every per-device action route and its bulk twin, plus the deleted
  // fleet command surface's own REST surface.
  app.route('/api/actions', deps.actionRoutes)

  app.route('/api/operations', deps.operationRoutes)

  app.route('/api/schedules', deps.scheduleRoutes)

  app.route('/api/settings', deps.settingsRoutes)

  app.route('/api/storage', deps.storageRoutes)

  app.route('/api/artifacts', deps.artifactRoutes)

  // A browser upload into the workspace (plan 115 §4.3, §5 step 115.3) —
  // see `workspaceFileRoutes`'s own doc comment on `HttpDeps` for why this
  // is conditional.
  if (deps.workspaceFileRoutes) app.route('/api/workspace', deps.workspaceFileRoutes)

  // adb concurrency and health diagnostics (plan 23 §4.6).
  app.route('/api/adb/stats', deps.adbStatsRoutes)

  // `POST /api/video/reprofile` (plan 92 §3.8, §4.5, §5 step 92.2).
  app.route('/api/video', deps.videoRoutes)

  // `enkaku doctor`'s checks, core-connected mode (plan 41 §4.5).
  app.route('/api/doctor', deps.doctorRoutes)

  app.route(
    '/api/tools',
    createToolsRoutes(deps.toolchain, {
      ...(deps.audit ? { audit: deps.audit } : {}),
      ...(deps.adbControl ? { adb: deps.adbControl } : {}),
      ...(deps.appRestart ? { app: deps.appRestart } : {}),
    }),
  )

  app.get('/api/registry', async (c) => c.json(await buildRegistryResponse(deps.toolchain)))

  app.route('/api/jobs', deps.jobRoutes)

  app.route('/api/scripts', deps.scriptRoutes)

  // Plan 99 §4.9, §5 step 99.6 — optional (see `workflowRoutes`'s own doc
  // comment on `HttpDeps` for why); a build where `daemon.ts` has not yet
  // been wired to construct one simply never mounts this route, and
  // `/api/workflows/*` falls through to the catch-all 404 below like any
  // other unmounted path — never a boot failure.
  if (deps.workflowRoutes) app.route('/api/workflows', deps.workflowRoutes)

  /*
   * Plan 211 §7.1 — the workflow RUN's own routes: the per-step list the
   * Timeline tab draws for a workflow job, and `resume`.
   *
   * `api/workflow-jobs.ts` has existed, with its own passing test file, since
   * plan 211 and was never mounted by anything. Every request to it answered
   * "no such route", so a workflow job's Timeline read `Steps · 0` however
   * many steps the run had actually recorded, and Resume was unreachable
   * — a whole surface dark because of a missing line here (owner,
   * 2026-09-05). The test suite could not see it: it mounts the router
   * itself.
   */
  if (deps.workflowJobRoutes) app.route('/api/workflow-jobs', deps.workflowJobRoutes)

  // Plan 94 §4.9, §5 step 94.5 — same optional-mount pattern as `workflowRoutes` above.
  if (deps.recordingRoutes) app.route('/api/recordings', deps.recordingRoutes)

  app.route('/api/plugins', deps.pluginRoutes)

  app.route('/api/node-types', deps.nodeTypeRoutes)

  // AI agents and their farm-level connectors (plan 65 §4.5).
  app.route('/api/agents', deps.agentRoutes)
  app.route('/api/connectors', deps.connectorRoutes)

  // The durable kv store's admin surface (plan 79 §4.3, step 4).
  app.route('/api/kv', deps.kvRoutes)

  // The capability registry's three generated surfaces (plan 63 §3.5, §3.6,
  // §4.4, §4.5). `capRoutes` and `GET /api/openapi.json` sit under `/api/*`
  // and inherit the `authMiddleware` applied above; `/mcp` sits outside it,
  // so it gets its own application of the SAME middleware (§4.4: "the same
  // session token as everything else").
  app.route('/api/v1/cap', deps.capRoutes)

  app.get('/api/openapi.json', (c) => c.json(deps.openApiDocument))

  // The agent chat protocol's REST surface (plan 66 §4.4) — threads, runs, approvals.
  app.route('/api/v1', deps.threadRoutes)

  // Content-addressed image blobs (plan 70 §4.6) — a screenshot's blob and a person's attachment both flow through here.
  app.route('/api/v1/blobs', deps.blobRoutes)

  // Notifications and webhooks (plan 68 §4.5) — the bell's data source and its farm-level endpoints.
  app.route('/api/notifications', deps.notificationRoutes)
  app.route('/api/webhooks', deps.webhookRoutes)

  app.use('/mcp', authMiddleware({ auth: deps.auth, mode: deps.authMode, apiTokens: deps.apiTokens }))
  app.route('/mcp', deps.mcpRoutes)

  // Static Studio (single-origin prod); /api/* and /ws are handled above.
  const serveStudio = createStudioServer(deps.log.child('studio'))
  app.get('*', async (c) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/api/')) return c.json({ error: { code: 'E_NOT_FOUND', message: 'no such route' } }, 404)
    return serveStudio(path)
  })

  app.notFound((c) => c.json({ error: { code: 'E_NOT_FOUND', message: 'no such route' } }, 404))

  app.onError((err, c) => {
    if (err instanceof ToolchainError) {
      deps.log.warn(`api error ${err.code}: ${err.message}`)
      return c.json(err.toJSON(), 500)
    }
    if (err instanceof EnkakuError) {
      const status = ERROR_STATUS[err.code] ?? 500
      deps.log.warn(`api error ${err.code}: ${err.message}`)
      return c.json(err.toJSON(), status as 400)
    }
    deps.log.error(`unexpected api error: ${String(err)}`)
    return c.json({ error: { code: 'E_INTERNAL', message: 'internal error' } }, 500)
  })

  return app
}
