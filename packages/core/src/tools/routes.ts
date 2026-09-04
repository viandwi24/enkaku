import { Hono } from 'hono'
import { z } from 'zod'
import {
  AdbRestartPreviewSchema,
  AdbRestartReportSchema,
  AppRestartPreviewSchema,
  AppRestartReportSchema,
  ToolsResponseSchema,
  type AppRestartPreview,
} from '@enkaku/protocol'
import { ToolchainError, type ToolchainManager } from '@enkaku/toolchain'
import { typedJson } from '../api/typed-json'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import { EnkakuError } from '../util/errors'
import type { AdbServerControl } from './adb-server-control'
import type { AppRestartControl } from './app-restart-control'
import { REQUIRED_TOOLS } from './required'

const VersionBody = z.object({ version: z.string().min(1) })
const AdbRestartBody = z.object({ force: z.boolean().optional() })
const AppRestartBody = z.object({ force: z.boolean().optional() })

const ERROR_STATUS: Record<string, number> = {
  E_TOOL_NOT_FOUND: 404,
  E_VERSION_NOT_IN_MANIFEST: 404,
  E_NOT_INSTALLED: 404,
  E_NOT_SWAPPABLE: 403,
  E_CHECKSUM_MISMATCH: 502,
  E_CHECKSUM_MISSING: 409,
  E_DELETE_ACTIVE: 409,
  E_TOOL_IN_USE: 409,
  E_HEALTH_CHECK_FAILED: 409,
  E_ALREADY_INSTALLED: 409,
  E_MANIFEST_FETCH_FAILED: 502,
  E_TOOL_NOT_PROVISIONED: 409,
  E_PLATFORM_UNSUPPORTED: 409,
  E_DOWNLOAD_FAILED: 502,
  E_DOWNLOAD_STALLED: 502,
}

/**
 * The "Restart adb server" button's dependencies (plan 88 §3.10, §4.8, §5
 * step 88.8) — bundled separately from `audit` because it is optional in a
 * different way: adb genuinely has nothing to restart before the adb
 * subsystem finishes provisioning (or in orchestrator mode, where it never
 * comes up at all), and the route says so (`E_ADB_UNAVAILABLE`) rather than
 * pretending the button exists.
 */
export interface AdbControlRouteDeps {
  /** The one shared drain/kill/start/reattach implementation (plan 88 §3.10) — the SAME instance the Toolchain Manager's version swap already runs through, so the two share one mutex. */
  control: AdbServerControl
  /** The current adb binary path — a restart stops and starts the SAME binary, unlike a version swap. `null` while adb has not finished provisioning. */
  binaryPath: () => string | null
  /** Live counts for the confirmation dialog, fetched fresh on every call. */
  preview: () => { devicesTotal: number; sessionsActive: number; networkDevicesWithEndpoint: number }
  /** Named, not just counted (plan 88 §3.10's `E_ADB_BUSY_FARM` guard: "listing running jobs and controlled devices"). */
  busyFarm: () => { runningJobs: Array<{ id: string; label: string }>; controlledDevices: Array<{ deviceId: string; label: string }> }
  restartCooldownSec: () => number
}

/**
 * "Restart Enkaku" (plan 120 §4) — the whole core process's dependencies,
 * mirroring `AdbControlRouteDeps` above in shape and reasoning: bundled
 * separately from `audit`, optional for the same "not ready / not this
 * caller's job to build" reasons `adb` above already documents. No
 * `binaryPath`/`busyFarm` here — there is no version-swap concept for the
 * process itself, and the busy-farm guard for THIS action is the route's
 * own body below (`force`), not a separate pre-check endpoint the way adb's
 * `E_ADB_BUSY_FARM` needed one.
 */
export interface AppRestartRouteDeps {
  /** The one restart implementation (plan 120 §4) — drains, detects the deployment mode, and acts accordingly. */
  control: AppRestartControl
  /** Live counts plus the detected supervision mode, fetched fresh on every call — never cached, same reasoning as `AdbControlRouteDeps.preview`. */
  preview: () => AppRestartPreview
}

