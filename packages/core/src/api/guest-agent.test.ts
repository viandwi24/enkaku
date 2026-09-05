import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { GuestAgentClient, GuestAgentClientOptions, GuestAgentLauncher } from '@enkaku/drivers'
import { GuestAgentClientError } from '@enkaku/drivers'
import type {
  AgentStatus,
  EgressProbeResult,
  HelloResult,
  LocationClearResult,
  LocationSetResult,
  PingResult,
  RouteHoldResult,
  RouteStartResult,
  RouteStatusResult,
  RouteStopResult,
} from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createActivityRegistry, type ActivityRegistry } from '../activity/registry'
import { createLogger, type Logger } from '../util/logger'
import { createGuestAgentRoutes, resolveGuestAgentApkPath, type GuestAgentRoutesDeps, type GuestAgentRoutesHandle, type NetworkStatusResult } from './guest-agent'

/** Mirrors `authMiddleware` well enough for a route test: sets `c.get('user')` before dispatch (same pattern `adb-endpoint.test.ts` uses). */
function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function seedDevice(db: Db, overrides: Partial<DeviceRow> = {}): void {
  db.insert(devices)
    .values({
      id: 'dev-1',
      stableId: 'stable-dev-1',
      serial: 'serial-dev-1',
      label: 'Test Phone',
      status: 'online',
      apiLevel: 35,
      ...overrides,
    })
    .run()
}

/** A launcher fake that records every call — same shape `vpn-helper.test.ts` uses. */
function fakeLauncher(overrides: Partial<GuestAgentLauncher> = {}): { launcher: GuestAgentLauncher; calls: string[] } {
  const calls: string[] = []
  const launcher: GuestAgentLauncher = {
    isInstalled: async () => true,
    ensureInstalled: async () => {
      calls.push('ensureInstalled')
      return { versionCode: null }
    },
    ensurePreGranted: async () => {
      calls.push('ensurePreGranted')
      return { state: 'granted' as const, reason: null }
    },
    vpnConsent: async () => ({ state: 'granted' as const, reason: null }),
    ensureAccessibilityEnabled: async () => ({ state: 'enabled' as const, reason: null }),
    bootstrap: async (token) => {
      calls.push(`bootstrap:${token}`)
    },
    forward: async (port) => {
      calls.push(`forward:${port}`)
    },
    removeForward: async (port) => {
      calls.push(`removeForward:${port}`)
    },
    stop: async () => {
      calls.push('stop')
    },
    ...overrides,
  }
  return { launcher, calls }
}

function fakeClient(overrides: Partial<GuestAgentClient> = {}): GuestAgentClient {
  return {
    hello: async (): Promise<HelloResult> => ({
      protocol: 1,
      appVersion: '1.0.0',
      androidSdkInt: 35,
      capabilities: ['socks5-route', 'vpn-status'],
    }),
    ping: async (): Promise<PingResult> => ({ pong: true }),
    routeStart: async (): Promise<RouteStartResult> => ({ started: true }),
    routeStop: async (): Promise<RouteStopResult> => ({ stopped: true }),
    routeStatus: async (): Promise<RouteStatusResult> => ({ prepared: true, up: true }),
    // Not called unless ENKAKU_NETWORK_PROBE_URL is set (plan 51 §5.5) — every existing test
    // here runs without it, so this default only matters for the probe-specific tests below.
    egressProbe: async (): Promise<EgressProbeResult> => ({
      tunnelled: { ok: true, status: 200, body: 'nonce=abc', ms: 100 },
      direct: { ok: true, status: 200, body: 'nonce=abc', ms: 20 },
    }),
    // Not called unless a route reaches `onGeoFail: 'hold'` with a genuinely mismatched geo check
    // (plan 55 §5.6) — every existing test here runs without that, so this default only matters
    // for the hold-wiring tests below.
    routeHold: async (): Promise<RouteHoldResult> => ({ held: true }),
    // Not called unless a device applies GPS identity (plan 58 §5.3) — every existing test here
    // runs without that, so this default only matters for the identity-specific tests below.
    locationSet: async (): Promise<LocationSetResult> => ({ set: true }),
    locationClear: async (): Promise<LocationClearResult> => ({ cleared: true }),
    // Not exercised by this file's tests — stubs to satisfy the widened `GuestAgentClient`
    // interface (plan 90 §4.1, §3.9's `screen-label`/`text-input` capabilities).
    labelApply: async () => ({
      applied: [],
      fingerprint: '',
      rendererVersion: 0,
      widthPx: 0,
      heightPx: 0,
      wallpaperIdHome: null,
      wallpaperIdLock: null,
    }),
    labelStatus: async () => ({
      fingerprint: null,
      matchesOurs: false,
      wallpaperIdHome: null,
      wallpaperIdLock: null,
      originalCaptured: false,
      rendererVersion: 0,
    }),
    labelClear: async () => ({ restored: 'system-default', fingerprint: null }),
    textCommit: async () => ({ committed: 0, ime: 'not-current' }),
    textStatus: async () => ({ ime: 'disabled', id: 'dev.enkaku.guestagent/.input.EnkakuIme', connected: false }),
    // Not exercised by this file's tests — stubs to satisfy the widened `GuestAgentClient`
    // interface (plan 221 §4.11's `ui-tree`/`activity` capabilities).
    uiDump: async () => ({
      root: { resourceId: '', text: '', desc: '', className: 'hierarchy', packageName: '', bounds: { left: 0, top: 0, right: 0, bottom: 0 }, clickable: false, enabled: true, focused: false, index: 0, children: [] },
      widthPx: 0,
      heightPx: 0,
      nodeCount: 0,
      truncated: false,
      tookMs: 0,
    }),
    uiFind: async () => ({ node: null, matches: 0, tookMs: 0 }),
    activitySet: async () => ({ accepted: 0 }),
    deviceDescribe: async () => ({ accepted: true as const }),
    textPrefs: async () => ({ showSoftKeyboardWithHardware: false }),
    uiStatus: async () => ({
      enabled: false,
      connected: false,
      watching: false,
      lastDumpAgoMs: null,
      lastDumpNodes: null,
      lastError: null,
    }),
    ...overrides,
  }
}

function fakePorts() {
  let next = 27400
  const inUse = new Set<number>()
  return {
    claim: async (_deviceId: string) => {
      const port = next++
      inUse.add(port)
      return port
    },
    release: (port: number) => {
      inUse.delete(port)
    },
    inUse,
  }
}

/**
 * The forward/list-forward/killForward trio (plan 119 §4.1, §4.2) — this file's tests never drive
 * the real `createGuestAgentLauncher`'s network calls directly (they go through `fakeLauncher`
 * above, or the real one against a fake `exec`), so an empty-but-typed stub is enough to satisfy
 * `GuestAgentRoutesDeps['adb']`.
 */
function fakeAdbForward(): GuestAgentRoutesDeps['adb'] {
  return {
    forward: async () => undefined,
    listForward: async () => [],
    killForward: async () => undefined,
  }
}

/** A `Logger` that records every `warn` call's message instead of writing to the console — plan 90 §3.7 rule 2's breaker tests assert a warning fired exactly once, which a real logger's console output cannot be asserted against. */
function fakeLog(): { log: Logger; warns: string[] } {
  const warns: string[] = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warns.push(msg)
    },
    error: () => {},
    child: () => log,
  }
  return { log, warns }
}

/**
 * Freezes `Date.now()` at `startMs` for the duration of `fn`, restoring the real clock afterward
 * even if `fn` throws — plan 90 §3.7's tests need to move `offlineAt`/`exhaustedAt` seconds apart
 * from each other deterministically (`nowSeconds()` floors to the current second, so two calls
 * inside one fast synchronous test can otherwise land in the same second and never satisfy a
 * strict `>` comparison). `advance` moves the frozen clock forward; nothing here sleeps for real.
 */
async function withFakeClock<T>(startMs: number, fn: (advance: (deltaMs: number) => void) => Promise<T>): Promise<T> {
  const realNow = Date.now
  let current = startMs
  Date.now = () => current
  try {
    return await fn((deltaMs) => {
      current += deltaMs
    })
  } finally {
    Date.now = realNow
  }
}

interface Harness {
  db: Db
  app: Hono<AuthEnv>
  events: Array<{ deviceId: string; stream: string; kind: string; actor?: string | null; meta?: Record<string, unknown> }>
  ports: ReturnType<typeof fakePorts>
  /** Awaited explicitly by boot-reconciliation tests instead of racing the fire-and-forget call `createGuestAgentRoutes` makes at construction. */
  reconcileNetworkRoutes: () => Promise<void>
  /** The plan 52 §5.3 "device online" restore — probe-first, never a blind re-apply. */
  restoreDeviceRoute: (deviceId: string) => Promise<void>
  /** The plan 52 §4.1 "device offline" handler — keeps the persisted route, marks checks unknown. */
  handleDeviceOffline: (deviceId: string) => Promise<void>
  /** The shared per-device session seam (plan 44 §8b) — exercised directly by the pairing tests below. */
  withGuestAgentClient: <T>(deviceId: string, fn: (client: GuestAgentClient) => Promise<T>) => Promise<T>
  /** The REAL activity registry (plan 205 §4.2) — exposed so a test can seat a live job/workflow-job/install and prove the `network-apply` policy row still forbids it. */
  activities: ActivityRegistry
  /**
   * The five per-device network operations (plan 207 §4.2, §5 step 207.4) —
   * the exact functions `PUT/POST/DELETE /:id/network*` used to call before
   * those per-device HTTP routes were removed (plan 207 §10's removal
   * register: `set-network` is the one remaining door). Exposed here so
   * this file's own network tests can keep exercising the same admission
   * and write behaviour directly, through `asNetworkResponse` below.
   */
  routeActions: GuestAgentRoutesHandle['routeActions']
}

function makeHarness(opts: {
  role?: 'admin' | 'operator' | null
  launcher?: GuestAgentLauncher
  client?: GuestAgentClient
  makeClient?: (opts: GuestAgentClientOptions) => GuestAgentClient
  /** Plan 54 §3.2, §4.2 test seam — the bounded-recovery backoff, overridden in recovery tests so they need not sit out real wall-clock delays. */
  recoveryBackoffS?: number[]
  /** Seconds an exhausted bound waits before re-arming — 0 in the re-arm test so it need not sit out the real cool-off. */
  recoveryRearmS?: number
  /** Plan 55 §3.2, §5.1 — the geo half of `FarmSettingsSchema.network`, overridden in the geo/dns tests below. Defaults to no provider configured, matching a farm that never touched Settings → Network. */
  networkSettings?: () => { geoProvider?: string; geoIntervalSec: number }
  /** Plan 90 §3.7, §4.4 — `FarmSettingsSchema.guestAgent`'s recovery half, overridden in the breaker tests below. Defaults to the schema's own defaults. */
  guestAgentSettings?: () => { maxRecoveryCyclesPerHour: number; recoveryRearmSec: number }
  /**
   * Plan 90 §3.8, §4.7 — the "on demand, single device" provisioning hook
   * POST /:id/guest-agent fires; `status`/`remove` are GET's and DELETE's own
   * producers (docs/plans/96-m61-hotfixes.md's Gap 2 fix). Undefined by
   * default, matching every existing test/call site that predates the
   * provisioner — GET then falls back to the pre-plan-90 live probe.
   */
  agentProvisioner?: {
    ensure: (deviceId: string, opts?: { force?: boolean }) => Promise<unknown>
    status?: (deviceId: string) => Promise<AgentStatus>
    remove?: (deviceId: string, actor: string | null) => Promise<unknown>
  }
  /** Overrides the default `createLogger('test')` — the breaker tests below need to assert a `warn` fired exactly once, which a real logger's console output cannot be asserted against. */
  log?: Logger
}): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const events: Harness['events'] = []
  const ports = fakePorts()
  const log = opts.log ?? createLogger('test')
  const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
  const states = createDeviceStateMachine({ db, log })

  const deps: GuestAgentRoutesDeps = {
    db,
    hostAdb: async () => '',
    adb: fakeAdbForward(),
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    apkPath: async () => '/fake/guest-agent.apk',
    ports,
    // A fresh temp dir per harness — the credential store (plan 52 §4.2) writes a real key file
    // to `<dataDir>/network-credentials.key`, and tests must never share one, or an encrypt in
    // one test and a decrypt in another would use two different keys for the "same" credential.
    dataDir: mkdtempSync(join(tmpdir(), 'enkaku-guest-agent-test-')),
    activities,
    controlSettings: () => ({ overControl: 'allow', idleSec: 30 }),
    states,
    record: (e) => events.push(e),
    log,
    // These drive fakes; sitting out the real multi-second settle/poll budgets would only make the
    // suite slow and flaky.
    routeTimings: { applySettleTimeoutMs: 0, revertPollTimeoutMs: 0 },
    ...(opts.recoveryBackoffS ? { recoveryBackoffS: opts.recoveryBackoffS } : {}),
    ...(opts.recoveryRearmS !== undefined ? { recoveryRearmS: opts.recoveryRearmS } : {}),
    ...(opts.launcher ? { makeLauncher: () => opts.launcher! } : {}),
    makeClient: opts.makeClient ?? (() => opts.client ?? fakeClient()),
    ...(opts.networkSettings ? { networkSettings: opts.networkSettings } : {}),
    ...(opts.guestAgentSettings ? { guestAgentSettings: opts.guestAgentSettings } : {}),
    ...(opts.agentProvisioner ? { agentProvisioner: opts.agentProvisioner } : {}),
  }
  const { routes, reconcileNetworkRoutes, restoreDeviceRoute, handleDeviceOffline, withGuestAgentClient, routeActions } = createGuestAgentRoutes(deps)
  const app = withUser(opts.role === undefined ? 'admin' : opts.role, withTestOnlyNetworkActionRoutes(routes, routeActions))
  return { db, app, events, ports, reconcileNetworkRoutes, restoreDeviceRoute, handleDeviceOffline, withGuestAgentClient, activities, routeActions }
}

