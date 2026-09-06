import { Hono } from 'hono'
import {
  DeviceSettingsSchema,
  FarmSettingsSchema,
  ResetSettingsRequestSchema,
  ResetSettingsResponseSchema,
  SettingsResponseSchema,
  UpdateSettingsResponseSchema,
  defaultFarmSettings,
} from '@enkaku/protocol'
import { z } from 'zod'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { FarmSettingsStore } from '../settings/farm-settings'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

/**
 * Farm-wide settings plus the JSON Schema for the schema-driven form renderer
 * (spec §8, §19) — Studio hardcodes no forms.
 */
export function createSettingsRoutes(store: FarmSettingsStore, deps?: { audit?: AuditLogger }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.get('/', (c) =>
    typedJson(c, SettingsResponseSchema, {
      settings: store.get(),
      schema: z.toJSONSchema(FarmSettingsSchema),
      // The per-device schema ships alongside, because the device screen renders
      // the exact same fields the farm defaults do (spec §12).
      deviceSchema: z.toJSONSchema(DeviceSettingsSchema),
      // This build's defaults, so a client can show what a reset would change
      // before the operator commits to it. Recomputed per request rather than
      // captured at module load: it is one `parse({})` and staleness here
      // would be a preview that lies.
      defaults: defaultFarmSettings(),
    }),
  )

  // `settings.manage` (plan 34 §4.4, §4.5) — the plan names `PUT
  // /api/settings`; the actual route (unchanged by this plan) is `PATCH`, so
  // that is where the permission is applied.
  app.patch('/', requirePermission('settings.manage'), async (c) => {
    const body = await c.req.json().catch(() => null)
    return typedJson(c, UpdateSettingsResponseSchema, { settings: store.update(body) })
  })

  /**
   * Put named sections back to this build's defaults.
   *
   * `POST` rather than `DELETE`: it names sections in a body, and it writes
   * new values rather than removing a resource.
   *
   * The blast radius is `farm_settings` and nothing else — `store` is the
   * only thing this route can reach, and it holds one row. That is worth
   * saying out loud because "reset" on a device farm is a frightening word:
   * this cannot touch a device, a group, a job, a run, a script, a user, a
   * token, or a stored credential, however it is called.
   */
  app.post('/reset', requirePermission('settings.manage'), async (c) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = ResetSettingsRequestSchema.safeParse(raw)
    if (!parsed.success) {
      throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    // `resetSections` refuses an unknown section rather than skipping it, so
    // a failure here never leaves a partial write behind — it throws before
    // touching the row.
    const settings = store.resetSections(parsed.data.sections)
    deps?.audit?.record({
      userId: c.get('user')?.id ?? null,
      action: 'settings.reset',
      target: parsed.data.sections.join(','),
      meta: { sections: parsed.data.sections },
    })
    return typedJson(c, ResetSettingsResponseSchema, { settings, reset: parsed.data.sections })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), 400)
    throw err
  })

  return app
}
