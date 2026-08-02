import { Hono } from 'hono'
import type { ShellMode } from '@enkaku/protocol'
import { z } from 'zod'
import type { AuthEnv } from '../auth/middleware'
import { canUseAdbEndpoint } from '../auth/acl'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { LeaseManager } from '../lease/lease-manager'
import { EnkakuError } from '../util/errors'

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  device_not_found: 404,
  device_busy: 409,
  no_lease: 409,
  not_lease_holder: 409,
  device_unavailable: 409,
  E_ADB_UNAVAILABLE: 503,
  E_BAD_REQUEST: 400,
}

const OpenBody = z.object({
  /**
   * The requesting browser tab's WS session id (the `sessionId` its `hello`
   * message carried — plan 31 §4.2 already sends this on every connection).
   * The adb endpoint is lease-scoped, and a manual lease's holder IS a WS
   * `clientId` (plan 04 §4.1) — there is no HTTP-native notion of "the
   * client currently holding control", so the browser tells us which WS
   * session it is, and `leases.checkInputAllowed` verifies that session
   * really does hold the lease before anything opens. Never trusted for
   * identity (the user is still whoever `authMiddleware` resolved); only for
   * "which lease".
   */
  clientId: z.string().min(1),
})

/**
 * `POST/DELETE/GET /api/devices/:id/adb-endpoint` (plan 27 §4.3). All three
 * require `device.adb` (widened by the SAME `shell.mode` switch the
 * terminal uses, `canUseAdbEndpoint`) AND the manual lease, checked with the
 * same `leases.checkInputAllowed` call plan 26 uses for `shell.exec` — one
 * policy, one implementation, reused rather than re-derived.
 */
export function createAdbEndpointRoutes(deps: {
  manager: AdbEndpointManager
  leases: LeaseManager
  shellSettings: () => { mode: ShellMode; endpointEnabled: boolean }
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  function authorize(user: { role: 'admin' | 'operator' } | undefined, deviceId: string, clientId: string): void {
    const settings = deps.shellSettings()
    if (!settings.endpointEnabled) {
      throw new EnkakuError('auth.forbidden', 'the adb endpoint is disabled for this farm (shell.endpointEnabled)')
    }
    if (!user || !canUseAdbEndpoint(user.role, settings.mode)) {
      throw new EnkakuError('auth.forbidden', 'you do not have permission to open an adb endpoint on this device')
    }
    const allowed = deps.leases.checkInputAllowed(deviceId, clientId)
    if (!allowed.ok) throw new EnkakuError(allowed.code, allowed.message)
  }

  app.post('/:id/adb-endpoint', async (c) => {
    const deviceId = c.req.param('id')
    const body = OpenBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { clientId } is required')
    authorize(c.get('user'), deviceId, body.data.clientId)
    const userId = c.get('user')?.id ?? null
    const { host, port, expiresAt } = await deps.manager.open(deviceId, body.data.clientId, userId)
    return c.json({ host, port, expiresAt, command: `adb connect ${host}:${port}` })
  })

  app.delete('/:id/adb-endpoint', (c) => {
    const deviceId = c.req.param('id')
    const clientId = c.req.query('clientId')
    if (!clientId) throw new EnkakuError('E_BAD_REQUEST', 'a clientId query parameter is required')
    authorize(c.get('user'), deviceId, clientId)
    deps.manager.close(deviceId, 'closed_by_user')
    return c.json({ ok: true })
  })

  app.get('/:id/adb-endpoint', (c) => {
    const deviceId = c.req.param('id')
    const clientId = c.req.query('clientId')
    if (!clientId) throw new EnkakuError('E_BAD_REQUEST', 'a clientId query parameter is required')
    authorize(c.get('user'), deviceId, clientId)
    return c.json({ endpoint: deps.manager.get(deviceId) })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
