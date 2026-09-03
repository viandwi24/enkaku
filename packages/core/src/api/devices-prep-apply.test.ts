import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceSettingsSchema, DevicePrepApplyResponseSchema, type RegistryResponse, type RotationMode } from '@enkaku/protocol'
import type { RotationOutcome, SessionManager } from '@enkaku/session'
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
 * `POST /api/devices/prep/apply` — one prep setting across a selection.
 *
 * The two properties worth a test suite of their own, because both are silent
 * when they break:
 *
 * 1. **Only the chosen keys are written.** `DeviceSettingsSchema` defaults
 *    every field in `prep`, so a bulk apply that posted the whole block (or
 *    spread a patch whose absent keys are `undefined`) would reset four
 *    settings the operator never touched on every selected device, with no
 *    error anywhere.
 * 2. **The report is per-device and honest.** Twenty phones produce a mix of
 *    applied / no session / busy / declined, and one aggregate "applied to 20"
 *    over that mix is the failure mode the whole route exists to avoid.
 *
 * Modelled on `devices-rotation.test.ts` beside it, which covers the same live
 * apply through the single-device `PATCH`.
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

function seedDevice(db: Db, id: string, opts: { settings?: unknown } = {}): void {
  db.insert(devices)
    .values({
      id,
      stableId: `stable-${id}`,
      serial: `serial-${id}`,
      label: `Phone ${id}`,
      status: 'online',
      ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
    })
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

/** Per-device outcomes: what the (fake) live session reports back for each device id. `null` is "no session open". */
function fakeSessions(outcomes: Record<string, RotationOutcome | null>): SessionsStub {
  const applied: Array<{ deviceId: string; mode: RotationMode }> = []
  return {
    applied,
    closeDevice: async () => {},
    get: () => null,
    restartAt: async () => {},
    setRotation: async (deviceId, mode) => {
      applied.push({ deviceId, mode })
      return outcomes[deviceId] ?? null
    },
  }
}

function makeApp(opts: { sessions?: SessionsStub; runningJobDeviceIds?: Set<string> } = {}) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const audit = createAuditLogger(db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-devices-prep-apply-test-'))
  const activities = fakeActivities()
  const controlSettings = () => ({ overControl: 'allow' as const, idleSec: 30 })
  const lifecycle = createDeviceLifecycle({ db, activities, controlSettings, log: createLogger('test') })
  const events: Array<{ deviceId: string; kind: string; meta: unknown }> = []
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
      record: (e) => {
        events.push({ deviceId: e.deviceId, kind: e.kind, meta: e.meta ?? null })
      },
      ...(opts.sessions ? { connection: { reconnector: () => null, sessions: () => opts.sessions! } } : {}),
    }),
  )
  return { db, app, events }
}

const applyReq = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const relocked = (mode: RotationMode): RotationOutcome => ({ mode, target: '0', applied: true })

/** Parsed through the DECLARED response schema, never read raw — an undeclared key is stripped silently, and this repo has been bitten by that three times. */
async function reportOf(res: Response) {
  return DevicePrepApplyResponseSchema.parse(await res.json())
}

function prepOf(db: Db, id: string) {
  const row = db.select().from(devices).all().find((r) => r.id === id)
  return DeviceSettingsSchema.parse(row?.settings ?? {}).prep
}

