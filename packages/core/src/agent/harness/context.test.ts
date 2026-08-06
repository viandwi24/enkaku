import { describe, expect, test } from 'bun:test'
import type { Agent } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../../db'
import { devices } from '../../db/schema'
import { createLogger } from '../../util/logger'
import { createLeaseManager, type LeaseManager } from '../../lease/lease-manager'
import { createDeviceStateMachine } from '../../device/state-machine'
import type { CapabilityContextDeps } from '../../capability/context'
import { createAgentCapabilityContext } from './context'
import type { AuthorityLookupDeps } from '../tree/authority'

/**
 * Moved from `agent/loop/context.test.ts` (plan 76 §3.7 — the module itself moved unedited; these
 * are new tests written against the moved implementation, since the original test file could not
 * be recovered — see the plan 76 report). Covers §4's two paths: a plain (non-tree) agent context,
 * and a tree-aware one built with a `TreeRunContext`.
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

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'd1', stableId: 's1', serial: 'SER1', label: 'Phone', status: 'idle' }).run()
  const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
  const leases: LeaseManager = createLeaseManager({
    states,
    jobStore: { expiredRunning: () => [] } as never,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 60, reaperIntervalMs: 1_000_000 },
    log: createLogger('test'),
    onJobLeaseExpired: () => {},
  })
  const deps: CapabilityContextDeps = {
    db,
    leases,
    states,
    sessions: () => null,
    readiness: () => null,
    transfer: null,
    jobService: {} as never,
    workspace: {} as never,
  }
  return { db, leases, deps }
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

  test('controlLeaseBlockedBy names the human holder when a manual lease is already held by someone else', () => {
    const { deps, leases } = setUp()
    leases.acquireManual('d1', 'human-client', 'some-user')
    const ctx = createAgentCapabilityContext(deps, fakeAgent(), 'operator')
    expect(ctx.controlLeaseBlockedBy('d1')).toBe('some-user')
  })
})

describe('createAgentCapabilityContext — tree-aware (plan 67 §3.4, §3.7)', () => {
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
      leaseClientId: 'agent-run:root-1',
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
      leaseClientId: 'agent-run:root-1',
      lookup: treeDeps(agent),
      deviceIdsOverride: ['d1'],
    })
    expect(ctx.canReachDevice('d1')).toBe(true)
    expect(ctx.canReachDevice('d2')).toBe(false)
  })

  test('controlLeaseBlockedBy defers to the tree device lock once the lease is held by THIS tree', () => {
    const { deps, leases } = setUp()
    leases.acquireManual('d1', 'agent-run:root-1', 'agent-1')
    const claimed: { value: string | null } = { value: null }
    const agent = fakeAgent()
    const ctx = createAgentCapabilityContext(deps, agent, 'operator', {
      runId: 'run-1',
      leaseClientId: 'agent-run:root-1',
      lookup: treeDeps(agent),
      deviceLock: {
        claim: (deviceId) => {
          claimed.value = deviceId
          return null
        },
        release: () => {},
      },
    })
    expect(ctx.controlLeaseBlockedBy('d1')).toBeNull()
    expect(claimed.value).toBe('d1')
  })
})
