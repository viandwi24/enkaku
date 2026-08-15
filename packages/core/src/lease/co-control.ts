import type { CoControlMode, LeaseHolder } from '@enkaku/protocol'
import { toHolder, type LeaseManager, type ResolveLabel } from './lease-manager'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

/**
 * Co-control: **Assist** (plan 91 §3.2, §4.2) — a short-lived, subordinate
 * authorisation that lets a second party inject input into a device someone
 * (or something) else already holds, without ever moving the hold itself.
 *
 * This is a THIRD authorisation object, not a lease variant: `DeviceStatus`
 * never changes because of it, `acquireManual` is never called, and the
 * primary holder's `expiresAt` is never touched (§3.2's table). It grants
 * exactly the five input verbs (tap/swipe/gesture/key/text) — nothing else
 * is gated by it; `checkAssistAllowed` below is consulted **only** by the
 * `input.*` branch (step 91.4), never by `shell.exec`, `inspect.*`,
 * `clipboard.set`, transfer, or the adb endpoint.
 *
 * **The one property this file exists to guarantee**: a grant can never
 * outlive the hold it was subordinate to. Four independent paths must all
 * reach zero-latency cleanup — the grant's own TTL (`startReaper`), the
 * assisting connection going away (`releaseAllForClient`, WS close), the
 * assisting operator giving it up (`release`), and the PRIMARY hold ending,
 * for any reason (`onPrimaryEnded`, wired from `lease-manager.ts`'s
 * `release()` and `clearJobLease()` in `daemon.ts`). Losing any one of the
 * four would let a second input source keep writing to a device nobody
 * remembers granting it on.
 */

/**
 * Why a grant ended (plan 91 §3.2, §3.9, §4.2). Declared here as the
 * authoritative internal type; `packages/protocol/src/messages/co-control.ts`
 * declares its OWN wire-level `AssistEndReasonSchema` independently (the same
 * "a wire message owns its own vocabulary" reasoning that file's own comment
 * gives for `LeaseRevokedMessage.payload.reason`) rather than importing this
 * one — core internals must never leak into `@enkaku/protocol`, which is the
 * wrong direction for that dependency to run.
 */
export type AssistEndReason = 'released' | 'ttl' | 'disconnected' | 'primary_ended' | 'mode_off'

export interface CoControlGrant {
  deviceId: string
  /** The WS connection's clientId — the same key `Lease.holder` uses for a manual lease. */
  clientId: string
  userId: string | null
  /** Snapshot of who held the device when the grant was issued; the grant dies with them (§3.2). For a job this is the jobId, for an agent the agent's id, for a person the userId (or clientId, unauthenticated) — the same `id` `toHolder` would report for the primary's own `LeaseHolder`. */
  primaryHolderId: string
  primaryKind: 'job' | 'user' | 'agent'
  /** The job this grant is attributed to, when the primary is a job; null otherwise. */
  jobId: string | null
  grantedAt: number
  expiresAt: number
}

export interface CoControlConfig {
  /** `coControl.grantTtlSec` — read fresh on every grant/touch, like every other farm setting (`lease-manager.ts`'s own `config` is the one exception, captured once at boot; this follows the newer, preferred pattern). */
  grantTtlSec: () => number
  /** `coControl.maxConcurrentPerDevice`. */
  maxConcurrentPerDevice: () => number
  /**
   * The farm-wide switch (plan 91 §3.6, §4.6) — defense in depth alongside
   * `canAssist(role, mode)`, which is the REAL gate an authenticated caller
   * is checked against before `grant()` is ever reached (step 91.4, at the WS
   * layer, where the role is known). This store has no notion of a role, so
   * it can only enforce the farm-wide half on its own — which matters
   * because `mirror.start` (step 91.7) calls `grant()` directly for a
   * held/busy member, and a farm that just flipped `coControl.mode: 'off'`
   * must not keep minting grants through that second door.
   * Optional so a host/test built before this wiring keeps compiling —
   * omitted means "never off" (matches `LeaseManagerDeps`'s own optional-hook
   * convention throughout this package).
   */
  mode?: () => CoControlMode
  /**
   * Per-script opt-out (plan 91 §3.6) — `ScriptDefinition.assist`, wired
   * once step 91.5 threads it through the running job via the executor
   * host. Optional and permissive by default: omitted means every job may
   * be assisted, which is correct for every build before 91.5 lands.
   */
  scriptAssistPolicy?: (jobId: string) => 'allow' | 'deny'
  /** How often the TTL reaper sweeps. Defaults to `DEFAULT_REAPER_INTERVAL_MS`. */
  reaperIntervalMs?: number
}

