import { describe, expect, test } from 'bun:test'
import {
  GATE_OPS,
  PredicateSchema,
  ValueExprSchema,
  WORKFLOW_LIMITS,
  WorkflowDocSchema,
  WorkflowNameSchema,
  WorkflowNodeIdSchema,
  WorkflowNodeSchema,
  WorkflowPathSchema,
  WorkflowPointSchema,
} from './workflow'

/** A minimal, otherwise-valid script node — callers override only what the test cares about. */
function scriptNode(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'script',
    id: 'n0',
    title: '',
    ui: { x: 0, y: 0 },
    script: 'tiktok/auto-scroll@1.4.0',
    params: {},
    ...overrides,
  }
}

function startNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, ...overrides }
}

function finishNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'finish', id: 'finish', title: '', ui: { x: 0, y: 0 }, ...overrides }
}

describe('WorkflowDocSchema — v2 shape', () => {
  // The owner's own example (plan 99 §0, adapted to doc v2, plan 301): start
  // → Scroll FYP (warm-up) → Search Keywords & Scroll Posts → [gate: enough
  // matches?] → Scroll FYP again → Report → finish. The gate's `else` branch
  // loops backward to `scroll1` ("if not enough matches yet, scroll again",
  // §3.9) — the loop `maxSteps` exists to bound.
  const doc = {
    schema: 2,
    name: 'tiktok-search-pipeline',
    title: 'TikTok search pipeline',
    description: 'Warm up the feed, search a keyword, and report what was found.',
    params: [{ name: 'keyword', type: 'string', required: true, title: 'Search keyword' }],
    entry: 'start',
    nodes: [
      startNode({ next: 'scroll1' }),
      scriptNode({ id: 'scroll1', title: 'Scroll FYP (warm-up)', next: 'search1' }),
      scriptNode({
        id: 'search1',
        title: 'Search Keywords & Scroll Posts',
        script: 'tiktok/searched-follow@1.4.0',
        params: { keyword: { param: 'keyword' } },
        next: 'enough',
      }),
      {
        kind: 'gate',
        id: 'enough',
        title: 'Enough matches?',
        ui: { x: 0, y: 0 },
        when: { left: { from: 'search1', path: 'matches' }, op: 'notEmpty' },
        then: 'scroll2',
        else: 'scroll1',
      },
      scriptNode({ id: 'scroll2', title: 'Scroll FYP again', next: 'report' }),
      scriptNode({
        id: 'report',
        title: 'Report',
        script: 'tiktok/report@1.0.0',
        params: { videos: { from: 'scroll1', path: 'videos' }, all: { run: 'summary' } },
        next: 'finish',
      }),
      finishNode(),
    ],
    onFail: { script: 'tiktok/switch-account@1.0.0', params: {} },
  }

  test('a hand-written seven-node document parses', () => {
    const result = WorkflowDocSchema.safeParse(doc)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.nodes).toHaveLength(7)
    expect(result.data.nodes.filter((n) => n.kind === 'gate')).toHaveLength(1)
    expect(result.data.nodes.filter((n) => n.kind === 'script')).toHaveLength(4)
    expect(result.data.nodes.filter((n) => n.kind === 'start')).toHaveLength(1)
    expect(result.data.nodes.filter((n) => n.kind === 'finish')).toHaveLength(1)
  })

  test('round-trips through JSON unchanged (this is what workflows.doc/jobs.workflow_doc actually store, plan 301 §4.5)', () => {
    const first = WorkflowDocSchema.parse(doc)
    const second = WorkflowDocSchema.parse(JSON.parse(JSON.stringify(first)))
    expect(second).toEqual(first)
  })

  test('array order carries no control meaning — a shuffled copy of the same nodes parses to an equivalent document', () => {
    const shuffled = { ...doc, nodes: [...doc.nodes].reverse() }
    const result = WorkflowDocSchema.safeParse(shuffled)
    expect(result.success).toBe(true)
  })
})

describe('WorkflowDocSchema — schema literal is 2, not 1', () => {
  test('schema: 1 is refused', () => {
    const result = WorkflowDocSchema.safeParse({
      schema: 1,
      name: 'old',
      entry: 'start',
      nodes: [startNode({ next: undefined })],
    })
    expect(result.success).toBe(false)
  })
})

