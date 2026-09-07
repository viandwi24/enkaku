import { describe, expect, test } from 'bun:test'
import { groupSplitCases, groupSplitExpr, readGrouped, readStagger } from './workflow-groups'
import { WorkflowDocSchema, type WorkflowDoc } from './workflow'

function startNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, ...overrides }
}
function scriptNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'script', id: 'n0', title: '', ui: { x: 0, y: 0 }, script: 'demo/a@1.0.0', params: {}, ...overrides }
}
function finishNode(id = 'done') {
  return { kind: 'finish', id, title: '', ui: { x: 0, y: 0 } }
}
/** The split every test below shares: G cases on `$run.index % G`, one per share. */
function splitNode(targets: (string | undefined)[], overrides: Record<string, unknown> = {}) {
  return {
    kind: 'switch',
    id: 'split',
    title: 'Split',
    ui: { x: 0, y: 0 },
    mode: 'predicate',
    cases: targets.map((to, i) => ({
      when: { left: { expr: groupSplitExpr(targets.length) }, op: 'eq', right: { const: i } },
      ...(to === undefined ? {} : { to }),
      label: `share ${i + 1}`,
    })),
    ...overrides,
  }
}
function docOf(nodes: Record<string, unknown>[]): WorkflowDoc {
  return WorkflowDocSchema.parse({ schema: 2, name: 'grp', title: '', description: '', params: [], entry: 'start', nodes })
}

