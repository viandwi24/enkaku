import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AuthEnv } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import type { ToolchainManager } from '@enkaku/toolchain'
import { createLogger } from '../util/logger'
import { createApp, type HttpDeps } from './http'

/**
 * `GET /api/health` (plan: release-gate hardening). The route sits on the
 * main app built by `createApp`, which wires in every other subsystem's
 * routes too — so exercising it for real means satisfying the whole
 * `HttpDeps` shape. Everything below that the health handler itself never
 * touches is a cheap stand-in: an empty `Hono` app for every route field
 * (never receives a request in these tests), and `auth`/`toolchain` cast
 * from a minimal object rather than built for real (no DB, no on-disk
 * toolchain layout) — the same pattern `tools/provision.test.ts` already
 * uses for `ToolchainManager`.
 */
function buildDeps(overrides: Partial<HttpDeps> = {}): HttpDeps {
  const emptyAuthEnvApp = () => new Hono<AuthEnv>()
  const emptyApp = () => new Hono()
  const auth = {} as unknown as AuthService
  const toolchain = {} as unknown as ToolchainManager

  return {
    listDevices: () => [],
    deviceCount: () => 0,
    log: createLogger('test.http'),
    version: '0.0.0-test',
    adbServerVersion: async () => null,
    adbState: () => 'provisioning',
    toolchain,
    jobRoutes: emptyAuthEnvApp(),
    scriptRoutes: emptyAuthEnvApp(),
    pluginRoutes: emptyAuthEnvApp(),
    capRoutes: emptyAuthEnvApp(),
    openApiDocument: {},
    mcpRoutes: emptyAuthEnvApp(),
    agentRoutes: emptyAuthEnvApp(),
    connectorRoutes: emptyAuthEnvApp(),
    kvRoutes: emptyAuthEnvApp(),
    threadRoutes: emptyAuthEnvApp(),
    blobRoutes: emptyAuthEnvApp(),
    notificationRoutes: emptyAuthEnvApp(),
    webhookRoutes: emptyAuthEnvApp(),
    deviceRoutes: emptyAuthEnvApp(),
    guestAgentRoutes: emptyAuthEnvApp(),
    agentProvisionerRoutes: emptyAuthEnvApp(),
    deviceIdentityRoutes: emptyAuthEnvApp(),
    tagRoutes: emptyApp(),
    clusterRoutes: emptyAuthEnvApp(),
    topologyRoutes: emptyApp(),
    batchRoutes: emptyAuthEnvApp(),
    scheduleRoutes: emptyAuthEnvApp(),
    settingsRoutes: emptyAuthEnvApp(),
    artifactRoutes: emptyAuthEnvApp(),
    adbStatsRoutes: emptyAuthEnvApp(),
    videoRoutes: emptyAuthEnvApp(),
    doctorRoutes: emptyAuthEnvApp(),
    authRoutes: emptyAuthEnvApp(),
    nodeRoutes: emptyAuthEnvApp(),
    auth,
    // 'server' mode + the public-paths bypass in authMiddleware means
    // `/api/health` never calls into the `auth` stand-in above.
    authMode: 'server',
    startedAt: Date.now() - 1000,
    ...overrides,
  }
}

async function health(deps: HttpDeps) {
  const app = createApp(deps)
  const res = await app.request('/api/health')
  expect(res.status).toBe(200)
  return (await res.json()) as {
    ok?: boolean
    version?: string
    adb?: { state?: string; serverVersion?: string | null }
    mode?: string
    deviceCount?: number
    uptimeMs?: number
  }
}

describe('GET /api/health', () => {
  test('reports version, adb state, device count and uptime from the live daemon', async () => {
    const body = await health(
      buildDeps({
        version: '9.9.9',
        adbState: () => 'ready',
        adbServerVersion: async () => '36.0.0',
        deviceCount: () => 3,
        startedAt: Date.now() - 5000,
      }),
    )
    expect(body.version).toBe('9.9.9')
    expect(body.adb).toEqual({ state: 'ready', serverVersion: '36.0.0' })
    expect(body.deviceCount).toBe(3)
    expect(body.uptimeMs).toBeGreaterThanOrEqual(5000)
  })

  test('mode reflects ENKAKU_MODE=orchestrator and falls back to local otherwise', async () => {
    const original = process.env.ENKAKU_MODE
    try {
      delete process.env.ENKAKU_MODE
      expect((await health(buildDeps())).mode).toBe('local')

      process.env.ENKAKU_MODE = 'orchestrator'
      expect((await health(buildDeps())).mode).toBe('orchestrator')
    } finally {
      if (original === undefined) delete process.env.ENKAKU_MODE
      else process.env.ENKAKU_MODE = original
    }
  })

  /**
   * `ok` is a liveness ping, not a readiness one (see the comment on the
   * route itself) — it must NOT go `false` just because adb is still
   * provisioning or has permanently failed, because `doctor/checks/port.ts`
   * and `doctor/context.ts`'s `probeCore` both read it to decide "is this
   * port held by a live enkaku core", and a live-but-not-yet-ready (or
   * live-but-broken-adb) core is still exactly that. Real readiness is
   * `adb.state`, asserted separately above and by the release smoke test.
   */
  test('ok stays true regardless of adb.state — provisioning, ready, error, and orchestrator all report the process as alive', async () => {
    for (const state of ['provisioning', 'ready', 'error', 'orchestrator']) {
      const body = await health(buildDeps({ adbState: () => state }))
      expect(body.ok).toBe(true)
      expect(body.adb?.state).toBe(state)
    }
  })
})

