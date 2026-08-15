import type { DeviceStatus, LeaseHolder } from '@enkaku/protocol'
import type { DeviceStateMachine } from '../device/state-machine'
import type { JobStore } from '../queue/job-store'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

export type LeaseType = 'manual' | 'job'

/**
 * Why a manual lease ended without its holder asking (plan 88 §3.10, §4.8
 * adds `'adb-server-restart'` to the pre-existing three — a restart drains
 * every manual lease farm-wide, same as an idle timeout or a quarantine, and
 * the holder deserves the same honest reason on the wire and in the log).
 */
export type ManualReleaseReason = 'idle_timeout' | 'disconnected' | 'quarantined' | 'adb-server-restart'

/**
 * What a hold is FOR (plan 93 §3.8, §4.3, §5 step 93.3) — legibility for the
 * `lease.changed` broadcast a fan-out's per-member acquire/release traffic
 * generates (H4): Studio's holder badge can read "running a command" for a
 * sub-second `'command'` hold instead of "alice took control", the same
 * distinction a takeover already gets its own wording for. Defaults to
 * `'control'` EVERYWHERE ELSE in this file — every existing acquire path is
 * unchanged, and only the command console's own `acquireManual(..., {
 * purpose: 'command' })` call (`command-console/runner.ts`) ever passes the
 * other value.
 */
export type LeasePurpose = 'control' | 'command'

export interface Lease {
  deviceId: string
  type: LeaseType
  /** manual: the WS connection's clientId (or `agent-run:<rootRunId>` for an agent run, plan 67 §3.7); job: the jobId. */
  holder: string
  /** manual: the authenticated user who holds it, when known (plan 18 §4.2 actor) — an agent-held lease carries the agent's id here instead (`agent/loop/run.ts`'s `ensureControlLease`). */
  holderUserId?: string | null
  acquiredAt: number
  expiresAt: number
  /**
   * Plan 93 §3.8 — see `LeasePurpose`'s own doc comment. Optional, not
   * required, so every hand-written `Lease`-shaped fake across this repo's
   * test suite (`api/device-identity.test.ts`, `api/guest-agent.test.ts`,
   * `capability/context.test.ts`, and this file's own) keeps compiling with
   * NO edit — "nothing changes for existing callers" applies to test fakes
   * too, not only to production call sites. Treated as `'control'` wherever
   * it is read (`toHolder` below); a real lease this process constructs
   * always sets it explicitly (`acquireManual`, `noteJobLease`).
   */
  purpose?: LeasePurpose
}

/**
 * `toHolder`'s return type: `LeaseHolder` (plan 71, `@enkaku/protocol`)
 * widened with `purpose` (plan 93 §3.8). Declared locally rather than in the
 * wire schema itself because `packages/protocol/src/device.ts` — where
 * `LeaseHolderSchema` lives — is out of this step's reach (held by a
 * concurrent worker on plan 94 step 94.2 per this step's own brief); adding
 * `purpose` to the WIRE schema is step 93.4's job. Every existing caller
 * that treats a `toHolder`/`getHolder`/`lastManualHolder` result as a plain
 * `LeaseHolder` keeps compiling unchanged (a wider object is assignable to
 * the narrower type it structurally contains); once 93.4 lands the schema
 * field, this local alias becomes redundant and can be dropped in favour of
 * the real `LeaseHolder` type with no call-site change here.
 */
export type ResolvedLeaseHolder = LeaseHolder & { purpose: LeasePurpose }

export interface LeaseConfig {
  jobTtlSec: number
  manualIdleTimeoutSec: number
  reaperIntervalMs: number
}

/** An agent-held manual lease's `holder` is `agent-run:<rootRunId>` (plan 67 §3.7) — this is the
 * one place that prefix is both written (`agent/loop/run.ts`) and read (`toHolder` below). */
export const AGENT_LEASE_PREFIX = 'agent-run:'

/**
 * Resolves a holder id to a display label (plan 71 §3.3) — injected so the
 * lease manager itself never learns about users, agents, or jobs. Must
 * never return an empty string or the raw id; an id it cannot resolve
 * becomes a truthful phrase ('a signed-out client', 'a deleted agent', ...).
 */
