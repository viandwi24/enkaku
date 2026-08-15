import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createLogger } from '../util/logger'
import { createDeviceStateMachine } from '../device/state-machine'
import { EnkakuError } from '../util/errors'
import { createLeaseManager, type LeaseManager } from './lease-manager'
import { createCoControlManager, type CoControlManager } from './co-control'

/**
 * Plan 91 §4.2, §5 step 91.2 — the co-control grant store, wired exactly the
 * way `daemon.ts` wires it (`onPrimaryEnded` from `lease-manager.ts`'s own
 * `release()`/`clearJobLease()`/`onManualTakenOver`, back into
 * `coControl.onPrimaryEnded`).
 *
 * The one property every test in this file ultimately serves: **a grant can
 * never outlive the hold it was subordinate to** — proven here for all four
 * end reasons (job lease clears, manual holder releases, TTL, WS close/
 * `releaseAllForClient`), plus a fifth this step added beyond the plan's own
 * checklist (a takeover of the manual lease).
 */

const readable = (kind: 'user' | 'agent' | 'job', id: string): string => `${kind}:${id}`

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'd1', stableId: 'stable-1', serial: 'SER1', label: 'Phone One', status: 'idle' }).run()
  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  return { db, states }
}

/** Mirrors `daemon.ts`'s own wiring exactly: `leases` built first, `coControl` built second (it only ever reads `leases.getLease`), and `onPrimaryEnded`/`onManualTakenOver` on the lease manager both reach back into `coControl.onPrimaryEnded` through the SAME forward-ref pattern `daemon.ts` uses (`coControlRef`, assigned after `coControl` exists). */
function makeWired(opts: {
  states: ReturnType<typeof createDeviceStateMachine>
  grantTtlSec?: () => number
  maxConcurrentPerDevice?: () => number
  mode?: () => 'off' | 'admin' | 'operator'
  scriptAssistPolicy?: (jobId: string) => 'allow' | 'deny'
  reaperIntervalMs?: number
}): { leases: LeaseManager; coControl: CoControlManager } {
  let coControlRef: CoControlManager | null = null
  const leases = createLeaseManager({
    states: opts.states,
    jobStore: { expiredRunning: () => [] } as never,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 60, reaperIntervalMs: 1_000_000 },
    log: createLogger('test'),
    onJobLeaseExpired: () => {},
    resolveLabel: readable,
    onPrimaryEnded: (deviceId) => coControlRef?.onPrimaryEnded(deviceId),
    onManualTakenOver: ({ deviceId }) => coControlRef?.onPrimaryEnded(deviceId),
  })
  const coControl = createCoControlManager({
    leases,
    config: {
      grantTtlSec: opts.grantTtlSec ?? (() => 300),
      maxConcurrentPerDevice: opts.maxConcurrentPerDevice ?? (() => 1),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.scriptAssistPolicy ? { scriptAssistPolicy: opts.scriptAssistPolicy } : {}),
      ...(opts.reaperIntervalMs !== undefined ? { reaperIntervalMs: opts.reaperIntervalMs } : {}),
    },
    log: createLogger('test'),
    resolveLabel: readable,
  })
  coControlRef = coControl
  return { leases, coControl }
}

describe('CoControlManager.grant — refusals (plan 91 §3.2, §4.2)', () => {
  test('an idle device (no lease at all) is refused device_not_held', () => {
    const { states } = setUp()
    const { coControl } = makeWired({ states })
    expect(() => coControl.grant('d1', 'assist-a', 'user-a')).toThrow(EnkakuError)
    try {
      coControl.grant('d1', 'assist-a', 'user-a')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('device_not_held')
    }
  })

  test('a second grant on the same device is refused assist_taken, naming the holder', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')
    try {
      coControl.grant('d1', 'assist-b', 'user-b')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('assist_taken')
      // Names the CURRENT assisting holder (user-a), not the primary lease holder.
      expect((err as EnkakuError).message).toContain(readable('user', 'user-a'))
    }
  })

  test('re-granting the SAME (deviceId, clientId) is idempotent — refreshes the TTL instead of throwing assist_taken against itself', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    const first = coControl.grant('d1', 'assist-a', 'user-a')
    const second = coControl.grant('d1', 'assist-a', 'user-a')
    expect(second.grantedAt).toBe(first.grantedAt)
    expect(coControl.assistedBy('d1').length).toBe(1)
  })

  test('a farm-wide coControl.mode of "off" refuses with assist_not_allowed, even on a held device (defense in depth alongside canAssist)', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states, mode: () => 'off' })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    try {
      coControl.grant('d1', 'assist-a', 'user-a')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('assist_not_allowed')
    }
  })

  test('a script that declared assist: "deny" refuses with assist_denied_by_script, naming the job (plan 91 §3.6 — wired for real once step 91.5 lands)', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states, scriptAssistPolicy: (jobId) => (jobId === 'job-1' ? 'deny' : 'allow') })
    leases.noteJobLease('d1', 'job-1', 3600)
    try {
      coControl.grant('d1', 'assist-a', 'user-a')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('assist_denied_by_script')
    }
  })
})

