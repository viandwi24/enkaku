import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { ActionRequest, DeviceActivity } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createAuditLogger } from '../auth/audit'
import { createOperationRegistry } from '../actions/operations'
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
      { verb: 'set-tags', target: { deviceIds: ['d-offline'] }, force: false, tags: ['a'] } as ActionRequest,
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
