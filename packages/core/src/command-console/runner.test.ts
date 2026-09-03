import { describe, expect, test } from 'bun:test'
import { defaultFarmSettings, type FarmSettings } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine, type DeviceStateMachine } from '../device/state-machine'
import type { ShellExecResult, ShellPort } from '../device/shell-port'
import { createActivityRegistry, type ActivityRegistry } from '../activity/registry'
import type { ControlPolicySettings } from '../activity/policy'
import { createLogger } from '../util/logger'
import { createCommandRunStore, type CommandRunStore } from './store'
import { admitMember, computeCommandRunStatus, createCommandRunner, resolveCommandTarget, type CommandRunner, type CommandRunnerEvent } from './runner'

/**
 * Plan 93 §3.5-§3.8, §4.5, step 93.3's own verifiable result — every
 * assertion below is one of the eight the plan lists, plus the process-
 * liveness guarantee `00-overview.md` §7 requires of anything with a worker
 * pool. Uses a REAL `CommandRunStore`, a REAL `ActivityRegistry` (backed by
 * a REAL `DeviceStateMachine` over an in-memory db) — only `ShellPort` is
 * faked, since that is the actual boundary these tests need to control.
 *
 * Reworked for plan 205 §5 step 205.8: the old three-branch per-holder policy
 * (already held / idle-acquire / refused) becomes the device activity
 * policy's `command` row, which never refuses for a busy device — only
 * `device_unavailable`/`device_not_found` still skip a member; a `job`
 * already running there now WARNS and still runs the command (MVP 04 §1.3's
 * own `command` row: `job: 'warn'`).
 */

function setUp(): { db: Db; store: CommandRunStore; activities: ActivityRegistry; controlSettings: () => ControlPolicySettings; states: DeviceStateMachine } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const activities = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
  const controlSettings = (): ControlPolicySettings => ({ overControl: 'allow', idleSec: 30 })
  return { db, store: createCommandRunStore(db), activities, controlSettings, states }
}

function insertDevice(db: Db, id: string, status: 'online' | 'offline' | 'quarantined' = 'online'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `SER-${id}`, label: `Phone ${id}`, status }).run()
}

/** Registers a live `job` activity on `deviceId` — the new stand-in for the old `'busy'` device status. */
function markJobRunning(activities: ActivityRegistry, deviceId: string): void {
  activities.start(deviceId, { id: `job:${deviceId}-job`, kind: 'job', label: 'Running a script', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
}

/** Wraps a real `ActivityRegistry`, counting `start`/`end` calls without changing behaviour. */
function spyActivities(real: ActivityRegistry): { activities: ActivityRegistry; calls: { start: number; end: number } } {
  const calls = { start: 0, end: 0 }
  const activities: ActivityRegistry = {
    ...real,
    start: (deviceId, input) => {
      calls.start++
      return real.start(deviceId, input)
    },
    end: (deviceId, id) => {
      calls.end++
      return real.end(deviceId, id)
    },
  }
  return { activities, calls }
}

const shellSettings = (overrides: Partial<FarmSettings['shell']> = {}): FarmSettings['shell'] => ({
  ...defaultFarmSettings().shell,
  mode: 'admin',
  fanoutEnabled: true,
  fanoutMaxDevices: 0,
  fanoutConcurrency: 0,
  ...overrides,
})

function fakeShellPort(behavior: (deviceId: string, cmd: string, signal?: AbortSignal) => Promise<ShellExecResult>): {
  shellPortFor: (deviceId: string) => ShellPort
  calls: Array<{ deviceId: string; cmd: string; aborted: () => boolean }>
} {
  const calls: Array<{ deviceId: string; cmd: string; aborted: () => boolean }> = []
  const shellPortFor = (deviceId: string): ShellPort => ({
    async exec(cmd, opts) {
      calls.push({ deviceId, cmd, aborted: () => opts?.signal?.aborted ?? false })
      return behavior(deviceId, cmd, opts?.signal)
    },
    async stream() {
      throw new Error('not used by these tests')
    },
  })
  return { shellPortFor, calls }
}

interface Harness {
  db: Db
  store: CommandRunStore
  activities: ActivityRegistry
  activityCalls: { start: number; end: number }
  runner: CommandRunner
  events: CommandRunnerEvent[]
  execCalls: Array<{ deviceId: string; cmd: string; aborted: () => boolean }>
}

function buildHarness(
  execBehavior: (deviceId: string, cmd: string, signal?: AbortSignal) => Promise<ShellExecResult>,
  settingsOverride: Partial<FarmSettings['shell']> = {},
): Harness {
  const { db, store, activities: realActivities, controlSettings, states } = setUp()
  const { activities, calls: activityCalls } = spyActivities(realActivities)
  const { shellPortFor, calls: execCalls } = fakeShellPort(execBehavior)
  const events: CommandRunnerEvent[] = []
  const runner = createCommandRunner({
    db,
    store,
    activities,
    controlSettings,
    states,
    shellPortFor,
    resolve: (target) => resolveCommandTarget(db, target),
    settings: () => shellSettings(settingsOverride),
    recorder: () => {},
    audit: { record: () => {}, list: () => [] },
    broadcast: (_runId, msg) => events.push(msg),
    roleOf: () => 'admin',
    getDevice: () => null,
    log: createLogger('test'),
  })
  return { db, store, activities, activityCalls, runner, events, execCalls }
}

/** Polls until `pred()` is true or the timeout elapses — the store is a real (synchronous) sqlite db, so a settled member is visible the instant `updateMember` returns; this only waits out the pool's own async scheduling. */
async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out')
    await Bun.sleep(5)
  }
}

