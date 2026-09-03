import { Hono } from 'hono'
import { AdbEndpointCreateResponseSchema, AdbEndpointResponseSchema, E_DEVICE_CONFLICT, type ShellMode } from '@enkaku/protocol'
import { z } from 'zod'
import type { AuthEnv } from '../auth/middleware'
import { canUseAdbEndpoint, canUseDevice } from '../auth/acl'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { DeviceStateMachine } from '../device/state-machine'
import { requireAdmission } from '../activity/admission'
import type { ActivityRegistry } from '../activity/registry'
import type { ControlPolicySettings } from '../activity/policy'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  device_not_found: 404,
  device_unavailable: 409,
  [E_DEVICE_CONFLICT]: 409,
  E_ADB_UNAVAILABLE: 503,
  E_BAD_REQUEST: 400,
}

const OpenBody = z.object({
  /**
   * The requesting browser tab's WS session id (the `sessionId` its `hello`
   * message carried — plan 31 §4.2 already sends this on every connection).
   * The activity this endpoint starts is keyed on it
   * (`command:adb-endpoint:<clientId>`, plan 205 §4.9) — there is no
   * HTTP-native notion of "which client is asking", so the browser tells us
   * which WS session it is. Never trusted for identity (the user is still
   * whoever `authMiddleware` resolved); only for which marker to start and
   * later end.
   */
  clientId: z.string().min(1),
})

/**
 * `POST/DELETE/GET /api/devices/:id/adb-endpoint` (plan 27 §4.3). All three
 * require `device.adb` (widened by the SAME `shell.mode` switch the
 * terminal uses, `canUseAdbEndpoint`) AND the device activity policy
 * (plan 205 §4.9) — the same `requireAdmission` door `shell.exec` takes for
 * its own `command` marker.
 */
export function createAdbEndpointRoutes(deps: {
  manager: AdbEndpointManager
  activities: Pick<ActivityRegistry, 'start' | 'end'>
  controlSettings: () => ControlPolicySettings
  states: Pick<DeviceStateMachine, 'current'>
  userLabel?: (userId: string | null) => string | null
  shellSettings: () => { mode: ShellMode; endpointEnabled: boolean }
  /** `canUseDevice`'s device half (plan 34 §3.5, §4.4). */
  getDevice: (deviceId: string) => { ownerId: string | null } | null
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  function authorize(user: { id: string; role: 'admin' | 'operator' } | undefined, deviceId: string, clientId: string): void {
    const settings = deps.shellSettings()
    if (!settings.endpointEnabled) {
      throw new EnkakuError('auth.forbidden', 'the adb endpoint is disabled for this farm (shell.endpointEnabled)')
    }
    if (!user || !canUseAdbEndpoint(user.role, settings.mode)) {
      throw new EnkakuError('auth.forbidden', 'you do not have permission to open an adb endpoint on this device')
    }
    // `canUseDevice` (plan 34 §3.5, §4.4) — this is "the Plan 27 endpoint"
    // the plan names explicitly: lending the caller's own `adb` full control
    // of a device someone else owns is exactly the case ownership exists to stop.
    const device = deps.getDevice(deviceId)
    if (device && !canUseDevice(user, device)) {
      throw new EnkakuError('auth.forbidden', 'this device belongs to another user')
    }
    requireAdmission(deps.activities, deps.controlSettings, deps.states, deviceId, 'command', { selfIds: [`command:adb-endpoint:${clientId}`] })
  }

  app.post('/:id/adb-endpoint', async (c) => {
    const deviceId = c.req.param('id')
    const body = OpenBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { clientId } is required')
    authorize(c.get('user'), deviceId, body.data.clientId)
    const userId = c.get('user')?.id ?? null
    const { host, port, expiresAt } = await deps.manager.open(deviceId, body.data.clientId, userId)
    deps.activities.start(deviceId, {
      id: `command:adb-endpoint:${body.data.clientId}`,
      kind: 'command',
      label: 'adb endpoint open',
      actor: { kind: 'user', id: userId ?? body.data.clientId, label: deps.userLabel?.(userId) ?? 'a signed-out client' },
    })
    return typedJson(c, AdbEndpointCreateResponseSchema, { host, port, expiresAt, command: `adb connect ${host}:${port}` })
  })

  app.delete('/:id/adb-endpoint', (c) => {
    const deviceId = c.req.param('id')
    const clientId = c.req.query('clientId')
    if (!clientId) throw new EnkakuError('E_BAD_REQUEST', 'a clientId query parameter is required')
    authorize(c.get('user'), deviceId, clientId)
    deps.manager.close(deviceId, 'closed_by_user')
    deps.activities.end(deviceId, `command:adb-endpoint:${clientId}`)
    return c.json({ ok: true })
  })

  app.get('/:id/adb-endpoint', (c) => {
    const deviceId = c.req.param('id')
    const clientId = c.req.query('clientId')
    if (!clientId) throw new EnkakuError('E_BAD_REQUEST', 'a clientId query parameter is required')
    authorize(c.get('user'), deviceId, clientId)
    return typedJson(c, AdbEndpointResponseSchema, { endpoint: deps.manager.get(deviceId) })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
