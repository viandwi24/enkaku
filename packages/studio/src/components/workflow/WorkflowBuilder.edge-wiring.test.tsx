import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { ScriptOption } from './ScriptPicker'

/**
 * Plan 102 (M67) §3.3, §4.2, §5 step 102.5 — the LAST HOP: does
 * `WorkflowBuilder` actually apply whatever `WorkflowCanvas` reports
 * through `onEdgeChange`, into the one real draft?
 *
 * `canvas-edit.test.ts` already proves the translation/write-back logic
 * with no renderer at all, and `WorkflowCanvas.test.tsx` proves the real
 * `@xyflow/react` library is wired to call that logic (handles exist with
 * the right ids, connectable state toggles correctly) — but happy-dom has
 * no real pointer/geometry engine, so neither file can simulate an actual
 * drag completing. This file closes that gap a different way: `@xyflow/react`
 * is mocked here (ONLY in this file — `mock.module` plus `--isolate`, the
 * same pattern `AdbRestartDialog.test.tsx` already uses for `@/lib/ws`) with
 * a `ReactFlow` stand-in that captures the exact props `WorkflowCanvas`
 * hands the real library, so `onConnect`/`onReconnect`/`onEdgesDelete` can
 * be invoked DIRECTLY with a plain `Connection`/`Edge` object — precisely
 * what a completed drag would eventually produce — and the result observed
 * through the list view, exactly like an operator would see it.
 *
 * This intentionally sacrifices real-library fidelity (no real handles, no
 * real pan/zoom) in exchange for testing the one thing no other test file
 * can reach: that a canvas edge edit really does turn into a draft write,
 * not just that the pieces on either side of that gap are individually
 * correct.
 */

let rfProps: Record<string, unknown> = {}

mock.module('@xyflow/react', () => ({
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => null,
  Handle: () => null,
  MiniMap: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  ReactFlowProvider: ({ children }: { children: unknown }) => children,
  ReactFlow: (props: Record<string, unknown>) => {
    rfProps = props
    return null
  },
}))

const { WorkflowBuilder } = await import('./WorkflowBuilder')
const { addScriptNode, emptyDraft, updateNode } = await import('./model')

afterEach(() => {
  cleanup()
  // `changeView('canvas')` persists to `localStorage` (plan 102 §5 step
  // 102.6) — without clearing it, a later test's fresh `WorkflowBuilder`
  // would read back an earlier test's view choice instead of the real
  // default, exactly like `app/page.test.tsx` already guards against for
  // its own `localStorage`-backed preference.
  localStorage.clear()
  // `rfProps` is a module-level capture (the mock's own state, not
  // React's) — cleared too, so a test that never mounts `WorkflowCanvas`
  // does not inherit the previous test's captured callbacks.
  rfProps = {}
})

function threeNodeDraft() {
  let d = emptyDraft()
  d.name = 'wf'
  d = addScriptNode(d, 'first')
  d = addScriptNode(d, 'second')
  d = addScriptNode(d, 'third')
  d = updateNode(d, 0, { script: 'demo@1.0.0' })
  d = updateNode(d, 1, { script: 'demo@1.0.0' })
  d = updateNode(d, 2, { script: 'demo@1.0.0' })
  return d
}

const scripts: ScriptOption[] = [{ id: 's-demo', name: 'demo', version: '1.0.0', enabled: true, paramsSchema: null }]

function openCanvas() {
  renderWithApi(<WorkflowBuilder initialDraft={threeNodeDraft()} scripts={scripts} onPublished={() => {}} />, {})
  fireEvent.click(screen.getByRole('button', { name: /^Canvas$/ }))
}

function backToList() {
  fireEvent.click(screen.getByRole('button', { name: /^List$/ }))
}

describe('WorkflowBuilder — an edge change from the canvas reaches the real draft (plan 102 §5 step 102.5)', () => {
  test('a new connection ("next" from a script node) retargets exactly like the list\'s own outcome picker would', () => {
    openCanvas()
    expect(rfProps.onConnect).toBeInstanceOf(Function)

    act(() => {
      ;(rfProps.onConnect as (c: unknown) => void)({ source: 'first', sourceHandle: 'next', target: 'third' })
    })

    backToList()
    expect(within(screen.getByTestId('node-card-0')).getByRole('combobox', { name: 'on success outcome' }).textContent).toBe('jump to third')
  })

  test('reconnecting an edge (onReconnect) writes the SAME field a fresh connection would', () => {
    openCanvas()
    expect(rfProps.onReconnect).toBeInstanceOf(Function)

    act(() => {
      ;(rfProps.onReconnect as (oldEdge: unknown, c: unknown) => void)({ id: 'first-next-second-0' }, { source: 'first', sourceHandle: 'next', target: 'third' })
    })

    backToList()
    expect(within(screen.getByTestId('node-card-0')).getByRole('combobox', { name: 'on success outcome' }).textContent).toBe('jump to third')
  })

  test('deleting an edge (onEdgesDelete) reverts the field to its no-explicit-edge default', () => {
    openCanvas()
    act(() => {
      ;(rfProps.onConnect as (c: unknown) => void)({ source: 'first', sourceHandle: 'next', target: 'third' })
    })
    expect(rfProps.onEdgesDelete).toBeInstanceOf(Function)

    act(() => {
      ;(rfProps.onEdgesDelete as (edges: unknown[]) => void)([{ source: 'first', sourceHandle: 'next' }])
    })

    backToList()
    // Back to "continue to the next node" — the same default a freshly-added node has.
    expect(within(screen.getByTestId('node-card-0')).getByRole('combobox', { name: 'on success outcome' }).textContent).toBe('continue to the next node')
  })

  test('a script node\'s "onFailure" handle writes a goto GateOutcome, visible in the panel\'s own onFailure picker', () => {
    openCanvas()
    act(() => {
      ;(rfProps.onConnect as (c: unknown) => void)({ source: 'first', sourceHandle: 'onFailure', target: 'second' })
    })

    backToList()
    const card0 = within(screen.getByTestId('node-card-0'))
    expect(card0.getByRole('combobox', { name: 'on failure outcome' }).textContent).toContain('Jump to a node')
    expect(card0.getByRole('combobox', { name: 'Jump target' }).textContent).toBe('second')
  })

  test('when the canvas is NOT the active view, no edge-change wiring exists to misfire — onEdgeChange is only ever handed to a mounted WorkflowCanvas', () => {
    renderWithApi(<WorkflowBuilder initialDraft={threeNodeDraft()} scripts={scripts} onPublished={() => {}} />, {})
    // List is the default view (plan 102 §2, §3.5) — WorkflowCanvas, and
    // therefore the mocked ReactFlow, never mounts at all.
    expect(rfProps.onConnect).toBeUndefined()
  })
})