const ok = (stdout = 'ok'): Promise<ShellExecResult> => Promise.resolve({ stdout, stderr: '', exitCode: 0, truncated: false })

describe("admitMember — the device activity policy's command row (plan 93 §3.8, plan 205 §4.9)", () => {
  test('an online device with nothing else running: ok', () => {
    const { db, activities, controlSettings, states } = setUp()
    insertDevice(db, 'd1', 'online')
    const result = admitMember(activities, controlSettings, states, 'd1')
    expect(result).toEqual({ ok: true })
  })

  test('a device with a job already running: still ok — command warns, it does not forbid', () => {
    const { db, activities, controlSettings, states } = setUp()
    insertDevice(db, 'd1', 'online')
    markJobRunning(activities, 'd1')
    const result = admitMember(activities, controlSettings, states, 'd1')
    expect(result).toEqual({ ok: true })
  })

  test('an offline device: refused with device_unavailable, verbatim', () => {
    const { db, activities, controlSettings, states } = setUp()
    insertDevice(db, 'd1', 'offline')
    const result = admitMember(activities, controlSettings, states, 'd1')
    expect(result).toEqual({ ok: false, code: 'device_unavailable', message: 'the device is offline' })
  })

  test('an unknown device: refused with device_not_found', () => {
    const { activities, controlSettings, states } = setUp()
    const result = admitMember(activities, controlSettings, states, 'no-such-device')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('device_not_found')
  })
})

describe('createCommandRunner — an online member is wrapped in exactly one command activity for the length of its exec', () => {
  test('starts and ends the activity around a successful exec', async () => {
    const h = buildHarness((_d, _c) => ok())
    insertDevice(h.db, 'd1', 'online')

    const { run } = await h.runner.start({ cmd: 'true', target: { deviceIds: ['d1'] }, clientId: 'op-client', createdBy: 'op-user' })
    await waitUntil(() => h.store.get(run.id)?.status !== 'running')

    expect(h.activityCalls.start).toBe(1)
    expect(h.activityCalls.end).toBe(1)
    expect(h.activities.list('d1')).toEqual([])
    const member = h.store.get(run.id)?.members[0]
    expect(member?.status).toBe('ok')
    h.runner.stop()
  })

  test('ends the activity even when the exec throws', async () => {
    const h = buildHarness((_d, _c) => Promise.reject(new Error('adb blew up')))
    insertDevice(h.db, 'd1', 'online')

    const { run } = await h.runner.start({ cmd: 'true', target: { deviceIds: ['d1'] }, clientId: 'op-client', createdBy: 'op-user' })
    await waitUntil(() => h.store.get(run.id)?.status !== 'running')

    expect(h.activityCalls.start).toBe(1)
    expect(h.activityCalls.end).toBe(1)
    expect(h.activities.list('d1')).toEqual([])
    const member = h.store.get(run.id)?.members[0]
    expect(member?.status).toBe('failed')
    expect(member?.error).toContain('adb blew up')
    h.runner.stop()
  })
})