describe('CoControlManager.grant — the two primary kinds a grant can be subordinate to', () => {
  test('a job-held device: primaryKind "job", jobId set, primaryHolderId is the jobId', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.noteJobLease('d1', 'job-1', 3600)
    const grant = coControl.grant('d1', 'assist-a', 'user-a')
    expect(grant.primaryKind).toBe('job')
    expect(grant.jobId).toBe('job-1')
    expect(grant.primaryHolderId).toBe('job-1')
  })

  test('a manual-held-by-another-operator device: primaryKind "user", jobId null — the §3.9 mirror table\'s "manual, held by someone else" row gets an ordinary Assist grant too, not just a busy/job device', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    const grant = coControl.grant('d1', 'assist-a', 'user-a')
    expect(grant.primaryKind).toBe('user')
    expect(grant.jobId).toBeNull()
    expect(grant.primaryHolderId).toBe('user-holder')
  })
})

describe('CoControlManager — the safety property: a grant can never outlive the hold it was subordinate to', () => {
  test('dies when the job lease clears (clearJobLease)', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.noteJobLease('d1', 'job-1', 3600)
    coControl.grant('d1', 'assist-a', 'user-a')
    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(true)

    leases.clearJobLease('d1')

    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(false)
    expect(coControl.assistedBy('d1')).toEqual([])
  })

  test('dies when the manual holder releases — a plain VOLUNTARY release with no reason, the everyday "Release control" case, not only an automatic revoke', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')
    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(true)

    // No `reason` argument — the voluntary path `ws-handlers.ts`'s explicit
    // `lease.release` message takes, which does NOT fire `onManualRevoked`
    // (that hook only fires for automatic revokes). `onPrimaryEnded` must
    // still fire, unconditionally.
    const released = leases.releaseManual('d1', 'holder-client')
    expect(released).toBe(true)

    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(false)
    expect(coControl.assistedBy('d1')).toEqual([])
  })

  test('dies on an AUTOMATIC revoke too (idle timeout) — onManualRevoked and onPrimaryEnded both fire, and both paths end the grant', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')

    expect(leases.releaseManual('d1', 'holder-client', 'idle_timeout')).toBe(true)

    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(false)
  })

  test('dies on the grant\'s own TTL, via the reaper — real timers, matching presence.test.ts\'s own pattern for lease-manager\'s idle-timeout reaper', async () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({
      states,
      // Zero TTL: overdue the instant the reaper's clock crosses into the
      // next whole second (grantedAt/expiresAt are unix SECONDS).
      grantTtlSec: () => 0,
      reaperIntervalMs: 100,
    })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')

    coControl.startReaper()
    await Bun.sleep(1200)
    coControl.stopReaper()

    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(false)
  })

  test('dies on WS close — releaseAllForClient ends every grant that client holds, farm-wide (two devices, one connection)', () => {
    const { db, states } = setUp()
    db.insert(devices).values({ id: 'd2', stableId: 'stable-2', serial: 'SER2', label: 'Phone Two', status: 'idle' }).run()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    leases.acquireManual('d2', 'other-holder-client', 'user-other-holder')
    coControl.grant('d1', 'assist-a', 'user-a')
    coControl.grant('d2', 'assist-a', 'user-a')
    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(true)
    expect(coControl.checkAssistAllowed('d2', 'assist-a').ok).toBe(true)

    coControl.releaseAllForClient('assist-a')

    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(false)
    expect(coControl.checkAssistAllowed('d2', 'assist-a').ok).toBe(false)
    expect(coControl.assistedBy('d1')).toEqual([])
    expect(coControl.assistedBy('d2')).toEqual([])
  })

  test('grantsForClient (plan 91 §5 step 91.5) — every grant the connection currently holds, farm-wide, read-only', () => {
    const { db, states } = setUp()
    db.insert(devices).values({ id: 'd2', stableId: 'stable-2', serial: 'SER2', label: 'Phone Two', status: 'idle' }).run()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    leases.acquireManual('d2', 'other-holder-client', 'user-other-holder')
    coControl.grant('d1', 'assist-a', 'user-a')
    coControl.grant('d2', 'assist-a', 'user-a')

    const grants = coControl.grantsForClient('assist-a')
    expect(grants.map((g) => g.deviceId).sort()).toEqual(['d1', 'd2'])
    expect(grants.every((g) => g.userId === 'user-a')).toBe(true)
    // Read-only — a second call sees the same live grants, not an emptied set.
    expect(coControl.grantsForClient('assist-a')).toHaveLength(2)
    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(true)

    // A client holding nothing gets an empty array, never null/undefined.
    expect(coControl.grantsForClient('nobody')).toEqual([])
  })

  test('dies on a takeover of the manual lease — the displaced holder\'s grant does not survive them being displaced (beyond this step\'s literal checklist, wired for the stated safety property)', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')
    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(true)

    // A takeover never calls `release()` — it is an atomic revoke-then-acquire.
    leases.acquireManual('d1', 'new-holder-client', 'user-new-holder', { takeOverFrom: 'holder-client' })

    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(false)
  })

  test('release() explicitly ("Stop assisting") ends exactly the caller\'s own grant and reports which reason', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')

    expect(coControl.release('d1', 'assist-a', 'released')).toBe(true)
    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(false)
    // A no-op, not a throw, for a grant that does not exist.
    expect(coControl.release('d1', 'assist-a', 'released')).toBe(false)
  })
})