describe('readGrouped — what Grouped Mode can open', () => {
  test('a split into shares reads as one list per share, all ending at one finish', () => {
    const doc = docOf([
      startNode({ next: 'split' }),
      splitNode(['a', 'b']),
      scriptNode({ id: 'a', next: 'done' }),
      scriptNode({ id: 'b', next: 'done' }),
      finishNode(),
    ])
    const result = readGrouped(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.groupCount).toBe(2)
    expect(result.view.groups.map((g) => g.steps.map((s) => s.node.id))).toEqual([['a'], ['b']])
    // A finish is a sink: every share arriving at the same one is the ordinary
    // shape, not a join between shares.
    expect(result.view.finishes.map((f) => f.id)).toEqual(['done'])
  })

  test('a share with no actions yet is a group, not a refusal', () => {
    const doc = docOf([startNode({ next: 'split' }), splitNode(['a', undefined]), scriptNode({ id: 'a', next: 'done' }), finishNode()])
    const result = readGrouped(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.groups[1]?.steps).toEqual([])
    expect(result.view.groups[1]?.headId).toBeUndefined()
  })

  test('a delay between start and the split is the per-device stagger, not an action', () => {
    const doc = docOf([
      startNode({ next: 'hold' }),
      { kind: 'delay', id: 'hold', title: '', ui: { x: 0, y: 0 }, next: 'split', ms: { expr: 'floor($random * 300000)' }, maxMs: 300_000 },
      splitNode(['a', 'b']),
      scriptNode({ id: 'a', next: 'done' }),
      scriptNode({ id: 'b', next: 'done' }),
      finishNode(),
    ])
    const result = readGrouped(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.stagger).toEqual({ node: expect.anything(), minMs: 0, maxMs: 300_000 })
    // It belongs to no share — it ran before the split.
    expect(result.view.groups.flatMap((g) => g.steps.map((s) => s.node.id))).toEqual(['a', 'b'])
  })

  test('a fallback that only ends the run is allowed; one that does work is not', () => {
    const terminal = docOf([
      startNode({ next: 'split' }),
      splitNode(['a', 'b'], { default: 'failed' }),
      scriptNode({ id: 'a', next: 'done' }),
      scriptNode({ id: 'b', next: 'done' }),
      finishNode(),
      { kind: 'finish', id: 'failed', title: '', ui: { x: 0, y: 0 }, status: 'fail' },
    ])
    expect(readGrouped(terminal).ok).toBe(true)

    const working = docOf([
      startNode({ next: 'split' }),
      splitNode(['a', 'b'], { default: 'rescue' }),
      scriptNode({ id: 'a', next: 'done' }),
      scriptNode({ id: 'b', next: 'done' }),
      scriptNode({ id: 'rescue', next: 'done' }),
      finishNode(),
    ])
    const result = readGrouped(working)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('branches')
  })

  test('a node two shares both run makes them dependent, and is refused', () => {
    const doc = docOf([
      startNode({ next: 'split' }),
      splitNode(['a', 'a']),
      scriptNode({ id: 'a', next: 'done' }),
      finishNode(),
    ])
    const result = readGrouped(doc)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('joins')
  })

  test('a switch on anything but an even split of the fleet is not a group split', () => {
    const doc = docOf([
      startNode({ next: 'split' }),
      {
        kind: 'switch',
        id: 'split',
        title: 'By battery',
        ui: { x: 0, y: 0 },
        mode: 'predicate',
        cases: [
          { when: { left: { expr: '$device.battery' }, op: 'gt', right: { const: 50 } }, to: 'a', label: '' },
          { when: { left: { expr: '$device.battery' }, op: 'lte', right: { const: 50 } }, to: 'b', label: '' },
        ],
      },
      scriptNode({ id: 'a', next: 'done' }),
      scriptNode({ id: 'b', next: 'done' }),
      finishNode(),
    ])
    const result = readGrouped(doc)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('not-grouped')
  })

  test('round trip — the cases the editor writes are the cases the lens reads', () => {
    // The writer and the reader are the same shape or they are nothing: the
    // editor builds its `cases` with `groupSplitCases`, so a document assembled
    // that way must read back with the same group count, targets and labels.
    const doc = docOf([
      startNode({ next: 'split' }),
      {
        kind: 'switch',
        id: 'split',
        title: 'Split 3 ways',
        ui: { x: 0, y: 0 },
        mode: 'predicate',
        cases: groupSplitCases(3, [{ to: 'a', label: 'Scrollers' }, { to: 'b' }, {}]),
      },
      scriptNode({ id: 'a', next: 'done' }),
      scriptNode({ id: 'b', next: 'done' }),
      finishNode(),
    ])
    const result = readGrouped(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.groupCount).toBe(3)
    expect(result.view.groups.map((g) => g.headId)).toEqual(['a', 'b', undefined])
    expect(result.view.groups.map((g) => g.label)).toEqual(['Scrollers', 'Group 2', 'Group 3'])
  })

  test('the refusal is not one-way — a plain sequence is simply not grouped', () => {
    const doc = docOf([startNode({ next: 'a' }), scriptNode({ id: 'a', next: 'done' }), finishNode()])
    const result = readGrouped(doc)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('not-grouped')
  })
})

describe('readStagger — both written forms, and the ceiling that must agree', () => {
  /** Built through the schema rather than cast, so the fixture is a node the document format actually admits. */
  function delay(ms: unknown, maxMs: number) {
    const doc = docOf([startNode({ next: 'd' }), { kind: 'delay', id: 'd', title: '', ui: { x: 0, y: 0 }, ms, maxMs }])
    const node = doc.nodes.find((n) => n.id === 'd')
    if (node === undefined) throw new Error('fixture did not survive the schema')
    return node
  }

  test('reads the hand-written floor($random * n) form as 0..n', () => {
    expect(readStagger(delay({ expr: 'floor($random * 300000)' }, 300_000))).toEqual({ minMs: 0, maxMs: 300_000 })
  })

  test('reads the editor-written min + $random * span form', () => {
    expect(readStagger(delay({ expr: '20000 + $random * 10000' }, 30_000))).toEqual({ minMs: 20_000, maxMs: 30_000 })
  })

  test('a ceiling that disagrees with the expression is not a range', () => {
    // The executor clamps to `maxMs`, so reporting 0-300s here would put a
    // number on screen the run does not honour.
    expect(readStagger(delay({ expr: 'floor($random * 300000)' }, 3_000))).toBeNull()
  })
})
