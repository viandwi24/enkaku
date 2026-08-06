import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AuthMode } from '../config'
import { authMiddleware, type AuthEnv } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import type { DeviceInfo } from '@enkaku/protocol'
import { HealthResponseSchema } from '@enkaku/protocol'
import { ToolchainError, type ToolchainManager } from '@enkaku/toolchain'
import { buildRegistryResponse } from '../registry/engines'
import { createToolsRoutes } from '../tools/routes'
import { createStudioServer } from './studio'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { typedJson } from '../api/typed-json'

export interface HttpDeps {
  listDevices: () => DeviceInfo[]
  deviceCount: () => number
  log: Logger
  version: string
  adbServerVersion: () => Promise<string | null>
  /** Status subsistem adb: 'provisioning' | 'ready' | 'error'. */
  adbState: () => string
  toolchain: ToolchainManager
  jobRoutes: Hono<AuthEnv>
  scriptRoutes: Hono<AuthEnv>
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
  /** `POST /api/v1/threads`, `GET /threads/:id/messages`, `POST /threads/:id/messages`, `GET /runs/:id`, `POST /runs/:id/cancel`, `POST /approvals/:id` (plan 66 §4.4). */
  threadRoutes: Hono<AuthEnv>
  /** `POST /api/v1/blobs`, `GET /api/v1/blobs/:id` (plan 70 §4.6) — content-addressed image storage; the only way base64 ever reaches Studio. */
  blobRoutes: Hono<AuthEnv>
  /** `GET /api/notifications`, `.../unread-count`, `.../:id/read`, `.../read-all` (plan 68 §4.5). */
  notificationRoutes: Hono<AuthEnv>
  /** `GET/POST/PATCH/DELETE /api/webhooks` (plan 68 §4.1, §4.5). */
  webhookRoutes: Hono<AuthEnv>
  deviceRoutes: Hono<AuthEnv>
  /** `GET/POST/DELETE /:id/guest-agent` and `GET/PUT/DELETE /:id/network` (plan 44 §5.8) — mounted at the same `/api/devices` prefix as `deviceRoutes`, from its own Hono app so `packages/core/src/api/devices.ts` stays untouched beyond the registry fallout fix. */
  guestAgentRoutes: Hono<AuthEnv>
  /** `GET/PUT/DELETE /:id/identity` and `POST /:id/identity/sync` (plan 58 §4.3, §5.3) — a third Hono app at the same `/api/devices` prefix, same reasoning as `guestAgentRoutes`. */
  deviceIdentityRoutes: Hono<AuthEnv>
  tagRoutes: Hono
  clusterRoutes: Hono<AuthEnv>
  topologyRoutes: Hono
  batchRoutes: Hono<AuthEnv>
  scheduleRoutes: Hono<AuthEnv>
  settingsRoutes: Hono<AuthEnv>
  artifactRoutes: Hono<AuthEnv>
  adbStatsRoutes: Hono<AuthEnv>
  /** `enkaku doctor`'s checks, rendered as JSON for the Tools page's diagnostics view (plan 41 §4.5). */
  doctorRoutes: Hono<AuthEnv>
  authRoutes: Hono<AuthEnv>
  nodeRoutes: Hono<AuthEnv>
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
 * This stays dev-only: in production the check never runs, and the core is
 * single-origin.
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

  // Studio dev mode (next dev on another port) — non-production only.
  if (process.env.NODE_ENV !== 'production') {
    app.use('/api/*', cors({ origin: (origin) => (isLoopbackOrigin(origin) ? origin : null) }))
  }

  // Auth: local mode (loopback) injects an implicit admin; server mode requires login.
  app.use('/api/*', authMiddleware({ auth: deps.auth, mode: deps.authMode }))

  app.route('/api/auth', deps.authRoutes)

  app.route('/api/nodes', deps.nodeRoutes)

  // `deps.adbServerVersion()` resolves `string | null` — `HealthResponseSchema`'s
  // `adb.serverVersion` was widened to `z.string().nullable().optional()` (plan 72.5) so this
  // structurally matches rather than needing a silent `?? undefined`.
  app.get('/api/health', async (c) => {
    return typedJson(c, HealthResponseSchema, {
      ok: true,
      version: deps.version,
      adb: { state: deps.adbState(), serverVersion: await deps.adbServerVersion() },
      // Studio hides cloud-only screens (Nodes) outside orchestrator mode.
      mode: process.env.ENKAKU_MODE === 'orchestrator' ? 'orchestrator' : 'local',
      deviceCount: deps.deviceCount(),
      uptimeMs: Date.now() - deps.startedAt,
    })
  })

  app.route('/api/devices', deps.deviceRoutes)

  // Plan 44 §5.8 — a second Hono app mounted at the same base path, the same
  // pattern `deviceRoutes` itself uses internally for the adb-endpoint and
  // transfer routes (`api/devices.ts`'s `app.route('/', ...)` calls).
  app.route('/api/devices', deps.guestAgentRoutes)

  // Plan 58 §4.3, §5.3 — a third Hono app at the same base path, same reasoning as
  // `guestAgentRoutes` above: identity is a device-settings extension living beside the network
  // route, not part of it (plan 58 §3.1), so it gets its own route file rather than growing
  // `guest-agent.ts` or `devices.ts` further.
  app.route('/api/devices', deps.deviceIdentityRoutes)

  app.route('/api/tags', deps.tagRoutes)

  app.route('/api/clusters', deps.clusterRoutes)

  app.route('/api/topology', deps.topologyRoutes)

  app.route('/api/batches', deps.batchRoutes)

  app.route('/api/schedules', deps.scheduleRoutes)

  app.route('/api/settings', deps.settingsRoutes)

  app.route('/api/artifacts', deps.artifactRoutes)

  // adb concurrency and health diagnostics (plan 23 §4.6).
  app.route('/api/adb/stats', deps.adbStatsRoutes)

  // `enkaku doctor`'s checks, core-connected mode (plan 41 §4.5).
  app.route('/api/doctor', deps.doctorRoutes)

  app.route('/api/tools', createToolsRoutes(deps.toolchain))

  app.get('/api/registry', async (c) => c.json(await buildRegistryResponse(deps.toolchain)))

  app.route('/api/jobs', deps.jobRoutes)

  app.route('/api/scripts', deps.scriptRoutes)

  // AI agents and their farm-level connectors (plan 65 §4.5).
  app.route('/api/agents', deps.agentRoutes)
  app.route('/api/connectors', deps.connectorRoutes)

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

  app.use('/mcp', authMiddleware({ auth: deps.auth, mode: deps.authMode }))
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
