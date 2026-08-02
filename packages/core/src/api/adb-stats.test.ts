import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { AdbClient } from '@enkaku/adb'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createAdbMetricsStore } from '../device/adb-metrics'
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
    streamStats: () => ({ maxStreams: 4, maxStreamsPerDevice: 1, streams: 1, perDevice: { SER1: 1 } }),
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
    })
    const app = withUser('operator', inner)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { global: { maxConcurrent: number } }
    expect(body.global.maxConcurrent).toBe(0)
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
    })
    const app = withUser(null, inner)
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })
})
