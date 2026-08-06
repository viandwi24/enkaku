import type { DeviceStatus, LeaseHolder } from '@enkaku/protocol'
import type { DeviceStateMachine } from '../device/state-machine'
import type { JobStore } from '../queue/job-store'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

export type LeaseType = 'manual' | 'job'

export interface Lease {
  deviceId: string
  type: LeaseType
  /** manual: the WS connection's clientId (or `agent-run:<rootRunId>` for an agent run, plan 67 §3.7); job: the jobId. */
  holder: string
  /** manual: the authenticated user who holds it, when known (plan 18 §4.2 actor) — an agent-held lease carries the agent's id here instead (`agent/loop/run.ts`'s `ensureControlLease`). */
  holderUserId?: string | null
  acquiredAt: number
  expiresAt: number
}

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

/** Pure — exported for `toHolder.test.ts`. Converts an internal `Lease` into the wire `LeaseHolder` shape (plan 71 §3.2), or `null` for no lease. `takeable` is computed here, server-side, once — never left for a client to derive (plan 71 §3.2's own reasoning). */
export function toHolder(lease: Lease | null, resolveLabel: ResolveLabel = defaultResolveLabel): LeaseHolder | null {
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
   */
  acquireManual(deviceId: string, clientId: string, userId?: string | null, opts?: { takeOverFrom?: string }): Lease
  touchManual(deviceId: string, clientId: string): void
  releaseManual(deviceId: string, clientId: string, reason?: 'idle_timeout' | 'disconnected' | 'quarantined'): boolean
  releaseAllForClient(clientId: string): void
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
  onManualRevoked?: (deviceId: string, reason: 'idle_timeout' | 'disconnected' | 'quarantined', holderUserId: string | null) => void
  /**
   * A successful takeover (plan 71 §3.5) — the displaced holder (`from`,
   * already resolved to a `LeaseHolder`, or null defensively if the map and
   * the state machine had drifted) and the taker's resolved label. Fired
   * synchronously, in the same tick as the CAS itself.
   */
  onManualTakenOver?: (info: { deviceId: string; from: LeaseHolder | null; toClientId: string; toUserId: string | null; takenByLabel: string }) => void
  onDeviceFreed?: () => void
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

  function release(deviceId: string, reason?: 'idle_timeout' | 'disconnected' | 'quarantined'): boolean {
    const lease = leases.get(deviceId)
    if (!lease || lease.type !== 'manual') return false
    leases.delete(deviceId)
    lastManualRelease.set(deviceId, { at: nowSec(), holder: toHolder(lease, resolveLabel) })
    states.apply(deviceId, 'MANUAL_RELEASED')
    if (reason) deps.onManualRevoked?.(deviceId, reason, lease.holderUserId ?? null)
    deps.onDeviceFreed?.()
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

    noteJobLease(deviceId, jobId, ttlSec) {
      leases.set(deviceId, {
        deviceId,
        type: 'job',
        holder: jobId,
        acquiredAt: nowSec(),
        expiresAt: nowSec() + ttlSec,
      })
    },

    clearJobLease(deviceId) {
      const lease = leases.get(deviceId)
      if (lease?.type === 'job') leases.delete(deviceId)
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
