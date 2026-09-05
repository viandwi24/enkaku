import { describe, expect, test } from 'bun:test'
import type { Agent } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../../db'
import { devices } from '../../db/schema'
import { createLogger } from '../../util/logger'
import { createActivityRegistry, type ActivityRegistry } from '../../activity/registry'
import type { ControlPolicySettings } from '../../activity/policy'
import { createDeviceStateMachine } from '../../device/state-machine'
import type { CapabilityContextDeps } from '../../capability/context'
import { createAgentCapabilityContext } from './context'
import type { AuthorityLookupDeps } from '../tree/authority'

/**
 * Moved from `agent/loop/context.test.ts` (plan 76 §3.7 — the module itself moved unedited; these
 * are new tests written against the moved implementation, since the original test file could not
 * be recovered — see the plan 76 report). Covers §4's two paths: a plain (non-tree) agent context,
 * and a tree-aware one built with a `TreeRunContext`. Reworked for plan 205 §5 step 205.8: the
 * per-holder checks become activity-policy checks against a real `ActivityRegistry`.
 */

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    slug: 'a',
    name: 'A',
    description: null,
    colour: null,
    enabled: true,
    connectorId: null,
    model: null,
    systemPrompt: null,
    settings: {},
    tools: [],
    requiresApproval: [],
    deviceGrants: [],
    workspaceScope: { read: ['/x'], write: ['/x'] },
    permissions: ['device.control'],
    wakeOnMessage: 'on-child-result',
    ownerId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const fakeControlSettings: ControlPolicySettings = { overControl: 'allow', idleSec: 30 }

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'SER1', label: 'Phone', status: 'online' }).run()
  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const activities: ActivityRegistry = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
  const deps: CapabilityContextDeps = {
    db,
    activities,
    controlSettings: () => fakeControlSettings,
    states,
    sessions: () => null,
    readiness: () => null,
    transfer: null,
    jobService: {} as never,
    workspace: {} as never,
  }
  return { db, activities, deps }
}

