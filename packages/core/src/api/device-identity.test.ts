import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { GuestAgentClient } from '@enkaku/drivers'
import type { HelloResult, LocationClearResult, LocationSetResult } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import { createLogger } from '../util/logger'
import { createDeviceIdentityRoutes, type DeviceIdentityRoutesDeps } from './device-identity'

/** Mirrors `authMiddleware` well enough for a route test — same pattern `guest-agent.test.ts` uses. */
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

function fakeLeases(held = true) {
  return {
    getLease: () => (held ? { deviceId: 'dev-1', type: 'manual' as const, holder: 'client-a', acquiredAt: 0, expiresAt: 0 } : null),
    checkInputAllowed: (_deviceId: string, clientId: string) =>
      held && clientId === 'client-a' ? { ok: true as const } : { ok: false as const, code: 'no_lease', message: 'take control first' },
  } as unknown as DeviceIdentityRoutesDeps['leases']
}

interface Harness {
  db: Db
  app: Hono<AuthEnv>
  execCalls: string[]
  clientCalls: string[]
}

function makeHarness(opts: {
  role?: 'admin' | 'operator' | null
  leaseHeld?: boolean
  /** Capabilities the fake guest agent advertises via `hello()`. Omit `'mock-location'` to simulate an older build. */
  capabilities?: string[]
  /** When set, every guest-agent call rejects with this — simulates an unreachable device. */
  guestAgentUnreachable?: Error
}): Harness {
  const { db } = openDb(':memory:')
  runMigrations(db)
  const execCalls: string[] = []
  const clientCalls: string[] = []

  const client: GuestAgentClient = {
    hello: async (): Promise<HelloResult> => ({
      protocol: 1,
      appVersion: '1.0.0',
      androidSdkInt: 35,
      capabilities: (opts.capabilities ?? ['socks5-route', 'vpn-status', 'mock-location']) as HelloResult['capabilities'],
    }),
    ping: async () => ({ pong: true }),
    routeStart: async () => ({ started: true }),
    routeStop: async () => ({ stopped: true }),
    routeStatus: async () => ({ prepared: true, up: true }),
    egressProbe: async () => ({ tunnelled: { ok: true, ms: 1 }, direct: { ok: true, ms: 1 } }),
    routeHold: async () => ({ held: true }),
    locationSet: async (lat, lng, accuracy): Promise<LocationSetResult> => {
      clientCalls.push(`locationSet:${lat},${lng},${accuracy}`)
      return { set: true }
    },
    locationClear: async (): Promise<LocationClearResult> => {
      clientCalls.push('locationClear')
      return { cleared: true }
    },
    // Not exercised by this file's tests (identity/GPS only) — stubs to satisfy the widened
    // `GuestAgentClient` interface (plan 90 §4.1, §3.9's `screen-label`/`text-input` capabilities).
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
  }

  const deps: DeviceIdentityRoutesDeps = {
    db,
    exec: async (serial, cmd) => {
      execCalls.push(`${serial}: ${cmd}`)
      return { stdout: '', stderr: '', exitCode: 0 }
    },
    leases: fakeLeases(opts.leaseHeld ?? true),
    record: () => {},
    log: createLogger('test'),
    withGuestAgentClient: async (_deviceId, fn) => {
      if (opts.guestAgentUnreachable) throw opts.guestAgentUnreachable
      return fn(client)
    },
  }

  const routes = createDeviceIdentityRoutes(deps)
  const app = withUser(opts.role === undefined ? 'admin' : opts.role, routes)
  return { db, app, execCalls, clientCalls }
}

describe('GET /api/devices/:id/identity (plan 58 §5.3)', () => {
  test('a device with no identity settings reads back an empty object, not null or a throw', async () => {
    const { db, app } = makeHarness({})
    seedDevice(db)
    const res = await app.request('/dev-1/identity')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ identity: {} })
  })

  test('device.settings permission is required', async () => {
    const { db, app } = makeHarness({ role: null })
    seedDevice(db)
    const res = await app.request('/dev-1/identity')
    expect(res.status).toBe(403)
  })
})

