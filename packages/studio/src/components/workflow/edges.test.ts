import { describe, expect, test } from 'bun:test'
import type { WorkflowNodeDraft } from './model'
import { describeOutcome, edgeLabelsFor, hasAnyExplicitEdges } from './edges'

function scriptNode(overrides: Partial<WorkflowNodeDraft> = {}): WorkflowNodeDraft {
  return { kind: 'script', id: 'n', title: '', script: 'a@1.0.0', params: {}, onFailure: { go: 'fail' }, ...overrides } as WorkflowNodeDraft
}

function gateNode(overrides: Partial<WorkflowNodeDraft> = {}): WorkflowNodeDraft {
  return {
    kind: 'gate',
    id: 'g',
    title: '',
    when: { left: { const: true }, op: 'eq', right: { const: true } },
    then: { go: 'continue' },
    else: { go: 'stop' },
    message: '',
    ...overrides,
  } as WorkflowNodeDraft
}

describe('edgeLabelsFor — only the rail-worthy rows (plan 99 §3.9, §4.11)', () => {
  test('a plain linear script node (no override) draws nothing', () => {
    const nodes = [scriptNode({ id: 'a' }), scriptNode({ id: 'b' })]
    expect(edgeLabelsFor(nodes, 0)).toEqual([])
  })

  test('an explicit `next` that matches the array\'s own order still draws nothing (it is not actually a deviation)', () => {
    const nodes = [scriptNode({ id: 'a', next: 'b' }), scriptNode({ id: 'b' })]
    expect(edgeLabelsFor(nodes, 0)).toEqual([])
  })

  test('an explicit `next` elsewhere draws a "next" label', () => {
    const nodes = [scriptNode({ id: 'a', next: 'c' }), scriptNode({ id: 'b' }), scriptNode({ id: 'c' })]
    const labels = edgeLabelsFor(nodes, 0)
    expect(labels).toHaveLength(1)
    expect(labels[0]?.kind).toBe('next')
    expect(labels[0]?.text).toContain('c')
  })

  test('a non-default onFailure draws an "onFailure" label', () => {
    const nodes = [scriptNode({ id: 'a', onFailure: { go: 'continue' } })]
    const labels = edgeLabelsFor(nodes, 0)
    expect(labels).toEqual([{ kind: 'onFailure', text: expect.stringContaining('continue') }])
  })

  test('a gate ALWAYS draws both then and else, even at their schema defaults', () => {
    const nodes = [gateNode()]
    const labels = edgeLabelsFor(nodes, 0)
    expect(labels.map((l) => l.kind)).toEqual(['then', 'else'])
  })

  test('hasAnyExplicitEdges is false for an all-default linear script pipeline, true once a gate is present', () => {
    expect(hasAnyExplicitEdges({ nodes: [scriptNode({ id: 'a' }), scriptNode({ id: 'b' })] } as never)).toBe(false)
    expect(hasAnyExplicitEdges({ nodes: [scriptNode({ id: 'a' }), gateNode()] } as never)).toBe(true)
  })
})

describe('describeOutcome', () => {
  test('names a goto target by title, falling back to its id', () => {
    const nodes = [scriptNode({ id: 'a', title: 'Scroll FYP' })]
    expect(describeOutcome({ go: 'goto', node: 'a' }, nodes)).toBe('jump to Scroll FYP (a)')
    expect(describeOutcome({ go: 'goto', node: 'missing' }, nodes)).toBe('jump to missing')
  })

  test('the plain-language sentence for each terminal outcome', () => {
    expect(describeOutcome({ go: 'continue' }, [])).toBe('continue to the next node')
    expect(describeOutcome({ go: 'stop' }, [])).toBe('stop the workflow — success')
    expect(describeOutcome({ go: 'fail' }, [])).toBe('stop the workflow — failed')
  })
})