export interface CoControlManagerDeps {
  /** Only ever used to look up the device's current PRIMARY hold — never to acquire, release, or otherwise mutate a lease. */
  leases: Pick<LeaseManager, 'getLease'>
  config: CoControlConfig
  log: Logger
  /** Resolves a holder/assisting id to a display label — the SAME `ResolveLabel` shape `lease-manager.ts` uses, so a grant's labels and a lease's labels are never worded differently for the same id. Defaults to a generic, honest, never-empty, never-raw-id fallback when omitted (tests, and hosts that predate this plan). */
  resolveLabel?: ResolveLabel
  /** Fired the instant a grant is created — step 91.4 broadcasts `assist.started`/`assist.changed` and records the audit row from this. */
  onGranted?: (grant: CoControlGrant) => void
  /** Fired the instant a grant ends, however it ends. `reason` is the wire `AssistEndReason` step 91.4 forwards verbatim into `assist.stopped`/`assist.changed`. */
  onReleased?: (grant: CoControlGrant, reason: AssistEndReason) => void
}

export interface CoControlManager {
  /** Throws `EnkakuError` coded `assist_not_allowed` / `assist_taken` / `assist_denied_by_script` / `device_not_held`. Idempotent for the SAME (deviceId, clientId): re-granting just refreshes the TTL, the same shape `acquireManual` already gives a re-acquiring holder. */
  grant(deviceId: string, clientId: string, userId: string | null): CoControlGrant
  /** Ends exactly one grant. Returns `false` if none existed (a harmless no-op, like `releaseManual` for a non-holder). */
  release(deviceId: string, clientId: string, reason: AssistEndReason): boolean
  /** Every grant this WS connection holds, anywhere on the farm — the WS-close path (plan 91 §3.2's "On WS close" row). */
  releaseAllForClient(clientId: string): void
  /**
   * Every grant this WS connection currently holds, anywhere on the farm —
   * read-only, never mutates anything (plan 91 §3.5, §5 step 91.5). Exists so
   * `ws-handlers.ts`'s `handleClose` can record `control.assist.ended`
   * (reason `'disconnected'`) and the `device.assist` audit row for each
   * grant BEFORE calling `releaseAllForClient` below, which has no return
   * value of its own to report what it released.
   */
  grantsForClient(clientId: string): CoControlGrant[]
  /** Called from the lease manager's own release/clear paths (`onPrimaryEnded` wiring in `lease-manager.ts`, threaded from `daemon.ts`) — subordination (§3.2): every grant on this device ends, because the hold they were subordinate to just did. */
  onPrimaryEnded(deviceId: string): void
  /** Refresh on every accepted assist action, exactly like `touchManual` — a no-op if the (deviceId, clientId) pair holds no grant. */
  touch(deviceId: string, clientId: string): void
  /** The §3.2 gate — read-only, never mutates anything. Consulted ONLY by `input.*` (step 91.4), as a fallback after `checkInputAllowed` has already failed. */
  checkAssistAllowed(deviceId: string, clientId: string): { ok: true } | { ok: false; code: string; message: string }
  /** Every live grant on a device, as the wire's `LeaseHolder` shape (§4.4's `DeviceInfo.assistedBy`) — always `kind: 'user'` (plan §2: no reverse, agent-assists-human facility exists), always `takeable: false` (an assist is granted or refused, never taken over). Empty array, never null, when nobody is assisting. */
  assistedBy(deviceId: string): LeaseHolder[]
  /** Farm-wide count of currently-live grants (plan 91 §4.10, §5 step 91.10) — every device's expired entries are pruned first, the same freshness guarantee every other read in this file gives, so `/api/adb/stats`'s `input.assistsActive` never counts a grant the reaper simply has not swept yet. */
  activeGrantCount(): number
  /**
   * Every grant farm-wide, exactly as stored, WITHOUT pruning first (plan 91
   * §4.10, §5 step 91.10) — every other read in this file prunes-then-reads
   * so a caller never observes a stale grant; this one deliberately does the
   * opposite, because it exists ONLY for the `co-control` doctor check's
   * "uncollected grants" leak detector, whose entire job is to notice a
   * grant the reaper (or a lazy prune) has NOT collected yet. Pruning first
   * here would make the leak detector permanently blind to the very defect
   * it exists to catch.
   */
  rawGrantSnapshot(): CoControlGrant[]
  startReaper(): void
  stopReaper(): void
}

