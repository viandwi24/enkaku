import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { ToolchainManager } from '@enkaku/toolchain'
import type { AppRestartPreview, AppRestartReport, SupervisionMode } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import type { AdbCycleOpts, AdbCycleReport, AdbServerControl } from './adb-server-control'
import type { AppRestartControl, AppRestartOpts } from './app-restart-control'
import { createToolsRoutes, type AdbControlRouteDeps, type AppRestartRouteDeps } from './routes'

/**
 * `/api/tools` (security-sweep finding, `packages/core/src/tools/routes.ts`):
 * every route here — including install/activate/delete, which run arbitrary
 * downloaded binaries under a new version — had NO `requirePermission` and NO
 * audit trail, despite `tool.manage` already being admin-only in
 * `auth/acl.ts` and `tool.install`/`tool.activate`/`tool.delete` already
 * existing (and going entirely unused) in `auth/audit.ts`. Plan 09 §4.4's own
 * matrix names this exact route set under `tool.manage`:
 * "install/activate/delete/check/manifest-refresh". This file had zero test
 * coverage before this fix.
 */

function fakeManager(overrides: Partial<ToolchainManager> = {}): ToolchainManager {
  const base = {
    list: async () => [],
    install: async () => {},
    activate: async () => {},
    check: async () => ({ ok: true, checkedAt: 0, detail: 'fine' }),
    remove: async () => {},
    ensureRequiredTools: async () => {},
    manifests: { refresh: async () => ({ updatedAt: 0, tools: [] }) },
  }
  return { ...base, ...overrides } as unknown as ToolchainManager
}

function fakeAudit(): { audit: AuditLogger; calls: Parameters<AuditLogger['record']>[0][] } {
  const calls: Parameters<AuditLogger['record']>[0][] = []
  return { audit: { record: (input) => void calls.push(input), list: () => [] }, calls }
}

/** `Response.json()` types as `unknown` — this file only ever reads a test's OWN fixture shapes back, never real external input, so a bare cast is the right tool (not the Zod-validation rule, which is about production boundaries). */
async function asJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

describe('GET /api/tools — requires tool.view (plan 09 §4.4)', () => {
  test('no authenticated user is refused (403)', async () => {
    const app = withUser(null, createToolsRoutes(fakeManager()))
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })

  test('an operator (tool.view is an OPERATOR permission) may list tools', async () => {
    const app = withUser('operator', createToolsRoutes(fakeManager()))
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })
})