describe('CoControlManager — touch, assistedBy, checkAssistAllowed (plan 91 §3.2, §4.4)', () => {
  test('touch refreshes the TTL; a grant no other client holds is invisible to checkAssistAllowed for anyone else', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    const grant = coControl.grant('d1', 'assist-a', 'user-a')
    const originalExpiry = grant.expiresAt

    coControl.touch('d1', 'assist-a')
    expect(coControl.assistedBy('d1')[0]?.expiresAt).toBeGreaterThanOrEqual(originalExpiry)

    // Never consulted by anything except input.* (step 91.4) — but on its
    // own terms, a different client (even the primary holder) has no grant.
    expect(coControl.checkAssistAllowed('d1', 'holder-client').ok).toBe(false)
    expect(coControl.checkAssistAllowed('d1', 'someone-else').ok).toBe(false)
  })

  test('assistedBy returns the wire LeaseHolder shape: kind "user", takeable false, never null/undefined for an unassisted device', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states })
    expect(coControl.assistedBy('d1')).toEqual([])

    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')
    const holders = coControl.assistedBy('d1')
    expect(holders).toHaveLength(1)
    expect(holders[0]).toMatchObject({ kind: 'user', id: 'user-a', label: readable('user', 'user-a'), runId: null, takeable: false })
  })

  test('maxConcurrentPerDevice > 1 allows more than one simultaneous grant, each independently trackable', () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states, maxConcurrentPerDevice: () => 2 })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')
    coControl.grant('d1', 'assist-b', 'user-b')
    expect(coControl.assistedBy('d1')).toHaveLength(2)
    expect(coControl.checkAssistAllowed('d1', 'assist-a').ok).toBe(true)
    expect(coControl.checkAssistAllowed('d1', 'assist-b').ok).toBe(true)

    coControl.release('d1', 'assist-a', 'released')
    expect(coControl.assistedBy('d1')).toHaveLength(1)
    expect(coControl.checkAssistAllowed('d1', 'assist-b').ok).toBe(true)
  })
})

describe('CoControlManager — observability (plan 91 §4.10, §5 step 91.10)', () => {
  test('activeGrantCount sums live grants across every device, farm-wide, and drops as they release', () => {
    const { db, states } = setUp()
    db.insert(devices).values({ id: 'd2', stableId: 'stable-2', serial: 'SER2', label: 'Phone Two', status: 'idle' }).run()
    const { leases, coControl } = makeWired({ states })
    expect(coControl.activeGrantCount()).toBe(0)

    leases.acquireManual('d1', 'holder-1', 'user-holder-1')
    leases.acquireManual('d2', 'holder-2', 'user-holder-2')
    coControl.grant('d1', 'assist-a', 'user-a')
    coControl.grant('d2', 'assist-b', 'user-b')
    expect(coControl.activeGrantCount()).toBe(2)

    coControl.release('d1', 'assist-a', 'released')
    expect(coControl.activeGrantCount()).toBe(1)
  })

  test('rawGrantSnapshot reports a grant past its own TTL even before anything has pruned it — the whole point of the "uncollected grants" leak detector', async () => {
    const { states } = setUp()
    // Zero TTL: expired the instant the clock crosses into the next whole
    // second (grantedAt/expiresAt are unix SECONDS) — but the reaper is
    // never started and no OTHER read (which would lazily prune) happens
    // in between, so nothing has collected it yet.
    const { leases, coControl } = makeWired({ states, grantTtlSec: () => 0 })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')

    await Bun.sleep(1100)

    const raw = coControl.rawGrantSnapshot()
    expect(raw).toHaveLength(1)
    expect(raw[0]?.deviceId).toBe('d1')
    expect(raw[0]?.clientId).toBe('assist-a')
    expect(raw[0]!.expiresAt).toBeLessThan(Math.floor(Date.now() / 1000))
    // activeGrantCount, unlike rawGrantSnapshot, prunes first — it must NOT count the same stale grant.
    expect(coControl.activeGrantCount()).toBe(0)
  })

  test('rawGrantSnapshot returns [] once the grant has actually been collected by the reaper', async () => {
    const { states } = setUp()
    const { leases, coControl } = makeWired({ states, grantTtlSec: () => 0, reaperIntervalMs: 100 })
    leases.acquireManual('d1', 'holder-client', 'user-holder')
    coControl.grant('d1', 'assist-a', 'user-a')

    coControl.startReaper()
    await Bun.sleep(1200)
    coControl.stopReaper()

    expect(coControl.rawGrantSnapshot()).toEqual([])
  })
})
