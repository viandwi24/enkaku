import { describe, expect, test } from 'bun:test'
import type { WorkflowDocDraft, WorkflowNodeDraft } from './model'
import { deriveGraph } from './derive-graph'
import { computeLayout } from './compute-layout'

function scriptNode(id: string, overrides: Partial<WorkflowNodeDraft & { kind: 'script' }> = {}): WorkflowNodeDraft {
  return { kind: 'script', id, title: '', script: 'demo@1.0.0', params: {}, onFailure: { go: 'fail' }, ...overrides } as WorkflowNodeDraft
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

/** No two nodes share the exact same (x, y) — the acceptance criterion's own "no overlapping nodes" (plan 102 §7). */
function assertNoOverlap(nodes: Array<{ x: number; y: number }>): void {
  const seen = new Set<string>()
  for (const n of nodes) {
    const key = `${n.x},${n.y}`
    expect(seen.has(key)).toBe(false)
    seen.add(key)
  }
}

describe('computeLayout — deterministic, terminates on a cycle, no overlap (plan 102 §3.2, §4.1, step 102.1)', () => {
  test('an empty graph lays out to nothing', () => {
    expect(computeLayout(deriveGraph(draft([])))).toEqual({ nodes: [] })
  })

  test('a linear chain lays out in strictly increasing columns, one row', () => {
    const layout = computeLayout(deriveGraph(draft([scriptNode('a'), scriptNode('b'), scriptNode('c')])))
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]))
    expect(byId.a!.x).toBeLessThan(byId.b!.x)
    expect(byId.b!.x).toBeLessThan(byId.c!.x)
    expect(byId.a!.y).toBe(byId.b!.y)
    expect(byId.b!.y).toBe(byId.c!.y)
    assertNoOverlap(layout.nodes)
  })

  test('a branch (two nodes at the same rank) gets two distinct rows, same column', () => {
    // Both branch targets are GATE nodes (never an implicit array-order
    // `next` the way a script node has) with their own terminal outcomes,
    // so neither branch accidentally chains into the other via array
    // fallthrough — isolating the actual thing under test: two nodes
    // reached at the same rank from the same source.
    const graph = deriveGraph(
      draft([
        gateNode('g', { then: { go: 'goto', node: 'left' }, else: { go: 'goto', node: 'right' } }),
        gateNode('left', { then: { go: 'stop' }, else: { go: 'stop' } }),
        gateNode('right', { then: { go: 'stop' }, else: { go: 'stop' } }),
      ]),
    )
    const layout = computeLayout(graph)
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]))
    expect(byId.left!.x).toBe(byId.right!.x)
    expect(byId.left!.y).not.toBe(byId.right!.y)
    assertNoOverlap(layout.nodes)
  })

  test('TERMINATES on a graph with a backward goto (plan 102 G5) — this is the specific thing a naive topological sort cannot do', () => {
    const graph = deriveGraph(
      draft([
        scriptNode('a', { next: 'loop' }),
        gateNode('loop', { then: { go: 'goto', node: 'a' }, else: { go: 'stop' } }), // backward jump to 'a'
        scriptNode('after'),
      ]),
    )
    // The mere fact this returns (rather than hanging) is the assertion —
    // bun:test's own timeout would fail this file if `computeLayout` looped.
    const layout = computeLayout(graph)
    expect(layout.nodes).toHaveLength(3)
    assertNoOverlap(layout.nodes)
  })

  test('a self-loop (a node whose own goto targets itself) terminates and does not crash', () => {
    const graph = deriveGraph(draft([gateNode('g', { then: { go: 'goto', node: 'g' }, else: { go: 'stop' } })]))
    expect(() => computeLayout(graph)).not.toThrow()
    assertNoOverlap(computeLayout(graph).nodes)
  })

  test('a node reachable only via a backward edge still gets a stable column (falls back to its own array index)', () => {
    // 'b' is targeted only by 'c's backward goto — no FORWARD edge reaches it at all.
    const graph = deriveGraph(
      draft([
        scriptNode('a', { next: 'c' }),
        scriptNode('b'),
        gateNode('c', { then: { go: 'goto', node: 'b' }, else: { go: 'stop' } }),
      ]),
    )
    const layout = computeLayout(graph)
    expect(layout.nodes.find((n) => n.id === 'b')).toBeDefined()
    assertNoOverlap(layout.nodes)
  })

  test('deterministic: the same input produces byte-identical output across repeated calls — "a layout that reshuffles on every open is unusable" (plan 102 §7)', () => {
    const graph = deriveGraph(
      draft([
        gateNode('g', { then: { go: 'goto', node: 'x' }, else: { go: 'goto', node: 'y' } }),
        scriptNode('x', { next: 'g' }), // backward
        scriptNode('y'),
      ]),
    )
    const first = computeLayout(graph)
    const second = computeLayout(graph)
    expect(second).toEqual(first)
  })

  test('a realistic longer linear workflow with one branch and one backward retry (standing in for "the longest workflow in examples/" — see plan status note: no workflow fixtures exist in examples/ today) lays out with no overlap and terminates', () => {
    const graph = deriveGraph(
      draft([
        scriptNode('provision'),
        scriptNode('login'),
        gateNode('login-ok', { then: { go: 'continue' }, else: { go: 'goto', node: 'login' } }), // retry loop, backward
        scriptNode('warm-up'),
        scriptNode('scroll-feed'),
        gateNode('rate-limited', { then: { go: 'goto', node: 'cooldown' }, else: { go: 'continue' } }),
        scriptNode('like-posts', { next: 'logout' }),
        scriptNode('cooldown', { next: 'scroll-feed' }),
        scriptNode('logout'),
      ]),
    )
    const layout = computeLayout(graph)
    expect(layout.nodes).toHaveLength(9)
    assertNoOverlap(layout.nodes)
    expect(graph.unreachable).toEqual([])
  })
})
