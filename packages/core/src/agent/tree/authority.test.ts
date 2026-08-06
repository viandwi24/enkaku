import { describe, expect, test } from 'bun:test'
import type { Agent } from '@enkaku/protocol'
import type { Role } from '../../auth/service'
import {
  effectiveAuthorityForRun,
  intersectAuthority,
  intersectCapabilities,
  intersectDeviceGrants,
  intersectPermissions,
  intersectWorkspaceScope,
  ownAuthority,
  type AuthorityLookupDeps,
  type RunAuthority,
} from './authority'

/**
 * Plan 67 §3.4, §7 — the security property of this plan, tested first and
 * pure. The empty-means-all device case gets its own named test, exactly as
 * §7 requires: "intersecting an empty set with a restricted parent must
 * yield the PARENT's set, not the empty set and not everything."
 */

describe('intersectCapabilities (plan 67 §3.4)', () => {
  test('a child can only call what BOTH it and its parent allow', () => {
    expect(intersectCapabilities(['device.tap', 'device.install'], ['device.tap', 'fs.read'])).toEqual(['device.tap'])
  })
  test('a child whose agent has BROADER grants cannot use them (criterion 3)', () => {
    expect(intersectCapabilities(['device.install', 'job.cancel'], ['device.tap'])).toEqual([])
  })
  test('no overlap at all yields empty, not an error', () => {
    expect(intersectCapabilities(['a'], ['b'])).toEqual([])
  })
})

describe('intersectDeviceGrants — the named subtle case (plan 67 §3.4, §7)', () => {
  test('empty child grants intersected with a RESTRICTED parent yields the PARENT set, not empty, not all', () => {
    expect(intersectDeviceGrants([], ['d1', 'd2'])).toEqual(['d1', 'd2'])
  })
  test('a restricted child intersected with empty (all) parent grants yields the CHILD set', () => {
    expect(intersectDeviceGrants(['d1'], [])).toEqual(['d1'])
  })
  test('both empty (both mean "all") stays empty — still all, not none', () => {
    expect(intersectDeviceGrants([], [])).toEqual([])
  })
  test('two restricted, overlapping sets intersect normally', () => {
    expect(intersectDeviceGrants(['d1', 'd2'], ['d2', 'd3'])).toEqual(['d2'])
  })
  test('two restricted, disjoint sets intersect to nothing', () => {
    expect(intersectDeviceGrants(['d1'], ['d2'])).toEqual([])
  })
})

describe('intersectPermissions (plan 67 §3.4)', () => {
  test('a permission the child has and the parent does not is dropped', () => {
    expect(intersectPermissions(['device.control', 'device.shell'] as never, ['device.control'] as never)).toEqual(['device.control'])
  })
  test('a permission the parent has and the child does not is not granted to the child', () => {
    expect(intersectPermissions(['device.control'] as never, ['device.control', 'agent.manage'] as never)).toEqual(['device.control'])
  })
})

describe('intersectWorkspaceScope (plan 67 §3.4)', () => {
  test('a broader child scope narrows to the parent when the parent is tighter', () => {
    const child = { read: ['/'], write: ['/'] }
    const parent = { read: ['/agents/parent/'], write: ['/agents/parent/'] }
    expect(intersectWorkspaceScope(child, parent)).toEqual({ read: ['/agents/parent/'], write: ['/agents/parent/'] })
  })
  test('a narrower child scope stays narrower when the parent is broader', () => {
    const child = { read: ['/agents/child/'], write: ['/agents/child/'] }
    const parent = { read: ['/'], write: ['/'] }
    expect(intersectWorkspaceScope(child, parent)).toEqual({ read: ['/agents/child/'], write: ['/agents/child/'] })
  })
  test('disjoint prefixes intersect to nothing (fails closed, not open)', () => {
    const child = { read: ['/agents/a/'], write: [] }
    const parent = { read: ['/agents/b/'], write: [] }
    expect(intersectWorkspaceScope(child, parent)).toEqual({ read: [], write: [] })
  })
})

describe('intersectAuthority — all four scopes combined (plan 67 §3.4 table)', () => {
  test('combines capability, device, permission, and workspace intersection in one call', () => {
    const child: RunAuthority = {
      tools: ['device.tap', 'device.install'],
      deviceGrants: [],
      permissions: ['device.control', 'device.shell'] as never,
      workspaceScope: { read: ['/'], write: ['/'] },
    }
    const parent: RunAuthority = {
      tools: ['device.tap'],
      deviceGrants: ['d1'],
      permissions: ['device.control'] as never,
      workspaceScope: { read: ['/agents/parent/'], write: ['/agents/parent/'] },
    }
    expect(intersectAuthority(child, parent)).toEqual({
      tools: ['device.tap'],
      deviceGrants: ['d1'],
      permissions: ['device.control'] as never,
      workspaceScope: { read: ['/agents/parent/'], write: ['/agents/parent/'] },
    })
  })
})

