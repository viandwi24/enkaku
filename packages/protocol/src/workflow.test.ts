import { describe, expect, test } from 'bun:test'
import {
  GATE_OPS,
  GateOutcomeSchema,
  PredicateSchema,
  ValueExprSchema,
  WORKFLOW_LIMITS,
  WorkflowDocSchema,
  WorkflowNameSchema,
  WorkflowNodeIdSchema,
  WorkflowNodeSchema,
  WorkflowPathSchema,
} from './workflow'

/** A minimal, otherwise-valid script node — callers override only what the test cares about. */
function scriptNode(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'script',
    id: 'n0',
    script: 'tiktok/auto-scroll@1.4.0',
    ...overrides,
  }
}

describe('WorkflowDocSchema — round trip (99.1 verifiable result)', () => {
  // The owner's own example (plan 99 §0, verbatim): Scroll FYP (warm-up) →
  // Search Keywords & Scroll Posts → [gate: enough matches?] → Scroll FYP
  // again → Report. Four SCRIPT nodes plus one GATE — five nodes in the
  // array, matching the literal "four nodes and one gate" of 99.1's
  // verifiable result. The gate's `else` branch loops backward to `scroll1`
  // ("if not enough matches yet, scroll again", §3.9) — the loop `maxSteps`
  // exists to bound.
  const doc = {
    schema: 1,
    name: 'tiktok-search-pipeline',
    title: 'TikTok search pipeline',
    description: 'Warm up the feed, search a keyword, and report what was found.',
    params: [{ name: 'keyword', type: 'string', required: true, title: 'Search keyword' }],
    nodes: [
      scriptNode({ id: 'scroll1', title: 'Scroll FYP (warm-up)' }),
      scriptNode({
        id: 'search1',
        title: 'Search Keywords & Scroll Posts',
        script: 'tiktok/searched-follow@1.4.0',
        params: { keyword: { param: 'keyword' } },
      }),
      {
        kind: 'gate',
        id: 'enough',
        title: 'Enough matches?',
        when: { left: { from: 'search1', path: 'matches' }, op: 'notEmpty' },
        then: { go: 'continue' },
        else: { go: 'goto', node: 'scroll1' },
      },
      scriptNode({ id: 'scroll2', title: 'Scroll FYP again' }),
      scriptNode({
        id: 'report',
        title: 'Report',
        script: 'tiktok/report@1.0.0',
        params: { videos: { from: 'scroll1', path: 'videos' }, all: { run: 'summary' } },
      }),
    ],
    onFail: { script: 'tiktok/switch-account@1.0.0', params: {} },
  }

  test('a hand-written four-node-plus-one-gate document parses', () => {
    const result = WorkflowDocSchema.safeParse(doc)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.nodes).toHaveLength(5)
    expect(result.data.nodes.filter((n) => n.kind === 'gate')).toHaveLength(1)
    expect(result.data.nodes.filter((n) => n.kind === 'script')).toHaveLength(4)
  })

  test('round-trips through JSON unchanged (this is what scripts.bundle/scripts.source actually store, §4.5)', () => {
    const first = WorkflowDocSchema.parse(doc)
    const second = WorkflowDocSchema.parse(JSON.parse(JSON.stringify(first)))
    expect(second).toEqual(first)
  })
})

describe('WorkflowDocSchema — duplicate node id is refused, naming the id', () => {
  test('two nodes sharing one id fail, and the message names the id', () => {
    const doc = {
      schema: 1,
      name: 'dup',
        nodes: [scriptNode({ id: 'same' }), scriptNode({ id: 'same' })],
    }
    const result = WorkflowDocSchema.safeParse(doc)
    expect(result.success).toBe(false)
    if (result.success) return
    const messages = result.error.issues.map((i) => i.message)
    expect(messages.some((m) => m.includes('duplicate node id') && m.includes('"same"'))).toBe(true)
  })

  test('distinct ids are fine', () => {
    const doc = {
      schema: 1,
      name: 'nodup',
        nodes: [scriptNode({ id: 'a' }), scriptNode({ id: 'b' })],
    }
    expect(WorkflowDocSchema.safeParse(doc).success).toBe(true)
  })
})

describe('WorkflowDocSchema — maxNodes (99.1 verifiable result: a 51-node document is refused)', () => {
  function nodesOfLength(n: number) {
    return Array.from({ length: n }, (_, i) => scriptNode({ id: `n${i}` }))
  }

  test(`exactly WORKFLOW_LIMITS.maxNodes (${WORKFLOW_LIMITS.maxNodes}) nodes is fine`, () => {
    const doc = { schema: 1, name: 'big', nodes: nodesOfLength(WORKFLOW_LIMITS.maxNodes) }
    expect(WorkflowDocSchema.safeParse(doc).success).toBe(true)
  })

  test(`${WORKFLOW_LIMITS.maxNodes + 1} nodes is refused`, () => {
    const doc = { schema: 1, name: 'toobig', nodes: nodesOfLength(WORKFLOW_LIMITS.maxNodes + 1) }
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

describe('GateOutcomeSchema', () => {
  test.each(['continue', 'stop', 'fail'] as const)('go: %s needs no node', (go) => {
    expect(GateOutcomeSchema.safeParse({ go }).success).toBe(true)
  })

  test('goto requires a node id', () => {
    expect(GateOutcomeSchema.safeParse({ go: 'goto', node: 'scroll1' }).success).toBe(true)
    expect(GateOutcomeSchema.safeParse({ go: 'goto' }).success).toBe(false)
  })

  test('an unknown `go` value is refused', () => {
    expect(GateOutcomeSchema.safeParse({ go: 'restart' }).success).toBe(false)
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
    const result = WorkflowDocSchema.safeParse({ schema: 1, name: 'versioned', version: '1.0.0', nodes: [scriptNode({ id: 'a' })] })
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
      'GateOutcomeSchema',
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
// discriminated union's OTHER arm (`kind: 'script'`) would never catch.
describe('WorkflowNodeSchema — a gate without `when` is refused', () => {
  test('missing `when`', () => {
    const result = WorkflowNodeSchema.safeParse({ kind: 'gate', id: 'g' })
    expect(result.success).toBe(false)
  })
})
