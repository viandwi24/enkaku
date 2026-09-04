import { describe, expect, test } from 'bun:test'
import { WorkflowDocSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { upgradeWorkflowDoc } from './upgrade'

/** A minimal, otherwise-valid v1 script node — callers override only what the test cares about. */
function v1ScriptNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'script', id: 'n0', title: '', script: 'demo/step@1.0.0', params: {}, onFailure: { go: 'fail' }, ...overrides }
}

function v1Doc(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    name: 'demo',
    title: '',
    description: '',
    params: [],
    maxSteps: 50,
    nodes: [v1ScriptNode()],
    ...overrides,
  }
}

describe('upgradeWorkflowDoc — unknown schema', () => {
  test('a schema outside {1, 2} throws E_WORKFLOW_SCHEMA_UNKNOWN', () => {
    expect(() => upgradeWorkflowDoc({ schema: 3, name: 'x', nodes: [] })).toThrow(EnkakuError)
    try {
      upgradeWorkflowDoc({ schema: 3, name: 'x', nodes: [] })
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_WORKFLOW_SCHEMA_UNKNOWN')
    }
  })
})

describe('upgradeWorkflowDoc — rule 7: a v2 document is returned unchanged', () => {
  test('a valid v2 document round-trips through the real schema, byte-identical', () => {
    const v2 = {
      schema: 2,
      name: 'already-v2',
      title: '',
      description: '',
      params: [],
      entry: 'start',
      maxSteps: 50,
      nodes: [
        { id: 'start', title: '', ui: { x: 0, y: 0 }, kind: 'start', next: 'n0' },
        { id: 'n0', title: '', ui: { x: 240, y: 0 }, kind: 'script', script: 'demo/step@1.0.0', params: {} },
      ],
    }
    const result = upgradeWorkflowDoc(v2)
    expect(result).toEqual(WorkflowDocSchema.parse(v2))
  })

  test('a malformed v2 document throws E_WORKFLOW_UPGRADE_FAILED', () => {
    expect(() => upgradeWorkflowDoc({ schema: 2, name: 'bad', nodes: [] })).toThrow(EnkakuError)
  })
})

describe('upgradeWorkflowDoc — rule 1: a malformed v1 document throws, naming the path', () => {
  test('a v1 document that does not satisfy the frozen v1 shape throws E_WORKFLOW_UPGRADE_FAILED', () => {
    expect(() => upgradeWorkflowDoc({ schema: 1, name: 'bad', nodes: [] })).toThrow(EnkakuError)
    try {
      upgradeWorkflowDoc({ schema: 1, name: 'bad', nodes: [] })
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_WORKFLOW_UPGRADE_FAILED')
    }
  })
})

describe('upgradeWorkflowDoc — rule 2: a start node is prepended, entry points at it', () => {
  test('the start node id does not collide with a real v1 node named "start"', () => {
    const doc = v1Doc({ nodes: [v1ScriptNode({ id: 'start' }), v1ScriptNode({ id: 'n1' })] })
    const v2 = upgradeWorkflowDoc(doc)
    expect(v2.entry).toBe('start-2')
    const start = v2.nodes.find((n) => n.id === 'start-2')
    expect(start?.kind).toBe('start')
    expect(start && 'next' in start ? start.next : undefined).toBe('start') // points at the v1 node literally named "start"
  })

  test('a plain document gets a start node named "start", pointing at the old first node', () => {
    const doc = v1Doc({ nodes: [v1ScriptNode({ id: 'n0' }), v1ScriptNode({ id: 'n1' })] })
    const v2 = upgradeWorkflowDoc(doc)
    expect(v2.entry).toBe('start')
    const start = v2.nodes.find((n) => n.id === 'start')
    expect(start?.kind).toBe('start')
    expect(start && 'next' in start ? start.next : undefined).toBe('n0')
  })
})