export type ResolveLabel = (kind: 'user' | 'agent' | 'job', id: string) => string

/** Used only when no `resolveLabel` is supplied (tests, and hosts that predate this plan) — honest and generic, never the raw id. */
const defaultResolveLabel: ResolveLabel = (kind) => (kind === 'user' ? 'a client' : kind === 'agent' ? 'an agent' : 'a job')

/** Pure — exported for `toHolder.test.ts`. Converts an internal `Lease` into the wire `LeaseHolder` shape (plan 71 §3.2), widened with `purpose` (plan 93 §3.8, see `ResolvedLeaseHolder`'s own doc comment), or `null` for no lease. `takeable` is computed here, server-side, once — never left for a client to derive (plan 71 §3.2's own reasoning). */
export function toHolder(lease: Lease | null, resolveLabel: ResolveLabel = defaultResolveLabel): ResolvedLeaseHolder | null {
  if (!lease) return null
  if (lease.type === 'job') {
    return {
      kind: 'job',
      id: lease.holder,
      label: resolveLabel('job', lease.holder),
      runId: null,
      takeable: false,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      purpose: lease.purpose ?? 'control',
    }
  }
  if (lease.holder.startsWith(AGENT_LEASE_PREFIX)) {
    const runId = lease.holder.slice(AGENT_LEASE_PREFIX.length)
    const agentId = lease.holderUserId ?? ''
    return {
      kind: 'agent',
      id: agentId,
      label: resolveLabel('agent', agentId),
      runId,
      takeable: true,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      purpose: lease.purpose ?? 'control',
    }
  }
  // A person — `holderUserId` when authenticated, else the bare WS clientId
  // (local mode with no login, or a connection established before auth was
  // wired through). Either way `resolveLabel` gets SOME id to try; an id
  // that is not a real persisted user (the clientId case) resolves to the
  // truthful 'a signed-out client' fallback rather than a raw id.
  const id = lease.holderUserId ?? lease.holder
  return {
    kind: 'user',
    id,
    label: resolveLabel('user', id),
    runId: null,
    takeable: true,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    purpose: lease.purpose ?? 'control',
  }
}

export interface LeaseManager {
  /**
   * `opts.takeOverFrom` (plan 71 §3.4) is the id of the holder the CALLER
   * believes currently holds the device (`Lease.holder`). Omitted: an
   * ordinary acquire, refused with `device_held_by_other` if someone else
   * already holds it. Present: a takeover — compare-and-swap against the
   * CURRENT holder, refused with `lease_holder_changed` (naming who holds it
   * now) if it no longer matches, and refused with `device_busy_job`
   * unconditionally when a job holds the device (never takeable, whatever is
   * passed). A successful takeover revokes and acquires atomically — no
   * `await` ever separates the read of the current holder from the write of
   * the new one, so no window exists for a third party to slip in.
   *
   * `opts.purpose` (plan 93 §3.8) — defaults to `'control'` when omitted, so
   * every existing caller is unchanged. The command console's runner is the
   * only caller that ever passes `'command'`.
   */
  acquireManual(deviceId: string, clientId: string, userId?: string | null, opts?: { takeOverFrom?: string; purpose?: LeasePurpose }): Lease
  touchManual(deviceId: string, clientId: string): void
  releaseManual(deviceId: string, clientId: string, reason?: ManualReleaseReason): boolean
  releaseAllForClient(clientId: string): void
  /**
   * Every manual lease, farm-wide, released with one named reason (plan 88
   * §3.10, §4.8) — the adb restart flow's own drain, alongside
   * `SessionManager.closeAll`. Job leases are untouched here: a running job
   * is the caller's own concern (the restart route's `E_ADB_BUSY_FARM`
   * guard), not something this method silently clears. Returns the number of
   * manual leases actually released, for `AdbCycleReport.leasesReleased`.
   *
   * Optional (unlike the rest of this interface) so the many existing
   * hand-written `LeaseManager` fakes across the test suite — several in
   * files this step deliberately avoids touching while `packages/core/src/api/devices.ts`
   * is under concurrent edit elsewhere — do not all need a stub added for a
   * method they never exercise. `createLeaseManager` below always provides
   * it; only a fake may omit it.
   */
  releaseAll?(opts: { reason: ManualReleaseReason }): number
  /**
   * Force-releases ONE device's manual lease, regardless of who holds it
   * (plan 88 §3.7, §4.6, §5 step 88.4: "a successful disconnect ... releases
   * the manual lease first"). Unlike `releaseManual`, which only succeeds
   * when `clientId` matches the current holder, an operator's explicit
   * Disconnect action is not the holder asking to give it back — it is the
   * same "someone else's concern overrides the hold" shape `releaseAll`
   * already has, scoped to one device instead of the whole farm. A no-op
   * (returns `false`) when the device carries no manual lease at all, so a
   * caller does not need to check `getHolder` first. Optional for the same
   * reason `releaseAll` is: several hand-written `LeaseManager` fakes across
   * the test suite do not need a stub added for a method they never exercise.
   */
  releaseDevice?(deviceId: string, reason: ManualReleaseReason): boolean
  noteJobLease(deviceId: string, jobId: string, ttlSec: number): void
  clearJobLease(deviceId: string): void
  getLease(deviceId: string): Lease | null
  /** The wire shape of `getLease` (plan 71 §3.2) — `null` when nobody holds the device. */
  getHolder(deviceId: string): LeaseHolder | null
  /**
   * Unix seconds of the last time a MANUAL lease on this device ended, for
   * any reason (release, idle timeout, disconnect, quarantine, or being
   * taken over) — `null` if it has never had one. The quiet-period wait
   * (plan 71 §3.7) reads this; nothing else does.
   */
  lastManualReleaseAt(deviceId: string): number | null
  /** Who last held the device manually, before its most recent release — the quiet-period wait's "who it is waiting to be free from" (plan 71 §3.7). `null` if it has never had a manual lease. */
  lastManualHolder(deviceId: string): LeaseHolder | null
  /** Input authorisation per spec §10.1 and plan 04 §4.1. */
  checkInputAllowed(deviceId: string, clientId: string): { ok: true } | { ok: false; code: string; message: string }
  startReaper(): void
  stopReaper(): void
}

