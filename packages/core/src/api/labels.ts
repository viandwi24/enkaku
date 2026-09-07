import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { LabelColorSchema, LabelResponseSchema, LabelsResponseSchema, type DeviceInfo } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { deviceLabels } from '../db/schema'
import { createLabel, deleteLabel, listLabels, updateLabel } from '../registry/device-labels'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const LabelBody = z.object({
  name: z.string().min(1),
  color: LabelColorSchema.optional(),
  description: z.string().nullable().optional(),
})

const LabelPatchBody = LabelBody.partial()

/**
 * Label CRUD (plan 225 §4.4). A label has a life of its own — created empty,
 * renamed, recoloured and deleted farm-wide — which is exactly what the
 * free-form tags it replaces could not have: a tag existed only while some
 * device carried it, so `GET /api/tags` could suggest one and nothing could
 * manage one.
 *
 * Membership is NOT here. Putting a label on a device is the `set-labels`
 * actions verb (`POST /api/actions/set-labels`), for the same reason group
 * membership is the `set-group` verb: the surface that needs it most acts on
 * a whole selection at once, and the actions API is where a target lives.
 */
export function createLabelRoutes(deps: {
  db: Db
  audit: AuditLogger
  /**
   * Broadcast a device row that changed (plan 225 §4.4). Deleting a label
   * changes every device that carried it, and a write that tells nobody
   * leaves the chips standing in every open browser until a hard refresh —
   * the exact bug `set-group` shipped with (see `DeviceUpdatedMessage`).
   * Optional so tests that predate it still construct these routes.
   */
  broadcast?: (msg: { type: 'device.updated'; payload: DeviceInfo }) => void
  /** The whole farm as `DeviceInfo` rows, read ONCE per mutation — never one read per affected device. */
  listDevices?: () => DeviceInfo[]
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  /** One listing for a whole mutation, then one `device.updated` per device that actually changed. */
  const announce = (deviceIds: string[]): void => {
    if (deviceIds.length === 0 || !deps.broadcast || !deps.listDevices) return
    const changed = new Set(deviceIds)
    for (const info of deps.listDevices().filter((d) => changed.has(d.id))) {
      deps.broadcast({ type: 'device.updated', payload: info })
    }
  }

  app.get('/', (c) => typedJson(c, LabelsResponseSchema, { labels: listLabels(db) }))

  // `device.settings` — the same permission group CRUD gates on, and for the
  // same reason: a label is device organisation, and there is no
  // `device.manage` in the ACL matrix to reach for.
  app.post('/', requirePermission('device.settings'), async (c) => {
    const body = LabelBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { name, color?, description? } is required')
    const label = createLabel(db, body.data)
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'label.create', target: label.id, meta: { name: label.name } })
    return typedJson(c, LabelResponseSchema, { label }, 201)
  })

  app.patch('/:id', requirePermission('device.settings'), async (c) => {
    const id = c.req.param('id')
    const body = LabelPatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'invalid body')
    const label = updateLabel(db, id, body.data)
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'label.update', target: id, meta: { patch: Object.keys(body.data) } })
    // A rename or a recolour changes what every device carrying it renders —
    // the chip text and its colour both live inline on the device row.
    announce(deviceIdsWithLabel(db, id))
    return typedJson(c, LabelResponseSchema, { label })
  })

  // Deleting a label takes it off its devices in the same transaction — the
  // devices stay, only the label goes away, exactly as deleting a group
  // leaves its members standing.
  app.delete('/:id', requirePermission('device.settings'), (c) => {
    const { name, deviceIds } = deleteLabel(db, c.req.param('id'))
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'label.delete', target: c.req.param('id'), meta: { name, devices: deviceIds.length } })
    announce(deviceIds)
    return c.body(null, 204)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const status = err.code === 'label_not_found' ? 404 : err.code === 'label_exists' ? 409 : err.code === 'E_BAD_REQUEST' ? 400 : 500
      return c.json(err.toJSON(), status as 400)
    }
    if (err instanceof z.ZodError) {
      return c.json(new EnkakuError('E_BAD_REQUEST', err.issues.map((i) => i.message).join('; ')).toJSON(), 400)
    }
    throw err
  })

  return app
}

/** Which devices carry one label right now — only ever called on a mutation, never per row of a list. */
function deviceIdsWithLabel(db: Db, labelId: string): string[] {
  return db
    .select({ deviceId: deviceLabels.deviceId })
    .from(deviceLabels)
    .where(eq(deviceLabels.labelId, labelId))
    .all()
    .map((r) => r.deviceId)
}