/**
 * Re-mounts `PUT/POST/DELETE /:id/network*` as plain HTTP routes over
 * `routeActions` (`RouteService['actions']`, `set/clear/enable/disable/
 * retry` — the exact functions the real per-device routes called before
 * they were removed, plan 207 §10's removal register: `set-network` is the
 * one remaining production door). TEST-FILE-ONLY: this router is never
 * mounted anywhere the real app tree can reach, so it does not reopen the
 * per-device write surface plan 207 closes — it exists purely so this
 * file's ~80 pre-existing `app.request('/dev-1/network...')` calls, several
 * of which depend on the GET route's own read-throttle window ordering
 * relative to a PUT/DELETE, keep working unchanged rather than each being
 * rewritten to a direct function call (a far larger, riskier mechanical
 * change than the small number of call sites `route-service.test.ts` needed).
 */
function withTestOnlyNetworkActionRoutes(app: Hono<AuthEnv>, routeActions: GuestAgentRoutesHandle['routeActions']): Hono<AuthEnv> {
  // `routes` already carries its own `onError` (`guest-agent.ts`'s own,
  // identical EnkakuError -> ERROR_STATUS mapping) — these routes rely on
  // that existing handler rather than registering a second one.
  const actorOf = (c: { get(key: 'user'): { id: string } | undefined }): string | null => c.get('user')?.id ?? null
  app.put('/:id/network', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return c.json(await routeActions.set(c.req.param('id'), raw, actorOf(c)))
  })
  app.post('/:id/network/enable', async (c) => c.json(await routeActions.enable(c.req.param('id'), actorOf(c))))
  app.post('/:id/network/disable', async (c) => c.json(await routeActions.disable(c.req.param('id'), actorOf(c))))
  app.post('/:id/network/retry', async (c) => c.json(await routeActions.retry(c.req.param('id'), actorOf(c))))
  app.delete('/:id/network', async (c) => c.json(await routeActions.clear(c.req.param('id'), actorOf(c))))
  return app
}

describe('GET /api/devices/:id/guest-agent — the state machine (plan 44 §5.8)', () => {
  test('unsupported: apiLevel below 29 wins over everything else', async () => {
    const { db, app } = makeHarness({})
    seedDevice(db, { apiLevel: 24 })
    const res = await app.request('/dev-1/guest-agent')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string; reason?: string }
    expect(body.state).toBe('unsupported')
    expect(body.reason).toContain('24')
  })

  test('not-installed: the package is absent', async () => {
    const { launcher } = fakeLauncher({ isInstalled: async () => false })
    const { db, app } = makeHarness({ launcher })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent')
    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('not-installed')
  })

  test('installed: present, but the app-op grant fails before any handshake is attempted', async () => {
    const { launcher } = fakeLauncher({
      ensurePreGranted: async () => {
        throw new Error('ACTIVATE_VPN was not granted')
      },
    })
    const { db, app } = makeHarness({ launcher })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent')
    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('installed')
  })

  test('ready: install present, handshake succeeds — appVersion/androidSdkInt/capabilities come through', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent')
    const body = (await res.json()) as { state: string; appVersion?: string; androidSdkInt?: number; capabilities?: string[] }
    expect(body.state).toBe('ready')
    expect(body.appVersion).toBe('1.0.0')
    expect(body.androidSdkInt).toBe(35)
    expect(body.capabilities).toEqual(['socks5-route', 'vpn-status'])
  })

  test('unreachable: bootstrap/forward succeed but the handshake itself never answers', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      hello: async () => {
        throw new GuestAgentClientError('E_TIMEOUT', 'guest agent did not respond within 15000ms')
      },
    })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent')
    const body = (await res.json()) as { state: string; reason?: string }
    expect(body.state).toBe('unreachable')
    expect(body.reason).toContain('15000ms')
  })

  test('installed vs unreachable are never collapsed into one state', async () => {
    const preGrantFails = fakeLauncher({
      ensurePreGranted: async () => {
        throw new Error('nope')
      },
    })
    const { db: db1, app: app1 } = makeHarness({ launcher: preGrantFails.launcher })
    seedDevice(db1)
    const r1 = (await (await app1.request('/dev-1/guest-agent')).json()) as { state: string }

    const handshakeFails = fakeLauncher()
    const client = fakeClient({
      hello: async () => {
        throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
      },
    })
    const { db: db2, app: app2 } = makeHarness({ launcher: handshakeFails.launcher, client })
    seedDevice(db2)
    const r2 = (await (await app2.request('/dev-1/guest-agent')).json()) as { state: string }

    expect(r1.state).toBe('installed')
    expect(r2.state).toBe('unreachable')
    expect(r1.state).not.toBe(r2.state)
  })

  test('the forwarded port is claimed and released around a single status probe, never held', async () => {
    const { launcher } = fakeLauncher()
    const { db, app, ports } = makeHarness({ launcher })
    seedDevice(db)
    await app.request('/dev-1/guest-agent')
    expect(ports.inUse.size).toBe(0)
  })
})

/**
 * Plan 90 §4.7, docs/plans/96-m61-hotfixes.md's Gap 2 fix: `GET` reads from
 * `AgentProvisioner.status()` when it is wired, instead of running its own
 * live presence+hello probe — the only way `outdated`/`failed` and
 * `versionCode`/`checkedAt`/`attempts`/`nextAttemptAt` (all declared on
 * `GuestAgentStatusResponseSchema` by step 90.6, none of them producible by
 * the pre-plan-90 probe) ever reach this endpoint. Every test above this
 * block proves the OLD path still works unchanged when `status` is absent
 * (the default); every test below proves the NEW path.
 */
describe('GET /api/devices/:id/guest-agent — wired to AgentProvisioner.status() (plan 90 §4.7, docs/plans/96-m61-hotfixes.md Gap 2 fix)', () => {
  function agentStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
    return {
      apkSha256: null,
      state: 'ready',
      appVersion: '1.0.0',
      versionCode: 5,
      androidSdkInt: 34,
      capabilities: ['socks5-route', 'vpn-status'],
      reason: null,
      checkedAt: 1_700_000_000,
      attempts: 0,
      nextAttemptAt: null,
      ...overrides,
    }
  }

  test('reports "outdated" — a state the pre-plan-90 live probe could never produce — with versionCode/checkedAt/attempts/nextAttemptAt all populated', async () => {
    const status = agentStatus({ state: 'outdated', appVersion: '1.0.0', versionCode: 3, reason: 'signature_mismatch', attempts: 0, nextAttemptAt: null, checkedAt: 1_700_000_042 })
    const { db, app } = makeHarness({ agentProvisioner: { ensure: async () => undefined, status: async () => status } })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      state: string
      versionCode: number | null
      checkedAt: number | null
      attempts: number
      nextAttemptAt: number | null
      reason?: string
    }
    expect(body.state).toBe('outdated')
    expect(body.versionCode).toBe(3)
    expect(body.checkedAt).toBe(1_700_000_042)
    expect(body.attempts).toBe(0)
    expect(body.nextAttemptAt).toBeNull()
    expect(body.reason).toBe('signature_mismatch')
  })

  test('reports "failed" with the verbatim reason and a nonzero attempts/nextAttemptAt', async () => {
    const status = agentStatus({ state: 'failed', appVersion: null, versionCode: null, capabilities: [], reason: 'E_CHECKSUM_MISSING: no signed release published yet', attempts: 2, nextAttemptAt: 1_700_000_100 })
    const { db, app } = makeHarness({ agentProvisioner: { ensure: async () => undefined, status: async () => status } })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent')
    const body = (await res.json()) as { state: string; reason?: string; attempts: number; nextAttemptAt: number | null }
    expect(body.state).toBe('failed')
    expect(body.reason).toBe('E_CHECKSUM_MISSING: no signed release published yet')
    expect(body.attempts).toBe(2)
    expect(body.nextAttemptAt).toBe(1_700_000_100)
  })

  test('maps the provisioner\'s "absent" onto this endpoint\'s pre-plan-90 "not-installed" — additive, never a new value Studio has not seen', async () => {
    const status = agentStatus({ state: 'absent', appVersion: null, versionCode: null, androidSdkInt: null, capabilities: [], reason: null, checkedAt: null, attempts: 0, nextAttemptAt: null })
    const { db, app } = makeHarness({ agentProvisioner: { ensure: async () => undefined, status: async () => status } })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent')
    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('not-installed')
  })

  test('"ready" still carries appVersion/androidSdkInt/capabilities through the provisioner path', async () => {
    const status = agentStatus({ state: 'ready' })
    const { db, app } = makeHarness({ agentProvisioner: { ensure: async () => undefined, status: async () => status } })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent')
    const body = (await res.json()) as { state: string; appVersion?: string; androidSdkInt?: number; capabilities?: string[] }
    expect(body.state).toBe('ready')
    expect(body.appVersion).toBe('1.0.0')
    expect(body.androidSdkInt).toBe(34)
    expect(body.capabilities).toEqual(['socks5-route', 'vpn-status'])
  })

  test('DELETE clears the persisted row through agentProvisioner.remove(), so a GET right after does not keep reporting a stale state', async () => {
    const { launcher } = fakeLauncher()
    let stored: AgentStatus = agentStatus({ state: 'ready' })
    const { db, app } = makeHarness({
      launcher,
      agentProvisioner: {
        ensure: async () => undefined,
        status: async () => stored,
        remove: async () => {
          stored = agentStatus({ state: 'absent', appVersion: null, versionCode: null, androidSdkInt: null, capabilities: [], reason: null, checkedAt: null, attempts: 0, nextAttemptAt: null })
        },
      },
    })
    seedDevice(db)

    const before = (await (await app.request('/dev-1/guest-agent')).json()) as { state: string }
    expect(before.state).toBe('ready')

    const delRes = await app.request('/dev-1/guest-agent', { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    // `remove()` is fire-and-forget after DELETE's own uninstall — give its
    // microtask a turn to run before asserting the follow-up GET.
    await Promise.resolve()
    await Promise.resolve()

    const after = (await (await app.request('/dev-1/guest-agent')).json()) as { state: string }
    expect(after.state).toBe('not-installed')
  })
})

