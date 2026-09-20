import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ActionRequestSchema } from '@enkaku/protocol'
import type { ActionRequest, DeviceActivity } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createAuditLogger } from '../auth/audit'
import { createOperationRegistry } from '../actions/operations'
import { createBatteryMonitor } from '../device/battery'
import { createDeviceStateMachine } from '../device/state-machine'
import { createFarmSettingsStore } from '../settings/farm-settings'
import { createLogger } from '../util/logger'
import { runAction, type ActionsDeps } from './run'

/**
 * `actions/run.test.ts` — restores the coverage `docs/plans/200-mvp-program.md`
 * §8.9/§10.1 records as lost when plan 211 deleted `api/actions.test.ts`
 * (plan 207's 29 tests over the action verbs, the 202 per-device shape, and
 * the policy warn-then-force path). `api/actions.ts`'s own handler is a thin
 * JSON/auth wrapper (proven by `bun run typecheck` and the route mount);
 * every rule that decides whether a verb actually reaches a device — target
 * resolution, offline handling, and MVP 04 §1.3's policy table — lives in
 * `runAction` here, so that is what this file exercises directly, the same
 * way `api/actions-runs.test.ts` (plan 211) already does for run-script and
 * run-workflow.
 */

function unused(name: string): never {
  throw new Error(`${name} is not exercised by this test`)
}

function unusedObject<T>(name: string): T {
  return new Proxy({}, { get: () => unused(name) }) as T
}

/** A minimal, seedable stand-in for `ActivityRegistry` — enough of `list`/`start`/`end` for the policy path and the `adb` verb's own activity marker. */
function fakeActivities() {
  const byDevice = new Map<string, DeviceActivity[]>()
  return {
    seed(deviceId: string, activity: DeviceActivity) {
      byDevice.set(deviceId, [...(byDevice.get(deviceId) ?? []), activity])
    },
    registry: {
      list: (deviceId: string) => byDevice.get(deviceId) ?? [],
      start: (deviceId: string, input: { id: string; kind: DeviceActivity['kind']; label: string; actor: DeviceActivity['actor'] }) => {
        const activity: DeviceActivity = { ...input, startedAt: 0, updatedAt: 0 }
        byDevice.set(deviceId, [...(byDevice.get(deviceId) ?? []), activity])
        return activity
      },
      end: (deviceId: string, id: string) => {
        const before = byDevice.get(deviceId) ?? []
        byDevice.set(deviceId, before.filter((a) => a.id !== id))
        return before.some((a) => a.id === id)
      },
    } as unknown as ActionsDeps['activities'],
  }
}

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const db: Db = opened.db
  db.insert(devices).values({ id: 'd-online', stableId: 's-online', serial: 'ser-online', label: 'online', status: 'online' }).run()
  db.insert(devices).values({ id: 'd-offline', stableId: 's-offline', serial: 'ser-offline', label: 'offline', status: 'offline' }).run()

  const activities = fakeActivities()
  const audit = createAuditLogger(db)
  const operations = createOperationRegistry({})

  const deps: ActionsDeps = {
    db,
    audit,
    record: () => {},
    broadcast: () => {},
    activities: activities.registry,
    controlSettings: () => ({ overControl: 'warn', idleSec: 30 }),
    states: {
      current: (deviceId) => (db.select({ status: devices.status }).from(devices).where(eq(devices.id, deviceId)).get()?.status ?? null) as 'online' | 'offline' | 'quarantined' | null,
    },
    operations,
    userLabel: () => 'Test User',
    shellSettings: () => ({ mode: 'operator', execTimeoutMs: 5000, maxOutputBytes: 65536 }),
    transferSettings: () => ({ enabled: true }),
    batchesFor: () => unused('batchesFor'),
    jobService: unusedObject('jobService'),
    workflows: unusedObject('workflows'),
    resolveScriptRef: () => unused('resolveScriptRef'),
    transfer: unusedObject('transfer'),
    shellPortFor: () => ({
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }),
      stream: () => unused('shellPortFor().stream'),
    }),
    readiness: null,
    reconnector: () => null,
    sessions: () => null,
    cutover: () => null,
    lifecycle: unusedObject('lifecycle'),
    battery: () => null,
    routeService: () => null,
    labelling: null,
    preparation: unusedObject('preparation'),
    screenshot: () => unused('screenshot'),
    dataDir: '/tmp/unused',
    networks: () => [],
    listDevices: () => [],
    infoWithTags: () => ({ ownerId: null }),
  }
  return { db, deps, activities }
}