export interface LeaseManagerDeps {
  states: DeviceStateMachine
  jobStore: JobStore
  config: LeaseConfig
  log: Logger
  /** An expired job lease fails the job and force-releases the device (spec §10.2). */
  onJobLeaseExpired: (jobId: string, reason: string) => void
  onManualRevoked?: (deviceId: string, reason: ManualReleaseReason, holderUserId: string | null) => void
  /**
   * A successful takeover (plan 71 §3.5) — the displaced holder (`from`,
   * already resolved to a `LeaseHolder`, or null defensively if the map and
   * the state machine had drifted) and the taker's resolved label. Fired
   * synchronously, in the same tick as the CAS itself.
   */
  onManualTakenOver?: (info: { deviceId: string; from: LeaseHolder | null; toClientId: string; toUserId: string | null; takenByLabel: string }) => void
  onDeviceFreed?: () => void
  /**
   * The PRIMARY hold on a device just ended (plan 91 §3.2, §4.2: a
   * co-control grant is "revoked the instant the primary hold ends"). Fired
   * UNCONDITIONALLY from `release()` — a voluntary `releaseManual` with no
   * `reason` included, not only the automatic paths — and from
   * `clearJobLease()`. Deliberately a SEPARATE hook from `onManualRevoked`
   * below: that one's job is telling the ex-holder "this was taken from you
   * without your asking" (so it is silent on a plain voluntary release,
   * which needs no such notice); this one's job is telling anything
   * SUBORDINATE to the hold — today, only the co-control grant store,
   * `daemon.ts`'s `coControl.onPrimaryEnded` — that whatever it was riding
   * on top of is gone, however that happened. A takeover (`onManualTakenOver`
   * below) does not flow through this hook either, because it never calls
   * `release()`; `daemon.ts` calls `coControl.onPrimaryEnded` directly from
   * its own `onManualTakenOver` handler for that path instead.
   */
  onPrimaryEnded?: (deviceId: string) => void
  /** Injected (plan 71 §3.3) — resolves a holder id to a display label. Defaults to a generic, honest, never-empty, never-raw-id fallback when omitted (existing hosts/tests that predate this plan). */
  resolveLabel?: ResolveLabel
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

export function createLeaseManager(deps: LeaseManagerDeps): LeaseManager {
  const { states, jobStore, config, log } = deps
  const resolveLabel = deps.resolveLabel ?? defaultResolveLabel
  const leases = new Map<string, Lease>()
  const lastManualRelease = new Map<string, { at: number; holder: LeaseHolder | null }>()
  let reaper: ReturnType<typeof setInterval> | null = null

  function release(deviceId: string, reason?: ManualReleaseReason): boolean {
    const lease = leases.get(deviceId)
    if (!lease || lease.type !== 'manual') return false
    leases.delete(deviceId)
    lastManualRelease.set(deviceId, { at: nowSec(), holder: toHolder(lease, resolveLabel) })
    states.apply(deviceId, 'MANUAL_RELEASED')
    if (reason) deps.onManualRevoked?.(deviceId, reason, lease.holderUserId ?? null)
    deps.onDeviceFreed?.()
    // Unconditional — a plain voluntary release ends the primary hold just
    // as much as an automatic one does (plan 91 §3.2). See this hook's own
    // doc comment above for why it is not folded into `onManualRevoked`.
    deps.onPrimaryEnded?.(deviceId)
    return true
  }

  return {
    acquireManual(deviceId, clientId, userId, opts) {
      const existing = leases.get(deviceId)
      if (existing?.type === 'manual' && existing.holder === clientId) {
        existing.expiresAt = nowSec() + config.manualIdleTimeoutSec
        return existing
      }
      const status = states.current(deviceId) as DeviceStatus | null
      if (status === null) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
      if (status === 'busy') {
        // A job's hold is never takeable, whatever is passed (plan 71 §3.4) — the device is
        // genuinely in use; the operator's route is to wait or cancel the job.
        throw new EnkakuError('device_busy_job', 'a job is running on this device — wait for it to finish or cancel it')
      }
      if (status === 'manual') {
        const current = existing ?? null
        const currentHolder = toHolder(current, resolveLabel)
        if (!opts?.takeOverFrom) {
          throw new EnkakuError('device_held_by_other', `the device is controlled by ${currentHolder?.label ?? 'another client'}`)
        }
        if (!current || opts.takeOverFrom !== current.holder) {
          // The CAS failed: the dialog was drawn against a holder who is no
          // longer the real one (plan 71 §3.4, §8) — refused, naming whoever
          // holds it NOW, never silently displacing them.
          throw new EnkakuError('lease_holder_changed', `the device is now held by ${currentHolder?.label ?? 'someone else'}`)
        }
        // Compare-and-swap passed. Revoke-then-acquire atomically: this whole
        // branch is synchronous — no `await` anywhere between reading
        // `current` above and writing the new lease below — so there is no
        // tick in which the device is unheld and a third party could slip in
        // (plan 71 §3.4, criterion 9).
        const lease: Lease = {
          deviceId,
          type: 'manual',
          holder: clientId,
          holderUserId: userId ?? null,
          acquiredAt: nowSec(),
          expiresAt: nowSec() + config.manualIdleTimeoutSec,
          purpose: opts?.purpose ?? 'control',
        }
        leases.set(deviceId, lease)
        // The device stays in the SAME `manual` status — there is no
        // idle→manual transition to apply for a takeover, only a change of
        // who the holder is.
        const takenByLabel = toHolder(lease, resolveLabel)?.label ?? 'another client'
        log.info(`manual lease taken over: device=${deviceId} from=${current.holder} to=${clientId}`)
        deps.onManualTakenOver?.({ deviceId, from: currentHolder, toClientId: clientId, toUserId: userId ?? null, takenByLabel })
        return lease
      }
      if (status !== 'idle') {
        throw new EnkakuError('device_unavailable', `the device is unavailable (status ${status})`)
      }
      const applied = states.apply(deviceId, 'MANUAL_ACQUIRED')
      if (!applied) throw new EnkakuError('device_busy', 'someone else claimed the device first')
      const lease: Lease = {
        deviceId,
        type: 'manual',
        holder: clientId,
        holderUserId: userId ?? null,
        acquiredAt: nowSec(),
        expiresAt: nowSec() + config.manualIdleTimeoutSec,
        purpose: opts?.purpose ?? 'control',
      }
      leases.set(deviceId, lease)
      log.info(`manual lease acquired: device=${deviceId} client=${clientId}`)
      return lease
    },

    touchManual(deviceId, clientId) {
      const lease = leases.get(deviceId)
      if (lease?.type === 'manual' && lease.holder === clientId) {
        lease.expiresAt = nowSec() + config.manualIdleTimeoutSec
      }
    },

    releaseManual(deviceId, clientId, reason) {
      const lease = leases.get(deviceId)
      if (!lease || lease.type !== 'manual' || lease.holder !== clientId) return false
      log.info(`manual lease released: device=${deviceId} client=${clientId}${reason ? ` (${reason})` : ''}`)
      return release(deviceId, reason)
    },

    releaseAllForClient(clientId) {
      for (const [deviceId, lease] of [...leases]) {
        if (lease.type === 'manual' && lease.holder === clientId) release(deviceId)
      }
    },

    releaseAll(opts) {
      let count = 0
      for (const [deviceId, lease] of [...leases]) {
        if (lease.type === 'manual' && release(deviceId, opts.reason)) count++
      }
      return count
    },

    releaseDevice(deviceId, reason) {
      return release(deviceId, reason)
    },

    noteJobLease(deviceId, jobId, ttlSec) {
      leases.set(deviceId, {
        deviceId,
        type: 'job',
        holder: jobId,
        acquiredAt: nowSec(),
        expiresAt: nowSec() + ttlSec,
        // A job lease has no console-command shape to speak of; 'control' is
        // the only meaningful value and matches every other non-command hold.
        purpose: 'control',
      })
    },

    clearJobLease(deviceId) {
      const lease = leases.get(deviceId)
      if (lease?.type === 'job') {
        leases.delete(deviceId)
        // Plan 91 §3.2 — a job lease clearing ends the primary hold a
        // co-control grant on this device was subordinate to, exactly like a
        // manual release does above.
        deps.onPrimaryEnded?.(deviceId)
      }
    },

    getLease(deviceId) {
      return leases.get(deviceId) ?? null
    },

    getHolder(deviceId) {
      return toHolder(leases.get(deviceId) ?? null, resolveLabel)
    },

    lastManualReleaseAt(deviceId) {
      return lastManualRelease.get(deviceId)?.at ?? null
    },

    lastManualHolder(deviceId) {
      return lastManualRelease.get(deviceId)?.holder ?? null
    },

    checkInputAllowed(deviceId, clientId) {
      const status = states.current(deviceId) as DeviceStatus | null
      if (status === null) return { ok: false, code: 'device_not_found', message: 'no such device' }
      if (status === 'busy') {
        return { ok: false, code: 'device_busy', message: 'Device is running an automation job' }
      }
      if (status === 'offline' || status === 'quarantined') {
        return { ok: false, code: 'device_unavailable', message: `the device is unavailable (status ${status})` }
      }
      if (status === 'idle') {
        return { ok: false, code: 'no_lease', message: 'take control (lease.acquire) before sending input' }
      }
      const lease = leases.get(deviceId)
      if (!lease || lease.type !== 'manual') {
        return { ok: false, code: 'no_lease', message: 'no manual lease is active' }
      }
      if (lease.holder !== clientId) {
        return { ok: false, code: 'not_lease_holder', message: 'another client is controlling this device' }
      }
      return { ok: true }
    },

    startReaper() {
      if (reaper) return
      reaper = setInterval(() => {
        // Job lease expired → job failed + device force-release (spec §10.2).
        for (const job of jobStore.expiredRunning()) {
          log.warn(`lease job expired: ${job.id} (device ${job.deviceId})`)
          deps.onJobLeaseExpired(job.id, 'lease expired')
        }
        // Manual lease idle-timeout.
        const now = nowSec()
        for (const [deviceId, lease] of [...leases]) {
          if (lease.type === 'manual' && lease.expiresAt < now) {
            log.info(`manual lease idle-timeout: device=${deviceId}`)
            release(deviceId, 'idle_timeout')
          }
        }
      }, config.reaperIntervalMs)
    },

    stopReaper() {
      if (reaper) clearInterval(reaper)
      reaper = null
    },
  }
}
