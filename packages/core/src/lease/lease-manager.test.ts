import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createLogger } from '../util/logger'
import { createDeviceStateMachine } from '../device/state-machine'
import { AGENT_LEASE_PREFIX, createLeaseManager, toHolder, type Lease, type ResolveLabel } from './lease-manager'

/**
 * Plan 71 §7 — "toHolder"/"resolveLabel": all three kinds; an unresolvable id
 * for each; `takeable` computed server-side per kind. "takeover": CAS
 * success; CAS failure naming the current holder; job refusal; atomicity (a
 * concurrent plain `acquireManual` during a takeover must lose, not
 * interleave); `lease.revoked` carrying the taker; the audit row.
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' }).run()
  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  return { db, states }
}

function makeLeases(opts: {
  states: ReturnType<typeof createDeviceStateMachine>
  resolveLabel?: ResolveLabel
  onManualTakenOver?: Parameters<typeof createLeaseManager>[0]['onManualTakenOver']
  onManualRevoked?: Parameters<typeof createLeaseManager>[0]['onManualRevoked']
}) {
  return createLeaseManager({
    states: opts.states,
    jobStore: { expiredRunning: () => [] } as never,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 60, reaperIntervalMs: 1_000_000 },
    log: createLogger('test'),
    onJobLeaseExpired: () => {},
    ...(opts.resolveLabel ? { resolveLabel: opts.resolveLabel } : {}),
    ...(opts.onManualTakenOver ? { onManualTakenOver: opts.onManualTakenOver } : {}),
    ...(opts.onManualRevoked ? { onManualRevoked: opts.onManualRevoked } : {}),
  })
}

describe('toHolder — the wire shape of a Lease (plan 71 §3.2, §7)', () => {
  test('a job lease: kind job, id/label from the job, never takeable, no runId', () => {
    const lease: Lease = { deviceId: 'd1', type: 'job', holder: 'job-1', acquiredAt: 100, expiresAt: 200 }
    const resolveLabel: ResolveLabel = (kind, id) => `${kind}:${id}`
    const holder = toHolder(lease, resolveLabel)
    expect(holder).toEqual({ kind: 'job', id: 'job-1', label: 'job:job-1', runId: null, takeable: false, acquiredAt: 100, expiresAt: 200, purpose: 'control' })
  })

  test('an agent lease (holder prefixed agent-run:): kind agent, id is the agent id (holderUserId), runId is the root run id, takeable', () => {
    const lease: Lease = { deviceId: 'd1', type: 'manual', holder: `${AGENT_LEASE_PREFIX}run-42`, holderUserId: 'agent-7', acquiredAt: 100, expiresAt: 200 }
    const resolveLabel: ResolveLabel = (kind, id) => `${kind}:${id}`
    const holder = toHolder(lease, resolveLabel)
    expect(holder).toEqual({ kind: 'agent', id: 'agent-7', label: 'agent:agent-7', runId: 'run-42', takeable: true, acquiredAt: 100, expiresAt: 200, purpose: 'control' })
  })

  test('a person lease: kind user, id is holderUserId when known, takeable', () => {
    const lease: Lease = { deviceId: 'd1', type: 'manual', holder: 'client-abc', holderUserId: 'user-9', acquiredAt: 100, expiresAt: 200 }
    const resolveLabel: ResolveLabel = (kind, id) => `${kind}:${id}`
    const holder = toHolder(lease, resolveLabel)
    expect(holder).toEqual({ kind: 'user', id: 'user-9', label: 'user:user-9', runId: null, takeable: true, acquiredAt: 100, expiresAt: 200, purpose: 'control' })
  })

  test('a person lease with no authenticated user (local mode, no login): falls back to the bare clientId', () => {
    const lease: Lease = { deviceId: 'd1', type: 'manual', holder: 'client-abc', holderUserId: null, acquiredAt: 100, expiresAt: 200 }
    const resolveLabel: ResolveLabel = (kind, id) => `${kind}:${id}`
    const holder = toHolder(lease, resolveLabel)
    expect(holder?.id).toBe('client-abc')
    expect(holder?.kind).toBe('user')
  })

  test('null lease → null holder', () => {
    expect(toHolder(null)).toBeNull()
  })

  test('an id resolveLabel cannot resolve renders a truthful, non-empty phrase — never empty, never the raw id (criterion 14)', () => {
    const unresolvable: ResolveLabel = (kind) => (kind === 'user' ? 'a signed-out client' : kind === 'agent' ? 'a deleted agent' : 'a deleted job')
    const userLease: Lease = { deviceId: 'd1', type: 'manual', holder: 'ghost-client-id', holderUserId: null, acquiredAt: 0, expiresAt: 0 }
    const agentLease: Lease = { deviceId: 'd1', type: 'manual', holder: `${AGENT_LEASE_PREFIX}gone`, holderUserId: 'ghost-agent-id', acquiredAt: 0, expiresAt: 0 }
    const jobLease: Lease = { deviceId: 'd1', type: 'job', holder: 'ghost-job-id', acquiredAt: 0, expiresAt: 0 }

    for (const [lease, forbidden] of [
      [userLease, 'ghost-client-id'],
      [agentLease, 'ghost-agent-id'],
      [jobLease, 'ghost-job-id'],
    ] as const) {
      const holder = toHolder(lease, unresolvable)!
      expect(holder.label.length).toBeGreaterThan(0)
      expect(holder.label).not.toBe(forbidden)
      expect(holder.label).not.toBe('')
    }
  })

  test('with no resolveLabel injected at all, the built-in default is still truthful and never a raw id', () => {
    const lease: Lease = { deviceId: 'd1', type: 'manual', holder: 'raw-client-id-xyz', holderUserId: null, acquiredAt: 0, expiresAt: 0 }
    const holder = toHolder(lease)! // no resolveLabel argument — default fallback
    expect(holder.label).not.toBe('raw-client-id-xyz')
    expect(holder.label.length).toBeGreaterThan(0)
  })

  test('takeable is false for a job and true for a user/agent, regardless of what resolveLabel returns', () => {
    const resolveLabel: ResolveLabel = () => 'whatever'
    expect(toHolder({ deviceId: 'd1', type: 'job', holder: 'j', acquiredAt: 0, expiresAt: 0 }, resolveLabel)!.takeable).toBe(false)
    expect(toHolder({ deviceId: 'd1', type: 'manual', holder: 'u', holderUserId: 'u', acquiredAt: 0, expiresAt: 0 }, resolveLabel)!.takeable).toBe(true)
    expect(toHolder({ deviceId: 'd1', type: 'manual', holder: `${AGENT_LEASE_PREFIX}r`, holderUserId: 'a', acquiredAt: 0, expiresAt: 0 }, resolveLabel)!.takeable).toBe(true)
  })
})

describe('acquireManual — ordinary acquire and refusal without takeOverFrom (plan 71 §3.4)', () => {
  test('acquires a free (idle) device', () => {
    const { states } = setUp()
    const leases = makeLeases({ states })
    const lease = leases.acquireManual('d1', 'client-a', 'user-a')
    expect(lease.holder).toBe('client-a')
    expect(leases.getLease('d1')?.holder).toBe('client-a')
  })

  test('a second caller with no takeOverFrom is refused device_held_by_other, naming the holder', () => {
    const { states } = setUp()
    const leases = makeLeases({ states, resolveLabel: (kind, id) => `${kind}:${id}` })
    leases.acquireManual('d1', 'client-a', 'user-a')
    expect(() => leases.acquireManual('d1', 'client-b', 'user-b')).toThrow(/user:user-a|device_held_by_other/i)
    try {
      leases.acquireManual('d1', 'client-b', 'user-b')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('device_held_by_other')
    }
    // The device is untouched — still held by the original caller.
    expect(leases.getLease('d1')?.holder).toBe('client-a')
  })
})

describe('acquireManual — takeover (plan 71 §3.4, §3.5, criteria 4, 8, 9, 10)', () => {
  test('a correct takeOverFrom succeeds: the CAS passes, the new holder wins, onManualTakenOver fires with the resolved names', () => {
    const { states } = setUp()
    const events: Array<{ deviceId: string; fromLabel: string | null; toLabel: string }> = []
    const leases = makeLeases({
      states,
      resolveLabel: (kind, id) => `${kind}:${id}`,
      onManualTakenOver: ({ deviceId, from, takenByLabel }) => events.push({ deviceId, fromLabel: from?.label ?? null, toLabel: takenByLabel }),
    })
    leases.acquireManual('d1', 'client-a', 'user-a')

    const taken = leases.acquireManual('d1', 'client-b', 'user-b', { takeOverFrom: 'client-a' })
    expect(taken.holder).toBe('client-b')
    expect(leases.getLease('d1')?.holder).toBe('client-b')
    expect(events).toEqual([{ deviceId: 'd1', fromLabel: 'user:user-a', toLabel: 'user:user-b' }])
  })

  /**
   * The bug plan 125 step 125.5 uncovered, and the reason it was total rather
   * than intermittent: `toHolder` publishes `lease.holderUserId ?? lease.holder`,
   * so on a farm with auth ON every `LeaseHolder.id` a browser ever saw was a
   * **userId** — while the CAS only accepted a **clientId**. The two can never
   * be equal, so EVERY takeover on an authenticated farm was refused. Plan 71
   * §3.4's whole path had been dead since auth shipped, and the field report in
   * plan 125 §0.8 ("take control keeps getting in the way") is what led here.
   *
   * The client sends back the id it was SHOWN, so both must be accepted.
   */
  test('takeOverFrom matching the holder USER id succeeds — the id an authenticated client is actually shown (plan 125 §0.8)', () => {
    const { states } = setUp()
    const leases = makeLeases({ states, resolveLabel: (kind, id) => `${kind}:${id}` })
    leases.acquireManual('d1', 'client-a', 'user-a')

    // 'user-a', not 'client-a' — exactly what `toHolder` put on the wire.
    const taken = leases.acquireManual('d1', 'client-b', 'user-b', { takeOverFrom: 'user-a' })
    expect(taken.holder).toBe('client-b')
    expect(leases.getLease('d1')?.holder).toBe('client-b')
  })

  test('widening the CAS does not weaken it: a stale USER id is still refused', () => {
    const { states } = setUp()
    const leases = makeLeases({ states, resolveLabel: (kind, id) => `${kind}:${id}` })
    leases.acquireManual('d1', 'client-a', 'user-a')
    leases.acquireManual('d1', 'client-b', 'user-b', { takeOverFrom: 'user-a' })
    // c still believes user-a holds it. Refused, naming the real holder.
    try {
      leases.acquireManual('d1', 'client-c', 'user-c', { takeOverFrom: 'user-a' })
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('lease_holder_changed')
      expect((err as { message?: string }).message).toContain('user:user-b')
    }
    expect(leases.getLease('d1')?.holder).toBe('client-b')
  })

  test('a stale takeOverFrom (the holder changed since the caller last looked) is refused with lease_holder_changed, naming who holds it NOW — the dialog re-asks rather than failing silently (criterion 8)', () => {
    const { states } = setUp()
    const leases = makeLeases({ states, resolveLabel: (kind, id) => `${kind}:${id}` })
    leases.acquireManual('d1', 'client-a', 'user-a')
    leases.acquireManual('d1', 'client-b', 'user-b', { takeOverFrom: 'client-a' }) // b takes over
    // c believes 'client-a' still holds it (a stale read) — refused, and the
    // device is left with its REAL current holder, client-b, untouched.
    expect(() => leases.acquireManual('d1', 'client-c', 'user-c', { takeOverFrom: 'client-a' })).toThrow()
    try {
      leases.acquireManual('d1', 'client-c', 'user-c', { takeOverFrom: 'client-a' })
    } catch (err) {
      expect((err as { code?: string }).code).toBe('lease_holder_changed')
      expect((err as { message?: string }).message).toContain('user:user-b')
    }
    expect(leases.getLease('d1')?.holder).toBe('client-b')
  })

  test('a job holding the device refuses a takeover UNCONDITIONALLY, whatever takeOverFrom names (plan 71 §3.4 table, criterion 7)', () => {
    const { states } = setUp()
    const leases = makeLeases({ states })
    states.apply('d1', 'JOB_CLAIMED')
    leases.noteJobLease('d1', 'job-1', 300)

    expect(() => leases.acquireManual('d1', 'client-a', 'user-a')).toThrow()
    expect(() => leases.acquireManual('d1', 'client-a', 'user-a', { takeOverFrom: 'job-1' })).toThrow()
    try {
      leases.acquireManual('d1', 'client-a', 'user-a', { takeOverFrom: 'job-1' })
    } catch (err) {
      expect((err as { code?: string }).code).toBe('device_busy_job')
    }
    // Still the job's lease, completely untouched.
    expect(leases.getLease('d1')?.type).toBe('job')
    expect(leases.getLease('d1')?.holder).toBe('job-1')
  })

  test('atomicity: there is no window in which the device is unheld during a takeover — a "concurrent" plain acquireManual (no takeOverFrom) issued immediately after must see the NEW holder and be refused, never slip into a gap (criterion 9)', () => {
    const { states } = setUp()
    const leases = makeLeases({ states, resolveLabel: (kind, id) => `${kind}:${id}` })
    leases.acquireManual('d1', 'client-a', 'user-a')

    // The takeover itself — synchronous, no `await` anywhere inside
    // `acquireManual` (lease-manager.ts's own comment on this). If it were
    // NOT atomic (e.g. release-then-acquire as two separate steps with a
    // tick between them), the plain acquire issued right after would be able
    // to land in that gap and see the device as idle/free.
    leases.acquireManual('d1', 'client-b', 'user-b', { takeOverFrom: 'client-a' })

    // A third party's plain acquire, issued the instant the takeover call
    // returns — simulating a request that raced the takeover and arrived
    // "at the same time". It must be refused (the device is never
    // observably unheld), and must be refused citing client-b — not a
    // leftover, stale reference to client-a or to "nobody".
    expect(() => leases.acquireManual('d1', 'client-c', 'user-c')).toThrow()
    try {
      leases.acquireManual('d1', 'client-c', 'user-c')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('device_held_by_other')
      expect((err as { message?: string }).message).toContain('user:user-b')
    }
    // The device status itself never dipped back to 'idle' at any point —
    // it stayed 'manual' throughout, which is only possible if no window
    // existed where the lease map had no entry for this device.
    expect(states.current('d1')).toBe('manual')
    expect(leases.getLease('d1')?.holder).toBe('client-b')
  })

  test('every takeover is audited with device, from, to, and actor (criterion 10) — asserted via the onManualTakenOver hook daemon.ts wires into the audit log', () => {
    const { states } = setUp()
    const audited: Array<{ deviceId: string; from: string | null; toUserId: string | null }> = []
    const leases = makeLeases({
      states,
      resolveLabel: (kind, id) => `${kind}:${id}`,
      onManualTakenOver: ({ deviceId, from, toUserId }) => audited.push({ deviceId, from: from?.label ?? null, toUserId }),
    })
    leases.acquireManual('d1', 'client-a', 'user-a')
    leases.acquireManual('d1', 'client-b', 'user-b', { takeOverFrom: 'client-a' })
    expect(audited).toHaveLength(1)
    expect(audited[0]).toEqual({ deviceId: 'd1', from: 'user:user-a', toUserId: 'user-b' })
  })

  test('the displaced holder is told: onManualTakenOver fires exactly once per takeover, never on an ordinary acquire', () => {
    const { states } = setUp()
    let takeoverCount = 0
    const leases = makeLeases({ states, onManualTakenOver: () => { takeoverCount++ } })
    leases.acquireManual('d1', 'client-a', 'user-a') // ordinary acquire — no takeover
    expect(takeoverCount).toBe(0)
    leases.releaseManual('d1', 'client-a')
    leases.acquireManual('d1', 'client-b', 'user-b') // ordinary acquire again (device was free) — still no takeover
    expect(takeoverCount).toBe(0)
  })
})