const actor = { id: 'u1', role: 'admin' as const }

/**
 * `adb`/`install`/`clear-cache` are async verbs (`VERBS[verb].mode === 'async'`,
 * `packages/core/src/actions/verbs.ts`): `runAction` answers `accepted`
 * immediately and settles the SAME operation off the fire-and-forget
 * `dispatchBounded` call. This polls the in-memory `OperationRegistry` for
 * that settle — the operation itself, never a timer — the same thing a
 * client polling `GET /api/operations/:id` would observe.
 */
async function settled(deps: ActionsDeps, operationId: string) {
  for (let i = 0; i < 50; i++) {
    const op = deps.operations.get(operationId)
    if (op?.settled) return op
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`operation ${operationId} never settled`)
}

function adbRequest(overrides: Partial<ActionRequest & { verb: 'adb' }> = {}): ActionRequest {
  return { verb: 'adb', target: { deviceIds: ['d-online'] }, force: false, cmd: 'echo hi', ...overrides } as ActionRequest
}

describe('target resolution and per-device results (MVP 07, plan 207 §4.2)', () => {
  test('a verb with offline: skip reports the offline device as skipped and the online one as done', async () => {
    const { deps } = setUp()
    const response = await runAction(deps, adbRequest({ target: { deviceIds: ['d-online', 'd-offline'] } }), actor)
    expect(response.results).toHaveLength(2)
    const byId = new Map(response.results.map((r) => [r.deviceId, r]))
    expect(byId.get('d-offline')?.status).toBe('skipped')
    expect(byId.get('d-online')?.status).toBe('accepted') // `adb` is async — settles below

    const op = await settled(deps, response.operationId)
    expect(op.results.find((r) => r.deviceId === 'd-online')?.status).toBe('done')
  })

  test('a verb with offline: allow still dispatches an offline device', async () => {
    const { deps } = setUp()
    const response = await runAction(
      deps,
      { verb: 'set-labels', target: { deviceIds: ['d-offline'] }, force: false, op: 'add', labelIds: [] } as ActionRequest,
      actor,
    )
    expect(response.results).toHaveLength(1)
    expect(response.results[0]?.status).toBe('done')
  })

  test('a device that no longer exists is reported skipped, not dropped from the response', async () => {
    const { deps } = setUp()
    const response = await runAction(deps, adbRequest({ target: { deviceIds: ['ghost'] } }), actor)
    expect(response.results).toEqual([{ deviceId: 'ghost', status: 'skipped', message: 'no longer exists' }])
  })
})

describe('the activity policy is evaluated before dispatch (MVP 04 §1.3)', () => {
  test('a conflicting activity in the warn row is reported warned, and force overrides it', async () => {
    const { deps, activities } = setUp()
    // POLICY.command.job === 'warn' (packages/core/src/activity/policy.ts) — a
    // running job on the device warns, rather than blocks, an `adb` call.
    activities.seed('d-online', { id: 'job:j1', kind: 'job', label: 'Running a job', actor: { kind: 'system', id: 'core', label: 'core' }, startedAt: 0, updatedAt: 0 })

    const warned = await runAction(deps, adbRequest(), actor)
    expect(warned.results[0]?.status).toBe('warned')

    const forced = await runAction(deps, adbRequest({ force: true }), actor)
    expect(forced.results[0]?.status).toBe('accepted') // async — settles below
    const op = await settled(deps, forced.operationId)
    expect(op.results[0]?.status).toBe('done')
  })

  test('a conflicting activity in the forbid row is refused even with force', async () => {
    const { deps, activities } = setUp()
    // POLICY.install.job === 'forbid' — an install never proceeds while a job
    // is running on that device, force or not (evaluateDevice only reads
    // `force` on the `warn` branch).
    activities.seed('d-online', { id: 'job:j1', kind: 'job', label: 'Running a job', actor: { kind: 'system', id: 'core', label: 'core' }, startedAt: 0, updatedAt: 0 })

    const request = { verb: 'install', target: { deviceIds: ['d-online'] }, force: true, artifactId: 'art-1' } as ActionRequest
    const response = await runAction(deps, request, actor)
    expect(response.results[0]?.status).toBe('forbidden')
  })

  test('no conflicting activity: the device is dispatched without a warning', async () => {
    const { deps } = setUp()
    const response = await runAction(deps, adbRequest(), actor)
    expect(response.results[0]?.status).toBe('accepted')
    const op = await settled(deps, response.operationId)
    expect(op.results[0]?.status).toBe('done')
  })
})