describe('POST /api/devices/:id/guest-agent — install/repair (plan 44 §5.8)', () => {
  test('installs and probes, then records a guest-agent.installed event with no secret in it', async () => {
    const { launcher, calls } = fakeLauncher()
    const { db, app, events } = makeHarness({ launcher })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('ready')
    expect(calls).toContain('ensureInstalled')

    const ev = events.find((e) => e.kind === 'guest-agent.installed')
    expect(ev).toBeTruthy()
    expect(ev?.meta).toEqual({ state: 'ready' })
  })

  test('also runs a forced pass through the agent provisioner, without changing this endpoint\'s own response shape (plan 90 §3.8, §4.7)', async () => {
    const { launcher } = fakeLauncher()
    const called: { value: { deviceId: string; opts?: { force?: boolean } } | null } = { value: null }
    let resolveEnsure: () => void = () => undefined
    const ensured = new Promise<void>((resolve) => {
      resolveEnsure = resolve
    })
    const { db, app } = makeHarness({
      launcher,
      agentProvisioner: {
        ensure: async (deviceId, opts) => {
          called.value = { deviceId, opts }
          resolveEnsure()
        },
      },
    })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string }
    // Unchanged: still the pre-plan-90 `GuestAgentStatusResult` shape, per this
    // dep's own doc comment (`GuestAgentStatusResponseSchema` is a strict enum
    // Studio's NetworkPanel already parses against).
    expect(body.state).toBe('ready')

    await ensured
    expect(called.value).toEqual({ deviceId: 'dev-1', opts: { force: true } })
  })

  test('a failing agent provisioner never turns a successful install+probe into an error response', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({
      launcher,
      agentProvisioner: {
        ensure: async () => {
          throw new Error('boom')
        },
      },
    })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('refuses an offline device, even for an admin (plan 205 §4.8 — no manual control to hold any more at all)', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher })
    seedDevice(db, { status: 'offline' })
    const res = await app.request('/dev-1/guest-agent', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('device_unavailable')
  })

  test('an operator (device.network is an OPERATOR permission) may install — no lockout', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher, role: 'operator' })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('an unauthenticated caller is refused', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher, role: null })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('resolveGuestAgentApkPath fails loudly, naming the variable, rather than a silent no-op', async () => {
    // Exercised directly rather than through the route (the real
    // `createGuestAgentLauncher.ensureInstalled()` is what calls this — a
    // fake launcher would just bypass it) — this is the exact function
    // `daemon.ts` wires in as `apkPath` (plan 44 §5.7).
    const saved = process.env.ENKAKU_GUEST_AGENT_PATH
    delete process.env.ENKAKU_GUEST_AGENT_PATH
    try {
      // `localBuildPaths: []` stands in for a deployed server, which has no `apps/` directory.
      // Without it this test would pass or fail depending on whether this checkout happens to
      // hold a Gradle build — which it does as soon as anyone runs `bun run build:guest-agent`.
      await expect(resolveGuestAgentApkPath({ localBuildPaths: [] })).rejects.toThrow(
        /bun run build:guest-agent|ENKAKU_GUEST_AGENT_PATH/,
      )
    } finally {
      if (saved !== undefined) process.env.ENKAKU_GUEST_AGENT_PATH = saved
    }
  })

  test('resolveGuestAgentApkPath prefers a local Gradle build over provisioning, and says so', async () => {
    const saved = process.env.ENKAKU_GUEST_AGENT_PATH
    delete process.env.ENKAKU_GUEST_AGENT_PATH
    const warnings: string[] = []
    try {
      const resolved = await resolveGuestAgentApkPath({
        localBuildPaths: ['package.json'], // any file that certainly exists in the repo root
        toolchain: {
          resolveToolPath: async () => 'SHOULD-NOT-REACH-TIER-3',
          ensureRequiredTools: async () => {
            throw new Error('SHOULD-NOT-REACH-TIER-3')
          },
        },
        onLog: (_l, msg) => warnings.push(msg),
      })
      expect(resolved).toBe('package.json')
      // The warning is the point: a stale local build silently beating a provisioned release is
      // exactly the kind of thing that wastes an afternoon.
      expect(warnings.join(' ')).toMatch(/local guest agent build/)
    } finally {
      if (saved !== undefined) process.env.ENKAKU_GUEST_AGENT_PATH = saved
    }
  })
})

describe('GET/PUT/DELETE /api/devices/:id/network (plan 44 §5.8, persistence in step 5.4)', () => {
  test('GET with no stored config reports engine none, enabled false, health unknown', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher })
    seedDevice(db)
    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as {
      engine: string
      config: unknown
      enabled: boolean
      observed: unknown
      health: string
      checks: unknown[]
      drift: boolean
      sessionId: unknown
      failClosed: unknown
      lastError: unknown
      exitHistory: unknown[]
      recovery: unknown
      captured: unknown
      setBy: unknown
      pendingClear: unknown
    }
    expect(body).toEqual({
      engine: 'none',
      config: null,
      enabled: false,
      observed: null,
      drift: false,
      sessionId: null,
      // Plan 54 §4.2, §5.6 — the safe default even with nothing stored yet, so Studio never has to
      // guess one of its own.
      failClosed: true,
      health: 'unknown',
      checks: [],
      lastError: null,
      exitHistory: [],
      // Plan 90 §3.7 rule 5 — no recovery has ever been needed for a route that does not exist yet.
      recovery: null,
      // Plan 114 §3.6, §3.3 — additive: nothing captured from a phone this farm never wrote to,
      // and nobody has set a route to be attributed.
      captured: null,
      setBy: null,
      // No teardown is owed to a device this farm has never written a route to.
      pendingClear: null,
    })
  })

  test('PUT saves AND enables the route in one action, never reports health "ok" (only an egress probe could), and never echoes the password', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const { db, app, events } = makeHarness({ launcher, client })
    seedDevice(db)

    const res = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, username: 'u', password: 'hunter2', udpMode: 'udp' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('hunter2')
    const body = JSON.parse(text) as {
      engine: string
      health: string
      enabled: boolean
      config: { engine: string; host: string; port: number; credentialRef?: string; credentialUsername?: string; udpMode: string; onGeoFail: string }
    }
    expect(body.engine).toBe('vpn-helper')
    expect(body.health).toBe('unverified')
    expect(body.enabled).toBe(true)
    // No username/password on the response — inline credentials were moved into this device's own
    // named credential (plan 52 §4.2, §5.1), referenced by `credentialRef` only.
    // `credentialUsername` is the non-secret half, added so an operator can tell
    // WHICH upstream session a route uses without revealing anything — the
    // password still never appears on this polled endpoint (asserted below).
    expect(body.config).toEqual({ engine: 'vpn-helper', host: 'proxy.example', port: 1080, credentialRef: 'device-dev-1', credentialUsername: 'u', udpMode: 'udp', onGeoFail: 'report' })

    const applied = events.find((e) => e.kind === 'network.applied')
    expect(applied).toBeTruthy()
    expect(JSON.stringify(applied?.meta)).not.toContain('hunter2')

    // Persisted straight into the DB row, not just held in memory — the whole point of step 5.4.
    // Unlike plan 44's original compromise, the password is NOT in the raw column any more (plan
    // 52 §4.2, §5.1, acceptance criterion 4) — only a `credentialRef` naming where it actually
    // lives, encrypted, in `network_credentials`.
    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect(JSON.stringify(row?.networkRoute)).not.toContain('hunter2')
    expect(JSON.stringify(row?.networkRoute)).toContain('device-dev-1')
  })

  test('re-saving host/port alone KEEPS the stored credential — a blank username is not a request to connect anonymously', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    const put = (body: unknown) =>
      app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    await put({ host: 'proxy.example', port: 1080, username: 'country-id-city-surabaya', password: 'hunter2', udpMode: 'udp' })

    // Exactly what Studio re-sends: the API never returns a username, so the form has none to
    // send back. Treating that as "no authentication" silently downgraded an authenticated route
    // to an anonymous one — against an upstream that also accepts IP-whitelist auth it connects
    // fine and serves a default-pool exit, so every check passes while the requested targeting is
    // gone. The credential must survive.
    const res = await put({ host: 'proxy.example', port: 1080, udpMode: 'tcp' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { config: { udpMode: string; credentialRef?: string } }
    expect(body.config.credentialRef).toBe('device-dev-1')
    expect(body.config.udpMode).toBe('tcp')

    // ...and dropping it is available, but only by asking.
    const cleared = await put({ host: 'proxy.example', port: 1080, udpMode: 'udp', clearCredential: true })
    const clearedBody = (await cleared.json()) as { config: { credentialRef?: string } }
    expect(clearedBody.config.credentialRef).toBeUndefined()
  })

  test('drift: enabled true with observed.up false produces drift true, never quietly reported as off', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: false }) })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })
    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as { enabled: boolean; observed: { up: boolean }; drift: boolean; health: string }
    expect(body.enabled).toBe(true)
    expect(body.observed.up).toBe(false)
    expect(body.drift).toBe(true)
    expect(body.health).toBe('degraded')
  })

  test('DELETE reverts the route, releases its port, and clears the stored config; a second DELETE is a no-op', async () => {
    const { launcher, calls } = fakeLauncher()
    // `revert()` polls `route.status` until the device agrees `up: false`
    // (plan 44 §8b #1) — reporting it already down keeps this test from
    // waiting out the real ~5s poll budget.
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: false }) })
    const { db, app, ports, events } = makeHarness({ launcher, client })
    seedDevice(db)

    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })
    expect(ports.inUse.size).toBe(1)

    const res1 = await app.request('/dev-1/network', { method: 'DELETE' })
    expect(res1.status).toBe(200)
    expect(ports.inUse.size).toBe(0)
    expect(calls).toContain('removeForward:27400')
    expect(events.find((e) => e.kind === 'network.reverted')).toBeTruthy()

    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect(row?.networkRoute).toBeNull()

    const res2 = await app.request('/dev-1/network', { method: 'DELETE' })
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as { engine: string; config: unknown; enabled: boolean }
    expect(body2).toMatchObject({ engine: 'none', config: null, enabled: false })
  })

  test('PUT refuses an offline device (plan 205 §4.8)', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher })
    seedDevice(db, { status: 'offline' })
    const res = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })
    expect(res.status).toBe(409)
  })

  test('an invalid body is rejected with E_BAD_REQUEST', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher })
    seedDevice(db)
    const res = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '', port: 999999 }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/devices/:id/network/enable and /disable (plan 44 step 5.4)', () => {
  test('enable is refused with E_NO_ROUTE_CONFIG when no config is stored — a hard server-side refusal', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher })
    seedDevice(db)
    const res = await app.request('/dev-1/network/enable', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NO_ROUTE_CONFIG')
  })

  test('disable tears the route down but keeps the config, so it can be switched back on', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: false }) })
    const { db, app, ports } = makeHarness({ launcher, client })
    seedDevice(db)

    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, username: 'u', password: 'hunter2', udpMode: 'udp' }),
    })

    const res = await app.request('/dev-1/network/disable', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      engine: string
      enabled: boolean
      config: { engine: string; host: string; port: number; credentialRef?: string; credentialUsername?: string; udpMode: string; onGeoFail: string } | null
    }
    expect(body.enabled).toBe(false)
    // No username/password on the response — moved into this device's own named credential.
    // `credentialUsername` is the non-secret half, added so an operator can tell
    // WHICH upstream session a route uses without revealing anything — the
    // password still never appears on this polled endpoint (asserted below).
    expect(body.config).toEqual({ engine: 'vpn-helper', host: 'proxy.example', port: 1080, credentialRef: 'device-dev-1', credentialUsername: 'u', udpMode: 'udp', onGeoFail: 'report' })
    expect(ports.inUse.size).toBe(0)

    // The config on the row references the credential by name — no plaintext password anywhere
    // in `devices` (plan 52 §4.2, acceptance criterion 4).
    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    const stored = row?.networkRoute as { config: Record<string, unknown>; enabled: boolean; sessionId?: string } | null
    expect(stored?.config).toEqual({ engine: 'vpn-helper', host: 'proxy.example', port: 1080, credentialRef: 'device-dev-1', udpMode: 'udp' })
    expect(stored?.enabled).toBe(false)
    expect(JSON.stringify(stored)).not.toContain('hunter2')
    // The sticky-session id (plan 52 §4.3), minted on the PUT's own apply(), survives the
    // disable — it is kept, not cleared, so re-enabling does not get a fresh exit for no reason.
    expect(typeof stored?.sessionId).toBe('string')
    expect(stored?.sessionId?.length).toBeGreaterThan(0)
  })

  test('enable re-applies a previously stored config without the operator retyping it', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: false }) })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, password: 'hunter2', udpMode: 'udp' }),
    })
    await app.request('/dev-1/network/disable', { method: 'POST' })

    const res = await app.request('/dev-1/network/enable', { method: 'POST' })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('hunter2')
    const body = JSON.parse(text) as {
      enabled: boolean
      config: { engine: string; host: string; port: number; credentialRef?: string; credentialUsername?: string; udpMode: string; onGeoFail: string }
    }
    expect(body.enabled).toBe(true)
    expect(body.config).toEqual({ engine: 'vpn-helper', host: 'proxy.example', port: 1080, credentialRef: 'device-dev-1', udpMode: 'udp', onGeoFail: 'report' })
  })

  test('enable refuses an offline device (the arm direction — plan 205 §4.8)', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher })
    seedDevice(db, { status: 'offline' })
    const res = await app.request('/dev-1/network/enable', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('disable does NOT refuse an offline device — the disarm direction widens exactly that case (plan 44 §5.7, plan 205 §4.8) — but a live job still forbids it', async () => {
    const { launcher } = fakeLauncher()
    const { db, app, activities } = makeHarness({ launcher })
    seedDevice(db, { status: 'offline' })
    const offline = await app.request('/dev-1/network/disable', { method: 'POST' })
    expect(offline.status).toBe(200)

    seedDevice(db, { id: 'dev-2', stableId: 'stable-dev-2', serial: 'serial-dev-2' })
    activities.start('dev-2', { id: 'job:j1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const busy = await app.request('/dev-2/network/disable', { method: 'POST' })
    expect(busy.status).toBe(409)
  })
})

describe('POST /api/devices/:id/network/retry (plan 90 §3.7 rule 4, fixes F17) — the honest disable/enable workaround', () => {
  test('refused with E_NO_ROUTE_CONFIG when there is no enabled route', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher })
    seedDevice(db)
    const res = await app.request('/dev-1/network/retry', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NO_ROUTE_CONFIG')
  })

  test('refuses an offline device (plan 205 §4.8)', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher })
    seedDevice(db, { status: 'offline' })
    const res = await app.request('/dev-1/network/retry', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('clears an exhausted bound and applies once, immediately — what disable-then-enable achieved by accident, without the teardown round trip', async () => {
    const routeStartCalls: string[] = []
    let shouldFail = true
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        if (shouldFail) throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
        return { started: true }
      },
      routeStatus: async () => (shouldFail ? { prepared: true, up: false, state: 'down' as const } : { prepared: true, up: true, upstream: 'proxy.example:1080' }),
    })
    const { db, restoreDeviceRoute, app } = makeHarness({ launcher, client, recoveryBackoffS: [0, 0, 0] })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    for (let i = 0; i < 3; i++) await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(3)
    const before = (await (await app.request('/dev-1/network')).json()) as NetworkStatusResult
    expect(before.recovery?.exhausted).toBe(true)

    // The upstream is fixed by the time the operator retries — the honest disable/enable
    // equivalent should not need it to still be broken to prove the counter was cleared.
    shouldFail = false
    const res = await app.request('/dev-1/network/retry', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(routeStartCalls).toHaveLength(4) // applied once, immediately — no waiting for the re-arm

    const body = (await res.json()) as NetworkStatusResult
    // The apply succeeded outright — the recovery state is gone entirely, not merely un-exhausted.
    expect(body.recovery).toBeNull()
    expect(body.enabled).toBe(true) // never the misleading "route is off" state disable-then-enable passes through
  })
})

