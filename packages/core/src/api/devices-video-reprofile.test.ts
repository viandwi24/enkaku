import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegistryResponse } from '@enkaku/protocol'
import type { SessionManager, DeviceSession } from '@enkaku/session'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceLifecycle } from '../device/lifecycle'
import type { ActivityRegistry } from '../activity/registry'
import { createJobStore } from '../queue/job-store'
import { createLogger } from '../util/logger'
import { createDeviceRoutes } from './devices'

/**
 * `PATCH /api/devices/:id` restarting a device's OPEN session when
 * `changedKeys` includes `video` (plan 92 §3.5, §4.4, §5 step 92.2) — the
 * "saved but never read" fix for a PER-DEVICE video override: F18 recorded
 * that `FarmSettings.defaults` only ever reaches a device at admission, and
 * a `DeviceSettings.video` override written through this exact route is the
 * same class of bug if nothing re-reads it on an already-open session.
 *
 * Kept in its OWN file rather than folded into `devices.test.ts`'s much
 * larger `PATCH /:id` coverage — this step owns `devices.ts` but not that
 * whole test file, and this is a self-contained slice.
 */

/**
 * A registry covering exactly `DeviceSettingsSchema.engines`'s own DEFAULTS
 * (`adb-usb`/`scrcpy`/`scrcpy-uhid`/`ui-server`) — every test PATCHes only
 * `video`, so the schema fills in the engine defaults, and `validateEngineSelection`
 * needs to find each one in the registry or it 400s before this route even
 * looks at `changedKeys`.
 */
function engineRegistry(): RegistryResponse {
  const engine = (id: string, kind: 'transport' | 'display' | 'input' | 'inspector' | 'network') => ({
    id,
    displayName: id,
    kind,
    capabilities: [],
    locks: [],
    requires: [],
    configSchema: {},
    available: true,
  })
  return {
    transports: [engine('adb-usb', 'transport')],
    displays: [engine('scrcpy', 'display')],
    inputs: [engine('scrcpy-uhid', 'input')],
    inspectors: [engine('ui-server', 'inspector')],
    networks: [engine('none', 'network')],
    tools: [],
  }
}

function fakeActivities(): Pick<ActivityRegistry, 'list' | 'endWhere'> {
  return { list: () => [], endWhere: () => 0 }
}

function seedDevice(db: Db, id: string): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: 'Test Phone', status: 'online' })
    .run()
}

function withAdmin(inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u@test', role: 'admin' })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

/** A stub `Pick<SessionManager, 'closeDevice' | 'restartAt' | 'get'>` — `openSession` (or `null`) is what `get(id)` returns for the ONE device this test cares about; every `restartAt` call is recorded. */
function fakeSessionsWithOpenSession(
  deviceId: string,
  openSession: Pick<DeviceSession, 'quality'> | null,
): Pick<SessionManager, 'closeDevice' | 'restartAt' | 'get'> & { restarted: Array<{ deviceId: string; quality: string; detail?: string }> } {
  const restarted: Array<{ deviceId: string; quality: string; detail?: string }> = []
  return {
    restarted,
    closeDevice: async () => {},
    get: (id) => (id === deviceId ? (openSession as DeviceSession) : null),
    restartAt: async (id, quality, detail) => {
      restarted.push({ deviceId: id, quality, ...(detail ? { detail } : {}) })
    },
  }
}

function makeApp(opts: { sessions?: ReturnType<typeof fakeSessionsWithOpenSession>; runningJobDeviceIds?: Set<string> } = {}) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const audit = createAuditLogger(db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-video-reprofile-test-'))
  const activities = fakeActivities()
  const controlSettings = () => ({ overControl: 'allow' as const, idleSec: 30 })
  const lifecycle = createDeviceLifecycle({ db, activities, controlSettings, log: createLogger('test') })
  const app = withAdmin(
    createDeviceRoutes({
      db,
      registry: async () => engineRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      activitiesOf: () => ({ activities: [], lastControl: null }),
      activities,
      runningJobOf: (deviceId) => opts.runningJobDeviceIds?.has(deviceId) ?? false,
      broadcast: () => {},
      jobStore: createJobStore(db),
      ...(opts.sessions ? { connection: { reconnector: () => null, sessions: () => opts.sessions! } } : {}),
    }),
  )
  return { db, app }
}

const patchReq = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('PATCH /api/devices/:id restarts an OPEN session when changedKeys includes "video" (plan 92 §3.8, §4.4, §5 step 92.2)', () => {
  test('a per-device video override PATCH restarts the device\'s open session at its OWN current quality, with the "applying new video settings" detail', async () => {
    const sessions = fakeSessionsWithOpenSession('a', { quality: 'wall' })
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { video: { wallMaxFps: 3 } } }))
    expect(res.status).toBe(200)

    expect(sessions.restarted).toEqual([{ deviceId: 'a', quality: 'wall', detail: 'applying new video settings' }])
  })

  test('a device running a job (a live job activity) is NEVER restarted — spec §10.1, the blast-radius bound', async () => {
    const sessions = fakeSessionsWithOpenSession('a', { quality: 'control' })
    const { db, app } = makeApp({ sessions, runningJobDeviceIds: new Set(['a']) })
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { video: { controlMaxFps: 15 } } }))
    expect(res.status).toBe(200) // the PATCH itself still succeeds — only the restart is refused

    expect(sessions.restarted).toEqual([])
  })

  test('a PATCH that changes an UNRELATED settings field never restarts anything', async () => {
    const sessions = fakeSessionsWithOpenSession('a', { quality: 'control' })
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { prep: { keepAwake: 'always' } } }))
    expect(res.status).toBe(200)

    expect(sessions.restarted).toEqual([])
  })

  test('a video PATCH against a device with NO open session is a harmless no-op — nothing to restart', async () => {
    const sessions = fakeSessionsWithOpenSession('a', null)
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { video: { wallMaxFps: 3 } } }))
    expect(res.status).toBe(200)

    expect(sessions.restarted).toEqual([])
  })

  test('with no connection.sessions accessor wired at all (orchestrator mode), the PATCH still succeeds — the restart is a courtesy, never a requirement of saving the setting', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { video: { wallMaxFps: 3 } } }))
    expect(res.status).toBe(200)
  })
})