/**
 * A run on a phone someone is controlling (owner field report, 2026-09-15).
 * `run-script`/`run-workflow` carry the `run` policy row: a live control
 * marker WARNS, and because a run is one batch the warning holds every chosen
 * phone — nothing queues until the operator confirms with `force`.
 */
describe('run verbs warn over live control and hold the whole batch (policy row `run`)', () => {
  const control: DeviceActivity = { id: 'control:c1', kind: 'control', label: 'Controlled by Rani', actor: { kind: 'user', id: 'c1', label: 'Rani' }, startedAt: 0, updatedAt: 0 }

  function withSecondOnline(db: Db) {
    db.insert(devices).values({ id: 'd-clean', stableId: 's-clean', serial: 'ser-clean', label: 'clean', status: 'online' }).run()
  }

  test('run-script: the controlled phone is warned and the clean phone is held, with nothing dispatched', async () => {
    const { db, deps, activities } = setUp()
    withSecondOnline(db)
    activities.seed('d-online', control)
    // `batchesFor` is `unused` in this fixture: reaching it would throw, so a
    // resolved response proves no batch was created.
    const res = await runAction(deps, { verb: 'run-script', target: { deviceIds: ['d-online', 'd-clean'] }, force: false, scriptId: 's1', params: {} } as never, actor)
    const byId = new Map(res.results.map((r) => [r.deviceId, r]))
    expect(byId.get('d-online')?.status).toBe('warned')
    expect(byId.get('d-online')?.message).toContain('Controlled by Rani')
    expect(byId.get('d-clean')?.status).toBe('skipped')
  })

  test('run-workflow is held the same way', async () => {
    const { db, deps, activities } = setUp()
    withSecondOnline(db)
    activities.seed('d-online', control)
    const res = await runAction(deps, { verb: 'run-workflow', target: { deviceIds: ['d-online', 'd-clean'] }, force: false, workflowName: 'w', params: {} } as never, actor)
    expect(res.results.map((r) => r.status).sort()).toEqual(['skipped', 'warned'])
  })

  test('force dispatches every chosen phone together', async () => {
    const { db, deps, activities } = setUp()
    withSecondOnline(db)
    activities.seed('d-online', control)
    const dispatched = { ...deps, batchesFor: () => { throw new Error('dispatched') } }
    await expect(runAction(dispatched, { verb: 'run-script', target: { deviceIds: ['d-online', 'd-clean'] }, force: true, scriptId: 's1', params: {} } as never, actor)).rejects.toThrow('dispatched')
  })

  test('a running job does not warn or hold a run — the queue sequences it', async () => {
    const { deps, activities } = setUp()
    activities.seed('d-online', { id: 'job:j1', kind: 'job', label: 'Running a job', actor: { kind: 'system', id: 'core', label: 'core' }, startedAt: 0, updatedAt: 0 })
    const dispatched = { ...deps, batchesFor: () => { throw new Error('dispatched') } }
    await expect(runAction(dispatched, { verb: 'run-script', target: { deviceIds: ['d-online'] }, force: false, scriptId: 's1', params: {} } as never, actor)).rejects.toThrow('dispatched')
  })
})