// `resolveCommandTarget` already filters `offline`/`quarantined` devices out
// of `resolved.usable` (`clusters/resolve.ts`) — the same two statuses
// `admitMember` itself would refuse — so a member that reaches `admitMember`
// through `start()` at all is already known-online; `device_unavailable`/
// `device_not_found` are only ever observed by unit-testing `admitMember`
// directly (the describe block above), never through a dispatched run. The
// `command` policy row (MVP 04 §1.3) has no `forbid` cell for any OTHER
// activity kind either (job/control/command/prep all warn or allow) — so a
// command-console member is never `skipped` for an activity conflict under
// the new policy, only ever for something resolve.ts already excluded
// upstream (covered by "start() gates"'s `E_NO_TARGETS` test below).
describe('createCommandRunner — a job already running does not skip the member', () => {
  test('warns but still runs — not skipped', async () => {
    const h = buildHarness((_d, _c) => ok())
    insertDevice(h.db, 'd1', 'online')
    markJobRunning(h.activities, 'd1')

    const { run } = await h.runner.start({ cmd: 'true', target: { deviceIds: ['d1'] }, clientId: 'op-client', createdBy: 'op-user' })
    await waitUntil(() => h.store.get(run.id)?.status !== 'running')

    const member = h.store.get(run.id)?.members[0]
    expect(member?.status).toBe('ok')
    expect(h.execCalls).toHaveLength(1)
    h.runner.stop()
  })
})

describe('createCommandRunner — verifiable result #5: cancel', () => {
  test('leaves every pending member cancelled and starts none of them; an already-running member is aborted and its real completion is discarded', async () => {
    const controls: { releaseD1: ((r: ShellExecResult) => void) | null } = { releaseD1: null }
    const h = buildHarness((deviceId, _c, signal) => {
      if (deviceId === 'd1') {
        return new Promise<ShellExecResult>((resolve, reject) => {
          controls.releaseD1 = resolve
          // Mirrors what `AdbClient.exec` already does for a real local
          // device (plan 22.1) — the fake honours the SAME `signal` contract
          // `ShellPort.exec` documents, so cancellation is not just a store
          // write here but an actual abort a caller can observe settling.
          signal?.addEventListener('abort', () => reject(new Error('aborted by caller signal')))
        })
      }
      return ok()
    })
    for (const id of ['d1', 'd2', 'd3', 'd4']) insertDevice(h.db, id, 'online')

    const { run } = await h.runner.start({
      cmd: 'true',
      target: { deviceIds: ['d1', 'd2', 'd3', 'd4'] },
      clientId: 'op-client',
      createdBy: 'op-user',
      concurrency: 1, // one at a time — d2/d3/d4 stay pending behind d1
    })
    await waitUntil(() => h.execCalls.length >= 1)
    await Bun.sleep(20) // let d1 settle into 'running' and hold its activity

    h.runner.cancel(run.id, null)

    const afterCancel = h.store.get(run.id)
    expect(afterCancel?.status).toBe('cancelled')
    for (const m of afterCancel?.members ?? []) {
      expect(m.status).toBe('cancelled')
    }
    // d2/d3/d4 were NEVER dispatched — cancel synchronously flipped them from
    // 'pending' to 'cancelled' without ever calling their exec.
    expect(h.execCalls.map((c) => c.deviceId)).toEqual(['d1'])
    expect(h.execCalls[0]?.aborted()).toBe(true)

    // d1's activity is ended once the abort actually propagates through the
    // (fake, but signal-honouring) exec — not claimed synchronously by
    // `cancel()` itself, since the real world has not caught up yet.
    await waitUntil(() => h.activities.list('d1').length === 0)

    // The real device "finishes" after the fact anyway — must not resurrect the member.
    controls.releaseD1?.({ stdout: 'late', stderr: '', exitCode: 0, truncated: false })
    await Bun.sleep(20)
    expect(h.store.get(run.id)?.members.find((m) => m.deviceId === 'd1')?.status).toBe('cancelled')

    h.runner.stop()
  })
})

