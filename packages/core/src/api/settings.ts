import { Hono } from 'hono'
import { DeviceSettingsSchema, FarmSettingsSchema } from '@enkaku/protocol'
import { z } from 'zod'
import type { FarmSettingsStore } from '../settings/farm-settings'
import { EnkakuError } from '../util/errors'

/**
 * Settings farm-wide + JSON Schema untuk schema-driven form renderer
 * (spec §8, §19) — Studio tidak hardcode form.
 */
export function createSettingsRoutes(store: FarmSettingsStore): Hono {
  const app = new Hono()

  app.get('/', (c) =>
    c.json({
      settings: store.get(),
      schema: z.toJSONSchema(FarmSettingsSchema),
    }),
  )

  app.patch('/', async (c) => {
    const body = await c.req.json().catch(() => null)
    return c.json({ settings: store.update(body) })
  })

  /** Schema DeviceSettings untuk form per-device. */
  app.get('/device-schema', (c) => c.json({ schema: z.toJSONSchema(DeviceSettingsSchema) }))

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), 400)
    throw err
  })

  return app
}