describe('createAgentCapabilityContext — no tree (plan 66 §4.2)', () => {
  test('hasPermission reflects the intersection with the owner role', () => {
    const { deps } = setUp()
    const agent = fakeAgent({ permissions: ['device.control'] })
    const ctx = createAgentCapabilityContext(deps, agent, 'operator')
    expect(ctx.hasPermission('device.control')).toBe(true)
    expect(ctx.hasPermission('fs.write' as never)).toBe(false)
  })

  test('an admin-only permission is refused for an operator owner even if the agent record lists it', () => {
    const { deps } = setUp()
    const agent = fakeAgent({ permissions: ['job.cancel.any'] })
    const ctx = createAgentCapabilityContext(deps, agent, 'operator')
    expect(ctx.hasPermission('job.cancel.any' as never)).toBe(false)
  })

  test('empty deviceGrants means every device is reachable', () => {
    const { deps } = setUp()
    const ctx = createAgentCapabilityContext(deps, fakeAgent({ deviceGrants: [] }), 'operator')
    expect(ctx.canReachDevice('d1')).toBe(true)
    expect(ctx.canReachDevice('any-other-device')).toBe(true)
  })

  test('a non-empty deviceGrants list narrows reachability', () => {
    const { deps } = setUp()
    const ctx = createAgentCapabilityContext(deps, fakeAgent({ deviceGrants: ['d1'] }), 'operator')
    expect(ctx.canReachDevice('d1')).toBe(true)
    expect(ctx.canReachDevice('d2')).toBe(false)
  })

  test('workspaceScope reads straight from the agent record', () => {
    const { deps } = setUp()
    const ctx = createAgentCapabilityContext(deps, fakeAgent({ workspaceScope: { read: ['/agents/a'], write: ['/agents/a'] } }), 'operator')
    expect(ctx.workspaceScope()).toEqual({ read: ['/agents/a'], write: ['/agents/a'] })
  })

  test('currentRunId and agentTree are null — a plain (non-tree) context cannot reach agent.* tree ops', () => {
    const { deps } = setUp()
    const ctx = createAgentCapabilityContext(deps, fakeAgent(), 'operator')
    expect(ctx.currentRunId).toBeNull()
    expect(ctx.agentTree).toBeNull()
  })

  test('evaluateActivity allows control over a running job, and still warns for an agent run', () => {
    const { deps, activities } = setUp()
    activities.start('d1', { id: 'job:j1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const ctx = createAgentCapabilityContext(deps, fakeAgent(), 'operator')

    // Control over a job became `allow` with no sentence on 2026-09-04 (CEO):
    // an operator reaching into a running job is helping it.
    expect(ctx.evaluateActivity('d1', 'control')).toMatchObject({ decision: 'allow', message: '' })

    // `agent` is the long, unattended run that still carries the warning —
    // the same split `activity/policy.test.ts` pins.
    const asAgent = ctx.evaluateActivity('d1', 'agent')
    expect(asAgent.decision).toBe('warn')
    expect(asAgent.message).toContain('Running x')
  })

  test('touchActivity is a no-op — a plain agent context never creates its own control marker', () => {
    const { deps, activities } = setUp()
    const ctx = createAgentCapabilityContext(deps, fakeAgent(), 'operator')
    ctx.touchActivity('d1', 'control')
    expect(activities.list('d1')).toEqual([])
  })
})

describe('createAgentCapabilityContext — tree-aware (plan 67 §3.4, §3.7, plan 205 §5 step 205.8)', () => {
  function treeDeps(agent: Agent): AuthorityLookupDeps {
    return {
      getRun: (id) => (id === 'run-1' ? { threadId: 'thread-1', parentRunId: null } : null),
      getThread: (id) => (id === 'thread-1' ? { agentId: agent.id } : null),
      getAgent: (id) => (id === agent.id ? agent : null),
      roleOf: () => 'operator',
    }
  }

  test('currentRunId and agentTree are wired through when a TreeRunContext is given', () => {
    const { deps } = setUp()
    const agent = fakeAgent()
    const treeOps = { spawn: async () => ({ waited: false as const, runId: 'x' }), send: () => ({ queued: true as const, inboxId: 'i' }), reply: () => ({ queued: true as const, inboxId: 'i' }), status: () => ({ runId: 'x', status: 'running' as const, stopReason: null, steps: 0, lastMessage: null }), cancel: () => ({ ok: true as const, cancelledCount: 1 }) }
    const ctx = createAgentCapabilityContext(deps, agent, 'operator', {
      runId: 'run-1',
      agentActivityId: 'agent:root-1',
      lookup: treeDeps(agent),
      treeOps,
    })
    expect(ctx.currentRunId).toBe('run-1')
    expect(ctx.agentTree).toBe(treeOps)
  })

  test('deviceIdsOverride narrows reachability below whatever the authority lookup grants, never widens it', () => {
    const { deps } = setUp()
    const agent = fakeAgent({ deviceGrants: [] })
    const ctx = createAgentCapabilityContext(deps, agent, 'operator', {
      runId: 'run-1',
      agentActivityId: 'agent:root-1',
      lookup: treeDeps(agent),
      deviceIdsOverride: ['d1'],
    })
    expect(ctx.canReachDevice('d1')).toBe(true)
    expect(ctx.canReachDevice('d2')).toBe(false)
  })

  test('evaluateActivity excludes the tree\'s own agent marker from its own conflict check', () => {
    const { deps, activities } = setUp()
    const agent = fakeAgent()
    activities.start('d1', { id: 'agent:root-1', kind: 'agent', label: `${agent.name} is working`, actor: { kind: 'agent', id: agent.id, label: agent.name } })
    const ctx = createAgentCapabilityContext(deps, agent, 'operator', {
      runId: 'run-1',
      agentActivityId: 'agent:root-1',
      lookup: treeDeps(agent),
    })
    // A capability that declares `exclusiveWith: ['agent']` would otherwise forbid on the
    // tree's OWN marker — the base (non-tree) context, which does not know to exclude it, IS
    // refused; the tree-aware override above is what lets the tree's own capability calls proceed.
    const baseCtx = createAgentCapabilityContext(deps, agent, 'operator')
    expect(baseCtx.evaluateActivity('d1', 'control', ['agent']).decision).toBe('forbid')
    expect(ctx.evaluateActivity('d1', 'control', ['agent']).decision).toBe('allow')
  })

  test('touchActivity is a no-op for a tree-aware context too', () => {
    const { deps, activities } = setUp()
    const agent = fakeAgent()
    const ctx = createAgentCapabilityContext(deps, agent, 'operator', {
      runId: 'run-1',
      agentActivityId: 'agent:root-1',
      lookup: treeDeps(agent),
    })
    ctx.touchActivity('d1', 'control')
    expect(activities.list('d1')).toEqual([])
  })
})