describe('createCommandRunner — verifiable result #6: staged rollout', () => {
  test('stops at awaiting-continue after stage 1 and holds no activity on any stage-2 device while waiting', async () => {
    const h = buildHarness((_d, _c) => ok())
    for (const id of ['d1', 'd2', 'd3']) insertDevice(h.db, id, 'online')

    const { run } = await h.runner.start({
      cmd: 'true',
      target: { deviceIds: ['d1', 'd2', 'd3'] },
      clientId: 'op-client',
      createdBy: 'op-user',
      stageFirstN: 1,
    })
    await waitUntil(() => h.store.get(run.id)?.status === 'awaiting-continue')

    const info = h.store.get(run.id)
    expect(info?.status).toBe('awaiting-continue')
    const stage1 = info?.members.find((m) => m.deviceId === 'd1')
    expect(stage1?.status).toBe('ok')
    for (const id of ['d2', 'd3']) {
      const m = info?.members.find((mm) => mm.deviceId === id)
      expect(m?.status).toBe('pending')
      expect(h.activities.list(id)).toEqual([])
    }
    expect(h.execCalls.map((c) => c.deviceId)).toEqual(['d1'])

    // Continuing dispatches the rest, and the run finishes normally.
    h.runner.continueRun(run.id, null)
    await waitUntil(() => h.store.get(run.id)?.status !== 'running' && h.store.get(run.id)?.status !== 'awaiting-continue')
    expect(h.store.get(run.id)?.status).toBe('ok')
    expect(h.execCalls.map((c) => c.deviceId).sort()).toEqual(['d1', 'd2', 'd3'])
    for (const id of ['d1', 'd2', 'd3']) expect(h.activities.list(id)).toEqual([])

    h.runner.stop()
  })

  test('cancelling while awaiting-continue also cancels the still-pending stage-2 members', async () => {
    const h = buildHarness((_d, _c) => ok())
    for (const id of ['d1', 'd2']) insertDevice(h.db, id, 'online')

    const { run } = await h.runner.start({
      cmd: 'true',
      target: { deviceIds: ['d1', 'd2'] },
      clientId: 'op-client',
      createdBy: 'op-user',
      stageFirstN: 1,
    })
    await waitUntil(() => h.store.get(run.id)?.status === 'awaiting-continue')

    h.runner.cancel(run.id, null)
    const info = h.store.get(run.id)
    // d1 already succeeded before cancel; only d2 (still pending) is forced
    // to 'cancelled'. The RUN's overall status is `computeCommandRunStatus`,
    // recomputed from ALL members (§3.4) — the same rule `computeBatchStatus`
    // uses: 'cancelled' only when EVERY member is; a mix with no failures is
    // 'ok', exactly as a batch whose queued members were cancelled but whose
    // already-succeeded ones were not still reads 'success'.
    expect(info?.members.find((m) => m.deviceId === 'd1')?.status).toBe('ok')
    expect(info?.members.find((m) => m.deviceId === 'd2')?.status).toBe('cancelled')
    expect(info?.status).toBe('ok')

    h.runner.stop()
  })
})