describe('PUT /api/devices/:id/identity — timezone and locale (plan 58 §4, §5.3)', () => {
  test('applies timezone and locale via setprop, and persists them', async () => {
    const { db, app, execCalls } = makeHarness({})
    seedDevice(db)
    const res = await app.request('/dev-1/identity', {
      method: 'PUT',
      body: JSON.stringify({ timezone: 'America/New_York', locale: 'en-US' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { identity: unknown; result: { timezone?: string; locale?: string } }
    expect(body.result.timezone).toBe('applied')
    expect(body.result.locale).toBe('applied')
    expect(execCalls).toContain(`serial-dev-1: setprop persist.sys.timezone 'America/New_York'`)
    expect(execCalls).toContain(`serial-dev-1: setprop persist.sys.locale 'en-US'`)

    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect((row?.settings as { identity?: { timezone?: string; locale?: string } } | null)?.identity).toEqual({
      timezone: 'America/New_York',
      locale: 'en-US',
    })
  })

  test('a manual lease must be held', async () => {
    const { db, app } = makeHarness({ leaseHeld: false })
    seedDevice(db)
    const res = await app.request('/dev-1/identity', {
      method: 'PUT',
      body: JSON.stringify({ timezone: 'America/New_York' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(409)
  })

  test('an out-of-range latitude is rejected before anything is applied', async () => {
    const { db, app, execCalls } = makeHarness({})
    seedDevice(db)
    const res = await app.request('/dev-1/identity', {
      method: 'PUT',
      body: JSON.stringify({ gps: { lat: 999, lng: 0 } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(400)
    expect(execCalls).toEqual([])
  })
})

describe('PUT /api/devices/:id/identity — GPS is honest about the guest agent (plan 58 §4.4, §5.4)', () => {
  test('an agent build advertising mock-location gets the appop granted and the fix installed', async () => {
    const { db, app, execCalls, clientCalls } = makeHarness({ capabilities: ['mock-location'] })
    seedDevice(db)
    const res = await app.request('/dev-1/identity', {
      method: 'PUT',
      body: JSON.stringify({ gps: { lat: 40.7128, lng: -74.006, accuracy: 50 } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { gps?: string } }
    expect(body.result.gps).toBe('applied')
    expect(execCalls.some((c) => c.includes('appops set') && c.includes('android:mock_location allow'))).toBe(true)
    expect(clientCalls).toContain('locationSet:40.7128,-74.006,50')
  })

  test('an agent build that does NOT advertise mock-location reports unavailable, never a spoofed success', async () => {
    const { app, db, clientCalls } = makeHarness({ capabilities: ['socks5-route', 'vpn-status'] })
    seedDevice(db)
    const res = await app.request('/dev-1/identity', {
      method: 'PUT',
      body: JSON.stringify({ gps: { lat: 1, lng: 2 } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { gps?: string; gpsDetail?: string } }
    expect(body.result.gps).toBe('unavailable')
    expect(body.result.gpsDetail).toContain('mock-location')
    expect(clientCalls).toEqual([])
  })

  test('an unreachable guest agent reports unavailable rather than throwing — timezone in the same request still applies', async () => {
    const { app, db, execCalls } = makeHarness({ guestAgentUnreachable: new Error('connection refused') })
    seedDevice(db)
    const res = await app.request('/dev-1/identity', {
      method: 'PUT',
      body: JSON.stringify({ timezone: 'Asia/Tokyo', gps: { lat: 1, lng: 2 } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { timezone?: string; gps?: string; gpsDetail?: string } }
    expect(body.result.timezone).toBe('applied')
    expect(body.result.gps).toBe('unavailable')
    expect(body.result.gpsDetail).toContain('connection refused')
    expect(execCalls.some((c) => c.includes('setprop persist.sys.timezone'))).toBe(true)
  })

  test('a declared GPS fix is persisted even when it could not be applied — the operator\'s intent survives', async () => {
    const { app, db } = makeHarness({ capabilities: [] })
    seedDevice(db)
    await app.request('/dev-1/identity', {
      method: 'PUT',
      body: JSON.stringify({ gps: { lat: 1, lng: 2, accuracy: 100 } }),
      headers: { 'content-type': 'application/json' },
    })
    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect((row?.settings as { identity?: { gps?: unknown } } | null)?.identity?.gps).toEqual({ lat: 1, lng: 2, accuracy: 100 })
  })
})

describe('DELETE /api/devices/:id/identity (plan 58 §4.3, §5.3)', () => {
  test('clears whatever was previously set, and only that', async () => {
    const { db, app, execCalls, clientCalls } = makeHarness({ capabilities: ['mock-location'] })
    seedDevice(db, { settings: { identity: { timezone: 'Asia/Jakarta', gps: { lat: 1, lng: 2, accuracy: 100 } } } })

    const res = await app.request('/dev-1/identity', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ identity: {} })

    expect(execCalls.some((c) => c.includes("setprop persist.sys.timezone ''"))).toBe(true)
    // Locale was never set, so it must never be touched.
    expect(execCalls.some((c) => c.includes('persist.sys.locale'))).toBe(false)
    expect(execCalls.some((c) => c.includes('android:mock_location ignore'))).toBe(true)
    expect(clientCalls).toContain('locationClear')

    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect((row?.settings as { identity?: unknown } | null)?.identity).toEqual({})
  })

  test('a manual lease must be held', async () => {
    const { db, app } = makeHarness({ leaseHeld: false })
    seedDevice(db)
    const res = await app.request('/dev-1/identity', { method: 'DELETE' })
    expect(res.status).toBe(409)
  })

  test('tolerates an unreachable guest agent — the stored settings are still cleared', async () => {
    const { db, app } = makeHarness({ guestAgentUnreachable: new Error('device offline') })
    seedDevice(db, { settings: { identity: { gps: { lat: 1, lng: 2, accuracy: 100 } } } })
    const res = await app.request('/dev-1/identity', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect((row?.settings as { identity?: unknown } | null)?.identity).toEqual({})
  })
})

describe('POST /api/devices/:id/identity/sync (plan 58 §3.4, §4.3, §5.3)', () => {
  test('suggests timezone/locale/gps from the most recent geo observation, and never applies anything', async () => {
    const { db, app, execCalls, clientCalls } = makeHarness({})
    seedDevice(db, {
      networkRoute: {
        config: { host: 'proxy.example', port: 1080, udpMode: 'udp', onGeoFail: 'report' },
        enabled: true,
        exitHistory: [
          { address: '1.2.3.4', country: 'US', region: 'NY', city: 'New York', asn: null, isp: null, at: 1000 },
          { address: '5.6.7.8', country: 'JP', region: null, city: 'Tokyo', asn: null, isp: null, at: 500 },
        ],
      },
    })

    const res = await app.request('/dev-1/identity/sync', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { suggestion: { timezone?: string; locale?: string; gps?: { lat: number; lng: number } }; country: string; city: string }
    expect(body.country).toBe('US')
    expect(body.city).toBe('New York')
    expect(body.suggestion.timezone).toBe('America/New_York')
    expect(body.suggestion.locale).toBe('en-US')
    expect(body.suggestion.gps?.lat).toBeCloseTo(40.7128)
    // Purely a suggestion — nothing on the device or in storage changes.
    expect(execCalls).toEqual([])
    expect(clientCalls).toEqual([])
    const row = db.select().from(devices).where(eq(devices.id, 'dev-1')).get()
    expect((row?.settings as { identity?: unknown } | null)?.identity ?? {}).toEqual({})
  })

  test('a device with no geo observation yet answers E_NO_GEO_OBSERVATION, not a guess', async () => {
    const { db, app } = makeHarness({})
    seedDevice(db)
    const res = await app.request('/dev-1/identity/sync', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NO_GEO_OBSERVATION')
  })
})