describe('mutating /api/tools routes — require tool.manage (admin-only, security fix)', () => {
  test('POST /repair: an operator is refused (403), and nothing is audited', async () => {
    const { audit, calls } = fakeAudit()
    const installCalls: string[] = []
    const app = withUser('operator', createToolsRoutes(fakeManager({ ensureRequiredTools: async (ids) => void installCalls.push(...ids) }), { audit }))
    const res = await app.request('/repair', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(installCalls).toEqual([])
    expect(calls).toEqual([])
  })

  test('POST /repair: an admin may repair, and it is audited as tool.repair', async () => {
    const { audit, calls } = fakeAudit()
    const app = withUser('admin', createToolsRoutes(fakeManager(), { audit }))
    const res = await app.request('/repair', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userId: 'u1', action: 'tool.repair' })
  })

  test('POST /manifest/refresh: an operator is refused (403)', async () => {
    const app = withUser('operator', createToolsRoutes(fakeManager()))
    const res = await app.request('/manifest/refresh', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('POST /manifest/refresh: an admin may refresh, and it is audited as tool.manifest.refresh', async () => {
    const { audit, calls } = fakeAudit()
    const app = withUser('admin', createToolsRoutes(fakeManager(), { audit }))
    const res = await app.request('/manifest/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ userId: 'u1', action: 'tool.manifest.refresh', meta: { updatedAt: 0, tools: 0 } }])
  })

  test('POST /:id/install: an operator is refused (403), and manager.install is never called', async () => {
    const installCalls: Array<{ id: string; version: string }> = []
    const app = withUser(
      'operator',
      createToolsRoutes(fakeManager({ install: async (id, version) => void installCalls.push({ id, version }) })),
    )
    const res = await app.request('/adb/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '36.0.0' }) })
    expect(res.status).toBe(403)
    expect(installCalls).toEqual([])
  })

  test('POST /:id/install: an admin may install, and it is audited as tool.install with the target and version', async () => {
    const { audit, calls } = fakeAudit()
    const app = withUser('admin', createToolsRoutes(fakeManager(), { audit }))
    const res = await app.request('/adb/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '36.0.0' }) })
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ userId: 'u1', action: 'tool.install', target: 'adb', meta: { version: '36.0.0' } }])
  })

  test('POST /:id/activate: an operator is refused (403)', async () => {
    const app = withUser('operator', createToolsRoutes(fakeManager()))
    const res = await app.request('/adb/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '36.0.0' }) })
    expect(res.status).toBe(403)
  })

  test('POST /:id/activate: an admin may activate, and it is audited as tool.activate', async () => {
    const { audit, calls } = fakeAudit()
    const app = withUser('admin', createToolsRoutes(fakeManager(), { audit }))
    const res = await app.request('/adb/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '36.0.0' }) })
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ userId: 'u1', action: 'tool.activate', target: 'adb', meta: { version: '36.0.0' } }])
  })

  test('POST /:id/check: an operator is refused (403) — plan 09 §4.4 lists check under tool.manage too', async () => {
    const app = withUser('operator', createToolsRoutes(fakeManager()))
    const res = await app.request('/adb/check', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('POST /:id/check: an admin may run it, and nothing is audited (diagnostic, not a state change)', async () => {
    const { audit, calls } = fakeAudit()
    const app = withUser('admin', createToolsRoutes(fakeManager(), { audit }))
    const res = await app.request('/adb/check', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(calls).toEqual([])
  })

  test('DELETE /:id/:version: an operator is refused (403), and manager.remove is never called', async () => {
    const removeCalls: Array<{ id: string; version: string }> = []
    const app = withUser(
      'operator',
      createToolsRoutes(fakeManager({ remove: async (id, version) => void removeCalls.push({ id, version }) })),
    )
    const res = await app.request('/adb/1.0.0', { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect(removeCalls).toEqual([])
  })

  test('DELETE /:id/:version: an admin may delete, and it is audited as tool.delete', async () => {
    const { audit, calls } = fakeAudit()
    const app = withUser('admin', createToolsRoutes(fakeManager(), { audit }))
    const res = await app.request('/adb/1.0.0', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ userId: 'u1', action: 'tool.delete', target: 'adb', meta: { version: '1.0.0' } }])
  })

  test('no authenticated user is refused (403) on every mutating route', async () => {
    const app = withUser(null, createToolsRoutes(fakeManager()))
    expect((await app.request('/repair', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/manifest/refresh', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/adb/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"version":"1"}' })).status).toBe(403)
    expect((await app.request('/adb/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"version":"1"}' })).status).toBe(403)
    expect((await app.request('/adb/check', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/adb/1.0.0', { method: 'DELETE' })).status).toBe(403)
  })
})

describe('createToolsRoutes without an `audit` dep (backward compatibility)', () => {
  test('an admin mutation still succeeds when audit is omitted entirely — it must never throw', async () => {
    const app = withUser('admin', createToolsRoutes(fakeManager()))
    const res = await app.request('/repair', { method: 'POST' })
    expect(res.status).toBe(200)
  })
})

/**
 * `POST /adb/restart` and `GET /adb/restart-preview` (plan 88 §3.10, §4.8,
 * §5 step 88.8) — the operator-triggered restart. `control.cycle` is a fake
 * here (never a real spawn/socket): what this file proves is the ROUTE's
 * own behaviour — permission, the `E_ADB_BUSY_FARM` guard and its `force`
 * bypass, the cooldown, and the audit record — not `cycle()` itself, which
 * `adb-server-control.test.ts` already covers in full.
 */
function fakeAdbControlDeps(
  overrides: Partial<{
    binaryPath: string | null
    busyFarm: { runningJobs: Array<{ id: string; label: string }>; controlledDevices: Array<{ deviceId: string; label: string }> }
    preview: { devicesTotal: number; sessionsActive: number; networkDevicesWithEndpoint: number }
    restartCooldownSec: number
    cycle: (opts: AdbCycleOpts) => Promise<AdbCycleReport>
  }> = {},
): { deps: AdbControlRouteDeps; cycleCalls: AdbCycleOpts[] } {
  const cycleCalls: AdbCycleOpts[] = []
  const defaultReport: AdbCycleReport = {
    reason: 'restart',
    durationMs: 1234,
    sessionsClosed: 0,
    controlsEnded: 0,
    jobsFailed: [],
    devicesBefore: 5,
    devicesAfter: 5,
    reattachAttempted: 0,
    reattachSucceeded: 0,
    reattachFailed: [],
    serverVersion: '0041',
  }
  const control: AdbServerControl = {
    cycle: async (opts) => {
      cycleCalls.push(opts)
      return overrides.cycle ? overrides.cycle(opts) : defaultReport
    },
    busy: () => false,
  }
  const deps: AdbControlRouteDeps = {
    control,
    binaryPath: () => (overrides.binaryPath === undefined ? '/bin/adb' : overrides.binaryPath),
    preview: () => overrides.preview ?? { devicesTotal: 5, sessionsActive: 2, networkDevicesWithEndpoint: 3 },
    busyFarm: () => overrides.busyFarm ?? { runningJobs: [], controlledDevices: [] },
    restartCooldownSec: () => overrides.restartCooldownSec ?? 60,
  }
  return { deps, cycleCalls }
}

describe('GET /adb/restart-preview — live counts before the confirmation dialog (plan 88 §3.10)', () => {
  test('no authenticated user is refused (403)', async () => {
    const { deps } = fakeAdbControlDeps()
    const app = withUser(null, createToolsRoutes(fakeManager(), { adb: deps }))
    expect((await app.request('/adb/restart-preview')).status).toBe(403)
  })

  test('an operator is refused — restarting adb is admin-only (tool.manage)', async () => {
    const { deps } = fakeAdbControlDeps()
    const app = withUser('operator', createToolsRoutes(fakeManager(), { adb: deps }))
    expect((await app.request('/adb/restart-preview')).status).toBe(403)
  })

  test('with no `adb` dep at all, refuses with E_ADB_UNAVAILABLE (503) rather than 404ing', async () => {
    const app = withUser('admin', createToolsRoutes(fakeManager()))
    const res = await app.request('/adb/restart-preview')
    expect(res.status).toBe(503)
    expect((await asJson<{ error: { code: string } }>(res)).error.code).toBe('E_ADB_UNAVAILABLE')
  })

  test('reports this farm\'s live numbers, not a placeholder', async () => {
    const { deps } = fakeAdbControlDeps({
      preview: { devicesTotal: 20, sessionsActive: 2, networkDevicesWithEndpoint: 12 },
      busyFarm: { runningJobs: [{ id: 'job-1', label: 'a script on Phone One' }], controlledDevices: [{ deviceId: 'd2', label: 'Phone Two' }] },
      restartCooldownSec: 90,
    })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { adb: deps }))
    const res = await app.request('/adb/restart-preview')
    expect(res.status).toBe(200)
    const body = await asJson<Record<string, unknown>>(res)
    expect(body).toEqual({
      devicesTotal: 20,
      sessionsActive: 2,
      controlled: 1,
      jobsRunning: 1,
      networkDevicesWithEndpoint: 12,
      restartCooldownSec: 90,
    })
  })
})

describe('POST /adb/restart (plan 88 §3.10, §4.8, §5 step 88.8)', () => {
  test('no authenticated user is refused (403), and cycle() is never called', async () => {
    const { deps, cycleCalls } = fakeAdbControlDeps()
    const app = withUser(null, createToolsRoutes(fakeManager(), { adb: deps }))
    expect((await app.request('/adb/restart', { method: 'POST' })).status).toBe(403)
    expect(cycleCalls).toEqual([])
  })

  test('an operator is refused (403) — tool.manage is admin-only', async () => {
    const { deps, cycleCalls } = fakeAdbControlDeps()
    const app = withUser('operator', createToolsRoutes(fakeManager(), { adb: deps }))
    expect((await app.request('/adb/restart', { method: 'POST' })).status).toBe(403)
    expect(cycleCalls).toEqual([])
  })

  test('with no `adb` dep at all, refuses with E_ADB_UNAVAILABLE (503)', async () => {
    const app = withUser('admin', createToolsRoutes(fakeManager()))
    const res = await app.request('/adb/restart', { method: 'POST' })
    expect(res.status).toBe(503)
    expect((await asJson<{ error: { code: string } }>(res)).error.code).toBe('E_ADB_UNAVAILABLE')
  })

  test('a busy farm (running jobs, controlled devices) refuses with E_ADB_BUSY_FARM (409) and never calls cycle()', async () => {
    const { deps, cycleCalls } = fakeAdbControlDeps({
      busyFarm: { runningJobs: [{ id: 'job-1', label: 'a script on Phone One' }], controlledDevices: [{ deviceId: 'd2', label: 'Phone Two' }] },
    })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { adb: deps }))
    const res = await app.request('/adb/restart', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = await asJson<{ error: { code: string }; runningJobs: unknown; controlledDevices: unknown }>(res)
    expect(body.error.code).toBe('E_ADB_BUSY_FARM')
    expect(body.runningJobs).toEqual([{ id: 'job-1', label: 'a script on Phone One' }])
    expect(body.controlledDevices).toEqual([{ deviceId: 'd2', label: 'Phone Two' }])
    expect(cycleCalls).toEqual([])
  })

  test('force:true bypasses the busy-farm guard and calls cycle() with force:true', async () => {
    const { deps, cycleCalls } = fakeAdbControlDeps({
      busyFarm: { runningJobs: [{ id: 'job-1', label: 'a script on Phone One' }], controlledDevices: [] },
    })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { adb: deps }))
    const res = await app.request('/adb/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })
    expect(res.status).toBe(200)
    expect(cycleCalls).toEqual([{ reason: 'restart', oldBinaryPath: '/bin/adb', newBinaryPath: '/bin/adb', force: true }])
  })

  test('an idle farm restarts cleanly, records the audit action, and returns the report', async () => {
    const { deps, cycleCalls } = fakeAdbControlDeps()
    const audit: { record: AuditLogger['record']; calls: Parameters<AuditLogger['record']>[0][] } = (() => {
      const calls: Parameters<AuditLogger['record']>[0][] = []
      return { record: (input) => void calls.push(input), calls }
    })()
    const app = withUser('admin', createToolsRoutes(fakeManager(), { adb: deps, audit: { record: audit.record, list: () => [] } }))
    const res = await app.request('/adb/restart', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await asJson<{ reason: string; devicesBefore: number }>(res)
    expect(body.reason).toBe('restart')
    expect(body.devicesBefore).toBe(5)
    expect(cycleCalls).toEqual([{ reason: 'restart', oldBinaryPath: '/bin/adb', newBinaryPath: '/bin/adb', force: false }])
    expect(audit.calls).toHaveLength(1)
    expect(audit.calls[0]?.action).toBe('adb.restart')
  })

  test('adb not yet provisioned (no binary path): refuses with E_ADB_UNAVAILABLE (503)', async () => {
    const { deps, cycleCalls } = fakeAdbControlDeps({ binaryPath: null })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { adb: deps }))
    const res = await app.request('/adb/restart', { method: 'POST' })
    expect(res.status).toBe(503)
    expect(cycleCalls).toEqual([])
  })

  test('a second restart inside the cooldown window is rate-limited (429) and never calls cycle() again', async () => {
    const { deps, cycleCalls } = fakeAdbControlDeps({ restartCooldownSec: 3600 })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { adb: deps }))
    const first = await app.request('/adb/restart', { method: 'POST' })
    expect(first.status).toBe(200)
    const second = await app.request('/adb/restart', { method: 'POST' })
    expect(second.status).toBe(429)
    expect((await asJson<{ error: { code: string } }>(second)).error.code).toBe('E_RATE_LIMITED')
    expect(cycleCalls).toHaveLength(1)
  })

  test('cycle() throwing E_TOOL_IN_USE (a swap already in flight) surfaces as 409 through the existing error handler', async () => {
    const { ToolchainError } = await import('@enkaku/toolchain')
    const { deps } = fakeAdbControlDeps({
      cycle: async () => {
        throw new ToolchainError('E_TOOL_IN_USE', 'a swap is already running')
      },
    })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { adb: deps }))
    const res = await app.request('/adb/restart', { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await asJson<{ error: { code: string } }>(res)).error.code).toBe('E_TOOL_IN_USE')
  })
})