/**
 * The /api/tools routes — exactly spec §7.7, with the §7.8 guards in
 * ToolchainManager. Permission model per plan 09 §4.4's matrix: `tool.view`
 * for the list, `tool.manage` (admin-only in `auth/acl.ts`) for every
 * mutation — the plan's own table names this exact route set verbatim:
 * "install/activate/delete/check/manifest-refresh". None of that was wired
 * up until this fix (a security-sweep finding): every route here was
 * reachable by any authenticated operator, with no audit trail, despite
 * `tool.manage` and the `tool.install`/`tool.activate`/`tool.delete` audit
 * actions already existing in `auth/acl.ts`/`auth/audit.ts` unused.
 *
 * `audit` is optional so an existing caller (`daemon.ts`'s
 * `createToolsRoutes(deps.toolchain)`) keeps compiling unchanged — wiring it
 * through is a one-line follow-up outside this file's ownership.
 *
 * `adb` (plan 88 §3.10, §5 step 88.8) adds `POST /adb/restart` and its
 * preview, under the SAME `tool.manage` gate. Also optional, for the same
 * "an existing caller keeps compiling" reason, and additionally because a
 * host with no adb subsystem (orchestrator mode) has nothing to restart.
 *
 * `app` (plan 120 §4) adds `POST /app/restart` and its preview, under the
 * SAME `tool.manage` gate — already the strictest this ACL has (`tool.manage`
 * is absent from `auth/acl.ts`'s `OPERATOR` set, so `can(role, 'tool.manage')`
 * only ever admits `admin`; there is no stricter tier to reach for here).
 * Optional for the same reasons `adb` is.
 */
