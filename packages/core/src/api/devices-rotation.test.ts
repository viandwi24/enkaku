import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegistryResponse, RotationApplyResult, RotationMode } from '@enkaku/protocol'
import type { RotationOutcome, SessionManager } from '@enkaku/session'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceLifecycle } from '../device/lifecycle'
import type { LeaseManager } from '../lease/lease-manager'
import { createJobStore } from '../queue/job-store'
import { createLogger } from '../util/logger'
import { createDeviceRoutes } from './devices'

/**
 * `PATCH /api/devices/:id` applying `settings.prep.rotation` to the session a
 * device is running RIGHT NOW (plan 85 §3.7).
 *
 * The defect this covers is the one a farm owner reported: the rotation lock
 * was built, wired, and apply-once. It reached a device only inside
 * `createSession`, so an operator watching a wall tile could pick "Lock
 * portrait", get a success toast, and watch the phone stay in landscape — the
 * toast was reporting a database write. On a wall that stays up all day there
 * is no next cold start to wait for.
 *
 * The sibling file `devices-video-reprofile.test.ts` covers the same class of
 * bug for `settings.video`, which is where this route's precedent comes from.
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

function fakeLeases(): LeaseManager {
  return {
    acquireManual: (): never => {
      throw new Error('not used in this test')
    },
    touchManual: () => {},
    releaseManual: () => false,
    releaseAllForClient: () => {},
    noteJobLease: () => {},
    clearJobLease: () => {},
    getLease: () => null,
    getHolder: () => null,
    lastManualReleaseAt: () => null,
    lastManualHolder: () => null,
    checkInputAllowed: () => ({ ok: true }),
    startReaper: () => {},
    stopReaper: () => {},
  } as unknown as LeaseManager
}

function seedDevice(db: Db, id: string, status: 'idle' | 'busy' = 'idle'): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: 'Test Phone', status })
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

type SessionsStub = Pick<SessionManager, 'closeDevice' | 'restartAt' | 'get' | 'setRotation'> & {
  applied: Array<{ deviceId: string; mode: RotationMode }>
}

/** `outcome` is what the (fake) live session reports back — `null` stands for "no session is open on this device". */
function fakeSessions(outcome: RotationOutcome | null): SessionsStub {
  const applied: Array<{ deviceId: string; mode: RotationMode }> = []
  return {
    applied,
    closeDevice: async () => {},
    get: () => null,
    restartAt: async () => {},
    setRotation: async (deviceId, mode) => {
      applied.push({ deviceId, mode })
      return outcome
    },
  }
}

function makeApp(opts: { sessions?: SessionsStub } = {}) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const audit = createAuditLogger(db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-rotation-test-'))
  const leases = fakeLeases()
  const lifecycle = createDeviceLifecycle({ db, leases, log: createLogger('test') })
  const events: Array<{ kind: string; meta: unknown }> = []
  const app = withAdmin(
    createDeviceRoutes({
      db,
      registry: async () => engineRegistry(),
      battery: () => null,
      audit,
      dataDir,
      lifecycle,
      heldByOf: () => null,
      broadcast: () => {},
      leases,
      jobStore: createJobStore(db),
      record: (e) => {
        events.push({ kind: e.kind, meta: e.meta ?? null })
      },
      ...(opts.sessions ? { connection: { reconnector: () => null, sessions: () => opts.sessions! } } : {}),
    }),
  )
  return { db, app, events }
}

const patchReq = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const applied = (mode: RotationMode, target: string): RotationOutcome => ({ mode, target, applied: true })

/** `Response.json()` is `unknown`; this is the one shape these tests read off it. */
async function bodyOf(res: Response): Promise<{ rotation?: RotationApplyResult }> {
  return (await res.json()) as { rotation?: RotationApplyResult }
}

