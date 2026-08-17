import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { WorkflowDocDraft, WorkflowNodeDraft } from './model'
import { deriveGraph } from './derive-graph'
import { WorkflowCanvas } from './WorkflowCanvas'

afterEach(cleanup)

// happy-dom has no ResizeObserver — @xyflow/react's viewport measurement
// needs one to mount without throwing. A minimal stub is enough: this test
// only asserts on rendered node/edge counts and click wiring, never on real
// pixel geometry.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= StubResizeObserver

function scriptNode(id: string, overrides: Partial<WorkflowNodeDraft & { kind: 'script' }> = {}): WorkflowNodeDraft {
  return { kind: 'script', id, title: id, script: 'demo@1.0.0', params: {}, onFailure: { go: 'fail' }, ...overrides } as WorkflowNodeDraft
}

function gateNode(id: string, overrides: Partial<WorkflowNodeDraft & { kind: 'gate' }> = {}): WorkflowNodeDraft {
  return {
    kind: 'gate',
    id,
    title: id,
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

/**
 * Plan 102 (M67) §5 step 102.3/102.4/102.5 — the canvas renders a real
 * workflow and its edge set matches `deriveGraph`'s output exactly (102.3's
 * own verifiable result). Selecting a node fires `onSelectNode` with the
 * node's id and NOTHING else — this component renders no editor of its
 * own; `WorkflowBuilder.tsx` (not this file) is what mounts the SAME
 * `NodeCard` the list uses, in a side panel, which is 102.4's real
 * acceptance (`WorkflowBuilder.test.tsx` proves that half). 102.5's edge
 * EDITING is proven two other ways, deliberately not here: the
 * connection/reconnection/deletion → field write-back logic lives in
 * `canvas-edit.ts` and is pure-function tested in `canvas-edit.test.ts`
 * with no renderer at all (same reasoning this file's own header once gave
 * for `deriveGraph`'s edge maths — "no component test ever has to assert
 * on graph maths", extended here to "or on drag maths", since happy-dom has
 * no real pointer/geometry engine to simulate an actual drag with); this
 * file instead proves the WIRING — that an editable canvas actually marks
 * its handles connectable and a read-only one does not.
 */
describe('WorkflowCanvas (plan 102 §3.1, §3.2, §4.1, step 102.3)', () => {
  const fixture = draft([
    scriptNode('provision'),
    gateNode('login-ok', { then: { go: 'continue' }, else: { go: 'goto', node: 'provision' } }),
    scriptNode('scroll-feed'),
  ])

  test('renders one graph node per workflow node, labelled by title', () => {
    renderWithApi(<WorkflowCanvas draft={fixture} />, {})
    expect(screen.getByText('provision')).toBeTruthy()
    expect(screen.getByText('login-ok')).toBeTruthy()
    expect(screen.getByText('scroll-feed')).toBeTruthy()
  })

  test('the edges layer renders — actual per-edge PATH geometry needs a real layout engine happy-dom does not have, so the exact edge SET (from/to/kind) is `derive-graph.test.ts`\'s job, not a component test\'s (plan 102 §3.3, §4.1: "no component test ever has to assert on graph maths")', () => {
    const { container } = renderWithApi(<WorkflowCanvas draft={fixture} />, {})
    expect(container.querySelector('.react-flow__edges')).toBeTruthy()
    const graph = deriveGraph(fixture)
    expect(graph.edges.length).toBeGreaterThan(0) // a test that passes over zero edges proves nothing
  })

  test('an unreachable node is marked in the DOM — Validate reads the SAME deriveGraph output, so the two can never disagree (plan 102 §4.3)', () => {
    // 'a' explicitly skips past 'orphan' straight to 'end'; 'orphan' has no
    // explicit `next` either, so its own implicit array-order edge points
    // OUT to 'end' — but nothing anywhere points INTO 'orphan'.
    const withOrphan = draft([scriptNode('a', { next: 'end' }), scriptNode('orphan'), scriptNode('end')])
    const graph = deriveGraph(withOrphan)
    expect(graph.unreachable).toEqual(['orphan'])
    renderWithApi(<WorkflowCanvas draft={withOrphan} />, {})
    expect(screen.getByText('orphan')).toBeTruthy()
    expect(screen.getByText('unreachable')).toBeTruthy()
  })

  test('clicking a node fires onSelectNode with that node\'s id, and nothing else', () => {
    const selected: string[] = []
    renderWithApi(<WorkflowCanvas draft={fixture} onSelectNode={(id) => selected.push(id)} />, {})
    fireEvent.click(screen.getByText('scroll-feed'))
    expect(selected).toEqual(['scroll-feed'])
  })

  describe('step 102.5 — the edge-editing handles', () => {
    test('a script node gets "next"/"onFailure"/"target" handles; a gate gets "then"/"else"/"target"', () => {
      const { container } = renderWithApi(<WorkflowCanvas draft={fixture} onEdgeChange={() => {}} />, {})
      // 'provision' and 'scroll-feed' are script nodes; 'login-ok' is a gate.
      expect(container.querySelectorAll('[data-nodeid="provision"][data-handleid="next"]')).toHaveLength(1)
      expect(container.querySelectorAll('[data-nodeid="provision"][data-handleid="onFailure"]')).toHaveLength(1)
      expect(container.querySelectorAll('[data-nodeid="provision"][data-handleid="target"]')).toHaveLength(1)
      expect(container.querySelectorAll('[data-nodeid="login-ok"][data-handleid="then"]')).toHaveLength(1)
      expect(container.querySelectorAll('[data-nodeid="login-ok"][data-handleid="else"]')).toHaveLength(1)
      // A script node never gets a "then"/"else" handle, nor a gate a "next"/"onFailure" one.
      expect(container.querySelectorAll('[data-nodeid="provision"][data-handleid="then"]')).toHaveLength(0)
      expect(container.querySelectorAll('[data-nodeid="login-ok"][data-handleid="next"]')).toHaveLength(0)
    })

    test('without onEdgeChange the canvas is read-only — no handle is marked connectable', () => {
      const { container } = renderWithApi(<WorkflowCanvas draft={fixture} />, {})
      expect(container.querySelectorAll('.react-flow__handle').length).toBeGreaterThan(0) // handles still render (labelled, just inert)
      expect(container.querySelectorAll('.react-flow__handle.connectable').length).toBe(0)
    })

    test('with onEdgeChange every handle is marked connectable — this is what makes 102.5 an editable canvas rather than a read-only one', () => {
      const { container } = renderWithApi(<WorkflowCanvas draft={fixture} onEdgeChange={() => {}} />, {})
      const handles = container.querySelectorAll('.react-flow__handle')
      const connectable = container.querySelectorAll('.react-flow__handle.connectable')
      expect(connectable.length).toBe(handles.length)
      expect(connectable.length).toBeGreaterThan(0)
    })
  })
})
