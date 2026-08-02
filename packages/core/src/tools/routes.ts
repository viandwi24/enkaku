import { Hono } from 'hono'
import { z } from 'zod'
import { ToolchainError, type ToolchainManager } from '@enkaku/toolchain'

const VersionBody = z.object({ version: z.string().min(1) })

const ERROR_STATUS: Record<string, number> = {
  E_TOOL_NOT_FOUND: 404,
  E_VERSION_NOT_IN_MANIFEST: 404,
  E_NOT_INSTALLED: 404,
  E_NOT_SWAPPABLE: 403,
  E_CHECKSUM_MISMATCH: 502,
  E_CHECKSUM_MISSING: 409,
  E_DELETE_ACTIVE: 409,
  E_TOOL_IN_USE: 409,
  E_HEALTH_CHECK_FAILED: 409,
  E_ALREADY_INSTALLED: 409,
  E_MANIFEST_FETCH_FAILED: 502,
  E_TOOL_NOT_PROVISIONED: 409,
  E_PLATFORM_UNSUPPORTED: 409,
  E_DOWNLOAD_FAILED: 502,
  E_DOWNLOAD_STALLED: 502,
}

/** The /api/tools routes — exactly spec §7.7, with the §7.8 guards in ToolchainManager. */
export function createToolsRoutes(manager: ToolchainManager): Hono {
  const app = new Hono()

  app.get('/', async (c) => c.json({ tools: await manager.list() }))

  app.post('/manifest/refresh', async (c) => {
    const manifest = await manager.manifests.refresh()
    return c.json({ ok: true, updatedAt: manifest.updatedAt, tools: manifest.tools.length })
  })

  app.post('/:id/install', async (c) => {
    const body = VersionBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: 'a body of { version } is required' } }, 400)
    await manager.install(c.req.param('id'), body.data.version)
    return c.json({ ok: true })
  })

  app.post('/:id/activate', async (c) => {
    const body = VersionBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: 'a body of { version } is required' } }, 400)
    await manager.activate(c.req.param('id'), body.data.version)
    return c.json({ ok: true })
  })

  app.post('/:id/check', async (c) => {
    const health = await manager.check(c.req.param('id'))
    return c.json({ health })
  })

  app.delete('/:id/:version', async (c) => {
    await manager.remove(c.req.param('id'), c.req.param('version'))
    return c.json({ ok: true })
  })

  app.onError((err, c) => {
    if (err instanceof ToolchainError) {
      const status = ERROR_STATUS[err.code] ?? 500
      return c.json(err.toJSON(), status as 400)
    }
    throw err
  })

  return app
}
