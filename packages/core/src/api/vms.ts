import { Hono } from 'hono'
import { VmCreateBodySchema, VmListResponseSchema, VmResponseSchema, type VmRecord } from '@enkaku/protocol'
import { can } from '../auth/acl'
import type { AuthEnv } from '../auth/middleware'
import { EnkakuError } from '../util/errors'
import type { VmManager } from '../vm/manager'
import type { VmRecord as CoreVmRecord } from '../vm/types'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  E_BAD_REQUEST: 400,
  E_VM_NOT_FOUND: 404,
  E_VM_LIMIT: 409,
  E_VM_NO_PORT: 409,
  E_VM_CONFLICT: 409,
  E_ANDROID_SDK_MISSING: 503,
}

/** Wire-shape a core `VmRecord` — `Date` fields become integer unix seconds (`CLAUDE.md`). */
function toWire(record: CoreVmRecord): VmRecord {
  return {
    id: record.id,
    name: record.name,
    state: record.state,
    consolePort: record.consolePort,
    serial: record.serial,
    spec: record.spec,
    message: record.message,
    createdAt: Math.floor(record.createdAt.getTime() / 1000),
    startedAt: record.startedAt ? Math.floor(record.startedAt.getTime() / 1000) : null,
  }
}

/**
 * `/api/vms` (plan 402 §4.2) — five routes over plan 401's `VmManager`. No
 * WebSocket message (plan 402 §3.2): Studio polls this while its dialog is
 * open, and once the emulator boots the ordinary `device.*` events take over
 * (plan 400 D2).
 *
 * A VM is not a device (plan 400 D6, plan 402 §3.4): this file never joins,
 * embeds, or looks up a `devices` row. The `serial` field is observational
 * only.
 */
export function createVmRoutes(deps: { manager: VmManager }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  function authorizeView(user: { role: 'admin' | 'operator' } | undefined): void {
    if (!user || !can(user.role, 'device.view')) {
      throw new EnkakuError('auth.forbidden', 'requires the device.view permission')
    }
  }

  /**
   * Creating, starting, stopping, or deleting a virtual device is adding (or
   * removing) a device to this farm, which is what `device.enroll` names
   * (plan 402 §3.3). Whether this should instead be admin-only is plan 402
   * §9 Q4 — an owner decision, not this route's.
   */
  function authorizeEnroll(user: { role: 'admin' | 'operator' } | undefined): void {
    if (!user || !can(user.role, 'device.enroll')) {
      throw new EnkakuError('auth.forbidden', 'requires the device.enroll permission')
    }
  }

  app.get('/', (c) => {
    authorizeView(c.get('user'))
    return typedJson(c, VmListResponseSchema, { vms: deps.manager.list().map(toWire) })
  })

  app.post('/', async (c) => {
    authorizeEnroll(c.get('user'))
    const body = VmCreateBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a valid virtual device spec is required')
    const record = await deps.manager.create(body.data)
    return typedJson(c, VmResponseSchema, { vm: toWire(record) }, 201)
  })

  app.post('/:id/start', (c) => {
    authorizeEnroll(c.get('user'))
    const id = c.req.param('id')
    // The row must exist before anything is kicked off, so a bad id is a
    // synchronous 404 rather than a background failure nobody is polling
    // for yet.
    const before = deps.manager.list().find((v) => v.id === id)
    if (!before) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)

    // `VmManager.start` awaits the FULL boot-poll loop (up to
    // `VM_BOOT_TIMEOUT_SEC`, plan 401 §4.4/§11) — up to five minutes, which
    // no reverse proxy or browser will tolerate on one HTTP request. This
    // route does NOT await it: calling an async function runs it
    // synchronously up to its first `await` before returning a pending
    // promise, and `VmManager.start`'s own first line sets the row to
    // `starting` before its first `await` (`manager.ts`'s `setRow(id, {
    // state: 'starting', ... })` precedes `await deps.provider.start(...)`).
    // So by the time this line returns, the row is already `starting`, and
    // the response below reads that state straight back off the manager.
    // The background promise is left running; its terminal state (`running`
    // or `failed`) lands in the row and Studio's dialog polls `GET /api/vms`
    // for it (plan 402 §3.2) rather than this request waiting for it.
    const startPromise = deps.manager.start(id)
    // Already recorded on the row by `VmManager` itself (`failed` +
    // message) — this catch exists only so a later provider/adb failure
    // never surfaces as an unhandled rejection.
    startPromise.catch(() => {})

    const after = deps.manager.list().find((v) => v.id === id)
    if (!after) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)
    return typedJson(c, VmResponseSchema, { vm: toWire(after) }, 202)
  })

  app.post('/:id/stop', (c) => {
    authorizeEnroll(c.get('user'))
    const id = c.req.param('id')
    const before = deps.manager.list().find((v) => v.id === id)
    if (!before) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)

    // Same fire-and-forget shape as `/start` above, for the same reason:
    // `VmManager.stop` sets the row to `stopping` before its own first
    // `await` (`stopImpl`'s `setRow(id, { state: 'stopping' })` precedes
    // `await deps.provider.stop(...)`), so the synchronous prefix has
    // already run by the time this line returns, and the 202 response
    // below reads `stopping` straight back off the manager rather than
    // waiting out the stop grace period.
    const stopPromise = deps.manager.stop(id)
    // Swallowed for the same reason as `/start`'s catch above.
    stopPromise.catch(() => {})

    const after = deps.manager.list().find((v) => v.id === id)
    if (!after) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)
    return typedJson(c, VmResponseSchema, { vm: toWire(after) }, 202)
  })

  app.delete('/:id', async (c) => {
    authorizeEnroll(c.get('user'))
    const id = c.req.param('id')
    // Stops first if running, then deletes the AVD (plan 402 §4.2). This
    // never touches the device row (plan 400 D6) — `VmManager.remove` only
    // ever reaches into `virtual_devices`.
    await deps.manager.remove(id)
    return c.body(null, 204)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
