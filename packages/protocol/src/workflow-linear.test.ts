import { describe, expect, test } from 'bun:test'
import { gapExpr, readGap, readLinear } from './workflow-linear'
import { WorkflowDocSchema, type WorkflowDoc } from './workflow'

function startNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, ...overrides }
}
function scriptNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'script', id: 'n0', title: '', ui: { x: 0, y: 0 }, script: 'demo/a@1.0.0', params: {}, ...overrides }
}
function docOf(nodes: Record<string, unknown>[]): WorkflowDoc {
  return WorkflowDocSchema.parse({ schema: 2, name: 'seq', title: '', description: '', params: [], entry: 'start', nodes })
}

describe('readLinear — what Sequential Mode can open (plan 313 §3.3)', () => {
  test('a plain chain reads as an ordered list', () => {
    const doc = docOf([startNode({ next: 'a' }), scriptNode({ id: 'a', next: 'b' }), scriptNode({ id: 'b', next: 'c' }), scriptNode({ id: 'c' })])
    const result = readLinear(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.steps.map((s) => s.node.id)).toEqual(['a', 'b', 'c'])
    expect(result.view.steps.every((s) => s.delayBefore === null)).toBe(true)
  })

  test('a gate makes it unavailable, and says which node is the reason', () => {
    const doc = docOf([
      startNode({ next: 'g' }),
      { kind: 'gate', id: 'g', title: 'Enough?', ui: { x: 0, y: 0 }, when: { left: { const: 1 }, op: 'eq', right: { const: 1 } } },
    ])
    const result = readLinear(doc)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('branches')
    expect(result.refusal.nodeId).toBe('g')
    expect(result.refusal.message).toContain('Enough?')
  })

  test('the refusal is not one-way — deleting the branch makes it linear again', () => {
    const withGate = docOf([
      startNode({ next: 'g' }),
      { kind: 'gate', id: 'g', title: '', ui: { x: 0, y: 0 }, when: { left: { const: 1 }, op: 'eq', right: { const: 1 } } },
    ])
    expect(readLinear(withGate).ok).toBe(false)
    // The SAME workflow with the gate removed. This is the property that
    // makes a computed recogniser better than a stored mode flag: an author
    // is never trapped on the canvas by an edit they can undo.
    expect(readLinear(docOf([startNode({ next: 'a' }), scriptNode({ id: 'a' })])).ok).toBe(true)
  })

  test('a loop is refused as a loop, not mistaken for a list', () => {
    const doc = docOf([startNode({ next: 'a' }), scriptNode({ id: 'a', next: 'b' }), scriptNode({ id: 'b', next: 'a' })])
    const result = readLinear(doc)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('joins')
  })

  test('a node parked off to the side is refused rather than silently dropped', () => {
    const doc = docOf([startNode({ next: 'a' }), scriptNode({ id: 'a' }), scriptNode({ id: 'orphan' })])
    const result = readLinear(doc)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('unreachable')
    expect(result.refusal.nodeId).toBe('orphan')
  })

  test('a shuffle is a step, and its members are not orphans', () => {
    const doc = docOf([
      startNode({ next: 'sh' }),
      { kind: 'shuffle', id: 'sh', title: '', ui: { x: 0, y: 0 }, members: ['a', 'b'], next: 'tail' },
      scriptNode({ id: 'a' }),
      scriptNode({ id: 'b' }),
      scriptNode({ id: 'tail' }),
    ])
    const result = readLinear(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The members are owned by the shuffle, so the list shows the shuffle and
    // the tail — not five rows in an order that means nothing.
    expect(result.view.steps.map((s) => s.node.id)).toEqual(['sh', 'tail'])
  })

  test('an onFailure that ends the run is allowed; one that goes elsewhere is not', () => {
    const toFinish = docOf([
      startNode({ next: 'a' }),
      scriptNode({ id: 'a', next: 'b', onFailure: 'end' }),
      scriptNode({ id: 'b', next: 'end' }),
      { kind: 'finish', id: 'end', title: '', ui: { x: 0, y: 0 } },
    ])
    expect(readLinear(toFinish).ok).toBe(true)

    const toElsewhere = docOf([
      startNode({ next: 'a' }),
      scriptNode({ id: 'a', next: 'b', onFailure: 'rescue' }),
      scriptNode({ id: 'b' }),
      scriptNode({ id: 'rescue' }),
    ])
    expect(readLinear(toElsewhere).ok).toBe(false)
  })
})

describe('the delay-between-actions gap (plan 313 §4.5)', () => {
  test('gapExpr and readGap round-trip a range', () => {
    const expr = gapExpr(1000, 10_000)
    expect(expr).toEqual({ expr: '1000 + $random * 9000' })
    expect(readGap({ kind: 'delay', id: 'd', title: '', ui: { x: 0, y: 0 }, enabled: true, ms: expr, maxMs: 10_000 })).toEqual({ minMs: 1000, maxMs: 10_000 })
  })

  test('a range whose ends are equal is a literal, not an expression with a zero span', () => {
    expect(gapExpr(5000, 5000)).toEqual({ const: 5000 })
    expect(readGap({ kind: 'delay', id: 'd', title: '', ui: { x: 0, y: 0 }, enabled: true, ms: { const: 5000 }, maxMs: 5000 })).toEqual({ minMs: 5000, maxMs: 5000 })
  })

  test('a delay whose maxMs contradicts its expression is NOT a gap — the clamp, not the expression, is what runs', () => {
    // `1000 + $random * 9000` describes 1–10 s, but `maxMs: 3000` is the
    // executor's hard ceiling, so this node waits at most 3 s. Folding it into
    // the "1 to 10 seconds" control would put a number on screen that the run
    // does not honour.
    const clamped = { kind: 'delay' as const, id: 'd', title: '', ui: { x: 0, y: 0 }, enabled: true, ms: gapExpr(1000, 10_000), maxMs: 3000 }
    expect(readGap(clamped)).toBeNull()
    // The same node with an honest ceiling reads back fine.
    expect(readGap({ ...clamped, maxMs: 10_000 })).toEqual({ minMs: 1000, maxMs: 10_000 })
  })

  test('a hand-written expression is NOT read as a gap — the editor never folds away what it cannot write back', () => {
    const handWritten = { kind: 'delay' as const, id: 'd', title: '', ui: { x: 0, y: 0 }, enabled: true, ms: { expr: 'len($nodes.a.items) * 1000' }, maxMs: 10_000 }
    expect(readGap(handWritten)).toBeNull()
  })

  test('gaps between every pair are reported as one uniform delay the editor can bind a single control to', () => {
    const gap = () => ({ kind: 'delay', title: '', ui: { x: 0, y: 0 }, ms: gapExpr(1000, 10_000), maxMs: 10_000 })
    const doc = docOf([
      startNode({ next: 'a' }),
      scriptNode({ id: 'a', next: 'g1' }),
      { ...gap(), id: 'g1', next: 'b' },
      scriptNode({ id: 'b', next: 'g2' }),
      { ...gap(), id: 'g2', next: 'c' },
      scriptNode({ id: 'c' }),
    ])
    const result = readLinear(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.steps.map((s) => s.node.id)).toEqual(['a', 'b', 'c'])
    expect(result.view.uniformDelay).toEqual({ minMs: 1000, maxMs: 10_000 })
  })

  test('gaps that disagree report no uniform delay, so the control shows nothing rather than rewriting them', () => {
    const doc = docOf([
      startNode({ next: 'a' }),
      scriptNode({ id: 'a', next: 'g1' }),
      { kind: 'delay', id: 'g1', title: '', ui: { x: 0, y: 0 }, ms: gapExpr(1000, 10_000), maxMs: 10_000, next: 'b' },
      scriptNode({ id: 'b', next: 'g2' }),
      { kind: 'delay', id: 'g2', title: '', ui: { x: 0, y: 0 }, ms: gapExpr(2000, 3000), maxMs: 3000, next: 'c' },
      scriptNode({ id: 'c' }),
    ])
    const result = readLinear(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.uniformDelay).toBeNull()
  })

  test('a delay BEFORE the first action stays an action of its own — there is no pair for it to sit between', () => {
    const doc = docOf([
      startNode({ next: 'g0' }),
      { kind: 'delay', id: 'g0', title: '', ui: { x: 0, y: 0 }, ms: gapExpr(1000, 2000), maxMs: 2000, next: 'a' },
      scriptNode({ id: 'a' }),
    ])
    const result = readLinear(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.steps.map((s) => s.node.id)).toEqual(['g0', 'a'])
  })
})