describe('the per-device gate is independent per device in one request', () => {
  test('one warned device and one clean device in the same operation both get their own result', async () => {
    const { deps, activities } = setUp()
    activities.seed('d-online', { id: 'job:j1', kind: 'job', label: 'Running a job', actor: { kind: 'system', id: 'core', label: 'core' }, startedAt: 0, updatedAt: 0 })
    const response = await runAction(deps, adbRequest({ target: { deviceIds: ['d-online', 'd-offline'] } }), actor)
    const byId = new Map(response.results.map((r) => [r.deviceId, r]))
    expect(byId.get('d-online')?.status).toBe('warned')
    expect(byId.get('d-offline')?.status).toBe('skipped') // offline, and `adb`'s offline policy is 'skip'
  })
})

/**
 * `set-group` tells every connected client what moved.
 *
 * It used to write the database and broadcast nothing, so a browser kept the
 * old group on the row and the old number on the group tab until a hard
 * refresh — and so did every OTHER operator watching the same wall (owner,
 * 2026-09-04). A wrong answer here is silent by construction: the action
 * still reports `done`, and only a second pair of eyes on a second screen
 * would ever notice.
 */
describe('set-group broadcasts device.updated (owner report, 2026-09-04)', () => {
  test('one device.updated per moved device, carrying the full row, and only ONE listing for the whole move', async () => {
    const { deps } = setUp()
    const sent: Array<{ type: string; payload: { id: string } }> = []
    let listings = 0
    const spied: ActionsDeps = {
      ...deps,
      broadcast: (m: unknown) => sent.push(m as { type: string; payload: { id: string } }),
      listDevices: () => {
        listings += 1
        return [
          { id: 'd-online', group: { id: 'g1', name: 'ig' } },
          { id: 'd-offline', group: { id: 'g1', name: 'ig' } },
        ] as never
      },
    }

    await runAction(spied, { verb: 'set-group', target: { deviceIds: ['d-online', 'd-offline'] }, groupId: null } as never, {
      id: 'u1',
      role: 'admin',
    })

    expect(sent.filter((m) => m.type === 'device.updated').map((m) => m.payload.id)).toEqual(['d-online', 'd-offline'])
    // An N+1 here would be one full farm listing per device — the reason the
    // snapshot is taken once, outside the loop.
    expect(listings).toBe(1)
  })
})

describe('screen-off / screen-on (plan 227 §3.3)', () => {
  function sessionsWith(calls: Array<{ deviceId: string; on: boolean }>, opts?: { scrcpy?: boolean }) {
    return () =>
      ({
        get: (deviceId: string) =>
          ({
            deviceId,
            ...(opts?.scrcpy === false
              ? {}
              : {
                  setDisplayPower: (on: boolean) => {
                    calls.push({ deviceId, on })
                    return true
                  },
                }),
          }) as never,
      }) as never
  }

  test('the panel is changed over the session, and no adb command is issued', async () => {
    const { deps } = setUp()
    const calls: Array<{ deviceId: string; on: boolean }> = []
    let shellCalls = 0
    const spied: ActionsDeps = {
      ...deps,
      sessions: sessionsWith(calls),
      shellPortFor: () => ({
        exec: async () => {
          shellCalls += 1
          return { exitCode: 0, stdout: '', stderr: '', truncated: false }
        },
        stream: () => unused('stream'),
      }),
    }

    const res = await runAction(spied, { verb: 'screen-off', target: { deviceIds: ['d-online'] } } as never, actor)

    expect(calls).toEqual([{ deviceId: 'd-online', on: false }])
    // The whole reason this verb exists beside `sleep` — it never joins adb's queue.
    expect(shellCalls).toBe(0)
    expect(res.results[0]?.status).toBe('done')
  })

  test('screen-on is the same verb with the other value, never a second mechanism', async () => {
    const { deps } = setUp()
    const calls: Array<{ deviceId: string; on: boolean }> = []
    await runAction({ ...deps, sessions: sessionsWith(calls) }, { verb: 'screen-on', target: { deviceIds: ['d-online'] } } as never, actor)
    expect(calls).toEqual([{ deviceId: 'd-online', on: true }])
  })

  test('a device with no session is SKIPPED, not failed — its panel simply was not ours to change', async () => {
    const { deps } = setUp()
    const res = await runAction({ ...deps, sessions: () => null }, { verb: 'screen-off', target: { deviceIds: ['d-online'] } } as never, actor)
    expect(res.results[0]?.status).toBe('skipped')
  })

  test('a session mirroring without scrcpy is skipped too, rather than reporting a change it did not make', async () => {
    const { deps } = setUp()
    const res = await runAction({ ...deps, sessions: sessionsWith([], { scrcpy: false }) }, { verb: 'screen-off', target: { deviceIds: ['d-online'] } } as never, actor)
    expect(res.results[0]?.status).toBe('skipped')
  })

  test('an offline device is skipped before dispatch, like every other `offline: skip` verb', async () => {
    const { deps } = setUp()
    const calls: Array<{ deviceId: string; on: boolean }> = []
    const res = await runAction(
      { ...deps, sessions: sessionsWith(calls) },
      { verb: 'screen-off', target: { deviceIds: ['d-online', 'd-offline'] } } as never,
      actor,
    )
    expect(calls.map((c) => c.deviceId)).toEqual(['d-online'])
    expect(res.results.find((r) => r.deviceId === 'd-offline')?.status).toBe('skipped')
  })
})