describe('WorkflowDocSchema — start and finish', () => {
  test('exactly one start node is required — zero is refused', () => {
    const result = WorkflowDocSchema.safeParse({
      schema: 2,
      name: 'no-start',
      entry: 'a',
      nodes: [scriptNode({ id: 'a' })],
    })
    expect(result.success).toBe(false)
  })

  test('two start nodes is refused', () => {
    const result = WorkflowDocSchema.safeParse({
      schema: 2,
      name: 'two-starts',
      entry: 'start',
      nodes: [startNode({ id: 'start' }), startNode({ id: 'start-2' })],
    })
    expect(result.success).toBe(false)
  })

  test('entry must name a node in the document', () => {
    const result = WorkflowDocSchema.safeParse({
      schema: 2,
      name: 'bad-entry',
      entry: 'ghost',
      nodes: [startNode()],
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some((i) => i.message.includes('entry'))).toBe(true)
  })

  test('entry must name a "start" node, not any node', () => {
    const result = WorkflowDocSchema.safeParse({
      schema: 2,
      name: 'entry-not-start',
      entry: 'a',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a' })],
    })
    expect(result.success).toBe(false)
  })

  test('a start node with no `next` (dangling) is legal — an empty document skeleton', () => {
    const result = WorkflowDocSchema.safeParse({
      schema: 2,
      name: 'empty-skeleton',
      entry: 'start',
      nodes: [startNode()],
    })
    expect(result.success).toBe(true)
  })

  test('a finish node defaults to status "succeed" and an empty message', () => {
    const result = WorkflowDocSchema.parse({
      schema: 2,
      name: 'finish-defaults',
      entry: 'start',
      nodes: [startNode({ next: 'finish' }), finishNode({ id: 'finish' })],
    })
    const finish = result.nodes.find((n) => n.kind === 'finish')
    expect(finish).toMatchObject({ status: 'succeed', message: '' })
  })

  test('a finish node may declare status "fail" with a message', () => {
    const result = WorkflowDocSchema.parse({
      schema: 2,
      name: 'finish-fail',
      entry: 'start',
      nodes: [startNode({ next: 'finish' }), finishNode({ id: 'finish', status: 'fail', message: 'no matches found' })],
    })
    const finish = result.nodes.find((n) => n.kind === 'finish')
    expect(finish).toMatchObject({ status: 'fail', message: 'no matches found' })
  })
})

describe('WorkflowNodeSchema — every node requires `ui` (plan 300 D2)', () => {
  test('a node with no `ui` is refused', () => {
    const result = WorkflowNodeSchema.safeParse({ kind: 'start', id: 'a', title: '' })
    expect(result.success).toBe(false)
  })

  test('a `ui` value outside the bound is refused', () => {
    expect(WorkflowPointSchema.safeParse({ x: 100_001, y: 0 }).success).toBe(false)
    expect(WorkflowPointSchema.safeParse({ x: 0, y: -100_001 }).success).toBe(false)
    expect(WorkflowPointSchema.safeParse({ x: 1.5, y: 0 }).success).toBe(false)
  })

  test('a `ui` value inside the bound is accepted', () => {
    expect(WorkflowPointSchema.safeParse({ x: -100_000, y: 100_000 }).success).toBe(true)
  })
})

describe('WorkflowDocSchema — duplicate node id is refused, naming the id', () => {
  test('two nodes sharing one id fail, and the message names the id', () => {
    const doc = {
      schema: 2,
      name: 'dup',
      entry: 'start',
      nodes: [startNode({ next: 'same' }), scriptNode({ id: 'same' }), scriptNode({ id: 'same' })],
    }
    const result = WorkflowDocSchema.safeParse(doc)
    expect(result.success).toBe(false)
    if (result.success) return
    const messages = result.error.issues.map((i) => i.message)
    expect(messages.some((m) => m.includes('duplicate node id') && m.includes('"same"'))).toBe(true)
  })

  test('distinct ids are fine', () => {
    const doc = {
      schema: 2,
      name: 'nodup',
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a' }), scriptNode({ id: 'b' })],
    }
    expect(WorkflowDocSchema.safeParse(doc).success).toBe(true)
  })
})

describe('WorkflowDocSchema — maxNodes (99.1 verifiable result: a 51-node document is refused)', () => {
  function nodesOfLength(n: number) {
    return [startNode({ next: 'n0' }), ...Array.from({ length: n - 1 }, (_, i) => scriptNode({ id: `n${i}` }))]
  }

  test(`exactly WORKFLOW_LIMITS.maxNodes (${WORKFLOW_LIMITS.maxNodes}) nodes is fine`, () => {
    const doc = { schema: 2, name: 'big', entry: 'start', nodes: nodesOfLength(WORKFLOW_LIMITS.maxNodes) }
    expect(WorkflowDocSchema.safeParse(doc).success).toBe(true)
  })

  test(`${WORKFLOW_LIMITS.maxNodes + 1} nodes is refused`, () => {
    const doc = { schema: 2, name: 'toobig', entry: 'start', nodes: nodesOfLength(WORKFLOW_LIMITS.maxNodes + 1) }
    const result = WorkflowDocSchema.safeParse(doc)
    expect(result.success).toBe(false)
  })
})

describe('WorkflowPathSchema / ValueExprSchema — a path is a LOOKUP, never an expression (99.1 verifiable result)', () => {
  test.each(['videos', 'byLabel.long', 'matches.0.author', 'a.b.c.0.d'])('accepts %s', (path) => {
    expect(WorkflowPathSchema.safeParse(path).success).toBe(true)
  })

  test.each([
    'items[0]', // no bracket indexing
    'items.*', // no wildcard
    'items[]', // no empty brackets either
    'a..b', // no empty segment
    '.a', // no leading dot
    'a.', // no trailing dot
    '', // empty
    'a-b', // hyphen is not an identifier character here
    'a b', // no spaces
  ])('rejects %s, naming what was wrong', (path) => {
    const result = WorkflowPathSchema.safeParse(path)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message.length).toBeGreaterThan(0)
  })

  test('a `{ from, path }` binding with a bracketed path is refused the same way', () => {
    const result = ValueExprSchema.safeParse({ from: 'scroll1', path: 'items[0]' })
    expect(result.success).toBe(false)
  })
})

