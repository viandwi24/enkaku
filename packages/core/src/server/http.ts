import { Hono } from 'hono'
import type { DeviceInfo } from '@enkaku/protocol'
import { ToolchainError, type ToolchainManager } from '@enkaku/toolchain'
import { createToolsRoutes } from '../tools/routes'
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
  startedAt: number
}

const ERROR_STATUS: Record<string, number> = {
  E_BAD_REQUEST: 400,
  E_TOOL_NOT_FOUND: 500,
  E_ADB_UNAVAILABLE: 503,
  E_ADB_FAIL: 502,
  E_DB: 500,
}

export function createApp(deps: HttpDeps): Hono {
  const app = new Hono()

  app.get('/api/health', async (c) => {
    return c.json({
      ok: true,
      version: deps.version,
      adb: { state: deps.adbState(), serverVersion: await deps.adbServerVersion() },
      deviceCount: deps.deviceCount(),
      uptimeMs: Date.now() - deps.startedAt,
    })
  })

  app.get('/api/devices', (c) => {
    return c.json({ devices: deps.listDevices() })
  })

  app.route('/api/tools', createToolsRoutes(deps.toolchain))

  app.notFound((c) => c.json({ error: { code: 'E_NOT_FOUND', message: 'route tidak ada' } }, 404))

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
    deps.log.error(`api error tak terduga: ${String(err)}`)
    return c.json({ error: { code: 'E_INTERNAL', message: 'internal error' } }, 500)
  })

  return app
}