describe('DELETE /api/devices/:id/guest-agent — uninstall (plan 44 §5.8)', () => {
  test('tears down an active route first, then uninstalls', async () => {
    const { launcher, calls } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: false }) })
    const { db, app, ports, events } = makeHarness({ launcher, client })
    seedDevice(db)

    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })
    expect(ports.inUse.size).toBe(1)

    const res = await app.request('/dev-1/guest-agent', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(ports.inUse.size).toBe(0)
    expect(calls).toContain('stop')
    expect(events.find((e) => e.kind === 'network.reverted')).toBeTruthy()
    expect(events.find((e) => e.kind === 'guest-agent.uninstalled')).toBeTruthy()
  })
})

describe('boot reconciliation (plan 44 step 5.4, fixing the outlived-route defect in §8b)', () => {
  test('a device carrying an enabled route from a previous process is probed, not blindly reapplied', async () => {
    const { launcher, calls } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: false }) })
    const { db, app, reconcileNetworkRoutes } = makeHarness({ launcher, client })
    seedDevice(db)
    // Simulates what a PREVIOUS core process would have left behind — no
    // route.start is ever called here, exactly what "do not blindly
    // reapply" requires.
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await reconcileNetworkRoutes()
    // Probed (bootstrap + forward, to reach `route.status`) — but never
    // `route.start`, since this launcher fake has no such call to record.
    expect(calls.some((c) => c.startsWith('bootstrap:'))).toBe(true)
    expect(calls).toContain('forward:27400')

    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as {
      enabled: boolean
      observed: { prepared: boolean; up: boolean } | null
      drift: boolean
      health: string
    }
    expect(body.enabled).toBe(true)
    expect(body.observed).toEqual({ prepared: true, up: false })
    expect(body.drift).toBe(true)
    expect(body.health).toBe('degraded')
  })
})

describe('plan 44 §8b "Bug 1": one token per device, shared across every operation', () => {
  test('a guest-agent status probe interleaved after an applied network route does NOT rotate its token', async () => {
    const { launcher, calls } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    // Apply a route (mints the device's ONE token and establishes its session).
    const putRes = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })
    expect(putRes.status).toBe(200)

    // A guest-agent status probe for the SAME device — this used to mint its OWN fresh token
    // (packages/core/src/api/guest-agent.ts's old `probeReachability`), invalidating the route's
    // live client and surfacing as E_UNAUTHORISED on the next status read.
    const statusRes = await app.request('/dev-1/guest-agent')
    expect(statusRes.status).toBe(200)
    expect(((await statusRes.json()) as { state: string }).state).toBe('ready')

    // The route's own status read afterwards must still be healthy — no E_UNAUTHORISED, and
    // `up`/`upstream` still coming straight from the device.
    const networkRes = await app.request('/dev-1/network')
    const networkBody = (await networkRes.json()) as { health: string; lastError: unknown; observed: { up: boolean } | null }
    expect(networkBody.lastError).toBeNull()
    expect(networkBody.health).not.toBe('degraded')
    expect(networkBody.observed?.up).toBe(true)

    // Exactly ONE bootstrap for the whole device across PUT + GET(guest-agent) + GET(network) —
    // the guest-agent probe reused the route's session instead of minting a competing token.
    expect(calls.filter((c) => c.startsWith('bootstrap:'))).toHaveLength(1)
  })

  test('a cold network read (no applied route in this process) that genuinely cannot reach the agent is reported as an OBSERVE failure, never E_NETWORK_APPLY_FAILED', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      hello: async () => {
        throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
      },
    })
    const { db, app, reconcileNetworkRoutes } = makeHarness({ launcher, client })
    seedDevice(db)
    // Simulates a route left behind by a PREVIOUS core process — `observe()` must be able to
    // answer without this process ever having called apply() (plan 44 §8b, "Bug 2").
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await reconcileNetworkRoutes()

    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as { lastError: { code: string } | null; health: string }
    expect(body.lastError?.code).toBe('E_TRANSPORT')
    expect(body.lastError?.code).not.toBe('E_NETWORK_APPLY_FAILED')
    expect(body.health).toBe('degraded')
  })

  test('a handshake that fails with E_UNAUTHORISED (the agent restarted) triggers exactly one re-bootstrap, then the route works again', async () => {
    const { launcher, calls } = fakeLauncher()
    let statusCalls = 0
    const client = fakeClient({
      routeStatus: async () => {
        statusCalls++
        if (statusCalls === 1) throw new GuestAgentClientError('E_UNAUTHORISED', 'bad or missing token')
        return { prepared: true, up: true, upstream: 'proxy.example:1080' }
      },
    })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })

    // The re-auth already happened transparently inside PUT's own post-apply `observe()` call
    // (best-effort, so a failure there would have been swallowed) — this GET just confirms the
    // route is left in a healthy, fully-recovered state afterwards.
    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as { observed: { up: boolean } | null; lastError: unknown }
    expect(body.lastError).toBeNull()
    expect(body.observed?.up).toBe(true)
    // Two bootstraps total for the device: the original apply(), plus exactly one re-auth.
    expect(calls.filter((c) => c.startsWith('bootstrap:'))).toHaveLength(2)
  })
})

describe('checks and health derivation (plan 51 §4.1, §5.5) — requires ENKAKU_NETWORK_PROBE_URL', () => {
  /** Sets `ENKAKU_NETWORK_PROBE_URL` for the duration of `fn`, then restores whatever was there before — `probeUrl()` in guest-agent.ts reads the env var fresh on every call, so this is enough; no module reload needed. */
  async function withProbeUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.ENKAKU_NETWORK_PROBE_URL
    process.env.ENKAKU_NETWORK_PROBE_URL = url
    try {
      return await fn()
    } finally {
      if (saved === undefined) delete process.env.ENKAKU_NETWORK_PROBE_URL
      else process.env.ENKAKU_NETWORK_PROBE_URL = saved
    }
  }

  test('with no probe endpoint configured, egress/dns/geo are skip and health stays unverified even with a healthy tunnel', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    const res = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })
    const body = (await res.json()) as { health: string; checks: Array<{ id: string; state: string }> }
    expect(body.health).toBe('unverified')
    const byId = Object.fromEntries(body.checks.map((c) => [c.id, c.state]))
    expect(byId.tunnel).toBe('pass')
    expect(byId.egress).toBe('skip')
    expect(byId.dns).toBe('skip')
    expect(byId.geo).toBe('skip')
    expect(byId.leak).toBe('skip')
  })

  test('a working route with the probe endpoint configured and the agent advertising egress-probe reaches health: ok — the first time that value is reachable (plan 51 §1)', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      const client = fakeClient({
        hello: async () => ({
          protocol: 1,
          appVersion: '1.0.0',
          androidSdkInt: 35,
          capabilities: ['socks5-route', 'vpn-status', 'egress-probe'],
        }),
        routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
        egressProbe: async (url) => {
          expect(url).toBe('https://probe.internal/x')
          return {
            tunnelled: { ok: true, status: 200, body: 'nonce=abc', ms: 210 },
            direct: { ok: true, status: 200, body: 'nonce=abc', ms: 30 },
          }
        },
      })
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)

      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
      })
      const body = (await res.json()) as { health: string; checks: Array<{ id: string; state: string }> }
      const byId = Object.fromEntries(body.checks.map((c) => [c.id, c.state]))
      expect(byId.tunnel).toBe('pass')
      expect(byId.upstream).toBe('pass')
      expect(byId.egress).toBe('pass')
      expect(body.health).toBe('ok')
    }))

  test('upstream reports fail when the tunnelled leg dies at the SOCKS5 connect stage, distinct from a healthy tunnel check (acceptance criterion 2)', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      const client = fakeClient({
        hello: async () => ({
          protocol: 1,
          appVersion: '1.0.0',
          androidSdkInt: 35,
          capabilities: ['socks5-route', 'vpn-status', 'egress-probe'],
        }),
        routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
        egressProbe: async () => ({
          tunnelled: { ok: false, ms: 8000, error: 'SOCKS5 CONNECT failed (reply code 5)', stage: 'connect' },
          direct: { ok: true, status: 200, body: 'nonce=xyz', ms: 40 },
        }),
      })
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)

      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
      })
      const body = (await res.json()) as { health: string; checks: Array<{ id: string; state: string; detail?: string }> }
      const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
      // The TUN itself is fine — only the SOCKS5 session failed, and the checks say exactly that
      // rather than a blanket `degraded` with no indication of which fact is wrong.
      expect(byId.tunnel?.state).toBe('pass')
      expect(byId.upstream?.state).toBe('fail')
      expect(byId.egress?.state).toBe('fail')
      expect(body.health).toBe('degraded')
    }))

  test('a probe target that fails to answer (SOCKS5 connect succeeded) reports upstream: pass, egress: fail — the two are not conflated', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      const client = fakeClient({
        hello: async () => ({
          protocol: 1,
          appVersion: '1.0.0',
          androidSdkInt: 35,
          capabilities: ['socks5-route', 'vpn-status', 'egress-probe'],
        }),
        routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
        egressProbe: async () => ({
          tunnelled: { ok: false, status: 503, ms: 210, error: 'probe target responded 503', stage: 'fetch' },
          direct: { ok: true, status: 200, body: 'nonce=xyz', ms: 40 },
        }),
      })
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)

      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
      })
      const body = (await res.json()) as { checks: Array<{ id: string; state: string }> }
      const byId = Object.fromEntries(body.checks.map((c) => [c.id, c.state]))
      expect(byId.upstream).toBe('pass')
      expect(byId.egress).toBe('fail')
    }))

  test('an agent build that does not advertise egress-probe leaves egress: skip even with a probe endpoint configured', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      // Default fakeClient hello() advertises only socks5-route/vpn-status — no egress-probe.
      const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)

      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
      })
      const body = (await res.json()) as { health: string; checks: Array<{ id: string; state: string; detail?: string }> }
      const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
      expect(byId.egress?.state).toBe('skip')
      expect(byId.egress?.detail).toContain('does not advertise')
      expect(body.health).toBe('unverified')
    }))

  test('no check detail ever carries the route\'s username or password (acceptance criterion 8)', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      const client = fakeClient({
        hello: async () => ({
          protocol: 1,
          appVersion: '1.0.0',
          androidSdkInt: 35,
          capabilities: ['socks5-route', 'vpn-status', 'egress-probe'],
        }),
        routeStatus: async () => ({ prepared: true, up: false, lastError: 'auth failed for hunter2' }),
        egressProbe: async () => ({
          tunnelled: { ok: false, ms: 10, error: 'no route is currently up — nothing to measure through', stage: 'connect' },
          direct: { ok: true, status: 200, ms: 12 },
        }),
      })
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)

      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, username: 'sam', password: 'hunter2', udpMode: 'udp' }),
      })
      const text = await res.text()
      expect(text).not.toContain('hunter2')
    }))
})