describe('POST /api/devices/prep/apply writes ONLY the keys the operator chose', () => {
  test('a rotation-only apply leaves every other prep setting exactly as it was', async () => {
    const { db, app } = makeApp({ sessions: fakeSessions({}) })
    seedDevice(db, 'a', {
      settings: DeviceSettingsSchema.parse({
        prep: { keepAwake: 'always', textInput: 'agent', disableAnimations: false, standbyScreenOff: true, rotation: 'device' },
      }),
    })

    const res = await app.request('/prep/apply', applyReq({ deviceIds: ['a'], prep: { rotation: 'lock-portrait' } }))
    expect(res.status).toBe(200)

    // The one chosen key moved; the five nobody touched are untouched — NOT
    // reset to the schema defaults (`always`/`auto`/`true`/`false`), which is
    // what a whole-object write would have done here.
    expect(prepOf(db, 'a')).toEqual({
      disableAnimations: false,
      keepAwake: 'always',
      // Never sent by this request, and the seed above did not set it either,
      // so it holds `DeviceSettingsSchema`'s own default (plan 125 §4.2).
      screenOffTimeoutMs: 1800000,
      standbyScreenOff: true,
      rotation: 'lock-portrait',
      textInput: 'agent',
    })
  })

  test('several chosen keys are all written, in one pass', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    const res = await app.request('/prep/apply', applyReq({ deviceIds: ['a'], prep: { keepAwake: 'always', textInput: 'agent' } }))
    expect(res.status).toBe(200)
    const prep = prepOf(db, 'a')
    expect(prep.keepAwake).toBe('always')
    expect(prep.textInput).toBe('agent')
    expect((await reportOf(res)).keys).toEqual(['keepAwake', 'textInput'])
  })

  test('an empty patch is a bad request — never "apply the defaults to everything"', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    const res = await app.request('/prep/apply', applyReq({ deviceIds: ['a'], prep: {} }))
    expect(res.status).toBe(400)
    // And nothing was written — the seeded device still holds the schema
    // default, which plan 125 §3.3 moved to `always`.
    expect(prepOf(db, 'a').keepAwake).toBe('always')
  })

  test('a device whose stored settings do not parse is REFUSED and named — never merged onto a blank slate', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'ok')
    seedDevice(db, 'broken', { settings: { engines: { transport: 42 }, prep: { keepAwake: 'sometimes' } } })

    const res = await app.request('/prep/apply', applyReq({ deviceIds: ['ok', 'broken'], prep: { rotation: 'lock-portrait' } }))
    const report = await reportOf(res)
    const broken = report.results.find((r) => r.deviceId === 'broken')
    expect(broken?.error?.code).toBe('E_SETTINGS_UNREADABLE')
    expect(broken?.saved).toBe(false)
    // Its row is untouched — no silent reset of everything else it holds.
    const raw = db.select().from(devices).all().find((r) => r.id === 'broken')
    expect(raw?.settings).toEqual({ engines: { transport: 42 }, prep: { keepAwake: 'sometimes' } })
    // And the healthy device in the same request still went through.
    expect(report.results.find((r) => r.deviceId === 'ok')?.saved).toBe(true)
  })

  test('`changed` names only the keys that actually moved on THIS device', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a', { settings: DeviceSettingsSchema.parse({ prep: { keepAwake: 'always' } }) })
    // Explicitly on the OLD value, not the schema default: plan 125 §3.3 moved
    // that default to `always`, so a plain `seedDevice` would already hold the
    // value this request applies and the test would assert nothing.
    seedDevice(db, 'b', { settings: DeviceSettingsSchema.parse({ prep: { keepAwake: 'while-charging' } }) })
    const res = await app.request('/prep/apply', applyReq({ deviceIds: ['a', 'b'], prep: { keepAwake: 'always' } }))
    const report = await reportOf(res)
    expect(report.results.find((r) => r.deviceId === 'a')?.changed).toEqual([])
    expect(report.results.find((r) => r.deviceId === 'b')?.changed).toEqual(['keepAwake'])
    // Both are saved either way — "it already held this value" is not a failure.
    expect(report.results.every((r) => r.saved)).toBe(true)
  })
})

