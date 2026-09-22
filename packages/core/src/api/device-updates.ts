import { Hono } from 'hono'
import { DeviceUpdatesStartBodySchema } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { DeviceUpdates } from '../device/device-updates'
import { EnkakuError } from '../util/errors'

/**
 * Devices → Update devices (0.2.74). Its own prefix, `/api/device-updates`, because under
 * `/api/devices` the device router's `/:id` would read `updates` as a device id.
 */
export function createDeviceUpdateRoutes(deps: { updates: DeviceUpdates }): { routes: Hono<AuthEnv> } {
  const app = new Hono<AuthEnv>()

  app.get('/', requirePermission('device.view'), async (c) => c.json(await deps.updates.list()))

  app.post('/', requirePermission('device.settings'), async (c) => {
    const parsed = DeviceUpdatesStartBodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) throw new EnkakuError('E_BAD_REQUEST', parsed.error.message)
    const queued = await deps.updates.start(parsed.data.deviceIds)
    return c.json({ ...(await deps.updates.list()), added: queued })
  })

  return { routes: app }
}