describe('createCommandRunner — verifiable result #7: sweepOrphans', () => {
  test('cancels a non-terminal run left by a previous process (mirrors failOrphanRunning)', () => {
    const { db, store, activities, controlSettings, states } = setUp()
    insertDevice(db, 'd1', 'online')
    // Simulate a run left `running` by a crashed process — created directly
    // through the store, never dispatched through a runner.
    const orphan = store.create({ cmd: 'true', target: { deviceIds: ['d1'] }, createdBy: 'user-1', members: [{ deviceId: 'd1' }] })
    expect(orphan.status).toBe('running')

    const runner = createCommandRunner({
      db,
      store,
      activities,
      controlSettings,
      states,
      shellPortFor: () => {
        throw new Error('must not be called')
      },
      resolve: (target) => resolveCommandTarget(db, target),
      settings: () => shellSettings(),
      recorder: () => {},
      audit: { record: () => {}, list: () => [] },
      broadcast: () => {},
      roleOf: () => 'admin',
      getDevice: () => null,
      log: createLogger('test'),
    })

    const swept = runner.sweepOrphans()
    expect(swept).toBe(1)
    const after = store.get(orphan.id)
    expect(after?.status).toBe('cancelled')
    expect(after?.members[0]?.status).toBe('cancelled')
    runner.stop()
  })
})

describe('createCommandRunner — verifiable result #8: the coalescer and the output hash', () => {
  test('coalesces many near-simultaneous member transitions into few command.progress broadcasts', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `d${i}`)
    const h = buildHarness((_d, _c) => ok())
    for (const id of ids) insertDevice(h.db, id, 'online')

    const { run } = await h.runner.start({ cmd: 'true', target: { deviceIds: ids }, clientId: 'op-client', createdBy: 'op-user', concurrency: 8 })
    await waitUntil(() => h.store.get(run.id)?.status !== 'running')
    // One more tick so any final coalescer flush (finalizeRun's own) has landed.
    await Bun.sleep(300)

    const progressEvents = h.events.filter((e): e is Extract<CommandRunnerEvent, { type: 'command.progress' }> => e.type === 'command.progress')
    const totalChanged = progressEvents.reduce((n, e) => n + e.payload.changed.length, 0)
    // All 8 members' final transitions were reported...
    expect(totalChanged).toBeGreaterThanOrEqual(8)
    // ...but coalesced: nowhere near one broadcast per member (8 members × up
    // to 2 transitions each = 16 possible individual messages; the whole run
    // finishes in well under one 250ms tick, so this should be a small handful).
    expect(progressEvents.length).toBeLessThan(8)
    expect(h.events.some((e) => e.type === 'command.finished')).toBe(true)

    h.runner.stop()
  })

  test('outputHash matches Bun.hash(exitCode + stdout + stderr) and groups identical output under one command.output broadcast', async () => {
    const h = buildHarness((_d, _c) => Promise.resolve({ stdout: 'same output', stderr: '', exitCode: 0, truncated: false }))
    insertDevice(h.db, 'd1', 'online')
    insertDevice(h.db, 'd2', 'online')

    const { run } = await h.runner.start({ cmd: 'true', target: { deviceIds: ['d1', 'd2'] }, clientId: 'op-client', createdBy: 'op-user' })
    await waitUntil(() => h.store.get(run.id)?.status !== 'running')

    const info = h.store.get(run.id)
    const [m1, m2] = info?.members ?? []
    const expectedHash = Bun.hash(`0\0same output\0`).toString()
    expect(m1?.outputHash).toBe(expectedHash)
    expect(m2?.outputHash).toBe(expectedHash)
    expect(m1?.outputHash).toBe(m2?.outputHash)

    const outputEvents = h.events.filter((e) => e.type === 'command.output')
    expect(outputEvents).toHaveLength(1) // one broadcast per DISTINCT hash, not per member

    h.runner.stop()
  })

  test('distinct outputs get distinct hashes and each gets its own command.output broadcast', async () => {
    const h = buildHarness((deviceId, _c) => Promise.resolve({ stdout: deviceId, stderr: '', exitCode: 0, truncated: false }))
    insertDevice(h.db, 'd1', 'online')
    insertDevice(h.db, 'd2', 'online')

    const { run } = await h.runner.start({ cmd: 'true', target: { deviceIds: ['d1', 'd2'] }, clientId: 'op-client', createdBy: 'op-user' })
    await waitUntil(() => h.store.get(run.id)?.status !== 'running')

    const info = h.store.get(run.id)
    const [m1, m2] = info?.members ?? []
    expect(m1?.outputHash).not.toBe(m2?.outputHash)
    const outputEvents = h.events.filter((e) => e.type === 'command.output')
    expect(outputEvents).toHaveLength(2)

    h.runner.stop()
  })
})