/**
 * The Studio-dev-server CORS grant (docs/plans/87-m52-mvp-release-readiness.md
 * §4.9, finding S7). This used to gate on `process.env.NODE_ENV !== 'production'`
 * — a check nothing in the release binary, Docker image, or systemd unit ever
 * flips, so it was live in every documented production (server-mode) boot. It
 * now gates on `deps.authMode`, which `resolveAuthMode` derives from the bind
 * address: 'local' only for a loopback bind with auth not forced to 'server'.
 */
describe('the dev-only CORS grant (plan 87 §4.9, S7)', () => {
  const loopbackOrigin = 'http://localhost:3001'
  // `authMiddleware`'s 'local' branch calls `deps.auth.ensureLocalAdmin()` for
  // EVERY request (unlike 'server' mode, which bypasses `PUBLIC_PATHS` before
  // ever touching `auth`) — so a local-mode app needs a real stand-in here,
  // unlike `buildDeps`'s default `{}` (fine only for the 'server' mode tests above).
  const localModeAuth = { ensureLocalAdmin: () => ({ id: 'local-admin', email: 'admin@localhost', role: 'admin' }) } as unknown as AuthService

  test('local mode (bun run dev / dev:studio) grants CORS to a loopback origin, regardless of NODE_ENV', async () => {
    const original = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production' // must NOT matter anymore, either direction
      const app = createApp(buildDeps({ authMode: 'local', auth: localModeAuth }))
      const res = await app.request('/api/health', { headers: { origin: loopbackOrigin } })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe(loopbackOrigin)
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })

  test('server mode never grants CORS to a loopback origin, even with NODE_ENV unset (the shipped deploy/enkaku.service case)', async () => {
    const original = process.env.NODE_ENV
    try {
      delete process.env.NODE_ENV // the real-world default: nothing sets this anywhere
      const app = createApp(buildDeps({ authMode: 'server' }))
      const res = await app.request('/api/health', { headers: { origin: loopbackOrigin } })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })

  /**
   * This replaces an earlier test that asserted the OPPOSITE — that the grant
   * never sets `Access-Control-Allow-Credentials`, "so the impact stays
   * bounded even in local mode". That reasoning does not survive contact with
   * the branch it guards, and the flag it withheld broke the one workflow the
   * grant exists for.
   *
   * Why withholding it cost something real: Studio fetches with
   * `credentials: 'include'` (it must — server mode needs the session
   * cookie). The CORS spec then makes the BROWSER discard any response
   * lacking this header, so the core answered 200 and the tab still saw a
   * rejected promise; `AuthGate` read that as "no session" and redirected to
   * `/login`, which in local mode has no credentials to offer. `bun run
   * dev:studio` was unusable, and the symptom pointed at auth, not CORS.
   *
   * Why withholding it bought nothing: `authMiddleware`'s `mode === 'local'`
   * branch returns an implicit admin for every request BEFORE it reads any
   * cookie. There is no session cookie in local mode for a cross-origin page
   * to ride — a loopback origin admitted here is already fully authorised
   * without sending one, which the second assertion below proves directly.
   *
   * The protections that actually bound this are the two tests either side of
   * this one — server mode grants no CORS at all, and local mode still
   * refuses a non-loopback origin — and neither is affected by the flag.
   */
  test('local mode sets Access-Control-Allow-Credentials, and it grants nothing a cookieless request did not already have', async () => {
    const app = createApp(buildDeps({ authMode: 'local', auth: localModeAuth }))
    const res = await app.request('/api/health', { headers: { origin: loopbackOrigin } })
    expect(res.headers.get('access-control-allow-origin')).toBe(loopbackOrigin)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')

    // The claim above, asserted rather than argued: no cookie, no
    // authorization header, still served as the implicit admin. Nothing the
    // credentials flag enables can exceed this, because this is everything.
    const cookieless = await app.request('/api/health', { headers: { origin: loopbackOrigin } })
    expect(cookieless.status).toBe(200)
  })

  test('local mode still refuses a non-loopback origin', async () => {
    const app = createApp(buildDeps({ authMode: 'local', auth: localModeAuth }))
    const res = await app.request('/api/health', { headers: { origin: 'https://evil.example.com' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