/**
 * `POST /app/restart` and `GET /app/restart-preview` (plan 120 §4) — the
 * whole-core restart. `control.restart` is a fake here (never a real
 * spawn/health-poll): what this file proves is the ROUTE's own behaviour —
 * permission, the `E_APP_BUSY_FARM` guard and its `force` bypass, the audit
 * record, and error translation — not `restart()` itself, which
 * `app-restart-control.test.ts` already covers in full.
 */
function fakeAppRestartDeps(
  overrides: Partial<{
    preview: AppRestartPreview
    restart: (opts: AppRestartOpts) => Promise<AppRestartReport>
  }> = {},
): { deps: AppRestartRouteDeps; restartCalls: AppRestartOpts[] } {
  const restartCalls: AppRestartOpts[] = []
  const defaultReport: AppRestartReport = {
    mode: 'bare',
    outcome: 'verified',
    durationMs: 42,
    sessionsClosed: 0,
    controlsEnded: 0,
    jobsFailed: [],
  }
  const control: AppRestartControl = {
    restart: async (opts) => {
      restartCalls.push(opts)
      return overrides.restart ? overrides.restart(opts) : defaultReport
    },
    busy: () => false,
  }
  const deps: AppRestartRouteDeps = {
    control,
    preview: () => overrides.preview ?? { mode: 'bare' as SupervisionMode, devicesTotal: 5, sessionsActive: 2, controlled: 0, jobsRunning: 0 },
  }
  return { deps, restartCalls }
}

