import { Hono } from 'hono'
import { DeviceSettingsSchema, FarmSettingsSchema } from '@enkaku/protocol'
import { z } from 'zod'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { FarmSettingsStore } from '../settings/farm-settings'
import { EnkakuError } from '../util/errors'

/**
 * Farm-wide settings plus the JSON Schema for the schema-driven form renderer
 * (spec §8, §19) — Studio hardcodes no forms.
 */
export function createSettingsRoutes(store: FarmSettingsStore): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.get('/', (c) =>
    c.json({
      settings: store.get(),
      schema: z.toJSONSchema(FarmSettingsSchema),
      // The per-device schema ships alongside, because the device screen renders
      // the exact same fields the farm defaults do (spec §12).
      deviceSchema: z.toJSONSchema(DeviceSettingsSchema),
    }),
  )

  // `settings.manage` (plan 34 §4.4, §4.5) — the plan names `PUT
  // /api/settings`; the actual route (unchanged by this plan) is `PATCH`, so
  // that is where the permission is applied.
  app.patch('/', requirePermission('settings.manage'), async (c) => {
    const body = await c.req.json().catch(() => null)
    return c.json({ settings: store.update(body) })
  })

  /** The DeviceSettings schema for per-device forms. */
  app.get('/device-schema', (c) => c.json({ schema: z.toJSONSchema(DeviceSettingsSchema) }))

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), 400)
    throw err
  })

  return app
}
