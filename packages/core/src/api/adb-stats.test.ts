import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { AdbClient } from '@enkaku/adb'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createAdbMetricsStore } from '../device/adb-metrics'
import { allocateDeviceNumber } from '../registry/device-number'
import type { AuthEnv } from '../auth/middleware'
import { createAdbStatsRoutes } from './adb-stats'

function seedDevice(db: Db, id: string, serial: string): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial, label: `Phone ${id}`, status: 'idle' }).run()
}

/** Mirrors `authMiddleware` well enough for a route test: sets `c.get('user')` before dispatch. */
function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function fakeAdbClient(): AdbClient {
  return {
    stats: () => ({ maxConcurrent: 8, inFlight: 2, waiting: 1 }),
    pending: (serial: string) => (serial === 'SER1' ? 3 : 0),
    streamStats: () => ({ maxStreams: 4, maxStreamsPerDevice: 1, streams: 1, pinned: 2, perDevice: { SER1: 1 } }),
  } as unknown as AdbClient
}

describe('GET /api/adb/stats (plan 23 §4.6, §6.8)', () => {
  test('reports the global semaphore state and per-device queue depth, latency, counts, and failure streak', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'd1', 'SER1')
    seedDevice(db, 'd2', 'SER2')

    const metrics = createAdbMetricsStore()
    metrics.record({ serial: 'SER1', profile: 'probe', ms: 10, outcome: 'ok' })
    metrics.record({ serial: 'SER1', profile: 'probe', ms: 20, outcome: 'ok' })
    metrics.record({ serial: 'SER1', profile: 'probe', ms: 5000, outcome: 'timeout', code: 'E_ADB_TIMEOUT' })

    const inner = createAdbStatsRoutes({
      db,
      client: () => fakeAdbClient(),
      metrics,
      health: () => ({ note: () => {}, consecutiveFailures: (id: string) => (id === 'd1' ? 2 : 0), start: () => {}, stop: () => {} }),
      auto: () => true,
      sessions: () => null,
    })
    const app = withUser('operator', inner)

    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      global: { maxConcurrent: number; auto: boolean; inFlight: number; waiting: number }
      devices: Array<{
        deviceId: string
        queueDepth: number
        counts: { ok: number; timeout: number; busy: number; error: number }
        consecutiveFailures: number
      }>
    }
    expect(body.global).toEqual({ maxConcurrent: 8, auto: true, inFlight: 2, waiting: 1 })
    const d1 = body.devices.find((d) => d.deviceId === 'd1')
    expect(d1?.queueDepth).toBe(3)
    expect(d1?.counts).toEqual({ ok: 2, timeout: 1, busy: 0, error: 0 })
    expect(d1?.consecutiveFailures).toBe(2)
    const d2 = body.devices.find((d) => d.deviceId === 'd2')
    expect(d2?.queueDepth).toBe(0)
    expect(d2?.consecutiveFailures).toBe(0)
  })

  test('the streams block carries pinned, separately from the counted active figure (plan 208 §3.6, §4.9)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'd1', 'SER1')

    const inner = createAdbStatsRoutes({
      db,
      client: () => fakeAdbClient(),
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
    })
    const app = withUser('operator', inner)

    const res = await app.request('/')
    const body = (await res.json()) as {
      streams: { maxStreams: number; maxStreamsPerDevice: number; active: number; pinned: number; perDevice: Record<string, number> }
    }
    expect(body.streams).toEqual({ maxStreams: 4, maxStreamsPerDevice: 1, active: 1, pinned: 2, perDevice: { SER1: 1 } })
  })

  /**
   * Plan 124 §3.7 — one of the five payloads that named a device and carried
   * no number. This one is a diagnostics table: "3 commands queued" is
   * useless on a rack of phones all labelled `SM-F721U1` unless the row says
   * WHICH phone. The label is composed server-side here (unlike `DeviceRef`,
   * which ships the number as its own field) because every consumer renders
   * it as one opaque string and none of them holds a `DeviceInfo` to compose
   * against — see the schema's own note in `packages/protocol/src/api/adb.ts`.
   */
  test('each device row is named with its number, and an unnumbered device keeps its bare label (plan 124 §3.7)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'd1', 'SER1')
    seedDevice(db, 'd2', 'SER2')
    allocateDeviceNumber(db, 'stable-d1')

    const inner = createAdbStatsRoutes({
      db,
      client: () => fakeAdbClient(),
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    const body = (await res.json()) as { devices: Array<{ deviceId: string; label: string }> }
    expect(body.devices.find((d) => d.deviceId === 'd1')?.label).toBe('#1 Phone d1')
    // No reservation → the bare label. Never `#null`, never a stray `#`.
    expect(body.devices.find((d) => d.deviceId === 'd2')?.label).toBe('Phone d2')
  })

  test('returns zeroed global figures when adb is not up yet (orchestrator mode, or still provisioning)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const inner = createAdbStatsRoutes({
      db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { global: { maxConcurrent: number } }
    expect(body.global.maxConcurrent).toBe(0)
  })

  test('adbHealth is zero-filled (status ok, never checked) when the monitor dep is absent (plan 88 §3.9, §4.7)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const inner = createAdbStatsRoutes({
      db: opened.db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    const body = (await res.json()) as { adbHealth: unknown }
    expect(body.adbHealth).toEqual({
      status: 'ok',
      versionRttMs: null,
      lastCheckedAt: 0,
      window: { seconds: 0, execs: 0, timeouts: 0, timeoutRate: 0 },
      wedged: [],
      stuckOffline: [],
      symptoms: [],
      restartAdvised: false,
    })
  })

  test('adbHealth reports the live monitor verdict verbatim when the dep is supplied', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const verdict = {
      status: 'stuck' as const,
      versionRttMs: null,
      lastCheckedAt: 12_345,
      window: { seconds: 600, execs: 40, timeouts: 25, timeoutRate: 0.625 },
      wedged: [],
      stuckOffline: [],
      symptoms: [{ symptom: 'server-unresponsive' as const, detail: 'host:version has not answered', since: 12_000 }],
      restartAdvised: true,
    }
    const inner = createAdbStatsRoutes({
      db: opened.db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
      adbHealth: () => verdict,
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    const body = (await res.json()) as { adbHealth: typeof verdict }
    expect(body.adbHealth).toEqual(verdict)
  })

  test('input is zero-filled (no active lanes/grants/groups) when the dep is absent (plan 91 §4.10, §5 step 91.10)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const inner = createAdbStatsRoutes({
      db: opened.db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    const body = (await res.json()) as { input: unknown }
    expect(body.input).toEqual({
      lanes: {
        pointer: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
        keys: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
        text: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
      },
    })
  })

  test('input reports the live ws-handlers.ts inputStats() verbatim when the dep is supplied (plan 91 §4.10, §5 step 91.10)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const live = {
      lanes: {
        pointer: { depth: 2, waitMsP50: 30, waitMsP95: 120, refusals: 1 },
        keys: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
        text: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
      },
    }
    const inner = createAdbStatsRoutes({
      db: opened.db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
      input: () => live,
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    const body = (await res.json()) as { input: typeof live }
    expect(body.input).toEqual(live)
  })

  test('video is zero-filled when sessions() is null (plan 206 §4.10)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const inner = createAdbStatsRoutes({
      db: opened.db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    const body = (await res.json()) as { video: unknown }
    expect(body.video).toEqual({
      controlStreams: 0,
      wallStreams: 0,
      buildsRunning: 0,
      buildQueueDepth: 0,
      buildsPerUsbRoot: 0,
      farmCeiling: 0,
      maxTiles: 0,
      maxTilesAuto: false,
      transport: 'loopback',
    })
  })

  test('video reports the live SessionManager.encoders() combined with the always-on builder stats and the video settings dep (plan 206 §4.10)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const fakeSessions = {
      encoders: () => [
        { deviceId: 'd1', wall: { engine: 'scrcpy' }, control: { engine: 'scrcpy' } },
        { deviceId: 'd2', wall: { engine: 'scrcpy' }, control: null },
        { deviceId: 'd3', wall: null, control: null },
      ],
      forwards: () => [],
    } as unknown as import('@enkaku/session').SessionManager
    const inner = createAdbStatsRoutes({
      db: opened.db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => fakeSessions,
      alwaysOn: () => ({ running: 1, queued: 3 }),
      video: () => ({ buildsPerUsbRoot: 4, farmCeiling: 16, maxTiles: 25, maxTilesAuto: true, transport: 'loopback' }),
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    const body = (await res.json()) as { video: unknown }
    expect(body.video).toEqual({
      controlStreams: 1,
      wallStreams: 2,
      buildsRunning: 1,
      buildQueueDepth: 3,
      buildsPerUsbRoot: 4,
      farmCeiling: 16,
      maxTiles: 25,
      maxTilesAuto: true,
      transport: 'loopback',
    })
  })

  test('GET / reports forwards and installsByRoot when the underlying accessors are wired, and omits/zero-fills them when absent (plan 223 §4.6)', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const forwardRow = { deviceId: 'd1', quality: 'wall' as const, port: 27500, scid: '7f00aabb', openedAt: 12345 }
    const fakeSessions = {
      encoders: () => [],
      forwards: () => [forwardRow],
    } as unknown as import('@enkaku/session').SessionManager
    const inner = createAdbStatsRoutes({
      db: opened.db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => fakeSessions,
      hostAdb: () => ({ running: 0, maxConcurrent: 2, installsRunning: 1, longLived: 0, installsByRoot: { 'usb-1': { running: 1, queued: 0 } } }),
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    const body = (await res.json()) as { forwards: unknown; hostAdb: { installsByRoot: unknown } }
    expect(body.forwards).toEqual([forwardRow])
    expect(body.hostAdb.installsByRoot).toEqual({ 'usb-1': { running: 1, queued: 0 } })

    const innerAbsent = createAdbStatsRoutes({
      db: opened.db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
    })
    const appAbsent = withUser('operator', innerAbsent)
    const resAbsent = await appAbsent.request('/')
    const bodyAbsent = (await resAbsent.json()) as { forwards: unknown; hostAdb: { installsByRoot: unknown } }
    expect(bodyAbsent.forwards).toBeUndefined()
    expect(bodyAbsent.hostAdb.installsByRoot).toBeUndefined()
  })

  test('requires device.view — an unauthenticated request is rejected with 403', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const inner = createAdbStatsRoutes({
      db: opened.db,
      client: () => null,
      metrics: createAdbMetricsStore(),
      health: () => null,
      auto: () => true,
      sessions: () => null,
    })
    const app = withUser(null, inner)
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })
})
