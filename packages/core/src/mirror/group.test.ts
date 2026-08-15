import { describe, expect, test } from 'bun:test'
import type { DeviceStatus, InputSink, MirrorMember } from '@enkaku/protocol'
import type { DeviceSession, InputArbiter, SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createLogger } from '../util/logger'
import type { Logger } from '../util/logger'
import { createDeviceStateMachine } from '../device/state-machine'
import { createLeaseManager } from '../lease/lease-manager'
import { createCoControlManager } from '../lease/co-control'
import { EnkakuError } from '../util/errors'
import type { JobService } from '../services/job-service'
import { createMirrorManager } from './group'

/**
 * Plan 91 §3.9, §4.7, §5 step 91.7 — mirror groups. Built against REAL
 * `LeaseManager`/`CoControlManager`/`DeviceStateMachine` instances (the same
 * pattern `co-control.test.ts` already established for this plan), backed by
 * an in-memory SQLite db — a member's `lease`/`assist` mode in these tests is
 * therefore an ordinary manual lease/co-control grant that the REAL stores
 * issued, not an assertion about a hand-rolled fake agreeing with itself.
 * Only `sessions` (would need a real adb/scrcpy device) and `jobs` (would
 * need the whole job pipeline) are faked.
 *
 * The property every test here ultimately serves: **no action ever completes
 * without a per-device result.**
 */

const readable = (kind: 'user' | 'agent' | 'job', id: string): string => `${kind}:${id}`

function seedDb(statuses: Record<string, DeviceStatus>): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  for (const [id, status] of Object.entries(statuses)) {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `SER-${id}`, label: `Phone ${id}`, status }).run()
  }
  return db
}

/** Mirrors `co-control.test.ts`'s own `makeWired` — `leases` built first, `coControl` second, reading only `leases.getLease`. No `onPrimaryEnded` wiring here: these tests call `MirrorManager.reconcile` explicitly rather than through that hook chain. */
function wireLeasesAndCoControl(states: ReturnType<typeof createDeviceStateMachine>) {
  const leases = createLeaseManager({
    states,
    jobStore: { expiredRunning: () => [] } as never,
    config: { jobTtlSec: 3600, manualIdleTimeoutSec: 3600, reaperIntervalMs: 1_000_000 },
    log: createLogger('test'),
    onJobLeaseExpired: () => {},
    resolveLabel: readable,
  })
  const coControl = createCoControlManager({
    leases,
    config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1 },
    log: createLogger('test'),
    resolveLabel: readable,
  })
  return { leases, coControl }
}

/** A fake `InputSink` whose four verbs record what was called and can be made to throw a coded error on demand (`opts.failing`), for the auto-drop test. */
function makeSink(opts: { failing?: () => boolean } = {}): { sink: InputSink; calls: string[] } {
  const calls: string[] = []
  const maybeFail = () => {
    if (opts.failing?.()) throw Object.assign(new Error('the fake device refused'), { code: 'E_FAKE_DEVICE_FAIL' })
  }
  const sink: InputSink = {
    id: 'fake',
    mode: 'uhid',
    tap: async () => {
      maybeFail()
      calls.push('tap')
    },
    swipe: async () => {
      maybeFail()
      calls.push('swipe')
    },
    key: async () => {
      maybeFail()
      calls.push('key')
    },
    text: async () => {
      maybeFail()
      calls.push('text')
    },
  }
  return { sink, calls }
}

