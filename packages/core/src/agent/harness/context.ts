import type { Agent } from '@enkaku/protocol'
import { createCapabilityContext, fileToolsSessionFor, type AgentTreeOps, type CapabilityContext, type CapabilityContextDeps } from '../../capability/context'
import type { Role } from '../../auth/service'
import { agentCanReachDevice, effectivePermissions } from '../agent-store'
import { effectiveAuthorityForRun, type AuthorityLookupDeps } from '../tree/authority'

/**
 * Plan 67 §3.4 — a run that is part of a tree needs its authority
 * RECOMPUTED LIVE on every check (not cached at context-build time), so
 * demoting a parent — or narrowing its own agent record — mid-run narrows a
 * running child immediately, not only at its next spawn. `runId` is the run
 * this context was built for; `lookup` is the (cheap, DB-backed) accessor
 * `effectiveAuthorityForRun` walks the `parentRunId` chain with. `deviceLock`
 * and `treeOps` are omitted entirely for a context built without tree
 * awareness (every existing plan 65/66 test, and any future non-tree run).
 *
 * Moved from `agent/loop/context.ts` (plan 76 §3.7 — `agent/loop/` is
 * deleted); this module's own logic is unchanged — it has nothing to do
 * with how a model is driven, only with what a capability call is allowed
 * to touch.
 */
export interface TreeRunContext {
  runId: string
  /** The tree's shared lease-holder identity (plan 67 §3.7) — `agent-run:<rootRunId>`, i.e. what
   * `harness/run.ts`'s `ensureControlLease` actually calls `leases.acquireManual` with. Needed so
   * `controlLeaseBlockedBy` can recognise "already held by MY tree" without the base check's
   * per-AGENT `holderUserId === actor.id` comparison, which does not hold between two DIFFERENT
   * agents sharing one tree (a parent and a spawned child are never the same agent). */
  leaseClientId: string
  lookup: AuthorityLookupDeps
  /** Plan 67 §4.2 — `agent.spawn`'s `deviceIds`, when given: narrows THIS run below the authority
   * intersection, never widens it. Null/absent/empty means no extra narrowing. Snapshotted once per
   * launch (unlike the rest of this context) because it is set only at spawn and never changes. */
  deviceIdsOverride?: string[] | null
  /** Plan 67 §3.7 — at most one run in the tree may hold control of a device at a time, EXCEPT an
   * ancestor/descendant pair (a child may use a device its parent already holds). Already bound to
   * this run's own id by whoever builds it (`agent/runner.ts`). `claim` returns null (granted) or a
   * human-readable label naming whichever unrelated run already holds it; `release` decides whether
   * the underlying real lease can actually be freed yet (another related run may still be using it)
   * and is called from `harness/run.ts`'s `releaseAcquiredLeases` on every terminal path. */
  deviceLock?: {
    claim(deviceId: string): string | null
    release(deviceId: string): void
  }
  treeOps?: AgentTreeOps
}

/**
 * Builds the `CapabilityContext` an agent actor invokes capabilities
 * through (plan 66 §4.2, plan 65 §9's deviation (7)) — `effectivePermissions`
 * and `agentCanReachDevice` are the pure functions Plan 65 wrote and tested
 * but never wired into a live context, because no agent actor existed
 * before this plan. This is that wiring, not a new authority model: every
 * other accessor (`deviceCall`, `ensureAwake`, `readiness`, `jobService`,
 * `scripts`, `workspace`, ...) is the SAME human-actor implementation
 * `createCapabilityContext` already provides — only the fields that encode
 * "who is this and what may they touch" are replaced.
 *
 * `tree` is OPTIONAL: omitted, this is exactly plan 66's original static
 * behaviour (an agent's own permissions/grants/scope, computed once). Given,
 * every check instead walks the run's live ancestor chain (plan 67 §3.4).
 *
 * `invoke()` remains the only door (plan 63 §3.4): this function does not
 * check anything itself, it only supplies the answers `invoke` asks for.
 */
export function createAgentCapabilityContext(deps: CapabilityContextDeps, agent: Agent, ownerRole: Role | null, tree?: TreeRunContext): CapabilityContext {
  const actor = { id: agent.id, role: ownerRole ?? ('operator' as Role) }
  // Built with the agent's OWN actor id so `controlLeaseBlockedBy`'s
  // `lease.holderUserId === actor.id` check (capability/context.ts) compares
  // against the agent, exactly as it would for a human caller.
  const base = createCapabilityContext(deps, actor)

  if (!tree) {
    const perms = new Set(effectivePermissions(agent, ownerRole))
    return {
      ...base,
      actor,
      hasPermission: (permission) => perms.has(permission),
      canReachDevice: (deviceId) => agentCanReachDevice(agent, deviceId),
      workspaceScope: () => agent.workspaceScope,
    }
  }

  const { runId, leaseClientId, lookup, deviceLock, treeOps, deviceIdsOverride } = tree
  return {
    ...base,
    actor,
    currentRunId: runId,
    agentTree: treeOps ?? null,
    // Re-keyed to the REAL run id (plan 77 §3.3) — `base`'s own `fileToolsSession` was built above
    // with `runId: null` (before this function knew it), which would have shared one session
    // across every agent/run sharing this actor id instead of one per run.
    fileToolsSession: fileToolsSessionFor(actor, runId),
    hasPermission: (permission) => (effectiveAuthorityForRun(lookup, runId).permissions as string[]).includes(permission),
    canReachDevice: (deviceId) => {
      // `deviceIds` on spawn narrows below the intersection but can never widen it (plan 67 §4.2).
      if (deviceIdsOverride && deviceIdsOverride.length > 0 && !deviceIdsOverride.includes(deviceId)) return false
      const grants = effectiveAuthorityForRun(lookup, runId).deviceGrants
      return grants.length === 0 || grants.includes(deviceId)
    },
    workspaceScope: () => effectiveAuthorityForRun(lookup, runId).workspaceScope,
    // Deliberately NOT delegating to `base.controlLeaseBlockedBy` here (plan 67 §3.7): that check
    // recognises "already mine" via `holderUserId === actor.id`, a per-AGENT identity — but the
    // tree is one SHARED lease holder across many different agents (a parent and its spawned
    // children are never the same agent), so that comparison would wrongly treat every ancestor/
    // descendant pair as "blocked by someone else". This reimplements the same OUTSIDE-the-tree
    // behaviour (name whoever holds it) using the tree's actual identity, `leaseClientId`, and
    // defers the INSIDE-the-tree decision entirely to `deviceLock` (ancestor/descendant allowed,
    // unrelated siblings refused by name).
    controlLeaseBlockedBy: (deviceId) => {
      const lease = deps.leases.getLease(deviceId)
      if (!lease || lease.type !== 'manual') return 'nobody — no manual lease is held; acquire it first'
      if (lease.holder !== leaseClientId) return lease.holderUserId ?? lease.holder
      if (!deviceLock) return null
      return deviceLock.claim(deviceId)
    },
  }
}