describe('GET /app/restart-preview — live counts and supervision mode before the confirmation dialog (plan 120 §4)', () => {
  test('no authenticated user is refused (403)', async () => {
    const { deps } = fakeAppRestartDeps()
    const app = withUser(null, createToolsRoutes(fakeManager(), { app: deps }))
    expect((await app.request('/app/restart-preview')).status).toBe(403)
  })

  test('an operator is refused — restarting Enkaku is admin-only (tool.manage)', async () => {
    const { deps } = fakeAppRestartDeps()
    const app = withUser('operator', createToolsRoutes(fakeManager(), { app: deps }))
    expect((await app.request('/app/restart-preview')).status).toBe(403)
  })

  test('with no `app` dep at all, refuses with E_APP_RESTART_UNAVAILABLE (503) rather than 404ing', async () => {
    const app = withUser('admin', createToolsRoutes(fakeManager()))
    const res = await app.request('/app/restart-preview')
    expect(res.status).toBe(503)
    expect((await asJson<{ error: { code: string } }>(res)).error.code).toBe('E_APP_RESTART_UNAVAILABLE')
  })

  test('reports this farm\'s live numbers AND the detected supervision mode, not a placeholder', async () => {
    const { deps } = fakeAppRestartDeps({ preview: { mode: 'systemd', devicesTotal: 20, sessionsActive: 4, controlled: 1, jobsRunning: 2 } })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { app: deps }))
    const res = await app.request('/app/restart-preview')
    expect(res.status).toBe(200)
    expect(await asJson<Record<string, unknown>>(res)).toEqual({ mode: 'systemd', devicesTotal: 20, sessionsActive: 4, controlled: 1, jobsRunning: 2 })
  })
})

