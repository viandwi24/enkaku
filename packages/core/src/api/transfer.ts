import { Hono } from 'hono'
import { InstallResponseSchema, PullResponseSchema, type ShellMode } from '@enkaku/protocol'
import { z } from 'zod'
import type { AuthEnv } from '../auth/middleware'
import { canUseFiles } from '../auth/acl'
import type { LeaseManager } from '../lease/lease-manager'
import type { EventRecorder } from '../events/recorder'
import type { TransferService } from '../device/transfer'
import { runTransfer, type TransferBroadcast } from '../device/transfer-dispatch'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  device_not_found: 404,
  device_busy: 409,
  no_lease: 409,
  not_lease_holder: 409,
  device_unavailable: 409,
  E_ADB_UNAVAILABLE: 503,
  E_UNSUPPORTED: 400,
  E_BAD_REQUEST: 400,
  E_BAD_PATH: 400,
  artifact_not_found: 404,
  E_TRANSFER_TOO_LARGE: 413,
  E_NOT_FOUND: 404,
  E_INSTALL_FAILED: 422,
  E_INSTALL_TIMEOUT: 504,
  E_TRANSFER_CANCELLED: 499,
}

/**
 * The requesting browser tab's WS session id — same pattern and same
 * reasoning as plan 27's `AdbEndpointRoutes` `OpenBody.clientId` (see
 * `api/adb-endpoint.ts`): a manual lease's holder IS a WS `clientId`, and
 * there is no HTTP-native notion of "the client currently holding control",
 * so the browser tells us which WS session it is. Never trusted for
 * identity — only for "which lease" — `authMiddleware` still resolves the
 * real user.
 */
const InstallBody = z.object({
  artifactId: z.string().min(1),
  clientId: z.string().min(1),
  reinstall: z.boolean().optional(),
  grantPermissions: z.boolean().optional(),
  allowDowngrade: z.boolean().optional(),
})
const PushBody = z.object({ artifactId: z.string().min(1), remotePath: z.string().min(1), clientId: z.string().min(1) })
const PullBody = z.object({ remotePath: z.string().min(1), clientId: z.string().min(1) })

export interface TransferRoutesDeps {
  transfer: TransferService
  leases: LeaseManager
  /** Main/input-stream device events (plan 39 §4.4: `device.install`/`device.push`/`device.pull` on `input`). */
  record: EventRecorder['record']
  shellSettings: () => { mode: ShellMode }
  transferSettings: () => { enabled: boolean }
  broadcast: TransferBroadcast
  /** Readiness hold (plan 43 §5 step 43.7) — optional so a host that does not wire readiness keeps working unchanged. */
  holdFor?: (deviceId: string) => Promise<{ release(): void }>
}

/**
 * `POST /api/devices/:id/install|push|pull` (plan 39 §4.4). All three
 * require `transfer.enabled`, the `device.files` permission (widened by the
 * SAME `shell.mode` switch the terminal and the adb endpoint use), and the
 * manual lease — checked with the exact `leases.checkInputAllowed` call
 * plan 26/27 already use, so this is one policy, not a fourth
 * reimplementation of it.
 */
export function createTransferRoutes(deps: TransferRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  function authorize(user: { role: 'admin' | 'operator' } | undefined, deviceId: string, clientId: string): void {
    if (!deps.transferSettings().enabled) {
      throw new EnkakuError('auth.forbidden', 'file transfer is disabled for this farm (transfer.enabled)')
    }
    if (!user || !canUseFiles(user.role, deps.shellSettings().mode)) {
      throw new EnkakuError('auth.forbidden', 'you do not have permission to transfer files on this device')
    }
    const allowed = deps.leases.checkInputAllowed(deviceId, clientId)
    if (!allowed.ok) throw new EnkakuError(allowed.code, allowed.message)
  }

  app.post('/:id/install', async (c) => {
    const deviceId = c.req.param('id')
    const body = InstallBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { artifactId, clientId } is required')
    authorize(c.get('user'), deviceId, body.data.clientId)
    const userId = c.get('user')?.id ?? null

    try {
      const result = await runTransfer({
        transfer: deps.transfer,
        broadcast: deps.broadcast,
        deviceId,
        kind: 'install',
        holdFor: deps.holdFor,
        op: (transferId, onProgress) =>
          deps.transfer.install(deviceId, body.data.artifactId, {
            transferId,
            onProgress,
            ...(body.data.reinstall !== undefined ? { reinstall: body.data.reinstall } : {}),
            ...(body.data.grantPermissions !== undefined ? { grantPermissions: body.data.grantPermissions } : {}),
            ...(body.data.allowDowngrade !== undefined ? { allowDowngrade: body.data.allowDowngrade } : {}),
          }),
      })
      deps.record({
        deviceId,
        stream: 'input',
        kind: 'device.install',
        actor: userId,
        meta: { artifactId: body.data.artifactId, package: result.package, ok: true },
      })
      return typedJson(c, InstallResponseSchema, { result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      deps.record({
        deviceId,
        stream: 'input',
        kind: 'device.install',
        actor: userId,
        meta: { artifactId: body.data.artifactId, ok: false, error: message },
      })
      throw err
    }
  })

  app.post('/:id/push', async (c) => {
    const deviceId = c.req.param('id')
    const body = PushBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { artifactId, remotePath, clientId } is required')
    authorize(c.get('user'), deviceId, body.data.clientId)
    const userId = c.get('user')?.id ?? null

    try {
      await runTransfer({
        transfer: deps.transfer,
        broadcast: deps.broadcast,
        deviceId,
        kind: 'push',
        holdFor: deps.holdFor,
        op: (transferId, onProgress) => deps.transfer.push(deviceId, body.data.artifactId, body.data.remotePath, { transferId, onProgress }),
      })
      deps.record({
        deviceId,
        stream: 'input',
        kind: 'device.push',
        actor: userId,
        meta: { artifactId: body.data.artifactId, remotePath: body.data.remotePath, ok: true },
      })
      return c.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      deps.record({
        deviceId,
        stream: 'input',
        kind: 'device.push',
        actor: userId,
        meta: { artifactId: body.data.artifactId, remotePath: body.data.remotePath, ok: false, error: message },
      })
      throw err
    }
  })

  app.post('/:id/pull', async (c) => {
    const deviceId = c.req.param('id')
    const body = PullBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { remotePath, clientId } is required')
    authorize(c.get('user'), deviceId, body.data.clientId)
    const userId = c.get('user')?.id ?? null

    try {
      const result = await runTransfer({
        transfer: deps.transfer,
        broadcast: deps.broadcast,
        deviceId,
        kind: 'pull',
        holdFor: deps.holdFor,
        op: (transferId, onProgress) => deps.transfer.pull(deviceId, body.data.remotePath, { transferId, onProgress }),
      })
      deps.record({
        deviceId,
        stream: 'input',
        kind: 'device.pull',
        actor: userId,
        meta: { remotePath: body.data.remotePath, bytes: result.bytes, ok: true },
      })
      return typedJson(c, PullResponseSchema, { result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      deps.record({
        deviceId,
        stream: 'input',
        kind: 'device.pull',
        actor: userId,
        meta: { remotePath: body.data.remotePath, ok: false, error: message },
      })
      throw err
    }
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
