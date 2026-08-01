import { Hono } from 'hono'
import {
  DeviceSettingsSchema,
  validateEngineSelection,
  type RegistryResponse,
} from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db'
import { devices } from '../db/schema'
import type { BatteryMonitor } from '../device/battery'
import { rowToDeviceInfo } from '../registry/device-registry'
import { EnkakuError } from '../util/errors'

const DriversBody = z.object({
  transport: z.string(),
  display: z.string(),
  input: z.string(),
  inspection: z.string(),
})

const PatchBody = z.object({
  label: z.string().min(1).optional(),
  ownerId: z.string().nullable().optional(),
  settings: z.unknown().optional(),
})

const ERROR_STATUS: Record<string, number> = {
  device_not_found: 404,
  E_BAD_REQUEST: 400,
  UNKNOWN_ENGINE: 400,
  ENGINE_UNAVAILABLE: 409,
  LOCK_CONFLICT: 409,
  REQUIREMENT_MISSING: 409,
  not_quarantined: 409,
}

export function createDeviceRoutes(deps: {
  db: Db
  registry: () => Promise<RegistryResponse>
  battery: () => BatteryMonitor | null
}): Hono {
  const app = new Hono()
  const { db } = deps

  const mustGet = (id: string) => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `device tidak ada: ${id}`)
    return row
  }

  app.get('/', (c) => c.json({ devices: db.select().from(devices).all().map(rowToDeviceInfo) }))

  app.get('/:id', (c) => {
    const row = mustGet(c.req.param('id'))
    return c.json({
      device: {
        ...rowToDeviceInfo(row),
        transport: row.transport,
        display: row.display,
        input: row.input,
        inspection: row.inspection,
        battery: row.battery,
        settings: row.settings,
        quarantineReason: row.quarantineReason,
        ownerId: row.ownerId,
      },
    })
  })

  app.patch('/:id', async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = PatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'body tidak valid')
    const patch: Record<string, unknown> = {}
    if (body.data.label !== undefined) patch.label = body.data.label
    if (body.data.ownerId !== undefined) patch.ownerId = body.data.ownerId
    if (body.data.settings !== undefined) {
      const parsed = DeviceSettingsSchema.safeParse(body.data.settings)
      if (!parsed.success) {
        throw new EnkakuError(
          'E_BAD_REQUEST',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        )
      }
      patch.settings = parsed.data
    }
    if (Object.keys(patch).length > 0) db.update(devices).set(patch).where(eq(devices.id, row.id)).run()
    return c.json({ device: rowToDeviceInfo(mustGet(row.id)) })
  })

  /** Pilih engine per device — divalidasi server (capability + locks, spec §8). */
  app.patch('/:id/drivers', async (c) => {
    const row = mustGet(c.req.param('id'))
    const body = DriversBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'body { transport, display, input, inspection } wajib')
    const result = validateEngineSelection(await deps.registry(), body.data)
    if (!result.ok) throw new EnkakuError(result.code, result.message)
    db.update(devices).set(body.data).where(eq(devices.id, row.id)).run()
    return c.json({ device: { id: row.id, ...body.data } })
  })

  app.post('/:id/unquarantine', (c) => {
    const row = mustGet(c.req.param('id'))
    const monitor = deps.battery()
    if (!monitor || !monitor.unquarantine(row.id)) {
      throw new EnkakuError('not_quarantined', `device ${row.label} tidak dalam status quarantined`)
    }
    return c.json({ device: rowToDeviceInfo(mustGet(row.id)) })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