describe('lastManualReleaseAt / lastManualHolder — feeds the quiet-period wait (plan 71 §3.7)', () => {
  test('null before any manual lease has ever existed', () => {
    const { states } = setUp()
    const leases = makeLeases({ states })
    expect(leases.lastManualReleaseAt('d1')).toBeNull()
    expect(leases.lastManualHolder('d1')).toBeNull()
  })

  test('records the release time and the holder who just released, on an explicit release', () => {
    const { states } = setUp()
    const leases = makeLeases({ states, resolveLabel: (kind, id) => `${kind}:${id}` })
    leases.acquireManual('d1', 'client-a', 'user-a')
    const before = Math.floor(Date.now() / 1000)
    leases.releaseManual('d1', 'client-a')
    expect(leases.lastManualReleaseAt('d1')).toBeGreaterThanOrEqual(before)
    expect(leases.lastManualHolder('d1')?.label).toBe('user:user-a')
  })

  test('after a takeover, a subsequent release correctly attributes to the NEW holder (not the one displaced earlier)', () => {
    const { states } = setUp()
    const leases = makeLeases({ states, resolveLabel: (kind, id) => `${kind}:${id}` })
    leases.acquireManual('d1', 'client-a', 'user-a')
    leases.acquireManual('d1', 'client-b', 'user-b', { takeOverFrom: 'client-a' })
    leases.releaseManual('d1', 'client-b')
    expect(leases.lastManualHolder('d1')?.label).toBe('user:user-b')
  })
})