describe('createCommandRunner — process liveness (00-overview.md §7): stop() drains a run with pending work', () => {
  test('stop() cancels every active run, aborts in-flight execs, and clears the coalescer/stage timers — nothing is left pending', async () => {
    const controls: { hold: ((r: ShellExecResult) => void) | null } = { hold: null }
    const h = buildHarness((deviceId, _c, signal) => {
      if (deviceId === 'd1') {
        return new Promise<ShellExecResult>((resolve, reject) => {
          controls.hold = resolve
          signal?.addEventListener('abort', () => reject(new Error('aborted by caller signal')))
        })
      }
      return ok()
    })
    for (const id of ['d1', 'd2', 'd3']) insertDevice(h.db, id, 'online')

    const { run } = await h.runner.start({
      cmd: 'true',
      target: { deviceIds: ['d1', 'd2', 'd3'] },
      clientId: 'op-client',
      createdBy: 'op-user',
      concurrency: 1,
    })
    await waitUntil(() => h.execCalls.length >= 1)

    h.runner.stop()

    const info = h.store.get(run.id)
    expect(info?.status).toBe('cancelled')
    expect(info?.members.every((m) => m.status === 'cancelled')).toBe(true)
    // Every activity this run could have been holding is gone — d1's exec was
    // genuinely aborted (the fake honours `signal`, matching what `AdbClient`
    // already does for a real local device), so its `finally` ends it too.
    await waitUntil(() => ['d1', 'd2', 'd3'].every((id) => h.activities.list(id).length === 0))
    // A second stop() is a harmless no-op (nothing left in `active`).
    expect(() => h.runner.stop()).not.toThrow()
    controls.hold?.({ stdout: '', stderr: '', exitCode: 0, truncated: false })
  })
})

describe('createCommandRunner — start() gates (plan 93 §3.8, defense in depth alongside the REST route)', () => {
  test('refuses when shell.fanoutEnabled is false', async () => {
    const h = buildHarness((_d, _c) => ok(), { fanoutEnabled: false })
    insertDevice(h.db, 'd1', 'online')
    await expect(h.runner.start({ cmd: 'true', target: { deviceIds: ['d1'] }, clientId: 'c', createdBy: 'u' })).rejects.toMatchObject({ code: 'E_FANOUT_DISABLED' })
    h.runner.stop()
  })

  test('refuses when shell.mode is off', async () => {
    const h = buildHarness((_d, _c) => ok(), { mode: 'off' })
    insertDevice(h.db, 'd1', 'online')
    await expect(h.runner.start({ cmd: 'true', target: { deviceIds: ['d1'] }, clientId: 'c', createdBy: 'u' })).rejects.toMatchObject({ code: 'auth.forbidden' })
    h.runner.stop()
  })

  test('refuses a target above fanoutMaxDevices', async () => {
    const h = buildHarness((_d, _c) => ok(), { fanoutMaxDevices: 1 })
    insertDevice(h.db, 'd1', 'online')
    insertDevice(h.db, 'd2', 'online')
    await expect(h.runner.start({ cmd: 'true', target: { deviceIds: ['d1', 'd2'] }, clientId: 'c', createdBy: 'u' })).rejects.toMatchObject({ code: 'E_TOO_MANY_TARGETS' })
    h.runner.stop()
  })

  test('refuses an all-unusable target with E_NO_TARGETS', async () => {
    const h = buildHarness((_d, _c) => ok())
    insertDevice(h.db, 'd1', 'offline')
    await expect(h.runner.start({ cmd: 'true', target: { deviceIds: ['d1'] }, clientId: 'c', createdBy: 'u' })).rejects.toMatchObject({ code: 'E_NO_TARGETS' })
    h.runner.stop()
  })
})