describe('ValueExprSchema — the four closed forms', () => {
  test('const', () => {
    expect(ValueExprSchema.safeParse({ const: 42 }).success).toBe(true)
    expect(ValueExprSchema.safeParse({ const: { nested: ['ok'] } }).success).toBe(true)
  })

  test('param', () => {
    expect(ValueExprSchema.safeParse({ param: 'keyword' }).success).toBe(true)
  })

  test('from, with and without a path, and optional/default', () => {
    expect(ValueExprSchema.safeParse({ from: 'scroll1' }).success).toBe(true)
    expect(ValueExprSchema.safeParse({ from: 'scroll1', path: 'videos' }).success).toBe(true)
    const parsed = ValueExprSchema.safeParse({ from: 'scroll1', path: 'videos', optional: true, default: 0 })
    expect(parsed.success).toBe(true)
  })

  test('`optional` defaults to false when absent', () => {
    const result = ValueExprSchema.parse({ from: 'scroll1' })
    expect(result).toEqual({ from: 'scroll1', optional: false })
  })

  test('run: summary', () => {
    expect(ValueExprSchema.safeParse({ run: 'summary' }).success).toBe(true)
    expect(ValueExprSchema.safeParse({ run: 'anything-else' }).success).toBe(false)
  })

  test('a fifth shape, or two forms mixed together, is refused (the union is closed and every arm is `.strict()`)', () => {
    expect(ValueExprSchema.safeParse({ eval: '1+1' }).success).toBe(false)
    expect(ValueExprSchema.safeParse({ const: 1, param: 'x' }).success).toBe(false)
    expect(ValueExprSchema.safeParse({}).success).toBe(false)
  })
})

describe('PredicateSchema — depth ≤ WORKFLOW_LIMITS.maxPredicateDepth (99.1 verifiable result: four levels deep is refused)', () => {
  const leaf = { left: { const: 1 }, op: 'eq', right: { const: 1 } }

  test(`exactly ${WORKFLOW_LIMITS.maxPredicateDepth} levels (all(any(leaf))) is accepted`, () => {
    const threeDeep = { all: [{ any: [leaf] }] }
    expect(WORKFLOW_LIMITS.maxPredicateDepth).toBe(3) // pin the constant the rest of this test assumes
    expect(PredicateSchema.safeParse(threeDeep).success).toBe(true)
  })

  test('four levels deep (all(any(not(leaf)))) is refused, and the message names the depth', () => {
    const fourDeep = { all: [{ any: [{ not: leaf }] }] }
    const result = PredicateSchema.safeParse(fourDeep)
    expect(result.success).toBe(false)
    if (result.success) return
    const message = result.error.issues.map((i) => i.message).join(' | ')
    expect(message).toContain('nested 4 levels deep')
    expect(message).toContain(`${WORKFLOW_LIMITS.maxPredicateDepth}-level limit`)
  })

  test('a plain leaf (depth 1) is accepted', () => {
    expect(PredicateSchema.safeParse(leaf).success).toBe(true)
  })

  test('`all`/`any` require at least one member', () => {
    expect(PredicateSchema.safeParse({ all: [] }).success).toBe(false)
    expect(PredicateSchema.safeParse({ any: [] }).success).toBe(false)
  })
})

