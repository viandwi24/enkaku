import { describe, expect, test } from 'bun:test'
import type { WorkflowDocDraft, WorkflowNodeDraft } from './model'
import { deriveGraph } from './derive-graph'

function scriptNode(id: string, overrides: Partial<WorkflowNodeDraft & { kind: 'script' }> = {}): WorkflowNodeDraft {
  return {
    kind: 'script',
    id,
    title: '',
    script: 'demo@1.0.0',
    params: {},
    onFailure: { go: 'fail' },
    ...overrides,
  } as WorkflowNodeDraft
}

function gateNode(id: string, overrides: Partial<WorkflowNodeDraft & { kind: 'gate' }> = {}): WorkflowNodeDraft {
  return {
    kind: 'gate',
    id,
    title: '',
    when: { left: { const: true }, op: 'eq', right: { const: true } },
    then: { go: 'continue' },
    else: { go: 'stop' },
    message: '',
    ...overrides,
  } as WorkflowNodeDraft
}

function draft(nodes: WorkflowNodeDraft[]): WorkflowDocDraft {
  return { schema: 1, name: 'w', version: '1.0.0', title: '', description: '', params: [], nodes, maxSteps: 50 }
}

describe('deriveGraph — edges from next/onFailure/then/else, never a stored list (plan 102 §3.2, §3.3, §4.1, step 102.1)', () => {
  test('a plain linear script chain: each node\'s implicit `next` (array order) is an edge, its default onFailure ({fail}) is not', () => {
    const g = deriveGraph(draft([scriptNode('a'), scriptNode('b'), scriptNode('c')]))
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(g.edges).toEqual([
      { from: 'a', to: 'b', kind: 'next', backward: false },
      { from: 'b', to: 'c', kind: 'next', backward: false },
    ])
    expect(g.unreachable).toEqual([])
  })

  test('an explicit `next` overrides array order', () => {
    const g = deriveGraph(draft([scriptNode('a', { next: 'c' }), scriptNode('b'), scriptNode('c')]))
    const nextEdges = g.edges.filter((e) => e.kind === 'next')
    expect(nextEdges).toEqual([
      { from: 'a', to: 'c', kind: 'next', backward: false },
      { from: 'b', to: 'c', kind: 'next', backward: false },
    ])
    // 'b' is skipped by 'a's explicit next but is still reachable via its own array-order predecessor... except nothing points at it here, so it IS unreachable.
    expect(g.unreachable).toEqual(['b'])
  })

  test('a non-default onFailure produces its own edge; the default ({go:"fail"}) produces none', () => {
    const withCustom = deriveGraph(draft([scriptNode('a', { onFailure: { go: 'goto', node: 'c' } }), scriptNode('b'), scriptNode('c')]))
    expect(withCustom.edges).toContainEqual({ from: 'a', to: 'c', kind: 'onFailure', backward: false })

    const withDefault = deriveGraph(draft([scriptNode('a'), scriptNode('b')]))
    expect(withDefault.edges.some((e) => e.kind === 'onFailure')).toBe(false)
  })

  test('a gate always produces both a then and an else edge, or a terminal for stop/fail', () => {
    const g = deriveGraph(draft([gateNode('g', { then: { go: 'continue' }, else: { go: 'stop' } }), scriptNode('a')]))
    expect(g.edges).toEqual([{ from: 'g', to: 'a', kind: 'then', backward: false }])
    // 'else: stop' is a terminal — no edge to a node, per plan 102 §4.2.
    expect(g.edges.some((e) => e.kind === 'else')).toBe(false)
  })

  test('a forward goto and a backward goto (plan 102 G5 — the graph is not a DAG)', () => {
    const g = deriveGraph(
      draft([
        gateNode('check', { then: { go: 'goto', node: 'retry' }, else: { go: 'continue' } }),
        scriptNode('retry', { next: 'check' }), // jumps BACK to 'check'
        scriptNode('done'),
      ]),
    )
    const thenEdge = g.edges.find((e) => e.from === 'check' && e.kind === 'then')
    expect(thenEdge).toEqual({ from: 'check', to: 'retry', kind: 'then', backward: false })
    const backEdge = g.edges.find((e) => e.from === 'retry')
    expect(backEdge).toEqual({ from: 'retry', to: 'check', kind: 'next', backward: true })
  })

  test('stop/fail terminals never produce an edge to a node', () => {
    const g = deriveGraph(draft([gateNode('g', { then: { go: 'stop' }, else: { go: 'fail' } }), scriptNode('unreachable-target')]))
    expect(g.edges).toEqual([])
  })

  test('a next/goto naming a missing id is silently not drawn — not this function\'s job to flag (checkWorkflow does)', () => {
    const g = deriveGraph(draft([scriptNode('a', { next: 'does-not-exist' })]))
    expect(g.edges).toEqual([])
  })

  test('unreachable-node detection: a node no edge targets, excluding the entry node (index 0)', () => {
    const g = deriveGraph(draft([scriptNode('a', { next: 'c' }), scriptNode('b'), scriptNode('c')]))
    expect(g.unreachable).toEqual(['b'])
  })

  test('the entry node (index 0) is never reported unreachable even though nothing points at it', () => {
    const g = deriveGraph(draft([scriptNode('a')]))
    expect(g.unreachable).toEqual([])
  })

  test('a node reachable only via a backward goto is still reachable, not flagged', () => {
    const g = deriveGraph(
      draft([
        scriptNode('a', { next: 'loop-target' }),
        gateNode('loop-target', { then: { go: 'goto', node: 'a' }, else: { go: 'stop' } }),
      ]),
    )
    expect(g.unreachable).toEqual([])
  })

  test('node label falls back to id when title is blank, matching edges.ts\'s own titleOf convention', () => {
    const g = deriveGraph(draft([scriptNode('a', { title: 'Warm up' }), scriptNode('b')]))
    expect(g.nodes).toEqual([
      { id: 'a', kind: 'script', label: 'Warm up' },
      { id: 'b', kind: 'script', label: 'b' },
    ])
  })

  test('an empty document (no nodes) produces an empty graph, not a throw', () => {
    expect(deriveGraph(draft([]))).toEqual({ nodes: [], edges: [], unreachable: [] })
  })
})