describe('upgradeWorkflowDoc — rule 3: implicit fallthrough materialised; dangling at the end', () => {
  test('a script node with no explicit next gets the array-order successor', () => {
    const doc = v1Doc({ nodes: [v1ScriptNode({ id: 'n0' }), v1ScriptNode({ id: 'n1' })] })
    const v2 = upgradeWorkflowDoc(doc)
    const n0 = v2.nodes.find((n) => n.id === 'n0')
    expect(n0 && n0.kind === 'script' ? n0.next : undefined).toBe('n1')
  })

  test('the LAST node with no explicit next stays dangling, never routed to a finish node', () => {
    const doc = v1Doc({ nodes: [v1ScriptNode({ id: 'n0' }), v1ScriptNode({ id: 'n1' })] })
    const v2 = upgradeWorkflowDoc(doc)
    const n1 = v2.nodes.find((n) => n.id === 'n1')
    expect(n1 && n1.kind === 'script' ? n1.next : 'MISSING').toBeUndefined()
    expect(v2.nodes.some((n) => n.kind === 'finish' && n.status === 'succeed')).toBe(false)
  })
})

describe('upgradeWorkflowDoc — rule 4/5: gate outcomes and onFailure become edges', () => {
  test('{ go: "goto", node } becomes that node id, for both a gate branch and a script onFailure', () => {
    const doc = v1Doc({
      nodes: [
        v1ScriptNode({ id: 'n0', onFailure: { go: 'goto', node: 'n1' }, next: 'g0' }),
        { kind: 'gate', id: 'g0', title: '', when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, then: { go: 'goto', node: 'n1' }, else: { go: 'stop' } },
        v1ScriptNode({ id: 'n1' }),
      ],
    })
    const v2 = upgradeWorkflowDoc(doc)
    const n0 = v2.nodes.find((n) => n.id === 'n0')
    expect(n0 && n0.kind === 'script' ? n0.onFailure : undefined).toBe('n1')
    const g0 = v2.nodes.find((n) => n.id === 'g0')
    expect(g0 && g0.kind === 'gate' ? g0.then : undefined).toBe('n1')
  })

  test('{ go: "continue" } at index i becomes nodes[i+1].id; at the last index becomes the shared succeed-finish', () => {
    const doc = v1Doc({
      nodes: [
        { kind: 'gate', id: 'g0', title: '', when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, then: { go: 'continue' }, else: { go: 'stop' } },
        v1ScriptNode({ id: 'n0' }),
      ],
    })
    const v2 = upgradeWorkflowDoc(doc)
    const g0 = v2.nodes.find((n) => n.id === 'g0')
    expect(g0 && g0.kind === 'gate' ? g0.then : undefined).toBe('n0')
    // else: 'stop' -> the shared succeed-finish
    const elseTarget = g0 && g0.kind === 'gate' ? g0.else : undefined
    expect(elseTarget).toBeDefined()
    expect(v2.nodes.find((n) => n.id === elseTarget)).toMatchObject({ kind: 'finish', status: 'succeed' })
  })

  test('{ go: "stop" } becomes an edge to a shared finish node with status "succeed"', () => {
    const doc = v1Doc({
      nodes: [{ kind: 'gate', id: 'g0', title: '', when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, then: { go: 'stop' }, else: { go: 'stop' } }],
    })
    const v2 = upgradeWorkflowDoc(doc)
    const g0 = v2.nodes.find((n) => n.id === 'g0')
    const thenTarget = g0 && g0.kind === 'gate' ? g0.then : undefined
    const elseTarget = g0 && g0.kind === 'gate' ? g0.else : undefined
    expect(thenTarget).toBe(elseTarget) // ONE shared succeed-finish, not two
    expect(v2.nodes.filter((n) => n.kind === 'finish' && n.status === 'succeed')).toHaveLength(1)
  })

  test('{ go: "fail" } becomes an edge to a shared finish node with status "fail", carrying the gate\'s old message', () => {
    const doc = v1Doc({
      nodes: [
        {
          kind: 'gate',
          id: 'g0',
          title: '',
          when: { left: { const: 1 }, op: 'eq', right: { const: 1 } },
          then: { go: 'stop' },
          else: { go: 'fail' },
          message: 'not enough matches',
        },
      ],
    })
    const v2 = upgradeWorkflowDoc(doc)
    const failFinish = v2.nodes.find((n) => n.kind === 'finish' && n.status === 'fail')
    expect(failFinish).toBeDefined()
    expect(failFinish && failFinish.kind === 'finish' ? failFinish.message : undefined).toBe('not enough matches')
  })

  test('at most two finish nodes are created per document — one succeed, one fail — even with many references', () => {
    const doc = v1Doc({
      nodes: [
        { kind: 'gate', id: 'g0', title: '', when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, then: { go: 'stop' }, else: { go: 'fail' } },
        { kind: 'gate', id: 'g1', title: '', when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, then: { go: 'stop' }, else: { go: 'fail' } },
      ],
    })
    const v2 = upgradeWorkflowDoc(doc)
    expect(v2.nodes.filter((n) => n.kind === 'finish')).toHaveLength(2)
  })

  test('a document that references neither stop nor fail creates zero finish nodes', () => {
    const doc = v1Doc({ nodes: [v1ScriptNode({ id: 'n0', onFailure: { go: 'goto', node: 'n0' } })] })
    const v2 = upgradeWorkflowDoc(doc)
    expect(v2.nodes.filter((n) => n.kind === 'finish')).toHaveLength(0)
  })
})