/** Matches `lease-manager.ts`'s own reaper cadence order of magnitude — grants expire in whole seconds, so a 5s sweep is comfortably finer-grained than anything an operator would notice. */
const DEFAULT_REAPER_INTERVAL_MS = 5_000

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** Used only when no `resolveLabel` is supplied (tests, and hosts that predate this plan) — honest and generic, never the raw id. Mirrors `lease-manager.ts`'s own private default exactly (duplicated rather than exported across the module boundary, since it is a two-line pure function, not shared state). */
const defaultResolveLabel: ResolveLabel = (kind) => (kind === 'user' ? 'a client' : kind === 'agent' ? 'an agent' : 'a job')

export function createCoControlManager(deps: CoControlManagerDeps): CoControlManager {
  const { leases, config, log } = deps
  const resolveLabel = deps.resolveLabel ?? defaultResolveLabel
  /** deviceId -> clientId -> grant. A `Map` of `Map`s rather than a flat `Map<string, CoControlGrant[]>` so `release`/`touch`/`checkAssistAllowed` — all keyed on the SAME (deviceId, clientId) pair the wire messages carry — are O(1), not a linear scan. */
  const grants = new Map<string, Map<string, CoControlGrant>>()
  let reaper: ReturnType<typeof setInterval> | null = null

  function doRelease(deviceId: string, clientId: string, reason: AssistEndReason): boolean {
    const byClient = grants.get(deviceId)
    const grant = byClient?.get(clientId)
    if (!grant || !byClient) return false
    byClient.delete(clientId)
    if (byClient.size === 0) grants.delete(deviceId)
    log.info(`assist grant released: device=${deviceId} client=${clientId} reason=${reason}`)
    deps.onReleased?.(grant, reason)
    return true
  }

  /** Lazily evicts anything past its TTL for one device — called before every read/write so a caller between reaper ticks never sees or reuses a stale grant. Each eviction goes through `doRelease` (reason `'ttl'`) so `onReleased` fires exactly once per grant, from exactly one code path, whether it was the periodic sweep or a lazy check that found it first. */
  function pruneExpired(deviceId: string): void {
    const byClient = grants.get(deviceId)
    if (!byClient) return
    const now = nowSec()
    for (const [clientId, grant] of [...byClient]) {
      if (grant.expiresAt <= now) doRelease(deviceId, clientId, 'ttl')
    }
  }

  return {
    grant(deviceId, clientId, userId) {
      pruneExpired(deviceId)

      const existing = grants.get(deviceId)?.get(clientId)
      if (existing) {
        existing.expiresAt = nowSec() + config.grantTtlSec()
        return existing
      }

      if (config.mode && config.mode() === 'off') {
        throw new EnkakuError('assist_not_allowed', 'assisting is turned off for this farm')
      }

      const lease = leases.getLease(deviceId)
      if (!lease) {
        // §3.2: a grant may only exist while somebody else holds the
        // device. An idle device has nothing to be subordinate to — the
        // correct route is an ordinary `lease.acquire`, not an assist.
        throw new EnkakuError('device_not_held', 'the device is not held by anyone — take control instead of assisting')
      }

      const primary = toHolder(lease, resolveLabel)
      if (!primary) {
        // Defensive only: `toHolder` returns null exactly when its input is
        // null, and `lease` was just checked non-null above.
        throw new EnkakuError('device_not_held', 'the device is not held by anyone — take control instead of assisting')
      }

      if (primary.kind === 'job' && config.scriptAssistPolicy) {
        const policy = config.scriptAssistPolicy(primary.id)
        if (policy === 'deny') {
          throw new EnkakuError('assist_denied_by_script', 'the running script has disabled assisting for this job')
        }
      }

      const byClient = grants.get(deviceId)
      const activeCount = byClient?.size ?? 0
      const maxConcurrent = config.maxConcurrentPerDevice()
      if (activeCount >= maxConcurrent) {
        // §3.2: refused naming the holder, the same shape `device_held_by_other` already gives.
        const holders = [...(byClient?.values() ?? [])].map((g) => resolveLabel('user', g.userId ?? g.clientId))
        throw new EnkakuError('assist_taken', `already being assisted by ${holders.join(', ') || 'another client'}`)
      }

      const now = nowSec()
      const newGrant: CoControlGrant = {
        deviceId,
        clientId,
        userId,
        primaryHolderId: primary.id,
        primaryKind: primary.kind,
        jobId: primary.kind === 'job' ? primary.id : null,
        grantedAt: now,
        expiresAt: now + config.grantTtlSec(),
      }
      if (!grants.has(deviceId)) grants.set(deviceId, new Map())
      grants.get(deviceId)!.set(clientId, newGrant)
      log.info(`assist grant created: device=${deviceId} client=${clientId} primary=${primary.kind}:${primary.id}`)
      deps.onGranted?.(newGrant)
      return newGrant
    },

    release(deviceId, clientId, reason) {
      return doRelease(deviceId, clientId, reason)
    },

    releaseAllForClient(clientId) {
      for (const [deviceId, byClient] of [...grants]) {
        if (byClient.has(clientId)) doRelease(deviceId, clientId, 'disconnected')
      }
    },

    grantsForClient(clientId) {
      const out: CoControlGrant[] = []
      for (const byClient of grants.values()) {
        const grant = byClient.get(clientId)
        if (grant) out.push(grant)
      }
      return out
    },

    onPrimaryEnded(deviceId) {
      const byClient = grants.get(deviceId)
      if (!byClient) return
      for (const clientId of [...byClient.keys()]) doRelease(deviceId, clientId, 'primary_ended')
    },

    touch(deviceId, clientId) {
      const grant = grants.get(deviceId)?.get(clientId)
      if (grant) grant.expiresAt = nowSec() + config.grantTtlSec()
    },

    checkAssistAllowed(deviceId, clientId) {
      pruneExpired(deviceId)
      const grant = grants.get(deviceId)?.get(clientId)
      if (!grant) {
        return { ok: false, code: 'no_grant', message: 'you are not currently assisting this device' }
      }
      return { ok: true }
    },

    assistedBy(deviceId) {
      pruneExpired(deviceId)
      const byClient = grants.get(deviceId)
      if (!byClient) return []
      return [...byClient.values()].map((grant) => ({
        kind: 'user' as const,
        id: grant.userId ?? grant.clientId,
        label: resolveLabel('user', grant.userId ?? grant.clientId),
        runId: null,
        takeable: false,
        acquiredAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
      }))
    },

    activeGrantCount() {
      let count = 0
      for (const deviceId of [...grants.keys()]) {
        pruneExpired(deviceId)
        count += grants.get(deviceId)?.size ?? 0
      }
      return count
    },

    rawGrantSnapshot() {
      const out: CoControlGrant[] = []
      for (const byClient of grants.values()) out.push(...byClient.values())
      return out
    },

    startReaper() {
      if (reaper) return
      const intervalMs = config.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS
      reaper = setInterval(() => {
        for (const deviceId of [...grants.keys()]) pruneExpired(deviceId)
      }, intervalMs)
    },

    stopReaper() {
      if (reaper) clearInterval(reaper)
      reaper = null
    },
  }
}