describe('releaseAll — the adb restart flow\'s farm-wide drain (plan 88 §3.10, §4.8, fixes F19)', () => {
  function setUpFarm() {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db as Db
    db.insert(devices)
      .values([
        { id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' },
        { id: 'd2', stableId: 'stable-2', serial: 'SER2', label: 'Phone Two', status: 'idle' },
        { id: 'd3', stableId: 'stable-3', serial: 'SER3', label: 'Phone Three', status: 'idle' },
      ])
      .run()
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    return { db, states }
  }

  test('releases every manual lease farm-wide with the given reason, and returns the count', () => {
    const { states } = setUpFarm()
    const revoked: Array<{ deviceId: string; reason: string }> = []
    const leases = makeLeases({
      states,
      onManualRevoked: (deviceId, reason) => {
        revoked.push({ deviceId, reason })
      },
    })
    leases.acquireManual('d1', 'client-a')
    leases.acquireManual('d2', 'client-b')
    // d3 stays idle — never leased, so it must not appear in the count or the revoke callback.

    const count = leases.releaseAll?.({ reason: 'adb-server-restart' })

    expect(count).toBe(2)
    expect(leases.getLease('d1')).toBeNull()
    expect(leases.getLease('d2')).toBeNull()
    expect(revoked.sort((a, b) => a.deviceId.localeCompare(b.deviceId))).toEqual([
      { deviceId: 'd1', reason: 'adb-server-restart' },
      { deviceId: 'd2', reason: 'adb-server-restart' },
    ])
  })

  test('never touches a JOB lease — only a manual one', () => {
    const { states } = setUpFarm()
    const leases = makeLeases({ states })
    leases.acquireManual('d1', 'client-a')
    leases.noteJobLease('d2', 'job-1', 60)

    const count = leases.releaseAll?.({ reason: 'adb-server-restart' })

    expect(count).toBe(1)
    expect(leases.getLease('d1')).toBeNull()
    expect(leases.getLease('d2')?.type).toBe('job')
  })

  test('no manual leases held: returns 0 and revokes nobody', () => {
    const { states } = setUpFarm()
    const revoked: string[] = []
    const leases = makeLeases({
      states,
      onManualRevoked: (deviceId) => {
        revoked.push(deviceId)
      },
    })

    const count = leases.releaseAll?.({ reason: 'adb-server-restart' })

    expect(count).toBe(0)
    expect(revoked).toEqual([])
  })
})

describe('releaseDevice — the per-device disconnect flow\'s forced release (plan 88 §3.7, §4.6, §5 step 88.4)', () => {
  function setUpFarm() {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db as Db
    db.insert(devices)
      .values([
        { id: 'd1', stableId: 'stable-1', serial: '10.0.0.5:5555', label: 'Phone One', status: 'idle' },
        { id: 'd2', stableId: 'stable-2', serial: 'SER2', label: 'Phone Two', status: 'idle' },
      ])
      .run()
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    return { db, states }
  }

  test('force-releases a manual lease regardless of WHO holds it — unlike releaseManual, no clientId match is needed', () => {
    const { states } = setUpFarm()
    const revoked: Array<{ deviceId: string; reason: string; holderUserId: string | null }> = []
    const leases = makeLeases({
      states,
      onManualRevoked: (deviceId, reason, holderUserId) => {
        revoked.push({ deviceId, reason, holderUserId })
      },
    })
    leases.acquireManual('d1', 'someone-elses-browser-tab', 'user-a')

    const released = leases.releaseDevice?.('d1', 'disconnected')

    expect(released).toBe(true)
    expect(leases.getLease('d1')).toBeNull()
    expect(revoked).toEqual([{ deviceId: 'd1', reason: 'disconnected', holderUserId: 'user-a' }])
  })

  test('a no-op (returns false) when the device carries no manual lease — a caller need not check getHolder first', () => {
    const { states } = setUpFarm()
    const leases = makeLeases({ states })

    const released = leases.releaseDevice?.('d2', 'disconnected')

    expect(released).toBe(false)
  })

  test('never touches a JOB lease', () => {
    const { states } = setUpFarm()
    const leases = makeLeases({ states })
    leases.noteJobLease('d1', 'job-1', 60)

    const released = leases.releaseDevice?.('d1', 'disconnected')

    expect(released).toBe(false)
    expect(leases.getLease('d1')?.type).toBe('job')
  })
})