describe('geo / dns / leak checks (plan 51 §5.3, §5.7; plan 55) — requires ENKAKU_NETWORK_PROBE_URL and a fake geo provider', () => {
  /** Sets `ENKAKU_NETWORK_PROBE_URL` for the duration of `fn` — mirrors the identically-named helper in the "checks and health derivation" describe block above (each `describe` here has its own copy; the env var itself is the only shared state). */
  async function withProbeUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.ENKAKU_NETWORK_PROBE_URL
    process.env.ENKAKU_NETWORK_PROBE_URL = url
    try {
      return await fn()
    } finally {
      if (saved === undefined) delete process.env.ENKAKU_NETWORK_PROBE_URL
      else process.env.ENKAKU_NETWORK_PROBE_URL = saved
    }
  }

  /** Mirrors `withProbeUrl` above, for `ENKAKU_NETWORK_PROBE_DNS_ZONE` (plan 51 §5.3). */
  async function withDnsZone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.ENKAKU_NETWORK_PROBE_DNS_ZONE
    process.env.ENKAKU_NETWORK_PROBE_DNS_ZONE = zone
    try {
      return await fn()
    } finally {
      if (saved === undefined) delete process.env.ENKAKU_NETWORK_PROBE_DNS_ZONE
      else process.env.ENKAKU_NETWORK_PROBE_DNS_ZONE = saved
    }
  }

  /** Swaps `globalThis.fetch` for the duration of `fn` — `lookupGeo()`/the dns resolver check in guest-agent.ts call the real global, never an injected client (that HTTP surface belongs to the farm's own probe-server, not the guest agent's wire protocol). */
  async function withFetch<T>(handler: (url: URL) => { status?: number; body: unknown } | null, fn: () => Promise<T>): Promise<T> {
    const saved = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const result = handler(new URL(raw))
      if (!result) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      return await fn()
    } finally {
      globalThis.fetch = saved
    }
  }

  const GEO_PROVIDER = 'https://probe.internal/geo'
  const geoSettings = () => ({ geoProvider: GEO_PROVIDER, geoIntervalSec: 300 })

  function fakeGeoFetch(byIp: Record<string, { country?: string | null; region?: string | null; city?: string | null; asn?: number | null; isp?: string | null }>) {
    return (url: URL): { body: unknown } | null => {
      if (url.pathname !== '/geo') return null
      const ip = url.searchParams.get('ip')
      const fields = (ip && byIp[ip]) ?? { country: null, region: null, city: null, asn: null, isp: null }
      return { body: { country: null, region: null, city: null, asn: null, isp: null, ...fields } }
    }
  }

  test('acceptance criterion 1: a route with no expectation reports geo: skip — never pass, even with a geo provider configured', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withFetch(fakeGeoFetch({ '1.2.3.4': { country: 'JP' } }), async () => {
        const { launcher } = fakeLauncher()
        const client = fakeClient({
          hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
          routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
          egressProbe: async () => ({
            tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
            direct: { ok: true, status: 200, ms: 20 },
          }),
        })
        const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
        seedDevice(db)
        const res = await app.request('/dev-1/network', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
        })
        const body = (await res.json()) as { checks: Array<{ id: string; state: string }> }
        const byId = Object.fromEntries(body.checks.map((c) => [c.id, c.state]))
        expect(byId.geo).toBe('skip')
      })))

  test('acceptance criterion 2: an expectation with no geo provider configured reports skip, naming the setting', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      const client = fakeClient({
        hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
        routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
        egressProbe: async () => ({
          tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
          direct: { ok: true, status: 200, ms: 20 },
        }),
      })
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)
      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JP' } }),
      })
      const body = (await res.json()) as { checks: Array<{ id: string; state: string; detail?: string }> }
      const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
      expect(byId.geo?.state).toBe('skip')
      expect(byId.geo?.detail).toContain('geo lookup provider')
    }))

  test('acceptance criterion 3: a matching exit reports pass with the observed location in detail (this IS the dead-config test — geoProvider is actually read, not just stored)', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withFetch(fakeGeoFetch({ '1.2.3.4': { country: 'JP', city: 'Tokyo', isp: 'NTT' } }), async () => {
        const { launcher } = fakeLauncher()
        const client = fakeClient({
          hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
          routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
          egressProbe: async () => ({
            tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
            direct: { ok: true, status: 200, ms: 20 },
          }),
        })
        const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
        seedDevice(db)
        const res = await app.request('/dev-1/network', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JP' } }),
        })
        const body = (await res.json()) as { health: string; checks: Array<{ id: string; state: string; detail?: string }> }
        const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
        expect(byId.geo?.state).toBe('pass')
        expect(byId.geo?.detail).toContain('Tokyo')
        expect(byId.geo?.detail).toContain('NTT')
        expect(body.health).toBe('ok')
      })))

  test('acceptance criterion 4: a mismatched exit reports fail, names the field, and health is no longer ok', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withFetch(fakeGeoFetch({ '1.2.3.4': { country: 'ID', city: 'Surabaya' } }), async () => {
        const { launcher } = fakeLauncher()
        const client = fakeClient({
          hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
          routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
          egressProbe: async () => ({
            tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
            direct: { ok: true, status: 200, ms: 20 },
          }),
        })
        const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
        seedDevice(db)
        const res = await app.request('/dev-1/network', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JP' } }),
        })
        const body = (await res.json()) as { health: string; checks: Array<{ id: string; state: string; detail?: string }> }
        const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
        expect(byId.geo?.state).toBe('fail')
        expect(byId.geo?.detail).toContain('country')
        expect(byId.geo?.detail).toContain('JP')
        expect(byId.geo?.detail).toContain('ID')
        expect(body.health).not.toBe('ok')
      })))

  test('acceptance criterion 5: a failed lookup reports unknown, never pass', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withFetch(() => ({ status: 500, body: { error: 'boom' } }), async () => {
        const { launcher } = fakeLauncher()
        const client = fakeClient({
          hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
          routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
          egressProbe: async () => ({
            tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
            direct: { ok: true, status: 200, ms: 20 },
          }),
        })
        const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
        seedDevice(db)
        const res = await app.request('/dev-1/network', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JP' } }),
        })
        const body = (await res.json()) as { checks: Array<{ id: string; state: string }> }
        const byId = Object.fromEntries(body.checks.map((c) => [c.id, c.state]))
        expect(byId.geo).toBe('unknown')
        expect(byId.geo).not.toBe('pass')
      })))

  test('acceptance criterion 6: an operator declaring only a country is not failed by a city change, but the city is visible in detail', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withFetch(fakeGeoFetch({ '1.2.3.4': { country: 'JP', city: 'Osaka' } }), async () => {
        const { launcher } = fakeLauncher()
        const client = fakeClient({
          hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
          routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
          egressProbe: async () => ({
            tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
            direct: { ok: true, status: 200, ms: 20 },
          }),
        })
        const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
        seedDevice(db)
        const res = await app.request('/dev-1/network', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JP' } }),
        })
        const body = (await res.json()) as { checks: Array<{ id: string; state: string; detail?: string }> }
        const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
        expect(byId.geo?.state).toBe('pass')
        expect(byId.geo?.detail).toContain('Osaka')
      })))

  test('the expect/onGeoFail fields round-trip through PUT and GET — saved config is actually read back, not dead', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      const client = fakeClient()
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)
      await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JP', city: 'Tokyo' }, onGeoFail: 'hold' }),
      })
      const res = await app.request('/dev-1/network')
      const body = (await res.json()) as { config: { expect?: { country: string; city?: string }; onGeoFail: string } }
      expect(body.config.expect).toEqual({ country: 'JP', city: 'Tokyo' })
      expect(body.config.onGeoFail).toBe('hold')
    }))

  test('dns: no probeDnsZone configured reports skip naming ENKAKU_NETWORK_PROBE_DNS_ZONE', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      const client = fakeClient({
        hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
        routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
      })
      const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
      seedDevice(db)
      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
      })
      const body = (await res.json()) as { checks: Array<{ id: string; state: string; detail?: string }> }
      const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
      expect(byId.dns?.state).toBe('skip')
      expect(byId.dns?.detail).toContain('ENKAKU_NETWORK_PROBE_DNS_ZONE')
    }))

  test('dns: zone configured but no geo provider reports skip naming the geo provider', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withDnsZone('dns.probe.test', async () => {
        const { launcher } = fakeLauncher()
        const client = fakeClient({
          hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
          routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
        })
        const { db, app } = makeHarness({ launcher, client })
        seedDevice(db)
        const res = await app.request('/dev-1/network', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
        })
        const body = (await res.json()) as { checks: Array<{ id: string; state: string; detail?: string }> }
        const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
        expect(byId.dns?.state).toBe('skip')
        expect(byId.dns?.detail).toContain('geo')
      })))

  test('dns: resolver on the upstream\'s own network reports pass', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withDnsZone('dns.probe.test', async () =>
        withFetch(
          (url) => {
            if (url.pathname === '/geo') {
              // Both the exit (1.2.3.4) and the resolver (9.9.9.9) attribute to the same network.
              return { body: { country: 'JP', region: null, city: null, asn: 4713, isp: 'NTT' } }
            }
            if (url.pathname.startsWith('/resolver/')) return { body: { nonce: 'x', seenFrom: '9.9.9.9', at: 1_700_000_000 } }
            return null
          },
          async () => {
            const { launcher } = fakeLauncher()
            const client = fakeClient({
              hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
              routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
              egressProbe: async () => ({
                tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
                direct: { ok: true, status: 200, ms: 20 },
              }),
            })
            const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
            seedDevice(db)
            const res = await app.request('/dev-1/network', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
            })
            const body = (await res.json()) as { checks: Array<{ id: string; state: string; detail?: string }> }
            const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
            expect(byId.dns?.state).toBe('pass')
          },
        ))))

  test('dns: resolver on a DIFFERENT network than the exit reports fail — the real DNS-leak signal', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withDnsZone('dns.probe.test', async () =>
        withFetch(
          (url) => {
            if (url.pathname === '/geo') {
              const ip = url.searchParams.get('ip')
              // 1.2.3.4 (the exit) is NTT/AS4713; 8.8.8.8 (the resolver) is a different network entirely.
              const network = ip === '1.2.3.4' ? { asn: 4713, isp: 'NTT' } : { asn: 15169, isp: 'Google' }
              return { body: { country: null, region: null, city: null, ...network } }
            }
            if (url.pathname.startsWith('/resolver/')) return { body: { nonce: 'x', seenFrom: '8.8.8.8', at: 1_700_000_000 } }
            return null
          },
          async () => {
            const { launcher } = fakeLauncher()
            const client = fakeClient({
              hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
              routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
              egressProbe: async () => ({
                tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
                direct: { ok: true, status: 200, ms: 20 },
              }),
            })
            const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
            seedDevice(db)
            const res = await app.request('/dev-1/network', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
            })
            const body = (await res.json()) as { health: string; checks: Array<{ id: string; state: string; detail?: string }> }
            const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
            expect(byId.dns?.state).toBe('fail')
            expect(byId.dns?.detail).toContain('Google')
            expect(body.health).not.toBe('ok')
          },
        ))))

  test('dns: no resolver sighting at all reports unknown, not fail — cannot confirm a leak from silence alone', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withDnsZone('dns.probe.test', async () =>
        withFetch(
          (url) => {
            if (url.pathname === '/geo') return { body: { country: 'JP', region: null, city: null, asn: 4713, isp: 'NTT' } }
            if (url.pathname.startsWith('/resolver/')) return { body: { nonce: 'x', seenFrom: null, at: null } }
            return null
          },
          async () => {
            const { launcher } = fakeLauncher()
            const client = fakeClient({
              hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
              routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
              egressProbe: async () => ({
                tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
                direct: { ok: true, status: 200, ms: 20 },
              }),
            })
            const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
            seedDevice(db)
            const res = await app.request('/dev-1/network', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
            })
            const body = (await res.json()) as { checks: Array<{ id: string; state: string }> }
            const byId = Object.fromEntries(body.checks.map((c) => [c.id, c.state]))
            expect(byId.dns).toBe('unknown')
          },
        ))))

  test('leak: IPv6 blocked reports pass', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080', ipv6Blocked: true }) })
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)
      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
      })
      const body = (await res.json()) as { checks: Array<{ id: string; state: string }> }
      expect(Object.fromEntries(body.checks.map((c) => [c.id, c.state])).leak).toBe('pass')
    }))

  test('leak: IPv6 NOT blocked reports fail — asserted, not assumed (plan 51 §5.7)', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080', ipv6Blocked: false }) })
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)
      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
      })
      const body = (await res.json()) as { health: string; checks: Array<{ id: string; state: string; detail?: string }> }
      const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
      expect(byId.leak?.state).toBe('fail')
      expect(body.health).not.toBe('ok')
    }))

  test('leak: an agent build that does not report ipv6Blocked reports skip, not a guessed pass', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      const { launcher } = fakeLauncher()
      // Default fakeClient's routeStatus omits ipv6Blocked entirely — an older agent build.
      const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
      const { db, app } = makeHarness({ launcher, client })
      seedDevice(db)
      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
      })
      const body = (await res.json()) as { checks: Array<{ id: string; state: string }> }
      expect(Object.fromEntries(body.checks.map((c) => [c.id, c.state])).leak).toBe('skip')
    }))

  test('onGeoFail: hold — a mismatched exit forces the device into held via route.hold when the agent supports it', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withFetch(fakeGeoFetch({ '1.2.3.4': { country: 'ID' } }), async () => {
        const holdCalls: string[] = []
        const { launcher } = fakeLauncher()
        const client = fakeClient({
          hello: async () => ({
            protocol: 1,
            appVersion: '1.0.0',
            androidSdkInt: 35,
            capabilities: ['socks5-route', 'vpn-status', 'egress-probe', 'route-hold'],
          }),
          routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
          egressProbe: async () => ({
            tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
            direct: { ok: true, status: 200, ms: 20 },
          }),
          routeHold: async (reason: string) => {
            holdCalls.push(reason)
            return { held: true }
          },
        })
        const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
        seedDevice(db)
        await app.request('/dev-1/network', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JP' }, onGeoFail: 'hold' }),
        })
        expect(holdCalls).toHaveLength(1)
        expect(holdCalls[0]).toContain('country')
      })))

  test('onGeoFail: report (the default) — a mismatched exit does NOT call route.hold', async () =>
    withProbeUrl('https://probe.internal/x', async () =>
      withFetch(fakeGeoFetch({ '1.2.3.4': { country: 'ID' } }), async () => {
        const holdCalls: string[] = []
        const { launcher } = fakeLauncher()
        const client = fakeClient({
          hello: async () => ({
            protocol: 1,
            appVersion: '1.0.0',
            androidSdkInt: 35,
            capabilities: ['socks5-route', 'vpn-status', 'egress-probe', 'route-hold'],
          }),
          routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
          egressProbe: async () => ({
            tunnelled: { ok: true, status: 200, body: '{"address":"1.2.3.4"}', ms: 100 },
            direct: { ok: true, status: 200, ms: 20 },
          }),
          routeHold: async (reason: string) => {
            holdCalls.push(reason)
            return { held: true }
          },
        })
        const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
        seedDevice(db)
        await app.request('/dev-1/network', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JP' } }),
        })
        expect(holdCalls).toHaveLength(0)
      })))

  test('exit history (plan 55 §4.3, §5.5): each fresh geo observation is prepended, newest first, without reading logs', async () =>
    withProbeUrl('https://probe.internal/x', async () => {
      let address = '1.1.1.1'
      const { launcher } = fakeLauncher()
      const client = fakeClient({
        hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status', 'egress-probe'] }),
        routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
        egressProbe: async () => ({
          tunnelled: { ok: true, status: 200, body: JSON.stringify({ address }), ms: 100 },
          direct: { ok: true, status: 200, ms: 20 },
        }),
      })
      await withFetch(
        (url) => (url.pathname === '/geo' ? { body: { country: 'JP', asn: null, isp: null, city: null, region: null } } : null),
        async () => {
          const { db, app } = makeHarness({ launcher, client, networkSettings: geoSettings })
          seedDevice(db)
          await app.request('/dev-1/network', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
          })
          address = '2.2.2.2'
          // A second apply (an operator re-saving, or the /enable path) forces a fresh geo lookup
          // the same way PUT's own apply does.
          await app.request('/dev-1/network/enable', { method: 'POST' })

          const res = await app.request('/dev-1/network')
          const body = (await res.json()) as { exitHistory: Array<{ address: string }> }
          expect(body.exitHistory.map((o) => o.address)).toEqual(['2.2.2.2', '1.1.1.1'])
        },
      )
    }))
})