/**
 * The quarantine pair, through `runAction` rather than through the monitor
 * directly (`device/battery.test.ts` covers that half): what this adds is the
 * router's own half — the verb reaches the monitor, its `false` becomes
 * `skipped` rather than a failure, and a farm whose adb subsystem has not
 * started says so instead of blaming the device.
 */
describe('quarantine / unquarantine', () => {
  function withBattery(deps: ActionsDeps, db: Db): ActionsDeps {
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const monitor = createBatteryMonitor({
      db,
      client: () => null,
      states,
      settings: createFarmSettingsStore(db),
      log: createLogger('test'),
      onBattery: () => {},
      onMetrics: () => {},
    })
    return { ...deps, battery: () => monitor }
  }

  const statusOf = (db: Db, id: string) => db.select().from(devices).where(eq(devices.id, id)).get()

  test('an online device is pulled with its reason, and returning it clears both', async () => {
    const { db, deps } = setUp()
    const withMonitor = withBattery(deps, db)

    const pulled = await runAction(withMonitor, { verb: 'quarantine', target: { deviceIds: ['d-online'] }, force: false, reason: 'screen cracked' } as ActionRequest, actor)
    expect(pulled.results).toEqual([{ deviceId: 'd-online', status: 'done', detail: { quarantined: true } }])
    expect(statusOf(db, 'd-online')).toMatchObject({ status: 'quarantined', quarantineReason: 'manual:screen cracked' })

    const back = await runAction(withMonitor, { verb: 'unquarantine', target: { deviceIds: ['d-online'] }, force: false } as ActionRequest, actor)
    expect(back.results[0]).toMatchObject({ deviceId: 'd-online', status: 'done' })
    expect(statusOf(db, 'd-online')).toMatchObject({ status: 'online', quarantineReason: null })
  })

  test('an offline device is skipped before dispatch, and a second quarantine is skipped by the transition', async () => {
    const { db, deps } = setUp()
    const withMonitor = withBattery(deps, db)

    const offline = await runAction(withMonitor, { verb: 'quarantine', target: { deviceIds: ['d-offline'] }, force: false } as ActionRequest, actor)
    expect(offline.results[0]).toMatchObject({ deviceId: 'd-offline', status: 'skipped' })

    // And a device that is ALREADY quarantined never reaches the monitor at
    // all: `offline: 'skip'` treats quarantined as unavailable, so the answer
    // is the pre-dispatch skip with that word in it.
    await runAction(withMonitor, { verb: 'quarantine', target: { deviceIds: ['d-online'] }, force: false } as ActionRequest, actor)
    const again = await runAction(withMonitor, { verb: 'quarantine', target: { deviceIds: ['d-online'] }, force: false } as ActionRequest, actor)
    expect(again.results[0]).toMatchObject({ status: 'skipped', message: 'quarantined' })
  })

  test('with no battery monitor the answer names the subsystem, not the device', async () => {
    const { deps } = setUp()
    // `battery: () => null` is `setUp`'s own default — a core whose adb
    // subsystem never started. Reporting "not quarantined" here would send an
    // operator to look at a phone that is fine.
    const res = await runAction(deps, { verb: 'unquarantine', target: { deviceIds: ['d-online'] }, force: false } as ActionRequest, actor)
    expect(res.results[0]).toMatchObject({ status: 'failed', code: 'E_NOT_SUPPORTED' })
  })
})