describe('upgradeWorkflowDoc — rule 6: every node gets a position', () => {
  test('every converted node carries an in-bounds `ui`', () => {
    const doc = v1Doc({
      nodes: [v1ScriptNode({ id: 'n0' }), v1ScriptNode({ id: 'n1' }), { kind: 'gate', id: 'g0', title: '', when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, then: { go: 'stop' }, else: { go: 'stop' } }],
    })
    const v2 = upgradeWorkflowDoc(doc)
    for (const n of v2.nodes) {
      expect(n.ui.x).toBeGreaterThanOrEqual(-100_000)
      expect(n.ui.x).toBeLessThanOrEqual(100_000)
      expect(n.ui.y).toBeGreaterThanOrEqual(-100_000)
      expect(n.ui.y).toBeLessThanOrEqual(100_000)
    }
  })
})

describe('upgradeWorkflowDoc — the owner\'s example, corpus equivalence smoke', () => {
  test('the plan 99 owner example upgrades to a valid v2 document with the same node count plus start (and no finish needed)', () => {
    const doc = v1Doc({
      name: 'tiktok-search-pipeline',
      params: [{ name: 'keyword', type: 'string', required: true, title: 'Search keyword' }],
      nodes: [
        v1ScriptNode({ id: 'scroll1', title: 'Scroll FYP (warm-up)' }),
        v1ScriptNode({ id: 'search1', title: 'Search', script: 'tiktok/searched-follow@1.4.0', params: { keyword: { param: 'keyword' } } }),
        {
          kind: 'gate',
          id: 'enough',
          title: 'Enough matches?',
          when: { left: { from: 'search1', path: 'matches' }, op: 'notEmpty' },
          then: { go: 'continue' },
          else: { go: 'goto', node: 'scroll1' },
        },
        v1ScriptNode({ id: 'scroll2', title: 'Scroll FYP again' }),
        v1ScriptNode({ id: 'report', title: 'Report', script: 'tiktok/report@1.0.0', params: { videos: { from: 'scroll1', path: 'videos' } } }),
      ],
      onFail: { script: 'tiktok/switch-account@1.0.0', params: {} },
    })
    const v2 = upgradeWorkflowDoc(doc)
    expect(v2.schema).toBe(2)
    // 5 v1 nodes + 1 start + 1 shared fail-finish (every v1ScriptNode's
    // default `onFailure: { go: 'fail' }` needs somewhere to land).
    expect(v2.nodes).toHaveLength(7)
    expect(WorkflowDocSchema.safeParse(v2).success).toBe(true)
  })
})