describe('plan 52 §4.1 device lifecycle — offline keeps the route, online restores it by probing', () => {
  test('device offline: the persisted route stays enabled, the live session is released, and every check reverts to unknown', async () => {
    const { launcher, calls } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const { db, app, ports, handleDeviceOffline } = makeHarness({ launcher, client })
    seedDevice(db)

    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })
    expect(ports.inUse.size).toBe(1)

    await handleDeviceOffline('dev-1')

    // The port/forward this process was holding is released — it is now
    // forwarding to nothing, and holding it would leak a slot forever.
    expect(ports.inUse.size).toBe(0)

    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as { enabled: boolean; health: string; checks: Array<{ id: string; state: string }>; observed: unknown }
    // The stored config/enabled is untouched — a device going offline is not
    // an operator turning the route off.
    expect(body.enabled).toBe(true)
    // The two checks that depend on live observation revert to `unknown`,
    // not a stale `pass` left over from before the disconnect. (`egress`,
    // `geo`, `dns`, `leak` stay `skip` regardless — no probe endpoint is
    // configured in this test, matching every other test in this file.)
    const byId = Object.fromEntries(body.checks.map((c) => [c.id, c.state]))
    expect(byId.tunnel).toBe('unknown')
    expect(byId.upstream).toBe('unknown')
    expect(body.observed).toBeNull()

    // Nothing on the device was asked to stop — no `route.stop`-shaped call.
    expect(calls).not.toContain('stop')
  })

  test('device online: the route is restored by probing, never by re-applying', async () => {
    const routeStartCalls: string[] = []
    const { launcher, calls } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        return { started: true }
      },
      routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
    })
    const { db, app, restoreDeviceRoute, handleDeviceOffline } = makeHarness({ launcher, client })
    seedDevice(db)

    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })
    expect(routeStartCalls).toHaveLength(1) // the PUT's own apply()

    await handleDeviceOffline('dev-1')
    const bootstrapsBeforeRestore = calls.filter((c) => c.startsWith('bootstrap:')).length

    await restoreDeviceRoute('dev-1')

    // A fresh probe happened (bootstrap + forward to reach `route.status`)...
    expect(calls.filter((c) => c.startsWith('bootstrap:')).length).toBeGreaterThan(bootstrapsBeforeRestore)
    // ...but `route.start` was NEVER called again — restore only probes.
    expect(routeStartCalls).toHaveLength(1)

    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as {
      enabled: boolean
      observed: { prepared: boolean; up: boolean; upstream?: string } | null
      drift: boolean
    }
    expect(body.enabled).toBe(true)
    expect(body.observed).toEqual({ prepared: true, up: true, upstream: 'proxy.example:1080' })
    expect(body.drift).toBe(false)
  })

  test('restore decision table: no persisted route, a disabled route, and an offline device are all no-ops', async () => {
    const { launcher, calls } = fakeLauncher()
    const client = fakeClient()
    const { db, restoreDeviceRoute } = makeHarness({ launcher, client })

    // No device row at all.
    await restoreDeviceRoute('ghost')
    expect(calls).toHaveLength(0)

    // A device with no persisted route.
    seedDevice(db, { id: 'dev-none', stableId: 'stable-dev-none', serial: 'serial-dev-none' })
    await restoreDeviceRoute('dev-none')
    expect(calls).toHaveLength(0)

    // A device whose route is stored but disabled (turned off, not removed).
    seedDevice(db, {
      id: 'dev-disabled',
      stableId: 'stable-dev-disabled',
      serial: 'serial-dev-disabled',
      networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: false },
    })
    await restoreDeviceRoute('dev-disabled')
    expect(calls).toHaveLength(0)

    // A device with an enabled route, but currently offline — left enabled
    // and unprobed; the next `device online` transition will call this again.
    seedDevice(db, {
      id: 'dev-offline',
      stableId: 'stable-dev-offline',
      serial: 'serial-dev-offline',
      status: 'offline',
      networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true },
    })
    await restoreDeviceRoute('dev-offline')
    expect(calls).toHaveLength(0)
  })
})

describe('plan 52 §0, §3.1: a route is no longer scoped to who is in control (plan 205 §2.4 widens this further — a live control marker never gates a route write at all)', () => {
  test('a route survives a control marker ending (an explicit end, and a forced idle-timeout sweep)', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const { db, app, events, activities } = makeHarness({ launcher, client })
    seedDevice(db)

    activities.touchControl('dev-1', 'client-a', { kind: 'user', id: 'user-1', label: 'user-1' })
    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })

    // An explicit end, exactly like a WS disconnect ends a control marker.
    expect(activities.end('dev-1', 'control:client-a')).toBe(true)

    let res = await app.request('/dev-1/network')
    let body = (await res.json()) as { enabled: boolean; observed: { up: boolean } | null }
    expect(body.enabled).toBe(true)
    expect(body.observed?.up).toBe(true)

    // Re-establish and end it again as an idle-timeout sweep would — still nothing torn down.
    activities.touchControl('dev-1', 'client-b', { kind: 'user', id: 'user-2', label: 'user-2' })
    expect(activities.end('dev-1', 'control:client-b')).toBe(true)

    res = await app.request('/dev-1/network')
    body = (await res.json()) as { enabled: boolean; observed: { up: boolean } | null }
    expect(body.enabled).toBe(true)
    expect(body.observed?.up).toBe(true)

    // No `network.reverted` event was ever recorded — the only things that
    // ever tear a route down are `/disable`, `DELETE /network`, and
    // uninstall, none of which were called here.
    expect(events.find((e) => e.kind === 'network.reverted')).toBeUndefined()
  })
})

describe('the named credential store (plan 52 §4.2, §5.1)', () => {
  test('create, list (never a secret), and delete round-trip', async () => {
    const { app } = makeHarness({})

    const createRes = await app.request('/network/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'soax-jp', username: 'sam', secret: 'hunter2' }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { id: string; name: string; username?: string; createdAt: number; createdBy: string | null }
    expect(created.name).toBe('soax-jp')
    expect(created.username).toBe('sam')
    // Never the secret, on ANY response shape.
    expect(JSON.stringify(created)).not.toContain('hunter2')

    const listRes = await app.request('/network/credentials')
    const list = (await listRes.json()) as Array<{ name: string }>
    expect(list.map((c) => c.name)).toContain('soax-jp')
    expect(JSON.stringify(list)).not.toContain('hunter2')

    const deleteRes = await app.request('/network/credentials/soax-jp', { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)
    const listAfter = (await (await app.request('/network/credentials')).json()) as Array<{ name: string }>
    expect(listAfter.map((c) => c.name)).not.toContain('soax-jp')
  })

  test('creating a credential with an already-taken name is refused', async () => {
    const { app } = makeHarness({})
    const body = JSON.stringify({ name: 'dup', secret: 'x' })
    const first = await app.request('/network/credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(first.status).toBe(201)
    const second = await app.request('/network/credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('E_CREDENTIAL_NAME_TAKEN')
  })

  test('a route referencing an unknown credentialRef is refused, not silently persisted', async () => {
    const { db, app } = makeHarness({})
    seedDevice(db)
    const res = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, credentialRef: 'does-not-exist', udpMode: 'udp' }),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('E_CREDENTIAL_NOT_FOUND')
    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect(row?.networkRoute).toBeNull()
  })

  test('deleting a credential still referenced by a device is refused (acceptance criterion 3: removing a route keeps the credential, but nothing forces a dangling reference)', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    await app.request('/network/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'shared', username: 'sam', secret: 'hunter2' }),
    })
    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, credentialRef: 'shared', udpMode: 'udp' }),
    })

    const deleteRes = await app.request('/network/credentials/shared', { method: 'DELETE' })
    expect(deleteRes.status).toBe(409)
    expect(((await deleteRes.json()) as { error: { code: string } }).error.code).toBe('E_CREDENTIAL_IN_USE')
  })

  test('two devices share one named credential without retyping it (acceptance criterion 5)', async () => {
    const capturedConfigs: Array<{ username?: string; password?: string }> = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => ({ started: true }),
      routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
    })
    // Intercept the resolved wire config every `route.start` receives, without changing the
    // client's declared behaviour above.
    const spyClient: typeof client = { ...client, routeStart: async (cfg) => (capturedConfigs.push(cfg), client.routeStart(cfg)) }
    const { db, app } = makeHarness({ launcher, client: spyClient })
    seedDevice(db, { id: 'dev-1', stableId: 'stable-dev-1', serial: 'serial-dev-1' })
    seedDevice(db, { id: 'dev-2', stableId: 'stable-dev-2', serial: 'serial-dev-2' })

    await app.request('/network/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'shared', username: 'sam', secret: 'hunter2' }),
    })

    for (const id of ['dev-1', 'dev-2']) {
      const res = await app.request(`/${id}/network`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, credentialRef: 'shared', udpMode: 'udp' }),
      })
      expect(res.status).toBe(200)
    }

    // Exactly one credential exists — neither PUT created its own.
    const list = (await (await app.request('/network/credentials')).json()) as Array<{ name: string }>
    expect(list.filter((c) => c.name === 'shared')).toHaveLength(1)

    // Both devices' resolved wire config carried the SAME real credential.
    expect(capturedConfigs).toHaveLength(2)
    for (const cfg of capturedConfigs) {
      expect(cfg.username).toBe('sam')
      expect(cfg.password).toBe('hunter2')
    }
  })
})