describe('POST /api/devices/prep/apply reports per device, honestly', () => {
  test('a mixed selection reports applied / no-session / busy / declined / missing, one row each', async () => {
    const sessions = fakeSessions({
      live: relocked('lock-portrait'),
      quiet: null,
      declined: { mode: 'lock-portrait', target: '0', applied: false, reason: 'user_rotation reads back "1", not "0"' },
    })
    const { db, app } = makeApp({ sessions, runningJobDeviceIds: new Set(['busy']) })
    seedDevice(db, 'live')
    seedDevice(db, 'quiet')
    seedDevice(db, 'busy')
    seedDevice(db, 'declined')

    const res = await app.request(
      '/prep/apply',
      applyReq({ deviceIds: ['live', 'quiet', 'busy', 'declined', 'gone'], prep: { rotation: 'lock-portrait' } }),
    )
    const report = await reportOf(res)
    expect(report.total).toBe(5)
    const byId = new Map(report.results.map((r) => [r.deviceId, r]))

    expect(byId.get('live')?.rotation).toEqual({ mode: 'lock-portrait', state: 'applied' })
    expect(byId.get('quiet')?.rotation).toEqual({ mode: 'lock-portrait', state: 'no-session' })
    expect(byId.get('declined')?.rotation?.state).toBe('failed')
    expect(byId.get('gone')?.error?.code).toBe('device_not_found')
    expect(byId.get('gone')?.saved).toBe(false)

    // The busy device: saved, and NOT re-locked. Both halves, on one row.
    expect(byId.get('busy')?.saved).toBe(true)
    expect(byId.get('busy')?.rotation?.state).toBe('busy')
    expect(byId.get('busy')?.rotation?.reason).toContain('job is running')
    expect(prepOf(db, 'busy').rotation).toBe('lock-portrait')
    // Nothing was taken from the running job — no live call was made for it.
    expect(sessions.applied.map((a) => a.deviceId)).not.toContain('busy')

    // A device that declined still has the setting stored: the save succeeded,
    // the live re-lock did not, and the row says exactly that.
    expect(byId.get('declined')?.saved).toBe(true)
    expect(prepOf(db, 'declined').rotation).toBe('lock-portrait')
  })

  test('a duplicated device id produces one row, not two', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    const res = await app.request('/prep/apply', applyReq({ deviceIds: ['a', 'a'], prep: { keepAwake: 'off' } }))
    const report = await reportOf(res)
    expect(report.total).toBe(1)
  })

  test('a non-rotation apply reports no rotation at all — it never claims a live effect it does not have', async () => {
    const sessions = fakeSessions({ a: relocked('lock-portrait') })
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a')
    const res = await app.request('/prep/apply', applyReq({ deviceIds: ['a'], prep: { keepAwake: 'always' } }))
    expect((await reportOf(res)).results[0]?.rotation).toBeNull()
    expect(sessions.applied).toEqual([])
  })

  /**
   * The retry case, and the one deliberate difference from `PATCH /:id`: that
   * route re-locks only when the STORED value changes, because its form posts
   * the whole settings object. Here the key is present only because the
   * operator ticked it, so a re-run must attempt the live apply again — a
   * retry that skipped every device whose value was already stored would be a
   * guaranteed no-op on exactly the devices that failed the first time.
   */
  test('re-applying the same value still attempts the live re-lock, so a retry can work', async () => {
    const sessions = fakeSessions({ a: relocked('lock-portrait') })
    const { db, app } = makeApp({ sessions })
    seedDevice(db, 'a', { settings: DeviceSettingsSchema.parse({ prep: { rotation: 'lock-portrait' } }) })

    const res = await app.request('/prep/apply', applyReq({ deviceIds: ['a'], prep: { rotation: 'lock-portrait' } }))
    const report = await reportOf(res)
    expect(report.results[0]?.changed).toEqual([])
    expect(report.results[0]?.rotation).toEqual({ mode: 'lock-portrait', state: 'applied' })
    expect(sessions.applied).toEqual([{ deviceId: 'a', mode: 'lock-portrait' }])
  })

  test('the live re-lock lands in the device’s own log, and a save that changed nothing does not', async () => {
    const sessions = fakeSessions({ a: relocked('lock-portrait') })
    const { db, app, events } = makeApp({ sessions })
    seedDevice(db, 'a', { settings: DeviceSettingsSchema.parse({ prep: { rotation: 'lock-portrait' } }) })

    await app.request('/prep/apply', applyReq({ deviceIds: ['a'], prep: { rotation: 'lock-portrait' } }))
    expect(events.filter((e) => e.kind === 'settings.changed')).toEqual([])
    expect(events.filter((e) => e.kind === 'device.rotation').length).toBe(1)
  })

  test('with no sessions accessor wired at all (orchestrator mode), the settings still save', async () => {
    const { db, app } = makeApp()
    seedDevice(db, 'a')
    const res = await app.request('/prep/apply', applyReq({ deviceIds: ['a'], prep: { rotation: 'lock-landscape' } }))
    expect((await reportOf(res)).results[0]?.rotation).toEqual({ mode: 'lock-landscape', state: 'no-session' })
    expect(prepOf(db, 'a').rotation).toBe('lock-landscape')
  })
})