/*
  A composition an operator authors is a saved project with a name, a version
  and an editor. A composition a PLUGIN authors is neither: it is drawn per run
  from the fleet as it is at that moment, and saving eighty of them a day as
  projects would fill the operator's own list with rows nobody wrote and nobody
  can usefully edit.

  So `run-workflow` takes the document itself. These tests use the harness's own
  stubs as the witness: `workflows` and `batchesFor` both throw when touched, and
  WHICH of them throws says whether the store was consulted.
*/
describe('run-workflow with an inline document (plan 907)', () => {
  const inlineDoc = {
    schema: 2 as const,
    name: 'warmup-sequence',
    title: 'Warm-up sequence',
    entry: 'start',
    nodes: [
      { id: 'start', title: 'Start', ui: { x: 0, y: 0 }, enabled: true, kind: 'start' as const, next: 'done' },
      { id: 'done', title: 'Done', ui: { x: 0, y: 120 }, enabled: true, kind: 'finish' as const, status: 'succeed' as const, message: '' },
    ],
  }

  test('an inline document is run without the store being asked at all', async () => {
    const { deps } = setUp()
    // Reaching `batchesFor` means the document was resolved; `workflows` was never touched.
    await expect(
      runAction(deps, { verb: 'run-workflow', target: { deviceIds: ['d-online'] }, force: true, workflowName: 'warmup-sequence', workflowDoc: inlineDoc, params: {} } as never, actor),
    ).rejects.toThrow('batchesFor is not exercised by this test')
  })

  test('without one, the name is still read from the store, exactly as before', async () => {
    const { deps } = setUp()
    await expect(
      runAction(deps, { verb: 'run-workflow', target: { deviceIds: ['d-online'] }, force: true, workflowName: 'saved-one', params: {} } as never, actor),
    ).rejects.toThrow('workflows is not exercised by this test')
  })

  /*
    The direct path must not be a way round the checks the editor's own save
    goes through. Both of these are refused by `WorkflowDocSchema` itself, at
    parse time, before anything is dispatched.
  */
  test('an inline document is held to the same schema as a stored one', () => {
    const tooMany = { ...inlineDoc, nodes: Array.from({ length: 51 }, (_, i) => ({ id: `n${i}`, title: 'n', ui: { x: 0, y: i }, enabled: true, kind: 'finish' as const, status: 'succeed' as const, message: '' })) }
    expect(ActionRequestSchema.safeParse({ verb: 'run-workflow', target: { deviceIds: ['d-online'] }, workflowName: 'x', workflowDoc: tooMany }).success).toBe(false)
    expect(ActionRequestSchema.safeParse({ verb: 'run-workflow', target: { deviceIds: ['d-online'] }, workflowName: 'x', workflowDoc: { schema: 2, name: 'x', nodes: [] } }).success).toBe(false)
  })

  test('a valid inline document parses, and the name stays required as its label', () => {
    expect(ActionRequestSchema.safeParse({ verb: 'run-workflow', target: { deviceIds: ['d-online'] }, workflowName: 'warmup-sequence', workflowDoc: inlineDoc }).success).toBe(true)
    expect(ActionRequestSchema.safeParse({ verb: 'run-workflow', target: { deviceIds: ['d-online'] }, workflowDoc: inlineDoc }).success).toBe(false)
  })
})
