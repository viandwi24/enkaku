import type { Agent } from '@enkaku/protocol'
import { createCapabilityContext, fileToolsSessionFor, type AgentTreeOps, type CapabilityContext, type CapabilityContextDeps } from '../../capability/context'
import type { Role } from '../../auth/service'
import { evaluate } from '../../activity/policy'
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
  /** The tree's shared activity marker id (plan 205 §4.4, §5 step 205.8) — `agent:<rootRunId>`, the
   * SAME id `harness/run.ts`'s `admitAgentActivity` starts and refreshes directly on the registry.
   * Needed so `evaluateActivity` excludes the tree's own marker from its own conflict check —
   * without this, a run's SECOND capability call on a device it is already working on would see its
   * own tree's `agent` marker and refuse or warn against itself. */
  agentActivityId: string
  lookup: AuthorityLookupDeps
  /** Plan 67 §4.2 — `agent.spawn`'s `deviceIds`, when given: narrows THIS run below the authority
   * intersection, never widens it. Null/absent/empty means no extra narrowing. Snapshotted once per
   * launch (unlike the rest of this context) because it is set only at spawn and never changes. */
  deviceIdsOverride?: string[] | null
  /** Plan 67 §3.7 — at most one run in the tree may DRIVE a device at a time, EXCEPT an
   * ancestor/descendant pair (a child may use a device its parent already drives). Already bound to
   * this run's own id by whoever builds it (`agent/runner.ts`). `claim` returns null (granted) or a
   * human-readable label naming whichever unrelated run already drives it; `release` decides whether
   * the shared `agent:<rootRunId>` activity can actually be ended yet (another related run may still
   * be using it) and is called from `harness/run.ts` on every terminal path. Consumed entirely by
   * `harness/run.ts` now — this context no longer calls either method itself. */
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
  const base = createCapabilityContext(deps, actor)

  // An agent's own presence on a device is entirely the shared `agent:<rootRunId>` marker
  // `harness/run.ts`'s `admitAgentActivity` starts and refreshes directly on the registry — a
  // per-capability `control` touch here would create a SECOND, redundant marker under this actor's
  // own id, plan 205 §4.4. Both branches below share this override.
  const touchActivity: CapabilityContext['touchActivity'] = () => {}

  if (!tree) {
    const perms = new Set(effectivePermissions(agent, ownerRole))
    return {
      ...base,
      actor,
      hasPermission: (permission) => perms.has(permission),
      canReachDevice: (deviceId) => agentCanReachDevice(agent, deviceId),
      workspaceScope: () => agent.workspaceScope,
      touchActivity,
    }
  }

  const { runId, agentActivityId, lookup, treeOps, deviceIdsOverride } = tree
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
    // Deliberately NOT delegating straight to `base.evaluateActivity` (plan 67 §3.7, plan 205 §5 step
    // 205.8): the base implementation only excludes THIS actor's own `control:user:<agentId>` marker,
    // which an agent never creates (see `touchActivity` above) — without also excluding the tree's
    // own `agent:<rootRunId>` marker, a run's SECOND capability call on a device it is already
    // working on would see its own tree's marker and warn or refuse against itself.
    evaluateActivity: (deviceId, kind, exclusiveWith) =>
      evaluate(kind, deps.activities.list(deviceId), deps.controlSettings(), { selfIds: [agentActivityId], ...(exclusiveWith ? { exclusiveWith } : {}) }),
    touchActivity,
  }
}