describe('ownAuthority', () => {
  function fakeAgent(overrides: Partial<Agent> = {}): Agent {
    return {
      id: 'a1',
      slug: 'a1',
      name: 'A1',
      description: null,
      colour: null,
      enabled: true,
      connectorId: null,
      model: null,
      systemPrompt: null,
      settings: {},
      tools: ['device.tap'],
      requiresApproval: [],
      deviceGrants: [],
      workspaceScope: { read: ['/'], write: ['/agents/a1/'] },
      permissions: ['device.control'],
      wakeOnMessage: 'on-child-result',
      ownerId: null,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    }
  }

  test('permissions are capped at the owner role live, not just copied from the record', () => {
    const agent = fakeAgent({ permissions: ['device.control', 'device.shell'] })
    const auth = ownAuthority(agent, 'operator')
    // an operator never holds device.shell — effectivePermissions filters it out live.
    expect(auth.permissions).toEqual(['device.control'])
  })

  test('a null owner role collapses permissions to empty, not a crash', () => {
    const agent = fakeAgent({ permissions: ['device.control'] })
    expect(ownAuthority(agent, null).permissions).toEqual([])
  })
})

describe('effectiveAuthorityForRun — live recomputation across a chain (plan 67 §3.4, criterion 4)', () => {
  function fakeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
    return {
      id,
      slug: id,
      name: id,
      description: null,
      colour: null,
      enabled: true,
      connectorId: null,
      model: null,
      systemPrompt: null,
      settings: {},
      tools: ['device.tap', 'device.install'],
      requiresApproval: [],
      deviceGrants: [],
      workspaceScope: { read: ['/'], write: ['/'] },
      permissions: ['device.control'],
      wakeOnMessage: 'on-child-result',
      ownerId: 'owner-1',
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    }
  }

  function depsFor(opts: {
    runs: Record<string, { threadId: string; parentRunId: string | null }>
    threads: Record<string, { agentId: string }>
    agents: Record<string, Agent>
    role: Role | null
  }): AuthorityLookupDeps {
    return {
      getRun: (id) => opts.runs[id] ?? null,
      getThread: (id) => opts.threads[id] ?? null,
      getAgent: (id) => opts.agents[id] ?? null,
      roleOf: () => opts.role,
    }
  }

  test('a root run (no parent) resolves to exactly its own authority', () => {
    const deps = depsFor({
      runs: { r1: { threadId: 't1', parentRunId: null } },
      threads: { t1: { agentId: 'root-agent' } },
      agents: { 'root-agent': fakeAgent('root-agent', { deviceGrants: ['d1'] }) },
      role: 'operator',
    })
    const auth = effectiveAuthorityForRun(deps, 'r1')
    expect(auth.deviceGrants).toEqual(['d1'])
    expect(auth.tools).toEqual(['device.tap', 'device.install'])
  })

  test('a two-level chain intersects child ∩ parent', () => {
    const deps = depsFor({
      runs: {
        root: { threadId: 't-root', parentRunId: null },
        child: { threadId: 't-child', parentRunId: 'root' },
      },
      threads: { 't-root': { agentId: 'root-agent' }, 't-child': { agentId: 'child-agent' } },
      agents: {
        'root-agent': fakeAgent('root-agent', { tools: ['device.tap'], deviceGrants: ['d1', 'd2'] }),
        'child-agent': fakeAgent('child-agent', { tools: ['device.tap', 'device.install'], deviceGrants: [] }),
      },
      role: 'operator',
    })
    const auth = effectiveAuthorityForRun(deps, 'child')
    expect(auth.tools).toEqual(['device.tap']) // device.install dropped — root never had it
    expect(auth.deviceGrants).toEqual(['d1', 'd2']) // child's empty (=all) ∩ root's restricted set
  })

  test('demoting the ROOT agent (narrower tools) narrows the child at its NEXT live check, not a cached snapshot', () => {
    const agents: Record<string, Agent> = {
      'root-agent': fakeAgent('root-agent', { tools: ['device.tap', 'device.install'] }),
      'child-agent': fakeAgent('child-agent', { tools: ['device.tap', 'device.install'] }),
    }
    const deps = depsFor({
      runs: { root: { threadId: 't-root', parentRunId: null }, child: { threadId: 't-child', parentRunId: 'root' } },
      threads: { 't-root': { agentId: 'root-agent' }, 't-child': { agentId: 'child-agent' } },
      agents,
      role: 'operator',
    })
    expect(effectiveAuthorityForRun(deps, 'child').tools).toEqual(['device.tap', 'device.install'])

    // The root agent's OWN allowlist narrows mid-run (an operator edits it, or its owner is demoted).
    agents['root-agent'] = fakeAgent('root-agent', { tools: ['device.tap'] })
    expect(effectiveAuthorityForRun(deps, 'child').tools).toEqual(['device.tap'])
  })

  test('a three-level chain (depth cap default 3) intersects transitively', () => {
    const deps = depsFor({
      runs: {
        root: { threadId: 't-root', parentRunId: null },
        mid: { threadId: 't-mid', parentRunId: 'root' },
        leaf: { threadId: 't-leaf', parentRunId: 'mid' },
      },
      threads: { 't-root': { agentId: 'a-root' }, 't-mid': { agentId: 'a-mid' }, 't-leaf': { agentId: 'a-leaf' } },
      agents: {
        'a-root': fakeAgent('a-root', { deviceGrants: ['d1', 'd2', 'd3'] }),
        'a-mid': fakeAgent('a-mid', { deviceGrants: ['d1', 'd2'] }),
        'a-leaf': fakeAgent('a-leaf', { deviceGrants: [] }),
      },
      role: 'operator',
    })
    expect(effectiveAuthorityForRun(deps, 'leaf').deviceGrants).toEqual(['d1', 'd2'])
  })
})