describe('sticky session (plan 52 §3.3, §4.3)', () => {
  /** Sets `ENKAKU_NETWORK_SESSION_TEMPLATE`, then restores whatever was there before. */
  async function withSessionTemplate<T>(template: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.ENKAKU_NETWORK_SESSION_TEMPLATE
    process.env.ENKAKU_NETWORK_SESSION_TEMPLATE = template
    try {
      return await fn()
    } finally {
      if (saved === undefined) delete process.env.ENKAKU_NETWORK_SESSION_TEMPLATE
      else process.env.ENKAKU_NETWORK_SESSION_TEMPLATE = saved
    }
  }

  test('with a template set, the resolved wire username carries the per-device sessionId', async () =>
    withSessionTemplate('-sessionid-{id}', async () => {
      const capturedConfigs: Array<{ username?: string }> = []
      const { launcher } = fakeLauncher()
      const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
      const spyClient: typeof client = { ...client, routeStart: async (cfg) => (capturedConfigs.push(cfg), client.routeStart(cfg)) }
      const { db, app } = makeHarness({ launcher, client: spyClient })
      seedDevice(db)

      const res = await app.request('/dev-1/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'proxy.example', port: 1080, username: 'sam', password: 'hunter2', udpMode: 'udp' }),
      })
      const body = (await res.json()) as { sessionId: string | null }
      expect(body.sessionId).toBeTruthy()

      expect(capturedConfigs).toHaveLength(1)
      expect(capturedConfigs[0]?.username).toBe(`sam-sessionid-${body.sessionId}`)
    }))

  test('with no template set (the default), the resolved wire username is unchanged, even though a sessionId is still minted', async () => {
    const capturedConfigs: Array<{ username?: string }> = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const spyClient: typeof client = { ...client, routeStart: async (cfg) => (capturedConfigs.push(cfg), client.routeStart(cfg)) }
    const { db, app } = makeHarness({ launcher, client: spyClient })
    seedDevice(db)

    const res = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, username: 'sam', password: 'hunter2', udpMode: 'udp' }),
    })
    const body = (await res.json()) as { sessionId: string | null }
    expect(body.sessionId).toBeTruthy()
    expect(capturedConfigs[0]?.username).toBe('sam')
  })

  test('the sessionId is stable across a disable/enable cycle — it is not regenerated on re-enable', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    const putRes = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, username: 'sam', password: 'hunter2', udpMode: 'udp' }),
    })
    const firstSessionId = ((await putRes.json()) as { sessionId: string | null }).sessionId

    await app.request('/dev-1/network/disable', { method: 'POST' })
    const enableRes = await app.request('/dev-1/network/enable', { method: 'POST' })
    const secondSessionId = ((await enableRes.json()) as { sessionId: string | null }).sessionId

    expect(secondSessionId).toBe(firstSessionId)
  })
})

describe('the boot-time inline-credential migration (plan 52 §5.1) — nothing is lost', () => {
  test('a pre-migration row with inline username/password is rewritten to reference a named credential, and the credential resolves to the exact same values', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })

    // Build the harness's `db` first, seed a PRE-MIGRATION row directly (bypassing every endpoint
    // in this file, exactly what a row written by a core built before plan 52 would look like),
    // THEN construct `createGuestAgentRoutes` against it — migration runs synchronously at
    // construction, before this function returns.
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db)
    db.update(devices)
      .set({
        networkRoute: {
          config: { host: 'proxy.example', port: 1080, username: 'sam', password: 'hunter2', udpMode: 'udp' },
          enabled: true,
        },
      })
      .where(eq(devices.id, 'dev-1'))
      .run()

    const deps: GuestAgentRoutesDeps = {
      db,
      hostAdb: async () => '',
      adb: fakeAdbForward(),
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      apkPath: async () => '/fake/guest-agent.apk',
      ports: fakePorts(),
      dataDir: mkdtempSync(join(tmpdir(), 'enkaku-guest-agent-test-')),
      activities: createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} }),
      controlSettings: () => ({ overControl: 'allow', idleSec: 30 }),
      states: createDeviceStateMachine({ db, log: createLogger('test') }),
      log: createLogger('test'),
      routeTimings: { applySettleTimeoutMs: 0, revertPollTimeoutMs: 0 },
      makeLauncher: () => launcher,
      makeClient: () => client,
    }
    const { routes } = createGuestAgentRoutes(deps)
    const app = withUser('admin', routes)

    // The row no longer carries the raw password.
    const migratedRow = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect(JSON.stringify(migratedRow?.networkRoute)).not.toContain('hunter2')

    // The API reflects a credentialRef, never username/password.
    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as { config: { credentialRef?: string; username?: string } | null; enabled: boolean }
    expect(body.enabled).toBe(true)
    expect(body.config?.credentialRef).toBeTruthy()
    expect(body.config?.username).toBeUndefined()

    // Nothing was lost: the migrated credential resolves to the EXACT original username/password.
    const list = (await (await app.request('/network/credentials')).json()) as Array<{ name: string; username?: string }>
    const migrated = list.find((c) => c.name === body.config?.credentialRef)
    expect(migrated?.username).toBe('sam')
  })
})

describe('plan 54 §3.2, §4.2 — restore actually applies, bounded and shared with the heartbeat', () => {
  test('restoreDeviceRoute applies when the device reports no route (the defect this plan fixes: restore used to only probe)', async () => {
    const routeStartCalls: string[] = []
    let started = false
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        started = true
        return { started: true }
      },
      // Down until `route.start` is actually sent, then up — a stand-in for a real device that
      // only starts reporting `up` once the route genuinely applies.
      routeStatus: async () => (started ? { prepared: true, up: true, upstream: 'proxy.example:1080' } : { prepared: true, up: false, state: 'down' as const }),
    })
    const { db, restoreDeviceRoute, app } = makeHarness({ launcher, client, recoveryBackoffS: [0] })
    seedDevice(db)
    // Simulates a route left behind by a previous core process — never applied by THIS process.
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(1)

    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as { enabled: boolean; observed: { up: boolean } | null }
    expect(body.enabled).toBe(true)
    expect(body.observed?.up).toBe(true)
  })

  test('a device already carrying its route is never re-applied, even when recovery is pending — probed and left alone', async () => {
    const routeStartCalls: string[] = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        return { started: true }
      },
      routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }),
    })
    const { db, restoreDeviceRoute } = makeHarness({ launcher, client, recoveryBackoffS: [0] })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(0)
  })

  test('the retry bound holds: gives up after the configured number of attempts and records a check that says why (acceptance criterion 5)', async () => {
    const routeStartCalls: string[] = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
      },
      routeStatus: async () => ({ prepared: true, up: false, state: 'down' as const }),
    })
    // Three attempts, zero backoff — the test still exercises the real bound without sitting out
    // real wall-clock seconds.
    const { db, restoreDeviceRoute, app } = makeHarness({ launcher, client, recoveryBackoffS: [0, 0, 0] })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    // Each call simulates one reconnect/heartbeat tick noticing the device is still down.
    await restoreDeviceRoute('dev-1')
    await restoreDeviceRoute('dev-1')
    await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(3)

    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as { lastError: { code: string; message: string } | null; enabled: boolean }
    expect(body.enabled).toBe(true) // never disabled by a failed recovery — the operator decides
    expect(body.lastError?.code).toBe('E_NETWORK_RECOVERY_EXHAUSTED')
    expect(body.lastError?.message).toContain('gave up after 3 attempts')

    // Does not spin: a fourth tick makes no further attempt, and the "gave up" answer survives it
    // (a cold probe's own success would otherwise silently erase `lastError` on this next tick).
    await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(3)
    const res2 = await app.request('/dev-1/network')
    const body2 = (await res2.json()) as { lastError: { code: string } | null }
    expect(body2.lastError?.code).toBe('E_NETWORK_RECOVERY_EXHAUSTED')
  })

  test('an exhausted bound re-arms after the cool-off — giving up is temporary, not permanent', async () => {
    const routeStartCalls: string[] = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
      },
      routeStatus: async () => ({ prepared: true, up: false, state: 'held' as const }),
    })
    // `recoveryRearmS: 0` — the cool-off itself is not what this asserts; that it EVER re-arms is.
    const { db, restoreDeviceRoute } = makeHarness({ launcher, client, recoveryBackoffS: [0, 0, 0], recoveryRearmS: 0 })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    for (let i = 0; i < 3; i++) await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(3) // bound reached

    // Observed on hardware: a device that hit the bound was still sitting there six hours later,
    // route enabled, nothing retrying. Bounded recovery must mean "not every 20s", not "never
    // again" — so the next tick past the cool-off tries a fresh schedule.
    await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(4)
  })

  test('turning the route off mid-recovery resets the bound — a route re-enabled later gets a fresh three attempts', async () => {
    const routeStartCalls: string[] = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
      },
      routeStatus: async () => ({ prepared: true, up: false, state: 'down' as const }),
    })
    const { db, restoreDeviceRoute, app } = makeHarness({ launcher, client, recoveryBackoffS: [0, 0, 0] })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await restoreDeviceRoute('dev-1')
    await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(2)

    await app.request('/dev-1/network/disable', { method: 'POST' })
    await app.request('/dev-1/network/enable', { method: 'POST' })
    expect(routeStartCalls).toHaveLength(3) // `/enable` itself applies once

    await restoreDeviceRoute('dev-1')
    // A fresh bound: this is attempt 4 overall, but only the 2nd since re-enabling — well within 3.
    expect(routeStartCalls).toHaveLength(4)
  })

  test('the heartbeat is the SAME owner as restoreDeviceRoute — one counter, not two independent retry loops (plan 54 §4.2)', async () => {
    // heartbeatTick itself is not exposed to tests (it only ever runs off a real setInterval in
    // production), so this proves the SHARED-counter property the way it is actually observable:
    // interleaving `restoreDeviceRoute` calls (standing in for "device reconnected") with the
    // recovery bound must still add up to exactly the configured number of attempts, never double
    // that — which is exactly what would happen if the heartbeat kept its own separate counter.
    const routeStartCalls: string[] = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
      },
      routeStatus: async () => ({ prepared: true, up: false, state: 'down' as const }),
    })
    const { db, restoreDeviceRoute } = makeHarness({ launcher, client, recoveryBackoffS: [0, 0, 0] })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    for (let i = 0; i < 6; i++) await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(3) // bounded at 3, no matter how many callers ask
  })
})

/**
 * Plan 90 §3.7, §5 step 90.4 — the actual fix for F16, and the regression test the plan's own
 * §7.1 test plan calls for: exhaust the bound, then prove a GENUINE offline→online transition (not
 * just another `restoreDeviceRoute` call) is what restarts it — and that the reconnect-cycle
 * breaker is what stops that from becoming plan 54 §9 Q2's own feared infinite-retry loop against
 * a permanently dead proxy. Every assertion below reads the real `/network` GET response and the
 * real device event log — the API surface an operator actually reads (this plan's own stated
 * lesson) — never `recoveryByDevice` directly, which this file cannot reach from outside
 * `guest-agent.ts` in any case.
 */