describe('POST /app/restart (plan 120 §4)', () => {
  test('no authenticated user is refused (403), and restart() is never called', async () => {
    const { deps, restartCalls } = fakeAppRestartDeps()
    const app = withUser(null, createToolsRoutes(fakeManager(), { app: deps }))
    expect((await app.request('/app/restart', { method: 'POST' })).status).toBe(403)
    expect(restartCalls).toEqual([])
  })

  test('an operator is refused (403) — tool.manage is admin-only', async () => {
    const { deps, restartCalls } = fakeAppRestartDeps()
    const app = withUser('operator', createToolsRoutes(fakeManager(), { app: deps }))
    expect((await app.request('/app/restart', { method: 'POST' })).status).toBe(403)
    expect(restartCalls).toEqual([])
  })

  test('with no `app` dep at all, refuses with E_APP_RESTART_UNAVAILABLE (503)', async () => {
    const app = withUser('admin', createToolsRoutes(fakeManager()))
    const res = await app.request('/app/restart', { method: 'POST' })
    expect(res.status).toBe(503)
    expect((await asJson<{ error: { code: string } }>(res)).error.code).toBe('E_APP_RESTART_UNAVAILABLE')
  })

  test('a busy farm (running jobs or controlled devices) refuses with E_APP_BUSY_FARM (409) and never calls restart()', async () => {
    const { deps, restartCalls } = fakeAppRestartDeps({
      preview: { mode: 'bare', devicesTotal: 5, sessionsActive: 0, controlled: 1, jobsRunning: 2 },
    })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { app: deps }))
    const res = await app.request('/app/restart', { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await asJson<{ error: { code: string } }>(res)).error.code).toBe('E_APP_BUSY_FARM')
    expect(restartCalls).toEqual([])
  })

  test('force:true bypasses the busy-farm guard and calls restart() with force:true', async () => {
    const { deps, restartCalls } = fakeAppRestartDeps({
      preview: { mode: 'bare', devicesTotal: 5, sessionsActive: 0, controlled: 0, jobsRunning: 1 },
    })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { app: deps }))
    const res = await app.request('/app/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })
    expect(res.status).toBe(200)
    expect(restartCalls).toEqual([{ force: true }])
  })

  test('an idle farm restarts cleanly, records the audit action, and returns the report', async () => {
    const { deps, restartCalls } = fakeAppRestartDeps()
    const calls: Parameters<AuditLogger['record']>[0][] = []
    const app = withUser('admin', createToolsRoutes(fakeManager(), { app: deps, audit: { record: (input) => void calls.push(input), list: () => [] } }))
    const res = await app.request('/app/restart', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await asJson<AppRestartReport>(res)
    expect(body.mode).toBe('bare')
    expect(body.outcome).toBe('verified')
    expect(restartCalls).toEqual([{ force: false }])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.action).toBe('app.restart')
  })

  test('restart() throwing E_TOOL_IN_USE (a restart already in flight) surfaces as 409', async () => {
    const { EnkakuError } = await import('../util/errors')
    const { deps } = fakeAppRestartDeps({
      restart: async () => {
        throw new EnkakuError('E_TOOL_IN_USE', 'a restart is already in progress')
      },
    })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { app: deps }))
    const res = await app.request('/app/restart', { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await asJson<{ error: { code: string } }>(res)).error.code).toBe('E_TOOL_IN_USE')
  })

  test('restart() throwing E_RESTART_FAILED (bare mode, the child never came up) surfaces as 500 — never a silent success', async () => {
    const { EnkakuError } = await import('../util/errors')
    const { deps } = fakeAppRestartDeps({
      restart: async () => {
        throw new EnkakuError('E_RESTART_FAILED', 'the new process never became healthy — the original process kept running')
      },
    })
    const app = withUser('admin', createToolsRoutes(fakeManager(), { app: deps }))
    const res = await app.request('/app/restart', { method: 'POST' })
    expect(res.status).toBe(500)
    expect((await asJson<{ error: { code: string } }>(res)).error.code).toBe('E_RESTART_FAILED')
  })
})