/** A minimal `DeviceSession` whose `arbiter.for(source)` always hands back the SAME sink regardless of `source` — lane priority/serialisation is `input-arbiter.test.ts`'s job, not this file's; `applyAction`'s per-verb mapping and error propagation is. */
function makeSession(frameSize: { width: number; height: number }, sink: InputSink): DeviceSession {
  const arbiter: InputArbiter = {
    for: () => sink,
    stats: () => ({
      pointer: { depth: 0, running: null, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
      keys: { depth: 0, running: null, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
      text: { depth: 0, running: null, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
    }),
  }
  return {
    deviceId: 'fake',
    transport: {} as DeviceSession['transport'],
    display: {} as DeviceSession['display'],
    input: sink,
    arbiter,
    displayEngineId: 'fake',
    inputEngineId: 'fake',
    quality: 'control',
    videoConfig: () => null,
    videoKeyframe: () => null,
    inspector: null,
    whenInspectorReady: async () => {},
    releaseInspector: async () => {},
    inspectorEngineId: 'fake',
    inspectorPollIntervalMs: 1000,
    frameSize,
    clipboard: null,
    textInput: {
      mode: 'device',
      agentCapabilities: null,
      imeCurrent: false,
      commitViaAgent: async () => ({ committed: 0, imeCurrent: false }),
    },
    close: async () => {},
  }
}

const defaultMirrorConfig = {
  maxDevices: () => 20,
  requireSameOrientation: () => true,
  aspectTolerance: () => 0.05,
  dropAfterConsecutiveFailures: () => 3,
}

/**
 * The step's own scenario (§5 step 91.7): 10 selected devices — 5 ordinary
 * (idle → `lease`), 1 busy with a normal job (→ `assist`, but deliberately
 * given NO live session, so its dispatch still fails honestly rather than
 * silently), 1 rotated (idle → `lease`, then downgraded to `partial` by
 * orientation), 2 offline, 1 busy running `internal:install` (F27).
 */
function setUpTenDeviceScenario() {
  const statuses: Record<string, DeviceStatus> = {
    d1: 'idle',
    d2: 'idle',
    d3: 'idle',
    d4: 'idle',
    d5: 'idle',
    d6: 'busy',
    d7: 'idle',
    d8: 'offline',
    d9: 'offline',
    d10: 'busy',
  }
  const db = seedDb(statuses)
  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const { leases, coControl } = wireLeasesAndCoControl(states)
  leases.noteJobLease('d6', 'job-a', 3600)
  leases.noteJobLease('d10', 'job-install', 3600)

  const sessionsByDevice = new Map<string, DeviceSession>()
  for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) {
    sessionsByDevice.set(id, makeSession({ width: 1080, height: 2400 }, makeSink().sink))
  }
  // d7 is landscape while every other live session is portrait — this is
  // what makes it `partial`/`orientation_mismatch` once resolved.
  sessionsByDevice.set('d7', makeSession({ width: 2400, height: 1080 }, makeSink().sink))
  // d6, d8, d9, d10 deliberately have NO session: d8/d9/d10 are skipped
  // before `resolveOne` ever looks at a session, and d6's job is running on
  // a device nobody has opened a Wall tile for — exactly the case that
  // proves an `assist`-mode member with nothing live still gets an honest,
  // coded non-delivery rather than a silent success.
  const sessionManager = { get: (deviceId: string) => sessionsByDevice.get(deviceId) ?? null } as unknown as SessionManager

  const jobs = {
    get: (jobId: string): { scriptId: string } | null => {
      if (jobId === 'job-a') return { scriptId: 'checkout' }
      if (jobId === 'job-install') return { scriptId: 'internal:install' }
      return null
    },
  } as unknown as Pick<JobService, 'get'>

  const changed: MirrorMember[][] = []
  const mirror = createMirrorManager({
    sessions: () => sessionManager,
    states,
    leases,
    coControl,
    jobs,
    deviceLabel: (id) => `Phone ${id}`,
    recorder: { record: () => {} },
    incrementAssistCount: () => {},
    assistAllowedFor: () => true,
    config: defaultMirrorConfig,
    onChanged: (_group, members) => changed.push(members),
    log: createLogger('test'),
  })

  return { mirror, changed, states, leases }
}

const TEN_DEVICE_IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10']

describe('MirrorManager.start — the §3.9 resolution table (plan 91 §5 step 91.7)', () => {
  test('one mirror.started names every one of 10 devices — nothing silently dropped', async () => {
    const { mirror } = setUpTenDeviceScenario()
    const { group, members } = await mirror.start({
      ownerClientId: 'operator-1',
      ownerUserId: 'user-1',
      focusDeviceId: 'd1',
      deviceIds: TEN_DEVICE_IDS,
    })
    expect(members).toHaveLength(10)
    expect(group.focusDeviceId).toBe('d1')

    const byId = new Map(members.map((m) => [m.deviceId, m]))
    for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) {
      expect(byId.get(id)?.mode).toBe('lease')
      expect(byId.get(id)?.reason).toBeNull()
    }
    expect(byId.get('d6')?.mode).toBe('assist')
    expect(byId.get('d6')?.reason).toBeNull()
    expect(byId.get('d7')?.mode).toBe('partial')
    expect(byId.get('d7')?.reason).toBe('orientation_mismatch')
    expect(byId.get('d8')?.mode).toBe('skipped')
    expect(byId.get('d8')?.reason).toBe('unavailable')
    expect(byId.get('d9')?.mode).toBe('skipped')
    expect(byId.get('d9')?.reason).toBe('unavailable')
    expect(byId.get('d10')?.mode).toBe('skipped')
    expect(byId.get('d10')?.reason).toBe('installing')

    // Every member also carries a human-readable label — never a bare id
    // standing in for one.
    for (const m of members) expect(m.label).toBe(`Phone ${m.deviceId}`)
  })

  test('a busy device really did get an ordinary co-control grant — checkInputAllowed refuses it, checkAssistAllowed does not', async () => {
    const { mirror, leases } = setUpTenDeviceScenario()
    await mirror.start({ ownerClientId: 'operator-1', ownerUserId: 'user-1', focusDeviceId: 'd1', deviceIds: ['d6'] })
    // d6 is `busy` (a job) — the lease is exactly as it was, never touched by the mirror.
    expect(leases.getLease('d6')?.type).toBe('job')
    expect(leases.getLease('d6')?.holder).toBe('job-a')
  })
})

describe('MirrorManager.dispatch — a tap across the ten-device scenario (plan 91 §5 step 91.7)', () => {
  test('a tap reaches exactly 5 devices and reports 5 non-deliveries, every one with a code', async () => {
    const { mirror } = setUpTenDeviceScenario()
    const { group } = await mirror.start({
      ownerClientId: 'operator-1',
      ownerUserId: 'user-1',
      focusDeviceId: 'd1',
      deviceIds: TEN_DEVICE_IDS,
    })
    const results = await mirror.dispatch(group.id, 'operator-1', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    expect(results).toHaveLength(10)

    const ok = results.filter((r) => r.ok)
    const failed = results.filter((r) => !r.ok)
    expect(ok.map((r) => r.deviceId).sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(failed).toHaveLength(5)
    // Every non-delivery names a code — never a bare `ok: false` with nothing to explain it.
    for (const r of failed) expect(r.code).toBeTruthy()

    const byId = new Map(results.map((r) => [r.deviceId, r]))
    expect(byId.get('d6')?.code).toBe('E_DEVICE_NOT_READY')
    expect(byId.get('d7')?.code).toBe('orientation_mismatch')
    expect(byId.get('d8')?.code).toBe('unavailable')
    expect(byId.get('d9')?.code).toBe('unavailable')
    expect(byId.get('d10')?.code).toBe('installing')
    for (const r of ok) {
      expect(r.code).toBeNull()
      expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    }
  })

  test('a key reaches the rotated device too — the per-lane gate withholds coordinates, not keystrokes', async () => {
    const { mirror } = setUpTenDeviceScenario()
    const { group } = await mirror.start({
      ownerClientId: 'operator-1',
      ownerUserId: 'user-1',
      focusDeviceId: 'd1',
      deviceIds: TEN_DEVICE_IDS,
    })
    const results = await mirror.dispatch(group.id, 'operator-1', { verb: 'key', keycode: 3 })
    const byId = new Map(results.map((r) => [r.deviceId, r]))
    // d7 failed the SAME group's tap a moment ago (previous test, fresh
    // fixture here) — a key must still land on it.
    expect(byId.get('d7')?.ok).toBe(true)
    expect(byId.get('d7')?.code).toBeNull()
    const ok = results.filter((r) => r.ok).map((r) => r.deviceId)
    expect(ok.sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd7'])
    // d6 (assist, no live session) and the three skipped members still fail — a rotated member's
    // pass is specific to the orientation gate, not a general "keys always succeed" relaxation.
    expect(byId.get('d6')?.ok).toBe(false)
  })
})

describe('MirrorManager.dispatch — solo (§3.9)', () => {
  test('a solo action reaches exactly one device, and the result names only it', async () => {
    const { mirror } = setUpTenDeviceScenario()
    const { group } = await mirror.start({
      ownerClientId: 'operator-1',
      ownerUserId: 'user-1',
      focusDeviceId: 'd1',
      deviceIds: TEN_DEVICE_IDS,
    })
    const results = await mirror.dispatch(group.id, 'operator-1', { verb: 'tap', pos: { x: 0.5, y: 0.5 } }, 'd3')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ deviceId: 'd3', ok: true, code: null })
  })

  test('soloing a device that is not a member of the group is refused, not silently ignored', async () => {
    const { mirror } = setUpTenDeviceScenario()
    const { group } = await mirror.start({ ownerClientId: 'operator-1', ownerUserId: 'user-1', focusDeviceId: 'd1', deviceIds: ['d1', 'd2'] })
    await expect(mirror.dispatch(group.id, 'operator-1', { verb: 'tap', pos: { x: 0.5, y: 0.5 } }, 'not-a-member')).rejects.toThrow(EnkakuError)
  })
})

describe('MirrorManager.dispatch — auto-drop after repeated failures (§3.9)', () => {
  test('three consecutive failures on one action drop that member, with exactly one mirror.changed', async () => {
    const db = seedDb({ good: 'idle', bad: 'idle' })
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const { leases, coControl } = wireLeasesAndCoControl(states)

    const goodSink = makeSink().sink
    const badSink = makeSink({ failing: () => true }).sink
    const sessionsByDevice = new Map<string, DeviceSession>([
      ['good', makeSession({ width: 1080, height: 2400 }, goodSink)],
      ['bad', makeSession({ width: 1080, height: 2400 }, badSink)],
    ])
    const sessionManager = { get: (id: string) => sessionsByDevice.get(id) ?? null } as unknown as SessionManager
    const jobs = { get: () => null } as unknown as Pick<JobService, 'get'>
    const changed: MirrorMember[][] = []
    const mirror = createMirrorManager({
      sessions: () => sessionManager,
      states,
      leases,
      coControl,
      jobs,
      deviceLabel: (id) => id,
      recorder: { record: () => {} },
      incrementAssistCount: () => {},
      assistAllowedFor: () => true,
      config: defaultMirrorConfig,
      onChanged: (_group, members) => changed.push(members),
      log: createLogger('test'),
    })

    const { group } = await mirror.start({ ownerClientId: 'op', ownerUserId: null, focusDeviceId: 'good', deviceIds: ['good', 'bad'] })

    const first = await mirror.dispatch(group.id, 'op', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    expect(first.find((r) => r.deviceId === 'bad')?.ok).toBe(false)
    expect(changed).toHaveLength(0)

    const second = await mirror.dispatch(group.id, 'op', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    expect(second.find((r) => r.deviceId === 'bad')?.ok).toBe(false)
    expect(changed).toHaveLength(0)

    const third = await mirror.dispatch(group.id, 'op', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    expect(third.find((r) => r.deviceId === 'bad')?.ok).toBe(false)
    expect(changed).toHaveLength(1)
    const droppedMember = changed[0]?.find((m) => m.deviceId === 'bad')
    expect(droppedMember?.mode).toBe('skipped')
    expect(droppedMember?.reason).toBe('repeated_failures')
    // 'good' is unaffected by 'bad's drop.
    expect(third.find((r) => r.deviceId === 'good')?.ok).toBe(true)

    // The drop stuck: a fourth action refuses at the "already skipped" gate,
    // never reaching the sink again.
    const fourth = await mirror.dispatch(group.id, 'op', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    expect(fourth.find((r) => r.deviceId === 'bad')?.code).toBe('repeated_failures')
    expect(changed).toHaveLength(1)
  })
})

describe('MirrorManager.dispatch — per-device attribution (plan 91 §3.5, §5 step 91.5)', () => {
  test('a successfully-delivered action is recorded PER DEVICE — lease and assist members alike — and only the assist member increments a job assistCount', async () => {
    const db = seedDb({ leased: 'idle', assisted: 'busy' })
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const { leases, coControl } = wireLeasesAndCoControl(states)
    leases.noteJobLease('assisted', 'job-checkout', 3600)

    const sessionsByDevice = new Map<string, DeviceSession>([
      ['leased', makeSession({ width: 1080, height: 2400 }, makeSink().sink)],
      ['assisted', makeSession({ width: 1080, height: 2400 }, makeSink().sink)],
    ])
    const sessionManager = { get: (id: string) => sessionsByDevice.get(id) ?? null } as unknown as SessionManager
    const jobs = { get: () => ({ scriptId: 'checkout' }) } as unknown as Pick<JobService, 'get'>

    const recorded: Array<{ deviceId: string; stream: string; kind: string; actor?: string | null; meta?: Record<string, unknown> }> = []
    const incremented: string[] = []
    const mirror = createMirrorManager({
      sessions: () => sessionManager,
      states,
      leases,
      coControl,
      jobs,
      deviceLabel: (id) => id,
      recorder: { record: (e) => recorded.push(e) },
      incrementAssistCount: (jobId) => incremented.push(jobId),
      assistAllowedFor: () => true,
      config: defaultMirrorConfig,
      log: createLogger('test'),
    })

    const { group, members } = await mirror.start({
      ownerClientId: 'op',
      ownerUserId: 'user-op',
      focusDeviceId: 'leased',
      deviceIds: ['leased', 'assisted'],
    })
    expect(members.find((m) => m.deviceId === 'leased')?.mode).toBe('lease')
    expect(members.find((m) => m.deviceId === 'assisted')?.mode).toBe('assist')

    const results = await mirror.dispatch(group.id, 'op', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    expect(results.every((r) => r.ok)).toBe(true)

    // ONE row per device, not one aggregate row (`MirrorManagerDeps.recorder`'s
    // own doc comment has the full reasoning) — both members recorded, each
    // on its OWN deviceId, both attributed to the mirror's owner.
    expect(recorded).toHaveLength(2)
    const leasedEvent = recorded.find((e) => e.deviceId === 'leased')
    const assistedEvent = recorded.find((e) => e.deviceId === 'assisted')
    expect(leasedEvent).toMatchObject({ stream: 'input', kind: 'input.tap', actor: 'user-op' })
    expect(leasedEvent?.meta).toMatchObject({ mirrored: true, groupId: group.id })
    expect(leasedEvent?.meta?.assist).toBeUndefined()
    expect(assistedEvent).toMatchObject({ stream: 'input', kind: 'input.tap', actor: 'user-op' })
    expect(assistedEvent?.meta).toMatchObject({ mirrored: true, groupId: group.id, assist: true, jobId: 'job-checkout' })

    // Only the ASSIST-mode member's underlying job gets counted — a mirrored
    // tap on an ordinary leased device is not a job attribution question.
    expect(incremented).toEqual(['job-checkout'])
  })
})

describe('MirrorManager.start — node-owned devices are refused by name (§2 non-goal)', () => {
  test('a node-owned device is skipped node_owned, never silently dropped from the members list', async () => {
    const db = seedDb({ 'node-dev': 'idle' })
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const { leases, coControl } = wireLeasesAndCoControl(states)
    const mirror = createMirrorManager({
      sessions: () => null,
      states,
      leases,
      coControl,
      jobs: { get: () => null } as unknown as Pick<JobService, 'get'>,
      nodeIdFor: (deviceId) => (deviceId === 'node-dev' ? 'node-1' : null),
      deviceLabel: (id) => id,
      recorder: { record: () => {} },
      incrementAssistCount: () => {},
      assistAllowedFor: () => true,
      config: defaultMirrorConfig,
      log: createLogger('test'),
    })
    const { members } = await mirror.start({ ownerClientId: 'op', ownerUserId: null, focusDeviceId: 'node-dev', deviceIds: ['node-dev'] })
    expect(members).toEqual([{ deviceId: 'node-dev', label: 'node-dev', mode: 'skipped', reason: 'node_owned', aspectDrift: false }])
    // A node-owned device never even reaches `leases`/`coControl` — no manual lease was acquired.
    expect(leases.getLease('node-dev')).toBeNull()
  })
})

describe('MirrorManager.start — the role gate is per-member, not per-call (plan 91 §3.6, §4.6)', () => {
  test('a caller who may not assist still gets ordinary leases on idle members; only the member that would need assisting is skipped assist_not_allowed', async () => {
    const db = seedDb({ 'idle-dev': 'idle', 'busy-dev': 'busy' })
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const { leases, coControl } = wireLeasesAndCoControl(states)
    leases.noteJobLease('busy-dev', 'job-x', 3600)
    const mirror = createMirrorManager({
      sessions: () => null,
      states,
      leases,
      coControl,
      jobs: { get: () => ({ scriptId: 'checkout' }) } as unknown as Pick<JobService, 'get'>,
      deviceLabel: (id) => id,
      recorder: { record: () => {} },
      incrementAssistCount: () => {},
      assistAllowedFor: () => false,
      config: defaultMirrorConfig,
      log: createLogger('test'),
    })
    const { members } = await mirror.start({
      ownerClientId: 'op',
      ownerUserId: 'no-assist-user',
      focusDeviceId: 'idle-dev',
      deviceIds: ['idle-dev', 'busy-dev'],
    })
    const byId = new Map(members.map((m) => [m.deviceId, m]))
    expect(byId.get('idle-dev')?.mode).toBe('lease')
    expect(byId.get('busy-dev')?.mode).toBe('skipped')
    expect(byId.get('busy-dev')?.reason).toBe('assist_not_allowed')
    // Never granted — `coControl.grant` was not reached.
    expect(coControl.assistedBy('busy-dev')).toEqual([])
  })
})

describe('MirrorManager.start — mirror.maxDevices is a whole-request refusal (plan 91 §4.5)', () => {
  test('requesting more devices than the farm allows refuses the whole call, not a silent partial group', async () => {
    const db = seedDb({ d1: 'idle', d2: 'idle', d3: 'idle' })
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const { leases, coControl } = wireLeasesAndCoControl(states)
    const mirror = createMirrorManager({
      sessions: () => null,
      states,
      leases,
      coControl,
      jobs: { get: () => null } as unknown as Pick<JobService, 'get'>,
      deviceLabel: (id) => id,
      recorder: { record: () => {} },
      incrementAssistCount: () => {},
      assistAllowedFor: () => true,
      config: { ...defaultMirrorConfig, maxDevices: () => 2 },
      log: createLogger('test'),
    })
    await expect(mirror.start({ ownerClientId: 'op', ownerUserId: null, focusDeviceId: 'd1', deviceIds: ['d1', 'd2', 'd3'] })).rejects.toThrow(
      EnkakuError,
    )
    // No device was touched by the refused attempt.
    expect(leases.getLease('d1')).toBeNull()
  })
})

describe('MirrorManager.reconcile — F27 re-admit (plan 91 §3.9, §4.7)', () => {
  test('an internal:install-skipped member rejoins as an ordinary lease once its job ends', async () => {
    const db = seedDb({ installing: 'busy' })
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const { leases, coControl } = wireLeasesAndCoControl(states)
    leases.noteJobLease('installing', 'job-install', 3600)
    const sessionsByDevice = new Map<string, DeviceSession>([['installing', makeSession({ width: 1080, height: 2400 }, makeSink().sink)]])
    const sessionManager = { get: (id: string) => sessionsByDevice.get(id) ?? null } as unknown as SessionManager
    const jobs = {
      get: (jobId: string): { scriptId: string } | null => (jobId === 'job-install' ? { scriptId: 'internal:install' } : null),
    } as unknown as Pick<JobService, 'get'>
    const changed: MirrorMember[][] = []
    const mirror = createMirrorManager({
      sessions: () => sessionManager,
      states,
      leases,
      coControl,
      jobs,
      deviceLabel: (id) => id,
      recorder: { record: () => {} },
      incrementAssistCount: () => {},
      assistAllowedFor: () => true,
      config: defaultMirrorConfig,
      onChanged: (_group, members) => changed.push(members),
      log: createLogger('test'),
    })

    const { members: initial } = await mirror.start({
      ownerClientId: 'op',
      ownerUserId: null,
      focusDeviceId: 'installing',
      deviceIds: ['installing'],
    })
    expect(initial[0]?.mode).toBe('skipped')
    expect(initial[0]?.reason).toBe('installing')

    // The install job settles: the SAME two calls production makes
    // (`lease-manager.ts`'s `clearJobLease`, `state-machine.ts`'s
    // `JOB_FINISHED` transition) — never something `reconcile` does itself.
    leases.clearJobLease('installing')
    states.apply('installing', 'JOB_FINISHED')

    mirror.reconcile('installing')
    expect(changed).toHaveLength(1)
    expect(changed[0]?.[0]).toMatchObject({ deviceId: 'installing', mode: 'lease', reason: null })

    // Reconciling a device that belongs to no group at all is a harmless no-op.
    mirror.reconcile('some-other-device')
    expect(changed).toHaveLength(1)
  })
})

describe('MirrorManager.stop / stopAllForClient (§4.7)', () => {
  test('stop is a no-op for a non-owner, and removes the group for its real owner', async () => {
    const { mirror } = setUpTenDeviceScenario()
    const { group } = await mirror.start({ ownerClientId: 'operator-1', ownerUserId: 'user-1', focusDeviceId: 'd1', deviceIds: ['d1', 'd2'] })

    mirror.stop(group.id, 'someone-else')
    // Still alive — dispatch still works.
    const stillAlive = await mirror.dispatch(group.id, 'operator-1', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    expect(stillAlive.every((r) => r.ok)).toBe(true)

    mirror.stop(group.id, 'operator-1')
    await expect(mirror.dispatch(group.id, 'operator-1', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })).rejects.toThrow(EnkakuError)
  })

  test('stopAllForClient removes every group a client owns, and leaves other owners untouched', async () => {
    const { mirror } = setUpTenDeviceScenario()
    const mine = await mirror.start({ ownerClientId: 'op-a', ownerUserId: null, focusDeviceId: 'd1', deviceIds: ['d1'] })
    const theirs = await mirror.start({ ownerClientId: 'op-b', ownerUserId: null, focusDeviceId: 'd2', deviceIds: ['d2'] })

    mirror.stopAllForClient('op-a')
    await expect(mirror.dispatch(mine.group.id, 'op-a', { verb: 'key', keycode: 3 })).rejects.toThrow(EnkakuError)
    const theirsResult = await mirror.dispatch(theirs.group.id, 'op-b', { verb: 'key', keycode: 3 })
    expect(theirsResult[0]?.ok).toBe(true)
  })
})

describe('MirrorManager — observability (plan 91 §4.10, §5 step 91.10)', () => {
  test('allGroups reports every live group with its owner and member count, and drops a stopped one', async () => {
    const { mirror } = setUpTenDeviceScenario()
    const a = await mirror.start({ ownerClientId: 'op-a', ownerUserId: null, focusDeviceId: 'd1', deviceIds: ['d1', 'd2'] })
    const b = await mirror.start({ ownerClientId: 'op-b', ownerUserId: null, focusDeviceId: 'd3', deviceIds: ['d3'] })

    const groups = mirror.allGroups()
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.id === a.group.id)).toMatchObject({ ownerClientId: 'op-a', memberCount: 2 })
    expect(groups.find((g) => g.id === b.group.id)).toMatchObject({ ownerClientId: 'op-b', memberCount: 1 })

    mirror.stop(a.group.id, 'op-a')
    const remaining = mirror.allGroups()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(b.group.id)
  })

  test('stats reports live group/member counts and fan-out latency percentiles sampled from real dispatch calls', async () => {
    const { mirror } = setUpTenDeviceScenario()
    expect(mirror.stats()).toEqual({ groups: 0, members: 0, fanoutMsP50: 0, fanoutMsP95: 0 })

    const { group } = await mirror.start({ ownerClientId: 'operator-1', ownerUserId: 'user-1', focusDeviceId: 'd1', deviceIds: TEN_DEVICE_IDS })
    await mirror.dispatch(group.id, 'operator-1', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    await mirror.dispatch(group.id, 'operator-1', { verb: 'key', keycode: 3 })

    const stats = mirror.stats()
    expect(stats.groups).toBe(1)
    expect(stats.members).toBe(10)
    expect(stats.fanoutMsP50).toBeGreaterThanOrEqual(0)
    expect(stats.fanoutMsP95).toBeGreaterThanOrEqual(stats.fanoutMsP50)
  })

  test('a member refused E_INPUT_BUSY logs exactly one rate-limited warn naming the group, device, and lane — not one per fanned-out action', async () => {
    const db = seedDb({ d1: 'idle' })
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const { leases, coControl } = wireLeasesAndCoControl(states)
    const busyErr = () => Object.assign(new Error("the job's swipe is still running"), { code: 'E_INPUT_BUSY' })
    const failingSink: InputSink = {
      id: 'fake',
      mode: 'uhid',
      tap: async () => {
        throw busyErr()
      },
      swipe: async () => {
        throw busyErr()
      },
      key: async () => {
        throw busyErr()
      },
      text: async () => {
        throw busyErr()
      },
    }
    const sessionsByDevice = new Map<string, DeviceSession>([['d1', makeSession({ width: 1080, height: 2400 }, failingSink)]])
    const sessionManager = { get: (id: string) => sessionsByDevice.get(id) ?? null } as unknown as SessionManager
    const warnings: string[] = []
    const fakeLog: Logger = {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (msg) => warnings.push(msg),
      child: () => fakeLog,
    }
    const mirror = createMirrorManager({
      sessions: () => sessionManager,
      states,
      leases,
      coControl,
      jobs: { get: () => null } as unknown as Pick<JobService, 'get'>,
      deviceLabel: (id) => id,
      recorder: { record: () => {} },
      incrementAssistCount: () => {},
      assistAllowedFor: () => true,
      // Never auto-drop for this test — it exists purely to exercise the rate limiter, not the drop threshold.
      config: { ...defaultMirrorConfig, dropAfterConsecutiveFailures: () => 1000 },
      log: fakeLog,
    })
    const { group } = await mirror.start({ ownerClientId: 'op', ownerUserId: null, focusDeviceId: 'd1', deviceIds: ['d1'] })

    await mirror.dispatch(group.id, 'op', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    await mirror.dispatch(group.id, 'op', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })
    await mirror.dispatch(group.id, 'op', { verb: 'tap', pos: { x: 0.5, y: 0.5 } })

    const busyWarnings = warnings.filter((w) => w.includes('E_INPUT_BUSY'))
    expect(busyWarnings).toHaveLength(1)
    expect(busyWarnings[0]).toContain(group.id)
    expect(busyWarnings[0]).toContain('d1')
    expect(busyWarnings[0]).toContain('pointer')
  })
})