describe('GATE_OPS / PredicateSchema — closed operator set (99.1 verifiable result: an unknown operator is refused)', () => {
  test('every declared op parses on a leaf', () => {
    for (const op of GATE_OPS) {
      const pred = op === 'exists' || op === 'notExists' || op === 'isEmpty' || op === 'notEmpty' ? { left: { const: 'x' }, op } : { left: { const: 'x' }, op, right: { const: 'x' } }
      expect(PredicateSchema.safeParse(pred).success).toBe(true)
    }
  })

  test('an operator outside GATE_OPS is refused, naming that it is invalid', () => {
    const result = PredicateSchema.safeParse({ left: { const: 'x' }, op: 'regexMatch', right: { const: 'x' } })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.length).toBeGreaterThan(0)
  })

  test('no author-supplied regular expression is representable — `pattern`/`regex` are not in the closed set (plan 95 §3.8 R2, plan 99 §3.7, F27)', () => {
    expect((GATE_OPS as readonly string[]).includes('pattern')).toBe(false)
    expect((GATE_OPS as readonly string[]).includes('regex')).toBe(false)
  })
})

describe('WorkflowNodeIdSchema', () => {
  test.each(['a', 'scroll1', 'search-keywords', 'n0'])('accepts %s', (id) => {
    expect(WorkflowNodeIdSchema.safeParse(id).success).toBe(true)
  })

  test.each(['', 'Scroll1', '-a', 'a_b', 'a.b', 'a b'])('rejects %s', (id) => {
    expect(WorkflowNodeIdSchema.safeParse(id).success).toBe(false)
  })
})

describe('WorkflowNameSchema — the SAME grammar a script name already uses', () => {
  test.each(['checkout', 'my-workflow', 'tiktok/pipeline'])('name accepts %s', (name) => {
    expect(WorkflowNameSchema.safeParse(name).success).toBe(true)
  })

  test.each(['', 'Checkout', '/leading', 'trailing/'])('name rejects %s', (name) => {
    expect(WorkflowNameSchema.safeParse(name).success).toBe(false)
  })
})

describe('WorkflowDocSchema — plan 210: a document carries no version', () => {
  test('a doc with a version key is refused (the schema is .strict())', () => {
    const result = WorkflowDocSchema.safeParse({
      schema: 2,
      name: 'versioned',
      version: '1.0.0',
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a' })],
    })
    expect(result.success).toBe(false)
  })
})

describe('WORKFLOW_LIMITS — pinned so a future change to these numbers is a deliberate edit, not a silent drift', () => {
  test('the numbers plan 99 §4.10 specifies', () => {
    expect(WORKFLOW_LIMITS).toEqual({
      maxNodes: 50,
      maxParams: 40,
      maxDocBytes: 128 * 1024,
      maxPredicateDepth: 3,
      maxPredicateLeaves: 20,
      maxNodeOutputBytes: 256 * 1024,
      maxRunSummaryBytes: 512 * 1024,
      maxSawKeys: 20,
    })
  })
})

describe('export surface — packages/protocol/src/index.ts re-exports (permanent pin, not a to-do)', () => {
  // This proves the wiring stays connected, not just that it once happened.
  // Plan 99's brief called for this to start as a FAILING guard (the module
  // existed but nothing re-exported it); by the time this ran, the
  // coordinator had freed `index.ts` and the exports were added in the same
  // pass as this test, so it is green from its first commit. Left in place
  // deliberately: if a future edit to `index.ts` drops one of these names —
  // the "built but never connected" failure mode this repo has hit nine
  // times in two days — THIS is the test that turns red.
  test('every public name from workflow.ts, workflow-params.ts and workflow-resolve.ts is reachable from @enkaku/protocol', async () => {
    const pkg = await import('@enkaku/protocol')
    const expectedNames = [
      'WORKFLOW_LIMITS',
      'WorkflowNodeIdSchema',
      'WorkflowPathSchema',
      'WorkflowNameSchema',
      'ValueExprSchema',
      'GATE_OPS',
      'PredicateSchema',
      'WorkflowPointSchema',
      'WorkflowNodeSchema',
      'WorkflowDocSchema',
      'WorkflowParamNameSchema',
      'WORKFLOW_PARAM_TYPES',
      'WorkflowParamSchema',
      'compileWorkflowParams',
      'resolveValue',
      'evaluatePredicate',
    ] as const
    for (const name of expectedNames) {
      expect((pkg as Record<string, unknown>)[name], `@enkaku/protocol should export "${name}"`).toBeDefined()
    }
  })
})

// A quiet consistency check: WorkflowNodeSchema (imported above) is exercised
// implicitly by every WorkflowDocSchema test in this file — `nodes` is an
// array of it — but it is also worth a direct assertion that a gate node
// without `when` is refused, since that is the one required field a
// discriminated union's OTHER arm would never catch.
describe('WorkflowNodeSchema — a gate without `when` is refused', () => {
  test('missing `when`', () => {
    const result = WorkflowNodeSchema.safeParse({ kind: 'gate', id: 'g', ui: { x: 0, y: 0 } })
    expect(result.success).toBe(false)
  })
})