describe('computeCommandRunStatus (plan 93 §3.4)', () => {
  const base = { total: 0, pending: 0, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 }
  test('any pending or running -> running', () => {
    expect(computeCommandRunStatus({ ...base, total: 2, pending: 1, ok: 1 })).toBe('running')
    expect(computeCommandRunStatus({ ...base, total: 2, running: 1, ok: 1 })).toBe('running')
  })
  test('all ok, or ok mixed with skipped -> ok (skipped is not a failure)', () => {
    expect(computeCommandRunStatus({ ...base, total: 2, ok: 2 })).toBe('ok')
    expect(computeCommandRunStatus({ ...base, total: 2, ok: 1, skipped: 1 })).toBe('ok')
  })
  test('any failed among terminal members -> failed', () => {
    expect(computeCommandRunStatus({ ...base, total: 2, ok: 1, failed: 1 })).toBe('failed')
  })
  test('all cancelled -> cancelled', () => {
    expect(computeCommandRunStatus({ ...base, total: 2, cancelled: 2 })).toBe('cancelled')
  })
})

describe('resolveCommandTarget (plan 93 §4.5)', () => {
  test('deviceIds and tags route through resolveTarget; clusterId through resolveCluster', () => {
    const { db } = setUp()
    insertDevice(db, 'd1', 'online')
    const byIds = resolveCommandTarget(db, { deviceIds: ['d1'] })
    expect(byIds.usable.map((u) => u.deviceId)).toEqual(['d1'])
  })

  test('an unknown clusterId throws cluster_not_found', () => {
    const { db } = setUp()
    expect(() => resolveCommandTarget(db, { clusterId: 'nope' })).toThrow()
  })
})

describe('CommandRunner.stats() — the commandConsole block (plan 93 §5 step 93.12, H1/H2)', () => {
  test('a fresh runner reports every field zeroed, distinctOutputRatio 0 not NaN', () => {
    const h = buildHarness((_d, _c) => ok())
    expect(h.runner.stats()).toEqual({
      runsInFlight: 0,
      membersInFlight: 0,
      coalescedFramesPerSec: 0,
      distinctOutputRatio: 0,
    })
    h.runner.stop()
  })

  test('identical output across members collapses distinctOutputRatio toward the H1 grouping ratio, not 1', async () => {
    const h = buildHarness((_d, _c) => ok('same-output'))
    insertDevice(h.db, 'd1', 'online')
    insertDevice(h.db, 'd2', 'online')
    const { run } = await h.runner.start({ cmd: 'true', target: { deviceIds: ['d1', 'd2'] }, clientId: 'c', createdBy: 'u' })
    await waitUntil(() => h.store.get(run.id)?.status === 'ok')
    // Both members produced the SAME hash — one distinct output over two settled execs.
    expect(h.runner.stats().distinctOutputRatio).toBe(0.5)
    h.runner.stop()
  })

  test('membersInFlight reflects an in-flight run before its exec resolves', async () => {
    const controls: { release: ((r: ShellExecResult) => void) | null } = { release: null }
    const h = buildHarness(
      (_d, _c) =>
        new Promise<ShellExecResult>((resolve) => {
          controls.release = resolve
        }),
    )
    insertDevice(h.db, 'd1', 'online')
    const startP = h.runner.start({ cmd: 'true', target: { deviceIds: ['d1'] }, clientId: 'c', createdBy: 'u' })
    await waitUntil(() => h.runner.stats().membersInFlight === 1)
    expect(h.runner.stats().runsInFlight).toBe(1)
    controls.release?.({ stdout: 'x', stderr: '', exitCode: 0, truncated: false })
    const { run } = await startP
    await waitUntil(() => h.store.get(run.id)?.status === 'ok')
    h.runner.stop()
  })
})