export function createToolsRoutes(
  manager: ToolchainManager,
  deps: { audit?: AuditLogger; adb?: AdbControlRouteDeps; app?: AppRestartRouteDeps } = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const actorId = (c: { get(k: 'user'): { id: string } | undefined }): string | null => c.get('user')?.id ?? null

  app.get('/', requirePermission('tool.view'), async (c) => typedJson(c, ToolsResponseSchema, { tools: await manager.list() }))

  /**
   * Re-run provisioning for the core-managed tools. The pinned ones are not
   * swappable, so /:id/install rejects them (E_NOT_SWAPPABLE) — without this
   * route a tool that failed to install at boot could only be recovered by
   * restarting the core. Tolerant: every tool is attempted, failures are
   * reported per tool.
   */
  app.post('/repair', requirePermission('tool.manage'), async (c) => {
    const repaired: string[] = []
    const failed: Array<{ toolId: string; code: string; message: string }> = []
    for (const toolId of REQUIRED_TOOLS) {
      try {
        await manager.ensureRequiredTools([toolId])
        repaired.push(toolId)
      } catch (err) {
        const code = err instanceof ToolchainError ? err.code : 'E_INTERNAL'
        failed.push({ toolId, code, message: err instanceof Error ? err.message : String(err) })
      }
    }
    deps.audit?.record({ userId: actorId(c), action: 'tool.repair', meta: { repaired, failed: failed.map((f) => f.toolId) } })
    return c.json({ ok: failed.length === 0, repaired, failed })
  })

  app.post('/manifest/refresh', requirePermission('tool.manage'), async (c) => {
    const manifest = await manager.manifests.refresh()
    deps.audit?.record({ userId: actorId(c), action: 'tool.manifest.refresh', meta: { updatedAt: manifest.updatedAt, tools: manifest.tools.length } })
    return c.json({ ok: true, updatedAt: manifest.updatedAt, tools: manifest.tools.length })
  })

  app.post('/:id/install', requirePermission('tool.manage'), async (c) => {
    const body = VersionBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: 'a body of { version } is required' } }, 400)
    await manager.install(c.req.param('id'), body.data.version)
    deps.audit?.record({ userId: actorId(c), action: 'tool.install', target: c.req.param('id'), meta: { version: body.data.version } })
    return c.json({ ok: true })
  })

  app.post('/:id/activate', requirePermission('tool.manage'), async (c) => {
    const body = VersionBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: 'a body of { version } is required' } }, 400)
    await manager.activate(c.req.param('id'), body.data.version)
    deps.audit?.record({ userId: actorId(c), action: 'tool.activate', target: c.req.param('id'), meta: { version: body.data.version } })
    return c.json({ ok: true })
  })

  // `check` is a diagnostic (health probe), not a state change — no audit entry, matching every
  // other read-shaped action in this codebase that only ever gets a permission gate.
  app.post('/:id/check', requirePermission('tool.manage'), async (c) => {
    const health = await manager.check(c.req.param('id'))
    return c.json({ health })
  })

  app.delete('/:id/:version', requirePermission('tool.manage'), async (c) => {
    await manager.remove(c.req.param('id'), c.req.param('version'))
    deps.audit?.record({ userId: actorId(c), action: 'tool.delete', target: c.req.param('id'), meta: { version: c.req.param('version') } })
    return c.json({ ok: true })
  })

  // `POST /adb/restart` and its preview (plan 88 §3.10, §4.8, §5 step 88.8)
  // are registered BEFORE `/:id/install` etc. above would ever shadow them —
  // Hono matches `/:id/*` params literally against `adb`, so without this
  // ordering concern `/adb/restart` would still resolve correctly (it is a
  // distinct path shape, `/adb/restart` vs `/:id/install`), but the routes
  // are grouped here regardless, next to each other, for readability.
  app.get('/adb/restart-preview', requirePermission('tool.manage'), (c) => {
    if (!deps.adb) return c.json({ error: { code: 'E_ADB_UNAVAILABLE', message: 'adb is not ready yet' } }, 503)
    const busy = deps.adb.busyFarm()
    const preview = deps.adb.preview()
    return typedJson(c, AdbRestartPreviewSchema, {
      devicesTotal: preview.devicesTotal,
      sessionsActive: preview.sessionsActive,
      controlled: busy.controlledDevices.length,
      jobsRunning: busy.runningJobs.length,
      networkDevicesWithEndpoint: preview.networkDevicesWithEndpoint,
      restartCooldownSec: deps.adb.restartCooldownSec(),
    })
  })

  let lastRestartAt: number | null = null

  /**
   * Restart the shared adb server (plan 88 §3.10). `tool.manage` (admin
   * only, F25); rate-limited to one per `restartCooldownSec`; refused with
   * `E_ADB_BUSY_FARM` — naming every running job and controlled device — unless
   * `force`. No automatic restart anywhere in this codebase calls this: it
   * is reachable from exactly one place, an operator's click on the Tools
   * page (plan 88 §3.10's "no automatic restart, ever").
   */
  app.post('/adb/restart', requirePermission('tool.manage'), async (c) => {
    if (!deps.adb) return c.json({ error: { code: 'E_ADB_UNAVAILABLE', message: 'adb is not ready yet' } }, 503)

    const rawBody = await c.req.json().catch(() => ({}))
    const parsedBody = AdbRestartBody.safeParse(rawBody)
    const force = parsedBody.success ? Boolean(parsedBody.data.force) : false

    const cooldownSec = deps.adb.restartCooldownSec()
    if (lastRestartAt !== null) {
      const elapsedSec = (Date.now() - lastRestartAt) / 1000
      if (elapsedSec < cooldownSec) {
        const waitSec = Math.max(1, Math.ceil(cooldownSec - elapsedSec))
        return c.json(
          { error: { code: 'E_RATE_LIMITED', message: `adb was restarted recently — wait ${waitSec}s before trying again` } },
          429,
        )
      }
    }

    if (!force) {
      const busy = deps.adb.busyFarm()
      if (busy.runningJobs.length > 0 || busy.controlledDevices.length > 0) {
        return c.json(
          {
            error: {
              code: 'E_ADB_BUSY_FARM',
              message: `restarting adb now would fail ${busy.runningJobs.length} running job(s) and release control on ${busy.controlledDevices.length} device(s) — pass force to restart anyway`,
            },
            runningJobs: busy.runningJobs,
            controlledDevices: busy.controlledDevices,
          },
          409,
        )
      }
    }

    const binaryPath = deps.adb.binaryPath()
    if (!binaryPath) return c.json({ error: { code: 'E_ADB_UNAVAILABLE', message: 'adb is not ready yet' } }, 503)

    lastRestartAt = Date.now()
    const report = await deps.adb.control.cycle({ reason: 'restart', oldBinaryPath: binaryPath, newBinaryPath: binaryPath, force })
    deps.audit?.record({ userId: actorId(c), action: 'adb.restart', meta: { force, ...report } })
    return typedJson(c, AdbRestartReportSchema, report)
  })

  // "Restart Enkaku" (plan 120 §4) — the whole core process, a materially
  // bigger blast radius than `/adb/restart` above (every live session/stream
  // drops, every in-flight job is interrupted, the farm is briefly fully
  // unreachable), grouped right after it for the same readability reason
  // `/adb/restart` is grouped beside `/adb/restart-preview`.
  app.get('/app/restart-preview', requirePermission('tool.manage'), (c) => {
    if (!deps.app) return c.json({ error: { code: 'E_APP_RESTART_UNAVAILABLE', message: 'the app restart control is not ready yet' } }, 503)
    return typedJson(c, AppRestartPreviewSchema, deps.app.preview())
  })

  /**
   * Restart the whole core process (plan 120 §4). `tool.manage` — already
   * admin-only in `auth/acl.ts` (`tool.manage` is absent from the
   * `OPERATOR` set, so `can(role, 'tool.manage')` only ever admits `admin`;
   * there is no stricter permission tier in this ACL to reach for). Refused
   * with `E_APP_BUSY_FARM` — the same shape `/adb/restart`'s
   * `E_ADB_BUSY_FARM` guard above uses — unless `force`. No automatic
   * restart anywhere in this codebase calls this: it is reachable from
   * exactly one place, an operator's confirmed click on the Tools page.
   */
  app.post('/app/restart', requirePermission('tool.manage'), async (c) => {
    if (!deps.app) return c.json({ error: { code: 'E_APP_RESTART_UNAVAILABLE', message: 'the app restart control is not ready yet' } }, 503)

    const rawBody = await c.req.json().catch(() => ({}))
    const parsedBody = AppRestartBody.safeParse(rawBody)
    const force = parsedBody.success ? Boolean(parsedBody.data.force) : false

    if (!force) {
      const preview = deps.app.preview()
      if (preview.jobsRunning > 0 || preview.controlled > 0) {
        return c.json(
          {
            error: {
              code: 'E_APP_BUSY_FARM',
              message: `restarting Enkaku now would fail ${preview.jobsRunning} running job(s) and release control on ${preview.controlled} device(s) — pass force to restart anyway`,
            },
          },
          409,
        )
      }
    }

    try {
      // For `mode: 'docker' | 'systemd'` the process exits a short beat
      // AFTER this resolves (see `app-restart-control.ts`'s own header) —
      // this response is the one honest confirmation the caller ever gets
      // for those two modes ("restart initiated", never "restart
      // succeeded"). For `mode: 'bare'` this only resolves at all once the
      // new process has already proven itself healthy, so `outcome:
      // 'verified'` here means exactly what it says.
      const report = await deps.app.control.restart({ force })
      deps.audit?.record({ userId: actorId(c), action: 'app.restart', meta: { force, ...report } })
      return typedJson(c, AppRestartReportSchema, report)
    } catch (err) {
      if (err instanceof EnkakuError) {
        const status = err.code === 'E_TOOL_IN_USE' ? 409 : 500
        return c.json(err.toJSON(), status)
      }
      throw err
    }
  })

  app.onError((err, c) => {
    if (err instanceof ToolchainError) {
      const status = ERROR_STATUS[err.code] ?? 500
      return c.json(err.toJSON(), status as 400)
    }
    throw err
  })

  return app
}
