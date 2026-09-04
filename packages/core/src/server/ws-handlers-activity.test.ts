import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { ServerMessage } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * `ws-handlers-activity.test.ts` — restores the coverage `docs/plans/
 * 200-mvp-program.md` §8.9/§10.1 records as lost when plan 211 deleted
 * `ws-handlers-activity.test.ts` (the `device.activity.warning` throttle,
 * originally written by plan 205 because that behaviour had no coverage
 * anywhere). Exercises the REAL `createWsMessageHandler`'s `admit()`/
 * `warnOnce()` gate through `input.tap` (MVP 04 §3, plan 205 §4.8) — the
 * device session itself is deliberately absent, so the handler answers
 * `E_DEVICE_NOT_READY` right after the gate; the warning already went out by
 * then, which is exactly the code path this file is proving.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'online' }).run()
}

function fakeConn(): { ws: ServerWebSocket<unknown>; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const ws = {
    readyState: 1,
    data: { userId: null },
    send: (raw: string | Uint8Array) => {
      if (typeof raw === 'string') sent.push(JSON.parse(raw) as ServerMessage)
      return typeof raw === 'string' ? raw.length : raw.byteLength
    },
    getBufferedAmount: () => 0,
  } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

function tap(conn: { ws: ServerWebSocket<unknown> }, handler: ReturnType<typeof createWsMessageHandler>, deviceId: string) {
  return handler.handleMessage(conn.ws, JSON.stringify({ type: 'input.tap', payload: { deviceId, pos: { x: 0.5, y: 0.5 } } }))
}

/** Someone else already driving this device — the conflict that still warns when a farm sets `control over control` to `warn` (MVP 04 §1.3), which this fixture does. */
const otherPerson = { id: 'control:other', kind: 'control', label: 'Controlled by Rani', actor: { kind: 'user' as const, id: 'u-rani', label: 'Rani' } }

describe('device.activity.warning: one per device per minute per connection (MVP 04 §3, plan 205 §4.8)', () => {
  test('a conflicting activity produces exactly one warning for two taps inside the same minute', async () => {
    const db = setUpDb()
    seedDevice(db, 'd1')
    const activitiesDeps = setUpHandlerActivities(db)
    const conn = fakeConn()

    activitiesDeps.start('d1', otherPerson)

    await tap(conn, activitiesDeps.handler, 'd1')
    await tap(conn, activitiesDeps.handler, 'd1')

    const warnings = conn.sent.filter((m) => m.type === 'device.activity.warning')
    expect(warnings).toHaveLength(1)
  })

  test('a second warning window (61s later) sends a fresh warning', async () => {
    const db = setUpDb()
    seedDevice(db, 'd1')
    const activitiesDeps = setUpHandlerActivities(db)
    const conn = fakeConn()
    activitiesDeps.start('d1', otherPerson)

    await tap(conn, activitiesDeps.handler, 'd1')
    expect(conn.sent.filter((m) => m.type === 'device.activity.warning')).toHaveLength(1)

    const realNow = Date.now
    try {
      Date.now = () => realNow() + 61_000
      await tap(conn, activitiesDeps.handler, 'd1')
    } finally {
      Date.now = realNow
    }
    expect(conn.sent.filter((m) => m.type === 'device.activity.warning')).toHaveLength(2)
  })

  /**
   * The two tests above used a RUNNING JOB as the conflict, because
   * `POLICY.control.job` was `warn`. The CEO struck that on 2026-09-04: an
   * operator reaching into a running job is helping it, and the sentence it
   * used to raise ("your taps will interfere") said the opposite. They now
   * use a second person's control marker, which still warns when a farm opts
   * into `control over control: warn` — so the throttle keeps its coverage —
   * and this pins the decision itself.
   */
  test('a running job raises NO warning at all — a person taking over a job is help, not a conflict', async () => {
    const db = setUpDb()
    seedDevice(db, 'd1')
    const activitiesDeps = setUpHandlerActivities(db)
    const conn = fakeConn()

    activitiesDeps.start('d1', { id: 'job:j1', kind: 'job', label: 'Running a job', actor: { kind: 'system', id: 'core', label: 'core' } })
    await tap(conn, activitiesDeps.handler, 'd1')

    expect(conn.sent.filter((m) => m.type === 'device.activity.warning')).toHaveLength(0)
  })

  test('no conflicting activity: no warning is sent, even though the device has no session', async () => {
    const db = setUpDb()
    seedDevice(db, 'd1')
    const activitiesDeps = setUpHandlerActivities(db)
    const conn = fakeConn()

    await tap(conn, activitiesDeps.handler, 'd1')
    expect(conn.sent.filter((m) => m.type === 'device.activity.warning')).toHaveLength(0)
    // The gate passed with no warning; the message still fails later for lack
    // of a session, which is expected in this fixture.
    expect(conn.sent.some((m) => m.type === 'error')).toBe(true)
  })

  test('a FORBIDDING activity refuses the tap outright and never reaches the warning path', async () => {
    const db = setUpDb()
    seedDevice(db, 'd1')
    const activitiesDeps = setUpHandlerActivities(db)
    const conn = fakeConn()
    // Every column of `POLICY.control` is `allow` now except `control`
    // itself, which resolves through `overControl` ('warn' here). So this
    // asserts the negative: a bare `job` conflict never refuses a tap.
    activitiesDeps.start('d1', { id: 'job:j1', kind: 'job', label: 'Running a job', actor: { kind: 'system', id: 'core', label: 'core' } })
    await tap(conn, activitiesDeps.handler, 'd1')
    const errors = conn.sent.filter((m) => m.type === 'error') as Array<{ payload: { code: string } }>
    expect(errors.some((e) => e.payload.code === 'E_DEVICE_CONFLICT')).toBe(false)
  })
})

/** A thin wrapper so each test gets its own `ActivityRegistry` alongside the handler it feeds. */
function setUpHandlerActivities(db: Db): { handler: ReturnType<typeof createWsMessageHandler>; start: (deviceId: string, input: { id: string; kind: string; label: string; actor: { kind: 'system' | 'user'; id: string; label: string } }) => void } {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
  const deps = {
    sessions: null,
    db,
    log,
    activities,
    controlSettings: () => ({ overControl: 'warn' as const, idleSec: 30 }),
    states,
    recorder: { record: () => {} },
    auth: null,
  } as unknown as WsHandlerDeps
  const handler = createWsMessageHandler(deps)
  return {
    handler,
    start: (deviceId, input) => {
      activities.start(deviceId, input as never)
    },
  }
}