describe('plan 90 §3.7 — recovery that knows the device came back (fixes F13–F20, answers plan 54 §9 Q2)', () => {
  test('a bare reconnect (no offline transition) does not reset an exhausted bound — F16 confirmed: a naive `resetRecovery` grep would wrongly conclude this already worked', async () => {
    const routeStartCalls: string[] = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
      },
      routeStatus: async () => ({ prepared: true, up: false, state: 'down' as const }),
    })
    const { db, restoreDeviceRoute } = makeHarness({ launcher, client, recoveryBackoffS: [0, 0, 0] })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    for (let i = 0; i < 3; i++) await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(3) // bound reached

    // Exactly the shape `restoreDeviceRoute`'s `!persisted?.enabled` early return already handled
    // BEFORE this plan (F16's "wrong branch") — this proves the RIGHT branch does not fire on its
    // own just because the function was called again.
    await restoreDeviceRoute('dev-1')
    expect(routeStartCalls).toHaveLength(3) // still held — nothing "new" happened
  })

  test('a genuine offline→online transition resets an exhausted bound and restarts recovery within one heartbeat, instead of waiting out the re-arm — the actual fix for F16', async () => {
    const routeStartCalls: string[] = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
      },
      routeStatus: async () => ({ prepared: true, up: false, state: 'down' as const }),
    })
    // The default re-arm is 120s (`guestAgent.recoveryRearmSec`'s own default) — deliberately NOT
    // overridden here, so the ONLY way a fourth attempt can happen within this test's few
    // simulated seconds is the reconnect reset, not the re-arm clock.
    const { db, restoreDeviceRoute, handleDeviceOffline, app } = makeHarness({ launcher, client, recoveryBackoffS: [0, 0, 0] })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await withFakeClock(Date.parse('2026-01-01T00:00:00Z'), async (advance) => {
      for (let i = 0; i < 3; i++) {
        advance(1_000)
        await restoreDeviceRoute('dev-1')
      }
      expect(routeStartCalls).toHaveLength(3) // bound reached

      const exhausted = (await (await app.request('/dev-1/network')).json()) as NetworkStatusResult
      expect(exhausted.recovery?.exhausted).toBe(true)
      expect(exhausted.recovery?.attempts).toBe(3)

      // The device genuinely went offline (a USB re-enumeration, F18) and reconnected — well
      // inside the 120s re-arm window, so only the reconnect reset can explain a fourth attempt.
      advance(5_000)
      await handleDeviceOffline('dev-1')
      advance(1_000)
      await restoreDeviceRoute('dev-1')
      expect(routeStartCalls).toHaveLength(4) // a fresh attempt — the bound was reset, not re-armed

      const restarted = (await (await app.request('/dev-1/network')).json()) as NetworkStatusResult
      expect(restarted.recovery?.exhausted).toBe(false)
      expect(restarted.recovery?.attempts).toBe(1) // a fresh attempt budget, not attempt 4 of 3
      // The operator never had to touch the toggle — this is the whole point (plan 90's own
      // stated verifiable result).
    })
  })

  test('network.recovery.exhausted and network.recovery.recovered are recorded on the device event log (fixes F20)', async () => {
    let shouldFail = true
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        if (shouldFail) throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
        return { started: true }
      },
      routeStatus: async () => (shouldFail ? { prepared: true, up: false, state: 'down' as const } : { prepared: true, up: true, upstream: 'proxy.example:1080' }),
    })
    const { db, restoreDeviceRoute, handleDeviceOffline, events } = makeHarness({ launcher, client, recoveryBackoffS: [0, 0, 0] })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await withFakeClock(Date.parse('2026-01-01T00:00:00Z'), async (advance) => {
      for (let i = 0; i < 3; i++) {
        advance(1_000)
        await restoreDeviceRoute('dev-1')
      }
      expect(events.some((e) => e.kind === 'network.recovery.exhausted')).toBe(true)

      // The upstream comes back, and a genuine reconnect resets the bound in time to catch it.
      shouldFail = false
      advance(5_000)
      await handleDeviceOffline('dev-1')
      advance(1_000)
      await restoreDeviceRoute('dev-1')

      expect(events.some((e) => e.kind === 'network.recovery.recovered')).toBe(true)
    })
  })

  test('six replugs inside an hour engage the reconnect-cycle breaker on the fifth, log it once, and fall back to the re-arm clock — no infinite retry against a genuinely dead proxy (plan 54 §9 Q2\'s own stated fear)', async () => {
    const routeStartCalls: string[] = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async () => {
        routeStartCalls.push('start')
        throw new GuestAgentClientError('E_TRANSPORT', 'connection refused')
      },
      routeStatus: async () => ({ prepared: true, up: false, state: 'down' as const }),
    })
    const { warns, log } = fakeLog()
    const { db, restoreDeviceRoute, handleDeviceOffline, app } = makeHarness({
      launcher,
      client,
      log,
      recoveryBackoffS: [0, 0, 0],
      // The default (4) — spelled out so this test keeps meaning "the fifth" even if the schema's
      // own default ever changes.
      guestAgentSettings: () => ({ maxRecoveryCyclesPerHour: 4, recoveryRearmSec: 120 }),
    })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await withFakeClock(Date.parse('2026-01-01T00:00:00Z'), async (advance) => {
      // Exhaust the bound once, the ordinary way — no offline transition yet.
      for (let i = 0; i < 3; i++) {
        advance(1_000)
        await restoreDeviceRoute('dev-1')
      }
      expect(routeStartCalls).toHaveLength(3)

      // Six replugs, a minute apart — comfortably inside one rolling hour.
      for (let i = 0; i < 6; i++) {
        advance(60_000)
        await handleDeviceOffline('dev-1')
        advance(1_000)
        await restoreDeviceRoute('dev-1')
      }

      const status = (await (await app.request('/dev-1/network')).json()) as NetworkStatusResult
      // The breaker's own ceiling — never climbs past it, no matter how many more replugs happen.
      expect(status.recovery?.reconnectCycles).toBe(4)

      const breakerWarnings = warns.filter((w) => w.includes('reconnect-cycle breaker is engaged'))
      expect(breakerWarnings).toHaveLength(1) // logged once, not once per refused reset
    })
  })
})

describe('plan 54 §4.3 — a held route reads as fail-closed, never as healthy', () => {
  test('held: tunnel passes (the TUN is still up), upstream and egress both fail with an honest "blocked on purpose" reason, health is never ok', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStatus: async () => ({
        prepared: true,
        up: false,
        state: 'held' as const,
        upstream: 'proxy.example:1080',
        lastError: 'no contact from the farm for 91000ms',
      }),
    })
    // A plain GET never probes on its own (it only re-observes a route this process already has
    // live state for) — `restoreDeviceRoute` is what actually asks the device, the same as a real
    // reconnect would.
    const { db, app, restoreDeviceRoute } = makeHarness({ launcher, client, recoveryBackoffS: [0, 0, 0] })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()
    await restoreDeviceRoute('dev-1')

    const res = await app.request('/dev-1/network')
    const body = (await res.json()) as {
      health: string
      checks: Array<{ id: string; state: string; detail?: string }>
      observed: { up: boolean; state?: string } | null
    }
    expect(body.observed?.up).toBe(false)
    expect(body.observed?.state).toBe('held')
    const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]))
    expect(byId.tunnel?.state).toBe('pass')
    expect(byId.upstream?.state).toBe('fail')
    expect(byId.upstream?.detail).toContain('no contact from the farm')
    expect(byId.egress?.state).toBe('fail')
    expect(body.health).not.toBe('ok')
    expect(body.health).toBe('degraded')
  })
})

describe('plan 54 §4.2, §5.6 — failClosed is real, not inert', () => {
  test('a brand-new route defaults failClosed to true, and the device is told so on route.start', async () => {
    const routeStartConfigs: Array<{ failClosed?: boolean }> = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async (config) => {
        routeStartConfigs.push(config)
        return { started: true }
      },
    })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    const res = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp' }),
    })
    const body = (await res.json()) as { failClosed: boolean }
    expect(body.failClosed).toBe(true)
    expect(routeStartConfigs).toHaveLength(1)
    expect(routeStartConfigs[0]?.failClosed).toBe(true)
  })

  test('an explicit failClosed:false on PUT is honoured, persisted, and sent to the device — the debugging opt-out', async () => {
    const routeStartConfigs: Array<{ failClosed?: boolean }> = []
    const { launcher } = fakeLauncher()
    const client = fakeClient({
      routeStart: async (config) => {
        routeStartConfigs.push(config)
        return { started: true }
      },
    })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)

    const res = await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1080, udpMode: 'udp', failClosed: false }),
    })
    const body = (await res.json()) as { failClosed: boolean }
    expect(body.failClosed).toBe(false)
    expect(routeStartConfigs[0]?.failClosed).toBe(false)

    // A plain config update (no opinion on failClosed this time) carries the false value forward
    // rather than resetting it back to the safe default — an update is not an operator asking to
    // change a setting they did not mention.
    await app.request('/dev-1/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'proxy.example', port: 1081, udpMode: 'udp' }),
    })
    const res2 = await app.request('/dev-1/network')
    expect(((await res2.json()) as { failClosed: boolean }).failClosed).toBe(false)
  })

  test('a route persisted before this plan shipped (no failClosed on the stored row) reads failClosed:true through GET — the safe default applies retroactively, not just to brand-new routes', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient({ routeStatus: async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080' }) })
    const { db, app } = makeHarness({ launcher, client })
    seedDevice(db)
    db.update(devices)
      .set({ networkRoute: { config: { host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    const res = await app.request('/dev-1/network')
    expect(((await res.json()) as { failClosed: boolean }).failClosed).toBe(true)
  })
})

describe('device not found', () => {
  test('404s for guest-agent and network routes alike', async () => {
    const { app } = makeHarness({})
    const r1 = await app.request('/ghost/guest-agent')
    const r2 = await app.request('/ghost/network')
    expect(r1.status).toBe(404)
    expect(r2.status).toBe(404)
  })
})

/**
 * The pairing token, end to end.
 *
 * `launcher.bootstrap()` runs `am start … --es token <t>` and returns before the token has reached
 * `ControlService`; the agent keeps answering with whatever token it already had until it does.
 * Measured on hardware: ~500 ms of `E_UNAUTHORISED` ("bad or missing token") after every bootstrap
 * of a device whose agent process survived the previous session, and PERMANENT `E_UNAUTHORISED`
 * once a second session has bootstrapped with a token of its own (8/8 attempts refused on a moto
 * g06, until the first session re-pushed its own token — then accepted immediately).
 *
 * Two devices in the reference farm (`ZP2222T7K5`, `R9RL608MQTT`) sat at a standing
 * `failed: bad or missing token` because of exactly that, and nothing ever re-pushed.
 */
describe('device session pairing (token handover is asynchronous, and the agent is not idle)', () => {
  /** A fake phone: one token in memory, replaced by every `bootstrap()`, exactly like `Pairing`. */
  function fakePhone(opts: { stompRounds: number }) {
    let deviceToken: string | null = null
    let stompsLeft = opts.stompRounds
    const bootstrapped: string[] = []
    const { launcher } = fakeLauncher({
      bootstrap: async (token: string) => {
        bootstrapped.push(token)
        deviceToken = token
        // Another session pairing the same device in the same window — the exact race
        // `daemon.ts`'s concurrent `onDeviceReady` hooks used to produce.
        if (stompsLeft > 0) {
          stompsLeft--
          deviceToken = 'a-token-this-core-never-issued'
        }
      },
    })
    const makeClient = (o: GuestAgentClientOptions): GuestAgentClient =>
      fakeClient({
        hello: async (): Promise<HelloResult> => {
          if (o.token !== deviceToken) throw new GuestAgentClientError('E_UNAUTHORISED', 'bad or missing token')
          return { protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route'] }
        },
      })
    return { launcher, makeClient, bootstrapped }
  }

  test('a token stomped once is recovered by re-pushing it — the pass succeeds instead of failing', async () => {
    const phone = fakePhone({ stompRounds: 1 })
    const { db, withGuestAgentClient } = makeHarness({ launcher: phone.launcher, makeClient: phone.makeClient })
    seedDevice(db)
    const hello = await withGuestAgentClient('dev-1', (client) => client.hello())
    expect(hello.appVersion).toBe('1.0.0')
    // Two pushes of the SAME token — never a new one, and never a token read off the device.
    expect(phone.bootstrapped).toHaveLength(2)
    expect(phone.bootstrapped[0]).toBe(phone.bootstrapped[1]!)
  })

  test('a token stomped on every round fails with a reason that names the mechanism, not just "bad or missing token"', async () => {
    const phone = fakePhone({ stompRounds: 99 })
    const { db, withGuestAgentClient } = makeHarness({ launcher: phone.launcher, makeClient: phone.makeClient })
    seedDevice(db)
    const err = await withGuestAgentClient('dev-1', (client) => client.hello()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GuestAgentClientError)
    const message = (err as Error).message
    expect(message).toContain('rejected this core\'s pairing token')
    expect(message).toContain('BootstrapActivity')
    expect(message).toContain('bad or missing token')
    // Bounded — three pushes, never a loop.
    expect(phone.bootstrapped).toHaveLength(3)
  })

  test('concurrent callers share ONE ephemeral session, so they cannot invalidate each other\'s token', async () => {
    const phone = fakePhone({ stompRounds: 0 })
    const { db, withGuestAgentClient, ports } = makeHarness({ launcher: phone.launcher, makeClient: phone.makeClient })
    seedDevice(db)
    // The shape `daemon.ts`'s `onDeviceReady` fires: several `void`-ed calls, no `await` between.
    const results = await Promise.all([
      withGuestAgentClient('dev-1', (c) => c.hello()),
      withGuestAgentClient('dev-1', (c) => c.labelStatus()),
      withGuestAgentClient('dev-1', (c) => c.textStatus()),
    ])
    expect(results).toHaveLength(3)
    // One bootstrap, one token, for all three.
    expect(phone.bootstrapped).toHaveLength(1)
    // And the port is still released once the LAST caller is out — a device with no applied
    // route must hold nothing between calls.
    expect(ports.inUse.size).toBe(0)
  })

  test('sequential callers still get a fresh session each — nothing is held between calls', async () => {
    const phone = fakePhone({ stompRounds: 0 })
    const { db, withGuestAgentClient, ports } = makeHarness({ launcher: phone.launcher, makeClient: phone.makeClient })
    seedDevice(db)
    await withGuestAgentClient('dev-1', (c) => c.hello())
    expect(ports.inUse.size).toBe(0)
    await withGuestAgentClient('dev-1', (c) => c.hello())
    expect(phone.bootstrapped).toHaveLength(2)
    expect(ports.inUse.size).toBe(0)
  })
})