describe('PATCH /api/devices/:id applies prep.rotation to a LIVE session (plan 85 §3.7)', () => {
  test('changing the lock re-locks the running session and REPORTS that it took', async () => {
    const sessions = fakeSessions(applied('lock-portrait', '0'))
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { prep: { rotation: 'lock-portrait' } } }))
    expect(res.status).toBe(200)
    expect(sessions.applied).toEqual([{ deviceId: 'a', mode: 'lock-portrait' }])
    expect((await bodyOf(res)).rotation).toEqual({ mode: 'lock-portrait', state: 'applied' })
  })

  // The Zod-strip trap this repo has been bitten by three times: the core
  // emits the field, the response schema does not declare it, and the client
  // silently goes back to reporting a database write as a device change.
  test('the `rotation` field survives the response schema — it is declared, not stripped', async () => {
    const sessions = fakeSessions(applied('lock-landscape', '1'))
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a')
    const res = await app.request('/a', patchReq({ settings: { prep: { rotation: 'lock-landscape' } } }))
    expect(Object.keys(await bodyOf(res))).toContain('rotation')
  })

  test('a device the lock could not be applied to reports `failed`, with the device’s own reason — never a silent success', async () => {
    const sessions = fakeSessions({
      mode: 'lock-portrait',
      target: '0',
      applied: false,
      reason: 'user_rotation reads back "1", not "0"',
    })
    const { db, app, events } = makeApp({ sessions })
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { prep: { rotation: 'lock-portrait' } } }))
    expect((await bodyOf(res)).rotation).toEqual({
      mode: 'lock-portrait',
      state: 'failed',
      reason: 'user_rotation reads back "1", not "0"',
    })
    // And it is in the device's OWN log, not only in a core log file.
    expect(events.filter((e) => e.kind === 'device.rotation')).toEqual([
      {
        kind: 'device.rotation',
        meta: { from: 'device', to: 'lock-portrait', state: 'failed', applied: false, reason: 'user_rotation reads back "1", not "0"' },
      },
    ])
  })

  test('no open session is `no-session`, not a failure — the stored setting still applies to the next one', async () => {
    const sessions = fakeSessions(null)
    const { db, app, events } = makeApp({ sessions })
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { prep: { rotation: 'lock-portrait' } } }))
    expect((await bodyOf(res)).rotation).toEqual({ mode: 'lock-portrait', state: 'no-session' })
    // Nothing happened on the device, so nothing is written to its log.
    expect(events.filter((e) => e.kind === 'device.rotation')).toEqual([])
  })

  // Spec §10.1 — the same rule the video reprofile beside this one follows: a
  // settings save must never be the thing that rotates a screen out from
  // under a running script.
  test('a device running a job is never re-locked live; the save still succeeds and says why it waited', async () => {
    const sessions = fakeSessions(applied('lock-portrait', '0'))
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a', 'busy')

    const res = await app.request('/a', patchReq({ settings: { prep: { rotation: 'lock-portrait' } } }))
    expect(res.status).toBe(200)
    expect(sessions.applied).toEqual([])
    const body = await bodyOf(res)
    expect(body.rotation?.state).toBe('busy')
    expect(body.rotation?.reason).toContain('job is running')
  })

  // `changedKeys` is a TOP-LEVEL diff, so `prep` reads as changed whenever any
  // field in it moves. Re-locking a screen on the strength of an unrelated
  // `prep` edit would rotate a phone nobody asked to rotate.
  test('a PATCH that changes another prep field but leaves rotation alone touches no session', async () => {
    const sessions = fakeSessions(applied('lock-portrait', '0'))
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { prep: { keepAwake: 'always' } } }))
    expect(res.status).toBe(200)
    expect(sessions.applied).toEqual([])
    expect((await bodyOf(res)).rotation).toBeUndefined()
  })

  test('switching back to "device" hands rotation to the phone through the same path', async () => {
    const sessions = fakeSessions({ mode: 'device', target: null, applied: true })
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a')
    db.update(devices)
      .set({ settings: { prep: { rotation: 'lock-portrait' } } })
      .run()

    const res = await app.request('/a', patchReq({ settings: { prep: { rotation: 'device' } } }))
    expect(res.status).toBe(200)
    expect(sessions.applied).toEqual([{ deviceId: 'a', mode: 'device' }])
  })

  test('with no connection.sessions accessor wired at all (orchestrator mode), the PATCH still saves the setting', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')

    const res = await app.request('/a', patchReq({ settings: { prep: { rotation: 'lock-portrait' } } }))
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).rotation).toEqual({ mode: 'lock-portrait', state: 'no-session' })
  })
})
