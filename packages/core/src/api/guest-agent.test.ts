import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { GuestAgentClient, GuestAgentClientOptions, GuestAgentLauncher } from '@enkaku/drivers'
import { GuestAgentClientError } from '@enkaku/drivers'
import type { HelloResult, PingResult, RouteStartResult, RouteStatusResult, RouteStopResult } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { LeaseManager } from '../lease/lease-manager'
import { createLogger } from '../util/logger'
import { createGuestAgentRoutes, resolveGuestAgentApkPath, type GuestAgentRoutesDeps } from './guest-agent'

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
      status: 'idle',
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
    },
    ensurePreGranted: async () => {
      calls.push('ensurePreGranted')
    },
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
    ...overrides,
  }
}

function fakeLeases(held = true): LeaseManager {
  return {
    getLease: () => (held ? { deviceId: 'dev-1', type: 'manual', holder: 'client-a', acquiredAt: 0, expiresAt: 0 } : null),
    checkInputAllowed: (_deviceId: string, clientId: string) =>
      held && clientId === 'client-a' ? { ok: true } : { ok: false, code: 'no_lease', message: 'take control first' },
  } as unknown as LeaseManager
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

interface Harness {
  db: Db
  app: Hono<AuthEnv>
  events: Array<{ deviceId: string; stream: string; kind: string; actor?: string | null; meta?: Record<string, unknown> }>
  ports: ReturnType<typeof fakePorts>
  /** Awaited explicitly by boot-reconciliation tests instead of racing the fire-and-forget call `createGuestAgentRoutes` makes at construction. */
  reconcileNetworkRoutes: () => Promise<void>
}

function makeHarness(opts: {
  role?: 'admin' | 'operator' | null
  leaseHeld?: boolean
  launcher?: GuestAgentLauncher
  client?: GuestAgentClient
  makeClient?: (opts: GuestAgentClientOptions) => GuestAgentClient
}): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const events: Harness['events'] = []
  const ports = fakePorts()

  const deps: GuestAgentRoutesDeps = {
    db,
    hostAdb: async () => '',
    exec: async () => '',
    apkPath: async () => '/fake/guest-agent.apk',
    ports,
    leases: fakeLeases(opts.leaseHeld ?? true),
    record: (e) => events.push(e),
    log: createLogger('test'),
    // These drive fakes; sitting out the real multi-second settle/poll budgets would only make the
    // suite slow and flaky.
    routeTimings: { applySettleTimeoutMs: 0, revertPollTimeoutMs: 0 },
    ...(opts.launcher ? { makeLauncher: () => opts.launcher! } : {}),
    makeClient: opts.makeClient ?? (() => opts.client ?? fakeClient()),
  }
  const { routes, reconcileNetworkRoutes } = createGuestAgentRoutes(deps)
  const app = withUser(opts.role === undefined ? 'admin' : opts.role, routes)
  return { db, app, events, ports, reconcileNetworkRoutes }
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

  test('refuses without a held lease, even for an admin', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher, leaseHeld: false })
    seedDevice(db)
    const res = await app.request('/dev-1/guest-agent', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('no_lease')
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
        toolchain: { resolveToolPath: async () => 'SHOULD-NOT-REACH-TIER-3' },
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
      drift: boolean
      lastError: unknown
    }
    expect(body).toEqual({ engine: 'none', config: null, enabled: false, observed: null, drift: false, health: 'unknown', lastError: null })
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
      config: { host: string; port: number; username?: string; udpMode: string }
    }
    expect(body.engine).toBe('vpn-helper')
    expect(body.health).toBe('unverified')
    expect(body.enabled).toBe(true)
    expect(body.config).toEqual({ host: 'proxy.example', port: 1080, username: 'u', udpMode: 'udp' })

    const applied = events.find((e) => e.kind === 'network.applied')
    expect(applied).toBeTruthy()
    expect(JSON.stringify(applied?.meta)).not.toContain('hunter2')

    // Persisted straight into the DB row, not just held in memory — the
    // whole point of step 5.4. The password IS in the raw column (it must
    // survive a restart), but it must never leave the process un-redacted.
    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect(JSON.stringify(row?.networkRoute)).toContain('hunter2')
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

  test('PUT refuses without a held lease', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher, leaseHeld: false })
    seedDevice(db)
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
      config: { host: string; port: number; username?: string; udpMode: string } | null
    }
    expect(body.enabled).toBe(false)
    expect(body.config).toEqual({ host: 'proxy.example', port: 1080, username: 'u', udpMode: 'udp' })
    expect(ports.inUse.size).toBe(0)

    // The config, password included, is still on the row — only `enabled` flipped.
    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect(row?.networkRoute).toEqual({
      config: { host: 'proxy.example', port: 1080, username: 'u', password: 'hunter2', udpMode: 'udp' },
      enabled: false,
    })
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
    const body = JSON.parse(text) as { enabled: boolean; config: { host: string; port: number; udpMode: string } }
    expect(body.enabled).toBe(true)
    expect(body.config).toEqual({ host: 'proxy.example', port: 1080, udpMode: 'udp' })
  })

  test('enable/disable refuse without a held lease', async () => {
    const { launcher } = fakeLauncher()
    const { db, app } = makeHarness({ launcher, leaseHeld: false })
    seedDevice(db)
    const res1 = await app.request('/dev-1/network/enable', { method: 'POST' })
    expect(res1.status).toBe(409)
    const res2 = await app.request('/dev-1/network/disable', { method: 'POST' })
    expect(res2.status).toBe(409)
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

describe('device not found', () => {
  test('404s for guest-agent and network routes alike', async () => {
    const { app } = makeHarness({})
    const r1 = await app.request('/ghost/guest-agent')
    const r2 = await app.request('/ghost/network')
    expect(r1.status).toBe(404)
    expect(r2.status).toBe(404)
  })
})
