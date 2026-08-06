import type { Agent, WorkspaceScope } from '@enkaku/protocol'
import type { Permission } from '../../auth/acl'
import type { Role } from '../../auth/service'
import { EnkakuError } from '../../util/errors'
import { pathWithinPrefix } from '../../workspace/path'
import { effectivePermissions } from '../agent-store'

/**
 * Authority intersection (plan 67 §3.4) — THE security property of this
 * plan. A spawned run's effective authority is the intersection of its own
 * agent's configuration and its running PARENT's, across all four scopes.
 * Pure, and tested first: everything else in this plan assumes it holds.
 *
 * Without this, spawning is a privilege-escalation primitive: a read-only
 * triage agent spawns the admin agent and does anything — and since a
 * low-privilege agent is exactly the kind most likely to be reading
 * attacker-controllable device text, that would place the escalation at the
 * end of the shortest injection path in the system.
 */
export interface RunAuthority {
  /** Registry capability ids this run may call. */
  tools: string[]
  /** Device ids this run may reach. EMPTY MEANS ALL (plan 65 §3.5) — the same convention as an
   * agent's own `deviceGrants`, carried through intersection unchanged (see `intersectDeviceGrants`). */
  deviceGrants: string[]
  /** ACL permission names this run acts with. */
  permissions: Permission[]
  /** Workspace path prefixes this run may read/write. */
  workspaceScope: WorkspaceScope
}

/** A run's authority BEFORE any intersection with a parent — its own agent's configuration, with
 * `permissions` already capped at what its owner currently holds (plan 65 §3.5's live re-derivation,
 * `agent-store.ts`'s `effectivePermissions`). */
export function ownAuthority(agent: Pick<Agent, 'tools' | 'deviceGrants' | 'permissions' | 'workspaceScope'>, ownerRole: Role | null): RunAuthority {
  return {
    tools: agent.tools,
    deviceGrants: agent.deviceGrants,
    permissions: effectivePermissions(agent, ownerRole),
    workspaceScope: agent.workspaceScope,
  }
}

/** Capabilities: plain set intersection — a child can never call anything its parent could not. */
export function intersectCapabilities(child: readonly string[], parent: readonly string[]): string[] {
  const parentSet = new Set(parent)
  return child.filter((id) => parentSet.has(id))
}

/**
 * Devices: plan 65 §3.5's rule is that EMPTY grants mean ALL devices — so
 * intersecting an empty set with a restricted parent must yield the
 * PARENT's set (not the empty set, and not everything). This is the subtle
 * case plan 67 §7 names explicitly and requires as a named test case.
 */
export function intersectDeviceGrants(child: readonly string[], parent: readonly string[]): string[] {
  if (child.length === 0) return [...parent]
  if (parent.length === 0) return [...child]
  const parentSet = new Set(parent)
  return child.filter((id) => parentSet.has(id))
}

/** Permissions: plain set intersection — a permission the child lists but the parent's run does
 * not currently have (e.g. the child's OWN owner grants something the parent's run lacks) is
 * dropped, never granted through the child. */
export function intersectPermissions(child: readonly Permission[], parent: readonly Permission[]): Permission[] {
  const parentSet = new Set(parent)
  return child.filter((p) => parentSet.has(p))
}

/**
 * Workspace: prefix-set intersection. For every (childPrefix, parentPrefix)
 * pair where one contains the other, the NARROWER of the two survives —
 * that is exactly the set of paths reachable under both. Two disjoint
 * prefixes contribute nothing. Reuses `pathWithinPrefix` (plan 64's own
 * prefix-containment test) rather than a second implementation.
 */
function intersectPrefixList(child: readonly string[], parent: readonly string[]): string[] {
  const result = new Set<string>()
  for (const c of child) {
    for (const p of parent) {
      if (pathWithinPrefix(c, p)) result.add(c)
      else if (pathWithinPrefix(p, c)) result.add(p)
    }
  }
  return [...result]
}

export function intersectWorkspaceScope(child: WorkspaceScope, parent: WorkspaceScope): WorkspaceScope {
  return { read: intersectPrefixList(child.read, parent.read), write: intersectPrefixList(child.write, parent.write) }
}

/** The combinator: a child's effective authority given its own configuration and its parent's
 * CURRENT effective authority (plan 67 §3.4's table, all four scopes). */
export function intersectAuthority(child: RunAuthority, parent: RunAuthority): RunAuthority {
  return {
    tools: intersectCapabilities(child.tools, parent.tools),
    deviceGrants: intersectDeviceGrants(child.deviceGrants, parent.deviceGrants),
    permissions: intersectPermissions(child.permissions, parent.permissions),
    workspaceScope: intersectWorkspaceScope(child.workspaceScope, parent.workspaceScope),
  }
}

/** The minimal read surface `effectiveAuthorityForRun` needs — kept narrow so this module never
 * imports the full `ThreadStore`/`AgentStore` types (which would pull `agent/runner.ts`-adjacent
 * concerns into a module that must stay pure and cheaply testable). */
export interface AuthorityLookupDeps {
  getRun(runId: string): { threadId: string; parentRunId: string | null } | null
  getThread(threadId: string): { agentId: string } | null
  getAgent(agentId: string): Pick<Agent, 'tools' | 'deviceGrants' | 'permissions' | 'workspaceScope' | 'ownerId'> | null
  roleOf(ownerId: string | null): Role | null
}

/**
 * A run's LIVE effective authority — recomputed fresh on every call, never
 * cached (plan 67 §3.4: "re-checked at EVERY `invoke`, not only at spawn" —
 * demoting a parent, or narrowing its own agent record, mid-run must narrow
 * a running child immediately). Walks the `parentRunId` chain to the root,
 * intersecting at each level; bounded by the tree's own depth cap (default
 * 3), so this never walks far.
 */
export function effectiveAuthorityForRun(deps: AuthorityLookupDeps, runId: string): RunAuthority {
  const run = deps.getRun(runId)
  if (!run) throw new EnkakuError('run_not_found', `no such run: ${runId}`)
  const thread = deps.getThread(run.threadId)
  if (!thread) throw new EnkakuError('thread_not_found', `no such thread: ${run.threadId}`)
  const agent = deps.getAgent(thread.agentId)
  if (!agent) throw new EnkakuError('agent_not_found', `no such agent: ${thread.agentId}`)
  const own = ownAuthority(agent, deps.roleOf(agent.ownerId))
  if (!run.parentRunId) return own
  const parentAuthority = effectiveAuthorityForRun(deps, run.parentRunId)
  return intersectAuthority(own, parentAuthority)
}
