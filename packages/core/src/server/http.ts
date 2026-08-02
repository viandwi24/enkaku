import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AuthMode } from '../config'
import { authMiddleware, type AuthEnv } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import type { DeviceInfo } from '@enkaku/protocol'
import { ToolchainError, type ToolchainManager } from '@enkaku/toolchain'
import { buildRegistryResponse } from '../registry/engines'
import { createToolsRoutes } from '../tools/routes'
import { createStudioServer } from './studio'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

export interface HttpDeps {
  listDevices: () => DeviceInfo[]
  deviceCount: () => number
  log: Logger
  version: string
  adbServerVersion: () => Promise<string | null>
  /** Status subsistem adb: 'provisioning' | 'ready' | 'error'. */
  adbState: () => string
  toolchain: ToolchainManager
  jobRoutes: Hono
  scriptRoutes: Hono
  deviceRoutes: Hono
  settingsRoutes: Hono
  artifactRoutes: Hono
  authRoutes: Hono<AuthEnv>
  agentRoutes: Hono<AuthEnv>
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

  app.route('/api/agents', deps.agentRoutes)

  app.get('/api/health', async (c) => {
    return c.json({
      ok: true,
      version: deps.version,
      adb: { state: deps.adbState(), serverVersion: await deps.adbServerVersion() },
      // Studio hides cloud-only screens (Agents) outside orchestrator mode.
      mode: process.env.ENKAKU_MODE === 'orchestrator' ? 'orchestrator' : 'local',
      deviceCount: deps.deviceCount(),
      uptimeMs: Date.now() - deps.startedAt,
    })
  })

  app.route('/api/devices', deps.deviceRoutes)

  app.route('/api/settings', deps.settingsRoutes)

  app.route('/api/artifacts', deps.artifactRoutes)

  app.route('/api/tools', createToolsRoutes(deps.toolchain))

  app.get('/api/registry', async (c) => c.json(await buildRegistryResponse(deps.toolchain)))

  app.route('/api/jobs', deps.jobRoutes)

  app.route('/api/scripts', deps.scriptRoutes)

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
